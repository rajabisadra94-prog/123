/**
 * ذخیرهٔ مطالبات مشکوک‌الوصول — مرحلهٔ ۴ د.
 *
 * سن‌بندی می‌گفت «۹۰ میلیارد بیش از ۹۰ روز معوق است» و همان‌جا تمام می‌شد.
 * ولی اصل تطابق می‌گوید زیانِ آن مطالبات مربوط به **دورهٔ فروش** است، نه دورهٔ
 * سوخت شدن؛ پس باید همین حالا برآورد و شناسایی شود.
 *
 * ─── سه تصمیم ──────────────────────────────────────────────────
 *
 * ۱) **حسابِ کاهندهٔ جدا (۱۱۰۴ دست‌نخورده).** ذخیره روی «۱۱۱۰ ذخیرهٔ مطالبات
 *    مشکوک‌الوصول» می‌نشیند نه روی خودِ دریافتنی. طلبِ حقوقیِ ما از مشتری
 *    عوض نشده — ذخیره یک **برآورد** است. اگر از ۱۱۰۴ کم می‌شد، پروندهٔ
 *    طرف‌حساب می‌گفت کمتر طلبکاریم و کسی دیگر پیگیرِ وصولش نمی‌شد.
 *
 * ۲) **روشِ مانده، نه روشِ هزینه.** ذخیرهٔ مطلوب برای کلِ مانده حساب می‌شود و
 *    سند فقط **تفاوتِ** آن با ذخیرهٔ موجود را می‌زند. اگر هر بار کلِ برآورد
 *    را هزینه می‌کردیم، اجرای دوبارهٔ گزارش در یک ماه ذخیره را دو برابر
 *    می‌کرد — و اجرای ماهانه، دوازده برابر.
 *
 * ۳) **درصدها تنظیمی‌اند، با پیش‌فرضِ محافظه‌کارانه.** هیچ درصدی «درست» نیست؛
 *    به صنعت و تجربهٔ وصول بستگی دارد. ولی پیش‌فرضِ نداشته هم بی‌معنی است، پس
 *    از یک نردبانِ متعارف شروع می‌شود و در تنظیمات قابل تغییر است.
 */
import { Prisma } from '@prisma/client';
import { aging, AGING_BUCKETS, type AgingBucket } from './reports/statements';
import { post } from './poster';

export class ProvisionError extends Error {}

/** حسابِ کاهندهٔ دارایی و طرفِ هزینه‌ایِ آن */
export const ALLOWANCE_CODE = '1110';
export const BAD_DEBT_EXPENSE_CODE = '6204';
export const PROVISION_SOURCE = 'Provision';

/** کلید تنظیمات — درصدها به **هزارم** ذخیره می‌شوند تا اعشار لازم نشود */
export const PROVISION_SETTING_KEY = 'GL_PROVISION_RATES';

/**
 * نردبانِ پیش‌فرض، به هزارم: تازه صفر، و هرچه کهنه‌تر سنگین‌تر.
 *
 * تا ۳۰ روز صفر است چون هنوز سررسید نگذشته و ذخیره گرفتن برایش یعنی
 * بدبینی به هر فروشی — نه محافظه‌کاری.
 */
export const DEFAULT_RATES: Record<AgingBucket, number> = {
  '0-30': 0,
  '31-60': 50,     // ۵٪
  '61-90': 150,    // ۱۵٪
  '90+': 500,      // ۵۰٪
};

export async function getRates(tx: Prisma.TransactionClient): Promise<Record<AgingBucket, number>> {
  const row = await tx.systemSetting.findUnique({ where: { key: PROVISION_SETTING_KEY } });
  if (!row) return { ...DEFAULT_RATES };
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    const out = { ...DEFAULT_RATES };
    for (const b of AGING_BUCKETS) {
      const v = Number(parsed[b.key]);
      // مقدارِ خراب در تنظیمات نباید گزارش را بیندازد؛ پیش‌فرض جایش می‌نشیند
      if (Number.isFinite(v) && v >= 0 && v <= 1000) out[b.key] = Math.round(v);
    }
    return out;
  } catch {
    return { ...DEFAULT_RATES };
  }
}

export async function setRates(
  tx: Prisma.TransactionClient, rates: Record<string, number>,
) {
  const clean: Record<string, number> = {};
  for (const b of AGING_BUCKETS) {
    const v = Number(rates[b.key]);
    if (!Number.isFinite(v) || v < 0 || v > 1000) {
      throw new ProvisionError(`درصد سطل «${b.label}» باید عددی بین ۰ تا ۱۰۰۰ هزارم باشد`);
    }
    clean[b.key] = Math.round(v);
  }
  await tx.systemSetting.upsert({
    where: { key: PROVISION_SETTING_KEY },
    update: { value: JSON.stringify(clean) },
    create: { key: PROVISION_SETTING_KEY, value: JSON.stringify(clean) },
  });
  return clean;
}

export interface ProvisionLine {
  bucket: AgingBucket;
  label: string;
  /** ماندهٔ باز آن سطل، به ارز پایه (خالصِ بدهکار و بستانکار) */
  balance: string;
  /** پایهٔ ذخیره — فقط ماندهٔ بدهکارِ طرف‌حساب‌ها (ممیزی ن۸) */
  receivable: string;
  /** درصد به هزارم */
  rate: number;
  /** ذخیرهٔ مطلوبِ همان سطل */
  required: string;
}

/**
 * برآورد ذخیره در یک تاریخ — **بدون** ثبت سند.
 *
 * `delta` همان چیزی است که سند خواهد زد: مثبت یعنی ذخیره باید بالا برود
 * (هزینه شناسایی شود)، منفی یعنی وصولی‌ها بهتر از برآورد بوده و ذخیره
 * برمی‌گردد.
 */
export async function computeProvision(
  tx: Prisma.TransactionClient,
  asOf: Date,
  accountCode = '1104',
) {
  const rates = await getRates(tx);
  const age = await aging(tx, accountCode, asOf);

  const lines: ProvisionLine[] = AGING_BUCKETS.map((b) => {
    const balance = age.bucketTotals[b.key];
    /**
     * ⚠️ ممیزی دور چهارم (ن۸) — پایه، جمعِ ماندهٔ بدهکارِ **هر طرف‌حساب** است.
     *
     * پیش‌تر اینجا `balance > 0n ? balance : 0n` بود، یعنی محافظ روی **جمعِ
     * سطل** اجرا می‌شد. اما جمعِ سطل، مثبت و منفی را از قبل خنثی کرده بود؛
     * پس پیش‌دریافتِ یک مشتری، ذخیرهٔ طلبِ مشکوکِ مشتری دیگر را کم می‌کرد.
     * `bucketReceivable` منفی‌ها را طرف‌حساب‌به‌طرف‌حساب کنار می‌گذارد.
     */
    const base = age.bucketReceivable[b.key];
    return {
      bucket: b.key, label: b.label,
      balance: balance.toString(),
      /** پایهٔ ذخیره — بدون ماندهٔ بستانکارِ طرف‌حساب‌ها */
      receivable: base.toString(),
      rate: rates[b.key],
      required: ((base * BigInt(rates[b.key])) / 1000n).toString(),
    };
  });

  const required = lines.reduce((s, l) => s + BigInt(l.required), 0n);

  // ماندهٔ ذخیرهٔ فعلی — ماهیتِ بستانکار، پس علامت برمی‌گردد
  const [cur] = await tx.$queryRaw<{ amount: bigint | null }[]>`
    SELECT (SUM(l."creditBase") - SUM(l."debitBase"))::bigint AS amount
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE a.code = ${ALLOWANCE_CODE}
      AND e.status <> 'DRAFT' AND e.date <= ${asOf}
  `;
  const existing = BigInt(cur?.amount ?? 0n);

  return {
    asOf, accountCode, rates, lines,
    required: required.toString(),
    existing: existing.toString(),
    /** مثبت = افزایش ذخیره (هزینه) · منفی = برگشت ذخیره */
    delta: (required - existing).toString(),
    receivableTotal: age.grandTotalBase.toString(),
    /** ذخیره چند درصدِ کلِ مطالبات است — عددی که مدیر مالی اول نگاه می‌کند */
    coverageRate: age.grandTotalBase === 0n
      ? null
      : Number((required * 1000n) / age.grandTotalBase),
  };
}

/**
 * ثبت سندِ تعدیلِ ذخیره.
 *
 * فقط **تفاوت** ثبت می‌شود (روشِ مانده). اگر تفاوت صفر باشد سندی زده
 * نمی‌شود و همین برمی‌گردد — سندِ صفرْ دفتر را شلوغ می‌کند و ممیزیِ بعدی را
 * گمراه (همان درسی که در ن۶ گرفتیم).
 */
export async function postProvision(
  tx: Prisma.TransactionClient,
  input: { fiscalYearId: string; asOf: Date; accountCode?: string; createdById?: string | null },
) {
  const calc = await computeProvision(tx, input.asOf, input.accountCode ?? '1104');
  const delta = BigInt(calc.delta);

  if (delta === 0n) {
    return { posted: false as const, reason: 'ذخیرهٔ موجود با برآورد برابر است', calc };
  }

  const allowance = await tx.glAccount.findUnique({ where: { code: ALLOWANCE_CODE } });
  const expense = await tx.glAccount.findUnique({ where: { code: BAD_DEBT_EXPENSE_CODE } });
  if (!allowance || !expense) {
    throw new ProvisionError(
      `حساب‌های ${ALLOWANCE_CODE} و ${BAD_DEBT_EXPENSE_CODE} در چارت نیستند`);
  }

  const abs = delta > 0n ? delta : -delta;
  const increasing = delta > 0n;

  const entry = await post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.asOf,
    description: increasing
      ? `ذخیرهٔ مطالبات مشکوک‌الوصول — افزایش به ${calc.required}`
      : `برگشت ذخیرهٔ مطالبات مشکوک‌الوصول — کاهش به ${calc.required}`,
    entryType: 'ADJUSTING',
    sourceType: PROVISION_SOURCE,
    createdById: input.createdById ?? null,
    lines: increasing
      ? [
        { accountId: expense.id, currencyCode: 'IRR', debit: abs },
        { accountId: allowance.id, currencyCode: 'IRR', credit: abs },
      ]
      : [
        { accountId: allowance.id, currencyCode: 'IRR', debit: abs },
        { accountId: expense.id, currencyCode: 'IRR', credit: abs },
      ],
  });

  return { posted: true as const, entry, calc };
}
