/**
 * استهلاک دارایی‌های ثابت — مرحلهٔ ۴ ه.
 *
 * حساب‌های «۱۲۰۱ دارایی ثابت»، «۱۲۰۲ استهلاک انباشته» و «۶۲۰۵ هزینهٔ استهلاک»
 * از قبل در چارت بودند ولی هیچ چیزی آن‌ها را پر نمی‌کرد؛ استهلاک باید هر ماه
 * دستی حساب و ثبت می‌شد.
 *
 * ─── سه تصمیم ──────────────────────────────────────────────────
 *
 * ۱) **عمر مفید به ماه، نه سال.** استهلاک ماهانه ثبت می‌شود و «۵ سال» یعنی
 *    ۶۰ ماه؛ نگه داشتنِ سال و تقسیم بر ۱۲ در لحظهٔ محاسبه، خطای گردکردن را
 *    شصت بار تکرار می‌کند.
 *
 * ۲) **ماهِ آخر باقی‌مانده را می‌گیرد.** تقسیمِ صحیحِ پایه بر عمر مفید تقریباً
 *    همیشه باقی‌مانده دارد. اگر هر ماه همان خارج‌قسمت ثبت شود، در پایان عمر
 *    چند ریال روی دفتر می‌ماند و دارایی هرگز کاملاً مستهلک نمی‌شود. پس ماه
 *    آخر = پایه منهای مجموعِ ماه‌های قبل.
 *
 * ۳) **یکتاییِ (دارایی × دورهٔ ماه) در دیتابیس.** ثبتِ دوبارهٔ استهلاکِ یک ماه
 *    اشتباهی است که در روش دستی رایج است و کسی متوجهش نمی‌شود چون مبلغ کوچک
 *    است. اینجا قید یکتا جلویش را می‌گیرد، نه یک `if` در کد.
 */
import { Prisma } from '@prisma/client';
import { post } from './poster';
import { shamsiMonths } from './shamsi';

export class DepreciationError extends Error {}

export const ASSET_CODE = '1201';
export const ACCUM_DEPRECIATION_CODE = '1202';
export const DEPRECIATION_EXPENSE_CODE = '6205';
export const DEPRECIATION_SOURCE = 'Depreciation';

const MONTH_DAYS = 30;

export interface AssetInput {
  code: string;
  name: string;
  cost: bigint;
  salvage?: bigint;
  usefulLifeMonths: number;
  inServiceAt: Date;
  costCenterCode?: string | null;
  note?: string | null;
}

export async function upsertAsset(tx: Prisma.TransactionClient, input: AssetInput) {
  if (input.cost <= 0n) throw new DepreciationError('بهای تمام‌شده باید مثبت باشد');
  const salvage = input.salvage ?? 0n;
  if (salvage < 0n) throw new DepreciationError('ارزش اسقاط نمی‌تواند منفی باشد');
  if (salvage >= input.cost) {
    throw new DepreciationError('ارزش اسقاط باید کمتر از بهای تمام‌شده باشد — وگرنه چیزی برای استهلاک نمی‌ماند');
  }
  if (!Number.isInteger(input.usefulLifeMonths) || input.usefulLifeMonths < 1) {
    throw new DepreciationError('عمر مفید باید دست‌کم یک ماه باشد');
  }

  let costCenterId: string | null = null;
  if (input.costCenterCode) {
    const cc = await tx.glCostCenter.findUnique({ where: { code: input.costCenterCode } });
    if (!cc) throw new DepreciationError(`مرکز هزینهٔ «${input.costCenterCode}» وجود ندارد`);
    if (!cc.isPostable) throw new DepreciationError('مرکز هزینهٔ سرگروه انتخاب نمی‌شود');
    costCenterId = cc.id;
  }

  const existing = await tx.glFixedAsset.findUnique({ where: { code: input.code } });
  const data = {
    name: input.name, cost: input.cost, salvage,
    usefulLifeMonths: input.usefulLifeMonths,
    inServiceAt: input.inServiceAt, costCenterId,
    note: input.note ?? null,
  };

  if (existing) {
    // تغییرِ مبنا پس از شروع استهلاک، دوره‌های ثبت‌شده را نامعتبر می‌کند
    const runs = await tx.glDepreciationRun.count({ where: { assetId: existing.id } });
    if (runs > 0 && (existing.cost !== input.cost
        || existing.usefulLifeMonths !== input.usefulLifeMonths
        || existing.salvage !== salvage)) {
      throw new DepreciationError(
        `«${existing.name}» ${runs} دورهٔ استهلاکِ ثبت‌شده دارد؛ بهای تمام‌شده، اسقاط و عمر مفید دیگر تغییر نمی‌کنند`);
    }
    return tx.glFixedAsset.update({ where: { id: existing.id }, data });
  }
  return tx.glFixedAsset.create({ data: { code: input.code, ...data } });
}

export async function disposeAsset(
  tx: Prisma.TransactionClient, code: string, disposedAt: Date,
) {
  const asset = await tx.glFixedAsset.findUnique({ where: { code } });
  if (!asset) throw new DepreciationError('دارایی یافت نشد');
  return tx.glFixedAsset.update({ where: { id: asset.id }, data: { disposedAt } });
}

/** پایهٔ استهلاک و سهمِ هر ماه — ماهِ آخر باقی‌مانده را می‌گیرد */
export function monthlyAmount(
  cost: bigint, salvage: bigint, life: number, periodNo: number,
): bigint {
  const base = cost - salvage;
  const per = base / BigInt(life);
  if (periodNo >= life) return base - per * BigInt(life - 1);
  return per;
}

export interface ScheduleRow {
  periodNo: number;
  periodDate: Date;
  amount: string;
  accumulated: string;
  bookValue: string;
  posted: boolean;
  entryId: string | null;
}

/** جدول استهلاک یک دارایی، با علامتِ اینکه هر دوره ثبت شده یا نه */
export async function schedule(tx: Prisma.TransactionClient, code: string) {
  const asset = await tx.glFixedAsset.findUnique({
    where: { code },
    include: { runs: true, costCenter: { select: { code: true, name: true } } },
  });
  if (!asset) throw new DepreciationError('دارایی یافت نشد');

  const byPeriod = new Map(asset.runs.map((r) => [r.periodNo, r]));
  const rows: ScheduleRow[] = [];
  let acc = 0n;

  for (let i = 1; i <= asset.usefulLifeMonths; i++) {
    const amount = monthlyAmount(asset.cost, asset.salvage, asset.usefulLifeMonths, i);
    acc += amount;
    const run = byPeriod.get(i);
    const d = new Date(asset.inServiceAt);
    d.setUTCDate(d.getUTCDate() + i * MONTH_DAYS);
    rows.push({
      periodNo: i,
      periodDate: run?.periodDate ?? d,
      amount: amount.toString(),
      accumulated: acc.toString(),
      bookValue: (asset.cost - acc).toString(),
      posted: !!run,
      entryId: run?.entryId ?? null,
    });
  }

  const postedTotal = asset.runs.reduce((s, r) => s + r.amount, 0n);
  return {
    asset: {
      code: asset.code, name: asset.name,
      cost: asset.cost.toString(), salvage: asset.salvage.toString(),
      usefulLifeMonths: asset.usefulLifeMonths,
      inServiceAt: asset.inServiceAt,
      disposedAt: asset.disposedAt,
      costCenterCode: asset.costCenter?.code ?? null,
      costCenterName: asset.costCenter?.name ?? null,
    },
    rows,
    postedPeriods: asset.runs.length,
    accumulated: postedTotal.toString(),
    bookValue: (asset.cost - postedTotal).toString(),
  };
}

export async function listAssets(tx: Prisma.TransactionClient) {
  const assets = await tx.glFixedAsset.findMany({
    include: { runs: { select: { amount: true } }, costCenter: { select: { code: true, name: true } } },
    orderBy: { code: 'asc' },
  });
  return assets.map((a) => {
    const acc = a.runs.reduce((s, r) => s + r.amount, 0n);
    return {
      code: a.code, name: a.name,
      cost: a.cost.toString(), salvage: a.salvage.toString(),
      usefulLifeMonths: a.usefulLifeMonths,
      inServiceAt: a.inServiceAt, disposedAt: a.disposedAt,
      costCenterCode: a.costCenter?.code ?? null,
      costCenterName: a.costCenter?.name ?? null,
      postedPeriods: a.runs.length,
      accumulated: acc.toString(),
      bookValue: (a.cost - acc).toString(),
      fullyDepreciated: a.runs.length >= a.usefulLifeMonths,
    };
  });
}

/**
 * ثبت استهلاک تا یک تاریخ.
 *
 * همهٔ دوره‌های سررسیدشده‌ای که هنوز ثبت نشده‌اند در **یک سند** جمع می‌شوند —
 * نه یک سند به‌ازای هر ماهِ عقب‌افتاده، که دفتر را با ده سندِ ریز پر می‌کند.
 * ولی هر دوره ردیفِ `GlDepreciationRun` خودش را می‌گیرد، تا دوباره ثبت نشود.
 */
export async function postDepreciation(
  tx: Prisma.TransactionClient,
  input: { fiscalYearId: string; asOf: Date; assetCode?: string | null; createdById?: string | null },
) {
  const assets = await tx.glFixedAsset.findMany({
    where: {
      ...(input.assetCode ? { code: input.assetCode } : {}),
      OR: [{ disposedAt: null }, { disposedAt: { gt: input.asOf } }],
    },
    include: { runs: { select: { periodNo: true } } },
  });

  const expense = await tx.glAccount.findUnique({ where: { code: DEPRECIATION_EXPENSE_CODE } });
  const accum = await tx.glAccount.findUnique({ where: { code: ACCUM_DEPRECIATION_CODE } });
  if (!expense || !accum) {
    throw new DepreciationError(
      `حساب‌های ${DEPRECIATION_EXPENSE_CODE} و ${ACCUM_DEPRECIATION_CODE} در چارت نیستند`);
  }

  type Pending = { assetId: string; periodNo: number; periodDate: Date; amount: bigint; costCenterId: string | null };
  const pending: Pending[] = [];

  for (const a of assets) {
    const done = new Set(a.runs.map((r) => r.periodNo));
    // چند ماه از شروع بهره‌برداری گذشته
    const elapsed = Math.floor(
      (input.asOf.getTime() - a.inServiceAt.getTime()) / (MONTH_DAYS * 86_400_000));
    const due = Math.min(Math.max(elapsed, 0), a.usefulLifeMonths);

    for (let i = 1; i <= due; i++) {
      if (done.has(i)) continue;
      const d = new Date(a.inServiceAt);
      d.setUTCDate(d.getUTCDate() + i * MONTH_DAYS);
      pending.push({
        assetId: a.id, periodNo: i,
        periodDate: d > input.asOf ? input.asOf : d,
        amount: monthlyAmount(a.cost, a.salvage, a.usefulLifeMonths, i),
        costCenterId: a.costCenterId,
      });
    }
  }

  const total = pending.reduce((s, p) => s + p.amount, 0n);
  if (total === 0n) {
    return { posted: false as const, reason: 'دورهٔ استهلاکِ ثبت‌نشده‌ای وجود ندارد', periods: 0 };
  }

  /**
   * ⚠️ ممیزی ب۶ — هر ماه سند خودش، به تاریخ پایان همان ماه شمسی.
   *
   * پیش‌تر همهٔ دوره‌های سررسیدشده در **یک** سند و به تاریخ **اجرای دستور**
   * بسته می‌شدند. اگر کسی سه ماه دیر اجرا می‌کرد، هزینهٔ استهلاک خرداد و تیر
   * و مرداد همه در شهریور می‌نشست و سود و زیان ماهانهٔ هر چهار ماه غلط
   * می‌شد. ماژول حقوق همین دام را آگاهانه دور زده — در `payroll/engine.ts`
   * نوشته شده «اگر یک‌جا در اسفند ثبت شوند، سود و زیان ماهانه بی‌معنی
   * می‌شود». همان اصل حالا اینجا هم برقرار است.
   *
   * تاریخ هم پایان ماه **شمسی** است، نه گامِ ۳۰ روزه. سال شمسی ۳۶۵ روز است
   * و دوازده ماهِ سی‌روزه ۳۶۰، پس گام ثابت هر سال پنج روز عقب می‌افتاد و
   * دوره‌های دور، وسط ماه می‌افتادند.
   */
  const monthEnd = await shamsiMonthEndResolver(tx);
  const groups = new Map<number, Pending[]>();
  for (const p of pending) {
    // پایان ماهِ جاری هنوز نرسیده؟ سند در آینده ثبت نمی‌شود — سقفش `asOf` است.
    const end = monthEnd(p.periodDate);
    p.periodDate = end > input.asOf ? input.asOf : end;
    const k = p.periodDate.getTime();
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }

  const entries = [];
  for (const key of [...groups.keys()].sort((a, b) => a - b)) {
    const group = groups.get(key)!;
    const date = new Date(key);
    const groupTotal = group.reduce((s, p) => s + p.amount, 0n);

    // هزینه به تفکیک مرکز هزینه، ولی استهلاک انباشته یک ردیف — حسابِ کاهندهٔ
    // دارایی بُعدِ مرکز هزینه ندارد و تفکیکش فقط دفتر را شلوغ می‌کند.
    const byCentre = new Map<string | null, bigint>();
    for (const p of group) {
      byCentre.set(p.costCenterId, (byCentre.get(p.costCenterId) ?? 0n) + p.amount);
    }

    const entry = await post(tx, {
      fiscalYearId: await fiscalYearFor(tx, date, input.fiscalYearId),
      date,
      description: `استهلاک ${group.length} دوره${input.assetCode ? ` — ${input.assetCode}` : ''}`,
      entryType: 'ADJUSTING',
      sourceType: DEPRECIATION_SOURCE,
      createdById: input.createdById ?? null,
      lines: [
        ...[...byCentre.entries()].map(([costCenterId, amount]) => ({
          accountId: expense.id, currencyCode: 'IRR', debit: amount,
          ...(costCenterId ? { costCenterId } : {}),
        })),
        { accountId: accum.id, currencyCode: 'IRR', credit: groupTotal },
      ],
    });
    entries.push(entry);

    // ⚠️ درجِ دوره‌ها **پس از** سند و در همان تراکنش: قید یکتای
    // (دارایی × دوره) اگر کسی هم‌زمان همین را بزند، اینجا می‌شکند و کل تراکنش
    // برمی‌گردد — پس نه سندِ تکراری می‌ماند نه دورهٔ ثبت‌نشده.
    await tx.glDepreciationRun.createMany({
      data: group.map((p) => ({
        assetId: p.assetId, periodNo: p.periodNo,
        periodDate: p.periodDate, amount: p.amount, entryId: entry.id,
      })),
    });
  }

  return {
    posted: true as const,
    entries,
    /** سند نخست — سازگاری با فراخوان‌های قدیمی که یک سند انتظار داشتند */
    entry: entries[0],
    periods: pending.length,
    months: entries.length,
    total: total.toString(),
  };
}

/**
 * سال مالیِ شاملِ یک تاریخ. اگر پیدا نشد، همان سالی که فراخوان داده
 * — تریگرِ بازهٔ سال مالی در دیتابیس حرف آخر را می‌زند.
 */
async function fiscalYearFor(
  tx: Prisma.TransactionClient, at: Date, fallback: string,
): Promise<string> {
  const fy = await tx.glFiscalYear.findFirst({
    where: { startDate: { lte: at }, endDate: { gte: at }, closedAt: null },
    select: { id: true },
  });
  return fy?.id ?? fallback;
}

/**
 * تابعی که هر تاریخ را به **آخرین روزِ ماه شمسیِ شاملش** می‌برد.
 *
 * مرزها از `shamsiMonths` می‌آید — همان منبعی که بودجه و گزارش روند
 * استفاده می‌کنند، پس استهلاک با آن‌ها هم‌تراز می‌ماند. تاریخی که در هیچ
 * سال مالیِ تعریف‌شده‌ای نیفتد، دست‌نخورده برمی‌گردد.
 */
async function shamsiMonthEndResolver(
  tx: Prisma.TransactionClient,
): Promise<(d: Date) => Date> {
  const years = await tx.glFiscalYear.findMany({ select: { startDate: true, endDate: true } });
  const bounds = years.flatMap((fy) => shamsiMonths(fy));
  return (d: Date) => {
    const hit = bounds.find((m) => d >= m.from && d <= m.to);
    return hit ? new Date(hit.to) : d;
  };
}
