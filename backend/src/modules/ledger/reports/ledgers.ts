/**
 * دفاتر — docs/ACCOUNTING_SPEC.md بند ۳-۷
 *
 * دفتر روزنامه، دفتر کل/معین/تفصیلی، و تراز آزمایشی.
 *
 * ⛔ قاعدهٔ مشترک همهٔ کوئری‌های این ماژول: فیلتر `status <> 'DRAFT'` است،
 * **نه** `status = 'POSTED'`. سند باطل‌شده (REVERSED) و سند برگشتی‌اش باید هر دو
 * بمانند تا خنثی شوند. با حذف سند اصلی، فقط برگشتی می‌ماند و مانده **قرینه**
 * می‌شود، نه صفر. این تله یک بار در هستهٔ قدیمی رخ داد؛ در
 * `tests/proven/08-reversed-not-filtered` قفل است.
 */
import { Prisma } from '@prisma/client';

export interface ReportScope {
  from?: Date;
  to?: Date;
  /** فقط این مرکز هزینه و نوادگانش */
  costCenterIds?: string[];
  /**
   * فقط این پروژه‌ها (بند ۲۸ ALIP).
   *
   * ⚠️ شرط، بُعد واقعی **و** مرکز هزینهٔ سایهٔ قدیمی را با هم می‌گیرد:
   * ردیف‌هایی که پیش از افزودن `projectId` ثبت شده‌اند پروژه‌شان را در
   * قالب مرکز هزینهٔ `9.<کد پروژه>` حمل می‌کنند و تریگر تغییرناپذیری
   * اجازهٔ مهاجرتشان را نمی‌دهد. ترجمه در زمان گزارش انجام می‌شود.
   */
  projectIds?: string[];
  /** فقط این ارز — اگر ندهید همهٔ ارزها به ارز پایه جمع می‌شوند */
  currencyCode?: string;
}

/** شرط‌های مشترک، یک‌جا تا در هر کوئری تکرار نشود */
function scopeWhere(s: ReportScope) {
  return Prisma.sql`
    e.status <> 'DRAFT'
    ${s.from ? Prisma.sql`AND e.date >= ${s.from}` : Prisma.empty}
    ${s.to ? Prisma.sql`AND e.date <= ${s.to}` : Prisma.empty}
    ${s.currencyCode ? Prisma.sql`AND l."currencyCode" = ${s.currencyCode}` : Prisma.empty}
    ${s.costCenterIds?.length
      ? Prisma.sql`AND l."costCenterId" IN (${Prisma.join(s.costCenterIds)})`
      : Prisma.empty}
    ${s.projectIds?.length
      ? Prisma.sql`AND (l."projectId" IN (${Prisma.join(s.projectIds)}) OR l."costCenterId" IN (
          SELECT cc.id FROM "GlCostCenter" cc JOIN "Project" p ON p.code = SUBSTRING(cc.code FROM 3)
          WHERE cc.code LIKE '9.%' AND p.id IN (${Prisma.join(s.projectIds)})))`
      : Prisma.empty}
  `;
}

/** ستون مبلغ: به ارز اصلی وقتی ارز مشخص شده، وگرنه به ارز پایه */
const amountCols = (s: ReportScope) =>
  s.currencyCode
    ? { debit: Prisma.sql`l.debit`, credit: Prisma.sql`l.credit` }
    : { debit: Prisma.sql`l."debitBase"`, credit: Prisma.sql`l."creditBase"` };

// ───────────────────────────────────────────────────────────────
// دفتر روزنامه
// ───────────────────────────────────────────────────────────────

export interface JournalRow {
  entryId: string;
  serial: number | null;
  date: Date;
  description: string;
  entryType: string;
  status: string;
  lineNo: number;
  accountCode: string;
  accountName: string;
  subsidiaryCode: string | null;
  subsidiaryName: string | null;
  costCenterCode: string | null;
  currencyCode: string;
  debit: bigint;
  credit: bigint;
  debitBase: bigint;
  creditBase: bigint;
  memo: string | null;
}

/**
 * دفتر روزنامه — همهٔ اسناد به ترتیب تاریخ و سریال.
 *
 * سریال بدون شکاف است (تضمین موتور ثبت)، پس ترتیب `serial` همان ترتیب قانونی
 * دفتر است و نیازی به شماره‌گذاری دوباره در گزارش نیست.
 */
export interface JournalFilter extends ReportScope {
  q?: string;
  serial?: number;
  /** پیشوندِ کد حساب — «۵» همهٔ گروه ۵ */
  accountCode?: string;
}

export async function journal(tx: Prisma.TransactionClient, s: JournalFilter = {}) {
  return tx.$queryRaw<JournalRow[]>`
    SELECT e.id AS "entryId", e.serial, e.date, e.description,
           e."entryType"::text AS "entryType", e.status::text AS status,
           l."lineNo", a.code AS "accountCode", a.name AS "accountName",
           sub.code AS "subsidiaryCode", sub.name AS "subsidiaryName",
           cc.code AS "costCenterCode",
           l."currencyCode", l.debit, l.credit, l."debitBase", l."creditBase", l.memo
    FROM "GlEntry" e
    JOIN "GlLine" l          ON l."entryId" = e.id
    JOIN "GlAccount" a       ON a.id = l."accountId"
    LEFT JOIN "GlSubsidiary" sub ON sub.id = l."subsidiaryId"
    LEFT JOIN "GlCostCenter" cc  ON cc.id = l."costCenterId"
    WHERE ${scopeWhere(s)}
      ${s.q ? Prisma.sql`AND e.description ILIKE ${'%' + s.q + '%'}` : Prisma.empty}
      ${s.serial ? Prisma.sql`AND e.serial = ${s.serial}` : Prisma.empty}
      ${s.accountCode
        ? Prisma.sql`AND e.id IN (SELECT l2."entryId" FROM "GlLine" l2 JOIN "GlAccount" a2 ON a2.id = l2."accountId" WHERE a2.code LIKE ${s.accountCode + '%'})`
        : Prisma.empty}
    ORDER BY e.date, e.serial, l."lineNo"
  `;
}

// ───────────────────────────────────────────────────────────────
// دفتر کل / معین / تفصیلی
// ───────────────────────────────────────────────────────────────

export interface LedgerRow {
  date: Date;
  serial: number | null;
  description: string;
  memo: string | null;
  subsidiaryName: string | null;
  currencyCode: string;
  /** مبلغ ستونِ scope‌شده (ارز اصلی اگر فیلتر ارز داده شده، وگرنه ریال) */
  debit: bigint;
  credit: bigint;
  /** همیشه هر دو — برای گزارش‌هایی که هم ارز اصلی و هم ریال می‌خواهند */
  debitForeign: bigint;
  creditForeign: bigint;
  debitBase: bigint;
  creditBase: bigint;
  running: bigint;
}

/**
 * گردش یک حساب با **مانده در حال حرکت**.
 *
 * اگر کد یک **سرگروه** باشد (کل یا گروه)، همهٔ نوادگانِ برگش تجمیع می‌شوند
 * (ممیزی ب۸ — پیش از این `WHERE a.code = ?` بود و سرگروه صفر ردیف می‌داد).
 * برای حساب برگ، زیردرخت فقط خودش است و رفتار عوض نمی‌شود.
 *
 * `s.from` مانده پیش از بازه را به‌عنوان نقطهٔ شروع می‌آورد، وگرنه ستون مانده
 * از صفر شروع می‌شود و برای بازه‌های میانی بی‌معنا می‌شود.
 */
export async function accountLedger(
  tx: Prisma.TransactionClient,
  accountCode: string,
  s: ReportScope = {},
  opts: { subsidiaryId?: string } = {},
) {
  const cols = amountCols(s);
  const subFilter = opts.subsidiaryId
    ? Prisma.sql`AND l."subsidiaryId" = ${opts.subsidiaryId}`
    : Prisma.empty;

  // زیردرختِ حساب: خودش + همهٔ نوادگان
  const subtree = Prisma.sql`
    WITH RECURSIVE acc_tree AS (
      SELECT id FROM "GlAccount" WHERE code = ${accountCode}
      UNION ALL
      SELECT c.id FROM "GlAccount" c JOIN acc_tree t ON c."parentId" = t.id
    )
  `;

  // مانده پیش از شروع بازه
  const opening = s.from
    ? await tx.$queryRaw<{ bal: bigint | null }[]>`
        ${subtree}
        SELECT (SUM(${cols.debit}) - SUM(${cols.credit}))::bigint AS bal
        FROM "GlLine" l
        JOIN "GlEntry" e ON e.id = l."entryId"
        WHERE l."accountId" IN (SELECT id FROM acc_tree)
          AND e.status <> 'DRAFT' AND e.date < ${s.from}
          ${s.currencyCode ? Prisma.sql`AND l."currencyCode" = ${s.currencyCode}` : Prisma.empty}
          ${subFilter}
      `
    : [{ bal: 0n }];

  const rows = await tx.$queryRaw<Omit<LedgerRow, 'running'>[]>`
    ${subtree}
    SELECT e.date, e.serial, e.description, l.memo,
           sub.name AS "subsidiaryName", l."currencyCode",
           ${cols.debit} AS debit, ${cols.credit} AS credit,
           l.debit        AS "debitForeign",  l.credit        AS "creditForeign",
           l."debitBase"  AS "debitBase",     l."creditBase"  AS "creditBase"
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    LEFT JOIN "GlSubsidiary" sub ON sub.id = l."subsidiaryId"
    WHERE l."accountId" IN (SELECT id FROM acc_tree) AND ${scopeWhere(s)} ${subFilter}
    ORDER BY e.date, e.serial, l."lineNo"
  `;

  let running = BigInt(opening[0]?.bal ?? 0n);
  const withRunning: LedgerRow[] = rows.map((r) => {
    running += BigInt(r.debit) - BigInt(r.credit);
    return { ...r, running };
  });

  return { openingBalance: BigInt(opening[0]?.bal ?? 0n), rows: withRunning, closingBalance: running };
}

// ───────────────────────────────────────────────────────────────
// تراز آزمایشی
// ───────────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  level: number;
  rootType: string;
  /** سرگروه‌ها تجمیع نوادگانشان‌اند و در جمع ستون‌ها نمی‌آیند */
  isPostable: boolean;
  /** مانده ابتدای دوره */
  openingDebit: bigint;
  openingCredit: bigint;
  /** گردش طی دوره */
  periodDebit: bigint;
  periodCredit: bigint;
  /** گردش تجمعی تا پایان دوره */
  cumulativeDebit: bigint;
  cumulativeCredit: bigint;
  /** مانده پایان دوره */
  closingDebit: bigint;
  closingCredit: bigint;
}

export type TrialBalanceColumns = 2 | 4 | 6 | 8;

/**
 * تراز آزمایشی — یک محاسبه، چهار نمایش.
 *
 * بند ۳-۷ چهار حالت ۲ و ۴ و ۶ و ۸ ستونی می‌خواهد. اینها چهار گزارش متفاوت نیستند،
 * بلکه **زیرمجموعه‌های ستونیِ یک محاسبه‌اند**:
 *
 *   ۲ ستونی → مانده پایان دوره
 *   ۴ ستونی → گردش دوره + مانده پایان
 *   ۶ ستونی → مانده ابتدا + گردش دوره + مانده پایان
 *   ۸ ستونی → مانده ابتدا + گردش دوره + گردش تجمعی + مانده پایان
 *
 * پس یک بار حساب می‌شود و `columns` فقط تعیین می‌کند کدام ستون‌ها برگردند.
 * `level` هم سطح تجمیع را می‌دهد: ۲ برای دفتر کل، ۳ برای معین، ۴ برای تفصیلی.
 */
export async function trialBalance(
  tx: Prisma.TransactionClient,
  s: ReportScope & { level?: number } = {},
  columns: TrialBalanceColumns = 4,
) {
  const cols = amountCols(s);
  const levelFilter = s.level ? Prisma.sql`AND a.level <= ${s.level}` : Prisma.empty;

  // تجمیع روی زیردرخت: هر حساب، جمع خودش و همهٔ نوادگانش
  const rows = await tx.$queryRaw<TrialBalanceRow[]>`
    WITH RECURSIVE tree AS (
      SELECT id AS root, id AS node FROM "GlAccount"
      UNION ALL
      SELECT t.root, c.id FROM "GlAccount" c JOIN tree t ON c."parentId" = t.node
    ),
    movement AS (
      SELECT t.root,
             SUM(CASE WHEN ${s.from ? Prisma.sql`e.date < ${s.from}` : Prisma.sql`FALSE`}
                      THEN ${cols.debit} ELSE 0 END)  AS open_dr,
             SUM(CASE WHEN ${s.from ? Prisma.sql`e.date < ${s.from}` : Prisma.sql`FALSE`}
                      THEN ${cols.credit} ELSE 0 END) AS open_cr,
             SUM(CASE WHEN ${s.from ? Prisma.sql`e.date >= ${s.from}` : Prisma.sql`TRUE`}
                      THEN ${cols.debit} ELSE 0 END)  AS per_dr,
             SUM(CASE WHEN ${s.from ? Prisma.sql`e.date >= ${s.from}` : Prisma.sql`TRUE`}
                      THEN ${cols.credit} ELSE 0 END) AS per_cr
      FROM tree t
      JOIN "GlLine" l  ON l."accountId" = t.node
      JOIN "GlEntry" e ON e.id = l."entryId"
      WHERE e.status <> 'DRAFT'
        ${s.to ? Prisma.sql`AND e.date <= ${s.to}` : Prisma.empty}
        ${s.currencyCode ? Prisma.sql`AND l."currencyCode" = ${s.currencyCode}` : Prisma.empty}
        ${s.costCenterIds?.length
          ? Prisma.sql`AND l."costCenterId" IN (${Prisma.join(s.costCenterIds)})`
          : Prisma.empty}
    ${s.projectIds?.length
      ? Prisma.sql`AND (l."projectId" IN (${Prisma.join(s.projectIds)}) OR l."costCenterId" IN (
          SELECT cc.id FROM "GlCostCenter" cc JOIN "Project" p ON p.code = SUBSTRING(cc.code FROM 3)
          WHERE cc.code LIKE '9.%' AND p.id IN (${Prisma.join(s.projectIds)})))`
      : Prisma.empty}
      GROUP BY t.root
    )
    SELECT a.id AS "accountId", a.code, a.name, a.level, a."rootType"::text AS "rootType",
           a."isPostable" AS "isPostable",
           GREATEST(m.open_dr - m.open_cr, 0)::bigint AS "openingDebit",
           GREATEST(m.open_cr - m.open_dr, 0)::bigint AS "openingCredit",
           m.per_dr::bigint AS "periodDebit",
           m.per_cr::bigint AS "periodCredit",
           (m.open_dr + m.per_dr)::bigint AS "cumulativeDebit",
           (m.open_cr + m.per_cr)::bigint AS "cumulativeCredit",
           GREATEST((m.open_dr + m.per_dr) - (m.open_cr + m.per_cr), 0)::bigint AS "closingDebit",
           GREATEST((m.open_cr + m.per_cr) - (m.open_dr + m.per_dr), 0)::bigint AS "closingCredit"
    FROM movement m
    JOIN "GlAccount" a ON a.id = m.root
    WHERE (m.open_dr + m.open_cr + m.per_dr + m.per_cr) <> 0
      ${levelFilter}
    ORDER BY a.code
  `;

  const keep: Record<TrialBalanceColumns, (keyof TrialBalanceRow)[]> = {
    2: ['closingDebit', 'closingCredit'],
    4: ['periodDebit', 'periodCredit', 'closingDebit', 'closingCredit'],
    6: ['openingDebit', 'openingCredit', 'periodDebit', 'periodCredit', 'closingDebit', 'closingCredit'],
    8: ['openingDebit', 'openingCredit', 'periodDebit', 'periodCredit',
        'cumulativeDebit', 'cumulativeCredit', 'closingDebit', 'closingCredit'],
  };

  /**
   * جمع ستون‌ها فقط روی **برگ‌ها** حساب می‌شود.
   *
   * سطرهای سرگروه، تجمیع نوادگانشان‌اند؛ اگر آن‌ها را هم در جمع بیاوریم هر مبلغ
   * به تعداد سطوح درخت شمرده می‌شود و تراز آزمایشی هرگز تراز درنمی‌آید.
   */
  const leaves = rows.filter((r) => r.isPostable);
  const totals = keep[columns].reduce(
    (acc, k) => ({ ...acc, [k]: leaves.reduce((s2, r) => s2 + BigInt(r[k] as bigint), 0n) }),
    {} as Record<string, bigint>,
  );

  return { columns, valueColumns: keep[columns], rows, totals };
}
