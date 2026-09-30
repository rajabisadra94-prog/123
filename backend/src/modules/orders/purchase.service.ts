import prisma from '../../shared/utils/prisma';
import { Currency } from '@prisma/client';
import { getOrCreateWallet, getOrCreateControl, postJournal, rateFor } from '../accounting/accounting.service';
import { dwPurchaseOrder, pwPurchaseOrder, writeLegacy } from '../ledger/dual-write';

// مراحل سفارش خرید (به ترتیب) — تصمیم #۱۱
export const PURCHASE_STAGES = ['ORDERED', 'DEPOSIT_PAID', 'PREPARING', 'SETTLED', 'SHIPPED', 'RECEIVED', 'READY'] as const;
export type PurchaseStage = (typeof PURCHASE_STAGES)[number];

/**
 * Handoff فاز ۳→۴ (buy-first): برای پروژهٔ TRADING که قیمت‌گیری‌اش نهایی شده،
 * به‌ازای هر تامین‌کننده یک «سفارش خرید» ساخته می‌شود و بدهی به تامین‌کننده در حسابداری ثبت می‌شود.
 * قطعات با selectedPrice.supplierId گروه‌بندی می‌شوند. سفارش‌های قبلاً‌ساخته‌شده دوباره ساخته نمی‌شوند.
 */
export async function createPurchaseOrdersForProject(projectId: string, actorId: string): Promise<number> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { code: true, type: true } });
  if (!project || project.type !== 'TRADING') return 0;

  // قطعاتِ دارای برندهٔ تامین‌کننده که هنوز به سفارش خرید نرفته‌اند
  const parts = await prisma.part.findMany({
    where: { projectId, archivedAt: null, selectedPrice: { supplierId: { not: null } } },
    include: { selectedPrice: true },
  });
  if (!parts.length) return 0;

  // گروه‌بندی بر اساس تامین‌کننده
  const bySupplier: Record<string, typeof parts> = {};
  for (const p of parts) {
    const sid = p.selectedPrice!.supplierId!;
    (bySupplier[sid] ||= []).push(p);
  }

  let created = 0;
  const createdOrderIds: string[] = [];
  for (const [supplierId, supParts] of Object.entries(bySupplier)) {
    // اگر برای این پروژه+تامین‌کننده سفارش خرید باز وجود دارد، رد شو (idempotent)
    const existing = await prisma.productionOrder.findFirst({ where: { projectId, supplierId, kind: 'PURCHASE' } });
    if (existing) continue;

    const supplier = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } });

    await prisma.$transaction(async (tx) => {
      const orderCount = await tx.productionOrder.count();
      const order = await tx.productionOrder.create({
        data: {
          code: `ORD-${String(orderCount + 1).padStart(5, '0')}`,
          projectId,
          supplierId,
          kind: 'PURCHASE',
          status: 'NEW',
          purchaseStage: 'ORDERED',
          inspectionStatus: 'PENDING',
        },
      });
      await tx.part.updateMany({ where: { id: { in: supParts.map((p) => p.id) } }, data: { milestone: 'ORDER_PLACED' } });

      // بدهی به تامین‌کننده = بهای تمام‌شدهٔ خرید (به تفکیک ارز). قیمت واحد × تعداد.
      if (writeLegacy()) {
        const byCurrency: Record<string, number> = {};
        for (const p of supParts) {
          const sp = p.selectedPrice!;
          const amt = Number(sp.amount) * (p.quantity || 1);
          byCurrency[sp.currency] = (byCurrency[sp.currency] || 0) + amt;
        }
        for (const [cur, amount] of Object.entries(byCurrency)) {
          if (amount <= 0) continue;
          const r = await rateFor(cur as Currency);
          const supWallet = await getOrCreateWallet(tx, 'SUPPLIER', supplierId, cur as Currency, supplier?.name);
          const purchaseCtrl = await getOrCreateControl(tx, 'PURCHASE', cur as Currency);
          await postJournal(tx, {
            description: `بدهی به تامین‌کننده ${supplier?.name || ''} بابت سفارش خرید ${order.code} (${project.code})`,
            eventType: 'PURCHASE_ORDER_CREATED', sourceType: 'ProductionOrder', sourceId: order.id, projectId, createdById: actorId,
            lines: [
              { accountId: purchaseCtrl.id, debit: amount, currency: cur as Currency, rateToIRR: r },
              { accountId: supWallet.id, credit: amount, currency: cur as Currency, rateToIRR: r },
            ],
          });
        }
      }
      await pwPurchaseOrder(tx, order.id, actorId);   // حالت 'new': داخل همین تراکنش

      // وظیفهٔ «حین خرید» برای گفتگو/پیگیری
      await tx.task.create({
        data: {
          title: `حین خرید پروژه ${project.code} از ${supplier?.name || 'تامین‌کننده'}`,
          notes: 'گفتگوها، پرداخت‌ها و تصمیمات حین خرید را اینجا ثبت کنید.',
          assigneeIds: [actorId],
          assignedTo: { connect: { id: actorId } },
          createdBy: { connect: { id: actorId } },
          project: { connect: { id: projectId } },
          order: { connect: { id: order.id } },
          entityType: 'ProductionOrder', entityId: order.id,
        },
      });

      await tx.auditLog.create({
        data: { userId: actorId, action: 'CREATE', entity: 'ProductionOrder', entityId: order.id, projectId, changes: { event: 'PURCHASE_ORDER_CREATED', kind: 'PURCHASE', supplierId } },
      });
      createdOrderIds.push(order.id);
      created += 1;
    }, { timeout: 20000 });
  }

  // سایهٔ 'dual' — بعد از commitِ هر سفارش، غیرمسدودکننده (در حالت 'new' بی‌اثر)
  for (const id of createdOrderIds) await dwPurchaseOrder(id, actorId);

  // پروژه به حالت «در حال تولید/تدارک» می‌رود (خرید در جریان)
  if (created > 0) await prisma.project.update({ where: { id: projectId }, data: { status: 'IN_PRODUCTION' } });
  return created;
}
