import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { upload } from '../../shared/middleware/upload';
import { AppError } from '../../shared/middleware/errorHandler';
import { projectAccessWhere, notifyProjectAudience } from '../../shared/utils/projectAccess';
import { generateFileName } from '../../shared/utils/fileNaming';
import path from 'path';
import fs from 'fs';

const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response) => {
  // اعلان تأخیر تولید برای سفارش‌های تازه‌تأخیرخورده (یک‌بار، با delayNotifiedAt)
  try {
    const overdue = await prisma.productionOrder.findMany({
      where: { kind: 'PRODUCTION', status: 'IN_PRODUCTION', estimatedEndDate: { lt: new Date() }, delayNotifiedAt: null },
      include: { project: { select: { code: true } }, producer: { select: { name: true } } },
    });
    for (const o of overdue) {
      await notifyProjectAudience(o.projectId, req.user!.id, 'PRODUCTION_DELAY', `⏰ تأخیر تولید: سفارش ${o.code} (سازنده ${o.producer?.name || ''}) در پروژهٔ ${o.project.code} از موعد گذشته — پیگیری کنید`, 'ProductionOrder', o.id);
      await prisma.productionOrder.update({ where: { id: o.id }, data: { delayNotifiedAt: new Date() } });
    }
  } catch { /* خطای اعلان نباید لیست را متوقف کند */ }

  const { status, producerId, projectId, kind } = req.query;
  const where: any = {};
  if (status) where.status = status;
  if (producerId) where.producerId = producerId;
  if (projectId) where.projectId = projectId;
  if (kind) where.kind = kind;
  Object.assign(where, await projectAccessWhere(req.user!.id, req.user!.role, 'projectId'));

  const orders = await prisma.productionOrder.findMany({
    where,
    include: {
      project: { include: { customer: { select: { id: true, name: true } } } },
      producer: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } },
      orderFiles: true,
      _count: { select: { domesticItems: true } }, // برای تشخیص سفارش‌هایی که بستهٔ حمل داخلی دارند
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(orders);
});

router.get('/:id', async (req: Request, res: Response) => {
  const order = await prisma.productionOrder.findUnique({
    where: { id: req.params.id },
    include: {
      project: { include: { customer: true } },
      producer: true,
      supplier: true,
      orderFiles: true,
      reminderTasks: { include: { _count: { select: { comments: true } } } }, // وظیفهٔ «حین ساخت/خرید»
    },
  });
  if (!order) throw new AppError(404, 'Order not found');

  // قطعاتِ این فروشنده در این پروژه (سازنده برای ساخت، تامین‌کننده برای خرید)
  const vendorWhere = order.supplierId ? { supplierId: order.supplierId } : { producerId: order.producerId };
  const parts = await prisma.part.findMany({
    where: { projectId: order.projectId, selectedPrice: vendorWhere },
    select: { id: true, name: true, quantity: true, weightGrams: true, milestone: true },
  });

  res.json({ ...order, parts });
});

router.patch('/:id/status', async (req: Request, res: Response) => {
  const { status, startDate, estimatedEndDate, notes, finalWeightGrams, packagingDetails } = req.body;
  const validStatuses = ['NEW', 'IN_PRODUCTION', 'QUALITY_CONTROL', 'COMPLETED'];
  if (!validStatuses.includes(status)) throw new AppError(400, 'Invalid status');

  const order = await prisma.productionOrder.findUnique({ where: { id: req.params.id } });
  if (!order) throw new AppError(404, 'Order not found');

  const data: any = { status, notes };
  if (status === 'IN_PRODUCTION') {
    data.startDate = startDate ? new Date(startDate) : new Date();
    // تنظیم/تمدید مهلت → ریست پرچم اعلان تأخیر تا در صورت تأخیر بعدی دوباره اعلان برود
    if (estimatedEndDate) { data.estimatedEndDate = new Date(estimatedEndDate); data.delayNotifiedAt = null; }
  }
  if (status === 'COMPLETED') {
    data.actualEndDate = new Date();
    if (finalWeightGrams) data.finalWeightGrams = Number(finalWeightGrams);
    if (packagingDetails) data.packagingDetails = packagingDetails;
  }

  await prisma.productionOrder.update({ where: { id: req.params.id }, data });

  // Update part milestones
  const milestoneMap: Record<string, string> = {
    IN_PRODUCTION: 'IN_PRODUCTION',
    QUALITY_CONTROL: 'QUALITY_CONTROL',
    COMPLETED: 'COMPLETED',
  };
  if (milestoneMap[status]) {
    // قطعات مرتبط با فروشندهٔ این سفارش (سازنده یا تامین‌کننده)
    const parts = await prisma.part.findMany({
      where: {
        projectId: order.projectId,
        selectedPrice: order.supplierId ? { supplierId: order.supplierId } : { producerId: order.producerId },
      },
    });
    await prisma.part.updateMany({
      where: { id: { in: parts.map((p) => p.id) } },
      data: { milestone: milestoneMap[status] as any },
    });
  }

  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'UPDATE',
      entity: 'ProductionOrder',
      entityId: req.params.id,
      projectId: order.projectId,
      changes: { status },
    },
  });

  res.json({ ok: true });
});

router.post('/:id/files', upload.array('files', 10), async (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[];
  if (!files?.length) throw new AppError(400, 'file required');
  const { fileType } = req.body;
  const order = await prisma.productionOrder.findUnique({ where: { id: req.params.id }, select: { code: true } });
  if (!order) throw new AppError(404, 'Order not found');
  const type = fileType || 'GENERAL';

  // نام‌گذاری استاندارد فایل‌های سفارش (به‌جای نام خامِ آپلود)
  const existing = await prisma.orderFile.count({ where: { orderId: req.params.id, fileType: type } });
  const records = files.map((f, i) => {
    const newName = generateFileName(
      { level: 'order', fileType: type, orderCode: order.code, version: `R${String(existing + i + 1).padStart(2, '0')}`, originalExt: path.extname(f.originalname) },
      f.originalname,
    );
    const newPath = path.join(path.dirname(f.path), newName);
    fs.renameSync(f.path, newPath);
    return { orderId: req.params.id, fileType: type, storedName: newName, url: `/uploads/${newName}`, sizeBytes: f.size, uploadedById: req.user!.id };
  });
  await prisma.orderFile.createMany({ data: records });
  res.status(201).json({ ok: true, count: files.length });
});

// ۵.۱ — ایجاد وظیفهٔ «حین ساخت» برای سفارش‌های قدیمی که آن را ندارند (تا گفتگو همیشه در دسترس باشد)
router.post('/:id/discussion', async (req: Request, res: Response) => {
  const order = await prisma.productionOrder.findUnique({
    where: { id: req.params.id },
    include: { project: { select: { id: true, code: true } }, producer: { select: { name: true } }, supplier: { select: { name: true } }, reminderTasks: { select: { id: true } } },
  });
  if (!order) throw new AppError(404, 'Order not found');
  if (order.reminderTasks.length) return res.json({ ok: true, taskId: order.reminderTasks[0].id });

  const task = await prisma.task.create({
    data: {
      title: `حین ${order.kind === 'PURCHASE' ? 'خرید' : 'ساخت'} پروژه ${order.project.code} با ${order.producer?.name ?? order.supplier?.name ?? ''}`,
      notes: 'گفتگوها، تغییرات و تصمیمات حین تولید را اینجا ثبت کنید.',
      assigneeIds: [req.user!.id],
      assignedTo: { connect: { id: req.user!.id } },
      createdBy: { connect: { id: req.user!.id } },
      project: { connect: { id: order.projectId } },
      order: { connect: { id: order.id } },
      entityType: 'ProductionOrder', entityId: order.id,
    },
  });
  res.json({ ok: true, taskId: task.id });
});

// ─── PURCHASE ORDERS (فاز ۴): پیشبرد مرحله + بازرسی + پرداخت بیعانه/تسویه ───
import { PURCHASE_STAGES } from './purchase.service';
import { postSettlement, rateFor } from '../accounting/accounting.service';
import { dwSettlement, pwSettlement, writeLegacy, ledgerMode } from '../ledger/dual-write';
import { Currency } from '@prisma/client';

const STAGE_LABELS: Record<string, string> = {
  ORDERED: 'ثبت سفارش', DEPOSIT_PAID: 'بیعانه پرداخت‌شده', PREPARING: 'آماده‌سازی تامین‌کننده',
  SETTLED: 'تسویه قبل ارسال', SHIPPED: 'ارسال شد', RECEIVED: 'دریافت شد', READY: 'آمادهٔ حمل',
};

// پیشبرد مرحلهٔ سفارش خرید (به مرحلهٔ دلخواه). با رسیدن به READY، status=COMPLETED می‌شود تا وارد زنجیرهٔ حمل شود.
router.patch('/:id/purchase-stage', async (req: Request, res: Response) => {
  const { stage, inspectionStatus, inspectionNote } = req.body;
  const order = await prisma.productionOrder.findUnique({ where: { id: req.params.id } });
  if (!order) throw new AppError(404, 'Order not found');
  if (order.kind !== 'PURCHASE') throw new AppError(400, 'این عملیات فقط برای سفارش خرید است');
  if (stage && !PURCHASE_STAGES.includes(stage)) throw new AppError(400, 'مرحلهٔ نامعتبر');

  const data: any = {};
  if (stage) data.purchaseStage = stage;
  if (inspectionStatus) { data.inspectionStatus = inspectionStatus; data.inspectionNote = inspectionNote ?? order.inspectionNote; }

  // با رسیدن به «آمادهٔ حمل» سفارش تکمیل می‌شود تا در ماژول حمل به‌عنوان آمادهٔ ارسال دیده شود
  if (stage === 'READY') {
    data.status = 'COMPLETED';
    data.actualEndDate = new Date();
    await prisma.part.updateMany({
      where: { projectId: order.projectId, selectedPrice: { supplierId: order.supplierId } },
      data: { milestone: 'COMPLETED' },
    });
  }

  // برگشت از «آمادهٔ حمل» به مرحلهٔ قبل: تا زمانی که در بستهٔ حمل نیست مجاز است و سفارش از فهرست آمادهٔ ارسال خارج می‌شود
  if (stage && stage !== 'READY' && order.status === 'COMPLETED') {
    const packaged = await prisma.domesticPackageItem.count({ where: { orderId: order.id } });
    if (packaged > 0) throw new AppError(400, 'این سفارش در بستهٔ حمل است و به مرحلهٔ قبل برنمی‌گردد');
    data.status = 'IN_PRODUCTION';
    data.actualEndDate = null;
    await prisma.part.updateMany({ where: { projectId: order.projectId, selectedPrice: { supplierId: order.supplierId } }, data: { milestone: 'ORDER_PLACED' } });
  }

  await prisma.productionOrder.update({ where: { id: order.id }, data });
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'ProductionOrder', entityId: order.id, projectId: order.projectId, changes: { purchaseStage: stage, inspectionStatus } },
  });
  res.json({ ok: true });
});

// پرداخت بیعانه/تسویه به تامین‌کننده — کاهش بدهی (بدهکار کیف تامین‌کننده / بستانکار حساب شرکت)
router.post('/:id/purchase-payment', async (req: Request, res: Response) => {
  const { amount, currency, fromAccountId, kind } = req.body; // kind: DEPOSIT | SETTLEMENT
  if (!amount || Number(amount) <= 0) throw new AppError(400, 'مبلغ پرداخت لازم است');
  if (!currency) throw new AppError(400, 'ارز پرداخت لازم است');
  if (!fromAccountId) throw new AppError(400, 'حساب پرداخت‌کننده لازم است');

  const order = await prisma.productionOrder.findUnique({ where: { id: req.params.id }, include: { supplier: { select: { name: true } }, project: { select: { code: true } } } });
  if (!order) throw new AppError(404, 'Order not found');
  if (order.kind !== 'PURCHASE' || !order.supplierId) throw new AppError(400, 'این عملیات فقط برای سفارش خرید است');

  const from = await prisma.financialAccount.findUnique({ where: { id: fromAccountId } });
  if (!from) throw new AppError(404, 'حساب پرداخت‌کننده یافت نشد');

  const sameCurrency = from.currency === currency;
  // هستهٔ جدید تسویهٔ چندارزی نمی‌پذیرد — اگر مرجع است، حالتِ چندارزی باید رد شود
  if (ledgerMode() === 'new' && !sameCurrency) {
    throw new AppError(400,
      'هستهٔ جدید تسویهٔ چندارزی نمی‌پذیرد — ابتدا از «عملیات ارزی» ارز حساب را به ارز بدهی تبدیل کنید');
  }

  const settlementDate = new Date();
  let legacyEntryId: string | undefined;
  await prisma.$transaction(async (tx) => {
    // پیشبرد خودکار مرحله بر اساس نوع پرداخت — همیشه
    const advanceStage = async () => {
      const nextStage = kind === 'SETTLEMENT' ? 'SETTLED' : 'DEPOSIT_PAID';
      if (PURCHASE_STAGES.indexOf(nextStage as any) > PURCHASE_STAGES.indexOf((order.purchaseStage || 'ORDERED') as any)) {
        await tx.productionOrder.update({ where: { id: order.id }, data: { purchaseStage: nextStage } });
      }
    };

    if (writeLegacy()) {
      // تسویهٔ استاندارد چند‌ارزی: بدهی تامین‌کننده به ارز خودش (نرخ ثبت) بسته می‌شود،
      // نقد به ارز حساب شرکت، اختلاف → سود/زیان تسعیر محقق‌شده (postSettlement).
      const payRate = await rateFor(currency as Currency);
      const fromRate = await rateFor(from.currency);
      const cashAmount = req.body.cashAmount != null && Number(req.body.cashAmount) > 0
        ? Number(req.body.cashAmount)
        : (sameCurrency ? Number(amount) : (Number(amount) * payRate) / fromRate);
      const label = kind === 'SETTLEMENT' ? 'تسویه' : 'بیعانه';
      const entry = await postSettlement(tx, {
        direction: 'PAYMENT',
        ownerType: 'SUPPLIER', ownerId: order.supplierId!, ownerName: order.supplier?.name,
        obligationCurrency: currency as Currency, settledAmount: Number(amount),
        companyAccountId: from.id, cashAmount,
        description: `${label} به تامین‌کننده ${order.supplier?.name || ''} — سفارش خرید ${order.code} (${order.project.code})`,
        eventType: 'PURCHASE_PAYMENT', sourceType: 'ProductionOrder', sourceId: order.id,
        projectId: order.projectId, createdById: req.user!.id,
      });
      legacyEntryId = (entry as any)?.id;
    }

    if (sameCurrency) {
      await pwSettlement(tx, {
        direction: 'PAYMENT', ownerType: 'SUPPLIER', ownerId: order.supplierId!,
        currency, amount: Number(amount), companyAccountName: from.name,
        date: settlementDate, userId: req.user!.id,
      });
    }

    await advanceStage();
  }, { timeout: 20000 });

  // سایهٔ 'dual' — فقط تسویهٔ هم‌ارز (در حالت 'new' اجرا نمی‌شود — legacyEntryId خالی است)
  if (legacyEntryId && sameCurrency) {
    await dwSettlement({
      legacyEntryId, direction: 'PAYMENT', ownerType: 'SUPPLIER', ownerId: order.supplierId!,
      currency, amount: Number(amount), legacyCashAccountName: from.name,
      date: settlementDate, userId: req.user!.id,
    });
  }

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'ProductionOrder', entityId: order.id, projectId: order.projectId, changes: { event: 'PURCHASE_PAYMENT', kind, amount, currency } },
  });
  res.json({ ok: true });
});

export { STAGE_LABELS };
export default router;
