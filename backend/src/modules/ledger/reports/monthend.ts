/**
 * چک‌لیست پایان ماه — مرحلهٔ ۴ ه.
 *
 * سامانه حالا هشت کارِ پایان‌دوره را بلد است: تسعیر ارز، ذخیرهٔ مطالبات،
 * استهلاک، مغایرت‌گیری، بستن دوره و… . ولی هیچ‌جا نمی‌گفت **کدامشان این ماه
 * انجام شده و کدام نه**. حسابداری که یکی را فراموش کند تا ماه بعد نمی‌فهمد،
 * و آن‌وقت اصلاحش یعنی سند برگشتی در دورهٔ قفل‌شده.
 *
 * ─── چرا «بررسی» و نه «تیک زدن» ────────────────────────────────
 *
 * چک‌لیستی که کاربر خودش تیک بزند، فهرستِ آرزوهاست نه کنترل. هر بند اینجا از
 * **خودِ دفتر** خوانده می‌شود: سند تسعیر در این ماه هست یا نه، نرخ ارز به‌روز
 * است یا نه، ذخیره با برآورد می‌خواند یا نه. کاربر نمی‌تواند تیکِ دروغ بزند.
 *
 * هر بند سه حالت دارد: `DONE` انجام شده · `TODO` باید انجام شود ·
 * `NA` این ماه موضوعیت ندارد (مثلاً دارایی ثابتی ثبت نشده). تفکیکِ `TODO` از
 * `NA` مهم است — «انجام نشده» و «لازم نبوده» دو چیزند.
 */
import { Prisma } from '@prisma/client';
import { shamsiMonths, MONTHS_IN_YEAR } from '../shamsi';
import { SHAMSI_MONTHS } from '../budget';
import { computeProvision } from '../provision';
import { monthlyAmount } from '../depreciation';

export class MonthEndError extends Error {}

export type CheckStatus = 'DONE' | 'TODO' | 'NA';

export interface CheckItem {
  key: string;
  title: string;
  status: CheckStatus;
  /** جملهٔ کوتاهی که می‌گوید چرا این وضعیت است */
  detail: string;
  /** کجا باید انجام شود — با چیدمانِ تب‌ها هم‌خوان است */
  action?: string | null;
}

const DAY = 86_400_000;

export async function monthEndChecklist(
  tx: Prisma.TransactionClient,
  input: { fiscalYearId: string; month: number },
) {
  const fy = await tx.glFiscalYear.findUnique({ where: { id: input.fiscalYearId } });
  if (!fy) throw new MonthEndError('سال مالی یافت نشد');
  const m = Math.min(Math.max(input.month, 1), MONTHS_IN_YEAR);
  const { from, to } = shamsiMonths(fy)[m - 1];

  const items: CheckItem[] = [];
  /** آیا در این ماه سندی با این منبع ثبت شده؟ */
  const hasEntry = async (sourceType: string) => tx.glEntry.count({
    where: { sourceType, status: 'POSTED', date: { gte: from, lte: to } },
  });

  // ── ۱) سند پیش‌نویسِ باقی‌مانده ──────────────────────────────
  const drafts = await tx.glEntry.count({
    where: { status: 'DRAFT', date: { gte: from, lte: to } },
  });
  items.push({
    key: 'drafts',
    title: 'پیش‌نویس‌های نهایی‌نشده',
    status: drafts === 0 ? 'DONE' : 'TODO',
    detail: drafts === 0
      ? 'پیش‌نویسی در این ماه نمانده'
      : `${drafts} پیش‌نویس هنوز نهایی نشده — در صورت‌های مالی نمی‌آیند`,
    action: drafts ? 'دفتر روزنامه' : null,
  });

  // ── ۲) نرخ ارز ────────────────────────────────────────────
  const currencies = await tx.glCurrency.count({ where: { code: { not: 'IRR' } } });
  if (currencies === 0) {
    items.push({ key: 'fx-rate', title: 'نرخ ارزِ پایان ماه', status: 'NA',
      detail: 'ارز خارجی تعریف نشده است' });
  } else {
    const stale = await tx.glExchangeRate.findFirst({
      where: { date: { gte: new Date(to.getTime() - 7 * DAY), lte: to } },
      orderBy: { date: 'desc' },
    });
    items.push({
      key: 'fx-rate',
      title: 'نرخ ارزِ پایان ماه',
      status: stale ? 'DONE' : 'TODO',
      detail: stale
        ? `آخرین نرخ ثبت‌شده: ${stale.date.toISOString().slice(0, 10)}`
        : 'در هفتهٔ پایانی ماه نرخی ثبت نشده — تسعیر با نرخ کهنه انجام می‌شود',
      action: stale ? null : 'تنظیمات و سلامت ← نرخ ارز',
    });
  }

  // ── ۳) تسعیر ارز ──────────────────────────────────────────
  const fxPositions = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n
    FROM "GlLine" l
    JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE l."currencyCode" <> 'IRR' AND e.status <> 'DRAFT' AND e.date <= ${to}`;
  const hasFxPositions = BigInt(fxPositions[0]?.n ?? 0n) > 0n;
  const revaluations = await hasEntry('Revaluation');
  items.push({
    key: 'revaluation',
    title: 'تسعیر اقلام ارزی',
    status: !hasFxPositions ? 'NA' : revaluations > 0 ? 'DONE' : 'TODO',
    detail: !hasFxPositions
      ? 'قلم ارزی‌ای در دفاتر نیست'
      : revaluations > 0
        ? `${revaluations} سند تسعیر در این ماه ثبت شده`
        : 'اقلام ارزی هست ولی سند تسعیری برای این ماه ثبت نشده',
    action: hasFxPositions && revaluations === 0 ? 'پایان دوره ← تسعیر ارزی' : null,
  });

  // ── ۴) ذخیرهٔ مطالبات ─────────────────────────────────────
  const prov = await computeProvision(tx, to);
  const provDelta = BigInt(prov.delta);
  items.push({
    key: 'provision',
    title: 'ذخیرهٔ مطالبات مشکوک‌الوصول',
    status: BigInt(prov.receivableTotal) === 0n ? 'NA' : provDelta === 0n ? 'DONE' : 'TODO',
    detail: BigInt(prov.receivableTotal) === 0n
      ? 'مطالبات بازی نیست'
      : provDelta === 0n
        ? `ذخیره با برآورد می‌خواند (${prov.required})`
        : `اختلاف ${prov.delta} با برآورد — سند تعدیل لازم است`,
    action: provDelta === 0n ? null : 'پایان دوره ← ذخیرهٔ مطالبات',
  });

  // ── ۵) استهلاک ────────────────────────────────────────────
  const assets = await tx.glFixedAsset.findMany({
    where: { OR: [{ disposedAt: null }, { disposedAt: { gt: to } }] },
    include: { runs: { select: { periodNo: true } } },
  });
  let dueUnposted = 0;
  for (const a of assets) {
    const done = new Set(a.runs.map((r) => r.periodNo));
    const elapsed = Math.floor((to.getTime() - a.inServiceAt.getTime()) / (30 * DAY));
    const due = Math.min(Math.max(elapsed, 0), a.usefulLifeMonths);
    for (let i = 1; i <= due; i++) if (!done.has(i)) dueUnposted++;
  }
  items.push({
    key: 'depreciation',
    title: 'استهلاک دارایی‌های ثابت',
    status: assets.length === 0 ? 'NA' : dueUnposted === 0 ? 'DONE' : 'TODO',
    detail: assets.length === 0
      ? 'دارایی ثابتی ثبت نشده است'
      : dueUnposted === 0
        ? `${assets.length} دارایی، همه به‌روز`
        : `${dueUnposted} دورهٔ استهلاکِ سررسیدشده ثبت نشده`,
    action: dueUnposted ? 'پایان دوره ← استهلاک' : null,
  });

  // ── ۶) مغایرت‌گیریِ ترازنامه ──────────────────────────────
  const [imbalance] = await tx.$queryRaw<{ diff: bigint | null }[]>`
    SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS diff
    FROM "GlLine" l
    JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE e.status <> 'DRAFT' AND e.date <= ${to}`;
  const diff = BigInt(imbalance?.diff ?? 0n);
  items.push({
    key: 'balanced',
    title: 'توازن دفتر کل',
    status: diff === 0n ? 'DONE' : 'TODO',
    detail: diff === 0n
      ? 'بدهکار و بستانکار برابرند'
      : `اختلاف ${diff} ریال — دفتر تراز نیست`,
    action: diff === 0n ? null : 'تنظیمات و سلامت ← سلامت دفاتر',
  });

  // ── ۷) حساب نقدیِ منفی ────────────────────────────────────
  const negativeCash = await tx.$queryRaw<{ code: string; name: string }[]>`
    SELECT a.code, a.name
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'DRAFT' AND a."isPostable" = true
      AND (a.code LIKE '1101%' OR a.code = '1102')
      AND e.date <= ${to}
    GROUP BY a.code, a.name
    HAVING SUM(l.debit) - SUM(l.credit) < 0`;
  items.push({
    key: 'negative-cash',
    title: 'حساب نقدیِ منفی',
    status: negativeCash.length === 0 ? 'DONE' : 'TODO',
    detail: negativeCash.length === 0
      ? 'هیچ صندوق یا بانکی منفی نیست'
      : `${negativeCash.map((c) => c.name).join('، ')} منفی است — پرداختی بیش از موجودی ثبت شده`,
    action: negativeCash.length ? 'دفتر روزنامه' : null,
  });

  // ── ۸) قفل دوره ───────────────────────────────────────────
  const lock = await tx.glPeriodLock.findFirst({
    where: { lockToDate: { gte: to } }, orderBy: { lockToDate: 'desc' },
  });
  const blockers = items.filter((i) => i.status === 'TODO').length;
  items.push({
    key: 'lock',
    title: 'قفل دوره',
    status: lock ? 'DONE' : 'TODO',
    detail: lock
      ? `دوره تا ${lock.lockToDate.toISOString().slice(0, 10)} قفل است`
      : blockers > 0
        ? `${blockers} کار باقی مانده؛ پس از انجامشان دوره را قفل کنید`
        : 'همه‌چیز آماده است — دوره را قفل کنید تا سند گذشته‌نگر ثبت نشود',
    action: lock ? null : 'پایان دوره ← سال مالی و قفل دوره',
  });

  const todo = items.filter((i) => i.status === 'TODO').length;
  const na = items.filter((i) => i.status === 'NA').length;
  return {
    fiscalYear: { id: fy.id, title: fy.title },
    month: m, label: SHAMSI_MONTHS[m - 1], from, to,
    items,
    summary: {
      total: items.length,
      done: items.length - todo - na,
      todo, na,
      /** بستنِ ماه فقط وقتی معنا دارد که هیچ `TODO`ای نمانده باشد */
      ready: todo === 0,
    },
  };
}

/** برای اطمینان از اینکه `monthlyAmount` در این ماژول هم همان است */
export { monthlyAmount };
