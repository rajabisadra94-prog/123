import type { MarketStatus } from '@prisma/client';
import prisma from '../../shared/utils/prisma';
import { sendPushToUsers } from '../../shared/utils/push';

// ─────────────────────────────────────────────
// شماره تلفن عراق
// ─────────────────────────────────────────────

/**
 * شمارهٔ عراقی را به یک شکل واحد در می‌آورد: `9647XXXXXXXXX`.
 *
 * چرا لازم است: یک شماره در فایل‌های مختلف به ده شکل نوشته می‌شود —
 * `07701234567`، `+964 770 123 4567`، `00964-770-1234567`، `۰۷۷۰…` با ارقام فارسی.
 * بدون یکدست‌کردن، نه تشخیص تکراری کار می‌کند نه جستجو.
 *
 * خروجی `null` یعنی چیزی که دادند شمارهٔ قابل‌استفاده نبود.
 */
export function normalizeIraqPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // ارقام فارسی/عربی → لاتین
  const latin = String(raw).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  let digits = latin.replace(/\D/g, '');
  if (!digits) return null;

  // پیشوند بین‌المللی به هر شکلی که نوشته شده. ترتیب مهم است: «0964» باید
  // پیش از شاخهٔ صفرِ ملی بررسی شود، وگرنه صفرش حذف می‌شود، «964…» می‌ماند
  // و چون آن شاخه قبلاً رد شده، شماره ۱۳رقمی و نامعتبر تشخیص داده می‌شد.
  // همین باعث شد در فایل‌های واقعی فقط ۴ شماره از ۵۸ شناخته شود.
  if (digits.startsWith('00964')) digits = digits.slice(5);
  else if (digits.startsWith('0964')) digits = digits.slice(4);
  else if (digits.startsWith('964')) digits = digits.slice(3);
  digits = digits.replace(/^0+/, '');

  // شمارهٔ ملی عراق: موبایل ۱۰ رقم (7XXXXXXXXX)، ثابت ۸ تا ۹ رقم
  if (digits.length < 8 || digits.length > 10) return null;
  return '964' + digits;
}

/** همهٔ شماره‌های یک رکورد را یکدست و بدون تکرار برمی‌گرداند (برای ستون phoneNorm) */
export function buildPhoneNorm(...raws: (string | null | undefined)[]): string[] {
  const out = raws.map(normalizeIraqPhone).filter((x): x is string => !!x);
  return [...new Set(out)];
}

// ─────────────────────────────────────────────
// وضعیت‌هایی که «کار این مخاطب تمام است»
// ─────────────────────────────────────────────

/**
 * از صف تماس، پیگیری‌ها و یادآوری‌ها بیرون می‌مانند.
 *
 * یک‌جا تعریف شده چون قبلاً `routes.ts` و `notifyMarketDue` هرکدام نسخهٔ
 * جدای خودشان را داشتند و `UNREACHABLE` (شمارهٔ اشتباه) در هیچ‌کدام نبود —
 * یعنی مخاطبی که یک بار «شماره اشتباه» ثبت می‌شد، برای همیشه در صف تماس
 * و یادآوری‌ها می‌ماند و هیچ‌وقت رهایش نمی‌کردیم.
 */
export const CLOSED_STATUSES: MarketStatus[] = ['CUSTOMER', 'NOT_INTERESTED', 'BLACKLIST', 'UNREACHABLE'];

// ─────────────────────────────────────────────
// بازهٔ سررسید — به‌وقتِ عراق
// ─────────────────────────────────────────────

const IRAQ_TZ = 'Asia/Baghdad';

/** روزِ محلیِ عراق برای یک لحظه، به شکل `YYYY-MM-DD` — برای مقایسهٔ «همان روز» بدون دخالت ساعت */
function iraqDayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IRAQ_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** ساعتِ محلیِ عراق (۰..۲۳) برای یک لحظه — مبنای «بهترین ساعت تماس» */
export function iraqHour(d: Date): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: IRAQ_TZ, hour: '2-digit', hour12: false }).format(d));
}

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'none';

/**
 * یک موعد را عقب‌افتاده/امروز/آینده می‌کند — به‌وقتِ بغداد، نه ساعت محلیِ
 * سروری که این کد رویش اجرا می‌شود.
 *
 * چرا لازم است: پیگیری‌ها و تعهدها قبلاً هرکدام جدا با `new Date()`/
 * `toDateString()` (ساعت سرور) این را حساب می‌کردند — نزدیک نیمه‌شب، «امروز»
 * عراق می‌توانست یک روز جابه‌جا نمایش داده شود. `iraqNow()` در فرانت
 * (`shared.ts`) از قبل درست همین ایده را برای «الان وقت مناسب تماس است؟»
 * پیاده کرده؛ این همان روش را برای «سررسید» هم به کار می‌برد.
 */
export function dueBucket(dueAt: Date | null | undefined, now: Date = new Date()): DueBucket {
  if (!dueAt) return 'none';
  const dueDay = iraqDayKey(dueAt);
  const today = iraqDayKey(now);
  if (dueDay === today) return 'today';
  return dueDay < today ? 'overdue' : 'upcoming';
}

// ─────────────────────────────────────────────
// پیشرفت خودکار وضعیت از نتیجهٔ تماس
// ─────────────────────────────────────────────

/**
 * از نتیجهٔ یک تماس، وضعیت بعدیِ مخاطب را برمی‌گرداند (یا `null` یعنی عوض نشود).
 *
 * یک‌جا تعریف شده چون قبلاً این قانون فقط داخل `POST /calls` نوشته شده بود —
 * یعنی وقتی یک تماسِ ثبت‌شده را ویرایش می‌کردی (مثلاً نتیجهٔ اشتباه‌ثبت‌شده را
 * درست می‌کردی)، وضعیتِ غلطی که آن نتیجهٔ اشتباه ساخته بود همچنان می‌ماند.
 * حالا هم ثبت هم ویرایشِ تماس از همین یک تابع استفاده می‌کنند.
 */
export function nextStatusForCallResult(currentStatus: MarketStatus | string, result?: string | null): MarketStatus | null {
  if (result === 'WRONG_NUMBER') return 'UNREACHABLE';
  if (result === 'REJECTED') return 'NOT_INTERESTED';
  if (result === 'ANSWERED' && ['NEW', 'ATTEMPTED'].includes(currentStatus)) return 'CONTACTED';
  if (result && ['NO_ANSWER', 'BUSY'].includes(result) && currentStatus === 'NEW') return 'ATTEMPTED';
  if (result === 'CALLBACK' && ['NEW', 'ATTEMPTED'].includes(currentStatus)) return 'CONTACTED';
  return null;
}

// ─────────────────────────────────────────────
// کد یکتای مخاطب
// ─────────────────────────────────────────────

/**
 * کد بعدی به شکل `MK-00001`.
 * از بیشترین کد موجود می‌سازد نه از count — تا حذف یک رکورد باعث کد تکراری نشود.
 */
export async function nextContactCode(): Promise<string> {
  const last = await prisma.marketContact.findFirst({
    where: { code: { startsWith: 'MK-' } },
    orderBy: { code: 'desc' },
    select: { code: true },
  });
  const n = last ? Number(last.code.slice(3)) || 0 : 0;
  return 'MK-' + String(n + 1).padStart(5, '0');
}

// ─────────────────────────────────────────────
// امتیاز خودکار مخاطب (۰..۱۰۰)
// ─────────────────────────────────────────────

/**
 * امتیاز «چقدر این مخاطب ارزش وقت گذاشتن دارد» را از دادهٔ واقعی می‌سازد،
 * تا صف تماس و لیست بدون قضاوت دستی مرتب شوند.
 *
 * سهم‌ها: علاقه به محصولات ۴۰ · نظر قیمت ۲۰ · درخواست نمونه ۱۰ ·
 * پاسخ‌گویی و پیشرفت وضعیت ۲۰ · رتبهٔ دستی ۱۰
 *
 * نکتهٔ کلیدی: علاقه **میانگین‌گیری نمی‌شود**. ما ۵ محصول داریم و مخاطبی که
 * یکی را دوست دارد و یکی را نه، هنوز مشتری خوبی است — میانگین‌گرفتن باعث
 * می‌شد هرچه دربارهٔ محصولات بیشتری صحبت کنیم امتیاز افت کند، یعنی دقیقاً
 * برعکسِ چیزی که می‌خواهیم. پس اولین «مثبت» بیشترین وزن را دارد، مثبت‌های
 * بعدی اضافه می‌کنند، و منفی‌ها فقط جریمهٔ کوچکی‌اند.
 */
export function computeScore(input: {
  interests: { level: string; priceOpinion: string; sampleRequested: boolean }[];
  status: string;
  rating: number | null;
  answeredCalls: number;
}): number {
  const { interests, status, rating, answeredCalls } = input;

  const positives = interests.filter((i) => i.level === 'POSITIVE').length;
  const neutrals = interests.filter((i) => i.level === 'NEUTRAL').length;
  const negatives = interests.filter((i) => i.level === 'NEGATIVE').length;

  let interestScore = 0;
  if (positives) interestScore = Math.min(40, 24 + (positives - 1) * 8);
  else if (neutrals) interestScore = Math.min(9, neutrals * 3);
  interestScore = Math.max(0, interestScore - negatives * 2);

  // نظر قیمت فقط روی محصولاتی که پسندیده معنا دارد — قیمت چیزی که اصلاً
  // نمی‌خواهد، به فروش ربطی ندارد. اگر هیچ محصولی را نپسندیده، میانگین کل.
  const priced = interests.filter((i) => i.priceOpinion !== 'NOT_DISCUSSED');
  const relevant = positives
    ? priced.filter((i) => i.level === 'POSITIVE')
    : priced;
  let priceScore = 0;
  if (relevant.length) {
    const raw = relevant.reduce((s, i) => s + (i.priceOpinion === 'GOOD' ? 1 : i.priceOpinion === 'ACCEPTABLE' ? 0.5 : 0), 0) / relevant.length;
    priceScore = raw * 20;
  }

  const sampleScore = interests.some((i) => i.sampleRequested) ? 10 : 0;

  // پیشرفت در قیف + اینکه اصلاً جواب تلفن را می‌دهد
  const STATUS_WEIGHT: Record<string, number> = {
    NEW: 0, ATTEMPTED: 2, CONTACTED: 6, INTERESTED: 12, NEGOTIATING: 16,
    SAMPLE_SENT: 18, CUSTOMER: 20, NOT_INTERESTED: 0, UNREACHABLE: 0, BLACKLIST: 0,
  };
  const progressScore = Math.min(20, (STATUS_WEIGHT[status] ?? 0) + Math.min(4, answeredCalls));

  const ratingScore = rating ? (rating / 5) * 10 : 0;

  const total = interestScore + priceScore + sampleScore + progressScore + ratingScore;
  return Math.max(0, Math.min(100, Math.round(total)));
}

/** امتیاز یک مخاطب را از دیتابیس دوباره می‌سازد و ذخیره می‌کند */
export async function refreshScore(contactId: string): Promise<number> {
  const contact = await prisma.marketContact.findUnique({
    where: { id: contactId },
    select: {
      status: true, rating: true,
      interests: { select: { level: true, priceOpinion: true, sampleRequested: true } },
      _count: { select: { calls: { where: { result: 'ANSWERED' } } } },
    },
  });
  if (!contact) return 0;
  const score = computeScore({
    interests: contact.interests,
    status: contact.status,
    rating: contact.rating,
    answeredCalls: contact._count.calls,
  });
  await prisma.marketContact.update({ where: { id: contactId }, data: { score } });
  return score;
}

// ─────────────────────────────────────────────
// اعلان سررسیدها
// ─────────────────────────────────────────────

/**
 * اعلان پیگیری‌های سررسیدشده و قول‌های ارسالِ عقب‌افتاده.
 *
 * idempotent است: هر موعد فقط یک بار اعلان می‌گیرد (`followUpNotifiedAt` / `notifiedAt`).
 * از مسیر داشبورد صدا زده می‌شود — همان الگوی `notifyDueFollowUps` در ماژول CRM.
 *
 * وقتی مخاطب مسئول ندارد، اعلان به سازندهٔ رکورد می‌رود؛ چون تیم یکی‌دو نفره است
 * و اگر «مسئول تعیین نشده» را بی‌صدا رد کنیم، همان یادآوری‌ای که کاربر خواسته گم می‌شود.
 */
export async function notifyMarketDue(): Promise<void> {
  const now = new Date();

  try {
    const dueContacts = await prisma.marketContact.findMany({
      where: {
        status: { notIn: CLOSED_STATUSES },
        nextFollowUpAt: { not: null, lte: now },
      },
      select: { id: true, name: true, assignedToId: true, createdById: true, nextFollowUpAt: true, followUpNotifiedAt: true },
    });
    for (const c of dueContacts) {
      if (c.followUpNotifiedAt && c.nextFollowUpAt && c.followUpNotifiedAt >= c.nextFollowUpAt) continue;
      const userId = c.assignedToId || c.createdById;
      if (!userId) continue;
      await prisma.notification.create({
        data: { userId, type: 'MARKET_FOLLOWUP', message: `⏰ زمان پیگیری «${c.name}» رسیده است`, entityType: 'MarketContact', entityId: c.id },
      });
      await sendPushToUsers([userId], 'پیگیری بازار', `زمان پیگیری «${c.name}» رسیده`, { type: 'MARKET_FOLLOWUP', entityId: c.id });
      await prisma.marketContact.update({ where: { id: c.id }, data: { followUpNotifiedAt: now } });
    }
  } catch (e) {
    console.error('notifyMarketDue (follow-ups) failed:', (e as Error).message);
  }

  try {
    const duePromises = await prisma.marketPromise.findMany({
      where: { status: 'PENDING', dueAt: { not: null, lte: now } },
      select: { id: true, kind: true, description: true, dueAt: true, notifiedAt: true, assignedToId: true, createdById: true, contact: { select: { id: true, name: true } } },
    });
    for (const p of duePromises) {
      if (p.notifiedAt && p.dueAt && p.notifiedAt >= p.dueAt) continue;
      const userId = p.assignedToId || p.createdById;
      if (!userId) continue;
      const what = p.description?.trim() || PROMISE_KIND_FA[p.kind] || 'ارسال';
      await prisma.notification.create({
        data: { userId, type: 'MARKET_PROMISE', message: `📦 قرار بود «${what}» را برای «${p.contact.name}» بفرستید`, entityType: 'MarketContact', entityId: p.contact.id },
      });
      await sendPushToUsers([userId], 'تعهد ارسال', `«${what}» برای ${p.contact.name}`, { type: 'MARKET_PROMISE', entityId: p.contact.id });
      await prisma.marketPromise.update({ where: { id: p.id }, data: { notifiedAt: now } });
    }
  } catch (e) {
    console.error('notifyMarketDue (promises) failed:', (e as Error).message);
  }
}

export const PROMISE_KIND_FA: Record<string, string> = {
  SAMPLE: 'نمونه', CATALOG: 'کاتالوگ', PRICE_LIST: 'لیست قیمت',
  QUOTE: 'پیش‌فاکتور', VIDEO: 'ویدیو', CERTIFICATE: 'گواهی', OTHER: 'سایر',
};
