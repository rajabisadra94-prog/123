/**
 * بودجه و مقایسهٔ بودجه با عملکرد — ممیزی سوم، ب۲.
 *
 * تا پیش از این، در کل ماژول صفر ارجاع به بودجه بود. بدون آن، «هزینه‌های اداری
 * ۱۶٬۹۳۱٬۸۲۷٬۲۶۰ ریال» فقط یک عدد است — نه می‌دانی زیاد است نه کم. بودجه همان
 * چیزی است که گزارش را از «تاریخ» به «کنترل» تبدیل می‌کند.
 *
 * سه تصمیم که ارزش نوشتن دارند:
 *
 * ۱) **ابعادِ بودجه = ابعادِ گزارش.** بودجه در سطح (سال مالی × حساب × مرکز
 *    هزینه) نگه داشته می‌شود، چون گزارش عملکرد هم همین ابعاد را دارد. اگر
 *    بودجه فقط سالانه و بدون مرکز بود، کنار هم گذاشتنشان ممکن نبود.
 *
 * ۲) **دوازده ستون ماهانه، نه یک عدد سالانه.** اجاره یکنواخت است ولی بازاریابی
 *    و عیدی نیستند. با عدد سالانه، انحرافِ فروردین همیشه مثبت و انحرافِ اسفند
 *    همیشه منفی درمی‌آید و گزارش بی‌معنی می‌شود.
 *
 * ۳) **معنای «انحراف مطلوب» به ماهیت حساب بند است.** برای هزینه، کمتر از بودجه
 *    خوب است؛ برای درآمد، بیشتر از بودجه. یک ستون خامِ «عملکرد − بودجه» هر دو
 *    را یک‌جور نشان می‌دهد و خواننده را گمراه می‌کند، پس `favorable` جدا
 *    برمی‌گردد.
 */
import { Prisma } from '@prisma/client';
import { Minor } from './money';
import { shamsiRange } from './shamsi';

export class BudgetError extends Error {}

export const MONTHS_IN_YEAR = 12;

/** نام ماه‌های شمسی — ترتیبِ ستون‌های `months` */
export const SHAMSI_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
] as const;

export interface BudgetInput {
  fiscalYearId: string;
  accountCode: string;
  costCenterCode?: string | null;
  /** ۱۲ عدد در کوچک‌ترین واحد ارز پایه، فروردین تا اسفند */
  months: Minor[];
  note?: string | null;
}

/**
 * ثبت یا به‌روزرسانی بودجهٔ یک حساب.
 *
 * روی حساب سرگروه بودجه گذاشته نمی‌شود: عملکرد فقط روی برگ ثبت می‌شود، پس
 * بودجهٔ سرگروه هیچ‌وقت طرفِ مقایسه‌ای پیدا نمی‌کند.
 */
export async function upsertBudget(tx: Prisma.TransactionClient, input: BudgetInput) {
  if (input.months.length !== MONTHS_IN_YEAR) {
    throw new BudgetError(`بودجه باید دقیقاً ${MONTHS_IN_YEAR} عدد ماهانه داشته باشد`);
  }
  if (input.months.some((m) => m < 0n)) {
    throw new BudgetError('بودجهٔ ماهانه نمی‌تواند منفی باشد');
  }

  const fy = await tx.glFiscalYear.findUnique({ where: { id: input.fiscalYearId } });
  if (!fy) throw new BudgetError('سال مالی یافت نشد');

  const account = await tx.glAccount.findUnique({ where: { code: input.accountCode } });
  if (!account) throw new BudgetError(`حساب «${input.accountCode}» در چارت نیست`);
  if (!account.isPostable) {
    throw new BudgetError(
      `حساب «${account.code} ${account.name}» سرگروه است — بودجه روی حساب برگ گذاشته می‌شود`,
    );
  }
  if (account.statement !== 'INCOME_STATEMENT') {
    throw new BudgetError(
      `بودجه فقط برای حساب‌های سود و زیانی است؛ «${account.code} ${account.name}» ترازنامه‌ای است`,
    );
  }

  let costCenterId: string | null = null;
  if (input.costCenterCode) {
    const cc = await tx.glCostCenter.findUnique({ where: { code: input.costCenterCode } });
    if (!cc) throw new BudgetError(`مرکز هزینهٔ «${input.costCenterCode}» وجود ندارد`);
    costCenterId = cc.id;
  }

  // چرا `findFirst` و نه `upsert`: کلید یکتای مرکب یک ستون nullable دارد
  // (`costCenterId`) و Prisma چنین کلیدی را در `where` نمی‌پذیرد. یکتاییِ واقعی
  // با دو ایندکس جزئی در `2026-08-27-gl-core-constraints.sql` اجبار می‌شود، پس
  // اگر دو درخواست هم‌زمان برسند، دیتابیس دومی را رد می‌کند.
  const existing = await tx.glBudget.findFirst({
    where: { fiscalYearId: input.fiscalYearId, accountId: account.id, costCenterId },
  });

  if (existing) {
    return tx.glBudget.update({
      where: { id: existing.id },
      data: { months: input.months, note: input.note ?? null },
    });
  }
  return tx.glBudget.create({
    data: {
      fiscalYearId: input.fiscalYearId,
      accountId: account.id,
      costCenterId,
      months: input.months,
      note: input.note ?? null,
    },
  });
}

export async function deleteBudget(tx: Prisma.TransactionClient, id: string) {
  const b = await tx.glBudget.findUnique({ where: { id } });
  if (!b) throw new BudgetError('ردیف بودجه یافت نشد');
  await tx.glBudget.delete({ where: { id } });
  return { ok: true };
}

export async function listBudgets(tx: Prisma.TransactionClient, fiscalYearId: string) {
  const rows = await tx.glBudget.findMany({
    where: { fiscalYearId },
    include: {
      account: { select: { code: true, name: true, rootType: true } },
      costCenter: { select: { code: true, name: true } },
    },
    orderBy: [{ account: { code: 'asc' } }],
  });
  return rows.map((r) => ({
    id: r.id,
    accountCode: r.account.code,
    accountName: r.account.name,
    rootType: r.account.rootType,
    costCenterCode: r.costCenter?.code ?? null,
    costCenterName: r.costCenter?.name ?? null,
    months: r.months.map((m) => m.toString()),
    annual: r.months.reduce((s, m) => s + m, 0n).toString(),
    note: r.note,
  }));
}

// ───────────────────────────────────────────────────────────────
// بودجه در برابر عملکرد
// ───────────────────────────────────────────────────────────────

export interface VarianceRow {
  accountCode: string;
  accountName: string;
  rootType: string;
  costCenterCode: string | null;
  costCenterName: string | null;
  budget: string;
  actual: string;
  variance: string;
  /** انحراف نسبت به بودجه، چهار رقم اعشار — `null` وقتی بودجه صفر است */
  variancePct: string | null;
  /** آیا انحراف به سود شرکت است؟ برای هزینه یعنی کمتر خرج شده، برای درآمد یعنی بیشتر فروخته */
  favorable: boolean;
}

/**
 * مقایسهٔ بودجه و عملکرد در یک بازهٔ ماهانه از سال مالی.
 *
 * `fromMonth`/`toMonth` یک‌مبنا هستند (۱ = فروردین). پیش‌فرض کلِ سال است.
 * بودجهٔ بازه = جمعِ ستون‌های همان ماه‌ها — به همین دلیل بود که ماهانه ذخیره شد.
 */
export async function budgetVsActual(
  tx: Prisma.TransactionClient,
  input: { fiscalYearId: string; fromMonth?: number; toMonth?: number },
): Promise<{ rows: VarianceRow[]; totals: { budget: string; actual: string; variance: string } }> {
  const fy = await tx.glFiscalYear.findUnique({ where: { id: input.fiscalYearId } });
  if (!fy) throw new BudgetError('سال مالی یافت نشد');

  const from = Math.min(Math.max(input.fromMonth ?? 1, 1), MONTHS_IN_YEAR);
  const to = Math.min(Math.max(input.toMonth ?? MONTHS_IN_YEAR, from), MONTHS_IN_YEAR);

  // مرزهای واقعیِ ماه شمسی، نه تقریبِ ۳۰ روزه.
  //
  // نسخهٔ اول همان تقریبِ `payroll/run.ts` را داشت و غلط بود: فروردین ۳۱ روز
  // است، پس اجاره‌ای که ۳۱ فروردین ثبت می‌شد در عملکردِ اردیبهشت می‌نشست و
  // انحرافِ هر دو ماه خراب می‌شد. تا اسفند خطا به شش روز می‌رسید.
  const { from: periodFrom, to: periodTo } = shamsiRange(fy, from, to);

  const budgets = await tx.glBudget.findMany({
    where: { fiscalYearId: input.fiscalYearId },
    include: {
      account: { select: { id: true, code: true, name: true, rootType: true } },
      costCenter: { select: { code: true, name: true } },
    },
  });

  // عملکردِ همان ابعاد — به ارز پایه، بدون اسناد ماشینِ بستن سال
  const actuals = await tx.$queryRaw<
    { accountId: string; costCenterId: string | null; amount: bigint }[]
  >`
    SELECT l."accountId", l."costCenterId",
           (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS amount
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'DRAFT'
      AND a."statement" = 'INCOME_STATEMENT'
      AND e.date >= ${periodFrom} AND e.date <= ${periodTo}
      AND e."sourceType" IS DISTINCT FROM 'YearClose'
    GROUP BY l."accountId", l."costCenterId"
  `;

  const key = (a: string, c: string | null) => `${a}|${c ?? ''}`;
  const actualMap = new Map<string, bigint>();
  for (const r of actuals) {
    actualMap.set(key(r.accountId, r.costCenterId), BigInt(r.amount));
  }

  const rows: VarianceRow[] = [];
  let totalBudget = 0n, totalActual = 0n;

  for (const b of budgets) {
    const budget = b.months.slice(from - 1, to).reduce((s, m) => s + m, 0n);
    const raw = actualMap.get(key(b.accountId, b.costCenterId)) ?? 0n;
    // درآمد در دفتر بستانکار (منفی) است؛ برای مقایسه با بودجه علامتش برمی‌گردد
    const isIncome = b.account.rootType === 'INCOME';
    const actual = isIncome ? -raw : raw;
    const variance = actual - budget;

    rows.push({
      accountCode: b.account.code,
      accountName: b.account.name,
      rootType: b.account.rootType,
      costCenterCode: b.costCenter?.code ?? null,
      costCenterName: b.costCenter?.name ?? null,
      budget: budget.toString(),
      actual: actual.toString(),
      variance: variance.toString(),
      variancePct: budget === 0n ? null : pctOf(variance, budget),
      // هزینه: کمتر از بودجه مطلوب · درآمد: بیشتر از بودجه مطلوب
      favorable: isIncome ? variance >= 0n : variance <= 0n,
    });

    totalBudget += budget;
    totalActual += actual;
  }

  rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  return {
    rows,
    totals: {
      budget: totalBudget.toString(),
      actual: totalActual.toString(),
      variance: (totalActual - totalBudget).toString(),
    },
  };
}

/** نسبت با ۴ رقم اعشار روی عدد صحیح */
function pctOf(num: bigint, den: bigint): string {
  const neg = (num < 0n) !== (den < 0n);
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const scaled = (a * 10000n) / b;
  const str = `${scaled / 10000n}.${(scaled % 10000n).toString().padStart(4, '0')}`;
  return neg ? `-${str}` : str;
}
