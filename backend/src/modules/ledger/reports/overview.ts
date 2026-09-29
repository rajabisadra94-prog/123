/**
 * نمای کلیِ مالی — داشبورد هستهٔ جدید.
 *
 * معادلِ `/accounting/overview` هستهٔ قدیمی، ولی:
 *  • همه‌چیز از **دفتر** خوانده می‌شود (قاعدهٔ ۳ — بدون ماندهٔ ذخیره‌شده)
 *  • معادل ریالی از خودِ ستون `*Base` می‌آید، نه ضرب در نرخ زنده
 *    (نرخ زندهٔ داخل گزارش = سود/زیان نوسان‌دار و غیرقابل‌بازتولید)
 */
import { Prisma, GlEntryType } from '@prisma/client';

/** چند روز از آخرین نرخ گذشته باشد «کهنه» است */
const RATE_STALE_DAYS = 3;

export async function overview(tx: Prisma.TransactionClient) {
  const asOf = new Date();

  // ماندهٔ سه دستهٔ کلیدی به تفکیک ارز — خام و پایه با هم
  const rows = await tx.$queryRaw<
    { bucket: 'cash' | 'receivable' | 'payable'; currencyCode: string; amount: bigint; base: bigint }[]
  >`
    SELECT
      CASE
        WHEN a.code LIKE '1101%' OR a.code = '1102' THEN 'cash'
        WHEN a.code = '1104'                        THEN 'receivable'
        WHEN a.code = '2101'                        THEN 'payable'
      END AS bucket,
      l."currencyCode",
      (SUM(l.debit) - SUM(l.credit))::bigint             AS amount,
      (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS base
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'DRAFT'
      AND (a.code LIKE '1101%' OR a.code IN ('1102', '1104', '2101'))
    GROUP BY 1, l."currencyCode"
  `;

  type Bucket = { byCurrency: Record<string, { amount: string; base: string }>; totalBase: bigint };
  const mk = (): Bucket => ({ byCurrency: {}, totalBase: 0n });
  const cash = mk(), receivable = mk(), payable = mk();

  for (const r of rows) {
    if (!r.bucket) continue;
    // پرداختنی ماهیت بستانکار است ⇒ علامت برمی‌گردد تا «بدهی ما» مثبت شود
    const flip = r.bucket === 'payable' ? -1n : 1n;
    const amount = BigInt(r.amount) * flip;
    const base = BigInt(r.base) * flip;
    const target = r.bucket === 'cash' ? cash : r.bucket === 'receivable' ? receivable : payable;
    target.byCurrency[r.currencyCode] = { amount: amount.toString(), base: base.toString() };
    target.totalBase += base;
  }

  const netBase = cash.totalBase + receivable.totalBase - payable.totalBase;

  // ── هشدارها ──────────────────────────────────────────────
  const negativeCashAccounts = await tx.$queryRaw<
    { code: string; name: string; currencyCode: string; amount: bigint }[]
  >`
    SELECT a.code, a.name, l."currencyCode",
           (SUM(l.debit) - SUM(l.credit))::bigint AS amount
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e.status <> 'DRAFT' AND a."isPostable" = true
      AND (a.code LIKE '1101%' OR a.code = '1102')
    GROUP BY a.code, a.name, l."currencyCode"
    HAVING SUM(l.debit) - SUM(l.credit) < 0
  `;

  const partiesWeOwe = await tx.$queryRaw<
    { code: string; name: string; currencyCode: string; amount: bigint }[]
  >`
    SELECT s.code, s.name, l."currencyCode",
           (SUM(l.credit) - SUM(l.debit))::bigint AS amount
    FROM "GlLine" l
    JOIN "GlEntry" e      ON e.id = l."entryId"
    JOIN "GlAccount" a    ON a.id = l."accountId"
    JOIN "GlSubsidiary" s ON s.id = l."subsidiaryId"
    WHERE e.status <> 'DRAFT' AND a.code = '1104'
    GROUP BY s.code, s.name, l."currencyCode"
    HAVING SUM(l.credit) - SUM(l.debit) > 0
  `;

  // ممیزی ب۱۳: سنِ نرخ نسبت به نرخِ **مؤثرِ امروز** سنجیده می‌شود (date <= asOf)،
  // نه تازه‌ترین ردیف — وگرنه یک نرخِ تاریخ‌آینده هشدارِ کهنگی را برای همیشه
  // خاموش می‌کند (rateAgeDays منفی).
  const [effectiveUsdRate, futureUsdRate] = await Promise.all([
    tx.glExchangeRate.findFirst({ where: { from: 'USD', to: 'IRR', date: { lte: asOf } }, orderBy: { date: 'desc' } }),
    tx.glExchangeRate.findFirst({ where: { from: 'USD', to: 'IRR', date: { gt: asOf } }, orderBy: { date: 'asc' } }),
  ]);
  const rateAgeDays = effectiveUsdRate
    ? Math.max(0, Math.floor((asOf.getTime() - new Date(effectiveUsdRate.date).getTime()) / 86_400_000))
    : Infinity;
  const ratesStale = rateAgeDays > RATE_STALE_DAYS;
  const hasFutureRate = futureUsdRate != null;

  // محموله‌های رسیده بدون فاکتور حمل — پرسش کسب‌وکاری، مستقل از دفتر
  const shipmentsAwaitingFreight = await tx.mainShipment.findMany({
    where: { status: 'ARRIVED', freightInvoiceRegistered: false },
    select: { id: true, code: true, shippingCompany: { select: { name: true } } },
  }).catch(() => [] as { id: string; code: string; shippingCompany: { name: string } }[]);

  /**
   * «آخرین اسناد» یعنی **آخرین کاری که کسی کرده**، نه آخرین ردیفی که در
   * جدول نشسته.
   *
   * سندهای افتتاحیه و اختتامیه در یک لحظه و با تاریخِ آخرِ سال ثبت می‌شوند،
   * پس همیشه بالای مرتب‌سازی می‌نشینند. روی دادهٔ واقعی، هر هشت سطرِ نمای
   * کلی «سند اختتامیه» و «برگشت سند اختتامیه» بود — یعنی پنلی که قرار بود
   * بگوید در سامانه چه می‌گذرد، فقط می‌گفت سال بسته شده. یک بار. هشت بار.
   *
   * پس افتتاحیه/اختتامیه و برگشت‌شان کنار گذاشته می‌شوند. برگشتِ یک سند
   * عادی می‌ماند — آن واقعاً کارِ کسی است و دیدنش مهم است.
   */
  const SYSTEM_TYPES: GlEntryType[] = ['OPENING', 'CLOSING'];
  const recentEntries = await tx.glEntry.findMany({
    where: {
      entryType: { notIn: SYSTEM_TYPES },
      NOT: { reverses: { entryType: { in: SYSTEM_TYPES } } },
    },
    orderBy: [{ date: 'desc' }, { serial: 'desc' }],
    take: 8,
    include: {
      lines: {
        include: { account: { select: { code: true, name: true } } },
        orderBy: { lineNo: 'asc' },
      },
    },
  });

  return {
    asOf,
    cash: { ...cash, totalBase: cash.totalBase.toString() },
    receivable: { ...receivable, totalBase: receivable.totalBase.toString() },
    payable: { ...payable, totalBase: payable.totalBase.toString() },
    netBase: netBase.toString(),
    alerts: {
      ratesStale,
      rateAgeDays: Number.isFinite(rateAgeDays) ? rateAgeDays : null,
      hasFutureRate,
      negativeCashAccounts: negativeCashAccounts.map((r) => ({ ...r, amount: r.amount.toString() })),
      partiesWeOwe: partiesWeOwe.map((r) => ({ ...r, amount: r.amount.toString() })),
      shipmentsAwaitingFreight: shipmentsAwaitingFreight.map((s) => ({
        id: s.id, code: s.code, carrier: s.shippingCompany?.name ?? '—',
      })),
    },
    recentEntries,
  };
}
