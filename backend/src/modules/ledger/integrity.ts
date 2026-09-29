/**
 * بررسی سلامت دفاتر هستهٔ جدید.
 *
 * چرا لازم است با وجود اجبارهای دیتابیس: تریگرها جلوی **ورود** داده‌ی بد را
 * می‌گیرند، ولی داده‌ای که پیش از نصب تریگر آمده، یا از مسیر مهاجرت وارد شده،
 * یا بعد از تغییر پیکربندی حساب معنایش عوض شده، همچنان می‌تواند غلط باشد.
 *
 * هر بررسی باید **همیشه** خالی باشد. غیرخالی‌بودن یعنی اشکال، نه هشدار.
 */
import { Prisma } from '@prisma/client';

export interface IntegrityReport {
  ok: boolean;
  unbalancedEntries: { serial: number | null; description: string; diff: bigint }[];
  missingSubsidiary: { serial: number | null; code: string; accountName: string }[];
  disallowedSubsidiaryKind: { serial: number | null; code: string; kind: string }[];
  missingCostCenter: { serial: number | null; code: string; accountName: string }[];
  postingsOnGroups: { serial: number | null; code: string; accountName: string }[];
  controlMismatch: { code: string; accountName: string; currencyCode: string; control: bigint; subsidiaries: bigint; diff: bigint }[];
  orphanSubsidiaries: { id: string; code: string; name: string; refType: string; refId: string }[];
  serialGaps: { fiscalYear: string; missing: number }[];
  /** دفتر کمکی دارایی ثابت در برابر ۱۲۰۱ و ۱۲۰۲ (ممیزی ب۵) */
  assetRegisterMismatch: { check: string; code: string; register: bigint; ledger: bigint; diff: bigint }[];
  checked: { entries: number; lines: number; subsidiaries: number };
}

export async function integrityCheck(tx: Prisma.TransactionClient): Promise<IntegrityReport> {
  // ── سند ناتراز ──
  const unbalancedEntries = await tx.$queryRaw<{ serial: number | null; description: string; diff: bigint }[]>`
    SELECT e.serial, e.description,
           (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS diff
    FROM "GlEntry" e JOIN "GlLine" l ON l."entryId" = e.id
    WHERE e.status <> 'DRAFT'
    GROUP BY e.id, e.serial, e.description
    HAVING SUM(l."debitBase") <> SUM(l."creditBase")
    ORDER BY e.serial
  `;

  // ── تفصیلی اجباری که خالی مانده ──
  const missingSubsidiary = await tx.$queryRaw<{ serial: number | null; code: string; accountName: string }[]>`
    SELECT e.serial, a.code, a.name AS "accountName"
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE a."requiresSubsidiary" AND l."subsidiaryId" IS NULL
    ORDER BY e.serial
  `;

  // ── تفصیلی از نوعی که این حساب نمی‌پذیرد ──
  const disallowedSubsidiaryKind = await tx.$queryRaw<{ serial: number | null; code: string; kind: string }[]>`
    SELECT e.serial, a.code, s.kind::text AS kind
    FROM "GlLine" l
    JOIN "GlEntry" e      ON e.id = l."entryId"
    JOIN "GlAccount" a    ON a.id = l."accountId"
    JOIN "GlSubsidiary" s ON s.id = l."subsidiaryId"
    WHERE array_length(a."subsidiaryKinds", 1) IS NOT NULL
      AND NOT (s.kind = ANY (a."subsidiaryKinds"))
    ORDER BY e.serial
  `;

  const missingCostCenter = await tx.$queryRaw<{ serial: number | null; code: string; accountName: string }[]>`
    SELECT e.serial, a.code, a.name AS "accountName"
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE a."requiresCostCenter" AND l."costCenterId" IS NULL
    ORDER BY e.serial
  `;

  // ── ثبت روی سرگروه ──
  const postingsOnGroups = await tx.$queryRaw<{ serial: number | null; code: string; accountName: string }[]>`
    SELECT e.serial, a.code, a.name AS "accountName"
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE NOT a."isPostable"
    ORDER BY e.serial
  `;

  /**
   * ── تطبیق کنترلی با معین تفصیلی ──
   *
   * این همان نگرانی‌ای است که طراحی قبلی («کیف پول به‌ازای هر ارز») را ساخته بود.
   * در مدل جدید نمی‌تواند منحرف شود، چون هر دو طرف از **یک** منبع محاسبه می‌شوند
   * و ماندهٔ ذخیره‌شده‌ای وجود ندارد. این بررسی نگهبان همان خاصیت است: اگر روزی
   * کسی کش یا ماندهٔ مادی‌شده اضافه کند، اینجا داد می‌زند.
   */
  const controlMismatch = await tx.$queryRaw<
    { code: string; accountName: string; currencyCode: string; control: bigint; subsidiaries: bigint; diff: bigint }[]
  >`
    WITH per_account AS (
      SELECT a.id, a.code, a.name, l."currencyCode",
             SUM(l."debitBase") - SUM(l."creditBase") AS control,
             SUM(CASE WHEN l."subsidiaryId" IS NOT NULL
                      THEN l."debitBase" - l."creditBase" ELSE 0 END) AS subs
      FROM "GlLine" l
      JOIN "GlEntry" e   ON e.id = l."entryId"
      JOIN "GlAccount" a ON a.id = l."accountId"
      WHERE a."requiresSubsidiary" AND e.status <> 'DRAFT'
      GROUP BY a.id, a.code, a.name, l."currencyCode"
    )
    SELECT code, name AS "accountName", "currencyCode",
           control::bigint, subs::bigint AS subsidiaries, (control - subs)::bigint AS diff
    FROM per_account WHERE control <> subs
  `;

  // ── تفصیلی‌ای که رکورد اصلی‌اش دیگر نیست ──
  const orphanSubsidiaries = await tx.$queryRaw<
    { id: string; code: string; name: string; refType: string; refId: string }[]
  >`
    SELECT s.id, s.code, s.name, s."refType", s."refId"
    FROM "GlSubsidiary" s
    WHERE s."refType" IS NOT NULL AND s."refId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "Customer"        c WHERE s."refType" = 'Customer'        AND c.id = s."refId"
        UNION ALL SELECT 1 FROM "Producer"        p WHERE s."refType" = 'Producer'        AND p.id = s."refId"
        UNION ALL SELECT 1 FROM "Supplier"        u WHERE s."refType" = 'Supplier'        AND u.id = s."refId"
        UNION ALL SELECT 1 FROM "ShippingCompany" h WHERE s."refType" = 'ShippingCompany' AND h.id = s."refId"
        UNION ALL SELECT 1 FROM "Exchange"        x WHERE s."refType" = 'Exchange'        AND x.id = s."refId"
        UNION ALL SELECT 1 FROM "CommissionAgent" g WHERE s."refType" = 'CommissionAgent' AND g.id = s."refId"
      )
  `;

  /**
   * ── شکاف در شمارهٔ سند ──
   * سریال باید از ۱ تا بیشینه پیوسته باشد. شکاف یعنی جایی سند حذف شده یا
   * شماره‌ای بیرون از تراکنش مصرف شده — هر دو نقض بند ۳-۴.
   */
  const serialGaps = await tx.$queryRaw<{ fiscalYear: string; missing: number }[]>`
    SELECT fy.title AS "fiscalYear", g.n::int AS missing
    FROM "GlFiscalYear" fy
    JOIN LATERAL (
      SELECT generate_series(1, COALESCE(MAX(e.serial), 0)) AS n
      FROM "GlEntry" e WHERE e."fiscalYearId" = fy.id
    ) g ON TRUE
    WHERE NOT EXISTS (
      SELECT 1 FROM "GlEntry" e2
      WHERE e2."fiscalYearId" = fy.id AND e2.serial = g.n
    )
    ORDER BY fy.title, g.n
  `;

  /**
   * ── مغایرت دفتر دارایی ثابت با دفتر کل (ممیزی ب۵) ──
   *
   * ثبت دارایی در دفتر کمکی سند سرمایه‌ای‌شدن نمی‌زند — خرید جداگانه ثبت
   * می‌شود و این درست است. اما هیچ‌چیز نمی‌سنجید که این دو با هم بخوانند.
   * نتیجه‌اش این بود که می‌شد برای دارایی‌ای که اصلاً در دفتر کل نیست
   * استهلاک ثبت کرد و «دارایی غیرجاریِ منفی» در ترازنامه ساخت، در حالی که
   * همین گزارش می‌گفت `ok: true`.
   *
   * دو کنترل: بهای داراییِ واگذارنشده در برابر ماندهٔ ۱۲۰۱، و استهلاکِ
   * ثبت‌شده در برابر ماندهٔ ۱۲۰۲.
   */
  const assetRegisterMismatch = await tx.$queryRaw<
    { check: string; code: string; register: bigint; ledger: bigint; diff: bigint }[]
  >`
    WITH ledger AS (
      SELECT a.code,
             COALESCE(SUM(l."debitBase" - l."creditBase"), 0) AS bal
      FROM "GlAccount" a
      LEFT JOIN "GlLine" l  ON l."accountId" = a.id
      LEFT JOIN "GlEntry" e ON e.id = l."entryId" AND e.status <> 'DRAFT'
      WHERE a.code IN ('1201', '1202')
      GROUP BY a.code
    ),
    reg AS (
      SELECT
        COALESCE(SUM(CASE WHEN fa."disposedAt" IS NULL THEN fa.cost ELSE 0 END), 0) AS cost,
        COALESCE((SELECT SUM(r.amount) FROM "GlDepreciationRun" r), 0)              AS accum
      FROM "GlFixedAsset" fa
    )
    SELECT 'بهای دارایی ثابت' AS check, '1201' AS code,
           reg.cost::bigint AS register,
           COALESCE((SELECT bal FROM ledger WHERE code = '1201'), 0)::bigint AS ledger,
           (reg.cost - COALESCE((SELECT bal FROM ledger WHERE code = '1201'), 0))::bigint AS diff
    FROM reg
    WHERE reg.cost <> COALESCE((SELECT bal FROM ledger WHERE code = '1201'), 0)
    UNION ALL
    SELECT 'استهلاک انباشته', '1202',
           reg.accum::bigint,
           (-COALESCE((SELECT bal FROM ledger WHERE code = '1202'), 0))::bigint,
           (reg.accum + COALESCE((SELECT bal FROM ledger WHERE code = '1202'), 0))::bigint
    FROM reg
    WHERE reg.accum <> -COALESCE((SELECT bal FROM ledger WHERE code = '1202'), 0)
  `;

  const [entries, lines, subsidiaries] = await Promise.all([
    tx.glEntry.count(),
    tx.glLine.count(),
    tx.glSubsidiary.count(),
  ]);

  const report: Omit<IntegrityReport, 'ok'> = {
    unbalancedEntries, missingSubsidiary, disallowedSubsidiaryKind,
    missingCostCenter, postingsOnGroups, controlMismatch,
    orphanSubsidiaries, serialGaps, assetRegisterMismatch,
    checked: { entries, lines, subsidiaries },
  };

  const ok = [
    unbalancedEntries, missingSubsidiary, disallowedSubsidiaryKind,
    missingCostCenter, postingsOnGroups, controlMismatch,
    orphanSubsidiaries, serialGaps, assetRegisterMismatch,
  ].every((x) => x.length === 0);

  return { ok, ...report };
}
