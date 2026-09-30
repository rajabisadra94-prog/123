import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../../shared/utils/prisma';
import { authenticate, requireRole } from '../../shared/middleware/auth';
import { AppError } from '../../shared/middleware/errorHandler';
import { getLiveRates } from '../../shared/utils/money';
import { Currency } from '@prisma/client';
import { renderInvoiceHtml } from './invoiceTemplate';
import { postInvoiceObligations, rateFor } from '../accounting/accounting.service';
import { dwInvoice, pwInvoice, writeLegacy } from '../ledger/dual-write';
import { requirePermission } from '../../shared/middleware/permissions';
import { projectAccessWhere } from '../../shared/utils/projectAccess';

const router = Router();

const CUR_LABEL: Record<string, string> = { IRR: 'تومان', USD: 'دلار', CNY: 'یوآن' };

// ─── PRINTABLE INVOICE (opens in new tab; token via query) ──
// Defined BEFORE the global authenticate middleware so it can read token from query string.
router.get('/:id/print', async (req: Request, res: Response) => {
  const token = (req.query.token as string) || req.headers.authorization?.slice(7);
  if (!token) { res.status(401).send('Unauthorized'); return; }
  try { jwt.verify(token, process.env.JWT_SECRET!); }
  catch { res.status(401).send('Invalid token'); return; }

  const inv = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: {
      project: { include: { customer: true } },
      items: { include: { part: { include: { material: true, coating: true } } } },
    },
  });
  if (!inv) { res.status(404).send('Invoice not found'); return; }

  const companyRows = await prisma.systemSetting.findMany({
    where: { key: { in: ['COMPANY_NAME', 'COMPANY_ADDRESS', 'COMPANY_PHONE', 'COMPANY_EMAIL', 'COMPANY_LOGO_URL', 'COMPANY_EXTRA', 'COMPANY_STAMP_URL'] } },
  });
  const company: Record<string, string> = {};
  companyRows.forEach((r) => { company[r.key] = r.value; });

  const invSetRow = await prisma.systemSetting.findUnique({ where: { key: 'INVOICE_SETTINGS' } });
  let invoiceSettings: Record<string, string> = {};
  try { invoiceSettings = invSetRow?.value ? JSON.parse(invSetRow.value) : {}; } catch { /* ignore */ }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderInvoiceHtml(inv, company, CUR_LABEL, invoiceSettings));
});

router.use(authenticate);

// List invoices
router.get('/', async (req: Request, res: Response) => {
  const { projectId, status } = req.query;
  const where: any = {};
  if (projectId) where.projectId = projectId;
  if (status) where.status = status;
  Object.assign(where, await projectAccessWhere(req.user!.id, req.user!.role, 'projectId'));

  const invoices = await prisma.invoice.findMany({
    where,
    include: {
      project: { include: { customer: { select: { id: true, name: true } } } },
      items: { include: { part: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(invoices);
});

// List projects that are ready for invoicing (have at least one part with a winning price).
// ساخت و خرید کالا: تا پیش از تأیید مشتری (ورود به تولید/تدارک) قابل فاکتور است.
router.get('/ready/projects', async (req: Request, res: Response) => {
  const where: any = {
    type: { in: ['MANUFACTURING', 'TRADING'] },
    parts: { some: { archivedAt: null, selectedPrice: { isNot: null } } },
    status: { notIn: ['ARCHIVED', 'COMPLETED', 'IN_PRODUCTION'] },
  };
  Object.assign(where, await projectAccessWhere(req.user!.id, req.user!.role, 'id'));
  const projects = await prisma.project.findMany({
    where,
    include: {
      customer: { select: { id: true, name: true } },
      parts: {
        where: { archivedAt: null, selectedPrice: { isNot: null } },
        include: { selectedPrice: true },
        orderBy: { sortOrder: 'asc' },
      },
      invoices: { orderBy: { versionNumber: 'desc' }, include: { items: true } },
      commissions: true,
      shippingCost: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json(projects);
});

// Get invoice detail
router.get('/:id', async (req: Request, res: Response) => {
  const inv = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: { items: { include: { part: { include: { selectedPrice: true } } } } },
  });
  if (!inv) throw new AppError(404, 'Invoice not found');
  res.json(inv);
});

// Create new invoice version for a project
router.post('/', requirePermission('invoicing', 'create'), async (req: Request, res: Response) => {
  const { projectId, currency, items, notes, prepDays, prepNote, hasVat } = req.body;
  // items: Array<{ partId, saleAmount, saleCurrency }>
  if (!projectId || !items?.length) throw new AppError(400, 'projectId and items required');

  const outCurrency: Currency = currency || 'IRR';
  const rates = await getLiveRates();
  const now = new Date();

  // Determine version number
  const existing = await prisma.invoice.count({ where: { projectId } });
  const versionNumber = existing + 1;
  const versionCode = `INV-${String(versionNumber).padStart(2, '0')}`;

  // تعداد هر قطعه از دیتابیس (منبع معتبر) — قیمت‌ها «واحد»اند و در تعداد ضرب می‌شوند
  const partIds: string[] = items.map((i: any) => i.partId);
  const partRows = await prisma.part.findMany({ where: { id: { in: partIds } }, select: { id: true, quantity: true } });
  const qtyOf: Record<string, number> = Object.fromEntries(partRows.map((p) => [p.id, p.quantity || 1]));

  // Build invoice items — نرخ هر سمت (هزینه/فروش) از ارز خودش محاسبه می‌شود
  // saleAmount/costAmount «قیمت واحد» ذخیره می‌شوند (گرد به عدد صحیح)؛ مجموع کل با تعداد محاسبه می‌شود
  const irrRateOf = (c: Currency) => (c === 'IRR' ? 1 : c === 'USD' ? rates.USD_TO_IRR : rates.CNY_TO_IRR);
  const invoiceItems = items.map((item: any) => {
    const saleCurr: Currency = item.saleCurrency || outCurrency;
    const costCurr: Currency = item.costCurrency || 'IRR';
    const unitSale = Math.round((Number(item.saleAmount) || 0) * 100) / 100; // ۴.۴ — قیمت واحد دقیق (بدون گرد به بالا)

    return {
      partId: item.partId,
      costAmount: item.costAmount || 0,
      costCurrency: costCurr,
      costRateToIRR: irrRateOf(costCurr),
      saleAmount: unitSale,
      saleCurrency: saleCurr,
      saleRateToIRR: irrRateOf(saleCurr),
      saleRateAt: now,
    };
  });

  // مجموع اقلام = Σ (قیمت واحد × تعداد) به ارز فاکتور
  const outRate = outCurrency === 'IRR' ? 1 : outCurrency === 'USD' ? rates.USD_TO_IRR : rates.CNY_TO_IRR;
  const subtotal = invoiceItems.reduce((sum: number, i: any) => {
    const qty = qtyOf[i.partId] || 1;
    const inIRR = i.saleAmount * i.saleRateToIRR * qty;
    return sum + inIRR / outRate;
  }, 0);

  // مالیات بر ارزش افزوده — درصد از تنظیمات فاکتور (پیش‌فرض ۱۰٪)؛ فقط اگر فاکتور «با ارزش افزوده» باشد
  let vatPercent = 0;
  if (hasVat) {
    const invSetRow = await prisma.systemSetting.findUnique({ where: { key: 'INVOICE_SETTINGS' } });
    let vp = 10;
    try {
      const s = invSetRow?.value ? JSON.parse(invSetRow.value) : {};
      if (s.vatPercent != null && s.vatPercent !== '' && !isNaN(Number(s.vatPercent))) vp = Number(s.vatPercent);
    } catch { /* پیش‌فرض ۱۰ */ }
    vatPercent = vp;
  }
  const vatAmount = Math.round(subtotal * (vatPercent / 100) * 100) / 100;
  // مبلغ کل شامل مالیات ذخیره می‌شود تا طلب مشتری در حسابداری هم شامل آن باشد
  const totalAmount = Math.round((subtotal + vatAmount) * 100) / 100;

  const invoice = await prisma.invoice.create({
    data: {
      projectId,
      versionNumber,
      versionCode,
      currency: outCurrency,
      status: 'DRAFT',
      notes,
      prepDays: prepDays != null && prepDays !== '' ? Number(prepDays) : null,
      prepNote: prepNote || null,
      hasVat: !!hasVat,
      vatPercent: hasVat ? vatPercent : null,
      vatAmount: hasVat ? vatAmount : null,
      totalAmount, // ۴.۴ — مبلغ کل دقیق (شامل مالیات، بدون گرد به بالای هزارگان)
      totalCurrency: outCurrency,
      totalRateToIRR: outCurrency === 'IRR' ? 1 : outCurrency === 'USD' ? rates.USD_TO_IRR : rates.CNY_TO_IRR,
      totalRateAt: now,
      items: { create: invoiceItems },
    },
    include: { items: true },
  });

  res.status(201).json(invoice);
});

// Mark invoice as sent / rejected
router.patch('/:id/status', async (req: Request, res: Response) => {
  const { status, rejectReason } = req.body;
  const allowed = ['SENT', 'REJECTED', 'SUPERSEDED'];
  if (!allowed.includes(status)) throw new AppError(400, `Status must be one of: ${allowed.join(', ')}`);

  const inv = await prisma.invoice.update({
    where: { id: req.params.id },
    data: { status, rejectReason },
  });
  res.json(inv);
});

// Confirm invoice — triggers production orders + accounting entries
router.post('/:id/confirm', requireRole('SUPER_ADMIN', 'MANAGER', 'PROJECT_MANAGER'), async (req: Request, res: Response) => {
  const { advanceAmount, advanceCurrency, notes, advanceAccountId } = req.body;

  // قانون پروپوزال: فعال‌سازی با پیش‌پرداخت صفر فقط توسط مدیر
  const adv = Number(advanceAmount || 0);
  if (adv < 0) throw new AppError(400, 'مبلغ پیش‌پرداخت نمی‌تواند منفی باشد');
  if (adv === 0 && !['SUPER_ADMIN', 'MANAGER'].includes(req.user!.role)) {
    throw new AppError(403, 'فعال‌سازی پروژه بدون پیش‌پرداخت فقط توسط مدیر مجاز است');
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: {
      project: { include: { commissions: { include: { agent: true } } } },
      items: { include: { part: { include: { selectedPrice: true } } } },
    },
  });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  if (invoice.status === 'APPROVED') throw new AppError(400, 'Invoice already confirmed');

  const now = new Date();

  // Group parts by producer for production orders
  const producerMap: Record<string, string[]> = {};
  invoice.items.forEach((item) => {
    const sp = item.part.selectedPrice;
    if (sp?.producerId) (producerMap[sp.producerId] ||= []).push(item.partId);
  });

  await prisma.$transaction(async (tx) => {
    // 1) Confirm invoice + activate project (advance saved on invoice for the accounting step)
    const advRate = await rateFor((advanceCurrency || 'IRR') as Currency);
    await tx.invoice.update({
      where: { id: req.params.id },
      data: {
        status: 'APPROVED', confirmedAt: now, notes,
        advanceAmount: advanceAmount ? Number(advanceAmount) : undefined,
        advanceCurrency: advanceCurrency || undefined,
        advanceRateToIRR: advRate, advanceRateAt: now,
      },
    });
    await tx.project.update({ where: { id: invoice.projectId }, data: { status: 'IN_PRODUCTION' } });

    // 2) Production orders + part milestones
    let orderCount = await tx.productionOrder.count();
    for (const [producerId, partIds] of Object.entries(producerMap)) {
      orderCount += 1;
      const order = await tx.productionOrder.create({
        data: { code: `ORD-${String(orderCount).padStart(5, '0')}`, projectId: invoice.projectId, producerId, status: 'NEW' },
      });
      await tx.part.updateMany({ where: { id: { in: partIds } }, data: { milestone: 'ORDER_PLACED' } });
      // وظیفهٔ «حین ساخت» متصل به کارت سفارش — برای ثبت گفتگوها و تصمیمات حین تولید
      const producer = await tx.producer.findUnique({ where: { id: producerId }, select: { name: true } });
      await tx.task.create({
        data: {
          title: `حین ساخت پروژه ${invoice.project.code} با ${producer?.name || 'سازنده'}`,
          notes: 'گفتگوها، تغییرات و تصمیمات حین تولید را اینجا ثبت کنید.',
          assigneeIds: [req.user!.id],
          assignedTo: { connect: { id: req.user!.id } },
          createdBy: { connect: { id: req.user!.id } },
          project: { connect: { id: invoice.projectId } },
          order: { connect: { id: order.id } },
          entityType: 'ProductionOrder', entityId: order.id,
        },
      });
    }

    // 3) Double-entry accounting (receivable, producer payables, commissions, advance)
    if (writeLegacy()) await postInvoiceObligations(tx, invoice.id, req.user!.id, advanceAccountId || undefined);
    await pwInvoice(tx, invoice.id, req.user!.id);   // حالت 'new': داخل همین تراکنش
  }, { timeout: 20000 });

  // سایهٔ 'dual' — بعد از commit، غیرمسدودکننده (در حالت 'new' بی‌اثر)
  await dwInvoice(invoice.id, req.user!.id);

  // خرید کالا: پس از تأیید مشتری و دریافت پیش‌پرداخت، سفارش نزد تامین‌کننده ثبت می‌شود (بدهی تامین‌کننده + وظیفهٔ پیگیری)
  let purchaseOrders = 0;
  if (invoice.project.type === 'TRADING') {
    const { createPurchaseOrdersForProject } = await import('../orders/purchase.service');
    purchaseOrders = await createPurchaseOrdersForProject(invoice.projectId, req.user!.id);
  }

  await prisma.auditLog.create({
    data: {
      userId: req.user!.id, action: 'UPDATE', entity: 'Invoice', entityId: invoice.id, projectId: invoice.projectId,
      // ۴.۲ — توضیحات توافق در ردپای پروژه ثبت می‌شود تا بعداً قابل‌مشاهده باشد
      changes: { event: 'INVOICE_APPROVED', status: 'APPROVED', advanceAmount, advanceCurrency, agreementNotes: notes || null },
    },
  });

  res.json({ ok: true, purchaseOrders, message: 'Invoice confirmed. Production orders + accounting entries created.' });
});

// Get profit estimate for invoice (live calc)
router.get('/:id/profit-estimate', async (req: Request, res: Response) => {
  const inv = await prisma.invoice.findUnique({
    where: { id: req.params.id },
    include: {
      project: {
        include: {
          commissions: true,
          shippingCost: true,
        },
      },
      items: { include: { part: { select: { quantity: true, weightGrams: true } } } },
    },
  });
  if (!inv) throw new AppError(404, 'Invoice not found');

  const rates = await getLiveRates();
  const toIRR = (amount: number, currency: string) => {
    if (currency === 'IRR') return amount;
    if (currency === 'USD') return amount * rates.USD_TO_IRR;
    return amount * rates.CNY_TO_IRR;
  };

  // قیمت‌ها «واحد»اند → در تعداد هر قطعه ضرب می‌شوند
  const totalSaleIRR = inv.items.reduce((s, i) => s + toIRR(Number(i.saleAmount), i.saleCurrency) * (i.part?.quantity || 1), 0);
  const totalCostIRR = inv.items.reduce((s, i) => s + toIRR(Number(i.costAmount), i.costCurrency) * (i.part?.quantity || 1), 0);

  // Commission
  let commissionIRR = 0;
  inv.project.commissions.forEach((c) => {
    commissionIRR += (Number(c.percentage) / 100) * totalSaleIRR;
  });

  // Shipping estimate — وزن ملاک:
  //   اگر «وزن کل پروژه» دستی وارد شده باشد (estimatedWeightKg) همان ملاک است
  //   (طبق درخواست: حتی اگر وزن تک‌تک قطعات هم وارد شده باشد، وزن کل پروژه اولویت دارد).
  //   در غیر این صورت از جمع وزن قطعاتِ فاکتور (تعداد × وزن گرم → کیلوگرم) استفاده می‌شود.
  let shippingIRR = 0;
  if (inv.project.shippingCost?.ratePerKgAmount) {
    const partsWeightKg = inv.items.reduce(
      (s, i) => s + ((i.part?.quantity || 0) * Number(i.part?.weightGrams || 0)) / 1000, 0,
    );
    const projWeightKg = Number(inv.project.estimatedWeightKg || 0);
    const totalWeightKg = projWeightKg > 0 ? projWeightKg : partsWeightKg;
    shippingIRR = toIRR(Number(inv.project.shippingCost.ratePerKgAmount), inv.project.shippingCost.ratePerKgCurrency || 'IRR') * totalWeightKg;
  }

  const estimatedProfitIRR = totalSaleIRR - totalCostIRR - commissionIRR - shippingIRR;

  res.json({
    totalSaleIRR,
    totalCostIRR,
    commissionIRR,
    shippingIRR,
    estimatedProfitIRR,
    rates,
  });
});

export default router;
