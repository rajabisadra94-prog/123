import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { getCachedRates } from '../../shared/utils/rates';
import { notifyDueFollowUps } from '../crm/crm.routes';
import { notifyMarketDue } from '../market/market.service';

const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response) => {
  void notifyDueFollowUps(); // اعلان پیگیری‌های سررسیدشدهٔ CRM (پس‌زمینه، بدون بلاک‌کردن پاسخ)
  void notifyMarketDue();    // پیگیری‌ها و تعهدهای ارسالِ سررسیدشدهٔ بازار صادرات
  const { customerId, producerId, type } = req.query as { customerId?: string; producerId?: string; type?: string };
  const typeF = type && ['MANUFACTURING', 'TRADING', 'FORWARDING'].includes(type) ? type : undefined;

  const projectWhere: any = {};
  if (customerId) projectWhere.customerId = customerId;
  if (typeF) projectWhere.type = typeF;

  // فیلتر پروژه برای کوئری‌های سفارش/بار (بر اساس مشتری + نوع)
  const projFilter: any = {};
  if (customerId) projFilter.customerId = customerId;
  if (typeF) projFilter.type = typeF;
  const hasProjFilter = Object.keys(projFilter).length > 0;

  const orderWhere: any = {};
  if (producerId) orderWhere.producerId = producerId;
  if (hasProjFilter) orderWhere.project = projFilter;

  const [
    activeProjects, inProduction, completedProjects, totalProjects,
    ordersInProduction, readyForInvoice, pendingInvoices, shipmentsInTransit,
    stalePricing, overdueOrders, shipmentsAwaitingSettlement,
    pricingCount, projectsCompleted, customerWallets,
    purchasePending, cargoAwaitingChina, tradingNoInvoice, byTypeRows,
  ] = await Promise.all([
    prisma.project.count({ where: { ...projectWhere, status: 'ACTIVE' } }),
    prisma.project.count({ where: { ...projectWhere, status: 'IN_PRODUCTION' } }),
    prisma.project.count({ where: { ...projectWhere, status: 'COMPLETED' } }),
    prisma.project.count({ where: projectWhere }),
    prisma.productionOrder.count({ where: { ...orderWhere, status: 'IN_PRODUCTION' } }),
    prisma.project.count({ where: { ...projectWhere, status: 'READY_FOR_INVOICE' } }),
    prisma.invoice.count({ where: { status: { in: ['DRAFT', 'SENT'] }, ...(customerId ? { project: { customerId } } : {}) } }),
    prisma.mainShipment.count({ where: { status: 'IN_TRANSIT' } }),
    // action center
    prisma.pricingRequest.findMany({
      where: { status: 'IN_PROGRESS', ...(customerId ? { project: { customerId } } : {}) },
      include: { project: { include: { customer: { select: { name: true } } } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.productionOrder.findMany({
      where: { ...orderWhere, status: 'IN_PRODUCTION', estimatedEndDate: { lt: new Date() } },
      include: { project: { select: { code: true } }, producer: { select: { name: true } } },
    }),
    prisma.mainShipment.findMany({
      where: { status: 'ARRIVED', freightInvoiceRegistered: false },
      include: { shippingCompany: { select: { name: true } } },
    }),
    prisma.pricingRequest.count({ where: { status: 'IN_PROGRESS' } }),
    prisma.project.count({ where: { ...projectWhere, status: 'COMPLETED' } }),
    prisma.financialAccount.findMany({ where: { ownerType: 'CUSTOMER', controlKind: null, ...(customerId ? { ownerId: customerId } : {}) } }),
    // ── فاز ۷: هشدارهای خرید/فورواردینگ + تفکیک نوع ──
    prisma.productionOrder.findMany({
      where: { kind: 'PURCHASE', purchaseStage: { in: ['ORDERED', 'PREPARING'] }, ...(hasProjFilter ? { project: projFilter } : {}) },
      include: { project: { select: { code: true } }, supplier: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.forwardingCargo.findMany({
      where: { stage: 'AWAITING_CHINA', ...(hasProjFilter ? { project: projFilter } : {}) },
      include: { project: { select: { code: true, customer: { select: { name: true } } } } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.project.findMany({
      where: { type: 'TRADING', status: { not: 'ARCHIVED' }, productionOrders: { some: { kind: 'PURCHASE' } }, invoices: { none: { status: 'APPROVED' } }, ...(customerId ? { customerId } : {}) },
      include: { customer: { select: { name: true } } },
    }),
    prisma.project.groupBy({ by: ['type'], where: { ...(customerId ? { customerId } : {}), status: { notIn: ['ARCHIVED', 'COMPLETED'] } }, _count: { _all: true } }),
  ]);

  // total receivable from customers in IRR-equivalent (نرخ بدون بلاک روی API — رفع کندی داشبورد SF4)
  const rates = await getCachedRates();
  const rateOf = (c: string) => (c === 'IRR' ? 1 : c === 'USD' ? rates.USD_TO_IRR : rates.CNY_TO_IRR);
  let totalReceivableIRR = 0;
  for (const w of customerWallets) totalReceivableIRR += Number(w.balance) * rateOf(w.currency);

  // stale pricing: older than 3 days (configurable client-side later)
  const STALE_DAYS = 3;
  const staleThreshold = Date.now() - STALE_DAYS * 86400000;
  const staleList = stalePricing.filter((p) => new Date(p.createdAt).getTime() < staleThreshold);

  // وظایف کاربر جاری: امروز + عقب‌مانده (فقط وظایف خودِ کاربر)
  const me = req.user!.id;
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const myOpen = await prisma.task.findMany({
    where: { isDone: false, OR: [{ assignedToId: me }, { assigneeIds: { has: me } }] },
    include: { project: { select: { code: true } } },
    orderBy: { dueAt: 'asc' },
  });
  const mapTask = (t: any) => ({ id: t.id, title: t.title, priority: t.priority, dueAt: t.dueAt, project: t.project?.code || null });
  const myTasksOverdue = myOpen.filter((t) => t.dueAt && new Date(t.dueAt) < startToday).map(mapTask);
  const myTasksToday = myOpen.filter((t) => t.dueAt && new Date(t.dueAt) >= startToday && new Date(t.dueAt) <= endToday).map(mapTask);

  // خلاصهٔ مالی: نقدینگی شرکت + بدهی به طرف‌حساب‌ها (معادل تومان)
  const [companyAccounts, payableAccounts] = await Promise.all([
    prisma.financialAccount.findMany({ where: { ownerType: 'COMPANY', controlKind: null, isActive: true } }),
    prisma.financialAccount.findMany({ where: { ownerType: { in: ['PRODUCER', 'SUPPLIER', 'CARRIER', 'EXCHANGE', 'COMMISSION_AGENT'] }, controlKind: null } }),
  ]);
  let cashIRR = 0;
  for (const a of companyAccounts) cashIRR += Number(a.balance) * rateOf(a.currency);
  let payableIRR = 0;
  for (const a of payableAccounts) payableIRR += -Number(a.balance) * rateOf(a.currency); // ماهیت بستانکار: مثبت = بدهی ما

  // تفکیک نوع پروژه (پروژه‌های فعال هر نوع) برای نوار بالای داشبورد
  const byType: Record<string, number> = { MANUFACTURING: 0, TRADING: 0, FORWARDING: 0 };
  for (const r of byTypeRows as any[]) if (byType[r.type] !== undefined) byType[r.type] = r._count._all;
  const PURCHASE_STAGE_FA: Record<string, string> = { ORDERED: 'منتظر بیعانه', DEPOSIT_PAID: 'بیعانه پرداخت‌شده', PREPARING: 'منتظر تسویه', SETTLED: 'تسویه‌شده', SHIPPED: 'ارسال‌شده', RECEIVED: 'دریافت‌شده', READY: 'آمادهٔ حمل' };
  const tradingNoInvoiceList = (typeF && typeF !== 'TRADING') ? [] : (tradingNoInvoice as any[]);

  res.json({
    byType,
    myTasks: { overdue: myTasksOverdue, today: myTasksToday, totalOpen: myOpen.length },
    finance: {
      cashIRR: Math.round(cashIRR),
      receivableIRR: Math.round(totalReceivableIRR),
      payableIRR: Math.round(payableIRR),
      netIRR: Math.round(cashIRR + totalReceivableIRR - payableIRR),
      rates: { usd: rates.USD_TO_IRR, cny: rates.CNY_TO_IRR, stale: rates.isStale },
    },
    kpis: {
      activeProjects, inProduction, completedProjects, totalProjects,
      ordersInProduction, readyForInvoice, pendingInvoices, shipmentsInTransit,
      totalReceivableIRR: Math.round(totalReceivableIRR),
    },
    actionCenter: {
      stalePricing: staleList.map((p) => ({ id: p.id, code: p.project.code, customer: p.project.customer.name, createdAt: p.createdAt })),
      overdueOrders: overdueOrders.map((o) => ({ id: o.id, code: o.code, project: o.project.code, producer: o.producer?.name ?? '', estimatedEndDate: o.estimatedEndDate })),
      shipmentsAwaitingSettlement: shipmentsAwaitingSettlement.map((s) => ({ id: s.id, code: s.code, carrier: s.shippingCompany.name })),
      // فاز ۷ — هشدارهای خرید/فورواردینگ
      purchasePending: purchasePending.map((o) => ({ id: o.id, code: o.code, project: o.project.code, supplier: o.supplier?.name ?? '', stage: PURCHASE_STAGE_FA[o.purchaseStage || ''] || o.purchaseStage })),
      cargoAwaitingChina: cargoAwaitingChina.map((c) => ({ id: c.id, project: c.project.code, customer: c.project.customer?.name ?? '', createdAt: c.createdAt })),
      tradingNoInvoice: tradingNoInvoiceList.map((p) => ({ id: p.id, code: p.code, customer: p.customer?.name ?? '' })),
    },
    pipeline: {
      projects: activeProjects,
      pricing: pricingCount,
      invoicing: readyForInvoice,
      production: ordersInProduction,
      shipping: shipmentsInTransit,
      completed: projectsCompleted,
    },
  });
});

// ── فاز ۷ — گزارش سود per-project + per-type (از دفتر روزنامه، معادل تومان) ──
// سود = درآمد (SALES + FREIGHT_INCOME) − هزینه (PURCHASE + FREIGHT + COMMISSION) برای هر پروژه
router.get('/profit', async (req: Request, res: Response) => {
  const { customerId, type } = req.query as { customerId?: string; type?: string };
  const typeF = type && ['MANUFACTURING', 'TRADING', 'FORWARDING'].includes(type) ? type : undefined;

  const REV = new Set(['SALES', 'FREIGHT_INCOME']);
  const COST = new Set(['PURCHASE', 'FREIGHT', 'COMMISSION']);

  const lines = await prisma.journalLine.findMany({
    where: {
      account: { controlKind: { in: ['SALES', 'FREIGHT_INCOME', 'PURCHASE', 'FREIGHT', 'COMMISSION'] } },
      entry: { projectId: { not: null }, ...(customerId ? { project: { customerId } } : {}) },
    },
    select: { debit: true, credit: true, rateToIRR: true, account: { select: { controlKind: true } }, entry: { select: { projectId: true } } },
  });

  const perProj: Record<string, { revenue: number; cost: number }> = {};
  for (const l of lines) {
    const pid = l.entry.projectId!;
    const ck = l.account.controlKind!;
    const irr = (Number(l.credit) - Number(l.debit)) * Number(l.rateToIRR); // credit مثبت = درآمد؛ debit منفی
    if (!perProj[pid]) perProj[pid] = { revenue: 0, cost: 0 };
    if (REV.has(ck)) perProj[pid].revenue += irr;
    else if (COST.has(ck)) perProj[pid].cost += -irr;
  }

  const projs = await prisma.project.findMany({
    where: { id: { in: Object.keys(perProj) }, ...(typeF ? { type: typeF } : {}) },
    select: { id: true, code: true, type: true, customer: { select: { name: true } } },
  });

  const perProject = projs
    .map((p) => {
      const v = perProj[p.id] || { revenue: 0, cost: 0 };
      return { id: p.id, code: p.code, type: p.type, customer: p.customer.name, revenue: Math.round(v.revenue), cost: Math.round(v.cost), profit: Math.round(v.revenue - v.cost) };
    })
    .sort((a, b) => b.profit - a.profit);

  const perType: Record<string, { revenue: number; cost: number; profit: number }> = {
    MANUFACTURING: { revenue: 0, cost: 0, profit: 0 },
    TRADING: { revenue: 0, cost: 0, profit: 0 },
    FORWARDING: { revenue: 0, cost: 0, profit: 0 },
  };
  for (const p of perProject) { const t = perType[p.type]; if (t) { t.revenue += p.revenue; t.cost += p.cost; t.profit += p.profit; } }

  res.json({ perType, perProject });
});

export default router;
