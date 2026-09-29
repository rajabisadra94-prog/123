import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { requirePermission } from '../../shared/middleware/permissions';
import { AppError } from '../../shared/middleware/errorHandler';
import { sendPushToUsers } from '../../shared/utils/push';

const router = Router();
router.use(authenticate);

export const LEAD_STAGES = ['NEW', 'CONTACTED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'];

// اعلان پیگیری‌های سررسیدشده به مسئول (زنگوله + Push) — idempotent با followUpNotifiedAt
// از مسیر داشبورد صدا زده می‌شود تا وقتی کسی برنامه را باز می‌کند، اعلان‌ها فرستاده شوند.
export async function notifyDueFollowUps() {
  try {
    const now = new Date();
    const due = await prisma.lead.findMany({
      where: { stage: { notIn: ['WON', 'LOST'] }, assignedToId: { not: null }, nextFollowUpAt: { not: null, lte: now } },
      select: { id: true, name: true, assignedToId: true, nextFollowUpAt: true, followUpNotifiedAt: true },
    });
    for (const l of due) {
      if (l.followUpNotifiedAt && l.nextFollowUpAt && l.followUpNotifiedAt >= l.nextFollowUpAt) continue; // قبلاً برای همین موعد فرستاده شده
      await prisma.notification.create({
        data: { userId: l.assignedToId!, type: 'CRM_FOLLOWUP', message: `⏰ زمان پیگیری سرنخ «${l.name}» رسیده است`, entityType: 'Lead', entityId: l.id },
      });
      await sendPushToUsers([l.assignedToId!], 'پیگیری سرنخ', `زمان پیگیری «${l.name}» رسیده`, { type: 'CRM_FOLLOWUP', entityId: l.id });
      await prisma.lead.update({ where: { id: l.id }, data: { followUpNotifiedAt: now } });
    }
  } catch (e) {
    console.error('notifyDueFollowUps failed:', (e as Error).message);
  }
}

// نگاشت شناسه→نام کاربر برای نمایش (assignee/creator)
async function userMap(ids: (string | null | undefined)[]) {
  const uniq = [...new Set(ids.filter(Boolean))] as string[];
  if (!uniq.length) return {} as Record<string, string>;
  const users = await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
  return Object.fromEntries(users.map((u) => [u.id, u.name]));
}

// ─── سرنخ‌ها ─────────────────────────────────────────────
router.get('/leads', async (req: Request, res: Response) => {
  const { stage, assignedToId, search } = req.query as Record<string, string>;
  const where: any = {};
  if (stage) where.stage = stage;
  if (assignedToId) where.assignedToId = assignedToId;
  if (search) where.OR = [
    { name: { contains: search, mode: 'insensitive' } },
    { company: { contains: search, mode: 'insensitive' } },
    { phone: { contains: search } },
  ];
  const leads = await prisma.lead.findMany({
    where,
    include: { assignedTo: { select: { id: true, name: true } }, customer: { select: { id: true, name: true } }, _count: { select: { interactions: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  res.json(leads);
});

// خلاصهٔ قیف: شمارش هر مرحله (برای کانبان/داشبورد)
router.get('/summary', async (_req: Request, res: Response) => {
  const grouped = await prisma.lead.groupBy({ by: ['stage'], _count: { _all: true } });
  const byStage: Record<string, number> = {};
  for (const s of LEAD_STAGES) byStage[s] = 0;
  for (const g of grouped) byStage[g.stage] = g._count._all;
  res.json({ byStage });
});

// تحلیل فروش: نرخ تبدیل، ارزش قیف per مرحله، سرنخ per منبع
router.get('/analytics', async (_req: Request, res: Response) => {
  const leads = await prisma.lead.findMany({ select: { stage: true, estimatedValue: true, source: true } });
  const byStage: Record<string, { count: number; value: number }> = {};
  for (const s of LEAD_STAGES) byStage[s] = { count: 0, value: 0 };
  const bySource: Record<string, number> = {};
  let totalValue = 0, openValue = 0;
  for (const l of leads) {
    const v = Number(l.estimatedValue || 0);
    byStage[l.stage] = byStage[l.stage] || { count: 0, value: 0 };
    byStage[l.stage].count++; byStage[l.stage].value += v;
    totalValue += v;
    if (!['WON', 'LOST'].includes(l.stage)) openValue += v;
    const src = l.source?.trim() || 'نامشخص';
    bySource[src] = (bySource[src] || 0) + 1;
  }
  const won = byStage['WON'].count, lost = byStage['LOST'].count, closed = won + lost;
  res.json({
    total: leads.length, byStage,
    bySource: Object.entries(bySource).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    totalValue, openValue, won, lost,
    conversionRate: closed ? Math.round((won / closed) * 100) : 0,
    wonValue: byStage['WON'].value,
  });
});

// پیگیری‌های سررسیدشده/امروز (یادآور) — سرنخ‌های باز با nextFollowUpAt
router.get('/follow-ups', async (req: Request, res: Response) => {
  const mine = req.query.mine === '1';
  const where: any = {
    stage: { notIn: ['WON', 'LOST'] },
    nextFollowUpAt: { not: null },
    ...(mine ? { assignedToId: req.user!.id } : {}),
  };
  const leads = await prisma.lead.findMany({
    where,
    include: { assignedTo: { select: { id: true, name: true } } },
    orderBy: { nextFollowUpAt: 'asc' },
  });
  const now = new Date();
  const today = now.toDateString();
  const overdue = leads.filter((l) => l.nextFollowUpAt && new Date(l.nextFollowUpAt) < now && new Date(l.nextFollowUpAt).toDateString() !== today);
  const dueToday = leads.filter((l) => l.nextFollowUpAt && new Date(l.nextFollowUpAt).toDateString() === today);
  res.json({ overdue, today: dueToday, upcoming: leads.filter((l) => l.nextFollowUpAt && new Date(l.nextFollowUpAt) > now && new Date(l.nextFollowUpAt).toDateString() !== today) });
});

router.get('/leads/:id', async (req: Request, res: Response) => {
  const lead = await prisma.lead.findUnique({
    where: { id: req.params.id },
    include: {
      assignedTo: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true } },
      interactions: { orderBy: { occurredAt: 'desc' } },
    },
  });
  if (!lead) throw new AppError(404, 'سرنخ یافت نشد');
  const names = await userMap(lead.interactions.map((i) => i.createdById).concat(lead.createdById));
  res.json({ ...lead, createdByName: lead.createdById ? names[lead.createdById] : null, interactions: lead.interactions.map((i) => ({ ...i, createdByName: i.createdById ? names[i.createdById] : null })) });
});

router.post('/leads', requirePermission('crm', 'create'), async (req: Request, res: Response) => {
  const { name, company, phone, email, source, stage, estimatedValue, notes, nextFollowUpAt, assignedToId } = req.body;
  if (!name?.trim()) throw new AppError(400, 'نام سرنخ لازم است');
  if (stage && !LEAD_STAGES.includes(stage)) throw new AppError(400, 'مرحلهٔ نامعتبر');
  const lead = await prisma.lead.create({
    data: {
      name: name.trim(), company, phone, email, source, stage: stage || 'NEW',
      estimatedValue: estimatedValue != null && estimatedValue !== '' ? Number(estimatedValue) : null,
      notes, nextFollowUpAt: nextFollowUpAt ? new Date(nextFollowUpAt) : null,
      assignedToId: assignedToId || null, createdById: req.user!.id,
    },
  });
  res.status(201).json(lead);
});

router.patch('/leads/:id', requirePermission('crm', 'edit'), async (req: Request, res: Response) => {
  const b = req.body;
  if (b.stage && !LEAD_STAGES.includes(b.stage)) throw new AppError(400, 'مرحلهٔ نامعتبر');
  const data: any = {};
  for (const k of ['name', 'company', 'phone', 'email', 'source', 'stage', 'notes', 'lostReason', 'assignedToId'] as const) {
    if (b[k] !== undefined) data[k] = b[k] || null;
  }
  if (b.estimatedValue !== undefined) data.estimatedValue = b.estimatedValue !== '' && b.estimatedValue != null ? Number(b.estimatedValue) : null;
  if (b.nextFollowUpAt !== undefined) data.nextFollowUpAt = b.nextFollowUpAt ? new Date(b.nextFollowUpAt) : null;
  const lead = await prisma.lead.update({ where: { id: req.params.id }, data });
  res.json(lead);
});

router.delete('/leads/:id', requirePermission('crm', 'delete'), async (req: Request, res: Response) => {
  await prisma.lead.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// تبدیل سرنخ به مشتری (برد) — لینک به مشتری موجود یا ساخت مشتری جدید
router.post('/leads/:id/convert', requirePermission('crm', 'edit'), async (req: Request, res: Response) => {
  const { customerId, shortCode } = req.body as { customerId?: string; shortCode?: string };
  const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
  if (!lead) throw new AppError(404, 'سرنخ یافت نشد');
  if (lead.customerId) throw new AppError(400, 'این سرنخ قبلاً به مشتری تبدیل شده است');

  let customer;
  if (customerId) {
    customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new AppError(404, 'مشتری یافت نشد');
  } else {
    if (!shortCode || shortCode.length !== 3) throw new AppError(400, 'کد ۳ حرفی مشتری لازم است');
    customer = await prisma.customer.create({
      data: { name: lead.company || lead.name, shortCode: shortCode.toUpperCase(), phone: lead.phone, email: lead.email, notes: lead.notes },
    });
  }
  // سرنخ WON + وصل به مشتری؛ تعاملات هم به مشتری وصل می‌شوند تا در نمای ۳۶۰ دیده شوند
  await prisma.$transaction([
    prisma.lead.update({ where: { id: lead.id }, data: { stage: 'WON', customerId: customer.id } }),
    prisma.crmInteraction.updateMany({ where: { leadId: lead.id, customerId: null }, data: { customerId: customer.id } }),
  ]);
  res.json({ ok: true, customer });
});

// ─── تعاملات ─────────────────────────────────────────────
router.post('/interactions', requirePermission('crm', 'create'), async (req: Request, res: Response) => {
  const { type, note, outcome, occurredAt, leadId, customerId, nextFollowUpAt } = req.body;
  if (!note?.trim()) throw new AppError(400, 'متن تعامل لازم است');
  if (!leadId && !customerId) throw new AppError(400, 'سرنخ یا مشتری لازم است');
  const interaction = await prisma.crmInteraction.create({
    data: {
      type: type || 'CALL', note: note.trim(), outcome: outcome || null,
      occurredAt: occurredAt ? new Date(occurredAt) : new Date(),
      leadId: leadId || null, customerId: customerId || null, createdById: req.user!.id,
    },
  });
  // اگر تاریخ پیگیری بعدی داده شد و روی سرنخ است، تاریخ پیگیری سرنخ به‌روز شود
  if (nextFollowUpAt && leadId) {
    await prisma.lead.update({ where: { id: leadId }, data: { nextFollowUpAt: new Date(nextFollowUpAt) } });
  }
  res.status(201).json(interaction);
});

router.get('/interactions', async (req: Request, res: Response) => {
  const { leadId, customerId } = req.query as Record<string, string>;
  if (!leadId && !customerId) throw new AppError(400, 'leadId یا customerId لازم است');
  const items = await prisma.crmInteraction.findMany({
    where: { ...(leadId ? { leadId } : {}), ...(customerId ? { customerId } : {}) },
    orderBy: { occurredAt: 'desc' },
  });
  const names = await userMap(items.map((i) => i.createdById));
  res.json(items.map((i) => ({ ...i, createdByName: i.createdById ? names[i.createdById] : null })));
});

router.patch('/interactions/:id', requirePermission('crm', 'edit'), async (req: Request, res: Response) => {
  const b = req.body;
  const data: any = {};
  if (b.type !== undefined) data.type = b.type;
  if (b.note !== undefined && b.note.trim()) data.note = b.note.trim();
  if (b.outcome !== undefined) data.outcome = b.outcome || null;
  if (b.occurredAt !== undefined && b.occurredAt) data.occurredAt = new Date(b.occurredAt);
  const item = await prisma.crmInteraction.update({ where: { id: req.params.id }, data });
  res.json(item);
});

router.delete('/interactions/:id', requirePermission('crm', 'delete'), async (req: Request, res: Response) => {
  await prisma.crmInteraction.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ─── نمای ۳۶۰ مشتری: تعاملات + پروژه‌ها + وضعیت مالی ───
router.get('/customers/:id/360', async (req: Request, res: Response) => {
  const customerId = req.params.id;
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new AppError(404, 'مشتری یافت نشد');

  const [interactions, projects, wallets, leads] = await Promise.all([
    prisma.crmInteraction.findMany({ where: { customerId }, orderBy: { occurredAt: 'desc' } }),
    prisma.project.findMany({ where: { customerId }, select: { id: true, code: true, description: true, status: true, type: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
    prisma.financialAccount.findMany({ where: { ownerType: 'CUSTOMER', ownerId: customerId }, select: { currency: true, balance: true } }),
    prisma.lead.findMany({ where: { customerId }, select: { id: true, name: true, stage: true, createdAt: true } }),
  ]);
  const names = await userMap(interactions.map((i) => i.createdById));
  const balances = wallets.map((w) => ({ currency: w.currency, balance: Number(w.balance) }));
  res.json({
    customer,
    interactions: interactions.map((i) => ({ ...i, createdByName: i.createdById ? names[i.createdById] : null })),
    projects,
    balances,
    leads,
    stats: { projectCount: projects.length, interactionCount: interactions.length },
  });
});

export default router;
