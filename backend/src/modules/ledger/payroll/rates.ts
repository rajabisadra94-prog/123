/**
 * نرخ‌های قانونی حقوق — نسخه‌دار (docs/ACCOUNTING_SPEC.md بند ۳-۶)
 *
 * **هیچ نرخی در کد نیست.** همه از جدول `GlPayrollRate` با بازهٔ اعتبار خوانده
 * می‌شوند. محاسبهٔ هر دوره با نرخ معتبر **همان دوره** انجام می‌شود، نه نرخ جاری.
 *
 * چرا این حیاتی است: بدون آن، بازمحاسبهٔ فروردین در آبان نتیجهٔ متفاوت می‌دهد و
 * اصلاح لیست قدیمی غیرممکن می‌شود. با آن، هر بازمحاسبه‌ای همان عدد قبلی را
 * برمی‌گرداند — مهم نیست کِی اجرا شود.
 */
import { Prisma } from '@prisma/client';

export class PayrollRateError extends Error {}

/**
 * کلیدهای نرخ.
 *
 * ثابت‌بودن **کلید** با هاردکد کردن **مقدار** فرق دارد: کلید نام یک مفهوم است،
 * مقدارش هر سال عوض می‌شود و در دیتابیس می‌نشیند.
 */
export const RATE_KEYS = {
  /** حداقل دستمزد روزانه */
  MIN_WAGE_DAILY: 'MIN_WAGE_DAILY',
  /** حق مسکن ماهانه */
  HOUSING_MONTHLY: 'HOUSING_MONTHLY',
  /** بن کارگری ماهانه */
  FOOD_MONTHLY: 'FOOD_MONTHLY',
  /** حق اولاد به‌ازای هر فرزند */
  CHILD_PER_CHILD: 'CHILD_PER_CHILD',
  /** پایهٔ سنوات روزانه */
  SENIORITY_DAILY: 'SENIORITY_DAILY',

  /** سهم بیمهٔ کارگر (نسبت، مثلاً ۰٫۰۷) */
  INSURANCE_EMPLOYEE: 'INSURANCE_EMPLOYEE',
  /** سهم بیمهٔ کارفرما */
  INSURANCE_EMPLOYER: 'INSURANCE_EMPLOYER',
  /** بیمهٔ بیکاری (سهم کارفرما) */
  UNEMPLOYMENT: 'UNEMPLOYMENT',
  /** سقف ماهانهٔ مشمول بیمه؛ صفر یعنی بی‌سقف */
  INSURANCE_CEILING: 'INSURANCE_CEILING',

  /** ضریب اضافه‌کاری (مثلاً ۱٫۴) */
  OVERTIME_FACTOR: 'OVERTIME_FACTOR',
  /** ضریب شب‌کاری */
  NIGHT_FACTOR: 'NIGHT_FACTOR',
  /** ضریب جمعه‌کاری و تعطیل */
  HOLIDAY_FACTOR: 'HOLIDAY_FACTOR',

  /** معافیت ماهانهٔ مالیات حقوق */
  TAX_EXEMPTION_MONTHLY: 'TAX_EXEMPTION_MONTHLY',

  /** ذخیرهٔ عیدی: ضریب ماهانه از حقوق (دو ماه در سال ⇒ ۲/۱۲) */
  BONUS_ACCRUAL_FACTOR: 'BONUS_ACCRUAL_FACTOR',
  /** ذخیرهٔ سنوات: روز به‌ازای هر ماه (۳۰ روز در سال ⇒ ۲٫۵) */
  SEVERANCE_DAYS_PER_MONTH: 'SEVERANCE_DAYS_PER_MONTH',
  /** ذخیرهٔ مرخصی: روز به‌ازای هر ماه */
  LEAVE_DAYS_PER_MONTH: 'LEAVE_DAYS_PER_MONTH',

  /** روزهای کاری ماه (مبنای محاسبهٔ نسبت) */
  MONTH_DAYS: 'MONTH_DAYS',
  /** ساعات کاری ماه (مبنای نرخ ساعتی) */
  MONTH_HOURS: 'MONTH_HOURS',
} as const;

/**
 * کلیدهای **اختیاری** — ضرایبِ متنِ قانون‌اند (نه نرخِ سالانهٔ وزارت کار)، پس
 * پیش‌فرضِ امنِ قانونی دارند و نبودشان `resolveRates` را رد نمی‌کند. اگر شرکتی
 * سیاستِ متفاوتی دارد (مثلاً حق مسکن را هم جزو پایهٔ عیدی حساب می‌کند)، همین
 * کلید را در جدولِ نرخ تعریف می‌کند و پیش‌فرض کنار می‌رود.
 */
export const OPTIONAL_RATE_KEYS = {
  /** پایهٔ محاسبهٔ عیدی: 0 = مزد + پایهٔ سنوات، 1 = + حق مسکن و بن (ممیزی ج۱۷) */
  BONUS_INCLUDE_ALLOWANCES: 'BONUS_INCLUDE_ALLOWANCES',
  /** سقفِ عیدیِ سالانه به روزِ حداقل‌دستمزد — قانونِ عیدی: ۹۰ روز (ممیزی ج۱۷) */
  BONUS_CAP_DAYS: 'BONUS_CAP_DAYS',
} as const;

/** پیش‌فرضِ کلیدهای اختیاری — مطابقِ متنِ «قانون مربوط به تعیین عیدی و پاداش سالانهٔ کارگران» */
export const OPTIONAL_RATE_DEFAULTS: Record<string, number> = {
  BONUS_INCLUDE_ALLOWANCES: 0,
  BONUS_CAP_DAYS: 90,
};

export type RateKey =
  | (typeof RATE_KEYS)[keyof typeof RATE_KEYS]
  | (typeof OPTIONAL_RATE_KEYS)[keyof typeof OPTIONAL_RATE_KEYS];

/** نرخ‌های حل‌شده برای یک تاریخ مشخص — ورودیِ موتور محاسبه */
export interface ResolvedRates {
  at: Date;
  values: Record<RateKey, number>;
  brackets: { from: bigint; to: bigint | null; rate: number }[];
}

/**
 * همهٔ نرخ‌های معتبر در یک تاریخ.
 *
 * اگر نرخی برای آن تاریخ تعریف نشده باشد **خطا می‌دهد** — پیش‌فرض نمی‌گذارد.
 * نرخ حدسی در لیست حقوق یعنی مبلغی که به کارمند پرداخت می‌شود اشتباه است.
 */
export async function resolveRates(tx: Prisma.TransactionClient, at: Date): Promise<ResolvedRates> {
  const rows = await tx.glPayrollRate.findMany({
    where: {
      validFrom: { lte: at },
      OR: [{ validTo: null }, { validTo: { gte: at } }],
    },
    orderBy: { validFrom: 'desc' },
  });

  const values = {} as Record<RateKey, number>;
  for (const r of rows) {
    // اولین مقدار (تازه‌ترین validFrom) برنده است
    if (!(r.key in values)) values[r.key as RateKey] = Number(r.value);
  }

  const missing = Object.values(RATE_KEYS).filter((k) => !(k in values));
  if (missing.length) {
    throw new PayrollRateError(
      `نرخ‌های زیر برای تاریخ ${at.toISOString().slice(0, 10)} تعریف نشده‌اند: ${missing.join('، ')}`,
    );
  }

  // کلیدهای اختیاری: اگر تعریف نشده‌اند، پیش‌فرضِ قانونی
  for (const k of Object.values(OPTIONAL_RATE_KEYS)) {
    if (!(k in values)) values[k] = OPTIONAL_RATE_DEFAULTS[k];
  }

  const bracketRows = await tx.glPayrollTaxBracket.findMany({
    where: {
      validFrom: { lte: at },
      OR: [{ validTo: null }, { validTo: { gte: at } }],
    },
    orderBy: [{ validFrom: 'desc' }, { fromAmount: 'asc' }],
  });
  if (!bracketRows.length) {
    throw new PayrollRateError(`پلکان مالیات برای تاریخ ${at.toISOString().slice(0, 10)} تعریف نشده است`);
  }

  /**
   * ⚠️ ممیزی ب۴ — فقط پلکانِ **یک** نسخه برداشته می‌شود.
   *
   * پیش‌تر همهٔ ردیف‌های معتبر برمی‌گشتند و `progressiveTax` روی همه‌شان جمع
   * می‌زد. اگر دو مجموعهٔ هم‌پوشان در جدول بود — که روی staging دقیقاً همین
   * بود، دو مجموعهٔ یکسان با همان `validFrom` — مالیات **دقیقاً دو برابر**
   * محاسبه می‌شد و لیست حقوق با همان عدد نهایی و در دفتر ثبت می‌شد.
   *
   * همان قاعده‌ای که بالا برای مقادیر نرخ هست («تازه‌ترین برنده است») حالا
   * برای پلکان هم اعمال می‌شود: تازه‌ترین `validFrom` انتخاب و بقیه کنار
   * گذاشته می‌شوند.
   */
  const newest = bracketRows[0].validFrom.getTime();
  const seen = new Set<string>();
  const brackets = bracketRows
    .filter((b) => b.validFrom.getTime() === newest)
    .map((b) => ({ from: b.fromAmount, to: b.toAmount, rate: Number(b.rate) }))
    // پلهٔ **کاملاً یکسان** بی‌ابهام است و بی‌صدا یکی می‌شود؛ بازهٔ واقعاً
    // هم‌پوشان (با نرخ یا مرز متفاوت) پایین‌تر خطا می‌گیرد.
    .filter((b) => {
      const k = `${b.from}|${b.to ?? '∞'}|${b.rate}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));

  assertNoOverlap(brackets, at);

  return { at, values, brackets };
}

/**
 * پلکان باید بازه‌های جدا از هم و مرتب باشد.
 *
 * حتی با انتخاب تک‌نسخه، دادهٔ خراب می‌تواند بازه‌های هم‌پوشان بسازد؛ چون
 * `progressiveTax` برش‌ها را جمع می‌زند، هم‌پوشانی یعنی مالیات مضاعف. اینجا
 * صریح خطا می‌دهیم به‌جای اینکه بی‌صدا عدد غلط از آب دربیاید.
 */
function assertNoOverlap(
  brackets: { from: bigint; to: bigint | null; rate: number }[],
  at: Date,
): void {
  for (let i = 1; i < brackets.length; i++) {
    const prev = brackets[i - 1];
    const cur = brackets[i];
    if (prev.to === null || cur.from < prev.to) {
      throw new PayrollRateError(
        `پلکان مالیات برای تاریخ ${at.toISOString().slice(0, 10)} هم‌پوشانی دارد `
        + `(پلهٔ «از ${cur.from}» با پلهٔ قبلی). تا اصلاح نشود لیست حقوق ساخته نمی‌شود.`,
      );
    }
  }
}

/** ثبت یک نرخ با بازهٔ اعتبار */
export async function setRate(
  tx: Prisma.TransactionClient,
  input: { key: RateKey; value: number | string; validFrom: Date; validTo?: Date | null; note?: string },
) {
  return tx.glPayrollRate.create({
    data: {
      key: input.key,
      value: new Prisma.Decimal(input.value),
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      note: input.note ?? null,
    },
  });
}

export async function setTaxBrackets(
  tx: Prisma.TransactionClient,
  validFrom: Date,
  brackets: { from: bigint; to: bigint | null; rate: number }[],
  validTo?: Date | null,
) {
  for (const b of brackets) {
    await tx.glPayrollTaxBracket.create({
      data: {
        fromAmount: b.from, toAmount: b.to,
        rate: new Prisma.Decimal(b.rate),
        validFrom, validTo: validTo ?? null,
      },
    });
  }
}
