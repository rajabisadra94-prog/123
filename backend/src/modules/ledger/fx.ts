/**
 * چندارزی و تسعیر — docs/ACCOUNTING_SPEC.md بند ۳-۳
 *
 * ریاضیات اینجا **بازتولید** رفتار اثبات‌شدهٔ هستهٔ قدیمی است، نه اختراع دوباره.
 * همان قواعدی که در `tests/proven/03` تا `05` قفل شده‌اند، اینجا روی مدل جدید
 * (عدد صحیح، تفصیلی شناور، ارز روی ردیف) پیاده می‌شوند.
 *
 * ⚠️ هیچ تابعی در این ماژول به شبکه نمی‌رود. نرخ یا از جدول `GlExchangeRate`
 * خوانده می‌شود یا صراحتاً پاس داده می‌شود. دلیلش در `LEDGER_SCHEMA.md` بخش ۷
 * مکتوب است: گرفتن نرخ زنده داخل تراکنشِ قفل‌دار، کل ثبت را به‌اندازهٔ تأخیر شبکه
 * سریال می‌کند — همان چیزی که امروز تجدید ارزیابی هستهٔ قدیمی را ۶ ثانیه‌ای کرده.
 */
import { Prisma } from '@prisma/client';
import { Minor, Rate, RATE_SCALE, rateFrom, toBase, divRound } from './money';
import { post, DraftLine, LedgerError } from './poster';

export const FX_CODES = {
  gainRealized: '8101',
  gainUnrealized: '8102',
  lossRealized: '8201',
  lossUnrealized: '8202',
  assetAdjustment: '1108',
  liabilityAdjustment: '2111',
} as const;

export class FxError extends Error {}

// ───────────────────────────────────────────────────────────────
// نرخ
// ───────────────────────────────────────────────────────────────

/** در تاریخِ یکسان، نرخِ دستیِ حسابدار بر خودکار اولویت دارد */
const RATE_SOURCE_RANK: Record<string, number> = { MANUAL: 0, BACKFILL: 1, AUTO: 2 };

/**
 * نرخِ **مؤثر** در یک تاریخ: تازه‌ترین ردیفِ `date <= asOf` و در تساویِ تاریخ،
 * منبعِ با اولویت بالاتر (`MANUAL`).
 *
 * چرا یک تابع مشترک: هم `resolveRate` (که نرخ را برای ثبت سند برمی‌دارد) و هم
 * `checkRateOutlier` (که نرخ ورودی را با آن می‌سنجد) باید **دقیقاً یک نرخ** را
 * ببینند. اگر جدا محاسبه شوند، گارد با نرخی می‌سنجد که هسته هرگز استفاده نمی‌کند.
 *
 * ⚠️ ممیزی ن۳: شرط `date <= asOf` حیاتی است. بدون آن، یک نرخِ تاریخ‌آینده
 * (که ممکن است اشتباه هم باشد) معیارِ سنجشِ همهٔ نرخ‌های گذشته می‌شود.
 */
async function effectiveRateRow(
  tx: Prisma.TransactionClient,
  from: string,
  to: string,
  asOf: Date,
) {
  const rows = await tx.glExchangeRate.findMany({
    where: { from, to, date: { lte: asOf } },
    orderBy: [{ date: 'desc' }],
    take: 8,
  });
  if (!rows.length) return null;
  const newest = rows[0].date.getTime();
  return rows
    .filter((r) => r.date.getTime() === newest)
    .sort((a, b) => (RATE_SOURCE_RANK[a.source] ?? 9) - (RATE_SOURCE_RANK[b.source] ?? 9))[0];
}

/**
 * آخرین نرخ ثبت‌شده تا یک تاریخ. اگر نرخی نباشد خطا می‌دهد — **حدس نمی‌زند**،
 * چون نرخ حدسی در دفتر، سود و زیان جعلی می‌سازد.
 *
 * یک تاریخ می‌تواند چند ردیف داشته باشد (`MANUAL` دستی، `AUTO` تغذیهٔ زنده،
 * `BACKFILL` تاریخچه) — کلید یکتا `[from,to,date,source]` است. تازه‌ترین تاریخ
 * برنده است و در تساویِ تاریخ، `MANUAL`.
 *
 * ⚠️ ممیزی ن۲ — دفاع در عمق: نرخِ نامثبت اینجا هم رد می‌شود، نه فقط با قید
 * دیتابیس. دلیلش این است که یک ردیفِ آلودهٔ از پیش موجود (در دیتابیسی که هنوز
 * قید رویش اعمال نشده) در `previewRevaluation` کلِ یک موضع ارزی را صفر ارزیابی
 * می‌کند و یک سندِ **متوازنِ** زیانِ ساختگی می‌سازد که هیچ سنجهٔ دیگری نمی‌گیردش.
 */
export async function resolveRate(
  tx: Prisma.TransactionClient,
  currencyCode: string,
  asOf: Date,
): Promise<Rate> {
  const base = await baseCurrency(tx);
  if (currencyCode === base.code) return rateFrom(1);

  const best = await effectiveRateRow(tx, currencyCode, base.code, asOf);
  if (!best) {
    throw new FxError(
      `نرخ ${currencyCode} تا تاریخ ${asOf.toISOString().slice(0, 10)} ثبت نشده است`,
    );
  }
  if (!(Number(best.rate) > 0)) {
    throw new FxError(
      `نرخ ثبت‌شدهٔ ${currencyCode} در ${best.date.toISOString().slice(0, 10)} ` +
      `نامعتبر است (${best.rate.toString()}). نرخ باید بزرگ‌تر از صفر باشد؛ اصلاحش کنید.`,
    );
  }
  return rateFrom(best.rate.toString());
}

export async function baseCurrency(tx: Prisma.TransactionClient) {
  const base = await tx.glCurrency.findFirst({ where: { isBase: true } });
  if (!base) throw new FxError('هیچ ارز پایه‌ای تعریف نشده است');
  return base;
}

/** آستانهٔ انحراف نرخ که نیاز به تأیید صریح دارد (ممیزی ج۱۵) */
export const RATE_OUTLIER_THRESHOLD = 0.15;

/**
 * بازهٔ عقلانیتِ **مطلق** نرخ (ریال به‌ازای یک واحد ارز).
 *
 * گاردِ انحراف کاملاً **نسبی** است: با نبودِ مرجع، هیچ نمی‌گوید. پس نخستین نرخِ
 * هر ارز — دقیقاً همان نقطه‌ای که یک صفرِ اضافه بیشترین آسیب را می‌زند — بی‌گارد
 * می‌ماند. این بازه عمداً بسیار گشاد است تا واقعیتِ اقتصاد ایران را محدود نکند و
 * فقط عددِ آشکارا بی‌معنا را بگیرد (مثل ۱۰²⁰ یا کسری کوچک‌تر از یک هزارم ریال).
 */
export const RATE_ABS_MIN = 0.001;
export const RATE_ABS_MAX = 1e12;

/**
 * نرخ واردشده را با **نرخِ مؤثرِ همان تاریخ** می‌سنجد. انحراف بزرگ معمولاً
 * یعنی خطای تایپی (نرخ ۳–۱۰ برابر) — سند افتتاحیهٔ مهاجرت پر از همین بود.
 * ارزان‌ترین کنترلی که بیشترین جلوگیری را می‌کند.
 *
 * دو درسِ ممیزی دوم، هر دو اینجا:
 *
 * **ن۲ — نرخِ نامثبت خطاست، نه «پرت».** نسخهٔ قبلی با
 * `if (!last || !(prop > 0)) return { ok: true }` هر نرخ ≤ ۰ را از گارد **معاف**
 * می‌کرد. نتیجه: `rate: "0"` و `rate: "-999999"` هر دو ۲۰۰ می‌گرفتند و در دفتر
 * می‌نشستند. یک نرخ صفر، موضع ۱۰٬۰۰۰ درهمی را در تجدید ارزیابی صفر ارزیابی کرد و
 * ۵٫۷ میلیارد ریال زیانِ ساختگی ساخت. حالا **پرتاب می‌شود** نه برگردانده — تا
 * `confirmOutlier` هم نتواند دورش بزند (تأیید برای «پرت» است، نه برای «نامعتبر»).
 *
 * **ن۳ — مرجع باید نرخِ همان تاریخ باشد.** نسخهٔ قبلی تازه‌ترین نرخِ جدول را
 * بدون توجه به تاریخِ نرخِ جدید برمی‌داشت، پس یک نرخِ تاریخ‌آینده معیارِ همه‌چیز
 * می‌شد. اندازه‌گیری‌شده: با یک نرخِ غلطِ ۷۰۰٬۰۰۰ در آینده، نرخِ **درستِ** بازار
 * (۲٬۱۰۰٬۰۰۰) رد و نرخِ **غلطِ** ۶۰۰٬۰۰۰ پذیرفته می‌شد — یعنی گارد وارونه شده بود.
 */
export async function checkRateOutlier(
  tx: Prisma.TransactionClient,
  from: string,
  to: string,
  proposedPlainRate: string | number,
  asOf: Date,
): Promise<{
  ok: boolean;
  deviation: number;
  reason: 'OUTLIER' | 'FIRST_RATE' | null;
  last: { rate: string; date: string; source: string } | null;
}> {
  const prop = Number(proposedPlainRate);
  if (!Number.isFinite(prop) || prop <= 0) {
    throw new FxError(`نرخ باید عددی بزرگ‌تر از صفر باشد — «${proposedPlainRate}» پذیرفته نیست`);
  }
  // بازهٔ مطلق: خطاست نه «پرت» — با تأیید هم نباید بشود ثبتش کرد
  if (prop < RATE_ABS_MIN || prop > RATE_ABS_MAX) {
    throw new FxError(
      `نرخ «${proposedPlainRate}» بیرون از بازهٔ معقول است ` +
      `(${RATE_ABS_MIN} تا ${RATE_ABS_MAX.toLocaleString('en-US')} ریال به‌ازای هر واحد)`,
    );
  }

  // مرجع: نرخِ مؤثرِ همین تاریخ. اگر ارز هیچ نرخِ گذشته‌ای ندارد (نرخِ عقب‌تاریخ)،
  // نزدیک‌ترین نرخِ **بعدی** مرجع می‌شود — وگرنه یک تاریخِ عقب‌تر از کلِ جدول
  // راهِ فرارِ کاملاً بی‌گارد می‌شد، و نرخِ غلطِ عقب‌تاریخ دقیقاً همان چیزی است
  // که سند افتتاحیهٔ مهاجرت پر از آن بود. این N3 را برنمی‌گرداند: آنجا مشکل
  // ترجیحِ نرخِ آینده بر نرخِ گذشتهٔ **موجود** بود، نه نبودِ نرخ گذشته.
  const last =
    (await effectiveRateRow(tx, from, to, asOf)) ??
    (await tx.glExchangeRate.findFirst({
      where: { from, to, date: { gt: asOf } },
      orderBy: [{ date: 'asc' }],
    }));
  /**
   * نخستین نرخِ این ارز در کل جدول — مرجعی برای مقایسه نیست.
   *
   * پیش از این «بدون اشکال» برمی‌گشت، یعنی حساس‌ترین نرخِ هر ارز (اولی، که همهٔ
   * نرخ‌های بعدی با آن سنجیده می‌شوند) تنها نرخی بود که هیچ گاردی نداشت. حالا
   * یک‌بار — و فقط یک‌بار در عمرِ هر ارز — تأیید صریح می‌خواهد.
   */
  if (!last) return { ok: false, deviation: 0, reason: 'FIRST_RATE', last: null };

  const lastR = Number(last.rate);
  // مرجعِ نامعتبر (دادهٔ آلودهٔ قدیمی) مبنای قضاوت نمی‌شود — مثل نبودِ مرجع
  if (!(lastR > 0)) return { ok: false, deviation: 0, reason: 'FIRST_RATE', last: null };

  const deviation = Math.abs(prop - lastR) / lastR;
  const ok = deviation <= RATE_OUTLIER_THRESHOLD;
  return {
    ok,
    deviation,
    reason: ok ? null : 'OUTLIER',
    last: { rate: last.rate.toString(), date: last.date.toISOString().slice(0, 10), source: last.source },
  };
}

async function decimalsOf(tx: Prisma.TransactionClient, code: string): Promise<number> {
  const c = await tx.glCurrency.findUnique({ where: { code } });
  if (!c) throw new FxError(`ارز «${code}» تعریف نشده است`);
  return c.decimalPlaces;
}

const accountByCode = (tx: Prisma.TransactionClient, code: string) =>
  tx.glAccount.findUniqueOrThrow({ where: { code } });

// ───────────────────────────────────────────────────────────────
// بهای تمام‌شدهٔ ماندهٔ باز
// ───────────────────────────────────────────────────────────────

export interface PositionKey {
  accountId: string;
  subsidiaryId?: string | null;
  currencyCode: string;
}

/**
 * نرخ بهای تمام‌شدهٔ ماندهٔ باز — **میانگین موزون متحرک**.
 *
 * برخلاف میانگین سادهٔ کل تاریخچه، هر کاهش سهم خودش را از بهای انباشته برمی‌دارد،
 * پس نرخ همیشه مربوط به همان مانده‌ای است که هنوز باز مانده. وقتی مانده صفر شود،
 * سابقهٔ نرخ هم پاک می‌شود — تعهد جدید با نرخ خودش شروع می‌کند.
 *
 * این همان الگوریتم `walletAvgBookedRate` هستهٔ قدیمی است، روی عدد صحیح.
 */
export async function carryingRate(
  tx: Prisma.TransactionClient,
  key: PositionKey,
): Promise<Rate | null> {
  const base = await baseCurrency(tx);
  if (key.currencyCode === base.code) return rateFrom(1);

  const account = await tx.glAccount.findUniqueOrThrow({ where: { id: key.accountId } });
  const debitIncreases = account.normalSide === 'DEBIT';

  const lines = await tx.glLine.findMany({
    where: {
      accountId: key.accountId,
      currencyCode: key.currencyCode,
      subsidiaryId: key.subsidiaryId ?? null,
      entry: { status: { not: 'DRAFT' } },
    },
    select: { debit: true, credit: true, debitBase: true, creditBase: true },
    orderBy: [{ entry: { date: 'asc' } }, { entry: { serial: 'asc' } }, { lineNo: 'asc' }],
  });

  let qty = 0n;   // ماندهٔ باز به کوچک‌ترین واحد ارز
  let cost = 0n;  // بهای تمام‌شدهٔ همان مانده، به ارز پایه

  for (const l of lines) {
    const inc = debitIncreases ? l.debit : l.credit;
    const incBase = debitIncreases ? l.debitBase : l.creditBase;
    const dec = debitIncreases ? l.credit : l.debit;

    if (inc > 0n) {
      qty += inc;
      cost += incBase;
    }
    if (dec > 0n) {
      const used = dec < qty ? dec : qty;
      if (qty > 0n) cost -= divRound(cost * used, qty);
      qty -= used;
      if (qty <= 0n) { qty = 0n; cost = 0n; }  // مانده بسته شد ⇒ سابقهٔ نرخ هم پاک
    }
  }

  if (qty <= 0n || cost <= 0n) return null;

  const fd = await decimalsOf(tx, key.currencyCode);
  const bd = base.decimalPlaces;
  // rate = cost/qty ، با در نظر گرفتن اختلاف اعشار دو ارز
  return { scaled: divRound(cost * RATE_SCALE * 10n ** BigInt(fd), qty * 10n ** BigInt(bd)) };
}

/**
 * ارزی که نداریم، خرج نمی‌شود.
 *
 * ⚠️ این نگهبان از یک باگِ واقعی آمد: تبدیلِ ۹٬۹۹۹٬۹۹۹ دلار از حسابی که فقط
 * چند صد دلار داشت، با HTTP 200 پذیرفته شد. نتیجه‌اش دو چیزِ بی‌معنی بود:
 * ماندهٔ ارزیِ **منفیِ** ده‌میلیون‌دلاری، و «زیان تسعیر»ِ ۹٬۱۲۹ میلیارد ریالی
 * که از هیچ ساخته شده بود.
 *
 * چرا خودبه‌خود نمی‌شکست: `carryingRate` ماندهٔ موجود را قیمت‌گذاری می‌کند و
 * نرخِ متوسطِ همان چند صد دلار را به ده میلیون دلار تعمیم می‌دهد. فرمول
 * «درست» کار می‌کند؛ فرضش است که غلط است — روش temporal فقط موضعِ **باز و
 * مثبت** را می‌فهمد. موضعِ منفی یعنی فروشِ استقراضی، که حسابداریِ دیگری
 * (ارزش بازار) می‌خواهد و این دفتر آن را ندارد.
 *
 * چرا فقط ارزِ غیرپایه: ماندهٔ ریالیِ منفیِ یک حساب بانکی «اضافه‌برداشت» است
 * و در دنیای واقعی وجود دارد؛ بستنش کار درست را هم می‌بندد. نمای کلی هم از
 * قبل حساب‌های نقدیِ منفی را هشدار می‌دهد. ولی دلارِ منفی اضافه‌برداشت نیست،
 * غلط است.
 */
export async function assertFxCover(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string;
    currencyCode: string;
    /** مبلغی که از این حساب خارج می‌شود، به کوچک‌ترین واحد */
    outgoing: Minor;
    subsidiaryId?: string | null;
  },
) {
  if (input.outgoing <= 0n) return;
  const base = await baseCurrency(tx);
  if (input.currencyCode === base.code) return;

  const pos = await positionBalance(tx, {
    accountId: input.accountId,
    currencyCode: input.currencyCode,
    subsidiaryId: input.subsidiaryId ?? null,
  });
  if (pos.amount >= input.outgoing) return;

  const acc = await tx.glAccount.findUniqueOrThrow({ where: { id: input.accountId } });
  const fd = await decimalsOf(tx, input.currencyCode);
  const show = (v: Minor) => {
    if (fd === 0) return v.toString();
    const p = 10n ** BigInt(fd);
    const neg = v < 0n ? '-' : '';
    const a = v < 0n ? -v : v;
    return `${neg}${a / p}.${(a % p).toString().padStart(fd, '0')}`;
  };
  throw new FxError(
    `موجودیِ ${input.currencyCode} حساب «${acc.code} ${acc.name}» کافی نیست: ` +
    `موجودی ${show(pos.amount)} ولی ${show(input.outgoing)} خارج می‌شود. ` +
    'ارزِ نداشته قابل خرج کردن نیست — اول آن را وارد کنید یا مبلغ را اصلاح کنید.',
  );
}

/** ماندهٔ باز یک موضع، به ارز خودش و به ارز پایه */
export async function positionBalance(tx: Prisma.TransactionClient, key: PositionKey) {
  const account = await tx.glAccount.findUniqueOrThrow({ where: { id: key.accountId } });
  const sign = account.normalSide === 'DEBIT' ? 1n : -1n;

  const rows = await tx.$queryRaw<{ amount: bigint | null; base: bigint | null }[]>`
    SELECT (SUM(l.debit) - SUM(l.credit))::bigint             AS amount,
           (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS base
    FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE l."accountId" = ${key.accountId}
      AND l."currencyCode" = ${key.currencyCode}
      AND l."subsidiaryId" IS NOT DISTINCT FROM ${key.subsidiaryId ?? null}
      AND e.status <> 'DRAFT'
  `;
  return {
    amount: BigInt(rows[0]?.amount ?? 0n) * sign,
    base: BigInt(rows[0]?.base ?? 0n) * sign,
  };
}

// ───────────────────────────────────────────────────────────────
// تسویه — تسعیر محقق‌شده
// ───────────────────────────────────────────────────────────────

export interface SettlementInput {
  fiscalYearId: string;
  date: Date;
  direction: 'RECEIPT' | 'PAYMENT';
  /** حساب تعهد (مثلاً ۱۱۰۴ دریافتنی یا ۲۱۰۱ پرداختنی) */
  obligationAccountCode: string;
  subsidiaryId: string;
  obligationCurrency: string;
  /** مبلغ تسویه به ارز تعهد، در کوچک‌ترین واحد */
  settledAmount: Minor;
  /** حساب نقدی شرکت */
  cashAccountCode: string;
  cashCurrency: string;
  cashAmount: Minor;
  /** نرخ روزِ وجه نقد؛ اگر ندهید از جدول نرخ خوانده می‌شود */
  cashRate?: Rate;
  description?: string;
  attachmentUrls?: string[];
  createdById?: string | null;
  /** برای دونویسی: اگر سندی با همین شناسه هست، دوباره ثبت نمی‌شود */
  sourceId?: string | null;
  /**
   * ممیزی ب۴: اگر مبلغ تسویه از موضعِ باز بیشتر بود، مازاد به‌جای منفی‌کردنِ
   * حسابِ تعهد، به این حسابِ پیش‌دریافت/پیش‌پرداخت می‌رود (۲۱۰۳ مشتری، ۱۱۰۵
   * تأمین‌کننده). نیاز به هم‌ارز بودنِ نقد و تعهد دارد.
   */
  prepaymentAccountCode?: string;
}

/**
 * تسویهٔ تعهد ارزی — روش temporal.
 *
 *  • تعهد در **ارز خودش** و با **نرخ بهای تمام‌شدهٔ خودش** بسته می‌شود
 *    ⇒ موضع ارزی طرف‌حساب دقیقاً صفر می‌شود، نه «تقریباً صفر»
 *  • وجه نقد به ارز و نرخ واقعی خودش ثبت می‌شود
 *  • اختلاف ارزش پایهٔ دو سمت = سود/زیان تسعیر **محقق‌شده**
 */
export async function postSettlement(tx: Prisma.TransactionClient, input: SettlementInput) {
  if (input.settledAmount <= 0n) throw new FxError('مبلغ تسویه باید بزرگ‌تر از صفر باشد');
  if (input.cashAmount <= 0n) throw new FxError('مبلغ نقدی باید بزرگ‌تر از صفر باشد');

  if (input.sourceId) {
    const dup = await tx.glEntry.findFirst({
      where: { sourceType: 'Settlement', sourceId: input.sourceId, status: { not: 'REVERSED' } },
      select: { id: true },
    });
    if (dup) return tx.glEntry.findUniqueOrThrow({ where: { id: dup.id }, include: { lines: true } });
  }

  const obligationAcc = await accountByCode(tx, input.obligationAccountCode);
  const cashAcc = await accountByCode(tx, input.cashAccountCode);
  const base = await baseCurrency(tx);

  const key: PositionKey = {
    accountId: obligationAcc.id,
    subsidiaryId: input.subsidiaryId,
    currencyCode: input.obligationCurrency,
  };
  // اگر موضعی باز نیست (تسویهٔ پیش از تعهد)، نرخ روز مبنا می‌شود
  const bookedRate = (await carryingRate(tx, key)) ?? (await resolveRate(tx, input.obligationCurrency, input.date));
  const dayRate = input.cashRate ?? (await resolveRate(tx, input.cashCurrency, input.date));

  const obFd = await decimalsOf(tx, input.obligationCurrency);
  const cashFd = await decimalsOf(tx, input.cashCurrency);
  const isReceipt = input.direction === 'RECEIPT';

  /**
   * ⚠️ ممیزی ب۳ — ارزی که **از** حساب خارج می‌شود به بهای تمام‌شدهٔ خودش آزاد
   * می‌شود، نه به نرخ روز.
   *
   * پیش‌تر ردیف نقد همیشه نرخ روز می‌گرفت. اثرش: پرداخت ۱۰٬۰۰۰ دلاری از حسابی
   * که دلارش را ۲٬۰۰۰٬۰۰۰ خریده بود، در نرخ روز ۲٬۱۰۰٬۰۰۰، «زیان تسعیر
   * ۱٬۰۰۰٬۰۰۰٬۰۰۰» می‌ساخت — با اینکه موضع کاملاً پوشش‌دار بود و سود و زیان
   * اقتصادی صفر. بدتر اینکه بهای تمام‌شدهٔ ماندهٔ حساب هم خراب می‌شد
   * (۵٬۰۰۰ دلارِ ۲٬۰۰۰٬۰۰۰ای با ۱٬۸۰۰٬۰۰۰ حمل می‌شد) و خطا به تبدیل‌های بعدی
   * و به تجدید ارزیابی منتشر می‌شد.
   *
   * `postConversion` از ابتدا همین کار را درست انجام می‌داد (خط ۵۴۴)؛ این
   * همان اصلاح است که به مسیر تسویه نرسیده بود.
   *
   * فقط سمتِ **خروج**: ارزی که وارد می‌شود بهای تمام‌شده‌اش همان نرخ روزِ
   * تحصیل است، پس دریافت‌ها باید نرخ روز بگیرند.
   */
  const cashOutgoing = !isReceipt;
  const cashRate = cashOutgoing
    ? (await carryingRate(tx, { accountId: cashAcc.id, currencyCode: input.cashCurrency })) ?? dayRate
    : dayRate;

  // ── ممیزی ب۴: تفکیک تعهد از مازادِ پیش‌دریافت/پیش‌پرداخت ──
  let obligationPart = input.settledAmount;
  let excess = 0n;
  if (input.prepaymentAccountCode && input.obligationCurrency === input.cashCurrency) {
    const pos = await positionBalance(tx, key);   // امضاشده با ماهیت حساب: مثبت = موضعِ باز
    const open = pos.amount > 0n ? pos.amount : 0n;
    if (input.settledAmount > open) {
      obligationPart = open;
      excess = input.settledAmount - open;
    }
  }

  // پرداختِ ارزی از حسابی که آن ارز را ندارد، همان غلطِ تبدیل است با نامِ دیگر
  if (!isReceipt) {
    await assertFxCover(tx, {
      accountId: cashAcc.id, currencyCode: input.cashCurrency, outgoing: input.cashAmount,
    });
  }

  const bd = base.decimalPlaces;
  const b = (amt: Minor, r: Rate, fd: number) => toBase(amt, r, fd, bd);

  const lines: DraftLine[] = [];
  const cashLine: DraftLine = { accountId: cashAcc.id, currencyCode: input.cashCurrency, rate: cashRate };
  const oblLine: DraftLine = { accountId: obligationAcc.id, subsidiaryId: input.subsidiaryId, currencyCode: input.obligationCurrency, rate: bookedRate };

  if (isReceipt) {
    lines.push({ ...cashLine, debit: input.cashAmount, memo: 'دریافت وجه' });
    if (obligationPart > 0n) lines.push({ ...oblLine, credit: obligationPart, memo: 'تسویهٔ طلب' });
  } else {
    if (obligationPart > 0n) lines.push({ ...oblLine, debit: obligationPart, memo: 'تسویهٔ بدهی' });
    lines.push({ ...cashLine, credit: input.cashAmount, memo: 'پرداخت وجه' });
  }
  if (excess > 0n) {
    const prepayAcc = await accountByCode(tx, input.prepaymentAccountCode!);
    lines.push({
      accountId: prepayAcc.id, subsidiaryId: input.subsidiaryId,
      currencyCode: input.obligationCurrency, rate: cashRate,
      ...(isReceipt ? { credit: excess } : { debit: excess }),
      memo: isReceipt ? 'پیش‌دریافت (مازاد تسویه)' : 'پیش‌پرداخت (مازاد تسویه)',
    });
  }

  /**
   * ⚠️ ممیزی ب۲ — پیش از ساختن پلاگ، تناسب دو سمت سنجیده می‌شود.
   *
   * پلاگ هر اختلافی را می‌بلعد، از جمله غلط تایپی. مسیر هم‌ارز محافظ داشت
   * (`doSettlement`) ولی مسیر بین‌ارزی نداشت: بدهی ۱۰۰ دلاری معادل
   * ۲۰۰٬۰۰۰٬۰۰۰ ریال با پرداخت ۹۰۰٬۰۰۰٬۰۰۰ ریالی تسویه می‌شد و
   * ۷۰۰٬۰۰۰٬۰۰۰ ریال «زیان تسعیر» ثبت می‌شد — نرخ ضمنی ۹٬۰۰۰٬۰۰۰ در برابر
   * نرخ روز ۲٬۰۰۰٬۰۰۰، بدون یک کلمه هشدار.
   *
   * هر دو سمت به نرخ **روز** ارزش‌گذاری و مقایسه می‌شوند؛ اختلاف واقعیِ
   * تسعیر (بهای تمام‌شده در برابر نرخ روز) از این آزمون رد می‌شود چون در هر
   * دو سمت نرخ روز به‌کار می‌رود.
   */
  await assertSettlementProportional(tx, input, dayRate, bookedRate, obFd, cashFd, bd);

  /**
   * تسعیر محقق = پلاگِ دقیقِ توازن. تعهد به نرخ بهای تمام‌شده بسته می‌شود و نقد
   * به بهای تمام‌شدهٔ خودش (خروج) یا نرخ روز (ورود)؛ مابه‌التفاوتِ ارز پایه
   * سود/زیان محقق است. با محاسبهٔ پلاگ به‌جای فرمول، توازن حتی با گرد کردنِ
   * چندریالی هم تضمین می‌شود.
   */
  const imbalance = lines.reduce((s, l) => {
    const r = l.rate as Rate;
    const fd = l.currencyCode === input.obligationCurrency ? obFd : cashFd;
    return s + (l.debit ? b(l.debit, r, fd) : 0n) - (l.credit ? b(l.credit, r, fd) : 0n);
  }, 0n);

  if (imbalance !== 0n) {
    const acc = await accountByCode(tx, imbalance > 0n ? FX_CODES.gainRealized : FX_CODES.lossRealized);
    lines.push({
      accountId: acc.id,
      currencyCode: base.code,
      ...(imbalance > 0n ? { credit: imbalance } : { debit: -imbalance }),
      memo: imbalance > 0n ? 'سود تسعیر محقق‌شده' : 'زیان تسعیر محقق‌شده',
    });
  }

  return post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.date,
    description: input.description ?? (isReceipt ? 'دریافت از طرف‌حساب' : 'پرداخت به طرف‌حساب'),
    entryType: 'NORMAL',
    sourceType: 'Settlement',
    sourceId: input.sourceId ?? null,
    createdById: input.createdById ?? null,
    attachmentUrls: input.attachmentUrls,
    lines,
  });
}

/**
 * حداکثر انحراف مجاز میان ارزشِ روزِ دو سمتِ تسویه.
 *
 * ۱۵٪ عمداً سخاوتمندانه است: نرخ آزاد در یک روز چند درصد نوسان دارد و
 * کارمزد صرافی هم روی مبلغ می‌نشیند. هدف گرفتنِ غلطِ تایپی (صفر اضافه،
 * جابه‌جایی رقم) است، نه سخت‌گیری روی معاملهٔ واقعی.
 */
const SETTLEMENT_TOLERANCE_PERCENT = 15n;

async function assertSettlementProportional(
  tx: Prisma.TransactionClient,
  input: SettlementInput,
  cashDayRate: Rate,
  bookedRate: Rate,
  obFd: number,
  cashFd: number,
  bd: number,
): Promise<void> {
  /**
   * ⚠️ نرخ روزِ ارز تعهد ممکن است اصلاً ثبت نشده باشد.
   *
   * این آزمون نباید مسیری را ببندد که بدون آن کار می‌کرد: پیش از افزودنش،
   * تسویهٔ یک بدهی ارزی با پرداخت ریالی فقط به `carryingRate` نیاز داشت و
   * نرخ بازار لازم نبود. اجباری‌کردنِ `resolveRate` باعث شد پرداختِ یک بدهی
   * درهمی در تاریخی که هنوز نرخ AED ثبت نشده بود، با «نرخ AED ثبت نشده
   * است» رد شود — رگرسیونی که خودِ این محافظ ساخت.
   *
   * نرخ بهای تمام‌شدهٔ همان موضع، مرجعِ کاملاً معتبری برای سنجش تناسب است.
   */
  const obligationDayRate = await resolveRate(tx, input.obligationCurrency, input.date)
    .catch(() => bookedRate);
  const settledAtSpot = toBase(input.settledAmount, obligationDayRate, obFd, bd);
  const cashAtSpot = toBase(input.cashAmount, cashDayRate, cashFd, bd);
  if (settledAtSpot <= 0n) return;   // چیزی برای مقایسه نیست

  const gap = cashAtSpot > settledAtSpot ? cashAtSpot - settledAtSpot : settledAtSpot - cashAtSpot;
  if (gap * 100n <= settledAtSpot * SETTLEMENT_TOLERANCE_PERCENT) return;

  const pct = Number((gap * 1000n) / settledAtSpot) / 10;
  throw new FxError(
    `مبلغ نقد با مبلغ تعهد نمی‌خواند: تعهد به نرخ روز ${settledAtSpot.toString()} ` +
    `ولی نقد ${cashAtSpot.toString()} (ارز پایه) — ${pct.toFixed(1)}٪ اختلاف. ` +
    'مبلغ یا ارز را بررسی کنید؛ اگر معامله واقعاً با این نرخ انجام شده، ' +
    'نرخ روز را برای همان تاریخ ثبت کنید و دوباره تلاش کنید.',
  );
}

// ───────────────────────────────────────────────────────────────
// تبدیل ارز
// ───────────────────────────────────────────────────────────────

export interface ConversionInput {
  fiscalYearId: string;
  date: Date;
  fromAccountCode: string;
  fromCurrency: string;
  fromAmount: Minor;
  toAccountCode: string;
  toCurrency: string;
  toAmount: Minor;
  description?: string;
  attachmentUrls?: string[];
  createdById?: string | null;
}

/**
 * تبدیل ارز — **تعویض دارایی به‌خودی‌خود سود نمی‌سازد**.
 *
 * این همان باگی است که در هستهٔ قدیمی رفع شد: نسخهٔ قبلی هر تبدیل را با نرخ روز
 * ارزیابی می‌کرد و اختلافش را «سود» می‌نوشت، پس صرفِ خریدن دلار سود می‌ساخت.
 *
 * قاعدهٔ درست:
 *  • سمت خروجی به **بهای تمام‌شدهٔ خودش** از دفتر خارج می‌شود
 *  • سمت ورودی دقیقاً به همان بهایی می‌نشیند که بابتش پرداخت شده
 *  • ارز پایه نرخ قطعی ۱ دارد و نمی‌تواند بها جذب کند؛ پس وقتی سمت ورودی ارز
 *    پایه باشد، مابه‌التفاوت همان سود/زیان **محقق‌شده** است
 */
export async function postConversion(tx: Prisma.TransactionClient, input: ConversionInput) {
  if (input.fromCurrency === input.toCurrency) {
    throw new FxError('ارز مبدأ و مقصد باید متفاوت باشند');
  }
  if (input.fromAmount <= 0n || input.toAmount <= 0n) {
    throw new FxError('مبالغ تبدیل باید بزرگ‌تر از صفر باشند');
  }

  const fromAcc = await accountByCode(tx, input.fromAccountCode);
  const toAcc = await accountByCode(tx, input.toAccountCode);
  const base = await baseCurrency(tx);

  // پیش از هر محاسبه‌ای: ارزی که نداریم نمی‌فروشیم
  await assertFxCover(tx, {
    accountId: fromAcc.id, currencyCode: input.fromCurrency, outgoing: input.fromAmount,
  });

  const fromRate =
    (await carryingRate(tx, { accountId: fromAcc.id, currencyCode: input.fromCurrency })) ??
    (await resolveRate(tx, input.fromCurrency, input.date));

  const fromFd = await decimalsOf(tx, input.fromCurrency);
  const toFd = await decimalsOf(tx, input.toCurrency);
  const fromBase = toBase(input.fromAmount, fromRate, fromFd, base.decimalPlaces);

  // سمت ورودی: ارز پایه نرخ ثابت ۱ دارد؛ ارز دیگر به بهای واقعیِ پرداخت‌شده می‌نشیند
  const toRate: Rate =
    input.toCurrency === base.code
      ? rateFrom(1)
      : { scaled: divRound(fromBase * RATE_SCALE * 10n ** BigInt(toFd), input.toAmount * 10n ** BigInt(base.decimalPlaces)) };
  const toBaseAmount = toBase(input.toAmount, toRate, toFd, base.decimalPlaces);

  const lines: DraftLine[] = [
    { accountId: toAcc.id, currencyCode: input.toCurrency, debit: input.toAmount, rate: toRate, memo: 'دریافت در تبدیل ارز' },
    { accountId: fromAcc.id, currencyCode: input.fromCurrency, credit: input.fromAmount, rate: fromRate, memo: 'پرداخت در تبدیل ارز' },
  ];

  const fx = toBaseAmount - fromBase;   // فقط وقتی سمت ورودی ارز پایه است غیرصفر می‌شود
  if (fx !== 0n) {
    const acc = await accountByCode(tx, fx > 0n ? FX_CODES.gainRealized : FX_CODES.lossRealized);
    lines.push({
      accountId: acc.id,
      currencyCode: base.code,
      ...(fx > 0n ? { credit: fx } : { debit: -fx }),
      memo: fx > 0n ? 'سود تسعیر محقق‌شده' : 'زیان تسعیر محقق‌شده',
    });
  }

  return post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.date,
    description: input.description ?? 'تبدیل ارز',
    entryType: 'NORMAL',
    sourceType: 'Conversion',
    createdById: input.createdById ?? null,
    attachmentUrls: input.attachmentUrls,
    lines,
  });
}

// ───────────────────────────────────────────────────────────────
// تجدید ارزیابی پایان دوره — تسعیر تحقق‌نیافته
// ───────────────────────────────────────────────────────────────

export interface RevaluationLine {
  accountId: string;
  code: string;
  accountName: string;
  subsidiaryId: string | null;
  subsidiaryName: string | null;
  currencyCode: string;
  amount: Minor;
  carryingBase: Minor;
  currentBase: Minor;
  deltaBase: Minor;
  rootType: string;
}

/**
 * اقلام پولی باز: دارایی و بدهی **ارزی** با ماندهٔ غیرصفر.
 *
 * درآمد، هزینه و سرمایه اقلام غیرپولی‌اند و به بهای تاریخی می‌مانند —
 * تجدید ارزیابی‌شان یعنی دوباره‌شماری سودی که قبلاً شناسایی شده.
 */
export async function previewRevaluation(
  tx: Prisma.TransactionClient,
  asOf: Date,
  overrideRates?: Record<string, Rate>,
): Promise<{ lines: RevaluationLine[]; totalGain: Minor; totalLoss: Minor; netBase: Minor; alreadyPosted: boolean }> {
  const base = await baseCurrency(tx);

  const positions = await tx.$queryRaw<
    { accountId: string; code: string; accountName: string; rootType: string; normalSide: string;
      subsidiaryId: string | null; subsidiaryName: string | null; currencyCode: string;
      amount: bigint; carrying: bigint }[]
  >`
    SELECT a.id AS "accountId", a.code, a.name AS "accountName",
           a."rootType"::text AS "rootType", a."normalSide"::text AS "normalSide",
           l."subsidiaryId", s.name AS "subsidiaryName", l."currencyCode",
           (SUM(l.debit) - SUM(l.credit))::bigint             AS amount,
           (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS carrying
    FROM "GlLine" l
    JOIN "GlEntry" e      ON e.id = l."entryId"
    JOIN "GlAccount" a    ON a.id = l."accountId"
    LEFT JOIN "GlSubsidiary" s ON s.id = l."subsidiaryId"
    WHERE e.status <> 'DRAFT'
      AND e.date <= ${asOf}
      AND l."currencyCode" <> ${base.code}
      AND a."rootType" IN ('ASSET', 'LIABILITY')
      AND a.code NOT IN (${FX_CODES.assetAdjustment}, ${FX_CODES.liabilityAdjustment})
    GROUP BY a.id, a.code, a.name, a."rootType", a."normalSide", l."subsidiaryId", s.name, l."currencyCode"
    HAVING SUM(l.debit) - SUM(l.credit) <> 0
  `;

  const lines: RevaluationLine[] = [];
  for (const p of positions) {
    const rate = overrideRates?.[p.currencyCode] ?? (await resolveRate(tx, p.currencyCode, asOf));
    const fd = await decimalsOf(tx, p.currencyCode);
    const amount = BigInt(p.amount);
    const carryingBase = BigInt(p.carrying);
    // مبلغ می‌تواند منفی باشد (مثلاً بدهی)؛ toBase روی قدر مطلق کار می‌کند
    const abs = amount < 0n ? -amount : amount;
    const currentAbs = toBase(abs, rate, fd, base.decimalPlaces);
    const currentBase = amount < 0n ? -currentAbs : currentAbs;
    const deltaBase = currentBase - carryingBase;
    if (deltaBase === 0n) continue;

    lines.push({
      accountId: p.accountId, code: p.code, accountName: p.accountName,
      subsidiaryId: p.subsidiaryId, subsidiaryName: p.subsidiaryName,
      currencyCode: p.currencyCode, amount, carryingBase, currentBase, deltaBase,
      rootType: p.rootType,
    });
  }

  const totalGain = lines.filter((l) => l.deltaBase > 0n).reduce((s, l) => s + l.deltaBase, 0n);
  const totalLoss = lines.filter((l) => l.deltaBase < 0n).reduce((s, l) => s - l.deltaBase, 0n);

  const existing = await tx.glEntry.findFirst({
    where: { sourceType: 'Revaluation', sourceId: asOf.toISOString().slice(0, 10), status: { not: 'REVERSED' } },
  });

  return { lines, totalGain, totalLoss, netBase: totalGain - totalLoss, alreadyPosted: !!existing };
}

/** نرخِ ضمنی که `toBase(amount, r, fd, bd)` را دقیقاً به `base` می‌رساند */
function impliedRate(base: Minor, amount: Minor, fd: number, bd: number): Rate {
  const a = base < 0n ? -base : base;
  const q = amount < 0n ? -amount : amount;
  if (q === 0n) return rateFrom(1);
  return { scaled: divRound(a * RATE_SCALE * 10n ** BigInt(fd), q * 10n ** BigInt(bd)) };
}

/**
 * ثبت تجدید ارزیابی ارزی.
 *
 * دو حالت (ممیزی ج۱۴):
 *
 *  • `temporary` (پیش‌فرض) — میان‌دوره. تعدیل به حساب‌های ۱۱۰۸/۲۱۱۱ می‌رود و
 *    **سند برگشت** در اولین روز دورهٔ بعد ثبت می‌شود. چرا برگشت اجباری است:
 *    بدون آن، وقتی همان تعهد بعداً تسویه شود `postSettlement` دوباره تسعیر محقق
 *    را حساب می‌کند و سود **دوبار** شمرده می‌شود.
 *
 *  • `permanent` — پایان سال (استاندارد ۱۶ ایران / IAS 21). نرخِ پایان سال
 *    **مبنای جدیدِ دائمی** می‌شود: هر موضع به نرخِ دفتریِ خودش بسته و به نرخِ
 *    پایان سال باز می‌شود (مبلغِ ارزی ثابت، مبلغِ پایه عوض). `carryingRate`
 *    خودش به نرخِ جدید می‌رسد، پس تسویهٔ سالِ بعد از همین‌جا اندازه می‌گیرد و
 *    دوبار شمردنی نیست ⇒ **بدون سند برگشت**.
 */
export async function postRevaluation(
  tx: Prisma.TransactionClient,
  input: {
    fiscalYearId: string; asOf: Date; overrideRates?: Record<string, Rate>;
    createdById?: string | null; force?: boolean;
    mode?: 'temporary' | 'permanent';
  },
) {
  const preview = await previewRevaluation(tx, input.asOf, input.overrideRates);
  const periodKey = input.asOf.toISOString().slice(0, 10);
  const mode = input.mode ?? 'temporary';

  if (preview.alreadyPosted && !input.force) {
    throw new FxError(`برای ${periodKey} قبلاً تجدید ارزیابی ثبت شده است`);
  }
  if (!preview.lines.length) {
    return { posted: false as const, preview };
  }

  const base = await baseCurrency(tx);

  // ── حالت دائمی: مبنای هر موضع به نرخِ پایان سال منتقل می‌شود، بدون برگشت ──
  if (mode === 'permanent') {
    const bd = base.decimalPlaces;
    const lines: DraftLine[] = [];
    // اثرِ خالصِ پایه روی موضع‌ها (با گرد کردنِ واقعیِ toBase) را جمع می‌زنیم تا
    // خطِ سود/زیان دقیقاً آن را خنثی کند — مثل پلاگِ توازنِ postSettlement.
    let positionBaseDelta = 0n;
    for (const l of preview.lines) {
      const fd = await decimalsOf(tx, l.currencyCode);
      const absAmt = l.amount < 0n ? -l.amount : l.amount;
      const oldRate = impliedRate(l.carryingBase, l.amount, fd, bd);
      const newRate = impliedRate(l.currentBase, l.amount, fd, bd);
      const oldBase = toBase(absAmt, oldRate, fd, bd);
      const newBase = toBase(absAmt, newRate, fd, bd);
      const common = { accountId: l.accountId, subsidiaryId: l.subsidiaryId, currencyCode: l.currencyCode };
      if (l.amount > 0n) {
        // دارایی: بستنِ مبنای قدیم (بستانکار)، بازکردن به نرخ نو (بدهکار)
        lines.push({ ...common, credit: absAmt, rate: oldRate, memo: `بستنِ مبنای قدیمِ ${l.code}` });
        lines.push({ ...common, debit: absAmt, rate: newRate, memo: `مبنای پایان سالِ ${l.code}` });
        positionBaseDelta += newBase - oldBase;
      } else {
        lines.push({ ...common, debit: absAmt, rate: oldRate, memo: `بستنِ مبنای قدیمِ ${l.code}` });
        lines.push({ ...common, credit: absAmt, rate: newRate, memo: `مبنای پایان سالِ ${l.code}` });
        positionBaseDelta -= newBase - oldBase;
      }
    }
    // توازن: خالصِ موضع‌ها + خطِ سود/زیان = ۰
    if (positionBaseDelta !== 0n) {
      const gain = positionBaseDelta;   // + دارایی‌ها بالا رفته / بدهی‌ها کم شده ⇒ سود
      const acc = await accountByCode(tx, gain > 0n ? FX_CODES.gainUnrealized : FX_CODES.lossUnrealized);
      lines.push({
        accountId: acc.id, currencyCode: base.code,
        ...(gain > 0n ? { credit: gain } : { debit: -gain }),
        memo: gain > 0n ? 'سود تسعیر پایان سال' : 'زیان تسعیر پایان سال',
      });
    }
    const adjustment = await post(tx, {
      fiscalYearId: input.fiscalYearId,
      date: input.asOf,
      description: `تجدید ارزیابی ارزی پایان سالِ ${periodKey} (دائمی)`,
      entryType: 'ADJUSTING',
      sourceType: 'Revaluation',
      sourceId: periodKey,
      createdById: input.createdById ?? null,
      lines,
    });
    return { posted: true as const, mode, preview, adjustment, reversal: null, net: positionBaseDelta };
  }

  const assetAdj = await accountByCode(tx, FX_CODES.assetAdjustment);
  const liabAdj = await accountByCode(tx, FX_CODES.liabilityAdjustment);

  let assetDelta = 0n;
  let liabDelta = 0n;
  for (const l of preview.lines) {
    if (l.rootType === 'ASSET') assetDelta += l.deltaBase;
    else liabDelta += l.deltaBase;
  }
  // دارایی: delta مثبت ⇒ ارزش بالا رفته ⇒ سود.
  // بدهی: ماندهٔ خام منفی است؛ delta مثبت یعنی بدهی (به عدد مطلق) کوچک‌تر شده ⇒ سود.
  const net = assetDelta + liabDelta;

  const fxAcc = await accountByCode(tx, net > 0n ? FX_CODES.gainUnrealized : FX_CODES.lossUnrealized);

  const buildLines = (reverse: boolean): DraftLine[] => {
    const s = reverse ? -1n : 1n;
    const out: DraftLine[] = [];
    const push = (accountId: string, amount: Minor, memo: string) => {
      if (amount === 0n) return;
      out.push({
        accountId, currencyCode: base.code,
        ...(amount > 0n ? { debit: amount } : { credit: -amount }),
        memo,
      });
    };

    push(assetAdj.id, assetDelta * s, 'تعدیل ارزش پایهٔ دارایی‌های ارزی');
    push(liabAdj.id, liabDelta * s, 'تعدیل ارزش پایهٔ بدهی‌های ارزی');

    // ⚠️ حساب سود/زیان از علامتِ **اصلی** انتخاب می‌شود، نه از مقدار معکوس‌شده.
    // اگر بر اساس علامت معکوس انتخاب شود، سند برگشت به حساب مقابل می‌خورد:
    // تعدیل «سود» را بستانکار می‌کند و برگشت «زیان» را بدهکار. خالص درست
    // درمی‌آید ولی صورت سود و زیان با دو قلم قرینهٔ جعلی آلوده می‌شود.
    // همین باگ یک بار در هستهٔ قدیمی رخ داد و در tests/proven/04 قفل شده.
    push(fxAcc.id, -net * s, net > 0n ? 'سود تسعیر تحقق‌نیافته' : 'زیان تسعیر تحقق‌نیافته');
    return out;
  };

  const adjustment = await post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.asOf,
    description: `تجدید ارزیابی ارزی پایان دورهٔ ${periodKey}`,
    entryType: 'ADJUSTING',
    sourceType: 'Revaluation',
    sourceId: periodKey,
    createdById: input.createdById ?? null,
    lines: buildLines(false),
  });

  // برگشت در اولین روز دورهٔ بعد
  const reversalDate = new Date(input.asOf);
  reversalDate.setUTCDate(reversalDate.getUTCDate() + 1);

  const fy = await tx.glFiscalYear.findFirst({
    where: { startDate: { lte: reversalDate }, endDate: { gte: reversalDate } },
  });
  if (!fy) {
    throw new FxError(
      `تاریخ برگشت (${reversalDate.toISOString().slice(0, 10)}) در هیچ سال مالی‌ای نیست. ` +
      'برای تجدید ارزیابی پایان سال، ابتدا سال مالی بعد را تعریف کنید.',
    );
  }

  const reversal = await post(tx, {
    fiscalYearId: fy.id,
    date: reversalDate,
    description: `برگشت تجدید ارزیابی ${periodKey}`,
    entryType: 'REVERSING',
    sourceType: 'Revaluation',
    sourceId: `${periodKey}-reversal`,
    createdById: input.createdById ?? null,
    lines: buildLines(true),
  });

  return { posted: true as const, preview, adjustment, reversal, assetDelta, liabDelta, net };
}
