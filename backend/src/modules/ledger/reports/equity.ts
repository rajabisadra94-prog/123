/**
 * صورت تغییرات حقوق صاحبان سهام — مرحلهٔ ۴ ب.
 *
 * چهارمین صورت مالیِ اساسی. سه‌تای دیگر (ترازنامه، سود و زیان، جریان وجوه
 * نقد) بودند و این نبود؛ بدون آن مجموعه ناقص است و حسابرس امضا نمی‌کند.
 *
 * ─── تلهٔ اصلی: سودِ دوره دو بار شمرده می‌شود ────────────────────
 *
 * صورت تغییرات همیشه «سود (زیان) خالص دوره» را به‌عنوان یک سطر مستقل نشان
 * می‌دهد. ولی اگر سال **بسته شده باشد**، همان سود از قبل با سند اختتامیه به
 * حساب ۳۱۰۲ منتقل شده و در گردشِ آن حساب هست. جمع کردنِ ساده یعنی دو برابر
 * شدنِ سود.
 *
 * راه‌حل: گردشِ سطرها **بدون سند اختتامیه** حساب می‌شود و سود دوره همیشه
 * سطر جدای خودش را دارد. آن‌وقت در هر دو حالت — سال باز یا بسته —
 * `ابتدا + گردش + سود = حقوق صاحبان سهامِ اقتصادی` درست درمی‌آید.
 *
 * ─── و قاعدهٔ وضعیتِ سند ────────────────────────────────────────
 *
 * فیلتر `status <> 'DRAFT'` است، **نه** `status = 'POSTED'`. ابطال در این
 * هسته با ثبتِ سندِ آینه‌ای انجام می‌شود نه با حذف؛ سندِ اصلی `REVERSED`
 * می‌شود و آینه‌اش `POSTED`. گرفتنِ فقط `POSTED` یعنی نگه داشتنِ آینه و
 * انداختنِ اصل — و یک ماندهٔ منفیِ ساختگی. همین اشتباه در نخستین نسخهٔ همین
 * فایل بود و روی دادهٔ staging یک «سود انباشتهٔ ‎−۲۵۵ میلیاردی» ساخت.
 *
 * و چون در سالِ باز این عدد با ماندهٔ خامِ حساب‌ها فرق دارد، هر دو برمی‌گردد:
 * `closingPosted` (آنچه در دفتر است) و `closingEconomic` (آنچه در صورت مالی
 * می‌آید)، به‌همراه `profitPosted` که می‌گوید کدام‌یک کدام است.
 */
import { Prisma } from '@prisma/client';
import { EXCLUDE_YEAR_CLOSE, YEAR_CLOSE_SOURCE } from '../year-close';

/** ریشهٔ حقوق صاحبان سهام در کدینگ */
const EQUITY_PREFIX = '3';
/** سود و زیان انباشته — مقصدِ سودِ دوره */
export const RETAINED_EARNINGS = '3102';
/** اندوختهٔ قانونی — مادهٔ ۱۴۰ قانون تجارت */
export const LEGAL_RESERVE = '3103';

export interface EquityColumn {
  code: string;
  name: string;
  opening: string;
  /** گردشِ دوره، بدون سند اختتامیه */
  movement: string;
  /** ماندهٔ دفتری در پایان دوره */
  closingPosted: string;
  /** ماندهٔ صورت مالی: دفتری به‌علاوهٔ سودی که هنوز منتقل نشده */
  closingEconomic: string;
}

export interface EquityMovementRow {
  serial: number | null;
  date: Date;
  description: string;
  /** مبلغِ اثر روی هر ستون، به کلید کد حساب */
  byAccount: Record<string, string>;
  total: string;
}

/**
 * `asOf` را یک روز عقب می‌برد تا «ماندهٔ ابتدای دوره» یعنی پیش از اولین سندِ
 * همان روز، نه شاملِ آن.
 */
const dayBefore = (d: Date) => new Date(d.getTime() - 86_400_000);

async function equityBalances(
  tx: Prisma.TransactionClient, asOf: Date, excludeClose: boolean,
) {
  const closing = excludeClose ? EXCLUDE_YEAR_CLOSE : Prisma.empty;
  return tx.$queryRaw<{ code: string; name: string; amount: bigint }[]>`
    SELECT a.code, a.name,
           (SUM(l."creditBase") - SUM(l."debitBase"))::bigint AS amount
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'DRAFT'
      AND a."isPostable" = true
      AND a.code LIKE ${EQUITY_PREFIX + '%'}
      AND a."rootType" = 'EQUITY'
      AND e.date <= ${asOf}
      ${closing}
    GROUP BY a.code, a.name
  `;
}

export async function equityStatement(
  tx: Prisma.TransactionClient,
  input: { from: Date; to: Date },
) {
  // همهٔ حساب‌های برگِ حقوق صاحبان سهام — حتی آن‌هایی که گردشی نداشته‌اند،
  // چون ستونِ غایب در صورت مالی یعنی «این حساب وجود ندارد»، نه «صفر است».
  const accounts = await tx.glAccount.findMany({
    where: { rootType: 'EQUITY', isPostable: true },
    select: { code: true, name: true },
    orderBy: { code: 'asc' },
  });

  const openingRows = await equityBalances(tx, dayBefore(input.from), true);
  const closingRows = await equityBalances(tx, input.to, false);
  const closingNoClose = await equityBalances(tx, input.to, true);

  const pick = (rows: { code: string; amount: bigint }[], code: string) =>
    BigInt(rows.find((r) => r.code === code)?.amount ?? 0n);

  // سود (زیان) خالص دوره — از حساب‌های سود و زیانی، بدون سند اختتامیه
  const [pl] = await tx.$queryRaw<{ amount: bigint | null }[]>`
    SELECT (SUM(l."creditBase") - SUM(l."debitBase"))::bigint AS amount
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'DRAFT'
      AND a."statement" = 'INCOME_STATEMENT'
      AND e.date >= ${input.from} AND e.date <= ${input.to}
      AND e."sourceType" IS DISTINCT FROM ${YEAR_CLOSE_SOURCE}
  `;
  const profit = BigInt(pl?.amount ?? 0n);

  // آیا سند اختتامیه این سود را از قبل به انباشته برده؟
  //
  // ⚠️ شرط `entryType: 'CLOSING'` و `status: 'POSTED'` با هم لازم است. سندِ
  // اختتامیهٔ **ابطال‌شده** یعنی سال دوباره باز شده و سود هنوز منتقل نیست؛
  // ولی سندِ برگشتیِ آن هم `sourceType = 'YearClose'` دارد و `POSTED` است،
  // پس شمردنِ صرفِ منبع، سالِ بازگشایی‌شده را «بسته» گزارش می‌کرد.
  const closeEntries = await tx.glEntry.count({
    where: {
      status: 'POSTED', entryType: 'CLOSING', sourceType: YEAR_CLOSE_SOURCE,
      date: { gte: input.from, lte: input.to },
    },
  });
  const profitPosted = closeEntries > 0;

  const columns: EquityColumn[] = accounts.map((a) => {
    const opening = pick(openingRows, a.code);
    const posted = pick(closingRows, a.code);
    const movement = pick(closingNoClose, a.code) - opening;
    // سودِ منتقل‌نشده فقط روی انباشته می‌نشیند
    const pending = !profitPosted && a.code === RETAINED_EARNINGS ? profit : 0n;
    return {
      code: a.code, name: a.name,
      opening: opening.toString(),
      movement: movement.toString(),
      closingPosted: posted.toString(),
      closingEconomic: (posted + pending).toString(),
    };
  });

  // ریزِ گردش‌ها، تا «۵ میلیارد افزایش سرمایه» قابل ردیابی باشد
  const moves = await tx.$queryRaw<{
    entryId: string; serial: number | null; date: Date; description: string;
    code: string; amount: bigint;
  }[]>`
    SELECT e.id AS "entryId", e.serial, e.date, e.description, a.code,
           (SUM(l."creditBase") - SUM(l."debitBase"))::bigint AS amount
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'DRAFT'
      AND a."isPostable" = true AND a."rootType" = 'EQUITY'
      AND e.date >= ${input.from} AND e.date <= ${input.to}
      AND e."sourceType" IS DISTINCT FROM ${YEAR_CLOSE_SOURCE}
    GROUP BY e.id, e.serial, e.date, e.description, a.code
    ORDER BY e.date, e.serial
  `;

  const byEntry = new Map<string, EquityMovementRow>();
  for (const m of moves) {
    const row = byEntry.get(m.entryId) ?? {
      serial: m.serial, date: m.date, description: m.description,
      byAccount: {} as Record<string, string>, total: '0',
    };
    byEntry.set(m.entryId, row);
    row.byAccount[m.code] = BigInt(m.amount).toString();
    row.total = (BigInt(row.total) + BigInt(m.amount)).toString();
  }
  // سندِ صرفاً جابه‌جاکننده (مثلاً انباشته ← اندوختهٔ قانونی) جمعش صفر است و
  // همین درست است؛ حذفش نمی‌کنیم چون خودِ جابه‌جایی خبر است.
  const movements = [...byEntry.values()];

  const sum = (f: (c: EquityColumn) => string) =>
    columns.reduce((s, c) => s + BigInt(f(c)), 0n).toString();

  return {
    from: input.from, to: input.to,
    columns,
    movements,
    profit: profit.toString(),
    profitPosted,
    totals: {
      opening: sum((c) => c.opening),
      movement: sum((c) => c.movement),
      closingPosted: sum((c) => c.closingPosted),
      closingEconomic: sum((c) => c.closingEconomic),
    },
  };
}

/**
 * اندوختهٔ قانونی طبق مادهٔ ۱۴۰ قانون تجارت: **پنج درصد** سود خالص هر سال،
 * تا وقتی اندوخته به **ده درصد** سرمایه برسد.
 *
 * فقط پیشنهاد می‌دهد و سند نمی‌زند. انتقال به اندوخته مصوبهٔ مجمع می‌خواهد،
 * نه محاسبهٔ سیستم؛ ولی محاسبه‌اش را نباید دستی کرد چون سقفِ ده درصد را
 * راحت فراموش می‌کنند.
 */
export async function legalReserveSuggestion(
  tx: Prisma.TransactionClient,
  input: { from: Date; to: Date },
) {
  const st = await equityStatement(tx, input);
  const capital = BigInt(st.columns.find((c) => c.code === '3101')?.closingPosted ?? 0n);
  const reserve = BigInt(st.columns.find((c) => c.code === LEGAL_RESERVE)?.closingPosted ?? 0n);
  const profit = BigInt(st.profit);

  const cap = capital / 10n;                 // سقف: ده درصد سرمایه
  const headroom = cap > reserve ? cap - reserve : 0n;
  const fivePercent = profit > 0n ? profit / 20n : 0n;
  const suggested = fivePercent < headroom ? fivePercent : headroom;

  return {
    capital: capital.toString(),
    reserve: reserve.toString(),
    profit: profit.toString(),
    ceiling: cap.toString(),
    headroom: headroom.toString(),
    suggested: suggested.toString(),
    reason: profit <= 0n ? 'سالِ زیان‌ده — اندوخته برداشت نمی‌شود'
      : headroom === 0n ? 'اندوخته به سقفِ ده درصد سرمایه رسیده است'
        : suggested < fivePercent ? 'تا سقفِ ده درصد سرمایه، کمتر از پنج درصد سود'
          : 'پنج درصد سود خالص، طبق مادهٔ ۱۴۰ قانون تجارت',
  };
}
