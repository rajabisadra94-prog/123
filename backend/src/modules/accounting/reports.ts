import { AccountType, Prisma } from '@prisma/client';
import { normalSideOf } from './chartOfAccounts';

/**
 * صورت‌های مالی پایه — docs/accounting-spec.md بخش ۵-۴
 *
 * همه از **دفتر** ساخته می‌شوند نه از ماندهٔ مادی‌شده، چون گزارش‌های تاریخ‌دار
 * باید فقط ردیف‌های تا آن تاریخ را ببینند. ارزش ریالی هر ردیف با **نرخ خودش**
 * حساب می‌شود (نه نرخ امروز) — این همان چیزی است که گزارش را تاریخی و درست نگه می‌دارد.
 */

export type AccountTotals = {
  id: string;
  code: string | null;
  name: string;
  accountType: AccountType | null;
  currency: string;
  parentId: string | null;
  isPostable: boolean;
  /** جمع بدهکار و بستانکار به ارز عملیاتی */
  debitIRR: number;
  creditIRR: number;
  /** مانده با علامت طبیعی حساب */
  balanceIRR: number;
  /** مانده به ارز خود حساب (برای حساب‌های تک‌ارزی معنا دارد) */
  balanceNative: number;
};

/** جمع بدهکار/بستانکار هر حساب از روی ردیف‌های دفتر، با فیلتر تاریخ */
export async function accountTotals(
  tx: Prisma.TransactionClient,
  opts: { from?: Date; to?: Date } = {},
): Promise<AccountTotals[]> {
  // نکته: اسناد باطل‌شده (REVERSED) عمداً فیلتر **نمی‌شوند**. سند برگشتی (REVERSAL)
  // اثر آن‌ها را با ردیف‌های معکوس خنثی می‌کند، پس جمع هر دو صفر می‌شود. اگر فقط
  // اصلی حذف شود، برگشتی به‌تنهایی می‌ماند و گزارش را به اندازهٔ همان سند غلط می‌کند.
  const where: Prisma.JournalLineWhereInput = {};
  if (opts.from || opts.to) {
    const date: Prisma.DateTimeFilter = {};
    if (opts.from) date.gte = opts.from;
    if (opts.to) date.lte = opts.to;
    where.entry = { date };
  }

  const lines = await tx.journalLine.findMany({
    where,
    select: { accountId: true, debit: true, credit: true, rateToIRR: true, currency: true },
  });

  const agg = new Map<string, { d: number; c: number; dn: number; cn: number }>();
  for (const l of lines) {
    const rate = Number(l.rateToIRR);
    const cur = agg.get(l.accountId) || { d: 0, c: 0, dn: 0, cn: 0 };
    cur.d += Number(l.debit) * rate;
    cur.c += Number(l.credit) * rate;
    cur.dn += Number(l.debit);
    cur.cn += Number(l.credit);
    agg.set(l.accountId, cur);
  }

  const accounts = await tx.financialAccount.findMany({
    where: { id: { in: [...agg.keys()] } },
    select: {
      id: true, code: true, name: true, accountType: true, currency: true,
      parentId: true, isPostable: true,
    },
  });

  return accounts.map((a) => {
    const t = agg.get(a.id)!;
    const sign = a.accountType ? (normalSideOf(a.accountType) === 'DEBIT' ? 1 : -1) : 1;
    return {
      ...a,
      debitIRR: t.d,
      creditIRR: t.c,
      balanceIRR: (t.d - t.c) * sign,
      balanceNative: (t.dn - t.cn) * sign,
    };
  });
}

/**
 * تراز آزمایشی: فهرست همهٔ حساب‌های دارای گردش با جمع بدهکار و بستانکار.
 * جمع کل بدهکار باید دقیقاً برابر جمع کل بستانکار باشد — اگر نبود یعنی جایی
 * سند ناتراز وارد دفتر شده (که با تریگر دیتابیس دیگر نباید ممکن باشد).
 */
export async function trialBalance(tx: Prisma.TransactionClient, asOf?: Date) {
  const rows = (await accountTotals(tx, { to: asOf }))
    .filter((r) => Math.abs(r.debitIRR) > 0.005 || Math.abs(r.creditIRR) > 0.005)
    .sort((a, b) => (a.code || 'zz').localeCompare(b.code || 'zz'));

  const totalDebit = rows.reduce((s, r) => s + r.debitIRR, 0);
  const totalCredit = rows.reduce((s, r) => s + r.creditIRR, 0);
  return {
    asOf: asOf || null,
    rows,
    totalDebit,
    totalCredit,
    difference: Math.round((totalDebit - totalCredit) * 100) / 100,
    balanced: Math.round((totalDebit - totalCredit) * 100) / 100 === 0,
  };
}

type Group = { accountType: AccountType; label: string; total: number; accounts: AccountTotals[] };

const TYPE_LABEL: Record<AccountType, string> = {
  ASSET: 'دارایی‌ها', LIABILITY: 'بدهی‌ها', EQUITY: 'سرمایه',
  INCOME: 'درآمدها', EXPENSE: 'هزینه‌ها',
};

function group(rows: AccountTotals[], types: AccountType[]): Group[] {
  return types.map((t) => {
    const accounts = rows
      .filter((r) => r.accountType === t && Math.abs(r.balanceIRR) > 0.005)
      .sort((a, b) => (a.code || 'zz').localeCompare(b.code || 'zz'));
    return {
      accountType: t,
      label: TYPE_LABEL[t],
      total: accounts.reduce((s, a) => s + a.balanceIRR, 0),
      accounts,
    };
  });
}

/**
 * صورت سود و زیان یک بازه: درآمد − هزینه.
 * فقط حساب‌های INCOME و EXPENSE و فقط ردیف‌های داخل بازه.
 */
export async function incomeStatement(tx: Prisma.TransactionClient, from: Date, to: Date) {
  const rows = await accountTotals(tx, { from, to });
  const [income, expense] = group(rows, ['INCOME', 'EXPENSE']);
  return {
    from, to,
    income, expense,
    netProfit: income.total - expense.total,
  };
}

/**
 * ترازنامه در یک تاریخ.
 *
 * چون دفتر «بسته» نمی‌شود (سند اختتامیه نداریم)، سود انباشتهٔ دوره‌های قبل و
 * سود دورهٔ جاری هنوز در حساب‌های درآمد/هزینه نشسته‌اند. پس برای برقراری
 * معادلهٔ حسابداری، سود خالص تا آن تاریخ به‌عنوان جزئی از سرمایه اضافه می‌شود:
 *
 *   دارایی = بدهی + سرمایه + (درآمد − هزینه)
 */
export async function balanceSheet(tx: Prisma.TransactionClient, asOf: Date) {
  const rows = await accountTotals(tx, { to: asOf });
  const [asset, liability, equity] = group(rows, ['ASSET', 'LIABILITY', 'EQUITY']);
  const [income, expense] = group(rows, ['INCOME', 'EXPENSE']);

  const retained = income.total - expense.total;   // سود انباشته تا این تاریخ
  const totalAssets = asset.total;
  const totalLiabEquity = liability.total + equity.total + retained;
  const difference = Math.round((totalAssets - totalLiabEquity) * 100) / 100;

  // حساب‌های طبقه‌بندی‌نشده در هیچ گروهی نمی‌افتند و دقیقاً به اندازهٔ مانده‌شان
  // معادله را می‌شکنند. علتِ ناترازی باید صریح گزارش شود نه اینکه کاربر حدس بزند.
  const unclassified = rows
    .filter((r) => !r.accountType && Math.abs(r.balanceIRR) > 0.005)
    .map((r) => ({ id: r.id, name: r.name, balanceIRR: r.balanceIRR }));

  return {
    asOf,
    asset, liability, equity,
    retainedEarnings: retained,
    totalAssets,
    totalLiabilitiesAndEquity: totalLiabEquity,
    difference,
    balanced: difference === 0,
    unclassified,
  };
}

/**
 * سن‌بندی مطالبات و بدهی‌ها (spec ۵-۴).
 *
 * روش: هر کیف پول طرف‌حساب، ردیف‌هایش به ترتیب تاریخ خوانده می‌شود و
 * افزایش‌ها (تعهد جدید) در صفی می‌نشینند؛ هر کاهش (تسویه) از **قدیمی‌ترین**
 * تعهد کم می‌شود — یعنی FIFO. آنچه در صف می‌ماند، ماندهٔ باز است و سنش از
 * تاریخ همان تعهد حساب می‌شود.
 *
 * چرا FIFO: در عمل پرداخت‌ها معمولاً بابت قدیمی‌ترین فاکتور باز است، و بدون
 * تخصیص صریحِ پرداخت‌به‌فاکتور، این نزدیک‌ترین فرض به واقعیت است.
 */
export type AgingBucket = '0-30' | '31-60' | '61-90' | '90+';
const BUCKETS: { key: AgingBucket; label: string; maxDays: number }[] = [
  { key: '0-30', label: 'تا ۳۰ روز', maxDays: 30 },
  { key: '31-60', label: '۳۱ تا ۶۰ روز', maxDays: 60 },
  { key: '61-90', label: '۶۱ تا ۹۰ روز', maxDays: 90 },
  { key: '90+', label: 'بیش از ۹۰ روز', maxDays: Infinity },
];

export async function aging(
  tx: Prisma.TransactionClient,
  side: 'RECEIVABLE' | 'PAYABLE',
  asOf: Date,
) {
  const ownerTypes = side === 'RECEIVABLE'
    ? ['CUSTOMER']
    : ['PRODUCER', 'SUPPLIER', 'CARRIER', 'EXCHANGE', 'COMMISSION_AGENT'];

  const wallets = await tx.financialAccount.findMany({
    where: { ownerType: { in: ownerTypes }, isActive: true },
    select: { id: true, name: true, currency: true, ownerType: true, ownerId: true, accountType: true, controlKind: true },
  });
  if (!wallets.length) return { asOf, side, buckets: BUCKETS.map((b) => ({ ...b, total: 0 })), rows: [], grandTotal: 0 };

  const lines = await tx.journalLine.findMany({
    where: { accountId: { in: wallets.map((w) => w.id) }, entry: { date: { lte: asOf } } },
    select: { accountId: true, debit: true, credit: true, rateToIRR: true, entry: { select: { date: true } } },
    orderBy: [{ entry: { date: 'asc' } }, { entry: { entryNo: 'asc' } }],
  });

  const byAccount = new Map<string, typeof lines>();
  for (const l of lines) {
    const arr = byAccount.get(l.accountId) || [];
    arr.push(l);
    byAccount.set(l.accountId, arr);
  }

  const dayMs = 86_400_000;
  const rows: any[] = [];

  for (const w of wallets) {
    const own = byAccount.get(w.id);
    if (!own?.length) continue;
    const sign = normalSideOf(w.accountType ?? (side === 'RECEIVABLE' ? 'ASSET' : 'LIABILITY')) === 'DEBIT' ? 1 : -1;

    // صف FIFO از تعهدهای باز
    const open: { date: Date; amount: number; rate: number }[] = [];
    for (const l of own) {
      const delta = (Number(l.debit) - Number(l.credit)) * sign;   // مثبت = تعهد جدید
      if (delta > 0) {
        open.push({ date: l.entry.date, amount: delta, rate: Number(l.rateToIRR) });
      } else if (delta < 0) {
        let pay = -delta;
        while (pay > 1e-9 && open.length) {
          const head = open[0];
          const take = Math.min(head.amount, pay);
          head.amount -= take;
          pay -= take;
          if (head.amount <= 1e-9) open.shift();
        }
        // مازاد تسویه (پیش‌پرداخت) به‌عنوان تعهد منفی نگه داشته نمی‌شود؛ در ستون جدا می‌آید
        if (pay > 1e-9) open.push({ date: l.entry.date, amount: -pay, rate: Number(l.rateToIRR) });
      }
    }

    const balance = open.reduce((s, o) => s + o.amount, 0);
    if (Math.abs(balance) < 0.005) continue;

    const buckets: Record<AgingBucket, number> = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    let totalIRR = 0;
    for (const o of open) {
      const days = Math.max(0, Math.floor((asOf.getTime() - new Date(o.date).getTime()) / dayMs));
      const b = BUCKETS.find((x) => days <= x.maxDays)!.key;
      buckets[b] += o.amount;
      totalIRR += o.amount * o.rate;
    }

    rows.push({
      accountId: w.id, name: w.name, currency: w.currency,
      ownerType: w.ownerType, ownerId: w.ownerId,
      balance, totalIRR, buckets,
      oldestDays: open.length
        ? Math.max(...open.map((o) => Math.floor((asOf.getTime() - new Date(o.date).getTime()) / dayMs)))
        : 0,
    });
  }

  rows.sort((a, b) => b.totalIRR - a.totalIRR);
  const bucketTotals = BUCKETS.map((b) => ({
    ...b,
    total: rows.reduce((s, r) => s + (r.buckets[b.key] || 0) * (r.totalIRR / (r.balance || 1)), 0),
  }));

  return {
    asOf, side,
    buckets: bucketTotals,
    rows,
    grandTotal: rows.reduce((s, r) => s + r.totalIRR, 0),
  };
}

/**
 * تشخیص انحراف (spec بخش ۳-۱) — سه بررسی سلامت که باید همیشه سبز باشند:
 *  ۱) ماندهٔ مادی‌شدهٔ هر حساب برابر جمع ردیف‌های دفترش باشد
 *  ۲) هیچ حسابِ دارای گردش بدون طبقه‌بندی نمانده باشد
 *  ۳) هیچ سند ناترازی در دفتر نباشد
 */
export async function integrityCheck(tx: Prisma.TransactionClient) {
  const accounts = await tx.financialAccount.findMany({
    select: { id: true, code: true, name: true, currency: true, balance: true, accountType: true },
  });
  const sums = await tx.journalLine.groupBy({
    by: ['accountId'],
    _sum: { debit: true, credit: true },
  });
  const ledgerByAccount = new Map(sums.map((s) => [s.accountId, Number(s._sum.debit || 0) - Number(s._sum.credit || 0)]));

  const drift = accounts
    .map((a) => {
      const ledger = ledgerByAccount.get(a.id) ?? 0;
      const stored = Number(a.balance);
      return { ...a, stored, ledger, diff: Math.round((stored - ledger) * 1e6) / 1e6 };
    })
    .filter((a) => a.diff !== 0)
    .map(({ id, code, name, currency, stored, ledger, diff }) => ({ id, code, name, currency, stored, ledger, diff }));

  const unclassified = accounts
    .filter((a) => !a.accountType && (ledgerByAccount.get(a.id) ?? 0) !== 0)
    .map((a) => ({ id: a.id, name: a.name, balance: ledgerByAccount.get(a.id) ?? 0 }));

  const entries = await tx.journalEntry.findMany({
    select: { id: true, entryNo: true, description: true, lines: { select: { debit: true, credit: true, rateToIRR: true } } },
  });
  const unbalanced = entries
    .map((e) => {
      const d = e.lines.reduce((s, l) => s + Number(l.debit) * Number(l.rateToIRR), 0);
      const c = e.lines.reduce((s, l) => s + Number(l.credit) * Number(l.rateToIRR), 0);
      return { entryNo: e.entryNo, description: e.description, diff: Math.round((d - c) * 100) / 100 };
    })
    .filter((e) => e.diff !== 0);

  return {
    ok: drift.length === 0 && unclassified.length === 0 && unbalanced.length === 0,
    drift, unclassified, unbalanced,
    checked: { accounts: accounts.length, entries: entries.length },
  };
}
