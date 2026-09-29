/**
 * صورت‌های مالی — docs/ACCOUNTING_SPEC.md بند ۳-۷
 *
 * ترازنامه، سود و زیان (با تفکیک مرکز هزینه)، صورت جریان وجوه نقد، و سن‌بندی.
 *
 * همه از **دفتر** محاسبه می‌شوند و هیچ ماندهٔ ذخیره‌شده‌ای در کار نیست (قاعدهٔ ۳).
 * همه هم به **ارز پایه** جمع می‌زنند — نه مبلغ خام. جمع‌زدن دلار و ریال روی هم،
 * ضعفی است که در Bigcapital دیدیم و اینجا تکرار نمی‌شود.
 */
import { Prisma } from '@prisma/client';
import { explicitAllocations } from '../allocation';
import { Minor } from '../money';
import { ReportScope } from './ledgers';
import { EXCLUDE_YEAR_CLOSE } from '../year-close';

// ───────────────────────────────────────────────────────────────
// ترازنامه
// ───────────────────────────────────────────────────────────────

export interface StatementNode {
  code: string;
  name: string;
  level: number;
  rootType: string;
  amount: Minor;
}

/** جمع هر ریشه، با علامت طبیعی خودش */
async function rootTotals(tx: Prisma.TransactionClient, asOf: Date, roots: string[]) {
  return tx.$queryRaw<{ code: string; name: string; level: number; rootType: string; amount: bigint }[]>`
    WITH RECURSIVE tree AS (
      SELECT id AS root, id AS node FROM "GlAccount"
      UNION ALL
      SELECT t.root, c.id FROM "GlAccount" c JOIN tree t ON c."parentId" = t.node
    )
    SELECT a.code, a.name, a.level, a."rootType"::text AS "rootType",
           (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS amount
    FROM tree t
    JOIN "GlLine" l    ON l."accountId" = t.node
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = t.root
    WHERE e.status <> 'DRAFT' AND e.date <= ${asOf}
      AND a."rootType"::text IN (${Prisma.join(roots)})
    GROUP BY a.code, a.name, a.level, a."rootType"
    HAVING SUM(l."debitBase") - SUM(l."creditBase") <> 0
    ORDER BY a.code
  `;
}

/**
 * ترازنامه در یک تاریخ.
 *
 * سود انباشتهٔ **جاری** (درآمد منهای هزینه تا آن تاریخ) به حقوق صاحبان سهام اضافه
 * می‌شود، وگرنه معادله برقرار نمی‌شود — چون حساب‌های موقت هنوز بسته نشده‌اند.
 */
async function balanceSheetAt(tx: Prisma.TransactionClient, asOf: Date) {
  const nodes = await rootTotals(tx, asOf, ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']);

  const sumOf = (rootType: string) =>
    nodes.filter((n) => n.rootType === rootType && n.level === 1)
      .reduce((s, n) => s + BigInt(n.amount), 0n);

  // دارایی ماهیت بدهکار ⇒ مثبت. بدهی و سرمایه ماهیت بستانکار ⇒ علامت برمی‌گردد.
  const assets = sumOf('ASSET');
  const liabilities = -sumOf('LIABILITY');
  const equity = -sumOf('EQUITY');
  const income = -sumOf('INCOME');
  const expense = sumOf('EXPENSE');
  const retained = income - expense;

  const totalLiabEquity = liabilities + equity + retained;
  const difference = assets - totalLiabEquity;

  // ممیزی ج۱۳: زیرجمعِ جاری/غیرجاری از سطح‌دومِ کدینگ (۱۱ جاری، ۱۲ غیرجاری،
  // ۲۱ جاری، ۲۲ بلندمدت). سرمایه در گردش = دارایی جاری − بدهی جاری.
  const level2 = (prefix: string, rootType: string) =>
    nodes.filter((n) => n.rootType === rootType && n.level === 2 && n.code.startsWith(prefix))
      .reduce((s, n) => s + BigInt(n.amount), 0n);
  const currentAssets = level2('11', 'ASSET');
  const nonCurrentAssets = assets - currentAssets;
  const currentLiabilities = -level2('21', 'LIABILITY');
  const longTermLiabilities = -level2('22', 'LIABILITY');

  // ممیزی ج۱۲: بدهی و سرمایه ماهیت بستانکار دارند ⇒ در دفتر منفی‌اند. برای
  // نمایش علامت طبیعی برمی‌گردد. سود دورهٔ بسته‌نشده هم یک سطرِ صریح در سرمایه
  // می‌شود، نه فقط عددی در totals — وگرنه جمعِ ستون با ترازنامه نمی‌خواند.
  const flip = (n: StatementNode) => ({ ...n, amount: -BigInt(n.amount) });
  const equityRows = nodes.filter((n) => n.rootType === 'EQUITY').map(flip);
  if (retained !== 0n) {
    equityRows.push({
      code: '—', name: 'سود (زیان) دورهٔ جاری — بسته‌نشده',
      level: 3, rootType: 'EQUITY', amount: retained,
    });
  }

  return {
    asOf,
    assets: nodes.filter((n) => n.rootType === 'ASSET'),
    liabilities: nodes.filter((n) => n.rootType === 'LIABILITY').map(flip),
    equity: equityRows,
    totals: {
      assets, liabilities, equity, retainedEarnings: retained,
      totalEquity: equity + retained,
      totalLiabilitiesAndEquity: totalLiabEquity,
      // ممیزی ج۱۳
      currentAssets, nonCurrentAssets,
      currentLiabilities, longTermLiabilities,
      workingCapital: currentAssets - currentLiabilities,
    },
    difference,
    balanced: difference === 0n,
  };
}

/**
 * ترازنامه، با **ستون دورهٔ مقایسه‌ای** (ممیزی ب۱۲).
 *
 * صورت سود و زیان از قبل چک‌باکس مقایسه داشت؛ ترازنامه هیچ. صورت مالیِ بدون
 * دورهٔ مقایسه‌ای طبق استانداردهای حسابداری ایران صورت مالی نیست — خواننده
 * نمی‌تواند بگوید مطالبات زیاد شده یا کم.
 *
 * `compareAsOf` اگر داده نشود، پیش‌فرض **یک سال پیش از `asOf`** است — همان
 * چیزی که ترازنامهٔ مقایسه‌ای معمولاً نشان می‌دهد.
 */
export async function balanceSheet(
  tx: Prisma.TransactionClient,
  asOf: Date,
  opts: { compareAsOf?: Date | null; compare?: boolean } = {},
) {
  const main = await balanceSheetAt(tx, asOf);
  if (opts.compare === false) return main;

  const prevDate = opts.compareAsOf ?? new Date(Date.UTC(
    asOf.getUTCFullYear() - 1, asOf.getUTCMonth(), asOf.getUTCDate(),
  ));
  const prev = await balanceSheetAt(tx, prevDate);

  /** ماندهٔ همان کد در دورهٔ قبل — برای ستون کنارِ هر سطر */
  const priorOf = (rows: { code: string; amount: bigint }[]) => {
    const m = new Map(rows.map((r) => [r.code, r.amount]));
    return (code: string) => m.get(code) ?? 0n;
  };
  const pa = priorOf(prev.assets as any);
  const pl = priorOf(prev.liabilities as any);
  const pe = priorOf(prev.equity as any);

  return {
    ...main,
    assets: main.assets.map((n: any) => ({ ...n, prior: pa(n.code) })),
    liabilities: main.liabilities.map((n: any) => ({ ...n, prior: pl(n.code) })),
    equity: main.equity.map((n: any) => ({ ...n, prior: pe(n.code) })),
    compareAsOf: prevDate,
    comparison: { totals: prev.totals },
  };
}

// ───────────────────────────────────────────────────────────────
// نسبت‌های مالی (ممیزی ب۱۱)
// ───────────────────────────────────────────────────────────────

/**
 * نسبت‌های مالیِ پایه — دادهٔ همه‌شان از قبل در دفتر بود و فقط محاسبه نشده بود.
 *
 * همه‌جا با **عدد صحیح** کار می‌شود تا هیچ مبلغی از مسیر شناور رد نشود؛ خودِ
 * نسبت‌ها با چهار رقم اعشار به‌صورت رشته برمی‌گردند (`'1.8342'`) و لایهٔ نمایش
 * تصمیم می‌گیرد چطور گردشان کند.
 *
 * `null` یعنی «قابل محاسبه نیست» (مخرج صفر) — نه صفر. تفاوتش مهم است: نسبت
 * جاریِ صفر یعنی فاجعه، نسبت جاریِ محاسبه‌نشده یعنی هنوز بدهی جاری نداریم.
 */
export interface FinancialRatios {
  asOf: Date;
  from: Date | null;
  to: Date;
  liquidity: { currentRatio: string | null; quickRatio: string | null; workingCapital: string };
  activity: {
    receivableTurnover: string | null;
    daysSalesOutstanding: string | null;
    /** طول واقعی دوره — مبنای تبدیل گردش به روز (ممیزی ن۲) */
    periodDays: number;
    payableTurnover: string | null;
    daysPayableOutstanding: string | null;
  };
  profitability: {
    grossMargin: string | null;
    operatingMargin: string | null;
    netMargin: string | null;
    returnOnEquity: string | null;
  };
  leverage: { debtToEquity: string | null; debtToAssets: string | null };
  inputs: Record<string, string>;
  /**
   * وضعیت موجودی کالا — تفاوتِ «نداریم» با «نمی‌سنجیم».
   *
   * نسبت آنی وقتی با نسبت جاری یکی درمی‌آید که موجودی کالا صفر باشد. دو
   * دلیلِ کاملاً متفاوت می‌تواند داشته باشد:
   *
   *  • **شرکت خدماتی است و اصلاً کالا ندارد** — آن‌وقت این تساوی درست است
   *    و هیچ هشداری لازم ندارد. مرجعِ این تشخیص، فعال/غیرفعال بودنِ حساب
   *    ۱۱۰۶ در چارت است: غیرفعال کردنِ حساب، همان زبانی است که حسابداری
   *    برای «این قلم به ما ربط ندارد» دارد. تنظیمِ تازه‌ای اختراع نکردیم.
   *
   *  • **شرکت کالا دارد ولی هیچ ماژولی به ۱۱۰۶ سند نمی‌زند** — آن‌وقت نسبت
   *    آنی نقدشوندگی را بیش از واقع نشان می‌دهد و باید هشدار بدهد.
   *
   * `posted` از **ردیف‌های دفتر** می‌آید نه از مانده: ماندهٔ صفر می‌تواند
   * نتیجهٔ «خریدیم و کاملاً فروختیم» باشد که فرق دارد با نبودِ ماژول.
   */
  inventory: { applicable: boolean; posted: boolean };
}

/** تقسیم با ۴ رقم اعشار روی عدد صحیح — بدون شناور */
function ratio(num: bigint, den: bigint): string | null {
  if (den === 0n) return null;
  const neg = (num < 0n) !== (den < 0n);
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const scaled = (a * 10000n) / b;
  const str = `${scaled / 10000n}.${(scaled % 10000n).toString().padStart(4, '0')}`;
  return neg ? `-${str}` : str;
}

export async function financialRatios(
  tx: Prisma.TransactionClient,
  s: { from?: Date; to?: Date } = {},
): Promise<FinancialRatios> {
  const to = s.to ?? new Date();
  const bs: any = await balanceSheetAt(tx, to);
  const is: any = await isPeriod(tx, { from: s.from, to });

  const t = bs.totals;
  const p = is.totals;

  // موجودی کالا: تنها قلم غیرسریعِ دارایی جاری در این چارت (۱۱۰۶)
  const inventoryRow = (bs.assets as any[]).find((a) => a.code === '1106');
  const inventory = inventoryRow ? BigInt(inventoryRow.amount) : 0n;
  const quickAssets = t.currentAssets - inventory;

  // حسابِ ۱۱۰۶ غیرفعال = «ما کالا نداریم» (شرکت خدماتی). نبودنش هم همان.
  const inventoryAccount = await tx.glAccount.findUnique({
    where: { code: '1106' }, select: { isActive: true },
  });
  const inventoryLines = await tx.glLine.count({
    where: { account: { code: { startsWith: '1106' } } },
  });

  const receivable = (bs.assets as any[]).find((a) => a.code === '1104');
  const payable = (bs.liabilities as any[]).find((a) => a.code === '2101');
  const ar = receivable ? BigInt(receivable.amount) : 0n;
  const ap = payable ? BigInt(payable.amount) : 0n;

  const totalEquity: bigint = t.totalEquity;
  const totalDebt: bigint = t.liabilities;

  // گردش = فروش ÷ ماندهٔ پایان دوره. ماندهٔ متوسط دقیق‌تر است ولی ماندهٔ ابتدای
  // دوره را فقط وقتی می‌شود گرفت که `from` داده شده باشد؛ سادگی بر دقتِ ظاهری
  // ترجیح داده شد و فرمول در UI نوشته می‌شود.
  const arTurns = ratio(p.revenue, ar);
  const apTurns = ratio(p.cogs, ap);

  /**
   * ⚠️ ممیزی ن۲ — دورهٔ ناقص سالانه می‌شود.
   *
   * پیش‌تر گردش (که از فروشِ **از ابتدای سال** ساخته می‌شود) بی‌واسطه در ۳۶۵
   * ضرب می‌شد. در شهریور یعنی فروشِ ۱۶۸ روز در برابر ۳۶۵ روز — و دورهٔ وصول
   * مطالبات ۳۶۱ روز گزارش می‌شد در حالی که عدد واقعی حدود ۱۶۶ روز بود.
   * عددی که از خودِ عمرِ دوره بزرگ‌تر باشد، تفسیرپذیر نیست.
   *
   * حالا از **طول واقعی دوره** استفاده می‌شود: `روزهای دوره ÷ گردش`.
   */
  const periodDays = s.from
    ? Math.max(1, Math.round((to.getTime() - s.from.getTime()) / 86_400_000) + 1)
    : 365;
  const days = (turns: string | null) =>
    turns === null || Number(turns) === 0
      ? null
      : ratio(BigInt(periodDays * 100), BigInt(Math.round(Number(turns) * 100)));

  return {
    asOf: to,
    from: s.from ?? null,
    to,
    liquidity: {
      currentRatio: ratio(t.currentAssets, t.currentLiabilities),
      quickRatio: ratio(quickAssets, t.currentLiabilities),
      workingCapital: t.workingCapital.toString(),
    },
    activity: {
      receivableTurnover: arTurns,
      daysSalesOutstanding: days(arTurns),
      payableTurnover: apTurns,
      daysPayableOutstanding: days(apTurns),
      /** طول واقعی دوره — مبنای تبدیل گردش به روز (ممیزی ن۲) */
      periodDays,
    },
    profitability: {
      grossMargin: ratio(p.grossProfit, p.revenue),
      operatingMargin: ratio(p.operatingProfit, p.revenue),
      netMargin: ratio(p.netProfit, p.revenue),
      returnOnEquity: ratio(p.netProfit, totalEquity),
    },
    inventory: { applicable: inventoryAccount?.isActive === true, posted: inventoryLines > 0 },
    leverage: {
      debtToEquity: ratio(totalDebt, totalEquity),
      debtToAssets: ratio(totalDebt, t.assets),
    },
    inputs: {
      currentAssets: t.currentAssets.toString(),
      currentLiabilities: t.currentLiabilities.toString(),
      inventory: inventory.toString(),
      receivable: ar.toString(),
      payable: ap.toString(),
      totalAssets: t.assets.toString(),
      totalDebt: totalDebt.toString(),
      totalEquity: totalEquity.toString(),
      revenue: p.revenue.toString(),
      cogs: p.cogs.toString(),
      grossProfit: p.grossProfit.toString(),
      operatingProfit: p.operatingProfit.toString(),
      netProfit: p.netProfit.toString(),
    },
  };
}

// ───────────────────────────────────────────────────────────────
// صورت سود و زیان
// ───────────────────────────────────────────────────────────────

/**
 * سود و زیان، با تفکیک اختیاری به مرکز هزینه (بند ۳-۲).
 *
 * ساختار سرفصل‌ها معنا را می‌سازد:
 *   ۴ فروش − ۵ بهای تمام‌شده  = سود ناخالص
 *   − ۶ اداری − ۷ مالی        = سود عملیاتی
 *   ± ۸ غیرعملیاتی            = سود خالص
 */
export interface IncomeStatementScope extends ReportScope {
  byCostCenter?: boolean;
  /** ردیف‌های سطح معین را هم برگردان (ممیزی ج۱۱) */
  byAccount?: boolean;
  /** دورهٔ مقایسه‌ای — همان جمع‌ها برای بازهٔ دیگر (ممیزی ج۱۱) */
  compareFrom?: Date;
  compareTo?: Date;
}

/** جمع‌های یک بازه — هستهٔ مشترکِ دورهٔ اصلی و دورهٔ مقایسه */
async function isPeriod(
  tx: Prisma.TransactionClient,
  s: {
    from?: Date; to?: Date; costCenterIds?: string[];
    byCostCenter?: boolean; byAccount?: boolean;
    /** فقط ردیف‌های بدون مرکز هزینه — برای محاسبهٔ سهمِ تخصیص‌نیافته */
    onlyUnallocated?: boolean;
  },
) {
  /**
   * فیلترِ مرکز هزینه — **سخت‌گیر** (ممیزی ن۴).
   *
   * تلاش اولِ رفعِ ب۵ شرطِ `OR l."costCenterId" IS NULL` را اضافه کرد تا گزارش
   * «صفرِ دروغین» ندهد. ولی چون تقریباً همهٔ ردیف‌ها مرکز هزینه ندارند، فیلتر
   * عملاً از کار افتاد: فیلتر روی «تولید»، «فروش»، «اداری» و «پروژه‌ها» همگی
   * **عین اعدادِ کلِ شرکت** را برمی‌گرداندند. این از حالت قبل بدتر است — صفر
   * بودنِ گزارش خرابی را لو می‌داد، ولی عددِ معقولِ غلط لو نمی‌دهد.
   *
   * راه درست: فیلتر واقعاً فیلتر کند، و گزارش **صریحاً** بگوید چقدر به هیچ
   * مرکزی تخصیص نیافته (`unallocated` در پاسخ). آن‌وقت خواننده می‌داند گزارش
   * جزئی است و چقدر جزئی.
   */
  const ccFilter = s.onlyUnallocated
    ? Prisma.sql`AND l."costCenterId" IS NULL`
    : s.costCenterIds?.length
      ? Prisma.sql`AND l."costCenterId" IN (${Prisma.join(s.costCenterIds)})`
      : Prisma.empty;
  const dateFilter = Prisma.sql`
    ${s.from ? Prisma.sql`AND e.date >= ${s.from}` : Prisma.empty}
    ${s.to ? Prisma.sql`AND e.date <= ${s.to}` : Prisma.empty}`;

  /**
   * ⚠️ ماشینِ بستن سال از صورت سود و زیان بیرون می‌ماند (ممیزی دوم — ن۱-ب).
   *
   * سند اختتامیه با تاریخِ **آخرین روزِ همان سال** ثبت می‌شود و همهٔ حساب‌های موقت
   * را صفر می‌کند. چون این تاریخ داخل بازهٔ گزارشِ همان سال است، بدون این فیلتر
   * صورت سود و زیانِ سالِ بسته‌شده **صفر** برمی‌گشت: درآمد ۶۰۰٬۰۰۰٬۰۰۰ ⟵ ۰.
   *
   * فیلتر روی `sourceType` است نه ترکیبِ آن با `entryType` — دلیلش (و باگی که
   * نسخهٔ اولِ همین فیلتر داشت) در `year-close.ts` کنار `EXCLUDE_YEAR_CLOSE`
   * مکتوب است: آینهٔ برگشتیِ سند اختتامیه `REVERSING` است نه `CLOSING`.
   *
   * دفتر روزنامه و تراز آزمایشی این اسناد را نشان می‌دهند — پنهان نمی‌شوند.
   */
  const closingFilter = EXCLUDE_YEAR_CLOSE;

  const rows = await tx.$queryRaw<
    { code: string; name: string; rootType: string; costCenterCode: string | null;
      costCenterName: string | null; amount: bigint }[]
  >`
    SELECT root.code, root.name, root."rootType"::text AS "rootType",
           ${s.byCostCenter ? Prisma.sql`cc.code` : Prisma.sql`NULL::text`} AS "costCenterCode",
           ${s.byCostCenter ? Prisma.sql`cc.name` : Prisma.sql`NULL::text`} AS "costCenterName",
           (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS amount
    FROM "GlLine" l
    JOIN "GlEntry" e    ON e.id = l."entryId"
    JOIN "GlAccount" a  ON a.id = l."accountId"
    JOIN "GlAccount" root ON root.code = LEFT(a.code, 1) AND root.level = 1
    LEFT JOIN "GlCostCenter" cc ON cc.id = l."costCenterId"
    WHERE e.status <> 'DRAFT' AND a."statement" = 'INCOME_STATEMENT'
      ${dateFilter} ${ccFilter} ${closingFilter}
    GROUP BY root.code, root.name, root."rootType"
      ${s.byCostCenter ? Prisma.sql`, cc.code, cc.name` : Prisma.empty}
    ORDER BY root.code
  `;

  // ممیزی ج۱۱: تفکیک سطح معین — هر حساب گروهِ ۴ تا ۸ با ماندهٔ غیرصفر
  const accounts = s.byAccount
    ? await tx.$queryRaw<{ rootCode: string; code: string; name: string; amount: bigint }[]>`
        SELECT LEFT(a.code, 1) AS "rootCode", a.code, a.name,
               (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS amount
        FROM "GlLine" l
        JOIN "GlEntry" e   ON e.id = l."entryId"
        JOIN "GlAccount" a ON a.id = l."accountId"
        WHERE e.status <> 'DRAFT' AND a."statement" = 'INCOME_STATEMENT'
          ${dateFilter} ${ccFilter} ${closingFilter}
        GROUP BY a.code, a.name
        HAVING SUM(l."debitBase") - SUM(l."creditBase") <> 0
        ORDER BY a.code
      `
    : [];

  const signed = (code: string) => {
    const raw = rows.filter((r) => r.code === code).reduce((sum, r) => sum + BigInt(r.amount), 0n);
    return code === '4' || code === '8' ? -raw : raw;
  };
  const taxRow = await tx.$queryRaw<{ amount: bigint | null }[]>`
    SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS amount
    FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'DRAFT' AND a.code = '8205' ${dateFilter} ${ccFilter} ${closingFilter}
  `;
  const taxExpense = BigInt(taxRow[0]?.amount ?? 0n);

  const revenue = signed('4');
  const cogs = signed('5');
  const admin = signed('6');
  const financial = signed('7');
  const nonOperating = signed('8') + taxExpense;
  const grossProfit = revenue - cogs;
  const operatingProfit = grossProfit - admin - financial;
  const profitBeforeTax = operatingProfit + nonOperating;
  const netProfit = profitBeforeTax - taxExpense;

  return {
    lines: rows,
    accounts: accounts.map((a) => ({
      rootCode: a.rootCode, code: a.code, name: a.name,
      // درآمد و غیرعملیاتی ماهیت بستانکار — علامتِ نمایشی برمی‌گردد
      amount: (a.rootCode === '4' || a.rootCode === '8') ? -BigInt(a.amount) : BigInt(a.amount),
    })),
    totals: {
      revenue, cogs, grossProfit, admin, financial, operatingProfit,
      nonOperating, profitBeforeTax, taxExpense, netProfit,
    },
  };
}

/**
 * سود و زیان، با تفکیک اختیاری به مرکز هزینه (بند ۳-۲).
 *
 * ساختار سرفصل‌ها معنا را می‌سازد:
 *   ۴ فروش − ۵ بهای تمام‌شده  = سود ناخالص
 *   − ۶ اداری − ۷ مالی        = سود عملیاتی
 *   ± ۸ غیرعملیاتی            = سود خالص
 *
 * ممیزی ج۱۱: `byAccount` تفکیک معین می‌دهد؛ `compareFrom/compareTo` ستون مقایسه.
 */
export async function incomeStatement(
  tx: Prisma.TransactionClient,
  s: IncomeStatementScope = {},
) {
  const main = await isPeriod(tx, s);
  const comparison = s.compareFrom || s.compareTo
    ? await isPeriod(tx, {
        from: s.compareFrom, to: s.compareTo,
        costCenterIds: s.costCenterIds, byCostCenter: s.byCostCenter, byAccount: s.byAccount,
      })
    : null;

  // ممیزی ن۴: وقتی گزارش به مرکز هزینه محدود شده، سهمِ تخصیص‌نیافته هم گزارش
  // می‌شود — وگرنه خواننده نمی‌فهمد چه بخشی از شرکت اصلاً در این عدد نیست.
  const unallocated = s.costCenterIds?.length
    ? (await isPeriod(tx, { from: s.from, to: s.to, onlyUnallocated: true })).totals
    : null;

  return {
    from: s.from, to: s.to,
    lines: main.lines,
    accounts: main.accounts,
    totals: main.totals,
    ...(unallocated ? { unallocated } : {}),
    ...(comparison
      ? {
          compareFrom: s.compareFrom, compareTo: s.compareTo,
          comparison: { accounts: comparison.accounts, totals: comparison.totals },
        }
      : {}),
  };
}

// ───────────────────────────────────────────────────────────────
// صورت جریان وجوه نقد
// ───────────────────────────────────────────────────────────────

export type CashFlowCategory = 'OPERATING' | 'INVESTING' | 'FINANCING';

/**
 * طبقه‌بندی جریان نقدی بر پایهٔ **حساب طرف مقابل**.
 *
 * روش مستقیم: هر حرکت نقدی را می‌گیریم و از روی سرفصلِ طرف مقابلش دسته‌بندی می‌کنیم.
 * برای یک شرکت بازرگانی این از روش غیرمستقیم صادق‌تر است، چون سود خالص را با
 * تعدیل‌های حدسی به نقد تبدیل نمی‌کند.
 *
 * قاعده‌ها صریح‌اند تا قابل بحث باشند:
 *   ۱۲ دارایی غیرجاری   → سرمایه‌گذاری
 *   ۲۲ بدهی بلندمدت، ۳ سرمایه → تأمین مالی
 *   بقیه (درآمد، هزینه، دریافتنی، پرداختنی، پیش‌پرداخت) → عملیاتی
 */
export function classifyCounterpart(code: string): CashFlowCategory {
  if (code.startsWith('12')) return 'INVESTING';
  if (code.startsWith('22') || code.startsWith('3')) return 'FINANCING';
  return 'OPERATING';
}

/** حساب‌های نقد و بانک — زیردرخت ۱۱۰۱ */
const CASH_ROOT = '1101';

export async function cashFlow(tx: Prisma.TransactionClient, s: { from: Date; to: Date }) {
  /**
   * هر سند نقدی: سمت نقد و سمت‌های غیرنقد. جریان هر سند به نسبت سمت‌های
   * غیرنقدش دسته‌بندی می‌شود. برای اسناد ساده (دو ردیفی) این دقیق است؛ برای
   * اسناد چندردیفی، سهم هر طرف مقابل به نسبت مبلغش تخصیص می‌یابد.
   */
  const rows = await tx.$queryRaw<{ counterCode: string; amount: bigint }[]>`
    WITH RECURSIVE cash_tree AS (
      SELECT id FROM "GlAccount" WHERE code = ${CASH_ROOT}
      UNION ALL
      SELECT c.id FROM "GlAccount" c JOIN cash_tree t ON c."parentId" = t.id
    ),
    cash_entries AS (
      SELECT l."entryId",
             SUM(l."debitBase" - l."creditBase") AS net_cash
      FROM "GlLine" l
      JOIN "GlEntry" e ON e.id = l."entryId"
      WHERE l."accountId" IN (SELECT id FROM cash_tree)
        AND e.status <> 'DRAFT' AND e.date >= ${s.from} AND e.date <= ${s.to}
      GROUP BY l."entryId"
      HAVING SUM(l."debitBase" - l."creditBase") <> 0
    ),
    counterparts AS (
      SELECT ce."entryId", ce.net_cash, a.code AS counter_code,
             (l."creditBase" - l."debitBase") AS weight
      FROM cash_entries ce
      JOIN "GlLine" l    ON l."entryId" = ce."entryId"
      JOIN "GlAccount" a ON a.id = l."accountId"
      WHERE l."accountId" NOT IN (SELECT id FROM cash_tree)
    ),
    -- پنجره باید در یک لایهٔ جدا حساب شود؛ PostgreSQL اجازه نمی‌دهد
    -- تابع پنجره‌ای داخل تابع تجمیعی بیاید.
    weighted AS (
      SELECT counter_code, net_cash, weight,
             SUM(weight) OVER (PARTITION BY "entryId") AS total_weight
      FROM counterparts
    )
    SELECT counter_code AS "counterCode",
           SUM(net_cash * weight / NULLIF(total_weight, 0))::bigint AS amount
    FROM weighted
    GROUP BY counter_code
  `;

  const buckets: Record<CashFlowCategory, bigint> = { OPERATING: 0n, INVESTING: 0n, FINANCING: 0n };
  const detail: { counterCode: string; category: CashFlowCategory; amount: bigint }[] = [];

  for (const r of rows) {
    const category = classifyCounterpart(r.counterCode);
    const amount = BigInt(r.amount ?? 0n);
    buckets[category] += amount;
    detail.push({ counterCode: r.counterCode, category, amount });
  }

  // بازبینی: ماندهٔ ابتدای دوره + جریان دوره = ماندهٔ انتهای دوره (ممیزی ج۱۳)
  const bal = await tx.$queryRaw<{ opening: bigint | null; closing: bigint | null; change: bigint | null }[]>`
    WITH RECURSIVE cash_tree AS (
      SELECT id FROM "GlAccount" WHERE code = ${CASH_ROOT}
      UNION ALL
      SELECT c.id FROM "GlAccount" c JOIN cash_tree t ON c."parentId" = t.id
    )
    SELECT
      COALESCE(SUM(l."debitBase" - l."creditBase") FILTER (WHERE e.date < ${s.from}), 0)::bigint AS opening,
      COALESCE(SUM(l."debitBase" - l."creditBase") FILTER (WHERE e.date <= ${s.to}), 0)::bigint AS closing,
      COALESCE(SUM(l."debitBase" - l."creditBase") FILTER (WHERE e.date >= ${s.from} AND e.date <= ${s.to}), 0)::bigint AS change
    FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE l."accountId" IN (SELECT id FROM cash_tree) AND e.status <> 'DRAFT'
  `;

  const openingCash = BigInt(bal[0]?.opening ?? 0n);
  const closingCash = BigInt(bal[0]?.closing ?? 0n);
  const netChange = BigInt(bal[0]?.change ?? 0n);
  const classified = buckets.OPERATING + buckets.INVESTING + buckets.FINANCING;

  return {
    from: s.from, to: s.to,
    operating: buckets.OPERATING,
    investing: buckets.INVESTING,
    financing: buckets.FINANCING,
    netChange,
    openingCash,
    closingCash,
    /** باید صفر باشد: ماندهٔ ابتدا + جریان − ماندهٔ انتها */
    reconciliation: openingCash + netChange - closingCash,
    detail,
    /** اگر صفر نباشد، طبقه‌بندی چیزی را جا انداخته — باید صریح دیده شود */
    unclassified: netChange - classified,
  };
}

// ───────────────────────────────────────────────────────────────
// سودآوری پروژه — بر پایهٔ مرکز هزینهٔ «۹.<کد پروژه>»
// ───────────────────────────────────────────────────────────────

/**
 * سود و زیانِ هر پروژه.
 *
 * درآمد (گروه ۴) منهای هزینه‌ها (گروه ۵ تا ۸) به تفکیک پروژه.
 *
 * ─── چرا دو منبع، نه یکی ─────────────────────────────────────────────
 *
 * از این پس ردیف سند خودش `projectId` دارد (بند ۲۸ ALIP). ولی ردیف‌هایی که
 * **پیش از** افزودن آن ستون ثبت شده‌اند، پروژه‌شان را در قالب مرکز هزینهٔ
 * سایهٔ `9.<کد پروژه>` حمل می‌کنند.
 *
 * ⚠️ چرا داده‌های قدیمی مهاجرت داده نشدند: تریگر `gl_line_immutable` هر
 * تغییری روی ردیفِ سندِ ثبت‌شده را رد می‌کند — حتی پرکردنِ ستونی که NULL
 * است. همان کنترلی که کل ممیزی رویش حساب کرد؛ تضعیفش برای یک راحتی
 * گزارشی، معامله‌ای بد است.
 *
 * پس ترجمه در **زمان گزارش** انجام می‌شود: `COALESCE` بین بُعد واقعی و
 * پروژه‌ای که کد مرکز سایه به آن اشاره می‌کند. تاریخ دست‌نخورده می‌ماند و
 * گزارش کامل است.
 */
export async function projectProfitability(
  tx: Prisma.TransactionClient,
  s: { from?: Date; to?: Date; projectIds?: string[] } = {},
) {
  const rows = await tx.$queryRaw<
    { projectId: string; code: string; name: string; rootCode: string; amount: bigint }[]
  >`
    SELECT p.id AS "projectId", p.code,
           COALESCE(NULLIF(p.description, ''), p.code) AS name,
           LEFT(a.code, 1) AS "rootCode",
           (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS amount
    FROM "GlLine" l
    JOIN "GlEntry" e         ON e.id = l."entryId"
    JOIN "GlAccount" a       ON a.id = l."accountId"
    LEFT JOIN "GlCostCenter" cc ON cc.id = l."costCenterId"
    -- بُعد واقعی، وگرنه پروژه‌ای که مرکز هزینهٔ سایه به آن اشاره دارد
    JOIN "Project" p ON p.id = COALESCE(
      l."projectId",
      (SELECT p2.id FROM "Project" p2
        WHERE cc.code LIKE '9.%' AND p2.code = SUBSTRING(cc.code FROM 3))
    )
    WHERE e.status <> 'DRAFT'
      AND a."statement" = 'INCOME_STATEMENT'
      ${s.projectIds?.length ? Prisma.sql`AND p.id IN (${Prisma.join(s.projectIds)})` : Prisma.empty}
      ${s.from ? Prisma.sql`AND e.date >= ${s.from}` : Prisma.empty}
      ${s.to ? Prisma.sql`AND e.date <= ${s.to}` : Prisma.empty}
    GROUP BY p.id, p.code, p.description, LEFT(a.code, 1)
  `;

  const byProject = new Map<string, { id: string; code: string; name: string; revenue: bigint; cogs: bigint; otherExpense: bigint }>();
  for (const r of rows) {
    const p = byProject.get(r.projectId)
      ?? { id: r.projectId, code: r.code, name: r.name, revenue: 0n, cogs: 0n, otherExpense: 0n };
    const amt = BigInt(r.amount);
    if (r.rootCode === '4') p.revenue += -amt;               // درآمد ماهیت بستانکار
    else if (r.rootCode === '5') p.cogs += amt;
    else p.otherExpense += amt;                              // ۶/۷/۸
    byProject.set(r.projectId, p);
  }

  const projects = [...byProject.values()]
    .map((p) => ({
      ...p,
      grossProfit: p.revenue - p.cogs,
      netProfit: p.revenue - p.cogs - p.otherExpense,
      margin: p.revenue > 0n ? Number((p.revenue - p.cogs - p.otherExpense) * 10000n / p.revenue) / 100 : null,
    }))
    .sort((a, b) => (b.revenue > a.revenue ? 1 : b.revenue < a.revenue ? -1 : 0));

  const totals = projects.reduce(
    (s2, p) => ({
      revenue: s2.revenue + p.revenue, cogs: s2.cogs + p.cogs,
      otherExpense: s2.otherExpense + p.otherExpense,
      grossProfit: s2.grossProfit + p.grossProfit, netProfit: s2.netProfit + p.netProfit,
    }),
    { revenue: 0n, cogs: 0n, otherExpense: 0n, grossProfit: 0n, netProfit: 0n },
  );

  return { from: s.from, to: s.to, projects, totals };
}

// ───────────────────────────────────────────────────────────────
// سن‌بندی — تخصیص FIFO
// ───────────────────────────────────────────────────────────────

export const AGING_BUCKETS = [
  { key: '0-30', label: 'تا ۳۰ روز', maxDays: 30 },
  { key: '31-60', label: '۳۱ تا ۶۰ روز', maxDays: 60 },
  { key: '61-90', label: '۶۱ تا ۹۰ روز', maxDays: 90 },
  { key: '90+', label: 'بیش از ۹۰ روز', maxDays: Number.POSITIVE_INFINITY },
] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number]['key'];

/**
 * سن‌بندی — **تخصیصِ صریح اول، FIFO برای بقیه** (مرحلهٔ ۴ ج).
 *
 * تا پیش از این فقط FIFO بود: هر دریافتی قدیمی‌ترین تعهد باز را می‌بست. برای
 * دریافت‌هایی که نمی‌دانیم بابت چه بوده‌اند، این بهترین حدسِ ممکن است و
 * می‌ماند. ولی وقتی کاربر **گفته** که این پرداخت بابت آن فاکتور است، حدس زدن
 * دیگر غلط است — فاکتورِ پرداخت‌شده در سطل ۹۰+ می‌ماند و فاکتورِ تازه بسته
 * نشان داده می‌شود.
 *
 * پس دو مرحله: نخست تخصیص‌های صریح از هر دو سرِ خودشان کم می‌شوند، بعد
 * ماندهٔ تخصیص‌نیافتهٔ تسویه‌ها با FIFO روی ماندهٔ تخصیص‌نیافتهٔ تعهدها
 * می‌نشیند. `explicitCoverage` می‌گوید چه سهمی از تسویه‌ها صریح بوده، تا
 * خواننده بداند این گزارش چقدر «حدس» است.
 *
 * بدون FIFO، سن‌بندی یعنی «کل مانده به تاریخ آخرین سند» که هیچ اطلاعاتی نمی‌دهد.
 *
 * ⚠️ سن از **تاریخ سند** خوانده می‌شود نه تاریخ درج. یک بار در هستهٔ قدیمی
 * بازسازی دفاتر تاریخ همهٔ فاکتورها را به امروز برد و همه‌چیز «۱ روزه» شد.
 */
export async function aging(
  tx: Prisma.TransactionClient,
  accountCode: string,
  asOf: Date,
  opts: { subsidiaryId?: string | null } = {},
) {
  // محدودکردن به یک طرف‌حساب امن است چون صف‌های FIFO از ابتدا per-party بودند —
  // حذف بقیه هیچ تخصیصی را جابه‌جا نمی‌کند (پروندهٔ طرف‌حساب، ج۱).
  const partyFilter = opts.subsidiaryId
    ? Prisma.sql`AND l."subsidiaryId" = ${opts.subsidiaryId}`
    : Prisma.empty;

  const lines = await tx.$queryRaw<
    { id: string; subsidiaryId: string; code: string; name: string; currencyCode: string;
      date: Date; delta: bigint; deltaBase: bigint }[]
  >`
    SELECT l.id, l."subsidiaryId", s.code, s.name, l."currencyCode", e.date,
           (l.debit - l.credit)::bigint             AS delta,
           (l."debitBase" - l."creditBase")::bigint AS "deltaBase"
    FROM "GlLine" l
    JOIN "GlEntry" e      ON e.id = l."entryId"
    JOIN "GlAccount" a    ON a.id = l."accountId"
    JOIN "GlSubsidiary" s ON s.id = l."subsidiaryId"
    WHERE a.code = ${accountCode} AND e.status <> 'DRAFT' AND e.date <= ${asOf}
      ${partyFilter}
    ORDER BY e.date, e.serial, l."lineNo"
  `;

  // تخصیص‌های صریح — پیش از FIFO از هر دو سر کم می‌شوند
  const { byObligation, bySettlement } = await explicitAllocations(tx, accountCode, asOf);

  const account = await tx.glAccount.findUniqueOrThrow({ where: { code: accountCode } });
  const sign = account.normalSide === 'DEBIT' ? 1n : -1n;
  const dayMs = 86_400_000;

  type Open = { date: Date; amount: bigint; base: bigint };
  const queues = new Map<string, { meta: { code: string; name: string; currencyCode: string; subsidiaryId: string }; open: Open[] }>();

  let settlementTotal = 0n, explicitTotal = 0n;

  for (const l of lines) {
    const key = `${l.subsidiaryId}|${l.currencyCode}`;
    const q = queues.get(key) ?? {
      meta: { code: l.code, name: l.name, currencyCode: l.currencyCode, subsidiaryId: l.subsidiaryId },
      open: [] as Open[],
    };
    queues.set(key, q);

    const delta = BigInt(l.delta) * sign;
    const base = BigInt(l.deltaBase) * sign;

    if (delta > 0n) {
      // تعهد: آن بخشی که تخصیصِ صریح خورده از همین‌جا کنار می‌رود و اصلاً وارد
      // صف نمی‌شود — نه در سطل سنی می‌نشیند نه FIFO می‌تواند دوباره ببنددش.
      const explicit = byObligation.get(l.id) ?? 0n;
      const remaining = delta - explicit;
      if (remaining <= 0n) continue;
      // ارزش پایه به همان نسبت کم می‌شود تا بهای تمام‌شده سازگار بماند
      q.open.push({ date: l.date, amount: remaining, base: (base * remaining) / delta });
      continue;
    }

    // تسویه: بخشِ صریحش قبلاً از تعهدِ خودش کم شده، پس فقط بقیه FIFO می‌شود
    const gross = -delta;
    const explicit = bySettlement.get(l.id) ?? 0n;
    settlementTotal += gross;
    explicitTotal += explicit < gross ? explicit : gross;

    let pay = gross - explicit;
    if (pay < 0n) pay = 0n;
    while (pay > 0n && q.open.length) {
      const head = q.open[0];
      const take = head.amount < pay ? head.amount : pay;
      head.base -= (head.base * take) / head.amount;
      head.amount -= take;
      pay -= take;
      if (head.amount <= 0n) q.open.shift();
    }
    // مازاد تسویه (پیش‌پرداخت) به‌عنوان تعهد منفی نگه داشته می‌شود
    if (pay > 0n) q.open.push({ date: l.date, amount: -pay, base: -pay });
  }

  const emptyBuckets = () => Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0n])) as Record<AgingBucket, bigint>;

  // صف‌ها به تفکیک (طرف‌حساب × ارز) بسته شدند — و باید همین‌طور می‌ماندند،
  // چون یک دریافتِ دلاری فاکتورِ ریالی را نمی‌بندد. ولی **نمایش** به تفکیک ارز
  // اشتباه بود: یک مشتری با سه ارز سه ردیف می‌گرفت، پاورقی «۳ طرف‌حساب»
  // می‌گفت، و مرتب‌سازی بر اساس بزرگ‌ترین بدهکار یک نفر را سه تکه می‌کرد
  // (ممیزی سوم — ج۴). پس تخصیص per-currency می‌ماند و تجمیع per-party
  // انجام می‌شود؛ ارزها زیرِ همان ردیف باز می‌شوند.
  const perCurrency = [...queues.values()]
    .map(({ meta, open }) => {
      const balance = open.reduce((s2, o) => s2 + o.amount, 0n);
      if (balance === 0n) return null;

      // ⚠️ سطل‌ها به **ارز پایه** پر می‌شوند، نه مبلغ خام ارز — وگرنه جمعِ
      // چند طرف‌حسابِ چندارزی، سنت و ریال و فِن را روی هم می‌ریزد (ممیزی ب۱).
      // `bucketsForeign` هم برای دیدِ تک‌ارزیِ همان ردیف نگه داشته می‌شود.
      const buckets = emptyBuckets();
      const bucketsForeign = emptyBuckets();
      let totalBase = 0n;
      let oldestDays = 0;

      for (const o of open) {
        const days = Math.max(0, Math.floor((asOf.getTime() - new Date(o.date).getTime()) / dayMs));
        const bucket = AGING_BUCKETS.find((b) => days <= b.maxDays)!.key;
        buckets[bucket] += o.base;
        bucketsForeign[bucket] += o.amount;
        totalBase += o.base;
        if (days > oldestDays) oldestDays = days;
      }
      return { ...meta, balance, totalBase, buckets, bucketsForeign, oldestDays };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  type PartyRow = {
    subsidiaryId: string; code: string; name: string;
    buckets: Record<AgingBucket, bigint>;
    totalBase: bigint; oldestDays: number;
    /** یک ورودی به‌ازای هر ارزِ باز؛ همیشه دست‌کم یکی */
    currencies: typeof perCurrency;
  };

  const byParty = new Map<string, PartyRow>();
  for (const c of perCurrency) {
    const row = byParty.get(c.subsidiaryId) ?? {
      subsidiaryId: c.subsidiaryId, code: c.code, name: c.name,
      buckets: emptyBuckets(), totalBase: 0n, oldestDays: 0,
      currencies: [] as typeof perCurrency,
    };
    byParty.set(c.subsidiaryId, row);
    for (const b of AGING_BUCKETS) row.buckets[b.key] += c.buckets[b.key];
    row.totalBase += c.totalBase;
    // قدیمی‌ترینِ طرف‌حساب = قدیمی‌ترین در هر ارزی که باشد
    if (c.oldestDays > row.oldestDays) row.oldestDays = c.oldestDays;
    row.currencies.push(c);
  }

  const rows = [...byParty.values()]
    .map((r) => ({
      ...r,
      currencies: [...r.currencies].sort((a, b) =>
        b.totalBase > a.totalBase ? 1 : b.totalBase < a.totalBase ? -1 : 0),
      /** برای نمایشِ فشرده: وقتی طرف‌حساب تک‌ارزی است، همان ارز */
      singleCurrency: r.currencies.length === 1 ? r.currencies[0].currencyCode : null,
    }))
    .sort((a, b) => (b.totalBase > a.totalBase ? 1 : b.totalBase < a.totalBase ? -1 : 0));

  // حالا که سطل‌ها هم‌ارزند، جمعِ واحد معنادار است
  const bucketTotals = Object.fromEntries(
    AGING_BUCKETS.map((b) => [b.key, rows.reduce((s2, r) => s2 + r.buckets[b.key], 0n)]),
  ) as Record<AgingBucket, bigint>;

  /**
   * جمعِ **فقط ماندهٔ بدهکارِ** هر طرف‌حساب در هر سطل (ممیزی دور چهارم — ن۸).
   *
   * `bucketTotals` مثبت و منفی را با هم جمع می‌زند، و ذخیرهٔ مطالبات روی همان
   * حساب می‌کرد. نتیجه: پیش‌دریافتِ یک مشتری، ذخیرهٔ لازم برای طلبِ مشکوکِ
   * **مشتریِ دیگری** را کم می‌کرد — ۹۰۰ میلیون پیش‌دریافت، ۹۰۰ میلیون از
   * پایهٔ ذخیره کم کرد. طلبِ سوخته با پولِ کسِ دیگر جبران نمی‌شود؛ آن
   * پیش‌دریافت بدهیِ ماست، نه دارایی در معرض خطر.
   */
  const bucketReceivable = Object.fromEntries(
    AGING_BUCKETS.map((b) => [
      b.key,
      rows.reduce((s2, r) => s2 + (r.buckets[b.key] > 0n ? r.buckets[b.key] : 0n), 0n),
    ]),
  ) as Record<AgingBucket, bigint>;

  return {
    asOf, accountCode, rows, bucketTotals, bucketReceivable,
    /** تعداد ردیف‌های (طرف‌حساب × ارز) — پاورقی «N طرف‌حساب» باید `rows.length` را بگوید نه این را */
    positionCount: perCurrency.length,
    grandTotalBase: rows.reduce((s2, r) => s2 + r.totalBase, 0n),
    /** واحدِ سطل‌ها و جمع‌ها: ارز پایه */
    bucketCurrency: 'BASE' as const,
    /**
     * چه سهمی از تسویه‌ها تخصیصِ صریح داشته — به هزارم.
     * `1000` یعنی هیچ حدسی در کار نیست؛ `0` یعنی همه‌چیز FIFO است.
     */
    explicitCoverage: settlementTotal === 0n
      ? null
      : Number((explicitTotal * 1000n) / settlementTotal),
  };
}
