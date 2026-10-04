import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../../shared/utils/prisma';
import { STATUS_FA, TYPE_FA, LEVEL_FA, PRICE_FA, PROMISE_FA } from './market.labels';

/**
 * دفترچهٔ تغییرات ماژول بازار — «چه کسی، کِی، چه چیزی را عوض کرد».
 *
 * روی جدول `AuditLog` که از قبل در سیستم بود می‌نشیند، ولی با یک تفاوت مهم:
 * میان‌افزار عمومیِ سیستم کلِ بدنهٔ پاسخ را در `changes` می‌ریزد، که برای خواندن
 * بی‌فایده است («چه چیزی عوض شد؟» جوابش یک JSON صد خطی می‌شود). این‌جا از روی
 * فیلدهایی که کاربر فرستاده یک جملهٔ فارسی ساخته می‌شود:
 * «وضعیت: علاقه‌مند ← نیاز به تماس مجدد» یا «رتبه: ۴».
 *
 * چرا میان‌افزار و نه فراخوانی دستی در هر مسیر: مسیرهای نوشتنیِ این ماژول از
 * سی‌تا بیشترند و هر کدام که یادمان می‌رفت، یک سوراخِ بی‌صدا در دفترچه می‌شد.
 */

const BOOL_FA = (v: any) => (v === null || v === undefined || v === '' ? 'نپرسیده‌ایم' : v ? 'بله' : 'خیر');
const DATE_FA = (v: any) => {
  if (!v) return 'بدون تاریخ';
  try { return new Date(v).toLocaleDateString('fa-IR'); } catch { return String(v); }
};

/** نام فارسی فیلدها + نحوهٔ خواندنی‌کردن مقدارشان */
const FIELDS: Record<string, { label: string; fmt?: (v: any) => string }> = {
  name: { label: 'نام' },
  nameAr: { label: 'نام عربی' },
  ownerName: { label: 'نام صاحب' },
  type: { label: 'نوع', fmt: (v) => TYPE_FA[v] || v },
  status: { label: 'وضعیت', fmt: (v) => STATUS_FA[v] || v },
  rating: { label: 'رتبه', fmt: (v) => (v == null ? 'بدون رتبه' : String(v)) },
  cityId: { label: 'شهر' },
  address: { label: 'آدرس' },
  phone: { label: 'تلفن' },
  phone2: { label: 'تلفن دوم' },
  whatsapp: { label: 'واتساپ' },
  telegram: { label: 'تلگرام' },
  instagram: { label: 'اینستاگرام' },
  email: { label: 'ایمیل' },
  website: { label: 'وب‌سایت' },
  mapUrl: { label: 'لینک نقشه' },
  language: { label: 'زبان' },
  source: { label: 'منبع' },
  notes: { label: 'یادداشت' },
  tags: { label: 'برچسب‌ها', fmt: (v) => (Array.isArray(v) ? v.join('، ') : String(v)) },
  assignedToId: { label: 'مسئول' },
  doNotCall: { label: 'دیگر تماس نگیرید', fmt: (v) => (v ? 'بله' : 'خیر') },
  attendsExhibition: { label: 'حضور در نمایشگاه', fmt: BOOL_FA },
  wantsAgency: { label: 'تمایل به نمایندگی', fmt: BOOL_FA },
  otherProductsNote: { label: 'درخواست محصول دیگر' },
  nextFollowUpAt: { label: 'پیگیری بعدی', fmt: DATE_FA },
  followUpReason: { label: 'دلیل پیگیری' },
  level: { label: 'نظر', fmt: (v) => LEVEL_FA[v] || v },
  priceOpinion: { label: 'نظر قیمت', fmt: (v) => PRICE_FA[v] || v },
  sampleRequested: { label: 'نمونه خواست', fmt: (v) => (v ? 'بله' : 'خیر') },
  kind: { label: 'نوع تعهد', fmt: (v) => PROMISE_FA[v] || v },
  description: { label: 'شرح' },
  qty: { label: 'تعداد' },
  dueAt: { label: 'موعد', fmt: DATE_FA },
  summary: { label: 'متن گفت‌وگو' },
  result: { label: 'نتیجهٔ تماس' },
  listPriceUsd: { label: 'قیمت پایه ($)' },
  moq: { label: 'حداقل سفارش' },
  isActive: { label: 'فعال', fmt: (v) => (v ? 'بله' : 'خیر') },
  iqdPerUsd: { label: 'نرخ دینار' },
  contactLine: { label: 'خط تماس برگه' },
  companyAr: { label: 'نام عربی شرکت' },
  body: { label: 'متن قالب' },
  title: { label: 'عنوان' },
};

/** فیلدهایی که هرگز نباید در دفترچه بنشینند */
const SECRET = new Set(['password', 'token', 'bridgeKey']);

/** متن‌های بلند در دفترچه کوتاه می‌شوند — دفترچه برای «چه چیزی» است، نه بایگانیِ متن */
const short = (v: any, max = 60) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s == null) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max) + '…' : one;
};

function describeFields(body: any, action: string): string {
  if (!body || typeof body !== 'object') return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (SECRET.has(k) || k === 'contactId' || k === 'productId' || k === 'id') continue;
    const f = FIELDS[k];
    if (!f) continue;
    const text = short(f.fmt ? f.fmt(v) : v);
    if (!text) {
      // فرم‌ها فیلدهای دست‌نخوردهٔ خودشان را هم می‌فرستند. در «افزودن» یعنی
      // چیزی نوشته نشده و ارزش ثبت ندارد؛ در «ویرایش» یعنی کاربر عمداً
      // خالی‌اش کرده و همین خبر است.
      if (action === 'CREATE') continue;
      parts.push(`${f.label}: خالی شد`);
      continue;
    }
    parts.push(`${f.label}: ${text}`);
  }
  return parts.join(' · ');
}

type Shape = { entity: string; what: string; contactIdFrom?: 'param' | 'body' | 'result' };

/** مسیر را به «چه چیزی» ترجمه می‌کند. ترتیب مهم است — خاص‌ها پیش از عام‌ها. */
function shapeOf(method: string, url: string): Shape | null {
  const p = url.split('?')[0].replace(/\/+$/, '');
  const M = (re: RegExp) => re.test(p);

  if (method === 'PUT' && M(/^\/contacts\/[^/]+\/interests\/[^/]+$/)) return { entity: 'MarketInterest', what: 'نظر دربارهٔ محصول', contactIdFrom: 'param' };
  if (method === 'POST' && M(/^\/contacts\/[^/]+\/files$/)) return { entity: 'MarketFile', what: 'افزودن پیوست', contactIdFrom: 'param' };
  if (method === 'POST' && M(/^\/contacts\/[^/]+\/convert$/)) return { entity: 'MarketContact', what: 'تبدیل به مشتری سیستم', contactIdFrom: 'param' };
  if (method === 'POST' && M(/^\/contacts\/bulk$/)) return { entity: 'MarketContact', what: 'اقدام گروهی' };
  if (method === 'POST' && M(/^\/contacts$/)) return { entity: 'MarketContact', what: 'مخاطب جدید', contactIdFrom: 'result' };
  if (method === 'PATCH' && M(/^\/contacts\/[^/]+$/)) return { entity: 'MarketContact', what: 'ویرایش مخاطب', contactIdFrom: 'param' };
  if (method === 'DELETE' && M(/^\/contacts\/[^/]+$/)) return { entity: 'MarketContact', what: 'حذف مخاطب', contactIdFrom: 'param' };

  if (method === 'POST' && M(/^\/calls$/)) return { entity: 'MarketCall', what: 'ثبت گفت‌وگو', contactIdFrom: 'body' };
  if (method === 'PATCH' && M(/^\/calls\/[^/]+$/)) return { entity: 'MarketCall', what: 'ویرایش گفت‌وگو' };
  if (method === 'DELETE' && M(/^\/calls\/[^/]+$/)) return { entity: 'MarketCall', what: 'حذف گفت‌وگو' };

  if (method === 'POST' && M(/^\/promises$/)) return { entity: 'MarketPromise', what: 'ثبت تعهد ارسال', contactIdFrom: 'body' };
  if (method === 'PATCH' && M(/^\/promises\/[^/]+$/)) return { entity: 'MarketPromise', what: 'ویرایش تعهد ارسال' };
  if (method === 'DELETE' && M(/^\/promises\/[^/]+$/)) return { entity: 'MarketPromise', what: 'حذف تعهد ارسال' };

  if (method === 'DELETE' && M(/^\/files\/[^/]+$/)) return { entity: 'MarketFile', what: 'حذف پیوست' };

  if (M(/^\/products\/[^/]+\/image$/)) return { entity: 'MarketProduct', what: method === 'POST' ? 'تغییر عکس محصول' : 'حذف عکس محصول' };
  if (M(/^\/products/)) return { entity: 'MarketProduct', what: method === 'POST' ? 'محصول جدید' : method === 'DELETE' ? 'حذف محصول' : 'ویرایش محصول' };
  if (M(/^\/cities/)) return { entity: 'MarketCity', what: method === 'POST' ? 'شهر جدید' : method === 'DELETE' ? 'حذف شهر' : 'ویرایش شهر' };
  if (M(/^\/templates\/[^/]+\/files/)) return { entity: 'MarketTemplate', what: method === 'POST' ? 'افزودن پیوست قالب' : 'حذف پیوست قالب' };
  if (M(/^\/templates/)) return { entity: 'MarketTemplate', what: method === 'POST' ? 'قالب پیام جدید' : method === 'DELETE' ? 'حذف قالب پیام' : 'ویرایش قالب پیام' };
  if (method === 'PUT' && M(/^\/settings$/)) return { entity: 'MarketSetting', what: 'تغییر تنظیمات' };
  if (M(/^\/import\/commit$/)) return { entity: 'MarketContact', what: 'ورود گروهی از اکسل' };

  // مسیرهای پل واتساپ و صفِ آن عمداً ثبت نمی‌شوند: هر سه ثانیه یک‌بار
  // heartbeat می‌آید و دفترچه را پر می‌کند بی‌آنکه چیزی گفته باشد.
  return null;
}

const ACTION = (m: string) => (m === 'POST' ? 'CREATE' : m === 'DELETE' ? 'DELETE' : 'UPDATE');

/**
 * روی روتر بازار می‌نشیند و هر نوشتنِ موفق را ثبت می‌کند.
 * نوشتن در دفترچه هرگز نباید پاسخ کاربر را کند یا خراب کند، پس بعد از ارسال
 * پاسخ و بدون await انجام می‌شود و خطایش فقط لاگ می‌گیرد.
 */
export function marketAudit(req: Request, res: Response, next: NextFunction) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();

  const originalJson = res.json.bind(res);
  res.json = function (body: any) {
    const out = originalJson(body);
    if (res.statusCode < 400 && req.user) {
      const shape = shapeOf(req.method, req.path);
      if (shape) void record(req, shape, body).catch(() => { /* دفترچه نباید سر و صدا کند */ });
    }
    return out;
  };
  next();
}

async function record(req: Request, shape: Shape, body: any) {
  const contactId =
    shape.contactIdFrom === 'param' ? req.params.id
      : shape.contactIdFrom === 'body' ? req.body?.contactId
        : shape.contactIdFrom === 'result' ? body?.id
          : undefined;

  let subject = '';
  if (contactId) {
    const c = await prisma.marketContact.findUnique({ where: { id: contactId }, select: { code: true, name: true } });
    if (c) subject = `${c.name} (${c.code})`;
  }

  // فایل‌های multipart بدنهٔ JSON ندارند؛ نامِ فایل تنها چیزی است که ارزش ثبت دارد
  const action = ACTION(req.method);
  const detail = req.file
    ? `فایل: ${short((req.file as Express.Multer.File).originalname)}`
    : describeFields(req.body, action);

  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: action as any,
      entity: shape.entity,
      entityId: contactId || req.params.id || body?.id || null,
      changes: { what: shape.what, subject, detail },
      ipAddress: req.ip,
    },
  });
}

// ─── خواندن دفترچه ────────────────────────────────────────
export function registerAuditRoutes(router: Router) {
  /** فقط رویدادهای همین ماژول — دفترچهٔ عمومیِ سیستم مسیر خودش را دارد */
  router.get('/activity', async (req: Request, res: Response) => {
    const q = req.query as Record<string, string>;
    const where: any = { entity: { startsWith: 'Market' } };
    if (q.action) where.action = q.action;
    if (q.entity) where.entity = q.entity;
    if (q.userId) where.userId = q.userId;
    if (q.from || q.to) {
      where.createdAt = {};
      if (q.from) where.createdAt.gte = new Date(q.from);
      if (q.to) { const t = new Date(q.to); t.setHours(23, 59, 59, 999); where.createdAt.lte = t; }
    }

    const take = Math.min(Number(q.take) || 60, 200);
    const skip = Number(q.skip) || 0;
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take, skip,
      }),
      prisma.auditLog.count({ where }),
    ]);

    // جستجو روی متنِ ساخته‌شده انجام می‌شود نه در دیتابیس، چون `changes` از نوع
    // Json است و شرطِ متنی رویش هم کند است هم به شکلِ ذخیره وابسته.
    const term = (q.search || '').trim();
    const filtered = term
      ? rows.filter((r) => JSON.stringify(r.changes || {}).includes(term) || (r.user?.name || '').includes(term))
      : rows;

    res.json({ rows: filtered, total, take, skip });
  });

  /** گزینه‌های واقعیِ موجود، برای دراپ‌داون فیلترها */
  router.get('/activity/facets', async (_req: Request, res: Response) => {
    const rows = await prisma.auditLog.findMany({
      where: { entity: { startsWith: 'Market' } },
      select: { entity: true, userId: true, user: { select: { id: true, name: true } } },
      distinct: ['entity', 'userId'],
    });
    const users = new Map<string, string>();
    for (const r of rows) if (r.user) users.set(r.user.id, r.user.name);
    res.json({
      entities: [...new Set(rows.map((r) => r.entity))].sort(),
      users: [...users].map(([id, name]) => ({ id, name })),
    });
  });
}

/** نام فارسی هر موجودیت — هم برای دراپ‌داون فیلتر، هم برای ستون جدول */
export const ENTITY_FA: Record<string, string> = {
  MarketContact: 'مخاطب',
  MarketCall: 'گفت‌وگو',
  MarketInterest: 'نظر محصول',
  MarketPromise: 'تعهد ارسال',
  MarketFile: 'پیوست',
  MarketProduct: 'محصول',
  MarketCity: 'شهر',
  MarketTemplate: 'قالب پیام',
  MarketSetting: 'تنظیمات',
};
