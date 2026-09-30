/**
 * روند ماهانه — داشبورد مدیر مالی (ممیزی سوم — ب۱۵).
 *
 * نمای کلی تا امروز چهار کارتِ ایستا بود: نقد، دریافتنی، پرداختنی، خالص. هر
 * چهارتا **مانده در همین لحظه** بودند و هیچ‌کدام نمی‌گفتند این عدد از کجا
 * آمده. مدیر مالی از یک عدد تصمیم نمی‌گیرد؛ از جهتش تصمیم می‌گیرد. «۳۰۱
 * میلیارد طلب» بدون اینکه بدانی سه ماه پیش ۱۸۰ بوده یا ۴۲۰، هیچ است.
 *
 * سه سری در یک نمودار: **درآمد، هزینه، و سودِ همان ماه** — نه تجمعی. تجمعی
 * همیشه صعودی است و افتِ یک ماه را پنهان می‌کند، که دقیقاً همان چیزی است که
 * باید دیده شود.
 *
 * و یک سری چهارم جدا: **ماندهٔ نقد در پایان هر ماه**، که تجمعی *است* چون
 * ماهیتش ترازنامه‌ای است. موجودی ابتدای سال هم به آن اضافه می‌شود، وگرنه
 * نمودار از صفر شروع می‌کرد و شرکتی که با ۵۰ میلیارد وارد سال شده، ورشکسته
 * به نظر می‌رسید.
 */
import { Prisma } from '@prisma/client';
import { shamsiMonths, MONTHS_IN_YEAR } from '../shamsi';
import { SHAMSI_MONTHS } from '../budget';

export interface TrendMonth {
  month: number;
  label: string;
  from: Date;
  to: Date;
  income: string;
  expense: string;
  profit: string;
  /** ماندهٔ نقد و بانک در پایان همان ماه — تجمعی */
  cash: string;
  /** آیا این ماه هنوز نرسیده؟ نقطه‌های آینده نباید صفر کشیده شوند */
  future: boolean;
}

/** مبالغِ سود و زیانیِ یک بازه، به ارز پایه، بدون سند اختتامیه */
const PERIOD_SQL = (from: Date, to: Date) => Prisma.sql`
  SELECT a."rootType",
         (SUM(l."creditBase") - SUM(l."debitBase"))::bigint AS credit_net,
         (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS debit_net
  FROM "GlLine" l
  JOIN "GlEntry" e   ON e.id = l."entryId"
  JOIN "GlAccount" a ON a.id = l."accountId"
  WHERE e.status <> 'DRAFT'
    AND a."statement" = 'INCOME_STATEMENT'
    AND e.date >= ${from} AND e.date <= ${to}
    AND e."sourceType" IS DISTINCT FROM 'YearClose'
  GROUP BY a."rootType"
`;

export async function monthlyTrend(
  tx: Prisma.TransactionClient,
  fiscalYearId: string,
  now: Date = new Date(),
): Promise<{ fiscalYear: { id: string; title: string }; months: TrendMonth[];
             totals: { income: string; expense: string; profit: string } }> {
  const fy = await tx.glFiscalYear.findUnique({ where: { id: fiscalYearId } });
  if (!fy) throw new Error('سال مالی یافت نشد');

  const bounds = shamsiMonths(fy);

  // ماندهٔ نقد پیش از شروع سال — نقطهٔ صفرِ سریِ نقد
  const [openingCash] = await tx.$queryRaw<{ amount: bigint | null }[]>`
    SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS amount
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'DRAFT'
      AND (a.code LIKE '1101%' OR a.code = '1102')
      AND e.date < ${bounds[0].from}
  `;

  let runningCash = BigInt(openingCash?.amount ?? 0n);
  let totalIncome = 0n, totalExpense = 0n;
  const months: TrendMonth[] = [];

  for (let m = 1; m <= MONTHS_IN_YEAR; m++) {
    const { from, to } = bounds[m - 1];

    const pl = await tx.$queryRaw<{ rootType: string; credit_net: bigint; debit_net: bigint }[]>(
      PERIOD_SQL(from, to),
    );
    // درآمد ماهیت بستانکار دارد و هزینه بدهکار؛ هر کدام از ستون خودش خوانده
    // می‌شود تا «هزینهٔ منفی» و «درآمد منفی» به هم قاطی نشوند.
    let income = 0n, expense = 0n;
    for (const r of pl) {
      if (r.rootType === 'INCOME') income += BigInt(r.credit_net);
      else if (r.rootType === 'EXPENSE') expense += BigInt(r.debit_net);
    }

    const [cashRow] = await tx.$queryRaw<{ amount: bigint | null }[]>`
      SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS amount
      FROM "GlLine" l
      JOIN "GlEntry" e   ON e.id = l."entryId"
      JOIN "GlAccount" a ON a.id = l."accountId"
      WHERE e.status <> 'DRAFT'
        AND (a.code LIKE '1101%' OR a.code = '1102')
        AND e.date >= ${from} AND e.date <= ${to}
    `;
    runningCash += BigInt(cashRow?.amount ?? 0n);

    totalIncome += income;
    totalExpense += expense;

    months.push({
      month: m,
      label: SHAMSI_MONTHS[m - 1],
      from, to,
      income: income.toString(),
      expense: expense.toString(),
      profit: (income - expense).toString(),
      cash: runningCash.toString(),
      future: from > now,
    });
  }

  return {
    fiscalYear: { id: fy.id, title: fy.title },
    months,
    totals: {
      income: totalIncome.toString(),
      expense: totalExpense.toString(),
      profit: (totalIncome - totalExpense).toString(),
    },
  };
}
