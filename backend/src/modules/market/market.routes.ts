import { Router, Request, Response } from 'express';
import path from 'path';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { requirePermission } from '../../shared/middleware/permissions';
import { upload } from '../../shared/middleware/upload';
import { AppError } from '../../shared/middleware/errorHandler';
import { buildPhoneNorm, nextContactCode, refreshScore, notifyMarketDue, CLOSED_STATUSES, dueBucket, nextStatusForCallResult, iraqHour } from './market.service';
import { registerExcelRoutes } from './market.excel';
import { registerVCardRoutes } from './market.vcard';
import { registerWhatsAppRoutes } from './market.whatsapp';
import { marketAudit, registerAuditRoutes } from './market.audit';

const router = Router();
router.use(authenticate);
// هر نوشتنِ موفق در این ماژول در دفترچهٔ تغییرات می‌نشیند — پس از احراز هویت،
// چون بدون کاربر «توسط کی» معنایی ندارد.
router.use(marketAudit);

export { notifyMarketDue };

export const MARKET_STATUSES = ['NEW', 'PHONE_ONLY', 'ATTEMPTED', 'NEEDS_RECALL', 'AWAITING_QUOTE', 'MEETING_SET', 'CONTACTED', 'INTERESTED', 'NEGOTIATING', 'SAMPLE_SENT', 'CUSTOMER', 'NOT_INTERESTED', 'UNREACHABLE', 'BLACKLIST'] as const;
const CONTACT_TYPES = ['SHOP', 'DISTRIBUTOR', 'CLINIC', 'LAB', 'IMPORTER', 'OTHER'];
const INTEREST_LEVELS = ['NOT_DISCUSSED', 'POSITIVE', 'NEUTRAL', 'NEGATIVE'];
const PRICE_OPINIONS = ['NOT_DISCUSSED', 'GOOD', 'ACCEPTABLE', 'EXPENSIVE'];
const CHANNELS = ['CALL', 'WHATSAPP', 'TELEGRAM', 'INSTAGRAM', 'EMAIL', 'VISIT', 'OTHER'];
const CALL_RESULTS = ['ANSWERED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'CALLBACK', 'REJECTED'];
const PROMISE_KINDS = ['SAMPLE', 'CATALOG', 'PRICE_LIST', 'QUOTE', 'VIDEO', 'CERTIFICATE', 'OTHER'];
const PROMISE_STATUSES = ['PENDING', 'SENT', 'DELIVERED', 'CANCELLED'];

const CONTACT_LIST_INCLUDE = {
  city: { select: { id: true, name: true, nameAr: true, governorate: true } },
  assignedTo: { select: { id: true, name: true } },
  interests: { select: { productId: true, level: true, priceOpinion: true, sampleRequested: true } },
  _count: { select: { calls: true, promises: true } },
};

/** نگاشت شناسه→نام کاربر برای نمایش سازنده/مسئول */
async function userMap(ids: (string | null | undefined)[]) {
  const uniq = [...new Set(ids.filter(Boolean))] as string[];
  if (!uniq.length) return {} as Record<string, string>;
  const users = await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
  return Object.fromEntries(users.map((u) => [u.id, u.name]));
}

/**
 * فیلترهای لیست مخاطبین را به `where` پریزما تبدیل می‌کند.
 * چون هم لیست، هم خروجی اکسل، هم صف تماس از همین استفاده می‌کنند،
 * یک‌جا نوشته شده تا «چیزی که در جدول می‌بینی» و «چیزی که اکسل می‌گیری» هرگز فرق نکنند.
 */
export function buildContactWhere(q: Record<string, string>) {
  const where: any = {};
  // بایگانی پیش‌فرض پنهان است — نکتهٔ کل بایگانی همین است که از جلوی چشم برود.
  // `archived=1` فقط بایگانی، `archived=all` هر دو.
  if (q.archived === '1') where.archived = true;
  else if (q.archived !== 'all') where.archived = false;
  if (q.cityId) where.cityId = q.cityId === 'none' ? null : q.cityId;
  if (q.governorate) where.city = { governorate: q.governorate };
  if (q.status) where.status = { in: q.status.split(',').filter(Boolean) };
  if (q.type) where.type = q.type;
  if (q.assignedToId) where.assignedToId = q.assignedToId === 'none' ? null : q.assignedToId;
  if (q.source) where.source = q.source;
  if (q.tag) where.tags = { has: q.tag };
  if (q.language) where.language = q.language;
  if (q.minRating) where.rating = { gte: Number(q.minRating) };
  if (q.minScore) where.score = { gte: Number(q.minScore) };
  if (q.doNotCall === '1') where.doNotCall = true;
  if (q.doNotCall === '0') where.doNotCall = false;

  // سه‌حالته، چون «نپرسیده‌ایم» یک فیلترِ واقعی است: «به چه کسانی هنوز
  // نگفته‌ایم نمایندگی می‌دهیم؟» درست همان لیستی است که باید زنگ زد.
  if (q.exhibition) where.attendsExhibition = q.exhibition === 'none' ? null : q.exhibition === '1';
  if (q.agency) where.wantsAgency = q.agency === 'none' ? null : q.agency === '1';

  // پیگیری معلق دارد یا نه
  if (q.hasFollowUp === '1') where.nextFollowUpAt = { not: null };
  if (q.overdue === '1') where.nextFollowUpAt = { not: null, lte: new Date() };
  // تعهد ارسالِ انجام‌نشده دارد
  if (q.hasPromise === '1') where.promises = { some: { status: 'PENDING' } };
  // هنوز با او صحبت نشده — همان چیزی که صف تماس می‌خواهد
  if (q.neverContacted === '1') where.status = { in: ['NEW', 'ATTEMPTED'] };

  // ⭐ فیلتر ترکیبی محصول: «چه کسانی فلان محصول را پسندیدند و قیمتش را هم قبول داشتند»
  if (q.productId) {
    const cond: any = { productId: q.productId };
    if (q.level) cond.level = { in: q.level.split(',').filter(Boolean) };
    if (q.priceOpinion) cond.priceOpinion = { in: q.priceOpinion.split(',').filter(Boolean) };
    if (q.sampleRequested === '1') cond.sampleRequested = true;
    where.interests = { some: cond };
  } else if (q.level || q.priceOpinion) {
    // بدون تعیین محصول: هر محصولی که این نظر را داشته باشد
    const cond: any = {};
    if (q.level) cond.level = { in: q.level.split(',').filter(Boolean) };
    if (q.priceOpinion) cond.priceOpinion = { in: q.priceOpinion.split(',').filter(Boolean) };
    where.interests = { some: cond };
  } else if (q.sampleRequested === '1') {
    // چیپ «نمونه خواسته» بدون فیلتر محصول — قبلاً فقط داخل شاخهٔ productId خوانده می‌شد و این حالت بی‌صدا نادیده گرفته می‌شد
    where.interests = { some: { sampleRequested: true } };
  }

  if (q.search) {
    const s = q.search.trim();
    const digits = s.replace(/\D/g, '');
    where.OR = [
      { name: { contains: s, mode: 'insensitive' } },
      { nameAr: { contains: s, mode: 'insensitive' } },
      { ownerName: { contains: s, mode: 'insensitive' } },
      { code: { contains: s, mode: 'insensitive' } },
      { address: { contains: s, mode: 'insensitive' } },
      ...(digits.length >= 4 ? [
        { phone: { contains: digits } },
        { phone2: { contains: digits } },
        { whatsapp: { contains: digits } },
        // شمارهٔ یکدست‌شده: «۰۷۷۰…» و «+964770…» هر دو همین‌جا پیدا می‌شوند
        { phoneNorm: { hasSome: [digits, '964' + digits.replace(/^0+/, '')] } },
      ] : []),
    ];
  }
  return where;
}

function orderFor(sort?: string): any {
  switch (sort) {
    case 'score': return [{ score: 'desc' }, { name: 'asc' }];
    case 'rating': return [{ rating: 'desc' }, { score: 'desc' }];
    case 'newest': return { createdAt: 'desc' };
    case 'oldest': return { createdAt: 'asc' };
    case 'lastContact': return [{ lastContactAt: 'desc' }];
    case 'followUp': return [{ nextFollowUpAt: 'asc' }];
    default: return { name: 'asc' };
  }
}

// ═══════════════════════════════════════════════
// مخاطبین
// ═══════════════════════════════════════════════

router.get('/contacts', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  const take = Math.min(Number(q.take) || 500, 2000);
  const skip = Number(q.skip) || 0;
  const where = buildContactWhere(q);
  const [rows, total] = await Promise.all([
    prisma.marketContact.findMany({ where, include: CONTACT_LIST_INCLUDE, orderBy: orderFor(q.sort), take, skip }),
    prisma.marketContact.count({ where }),
  ]);
  res.json({ rows, total, take, skip });
});

/* `GET /contacts/board` حذف شد: تنها مصرف‌کننده‌اش تب «شهرها» بود که برداشته
   شد (آمارش در «گزارش» ← پوشش شهرها و گروه‌بندی شهر/استانِ خود لیست تکرار
   می‌شد). پوششِ شهرهای دست‌نخورده حالا از `/analytics` می‌آید. */

/**
 * شمارش هر مرحلهٔ پیگیری — برای چیپ‌های بالای لیست.
 * جدا از `/contacts` است چون آن یکی فقط ردیف‌های *یک* مرحله را برمی‌گرداند،
 * ولی چیپ‌ها باید عددِ همهٔ مرحله‌ها را هم‌زمان نشان دهند.
 * فیلترهای دیگر (شهر/جستجو) اعمال می‌شوند تا عددها با لیست بخوانند.
 */
router.get('/contacts/stage-counts', async (req: Request, res: Response) => {
  const q = { ...(req.query as Record<string, string>) };
  delete q.status;      // خودِ مرحله را کنار می‌گذاریم وگرنه بقیه صفر می‌شوند
  delete q.archived;
  const base = buildContactWhere({ ...q, archived: 'all' });

  const grouped = await prisma.marketContact.groupBy({
    by: ['status'],
    where: { ...base, archived: false },
    _count: { _all: true },
  });
  const byStatus: Record<string, number> = {};
  for (const g of grouped) byStatus[g.status] = g._count._all;

  const [archived, active] = await Promise.all([
    prisma.marketContact.count({ where: { ...base, archived: true } }),
    prisma.marketContact.count({ where: { ...base, archived: false } }),
  ]);
  res.json({ byStatus, archived, active });
});

/** گزینه‌های واقعیِ موجود در داده — برای دراپ‌داون فیلترها */
router.get('/contacts/facets', async (_req: Request, res: Response) => {
  const rows = await prisma.marketContact.findMany({ select: { source: true, tags: true, language: true } });
  const uniq = (arr: any[]) => [...new Set(arr.filter(Boolean))].sort();
  res.json({
    sources: uniq(rows.map((r) => r.source)),
    tags: uniq(rows.flatMap((r) => r.tags || [])),
    languages: uniq(rows.map((r) => r.language)),
  });
});

/**
 * صف تماس — ورودی «اتاق تماس».
 * ترتیب: اول پیگیری‌های سررسیدشده (قولِ خودمان به مشتری)، بعد کسانی که هنوز
 * تماس نگرفته‌ایم، بعد بقیه بر اساس امتیاز. شماره‌نداشته‌ها و doNotCall بیرون‌اند.
 */
router.get('/contacts/queue', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  const take = Math.min(Number(q.take) || 50, 200);
  const base: any = { ...buildContactWhere(q), doNotCall: false };
  if (!q.status && !q.neverContacted) base.status = { notIn: CLOSED_STATUSES };

  const now = new Date();
  const rows = await prisma.marketContact.findMany({
    where: base,
    include: CONTACT_LIST_INCLUDE,
    orderBy: [{ score: 'desc' }, { name: 'asc' }],
    take: take * 3, // فضای کافی برای مرتب‌سازی سه‌لایهٔ زیر
  });

  const rank = (c: any) => {
    if (c.nextFollowUpAt && new Date(c.nextFollowUpAt) <= now) return 0; // سررسید شده
    if (c.status === 'NEW') return 1;                                    // هرگز تماس نگرفته‌ایم
    if (c.status === 'ATTEMPTED') return 2;                              // جواب نداده بود
    return 3;
  };
  const sorted = rows.sort((a, b) => rank(a) - rank(b) || b.score - a.score).slice(0, take);
  res.json(sorted);
});

/** پیگیری‌های معلق: عقب‌افتاده / امروز / آینده */
router.get('/contacts/follow-ups', async (_req: Request, res: Response) => {
  const rows = await prisma.marketContact.findMany({
    where: { status: { notIn: CLOSED_STATUSES }, nextFollowUpAt: { not: null } },
    include: CONTACT_LIST_INCLUDE,
    orderBy: { nextFollowUpAt: 'asc' },
  });
  const now = new Date();
  res.json({
    overdue: rows.filter((r) => dueBucket(r.nextFollowUpAt, now) === 'overdue'),
    today: rows.filter((r) => dueBucket(r.nextFollowUpAt, now) === 'today'),
    upcoming: rows.filter((r) => dueBucket(r.nextFollowUpAt, now) === 'upcoming'),
  });
});

/** پروفایل کامل مخاطب: علاقه به هر ۵ محصول + تماس‌ها + قول‌ها + فایل‌ها */
router.get('/contacts/:id', async (req: Request, res: Response) => {
  const contact = await prisma.marketContact.findUnique({
    where: { id: req.params.id },
    include: {
      city: true,
      assignedTo: { select: { id: true, name: true } },
      customer: { select: { id: true, name: true, shortCode: true } },
      interests: true,
      calls: { orderBy: { occurredAt: 'desc' } },
      promises: { include: { product: { select: { id: true, name: true } } }, orderBy: [{ status: 'asc' }, { dueAt: 'asc' }] },
      files: { orderBy: { createdAt: 'desc' } },
    },
  });
  if (!contact) throw new AppError(404, 'مخاطب یافت نشد');

  // همیشه یک ردیف به‌ازای هر محصول فعال برگردان — حتی اگر هنوز ثبت نشده باشد،
  // تا فرم فرانت بدون منطق اضافه، جدول کاملِ ۵ محصول را نشان دهد.
  const products = await prisma.marketProduct.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
  const byProduct = new Map(contact.interests.map((i) => [i.productId, i]));
  const interests = products.map((p) => ({
    product: p,
    ...(byProduct.get(p.id) || {
      id: null, productId: p.id, contactId: contact.id, level: 'NOT_DISCUSSED', priceOpinion: 'NOT_DISCUSSED',
      quotedPriceUsd: null, targetPriceUsd: null, currentSupplier: null, competitorPriceUsd: null,
      monthlyQty: null, sampleRequested: false, note: null,
    }),
  }));

  const names = await userMap([contact.createdById, ...contact.calls.map((c) => c.createdById)]);
  res.json({
    ...contact,
    interests,
    createdByName: contact.createdById ? names[contact.createdById] : null,
    calls: contact.calls.map((c) => ({ ...c, createdByName: c.createdById ? names[c.createdById] : null })),
  });
});

const CONTACT_STR_FIELDS = ['name', 'nameAr', 'ownerName', 'address', 'mapUrl', 'phone', 'phone2',
  'whatsapp', 'telegram', 'instagram', 'email', 'website', 'language', 'source', 'notes', 'followUpReason',
  'otherProductsNote'] as const;

/** بدنهٔ درخواست را به data معتبر تبدیل می‌کند (مشترک بین ساخت و ویرایش) */
function buildContactData(b: any) {
  const data: any = {};
  for (const f of CONTACT_STR_FIELDS) if (b[f] !== undefined) data[f] = b[f]?.toString().trim() || null;
  if (b.type !== undefined) {
    if (b.type && !CONTACT_TYPES.includes(b.type)) throw new AppError(400, 'نوع مخاطب نامعتبر است');
    data.type = b.type || 'SHOP';
  }
  if (b.status !== undefined) {
    if (!MARKET_STATUSES.includes(b.status)) throw new AppError(400, 'وضعیت نامعتبر است');
    data.status = b.status;
  }
  if (b.cityId !== undefined) data.cityId = b.cityId || null;
  if (b.assignedToId !== undefined) data.assignedToId = b.assignedToId || null;
  // بایگانی/برگرداندن از داخل پروندهٔ خود مخاطب
  if (b.archived !== undefined) {
    data.archived = !!b.archived;
    data.archivedAt = b.archived ? new Date() : null;
    if (!b.archived) data.archivedReason = null;
  }
  if (b.archivedReason !== undefined) data.archivedReason = b.archivedReason?.toString().trim() || null;
  if (b.rating !== undefined) {
    const r = b.rating === '' || b.rating == null ? null : Number(b.rating);
    if (r != null && (!Number.isInteger(r) || r < 1 || r > 5)) throw new AppError(400, 'رتبه باید عددی بین ۱ تا ۵ باشد');
    data.rating = r;
  }
  if (b.tags !== undefined) {
    data.tags = Array.isArray(b.tags) ? b.tags.map((t: any) => String(t).trim()).filter(Boolean)
      : String(b.tags).split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (b.doNotCall !== undefined) data.doNotCall = !!b.doNotCall;
  for (const f of ['attendsExhibition', 'wantsAgency'] as const) {
    // '' و null هر دو یعنی «برگرد به نپرسیده»؛ 'false' هم از فرم‌های HTML می‌آید
    if (b[f] !== undefined) data[f] = b[f] === null || b[f] === '' ? null : b[f] !== false && b[f] !== 'false';
  }
  if (b.nextFollowUpAt !== undefined) {
    data.nextFollowUpAt = b.nextFollowUpAt ? new Date(b.nextFollowUpAt) : null;
    // موعد که عوض شد، اعلانِ موعد قبلی نباید جلوی اعلان جدید را بگیرد
    data.followUpNotifiedAt = null;
  }
  return data;
}

/**
 * جلوی ثبت شمارهٔ تکراری را می‌گیرد.
 *
 * مقایسه روی `phoneNorm` است نه متن خام، پس «۰۷۷۰…» و «+964770…» و
 * «۰۹۶۴ ۷۷۰…» همه یک شماره حساب می‌شوند. `exceptId` برای ویرایش لازم است
 * تا رکورد در حال ویرایش خودش را تکراری نبیند.
 */
async function assertPhonesFree(phones: string[], exceptId?: string) {
  if (!phones.length) return;
  const clash = await prisma.marketContact.findFirst({
    where: { phoneNorm: { hasSome: phones }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true, code: true, name: true, phoneNorm: true },
  });
  if (!clash) return;
  const shared = clash.phoneNorm.filter((p) => phones.includes(p));
  throw new AppError(409, `این شماره قبلاً برای «${clash.name}» (${clash.code}) ثبت شده است: +${shared[0] || phones[0]}`);
}

router.post('/contacts', requirePermission('market', 'create'), async (req: Request, res: Response) => {
  const b = req.body;
  if (!b.name?.trim()) throw new AppError(400, 'نام مغازه/شرکت لازم است');
  const data = buildContactData(b);
  const phoneNorm = buildPhoneNorm(b.phone, b.phone2, b.whatsapp);
  await assertPhonesFree(phoneNorm);
  const contact = await prisma.marketContact.create({
    data: {
      ...data,
      name: b.name.trim(),
      code: await nextContactCode(),
      phoneNorm,
      createdById: req.user!.id,
    },
    include: CONTACT_LIST_INCLUDE,
  });
  res.status(201).json(contact);
});

router.patch('/contacts/:id', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  const b = req.body;
  const current = await prisma.marketContact.findUnique({ where: { id: req.params.id } });
  if (!current) throw new AppError(404, 'مخاطب یافت نشد');
  const data = buildContactData(b);
  // «مشتری» فقط باید از دکمهٔ «تبدیل به مشتری» بیاید — چون آن مسیر واقعاً یک Customer
  // می‌سازد/وصل می‌کند؛ یک PATCH ساده وضعیت را عوض می‌کرد بدون اینکه customerId ست شود
  if (data.status === 'CUSTOMER' && !current.customerId) {
    throw new AppError(400, 'برای تبدیل به مشتری از دکمهٔ «تبدیل به مشتری» در پروفایل مخاطب استفاده کنید');
  }
  if (b.name !== undefined) {
    if (!b.name?.trim()) throw new AppError(400, 'نام نمی‌تواند خالی باشد');
    data.name = b.name.trim();
  }
  // هر بار که یکی از شماره‌ها دست بخورد، شکل یکدست‌شده باید از نو ساخته شود
  if (b.phone !== undefined || b.phone2 !== undefined || b.whatsapp !== undefined) {
    data.phoneNorm = buildPhoneNorm(
      b.phone !== undefined ? b.phone : current.phone,
      b.phone2 !== undefined ? b.phone2 : current.phone2,
      b.whatsapp !== undefined ? b.whatsapp : current.whatsapp,
    );
    await assertPhonesFree(data.phoneNorm, current.id);
  }
  await prisma.marketContact.update({ where: { id: req.params.id }, data });
  if (data.status !== undefined || data.rating !== undefined) await refreshScore(req.params.id);
  const contact = await prisma.marketContact.findUnique({ where: { id: req.params.id }, include: CONTACT_LIST_INCLUDE });
  res.json(contact);
});

router.delete('/contacts/:id', requirePermission('market', 'delete'), async (req: Request, res: Response) => {
  await prisma.marketContact.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/** اقدام گروهی روی چند مخاطب — بعد از ورود اکسل لازم می‌شود */
router.post('/contacts/bulk', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  const { ids, action, value } = req.body as { ids: string[]; action: string; value: any };
  if (!Array.isArray(ids) || !ids.length) throw new AppError(400, 'هیچ مخاطبی انتخاب نشده است');

  if (action === 'delete') {
    const r = await prisma.marketContact.deleteMany({ where: { id: { in: ids } } });
    return res.json({ ok: true, count: r.count });
  }

  const data: any = {};
  if (action === 'status') {
    if (!MARKET_STATUSES.includes(value)) throw new AppError(400, 'وضعیت نامعتبر است');
    // همان قفلِ PATCH تکی — تبدیل به مشتری باید یکی‌یکی از پروفایل مخاطب انجام شود
    if (value === 'CUSTOMER') throw new AppError(400, 'تبدیل به مشتری باید یکی‌یکی از داخل پروفایل هر مخاطب انجام شود');
    data.status = value;
  } else if (action === 'city') data.cityId = value || null;
  else if (action === 'assign') data.assignedToId = value || null;
  else if (action === 'exhibition' || action === 'agency') {
    // بعد از یک نمایشگاه، ده‌ها غرفه‌دار یکجا علامت می‌خورند — یکی‌یکی زدنش بی‌معنی است
    const field = action === 'exhibition' ? 'attendsExhibition' : 'wantsAgency';
    data[field] = value === '' || value == null || value === 'none'
      ? null
      : value === true || value === '1' || value === 'true';
  }
  else if (action === 'followUp') { data.nextFollowUpAt = value ? new Date(value) : null; data.followUpNotifiedAt = null; }
  else if (action === 'archive') {
    // بایگانی گروهی: بعد از یک دور تماس، ده‌ها «شمارهٔ اشتباه» با هم کنار می‌روند
    data.archived = true;
    data.archivedAt = new Date();
    data.archivedReason = String(value || '').trim() || null;
  }
  else if (action === 'unarchive') { data.archived = false; data.archivedAt = null; data.archivedReason = null; }
  else if (action === 'tag') {
    // برچسب باید به برچسب‌های موجودِ هر رکورد اضافه شود نه جایگزینشان — پس تک‌تک
    const tag = String(value || '').trim();
    if (!tag) throw new AppError(400, 'برچسب خالی است');
    const rows = await prisma.marketContact.findMany({ where: { id: { in: ids } }, select: { id: true, tags: true } });
    await prisma.$transaction(rows.filter((r) => !r.tags.includes(tag)).map((r) =>
      prisma.marketContact.update({ where: { id: r.id }, data: { tags: [...r.tags, tag] } })));
    return res.json({ ok: true, count: rows.length });
  } else throw new AppError(400, 'اقدام نامعتبر است');

  const r = await prisma.marketContact.updateMany({ where: { id: { in: ids } }, data });
  if (action === 'status') for (const id of ids) await refreshScore(id);
  res.json({ ok: true, count: r.count });
});

/** تبدیل به مشتری واقعی سیستم — پل بین کمپین و پروژه/حسابداری */
router.post('/contacts/:id/convert', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  const { customerId, shortCode } = req.body as { customerId?: string; shortCode?: string };
  const contact = await prisma.marketContact.findUnique({ where: { id: req.params.id } });
  if (!contact) throw new AppError(404, 'مخاطب یافت نشد');
  if (contact.customerId) throw new AppError(400, 'این مخاطب قبلاً به مشتری تبدیل شده است');

  let customer;
  if (customerId) {
    customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new AppError(404, 'مشتری یافت نشد');
  } else {
    const code = shortCode?.trim().toUpperCase();
    if (!code || code.length !== 3) throw new AppError(400, 'کد ۳ حرفی مشتری لازم است');
    const dup = await prisma.customer.findUnique({ where: { shortCode: code } });
    if (dup) throw new AppError(400, `کد «${code}» قبلاً برای مشتری «${dup.name}» ثبت شده است`);
    customer = await prisma.customer.create({
      data: { name: contact.name, shortCode: code, phone: contact.phone, email: contact.email, address: contact.address, notes: contact.notes },
    });
  }
  await prisma.marketContact.update({ where: { id: contact.id }, data: { customerId: customer.id, status: 'CUSTOMER' } });
  await refreshScore(contact.id);
  res.json({ ok: true, customer });
});

// ═══════════════════════════════════════════════
// نظر دربارهٔ محصول
// ═══════════════════════════════════════════════

router.put('/contacts/:id/interests/:productId', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  const { id: contactId, productId } = req.params;
  const b = req.body;
  if (b.level && !INTEREST_LEVELS.includes(b.level)) throw new AppError(400, 'نظر نامعتبر است');
  if (b.priceOpinion && !PRICE_OPINIONS.includes(b.priceOpinion)) throw new AppError(400, 'نظر قیمت نامعتبر است');

  const num = (v: any) => (v === '' || v == null ? null : Number(v));
  const payload: any = {
    ...(b.level !== undefined ? { level: b.level } : {}),
    ...(b.priceOpinion !== undefined ? { priceOpinion: b.priceOpinion } : {}),
    ...(b.quotedPriceUsd !== undefined ? { quotedPriceUsd: num(b.quotedPriceUsd) } : {}),
    ...(b.targetPriceUsd !== undefined ? { targetPriceUsd: num(b.targetPriceUsd) } : {}),
    ...(b.competitorPriceUsd !== undefined ? { competitorPriceUsd: num(b.competitorPriceUsd) } : {}),
    ...(b.monthlyQty !== undefined ? { monthlyQty: num(b.monthlyQty) } : {}),
    ...(b.currentSupplier !== undefined ? { currentSupplier: b.currentSupplier?.trim() || null } : {}),
    ...(b.note !== undefined ? { note: b.note?.trim() || null } : {}),
    ...(b.sampleRequested !== undefined ? { sampleRequested: !!b.sampleRequested } : {}),
    updatedById: req.user!.id,
  };

  const row = await prisma.marketInterest.upsert({
    where: { contactId_productId: { contactId, productId } },
    update: payload,
    create: { contactId, productId, ...payload },
  });

  // اولین نظر مثبت یعنی مخاطب دیگر «فقط تماس‌گرفته‌شده» نیست
  const contact = await prisma.marketContact.findUnique({ where: { id: contactId }, select: { status: true } });
  if (row.level === 'POSITIVE' && contact && ['NEW', 'ATTEMPTED', 'CONTACTED'].includes(contact.status)) {
    await prisma.marketContact.update({ where: { id: contactId }, data: { status: 'INTERESTED' } });
  }
  const score = await refreshScore(contactId);
  res.json({ ...row, score });
});

// ═══════════════════════════════════════════════
// تماس / گفتگو
// ═══════════════════════════════════════════════

router.post('/calls', requirePermission('market', 'create'), async (req: Request, res: Response) => {
  const b = req.body;
  if (!b.contactId) throw new AppError(400, 'مخاطب مشخص نشده است');
  if (!b.summary?.trim()) throw new AppError(400, 'متن صحبت لازم است');
  if (b.channel && !CHANNELS.includes(b.channel)) throw new AppError(400, 'کانال نامعتبر است');
  if (b.result && !CALL_RESULTS.includes(b.result)) throw new AppError(400, 'نتیجهٔ تماس نامعتبر است');

  const contact = await prisma.marketContact.findUnique({ where: { id: b.contactId }, select: { id: true, status: true, firstContactAt: true } });
  if (!contact) throw new AppError(404, 'مخاطب یافت نشد');

  const occurredAt = b.occurredAt ? new Date(b.occurredAt) : new Date();
  const call = await prisma.marketCall.create({
    data: {
      contactId: b.contactId,
      channel: b.channel || 'CALL',
      direction: b.direction === 'IN' ? 'IN' : 'OUT',
      occurredAt,
      durationMin: b.durationMin ? Number(b.durationMin) : null,
      result: b.result || null,
      spokeWith: b.spokeWith?.trim() || null,
      summary: b.summary.trim(),
      createdById: req.user!.id,
    },
  });

  // وضعیت مخاطب از نتیجهٔ تماس نتیجه‌گیری می‌شود تا کاربر مجبور نباشد
  // بعد از هر تماس دوباره دستی وضعیت را عوض کند.
  const patch: any = {
    lastContactAt: occurredAt,
    contactAttempts: { increment: 1 },
    ...(contact.firstContactAt ? {} : { firstContactAt: occurredAt }),
  };
  if (b.nextFollowUpAt !== undefined) {
    patch.nextFollowUpAt = b.nextFollowUpAt ? new Date(b.nextFollowUpAt) : null;
    patch.followUpNotifiedAt = null;
    if (b.followUpReason !== undefined) patch.followUpReason = b.followUpReason?.trim() || null;
  }
  const nextStatus = nextStatusForCallResult(contact.status, b.result);
  if (nextStatus) patch.status = nextStatus;

  await prisma.marketContact.update({ where: { id: b.contactId }, data: patch });
  const score = await refreshScore(b.contactId);
  res.status(201).json({ ...call, score });
});

router.patch('/calls/:id', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  const b = req.body;
  const existing = await prisma.marketCall.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError(404, 'صحبت یافت نشد');
  const data: any = {};
  if (b.channel !== undefined) { if (!CHANNELS.includes(b.channel)) throw new AppError(400, 'کانال نامعتبر است'); data.channel = b.channel; }
  if (b.result !== undefined) { if (b.result && !CALL_RESULTS.includes(b.result)) throw new AppError(400, 'نتیجه نامعتبر است'); data.result = b.result || null; }
  if (b.summary !== undefined) { if (!b.summary?.trim()) throw new AppError(400, 'متن صحبت لازم است'); data.summary = b.summary.trim(); }
  if (b.spokeWith !== undefined) data.spokeWith = b.spokeWith?.trim() || null;
  if (b.durationMin !== undefined) data.durationMin = b.durationMin === '' || b.durationMin == null ? null : Number(b.durationMin);
  if (b.occurredAt !== undefined && b.occurredAt) data.occurredAt = new Date(b.occurredAt);
  const call = await prisma.marketCall.update({ where: { id: req.params.id }, data });

  // اگر نتیجهٔ «آخرین» تماسِ این مخاطب عوض شد، وضعیتی که آن نتیجهٔ قبلی خودکار ساخته بود هم
  // باید تصحیح شود — وگرنه اصلاح یک تماسِ اشتباه‌ثبت‌شده، وضعیت غلطی که ساخته بود را نگه می‌دارد
  if (data.result !== undefined && data.result !== existing.result) {
    const latest = await prisma.marketCall.findFirst({ where: { contactId: call.contactId }, orderBy: { occurredAt: 'desc' }, select: { id: true } });
    if (latest?.id === call.id) {
      const contact = await prisma.marketContact.findUnique({ where: { id: call.contactId }, select: { status: true } });
      if (contact) {
        // اگر وضعیتِ فعلی دقیقاً همان چیزی است که نتیجهٔ قبلی خودکار ساخته بود، آن را یک
        // پایهٔ محافظه‌کارانه («تماس گرفته شده ولی تأییدنشده») در نظر بگیر، نه وضعیت گیرکرده
        const wasAutoTerminal = (existing.result === 'WRONG_NUMBER' && contact.status === 'UNREACHABLE')
          || (existing.result === 'REJECTED' && contact.status === 'NOT_INTERESTED');
        const nextStatus = nextStatusForCallResult(wasAutoTerminal ? 'ATTEMPTED' : contact.status, data.result);
        if (nextStatus && nextStatus !== contact.status) {
          await prisma.marketContact.update({ where: { id: call.contactId }, data: { status: nextStatus } });
        }
      }
    }
  }

  await refreshScore(call.contactId);
  res.json(call);
});

router.delete('/calls/:id', requirePermission('market', 'delete'), async (req: Request, res: Response) => {
  const call = await prisma.marketCall.delete({ where: { id: req.params.id } });
  await refreshScore(call.contactId);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════
// تعهد ارسال («قرار شد برایش بفرستیم»)
// ═══════════════════════════════════════════════

router.get('/promises', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  const where: any = {};
  if (q.status) where.status = { in: q.status.split(',').filter(Boolean) };
  if (q.contactId) where.contactId = q.contactId;
  const rows = await prisma.marketPromise.findMany({
    where,
    include: {
      product: { select: { id: true, name: true } },
      contact: { select: { id: true, code: true, name: true, phone: true, whatsapp: true, city: { select: { name: true, governorate: true } } } },
      assignedTo: { select: { id: true, name: true } },
    },
    orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { promisedAt: 'desc' }],
  });
  const now = new Date();
  const pending = rows.filter((r) => r.status === 'PENDING');
  // بدون تاریخ سررسید معتبر است (هنوز قطعی نیست) ولی نباید نامرئی بماند —
  // در upcoming هم می‌ماند (سازگار با مصرف‌کننده‌های فعلی) هم جدا به noDate اضافه می‌شود
  res.json({
    overdue: pending.filter((r) => dueBucket(r.dueAt, now) === 'overdue'),
    today: pending.filter((r) => dueBucket(r.dueAt, now) === 'today'),
    upcoming: pending.filter((r) => { const b = dueBucket(r.dueAt, now); return b === 'upcoming' || b === 'none'; }),
    noDate: pending.filter((r) => !r.dueAt),
    done: rows.filter((r) => r.status !== 'PENDING').slice(0, 100),
  });
});

router.post('/promises', requirePermission('market', 'create'), async (req: Request, res: Response) => {
  const b = req.body;
  if (!b.contactId) throw new AppError(400, 'مخاطب مشخص نشده است');
  if (b.kind && !PROMISE_KINDS.includes(b.kind)) throw new AppError(400, 'نوع تعهد نامعتبر است');
  const promise = await prisma.marketPromise.create({
    data: {
      contactId: b.contactId,
      productId: b.productId || null,
      kind: b.kind || 'SAMPLE',
      description: b.description?.trim() || null,
      qty: b.qty ? Number(b.qty) : null,
      dueAt: b.dueAt ? new Date(b.dueAt) : null,
      assignedToId: b.assignedToId || req.user!.id,
      createdById: req.user!.id,
    },
    include: { product: { select: { id: true, name: true } } },
  });
  res.status(201).json(promise);
});

router.patch('/promises/:id', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  const b = req.body;
  const data: any = {};
  if (b.status !== undefined) {
    if (!PROMISE_STATUSES.includes(b.status)) throw new AppError(400, 'وضعیت نامعتبر است');
    data.status = b.status;
    // «ارسال شد» بدون تاریخ ارسال بی‌معنی است — اگر ندادند، همین حالا
    if (b.status === 'SENT' && !b.sentAt) data.sentAt = new Date();
    if (b.status === 'PENDING') data.sentAt = null;
  }
  if (b.kind !== undefined) { if (!PROMISE_KINDS.includes(b.kind)) throw new AppError(400, 'نوع نامعتبر است'); data.kind = b.kind; }
  if (b.description !== undefined) data.description = b.description?.trim() || null;
  if (b.productId !== undefined) data.productId = b.productId || null;
  if (b.qty !== undefined) data.qty = b.qty === '' || b.qty == null ? null : Number(b.qty);
  if (b.carrier !== undefined) data.carrier = b.carrier?.trim() || null;
  if (b.trackingNo !== undefined) data.trackingNo = b.trackingNo?.trim() || null;
  if (b.costUsd !== undefined) data.costUsd = b.costUsd === '' || b.costUsd == null ? null : Number(b.costUsd);
  if (b.assignedToId !== undefined) data.assignedToId = b.assignedToId || null;
  if (b.sentAt !== undefined) data.sentAt = b.sentAt ? new Date(b.sentAt) : null;
  if (b.dueAt !== undefined) { data.dueAt = b.dueAt ? new Date(b.dueAt) : null; data.notifiedAt = null; }

  const promise = await prisma.marketPromise.update({
    where: { id: req.params.id }, data,
    include: { product: { select: { id: true, name: true } } },
  });
  // ارسال نمونه یعنی مخاطب یک پله در قیف جلو رفته
  if (data.status === 'SENT' && promise.kind === 'SAMPLE') {
    const c = await prisma.marketContact.findUnique({ where: { id: promise.contactId }, select: { status: true } });
    if (c && ['CONTACTED', 'INTERESTED', 'NEGOTIATING'].includes(c.status)) {
      await prisma.marketContact.update({ where: { id: promise.contactId }, data: { status: 'SAMPLE_SENT' } });
      await refreshScore(promise.contactId);
    }
  }
  res.json(promise);
});

router.delete('/promises/:id', requirePermission('market', 'delete'), async (req: Request, res: Response) => {
  await prisma.marketPromise.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════
// پیوست‌ها
// ═══════════════════════════════════════════════

router.post('/contacts/:id/files', requirePermission('market', 'edit'), upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError(400, 'فایلی ارسال نشد');
  const contact = await prisma.marketContact.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!contact) throw new AppError(404, 'مخاطب یافت نشد');
  const file = await prisma.marketFile.create({
    data: {
      contactId: req.params.id,
      url: '/uploads/' + path.basename(req.file.path),
      originalName: req.file.originalname,
      size: req.file.size,
      kind: req.body.kind || null,
      uploadedById: req.user!.id,
    },
  });
  res.status(201).json(file);
});

router.delete('/files/:id', requirePermission('market', 'delete'), async (req: Request, res: Response) => {
  await prisma.marketFile.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════
// مرجع‌ها: محصول، شهر، قالب پیام
// ═══════════════════════════════════════════════

router.get('/products', async (_req: Request, res: Response) => {
  const rows = await prisma.marketProduct.findMany({ orderBy: { sortOrder: 'asc' } });
  res.json(rows);
});

router.post('/products', requirePermission('market', 'create'), async (req: Request, res: Response) => {
  const b = req.body;
  if (!b.name?.trim()) throw new AppError(400, 'نام محصول لازم است');
  const row = await prisma.marketProduct.create({
    data: {
      name: b.name.trim(), nameAr: b.nameAr?.trim() || null, nameEn: b.nameEn?.trim() || null,
      code: b.code?.trim() || null, unit: b.unit?.trim() || null,
      listPriceUsd: b.listPriceUsd ? Number(b.listPriceUsd) : null,
      moq: b.moq?.trim() || null, description: b.description?.trim() || null,
      sortOrder: b.sortOrder != null ? Number(b.sortOrder) : 99,
    },
  });
  res.status(201).json(row);
});

router.patch('/products/:id', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  const b = req.body;
  const data: any = {};
  for (const f of ['name', 'nameAr', 'nameEn', 'code', 'unit', 'moq', 'description'] as const) {
    if (b[f] !== undefined) data[f] = b[f]?.toString().trim() || null;
  }
  if (data.name === null) throw new AppError(400, 'نام محصول نمی‌تواند خالی باشد');
  if (b.listPriceUsd !== undefined) data.listPriceUsd = b.listPriceUsd === '' || b.listPriceUsd == null ? null : Number(b.listPriceUsd);
  if (b.sortOrder !== undefined) data.sortOrder = Number(b.sortOrder);
  if (b.isActive !== undefined) data.isActive = !!b.isActive;
  res.json(await prisma.marketProduct.update({ where: { id: req.params.id }, data }));
});

/**
 * تصویر محصول — همان تصویری که در «برگهٔ محصولات» واتساپ چاپ می‌شود.
 *
 * روی همان `/uploads` بی‌احراز‌هویت می‌نشیند که پیوست قالب‌ها می‌نشیند، چون
 * بوم (canvas) مرورگر باید بتواند بخواندش بدون آنکه آلوده (tainted) شود.
 */
router.post('/products/:id/image', requirePermission('market', 'edit'), upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError(400, 'فایلی انتخاب نشده است');
  if (!/^image\//.test(req.file.mimetype)) throw new AppError(400, 'فقط تصویر (PNG/JPG) قابل استفاده است');
  const row = await prisma.marketProduct.update({
    where: { id: req.params.id },
    data: { imageUrl: '/uploads/' + path.basename(req.file.path) },
  });
  res.json(row);
});

router.delete('/products/:id/image', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  res.json(await prisma.marketProduct.update({ where: { id: req.params.id }, data: { imageUrl: null } }));
});

router.delete('/products/:id', requirePermission('market', 'delete'), async (req: Request, res: Response) => {
  const used = await prisma.marketInterest.count({ where: { productId: req.params.id } });
  // حذف محصول یعنی پاک‌شدن نظر همهٔ مخاطب‌ها دربارهٔ آن — به‌جای حذف، غیرفعالش کن
  if (used) throw new AppError(400, `این محصول در نظر ${used} مخاطب ثبت شده است. به‌جای حذف، غیرفعالش کنید.`);
  await prisma.marketProduct.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/**
 * تنظیمات این ماژول در یک درخواست.
 * جدا از `/settings/config` است چون آن مسیر فقط کلیدهای whitelist‌شده و
 * مقادیر JSON را می‌پذیرد؛ این‌جا مقدارها رشتهٔ ساده‌اند.
 */
router.get('/settings', async (_req: Request, res: Response) => {
  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: ['IQD_PER_USD', 'COMPANY_NAME', 'MARKET_CONTACT_LINE', 'MARKET_COMPANY_AR'] } },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.json({
    iqdPerUsd: Number(map.IQD_PER_USD) || null,
    companyName: map.COMPANY_NAME || null,
    // خط پاورقیِ «برگهٔ محصولات» — تلفن/واتساپ/سایتی که مشتری باید ببیند
    contactLine: map.MARKET_CONTACT_LINE || null,
    // نام عربیِ شرکت. COMPANY_NAME لاتین است و برای مغازه‌دار عراقی خواندنی‌تر
    // است که اسم را به خط خودش هم ببیند؛ فارسی‌نویسی این‌جا غلط است.
    companyAr: map.MARKET_COMPANY_AR || null,
  });
});

router.put('/settings', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  const { iqdPerUsd, contactLine, companyAr } = req.body as
    { iqdPerUsd?: number | string; contactLine?: string; companyAr?: string };
  if (iqdPerUsd !== undefined) {
    const n = Number(iqdPerUsd);
    if (!Number.isFinite(n) || n <= 0) throw new AppError(400, 'نرخ دینار باید عددی مثبت باشد');
    await prisma.systemSetting.upsert({
      where: { key: 'IQD_PER_USD' },
      create: { key: 'IQD_PER_USD', value: String(n) },
      update: { value: String(n) },
    });
  }
  for (const [key, raw] of [['MARKET_CONTACT_LINE', contactLine], ['MARKET_COMPANY_AR', companyAr]] as const) {
    if (raw === undefined) continue;
    const value = String(raw).trim().slice(0, 160);
    await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  res.json({ ok: true });
});

router.get('/cities', async (_req: Request, res: Response) => {
  const rows = await prisma.marketCity.findMany({
    orderBy: [{ governorate: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { contacts: true } } },
  });
  res.json(rows);
});

router.post('/cities', requirePermission('market', 'create'), async (req: Request, res: Response) => {
  const { governorate, name, nameAr } = req.body;
  if (!governorate?.trim() || !name?.trim()) throw new AppError(400, 'استان و نام شهر لازم است');
  const exists = await prisma.marketCity.findUnique({ where: { governorate_name: { governorate: governorate.trim(), name: name.trim() } } });
  if (exists) throw new AppError(400, 'این شهر قبلاً ثبت شده است');
  res.status(201).json(await prisma.marketCity.create({
    data: { governorate: governorate.trim(), name: name.trim(), nameAr: nameAr?.trim() || null, sortOrder: 99 },
  }));
});

router.patch('/cities/:id', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  const b = req.body;
  const data: any = {};
  if (b.name !== undefined) { if (!b.name?.trim()) throw new AppError(400, 'نام شهر لازم است'); data.name = b.name.trim(); }
  if (b.governorate !== undefined) { if (!b.governorate?.trim()) throw new AppError(400, 'استان لازم است'); data.governorate = b.governorate.trim(); }
  if (b.nameAr !== undefined) data.nameAr = b.nameAr?.trim() || null;
  if (b.isActive !== undefined) data.isActive = !!b.isActive;
  if (b.sortOrder !== undefined) data.sortOrder = Number(b.sortOrder);
  res.json(await prisma.marketCity.update({ where: { id: req.params.id }, data }));
});

router.delete('/cities/:id', requirePermission('market', 'delete'), async (req: Request, res: Response) => {
  const used = await prisma.marketContact.count({ where: { cityId: req.params.id } });
  if (used) throw new AppError(400, `${used} مخاطب در این شهر ثبت شده‌اند. اول آن‌ها را جابه‌جا کنید.`);
  await prisma.marketCity.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

router.get('/templates', async (_req: Request, res: Response) => {
  res.json(await prisma.marketTemplate.findMany({
    orderBy: { sortOrder: 'asc' },
    include: {
      product: { select: { id: true, name: true } },
      files: { orderBy: { sortOrder: 'asc' } },
    },
  }));
});

router.post('/templates', requirePermission('market', 'create'), async (req: Request, res: Response) => {
  const b = req.body;
  if (!b.title?.trim() || !b.body?.trim()) throw new AppError(400, 'عنوان و متن قالب لازم است');
  res.status(201).json(await prisma.marketTemplate.create({
    data: {
      title: b.title.trim(), body: b.body, language: b.language || 'AR',
      channel: b.channel && CHANNELS.includes(b.channel) ? b.channel : 'WHATSAPP',
      productId: b.productId || null, sortOrder: b.sortOrder != null ? Number(b.sortOrder) : 99,
    },
  }));
});

router.patch('/templates/:id', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  const b = req.body;
  const data: any = {};
  if (b.title !== undefined) { if (!b.title?.trim()) throw new AppError(400, 'عنوان لازم است'); data.title = b.title.trim(); }
  if (b.body !== undefined) { if (!b.body?.trim()) throw new AppError(400, 'متن قالب لازم است'); data.body = b.body; }
  if (b.language !== undefined) data.language = b.language || 'AR';
  if (b.channel !== undefined) { if (!CHANNELS.includes(b.channel)) throw new AppError(400, 'کانال نامعتبر است'); data.channel = b.channel; }
  if (b.productId !== undefined) data.productId = b.productId || null;
  if (b.isActive !== undefined) data.isActive = !!b.isActive;
  if (b.sortOrder !== undefined) data.sortOrder = Number(b.sortOrder);
  res.json(await prisma.marketTemplate.update({ where: { id: req.params.id }, data }));
});

router.delete('/templates/:id', requirePermission('market', 'delete'), async (req: Request, res: Response) => {
  await prisma.marketTemplate.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/**
 * پیوستِ یک قالب پیام (عکس محصول، کاتالوگ، ویدیو).
 *
 * لینک `wa.me` نمی‌تواند فایل حمل کند، پس این فایل‌ها موقع ارسال یا در
 * کلیپ‌بورد کپی می‌شوند (برای Paste در واتساپ‌وب)، یا نشانی عمومی‌شان به
 * متن پیام اضافه می‌شود. برای همین `url` باید از بیرون قابل‌دسترس باشد —
 * پوشهٔ /uploads بدون احراز هویت سرو می‌شود و همین‌جا عمداً به آن تکیه شده.
 */
router.post('/templates/:id/files', requirePermission('market', 'edit'), upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError(400, 'فایلی ارسال نشد');
  const tpl = await prisma.marketTemplate.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!tpl) throw new AppError(404, 'قالب یافت نشد');
  const count = await prisma.marketTemplateFile.count({ where: { templateId: tpl.id } });
  const file = await prisma.marketTemplateFile.create({
    data: {
      templateId: tpl.id,
      url: '/uploads/' + path.basename(req.file.path),
      originalName: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype,
      sortOrder: count,
      uploadedById: req.user!.id,
    },
  });
  res.status(201).json(file);
});

router.delete('/templates/files/:fileId', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
  await prisma.marketTemplateFile.delete({ where: { id: req.params.fileId } });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════
// گزارش
// ═══════════════════════════════════════════════

router.get('/analytics', async (_req: Request, res: Response) => {
  const [contacts, interests, calls, promises, products, cities] = await Promise.all([
    prisma.marketContact.findMany({ select: { id: true, status: true, cityId: true, source: true, score: true, rating: true } }),
    prisma.marketInterest.findMany({ select: { productId: true, level: true, priceOpinion: true, sampleRequested: true, targetPriceUsd: true, quotedPriceUsd: true } }),
    prisma.marketCall.findMany({ select: { channel: true, result: true, createdById: true, occurredAt: true } }),
    prisma.marketPromise.findMany({ select: { status: true, kind: true } }),
    prisma.marketProduct.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.marketCity.findMany({ select: { id: true, name: true, governorate: true } }),
  ]);

  const byStatus: Record<string, number> = {};
  for (const s of MARKET_STATUSES) byStatus[s] = 0;
  const bySource: Record<string, number> = {};
  for (const c of contacts) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    const src = c.source?.trim() || 'نامشخص';
    bySource[src] = (bySource[src] || 0) + 1;
  }

  // محصول: چند نفر پسندیدند، چند نفر قیمت را قبول داشتند، چند نفر نمونه خواستند
  const byProduct = products.map((p) => {
    const mine = interests.filter((i) => i.productId === p.id);
    const positive = mine.filter((i) => i.level === 'POSITIVE');
    const targets = mine.map((i) => i.targetPriceUsd).filter((x): x is number => x != null);
    return {
      productId: p.id, name: p.name,
      discussed: mine.filter((i) => i.level !== 'NOT_DISCUSSED').length,
      positive: positive.length,
      neutral: mine.filter((i) => i.level === 'NEUTRAL').length,
      negative: mine.filter((i) => i.level === 'NEGATIVE').length,
      priceGood: mine.filter((i) => i.priceOpinion === 'GOOD').length,
      priceAcceptable: mine.filter((i) => i.priceOpinion === 'ACCEPTABLE').length,
      priceExpensive: mine.filter((i) => i.priceOpinion === 'EXPENSIVE').length,
      sampleRequests: mine.filter((i) => i.sampleRequested).length,
      // میانگین قیمتی که بازار می‌خواهد — مستقیم به تصمیم قیمت‌گذاری وصل است
      avgTargetUsd: targets.length ? Math.round((targets.reduce((s, x) => s + x, 0) / targets.length) * 100) / 100 : null,
    };
  });

  // از جدول شهرها شروع می‌کنیم نه از مخاطبین — وگرنه شهری که هنوز هیچ شماره‌ای
  // در آن ثبت نشده اصلاً در گزارش دیده نمی‌شود، و «کدام شهرها را هنوز دست
  // نزده‌ایم؟» بی‌جواب می‌ماند؛ همان سؤالی که تختهٔ شهرهای حذف‌شده جواب می‌داد.
  const cityAgg = new Map<string, { id: string; name: string; governorate: string; total: number; contacted: number; interested: number; customers: number }>();
  for (const city of cities) {
    cityAgg.set(city.id, { id: city.id, name: city.name, governorate: city.governorate, total: 0, contacted: 0, interested: 0, customers: 0 });
  }
  for (const c of contacts) {
    if (!c.cityId) continue;
    const a = cityAgg.get(c.cityId);
    if (!a) continue;
    a.total++;
    if (c.status !== 'NEW') a.contacted++;
    if (['INTERESTED', 'NEGOTIATING', 'SAMPLE_SENT'].includes(c.status)) a.interested++;
    if (c.status === 'CUSTOMER') a.customers++;
  }

  const byChannel: Record<string, number> = {};
  const byResult: Record<string, number> = {};
  const byCaller: Record<string, { calls: number; answered: number }> = {};
  // نرخ پاسخ به تفکیک ساعتِ بغداد — تا معلوم شود چه وقتی زنگ‌زدن جواب می‌دهد.
  // فقط تماس‌های تلفنی شمرده می‌شوند؛ پیام واتساپ «جواب دادن» ندارد و
  // آمار را بی‌معنی می‌کرد.
  const byHour: { hour: number; calls: number; answered: number }[] =
    Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0, answered: 0 }));

  for (const c of calls) {
    byChannel[c.channel] = (byChannel[c.channel] || 0) + 1;
    if (c.result) byResult[c.result] = (byResult[c.result] || 0) + 1;
    const uid = c.createdById || 'unknown';
    byCaller[uid] = byCaller[uid] || { calls: 0, answered: 0 };
    byCaller[uid].calls++;
    if (c.result === 'ANSWERED') byCaller[uid].answered++;

    if (c.channel === 'CALL' && c.result) {
      const h = byHour[iraqHour(c.occurredAt)];
      h.calls++;
      if (c.result === 'ANSWERED') h.answered++;
    }
  }

  // «بهترین ساعت» فقط وقتی ادعا می‌شود که نمونه کافی باشد؛ با ۲ تماس
  // گفتن «ساعت ۱۰ بهترین است» حرفِ بی‌پشتوانه است.
  const HOUR_MIN_SAMPLE = 5;
  const ranked = byHour.filter((h) => h.calls >= HOUR_MIN_SAMPLE)
    .map((h) => ({ ...h, rate: Math.round((h.answered / h.calls) * 100) }))
    .sort((a, b) => b.rate - a.rate);
  const totalRatedCalls = byHour.reduce((n, h) => n + h.calls, 0);
  const names = await userMap(Object.keys(byCaller));

  const reached = contacts.filter((c) => c.status !== 'NEW').length;
  const interestedCount = contacts.filter((c) => ['INTERESTED', 'NEGOTIATING', 'SAMPLE_SENT', 'CUSTOMER'].includes(c.status)).length;

  res.json({
    total: contacts.length,
    reached,
    interested: interestedCount,
    customers: byStatus.CUSTOMER,
    // نرخ تبدیل روی «کسانی که با آن‌ها صحبت شده» حساب می‌شود نه کل لیست،
    // وگرنه هرچه شمارهٔ تماس‌نگرفته بیشتر شود عدد بی‌دلیل بدتر می‌شود.
    interestRate: reached ? Math.round((interestedCount / reached) * 100) : 0,
    conversionRate: reached ? Math.round((byStatus.CUSTOMER / reached) * 100) : 0,
    byStatus,
    bySource: Object.entries(bySource).map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    byProduct,
    byCity: [...cityAgg.values()].sort((a, b) => b.interested - a.interested || b.total - a.total),
    // مخاطبینی که شهرشان تعیین نشده — در byCity جایی ندارند ولی نباید گم شوند
    noCityCount: contacts.filter((c) => !c.cityId).length,
    byChannel, byResult,
    callHours: {
      byHour: byHour.filter((h) => h.calls > 0),
      best: ranked[0] || null,
      worst: ranked.length > 1 ? ranked[ranked.length - 1] : null,
      minSample: HOUR_MIN_SAMPLE,
      totalCalls: totalRatedCalls,
    },
    callers: Object.entries(byCaller).map(([id, v]) => ({ id, name: names[id] || '—', ...v })).sort((a, b) => b.calls - a.calls),
    calls: calls.length,
    promises: {
      pending: promises.filter((p) => p.status === 'PENDING').length,
      sent: promises.filter((p) => p.status === 'SENT' || p.status === 'DELIVERED').length,
    },
  });
});

/** ماتریس مخاطب × محصول — یک نگاه به کل بازار */
router.get('/matrix', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string>;
  const where = buildContactWhere(q);
  const [products, contacts] = await Promise.all([
    prisma.marketProduct.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.marketContact.findMany({
      where,
      select: {
        id: true, code: true, name: true, status: true, score: true, rating: true,
        city: { select: { name: true, governorate: true } },
        interests: { select: { productId: true, level: true, priceOpinion: true, sampleRequested: true } },
      },
      orderBy: [{ score: 'desc' }, { name: 'asc' }],
      take: Math.min(Number(q.take) || 300, 1000),
    }),
  ]);
  res.json({ products, contacts });
});

// ورود/خروجی اکسل در فایل جدا — این‌جا فقط وصل می‌شود
registerExcelRoutes(router);
registerVCardRoutes(router);
registerWhatsAppRoutes(router);
registerAuditRoutes(router);

export default router;
