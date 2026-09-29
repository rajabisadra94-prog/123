/**
 * گزارش‌های قانونی: فصلی ماده ۱۶۹ و اظهارنامهٔ ارزش افزوده — مرحلهٔ ۴.
 *
 * تا امروز هیچ‌کدام از سامانه درنمی‌آمد و باید دستی از اکسل ساخته می‌شد.
 *
 * ─── تصمیمِ ساختاریِ اصلی: طرف‌حساب کجاست؟ ───────────────────────
 *
 * ردیف‌های سود و زیانی در این سامانه **تفصیلی ندارند** — روی دادهٔ واقعی
 * صفر از ۵۰۸ ردیفِ درآمد و هزینه `subsidiaryId` داشت. این عیب نیست، ساختار
 * درست است: تفصیلی روی معینِ کنترلیِ همان سند می‌نشیند
 * (۱۱۰۴ دریافتنی / ۲۱۰۱ پرداختنی)، نه روی حساب فروش.
 *
 * پس «فروش به مشتری الف» از **سند** خوانده می‌شود نه از ردیف: طرف‌حسابِ سند
 * از ردیف‌های کنترلی، و مبلغِ فروش از ردیف‌های درآمدی.
 *
 * ─── قاعدهٔ وضعیتِ سند ──────────────────────────────────────────
 *
 * `status <> 'DRAFT'` و نه `status = 'POSTED'`: سند باطل‌شده و برگشتی‌اش باید
 * هر دو بیایند تا همدیگر را خنثی کنند. گرفتنِ فقط `POSTED` آینه را نگه
 * می‌دارد و اصل را می‌اندازد.
 *
 * ─── و تصمیمِ سختِ دوم: سندِ چندطرف‌حسابی ────────────────────────
 *
 * اگر یک سند دو طرف‌حساب داشته باشد، سهم هرکدام از فروش معلوم نیست. سه راه
 * بود: تقسیم به نسبتِ مانده (حدس)، انتساب به اولی (غلط)، یا کنار گذاشتن و
 * **گزارش کردنِ همان کنار گذاشتن**. سومی انتخاب شد. گزارشِ مالیاتی جایی
 * نیست که حدس بزنی؛ حسابدار باید بداند کدام سند دستی لازم دارد.
 */
import { Prisma } from '@prisma/client';

export class TaxReportError extends Error {}

/** معین‌های کنترلیِ طرف‌حساب — همان‌جایی که تفصیلی می‌نشیند */
const CONTROL_CODES = ['1104', '2101'];
/** ارزش افزودهٔ فروش (بستانکار) و خرید (بدهکار) */
export const VAT_OUTPUT = '2107';
export const VAT_INPUT = '1109';

/**
 * نرخ قانونی مالیات بر ارزش افزوده — درصد.
 *
 * برای استخراج **پایهٔ مشمول** از خود مالیات لازم است؛ به مبلغِ مالیات دست
 * نمی‌زند (آن همیشه از حرکات واقعی حساب خوانده می‌شود).
 */
export const VAT_PERCENT = 10n;

/**
 * پایهٔ مشمول یک سند، از روی مالیاتِ همان سند.
 *
 * ⚠️ ممیزی ب۷ — چرا از جمعِ درآمدِ سند استفاده نمی‌کنیم.
 *
 * پیش‌تر منطق این بود: «اگر سند ارزش افزوده دارد، کل درآمدش مشمول است.»
 * اما یک سند می‌تواند هم فروش داخلیِ مشمول داشته باشد و هم فروش صادراتیِ
 * معاف — که برای شرکتی با صادرات به عراق حالت **عادی** است نه استثنا.
 * نتیجه‌اش این بود که ۵ میلیارد فروش صادراتیِ نرخ‌صفر در پایهٔ مشمول
 * می‌نشست و اظهارنامه نرخ ضمنیِ ۵٫۸٪ نشان می‌داد — عددی که در ممیزی
 * مالیاتی بلافاصله سؤال می‌سازد.
 *
 * حالا پایه از خودِ مالیات مشتق می‌شود: `پایه = مالیات ÷ نرخ`. این عدد
 * ذاتاً با مالیاتِ اعلامی سازگار است، هرچه ترکیب فروشِ سند باشد.
 */
const taxableFromVat = (vat: bigint): bigint => (vat * 100n) / VAT_PERCENT;

export const PERSON_TYPE_FA: Record<string, string> = {
  LEGAL: 'شخص حقوقی', NATURAL: 'شخص حقیقی',
  PARTNERSHIP: 'مشارکت مدنی', FOREIGN: 'اتباع خارجی',
  CONSUMER: 'مصرف‌کنندهٔ نهایی',
};

/** طول شناسه‌ای که سازمان امور مالیاتی برای هر نوع شخص می‌خواهد */
const ID_LENGTH: Record<string, number> = { LEGAL: 11, NATURAL: 10 };

// ───────────────────────────────────────────────────────────────
// گزارش فصلی ماده ۱۶۹
// ───────────────────────────────────────────────────────────────

export interface Article169Row {
  subsidiaryId: string;
  code: string;
  name: string;
  kind: string;
  taxPersonType: string | null;
  nationalId: string | null;
  economicCode: string | null;
  /** جمع فروش به این طرف‌حساب، بدون ارزش افزوده، به ارز پایه */
  sales: string;
  salesVat: string;
  salesCount: number;
  /** جمع خرید از این طرف‌حساب، بدون ارزش افزوده */
  purchases: string;
  purchasesVat: string;
  purchasesCount: number;
  /** چرا این ردیف هنوز قابل ارسال نیست */
  problems: string[];
}

interface EntryFacts {
  entryId: string;
  serial: number | null;
  date: Date;
  description: string;
  parties: string[];
  income: bigint;
  expense: bigint;
  vatOut: bigint;
  vatIn: bigint;
}

/**
 * حقایقِ هر سند در بازه: طرف‌حساب‌هایش، درآمد، هزینه و ارزش افزوده‌اش.
 *
 * یک کوئری برای همهٔ ردیف‌ها و تجمیع در حافظه — نه چهار کوئری جدا. تعداد
 * اسنادِ یک فصل در حدی نیست که ارزش پیچیده‌ترکردنِ SQL را داشته باشد.
 */
async function entryFacts(tx: Prisma.TransactionClient, from: Date, to: Date) {
  const lines = await tx.$queryRaw<{
    entryId: string; serial: number | null; date: Date; description: string;
    code: string; rootType: string; subsidiaryId: string | null;
    debitBase: bigint; creditBase: bigint;
  }[]>`
    SELECT e.id AS "entryId", e.serial, e.date, e.description,
           a.code, a."rootType", l."subsidiaryId",
           l."debitBase", l."creditBase"
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'DRAFT'
      AND e.date >= ${from} AND e.date <= ${to}
      AND e."sourceType" IS DISTINCT FROM 'YearClose'
    ORDER BY e.date, e.serial
  `;

  const map = new Map<string, EntryFacts>();
  for (const l of lines) {
    const f = map.get(l.entryId) ?? {
      entryId: l.entryId, serial: l.serial, date: l.date, description: l.description,
      parties: [] as string[], income: 0n, expense: 0n, vatOut: 0n, vatIn: 0n,
    };
    map.set(l.entryId, f);

    if (l.subsidiaryId && CONTROL_CODES.some((c) => l.code.startsWith(c))
        && !f.parties.includes(l.subsidiaryId)) {
      f.parties.push(l.subsidiaryId);
    }
    if (l.code === VAT_OUTPUT) f.vatOut += BigInt(l.creditBase) - BigInt(l.debitBase);
    else if (l.code === VAT_INPUT) f.vatIn += BigInt(l.debitBase) - BigInt(l.creditBase);
    else if (isOperating(l.code, 'INCOME', l.rootType)) f.income += BigInt(l.creditBase) - BigInt(l.debitBase);
    else if (isOperating(l.code, 'EXPENSE', l.rootType)) f.expense += BigInt(l.debitBase) - BigInt(l.creditBase);
  }
  return [...map.values()];
}

/**
 * فقط درآمد و هزینهٔ **عملیاتی** برای گزارش‌های مالیاتی به حساب می‌آید.
 *
 * ریشهٔ ۸ «درآمدها و هزینه‌های غیرعملیاتی» است — سود و زیان تسعیر ارز آنجا
 * می‌نشیند و `rootType`ش هم INCOME/EXPENSE است. بدون این فیلتر، سود تسعیرِ
 * یک سندِ تسویه به‌عنوان «فروش به طرف‌حساب» در فهرست معاملات فصلی می‌نشست.
 * معاملهٔ مشمولِ ماده ۱۶۹ و ارزش افزوده، خرید و فروش است — نه نوسان نرخ ارز.
 */
const isOperating = (code: string, want: 'INCOME' | 'EXPENSE', rootType: string): boolean =>
  rootType === want && !code.startsWith('8');

export async function article169(
  tx: Prisma.TransactionClient,
  input: { from: Date; to: Date },
) {
  const facts = await entryFacts(tx, input.from, input.to);

  type Acc = { sales: bigint; salesVat: bigint; salesCount: number;
               purchases: bigint; purchasesVat: bigint; purchasesCount: number };
  const mk = (): Acc => ({ sales: 0n, salesVat: 0n, salesCount: 0,
                           purchases: 0n, purchasesVat: 0n, purchasesCount: 0 });
  const byParty = new Map<string, Acc>();

  /** سندهایی که به یک طرف‌حساب منتسب نشدند — با دلیل، تا حسابدار بداند چه کند */
  const unattributed: {
    serial: number | null; date: Date; description: string;
    amount: string; reason: string;
  }[] = [];

  for (const f of facts) {
    const value = f.income + f.expense;
    if (value === 0n && f.vatOut === 0n && f.vatIn === 0n) continue;

    if (f.parties.length !== 1) {
      unattributed.push({
        serial: f.serial, date: f.date, description: f.description,
        amount: value.toString(),
        reason: f.parties.length === 0
          ? 'هیچ طرف‌حسابی روی معین کنترلی ندارد'
          : `${f.parties.length} طرف‌حساب دارد — سهم هرکدام معلوم نیست`,
      });
      continue;
    }

    const acc = byParty.get(f.parties[0]) ?? mk();
    byParty.set(f.parties[0], acc);
    if (f.income > 0n) { acc.sales += f.income; acc.salesVat += f.vatOut; acc.salesCount++; }
    if (f.expense > 0n) { acc.purchases += f.expense; acc.purchasesVat += f.vatIn; acc.purchasesCount++; }
  }

  const subs = byParty.size
    ? await tx.glSubsidiary.findMany({ where: { id: { in: [...byParty.keys()] } } })
    : [];

  const rows: Article169Row[] = subs.map((s) => {
    const a = byParty.get(s.id)!;
    return {
      subsidiaryId: s.id, code: s.code, name: s.name, kind: s.kind,
      taxPersonType: s.taxPersonType, nationalId: s.nationalId, economicCode: s.economicCode,
      sales: a.sales.toString(), salesVat: a.salesVat.toString(), salesCount: a.salesCount,
      purchases: a.purchases.toString(), purchasesVat: a.purchasesVat.toString(),
      purchasesCount: a.purchasesCount,
      problems: readinessProblems(s),
    };
  }).sort((x, y) =>
    (BigInt(y.sales) + BigInt(y.purchases)) > (BigInt(x.sales) + BigInt(x.purchases)) ? 1 : -1);

  const sum = (f: (r: Article169Row) => string) =>
    rows.reduce((s, r) => s + BigInt(f(r)), 0n).toString();

  return {
    from: input.from, to: input.to, rows,
    totals: {
      sales: sum((r) => r.sales), salesVat: sum((r) => r.salesVat),
      purchases: sum((r) => r.purchases), purchasesVat: sum((r) => r.purchasesVat),
    },
    unattributed,
    /** تعداد ردیف‌هایی که هنوز اطلاعات هویتی‌شان ناقص است */
    notReady: rows.filter((r) => r.problems.length > 0).length,
  };
}

/**
 * چرا این طرف‌حساب هنوز قابل ارسال نیست.
 *
 * پیام‌ها عمداً عملیاتی‌اند: «شناسهٔ ملی ثبت نشده» کاری است که می‌شود کرد،
 * برخلاف یک تیکِ قرمزِ بی‌توضیح.
 */
export function readinessProblems(s: {
  taxPersonType: string | null; nationalId: string | null; economicCode: string | null;
}): string[] {
  const out: string[] = [];
  if (!s.taxPersonType) {
    out.push('نوع شخص (حقیقی/حقوقی) مشخص نشده');
    return out;   // بدون نوع شخص، دربارهٔ طول شناسه نمی‌شود قضاوت کرد
  }
  // مصرف‌کنندهٔ نهایی شناسه ندارد و همین درست است
  if (s.taxPersonType === 'CONSUMER') return out;

  const want = ID_LENGTH[s.taxPersonType];
  if (!s.nationalId) {
    out.push(s.taxPersonType === 'LEGAL' ? 'شناسهٔ ملی ثبت نشده' : 'کد ملی ثبت نشده');
  } else if (want && !new RegExp(`^\\d{${want}}$`).test(s.nationalId)) {
    out.push(`شناسه باید ${want} رقم باشد`);
  }
  if (s.economicCode && !/^\d{12}$/.test(s.economicCode)) {
    out.push('کد اقتصادی باید ۱۲ رقم باشد');
  }
  return out;
}

// ───────────────────────────────────────────────────────────────
// اظهارنامهٔ ارزش افزوده
// ───────────────────────────────────────────────────────────────

/**
 * مالیات و عوارض ارزش افزودهٔ یک دوره.
 *
 * `net > 0` یعنی بدهکار به سازمان امور مالیاتی؛ `net < 0` یعنی اعتبارِ قابل
 * انتقال به دورهٔ بعد. علامت جدا برگردانده می‌شود چون «مالیات منفی» جمله‌ای
 * است که هیچ حسابداری نمی‌خواهد در اظهارنامه ببیند.
 */
export async function vatReturn(
  tx: Prisma.TransactionClient,
  input: { from: Date; to: Date },
) {
  const facts = await entryFacts(tx, input.from, input.to);

  let outputVat = 0n, inputVat = 0n, taxableSales = 0n, taxablePurchases = 0n;
  let grossSales = 0n;
  for (const f of facts) {
    outputVat += f.vatOut;
    inputVat += f.vatIn;
    // ممیزی ب۷: پایه از مالیات مشتق می‌شود، نه از جمعِ درآمدِ سند
    if (f.vatOut !== 0n) { taxableSales += taxableFromVat(f.vatOut); grossSales += f.income; }
    if (f.vatIn !== 0n) taxablePurchases += taxableFromVat(f.vatIn);
  }
  const net = outputVat - inputVat;

  return {
    from: input.from, to: input.to,
    taxableSales: taxableSales.toString(),
    outputVat: outputVat.toString(),
    taxablePurchases: taxablePurchases.toString(),
    inputVat: inputVat.toString(),
    net: net.toString(),
    /** نرخی که پایه با آن استخراج شده — تا خواننده بتواند خودش بازبینی کند */
    vatPercent: Number(VAT_PERCENT),
    /**
     * جمعِ درآمدِ اسنادِ ارزش‌افزوده‌دار. مابه‌التفاوتش با `taxableSales` یعنی
     * فروشِ معاف یا نرخ‌صفر (صادرات) در همان اسناد بوده — رقمی که برای
     * تفکیک «فروش معاف» در اظهارنامه لازم است.
     */
    exemptSales: (grossSales > taxableSales ? grossSales - taxableSales : 0n).toString(),
    /** `PAYABLE` بدهی به سازمان · `CREDIT` اعتبارِ قابل انتقال · `NIL` صفر */
    position: net > 0n ? 'PAYABLE' : net < 0n ? 'CREDIT' : 'NIL',
    /** قدرِ مطلقِ رقمِ اظهارنامه — همان عددی که در فرم نوشته می‌شود */
    amount: (net < 0n ? -net : net).toString(),
  };
}

/**
 * چهار فصلِ سال مالی، برای انتخابگرِ دوره.
 *
 * فصل مالیاتی همان سه‌ماههٔ شمسی است: بهار = فروردین تا خرداد. مرزها از
 * `shamsiMonths` می‌آید تا با بودجه و روند یکی باشد.
 */
export const QUARTERS = [
  { key: 1, label: 'بهار', months: [1, 3] },
  { key: 2, label: 'تابستان', months: [4, 6] },
  { key: 3, label: 'پاییز', months: [7, 9] },
  { key: 4, label: 'زمستان', months: [10, 12] },
] as const;
