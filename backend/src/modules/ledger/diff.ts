/**
 * هارنس مقایسهٔ دو هسته — فاز ۳ نقشهٔ پاریتی.
 *
 * در دورهٔ دونویسی، هر رویداد به هر دو هسته می‌رود. این تابع مانده‌ها را
 * **مفهوم‌به‌مفهوم و ارز‌به‌ارز** مقایسه می‌کند. اختلاف صفر برای چند روز پیوسته
 * یعنی هستهٔ جدید آمادهٔ برش است. اختلاف ماندگار = یک رویداد که دونویسی‌اش
 * می‌شکند (لاگ `[dual-write]` را ببینید).
 *
 * مفهوم = کد معینِ چارت جدید. خط هستهٔ قدیمی از `controlKind`/`ownerType`
 * به همان مفهوم نگاشت می‌شود (همان `CONTROL_MAP` مهاجرت).
 */
import { Prisma } from '@prisma/client';
import prisma from '../../shared/utils/prisma';
import { CONTROL_MAP } from './migration/migrate';

const PAYABLE_OWNERS = new Set(['PRODUCER', 'SUPPLIER', 'CARRIER', 'EXCHANGE', 'COMMISSION_AGENT']);

/**
 * منابعی که **فقط در هستهٔ جدید** وجود دارند و هرگز معادلی در قدیمی ندارند.
 *
 * ⚠️ این فهرست دروازهٔ برش را از یک عددِ بی‌معنا نجات می‌دهد. روی staging،
 * مقایسه ۷۱۷ میلیارد ریال اختلاف نشان می‌داد و رشتهٔ «روزهای پاک» صفر مانده
 * بود — نه چون دونویسی خراب بود، بلکه چون هستهٔ قدیمی اصلاً حقوق و دستمزد،
 * چک، تنخواه، ذخایر و استهلاک ندارد. مقایسهٔ آن‌ها مثل مقایسهٔ چیزی با هیچ
 * است و همیشه ناهماهنگ درمی‌آید.
 *
 * **قاعدهٔ پیش‌فرض: هر منبعِ تازه‌ای که اینجا نباشد، مقایسه می‌شود.** پس
 * آداپتوری که فردا اضافه شود و دونویسی‌اش را یادشان برود، به‌عنوان اختلاف
 * دیده می‌شود نه اینکه بی‌صدا نادیده گرفته شود. جهتِ امنِ خطا همین است.
 *
 * آنچه کنار گذاشته می‌شود **پنهان نمی‌شود**: حجمش به تفکیک منبع در
 * `excluded` برمی‌گردد تا خواننده خودش قضاوت کند.
 */
export const NEW_CORE_ONLY_SOURCES = [
  'Cheque',           // فاز ۵ — هستهٔ قدیمی چک ندارد
  'PettyCash',        // فاز ۵ — تنخواه‌گردان
  'PayrollRun',       // فاز ۵ — حقوق و دستمزد
  'ProvisionPayment', // پرداختِ ذخایر حقوق
  'Provision',        // مرحلهٔ ۴ د — ذخیرهٔ مطالبات
  'Depreciation',     // مرحلهٔ ۴ ه — استهلاک
  'Revaluation',      // تسعیر پایان دوره؛ قدیمی تسعیر ندارد
  'Conversion',       // نوار فرمان دفترداری — مسیرِ تبدیل ارزِ قدیمی جداست
  'ConversionFee',
  'Transfer',         // انتقال بین صندوق‌ها از نوار فرمان
  'Expense',          // ثبت هزینه از نوار فرمان
  'Manual',           // سند دستیِ مستقیم در هستهٔ جدید
] as const;

/**
 * `Settlement` دو منشأ دارد و نمی‌شود یک‌جا دربارهٔ آن قضاوت کرد:
 *
 *   • **دونویسی‌شده** — از `dwSettlement`، که `sourceId` را برابر شناسهٔ سندِ
 *     تسویهٔ هستهٔ قدیمی می‌گذارد (همان کلید idempotency). این‌ها دوقلوی
 *     قدیمی دارند و **باید** مقایسه شوند؛ تسویه مهم‌ترین عملیاتی است که
 *     دروازه باید بسنجد.
 *
 *   • **بومیِ هستهٔ جدید** — از نوار فرمان دفترداری، بدون `sourceId`. این‌ها
 *     هرگز به قدیمی نرفته‌اند.
 *
 * پس تمایز با نبودِ `sourceId` است، نه با نوعِ منبع. روی staging هر سه تسویه
 * `sourceId` تهی داشتند و همین ۸ ناهماهنگیِ باقی‌مانده را می‌ساختند.
 *
 * ⚠️ این قاعده را به منابع دیگر تعمیم ندهید: `PayrollRun` و `Revaluation` هم
 * `sourceId` دارند ولی دوقلوی قدیمی ندارند، و `Manual` تهی است ولی به دلیل
 * دیگری کنار می‌رود. `sourceId` یعنی «به رکوردی وصل است»، نه «دونویسی شده».
 */
const NATIVE_SETTLEMENT = Prisma.sql`
  (e."sourceType" = 'Settlement' AND e."sourceId" IS NULL)`;

/**
 * نفیِ NULL-امنِ همان شرط.
 *
 * ⚠️ `NOT (e."sourceType" = 'Settlement' AND …)` برای سندی که `sourceType`
 * تهی دارد **NULL** می‌شود، و ردیفِ NULL در `WHERE` رد می‌شود — یعنی همهٔ
 * اسناد بی‌منبع بی‌صدا از مقایسه می‌افتادند. منطق سه‌مقداری. تستِ «سند
 * بی‌منبع هم مقایسه می‌شود» همین را گرفت.
 */
const NOT_NATIVE_SETTLEMENT = Prisma.sql`
  (e."sourceType" IS DISTINCT FROM 'Settlement' OR e."sourceId" IS NOT NULL)`;

/** خط هستهٔ قدیمی → کد مفهوم */
function legacyConcept(controlKind: string | null, ownerType: string | null): string {
  if (controlKind && CONTROL_MAP[controlKind]) return CONTROL_MAP[controlKind];
  if (ownerType === 'CUSTOMER') return '1104';
  if (ownerType && PAYABLE_OWNERS.has(ownerType)) return '2101';
  if (ownerType === 'COMPANY') return '1101';
  return 'UNMAPPED';
}

/** کد حساب هستهٔ جدید → کد مفهوم (نقد/بانک همه زیر ۱۱۰۱) */
function glConcept(code: string): string {
  if (code.startsWith('1101') || code === '1102') return '1101';
  return code;
}

const CONCEPT_LABEL: Record<string, string> = {
  '1101': 'نقد و بانک', '1102': 'تنخواه', '1104': 'دریافتنی تجاری', '2101': 'پرداختنی تجاری',
  '2107': 'مالیات ارزش افزوده', '3101': 'سرمایه / افتتاحیه',
  '4101': 'فروش کالا', '4102': 'درآمد فورواردینگ',
  '5101': 'بهای تمام‌شده', '5102': 'هزینهٔ حمل', '5103': 'کمیسیون', '6201': 'هزینهٔ عمومی',
  '7102': 'کارمزد صرافی', '8101': 'سود تسعیر محقق', '8201': 'زیان تسعیر محقق',
};

export interface DiffRow {
  concept: string;
  label: string;
  currency: string;
  legacyForeign: string;
  legacyBase: string;
  glForeign: string;
  glBase: string;
  baseDelta: string;
  foreignDelta: string;
  ok: boolean;
}

export async function compareCores() {
  // واحدِ کوچک‌تر هر ارز — هستهٔ قدیمی مبلغ ارزی را به **واحد بزرگ** نگه می‌دارد
  // (۱۶۵۰ دلار)، هستهٔ جدید به **کوچک‌ترین واحد** (۱۶۵۰۰۰ سنت). برای هم‌سنگی،
  // مبلغِ قدیمی در `10^decimalPlaces` ضرب می‌شود. IRR استثناست: قدیمی تومان است
  // و جدید ریال ⇒ ×۱۰ (بازتعریفِ واحد، نه واحدِ کوچک‌تر).
  const currencies = await prisma.glCurrency.findMany({ select: { code: true, decimalPlaces: true, isBase: true } });
  const fxFactorCase = Prisma.join(
    currencies.map((c) => Prisma.sql`WHEN l.currency::text = ${c.code} THEN ${c.isBase ? 10 : 10 ** c.decimalPlaces}`),
    ' ',
  );

  // ── هستهٔ قدیمی: جمع به تفکیک (مفهوم، ارز) ──
  // ⚠️ سند باطل‌شده **و** سند برگشتی‌اش، هر دو کنار گذاشته می‌شوند. کنارگذاشتنِ
  // فقط `REVERSED` (کاری که نسخهٔ قبلی می‌کرد) سندِ برگشتی را تنها می‌گذارد و یک
  // ماندهٔ شبح می‌سازد — دقیقاً برعکسِ مهاجرت که هر دو را می‌شمارد و خنثی می‌کند.
  const legacy = await prisma.$queryRaw<
    { controlKind: string | null; ownerType: string | null; currency: string; fx: bigint | null; base: bigint | null }[]
  >`
    SELECT a."controlKind", a."ownerType", l.currency,
           round(SUM((l.debit - l.credit) * (CASE ${fxFactorCase} ELSE 1 END)))::bigint AS fx,
           round(SUM((l.debit - l.credit) * l."rateToIRR") * 10)::bigint                AS base
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e.id = l."entryId"
    JOIN "FinancialAccount" a ON a.id = l."accountId"
    WHERE e.status NOT IN ('REVERSED', 'REVERSAL')
    GROUP BY a."controlKind", a."ownerType", l.currency
  `;

  // ── هستهٔ جدید: جمع به تفکیک (کد حساب، ارز) ──
  const gl = await prisma.$queryRaw<
    { code: string; currency: string; fx: bigint | null; base: bigint | null }[]
  >`
    SELECT a.code, l."currencyCode" AS currency,
           SUM(l.debit - l.credit)::bigint             AS fx,
           SUM(l."debitBase" - l."creditBase")::bigint AS base
    FROM "GlLine" l
    JOIN "GlEntry" e ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'REVERSED' AND e."entryType" <> 'REVERSING'
      -- سند اختتامیه معادلی در هستهٔ قدیمی ندارد (قدیمی اصلاً بستن سال ندارد).
      -- اگر شمرده شود، بستنِ یک سال همهٔ مفاهیمِ موقت را در این مقایسه صفر
      -- می‌کند و رشتهٔ «روزهای پیاپی بدون اختلاف» را بی‌دلیل صفر می‌کند.
      AND NOT (e."entryType" = 'CLOSING' AND e."sourceType" = 'YearClose')
      -- منابعی که در هستهٔ قدیمی اصلاً وجود ندارند (بالا را ببینید)
      AND (e."sourceType" IS NULL
           OR e."sourceType" NOT IN (${Prisma.join(NEW_CORE_ONLY_SOURCES.map((x) => Prisma.sql`${x}`))}))
      -- تسویهٔ بومیِ نوار فرمان (بدون دوقلوی قدیمی)
      AND ${NOT_NATIVE_SETTLEMENT}
    GROUP BY a.code, l."currencyCode"
  `;

  // ── حجمِ کنارگذاشته‌شده، به تفکیک منبع ──
  // پنهان نمی‌شود؛ گزارش می‌شود تا خواننده بداند چه چیزی از مقایسه بیرون مانده.
  const excludedRows = await prisma.$queryRaw<
    { sourceType: string | null; entries: bigint; base: bigint | null }[]
  >`
    SELECT e."sourceType",
           COUNT(DISTINCT e.id)::bigint                       AS entries,
           SUM(ABS(l."debitBase" - l."creditBase"))::bigint    AS base
    FROM "GlLine" l
    JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE e.status <> 'REVERSED' AND e."entryType" <> 'REVERSING'
      AND (e."sourceType" IN (${Prisma.join(NEW_CORE_ONLY_SOURCES.map((x) => Prisma.sql`${x}`))})
           OR ${NATIVE_SETTLEMENT})
    GROUP BY e."sourceType"
    ORDER BY 3 DESC NULLS LAST
  `;
  const excluded = excludedRows.map((r) => ({
    sourceType: r.sourceType ?? '—',
    entries: Number(r.entries),
    base: BigInt(r.base ?? 0n).toString(),
  }));
  const excludedBase = excluded.reduce((a, r) => a + BigInt(r.base), 0n).toString();

  type Agg = { fx: bigint; base: bigint };
  const key = (c: string, cur: string) => `${c}|${cur}`;
  const legacyMap = new Map<string, Agg>();
  const glMap = new Map<string, Agg>();

  for (const r of legacy) {
    const c = legacyConcept(r.controlKind, r.ownerType);
    const k = key(c, r.currency);
    const cur = legacyMap.get(k) ?? { fx: 0n, base: 0n };
    cur.fx += BigInt(r.fx ?? 0n);
    cur.base += BigInt(r.base ?? 0n);
    legacyMap.set(k, cur);
  }
  for (const r of gl) {
    const c = glConcept(r.code);
    const k = key(c, r.currency);
    const cur = glMap.get(k) ?? { fx: 0n, base: 0n };
    cur.fx += BigInt(r.fx ?? 0n);
    cur.base += BigInt(r.base ?? 0n);
    glMap.set(k, cur);
  }

  const keys = [...new Set([...legacyMap.keys(), ...glMap.keys()])].sort();
  const rows: DiffRow[] = [];
  let totalBaseDelta = 0n;
  let mismatchCount = 0;
  let legacyOnlyBase = 0n;

  for (const k of keys) {
    const [concept, currency] = k.split('|');
    const L = legacyMap.get(k) ?? { fx: 0n, base: 0n };
    const G = glMap.get(k) ?? { fx: 0n, base: 0n };
    const baseDelta = L.base - G.base;
    const foreignDelta = L.fx - G.fx;
    const ok = baseDelta === 0n && foreignDelta === 0n;
    if (!ok) mismatchCount++;
    totalBaseDelta += baseDelta < 0n ? -baseDelta : baseDelta;
    if (!glMap.has(k)) legacyOnlyBase += L.base < 0n ? -L.base : L.base;

    rows.push({
      concept,
      label: CONCEPT_LABEL[concept] ?? (concept === 'UNMAPPED' ? 'نگاشت‌نشده' : concept),
      currency,
      legacyForeign: L.fx.toString(),
      legacyBase: L.base.toString(),
      glForeign: G.fx.toString(),
      glBase: G.base.toString(),
      baseDelta: baseDelta.toString(),
      foreignDelta: foreignDelta.toString(),
      ok,
    });
  }

  return {
    rows,
    totalBaseDelta: totalBaseDelta.toString(),
    mismatchCount,
    legacyOnlyBase: legacyOnlyBase.toString(),
    /** منابعِ فقط-جدید که از مقایسه بیرون ماندند — به تفکیک، تا پنهان نباشد */
    excluded,
    excludedBase,
    generatedAt: new Date().toISOString(),
  };
}
