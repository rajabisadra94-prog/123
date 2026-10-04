/**
 * دفاتر قانونی — مرحلهٔ ۵ الف.
 *
 * سامانه «دفتر روزنامه» و «دفتر کل» را به‌عنوان **گزارش** داشت، ولی دفترِ
 * قانونی یک گزارش نیست؛ یک **سند صفحه‌بندی‌شده** است که به ممیز مالیاتی
 * تحویل می‌شود و قواعد شکلیِ خودش را دارد:
 *
 *   • صفحه‌بندیِ ثابت با شمارهٔ صفحه
 *   • «نقل از صفحهٔ قبل» در بالای هر صفحه و «نقل به صفحهٔ بعد» در پایینش
 *   • جمعِ تجمعیِ بدهکار و بستانکار که از صفحه‌ای به صفحهٔ بعد منتقل می‌شود
 *   • ترتیب تاریخی و بدون شکاف
 *
 * ─── چرا صفحه‌بندی در بک‌اند و نه در CSS ───────────────────────
 *
 * وسوسه‌انگیز است که بگذاریم مرورگر خودش صفحه بشکند. ولی آن‌وقت «نقل از صفحهٔ
 * قبل» را نمی‌شود نوشت — چون تا وقتی مرورگر نشکسته، معلوم نیست هر صفحه با چه
 * جمعی تمام می‌شود. این عدد **همان چیزی است که ممیز نگاه می‌کند**، پس
 * صفحه‌بندی باید جایی انجام شود که جمع‌ها را می‌داند.
 *
 * ─── و چرا سندِ باطل‌شده هم می‌آید ─────────────────────────────
 *
 * دفتر قانونی تاریخ است نه خلاصه. سندی که ثبت و بعد ابطال شده، هر دو باید
 * دیده شوند؛ حذفِ اصل و نگه‌داشتنِ برگشتی یعنی دفتری که با خودش نمی‌خواند.
 */
import { Prisma } from '@prisma/client';

export class StatutoryError extends Error {}

/** ردیف‌های هر صفحهٔ دفتر — عددِ متعارفِ دفاتر چاپی */
export const ROWS_PER_PAGE = 25;

export interface BookLine {
  date: Date;
  serial: number | null;
  description: string;
  accountCode: string;
  accountName: string;
  subsidiaryName: string | null;
  debit: string;
  credit: string;
  status: string;
}

export interface BookPage {
  pageNo: number;
  /** جمعِ تجمعی تا انتهای صفحهٔ قبل */
  broughtForward: { debit: string; credit: string };
  lines: BookLine[];
  /** جمعِ همین صفحه */
  pageTotal: { debit: string; credit: string };
  /** جمعِ تجمعی تا انتهای این صفحه — «نقل به صفحهٔ بعد» */
  carriedForward: { debit: string; credit: string };
}

/** صفحه‌بندیِ مشترکِ هر دو دفتر */
function paginate(lines: BookLine[], rowsPerPage: number): BookPage[] {
  const pages: BookPage[] = [];
  let accDebit = 0n, accCredit = 0n;

  for (let i = 0; i < Math.max(lines.length, 1); i += rowsPerPage) {
    const slice = lines.slice(i, i + rowsPerPage);
    const bfDebit = accDebit, bfCredit = accCredit;
    let pDebit = 0n, pCredit = 0n;
    for (const l of slice) { pDebit += BigInt(l.debit); pCredit += BigInt(l.credit); }
    accDebit += pDebit; accCredit += pCredit;

    pages.push({
      pageNo: pages.length + 1,
      broughtForward: { debit: bfDebit.toString(), credit: bfCredit.toString() },
      lines: slice,
      pageTotal: { debit: pDebit.toString(), credit: pCredit.toString() },
      carriedForward: { debit: accDebit.toString(), credit: accCredit.toString() },
    });
    if (lines.length === 0) break;
  }
  return pages;
}

/**
 * دفتر روزنامهٔ قانونی: همهٔ ردیف‌ها به ترتیب تاریخ و شمارهٔ سند.
 *
 * پیش‌نویس‌ها **نمی‌آیند** — سندِ نهایی‌نشده هنوز سند نیست و شماره هم ندارد.
 */
export async function journalBook(
  tx: Prisma.TransactionClient,
  input: { from: Date; to: Date; rowsPerPage?: number },
) {
  const lines = await tx.$queryRaw<{
    date: Date; serial: number | null; description: string;
    accountCode: string; accountName: string; subsidiaryName: string | null;
    debit: bigint; credit: bigint; status: string;
  }[]>`
    SELECT e.date, e.serial, e.description,
           a.code AS "accountCode", a.name AS "accountName",
           sub.name AS "subsidiaryName",
           l."debitBase" AS debit, l."creditBase" AS credit,
           e.status::text AS status
    FROM "GlEntry" e
    JOIN "GlLine" l              ON l."entryId" = e.id
    JOIN "GlAccount" a           ON a.id = l."accountId"
    LEFT JOIN "GlSubsidiary" sub ON sub.id = l."subsidiaryId"
    WHERE e.status <> 'DRAFT'
      AND e.date >= ${input.from} AND e.date <= ${input.to}
    ORDER BY e.date, e.serial, l."lineNo"
  `;

  const shaped: BookLine[] = lines.map((l) => ({
    date: l.date, serial: l.serial, description: l.description,
    accountCode: l.accountCode, accountName: l.accountName,
    subsidiaryName: l.subsidiaryName,
    debit: BigInt(l.debit).toString(), credit: BigInt(l.credit).toString(),
    status: l.status,
  }));

  const pages = paginate(shaped, input.rowsPerPage ?? ROWS_PER_PAGE);
  const last = pages[pages.length - 1];
  return {
    book: 'JOURNAL' as const,
    from: input.from, to: input.to,
    pages,
    lineCount: shaped.length,
    total: last?.carriedForward ?? { debit: '0', credit: '0' },
    /** دفتر روزنامه باید در جمعِ نهایی تراز باشد */
    balanced: (last?.carriedForward.debit ?? '0') === (last?.carriedForward.credit ?? '0'),
  };
}

/**
 * دفتر کل قانونی: یک بخش به‌ازای هر **حساب کل** (دو رقمی)، با گردش ماهانه.
 *
 * دفتر کل ریزِ سند را نشان نمی‌دهد — آن کارِ دفتر روزنامه است. اینجا هر ماه
 * یک سطر است و ماندهٔ در حال حرکت هر بخش. همان چیزی که در دفتر چاپی هست.
 */
export async function generalLedgerBook(
  tx: Prisma.TransactionClient,
  input: { from: Date; to: Date },
) {
  const rows = await tx.$queryRaw<{
    code: string; name: string; month: Date;
    debit: bigint; credit: bigint;
  }[]>`
    SELECT LEFT(a.code, 2) AS code,
           MIN(top.name)   AS name,
           DATE_TRUNC('month', e.date) AS month,
           SUM(l."debitBase")::bigint  AS debit,
           SUM(l."creditBase")::bigint AS credit
    FROM "GlEntry" e
    JOIN "GlLine" l    ON l."entryId" = e.id
    JOIN "GlAccount" a ON a.id = l."accountId"
    LEFT JOIN "GlAccount" top ON top.code = LEFT(a.code, 2)
    WHERE e.status <> 'DRAFT'
      AND e.date >= ${input.from} AND e.date <= ${input.to}
    GROUP BY LEFT(a.code, 2), DATE_TRUNC('month', e.date)
    ORDER BY 1, 3
  `;

  // ماندهٔ پیش از بازه، تا ستون مانده از صفر شروع نشود
  const openings = await tx.$queryRaw<{ code: string; debit: bigint; credit: bigint }[]>`
    SELECT LEFT(a.code, 2) AS code,
           SUM(l."debitBase")::bigint  AS debit,
           SUM(l."creditBase")::bigint AS credit
    FROM "GlEntry" e
    JOIN "GlLine" l    ON l."entryId" = e.id
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'DRAFT' AND e.date < ${input.from}
    GROUP BY LEFT(a.code, 2)
  `;
  const openingOf = new Map(openings.map((o) => [o.code, BigInt(o.debit) - BigInt(o.credit)]));

  const byAccount = new Map<string, {
    code: string; name: string;
    opening: bigint;
    rows: { month: Date; debit: string; credit: string; running: string }[];
    totalDebit: bigint; totalCredit: bigint;
  }>();

  for (const r of rows) {
    const acc = byAccount.get(r.code) ?? {
      code: r.code, name: r.name ?? r.code,
      opening: openingOf.get(r.code) ?? 0n,
      rows: [], totalDebit: 0n, totalCredit: 0n,
    };
    byAccount.set(r.code, acc);
    acc.totalDebit += BigInt(r.debit);
    acc.totalCredit += BigInt(r.credit);
    const running = acc.opening + acc.totalDebit - acc.totalCredit;
    acc.rows.push({
      month: r.month,
      debit: BigInt(r.debit).toString(),
      credit: BigInt(r.credit).toString(),
      running: running.toString(),
    });
  }

  const sections = [...byAccount.values()]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((a) => ({
      code: a.code, name: a.name,
      opening: a.opening.toString(),
      rows: a.rows,
      totalDebit: a.totalDebit.toString(),
      totalCredit: a.totalCredit.toString(),
      closing: (a.opening + a.totalDebit - a.totalCredit).toString(),
    }));

  const grand = sections.reduce(
    (s, a) => ({ debit: s.debit + BigInt(a.totalDebit), credit: s.credit + BigInt(a.totalCredit) }),
    { debit: 0n, credit: 0n },
  );

  return {
    book: 'GENERAL' as const,
    from: input.from, to: input.to,
    sections,
    total: { debit: grand.debit.toString(), credit: grand.credit.toString() },
    balanced: grand.debit === grand.credit,
  };
}

// ───────────────────────────────────────────────────────────────
// صورتحساب طرف‌حساب
// ───────────────────────────────────────────────────────────────

/**
 * صورتحسابی که برای خودِ مشتری فرستاده می‌شود.
 *
 * فرقش با «پروندهٔ طرف‌حساب» این است که پرونده برای **ما**ست و صورتحساب برای
 * **او**: ماندهٔ ابتدای دوره، گردش، ماندهٔ پایان دوره، و یک جملهٔ روشن که
 * می‌گوید چه کسی به چه کسی بدهکار است. کد حساب و شمارهٔ سند داخلی در آن
 * نمی‌آید — به کار مشتری نمی‌خورد و فقط سؤال درست می‌کند.
 *
 * **به تفکیک ارز**، چون صورتحسابی که ریال و دلار را جمع کرده باشد قابل
 * پرداخت نیست.
 */
export async function partyStatement(
  tx: Prisma.TransactionClient,
  input: { subsidiaryId: string; from: Date; to: Date; accountCode?: string },
) {
  const sub = await tx.glSubsidiary.findUnique({ where: { id: input.subsidiaryId } });
  if (!sub) throw new StatutoryError('طرف‌حساب یافت نشد');
  const code = input.accountCode ?? (sub.kind === 'CUSTOMER' ? '1104' : '2101');

  const account = await tx.glAccount.findUnique({ where: { code } });
  if (!account) throw new StatutoryError(`حساب «${code}» در چارت نیست`);

  const rows = await tx.$queryRaw<{
    date: Date; description: string; memo: string | null;
    currencyCode: string; debit: bigint; credit: bigint;
  }[]>`
    SELECT e.date, e.description, l.memo, l."currencyCode",
           l.debit, l.credit
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE a.code = ${code} AND l."subsidiaryId" = ${input.subsidiaryId}
      AND e.status <> 'DRAFT'
      AND e.date >= ${input.from} AND e.date <= ${input.to}
    ORDER BY e.date, e.serial, l."lineNo"
  `;

  const openings = await tx.$queryRaw<{ currencyCode: string; amount: bigint }[]>`
    SELECT l."currencyCode",
           (SUM(l.debit) - SUM(l.credit))::bigint AS amount
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE a.code = ${code} AND l."subsidiaryId" = ${input.subsidiaryId}
      AND e.status <> 'DRAFT' AND e.date < ${input.from}
    GROUP BY l."currencyCode"
  `;

  // ماهیتِ حساب علامت را تعیین می‌کند: دریافتنی بدهکار، پرداختنی بستانکار
  const sign = account.normalSide === 'DEBIT' ? 1n : -1n;

  const byCurrency = new Map<string, {
    currencyCode: string; opening: bigint;
    lines: { date: Date; description: string; memo: string | null;
             debit: string; credit: string; running: string }[];
    totalDebit: bigint; totalCredit: bigint; closing: bigint;
  }>();

  for (const o of openings) {
    byCurrency.set(o.currencyCode, {
      currencyCode: o.currencyCode, opening: BigInt(o.amount) * sign,
      lines: [], totalDebit: 0n, totalCredit: 0n, closing: BigInt(o.amount) * sign,
    });
  }

  for (const r of rows) {
    const c = byCurrency.get(r.currencyCode) ?? {
      currencyCode: r.currencyCode, opening: 0n,
      lines: [], totalDebit: 0n, totalCredit: 0n, closing: 0n,
    };
    byCurrency.set(r.currencyCode, c);

    // ستون‌ها از دید طرف‌حساب: «بدهکار» یعنی بدهیِ او بیشتر شده
    const debit = sign === 1n ? BigInt(r.debit) : BigInt(r.credit);
    const credit = sign === 1n ? BigInt(r.credit) : BigInt(r.debit);
    c.totalDebit += debit;
    c.totalCredit += credit;
    c.closing = c.opening + c.totalDebit - c.totalCredit;
    c.lines.push({
      date: r.date, description: r.description, memo: r.memo,
      debit: debit.toString(), credit: credit.toString(),
      running: c.closing.toString(),
    });
  }

  const currencies = [...byCurrency.values()]
    .filter((c) => c.lines.length > 0 || c.opening !== 0n)
    .map((c) => ({
      currencyCode: c.currencyCode,
      opening: c.opening.toString(),
      lines: c.lines,
      totalDebit: c.totalDebit.toString(),
      totalCredit: c.totalCredit.toString(),
      closing: c.closing.toString(),
      /**
       * جملهٔ روشنی که خواننده بدون دانش حسابداری هم بفهمد.
       *
       * ⚠️ جهت به ماهیت حساب بند است. `closing` مثبت روی **دریافتنی** یعنی
       * طرف‌حساب به ما بدهکار است، ولی همان عدد روی **پرداختنی** یعنی ما به
       * او بدهکاریم — چون ستون‌ها با `sign` برگردانده شده‌اند تا «افزایش
       * تعهد» همیشه در ستون اول بنشیند.
       */
      verdict: c.closing === 0n ? 'تسویه'
        : sign === 1n
          ? (c.closing > 0n ? 'بدهکار به ما' : 'پیش‌پرداخت — ما به او بدهکاریم')
          : (c.closing > 0n ? 'ما به او بدهکاریم' : 'پیش‌پرداخت — او به ما بدهکار است'),
    }));

  return {
    party: { id: sub.id, code: sub.code, name: sub.name, kind: sub.kind },
    accountCode: code,
    from: input.from, to: input.to,
    currencies,
    empty: currencies.length === 0,
  };
}
