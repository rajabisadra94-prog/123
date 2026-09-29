/**
 * تفصیلی شناور — docs/ACCOUNTING_SPEC.md بند ۳-۱
 *
 * طرف‌حساب‌ها یک بُعد مستقل‌اند و در درخت کدینگ تکثیر نمی‌شوند. مشتری «الف»
 * **یک** تفصیلی است، حتی اگر با چهار ارز و زیر سه معین مختلف گردش داشته باشد.
 *
 * این ماژول تنها جایی است که تفصیلی ساخته می‌شود. هیچ ماژول کسب‌وکاری نباید
 * مستقیم `glSubsidiary.create` صدا بزند، وگرنه کدگذاری و یکتایی از دست می‌رود.
 */
import { Prisma, GlSubsidiaryKind } from '@prisma/client';

/**
 * بلوک کد هر نوع تفصیلی.
 *
 * چرا بلوک عددی و نه شمارهٔ پشت‌سرهم: در عمل حسابدار با دیدن کد باید بفهمد
 * طرف‌حساب از چه جنسی است. «۱۰۰۳» یعنی مشتری، «۲۰۰۷» یعنی سازنده.
 */
export const KIND_BLOCKS: Record<GlSubsidiaryKind, number> = {
  CUSTOMER: 1000,
  PRODUCER: 2000,
  SUPPLIER: 3000,
  CARRIER: 4000,
  EXCHANGE: 5000,
  AGENT: 6000,
  EMPLOYEE: 7000,
  PETTY_CASH_HOLDER: 7500,
  BANK: 8000,
  OTHER: 9000,
};

/** نگاشت مدل کسب‌وکار به نوع تفصیلی */
export const REF_TYPE_KIND: Record<string, GlSubsidiaryKind> = {
  Customer: 'CUSTOMER',
  Producer: 'PRODUCER',
  Supplier: 'SUPPLIER',
  ShippingCompany: 'CARRIER',
  Exchange: 'EXCHANGE',
  CommissionAgent: 'AGENT',
};

export class SubsidiaryError extends Error {}

/**
 * کد بعدی در بلوک یک نوع.
 *
 * قفل مشورتی گرفته می‌شود تا دو ساخت همزمان به یک کد نرسند. برخلاف شمارهٔ سند،
 * اینجا **شکاف اشکالی ندارد** — کد تفصیلی الزام قانونیِ پیوستگی ندارد و ساختش
 * هم نادر است. پس جدول شمارندهٔ جدا نمی‌سازیم.
 */
async function nextCode(tx: Prisma.TransactionClient, kind: GlSubsidiaryKind): Promise<string> {
  const block = KIND_BLOCKS[kind];
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${block})`;

  const rows = await tx.$queryRaw<{ max: number | null }[]>`
    SELECT MAX(code::int) AS max FROM "GlSubsidiary"
    WHERE kind = ${kind}::"GlSubsidiaryKind" AND code ~ '^[0-9]+$'
  `;
  const next = Math.max(rows[0]?.max ?? 0, block) + 1;
  if (next >= block + 1000) {
    throw new SubsidiaryError(`بلوک کد تفصیلی برای نوع ${kind} پر شده است`);
  }
  return String(next);
}

/**
 * تفصیلی یک طرف‌حساب موجود را برمی‌گرداند و اگر نباشد می‌سازد.
 *
 * نام از رکورد اصلی می‌آید و اگر عوض شده باشد به‌روز می‌شود — تفصیلی کپی داده
 * نیست، فقط ارجاع است (`refType`/`refId` منبع حقیقت‌اند).
 */
export async function ensureSubsidiary(
  tx: Prisma.TransactionClient,
  kind: GlSubsidiaryKind,
  refType: string,
  refId: string,
  name: string,
) {
  const existing = await tx.glSubsidiary.findUnique({ where: { refType_refId: { refType, refId } } });
  if (existing) {
    if (existing.name !== name) {
      return tx.glSubsidiary.update({ where: { id: existing.id }, data: { name } });
    }
    return existing;
  }

  return tx.glSubsidiary.create({
    data: { code: await nextCode(tx, kind), name, kind, refType, refId },
  });
}

/** تفصیلی‌ای که به رکورد کسب‌وکاری وصل نیست (مثلاً «متفرقه») */
export async function createStandalone(
  tx: Prisma.TransactionClient,
  kind: GlSubsidiaryKind,
  name: string,
) {
  return tx.glSubsidiary.create({
    data: { code: await nextCode(tx, kind), name, kind },
  });
}

type PartySource = { refType: string; rows: { id: string; name: string }[] };

/**
 * ساخت تفصیلی برای **همهٔ** طرف‌حساب‌های موجود سیستم.
 *
 * idempotent است و می‌شود هر بار اجرا کرد؛ تفصیلی‌های موجود فقط نامشان
 * هم‌گام می‌شود.
 */
export async function backfillSubsidiaries(tx: Prisma.TransactionClient) {
  const sources: PartySource[] = [
    { refType: 'Customer', rows: await tx.customer.findMany({ select: { id: true, name: true } }) },
    { refType: 'Producer', rows: await tx.producer.findMany({ select: { id: true, name: true } }) },
    { refType: 'Supplier', rows: await tx.supplier.findMany({ select: { id: true, name: true } }) },
    { refType: 'ShippingCompany', rows: await tx.shippingCompany.findMany({ select: { id: true, name: true } }) },
    { refType: 'Exchange', rows: await tx.exchange.findMany({ select: { id: true, name: true } }) },
    { refType: 'CommissionAgent', rows: await tx.commissionAgent.findMany({ select: { id: true, name: true } }) },
  ];

  let created = 0;
  let renamed = 0;
  for (const src of sources) {
    const kind = REF_TYPE_KIND[src.refType];
    for (const row of src.rows) {
      const before = await tx.glSubsidiary.findUnique({
        where: { refType_refId: { refType: src.refType, refId: row.id } },
        select: { id: true, name: true },
      });
      await ensureSubsidiary(tx, kind, src.refType, row.id, row.name);
      if (!before) created++;
      else if (before.name !== row.name) renamed++;
    }
  }
  return { created, renamed, total: sources.reduce((s, x) => s + x.rows.length, 0) };
}

/**
 * موضع‌های ارزی یک تفصیلی، به تفکیک حساب معین و ارز.
 *
 * این همان چیزی است که مدل «کیف پول به‌ازای هر ارز» می‌خواست بدهد — ولی اینجا
 * از دفتر محاسبه می‌شود، نه از گره‌های تکثیرشدهٔ درخت.
 */
export async function subsidiaryPositions(
  tx: Prisma.TransactionClient,
  subsidiaryId: string,
  asOf?: Date,
) {
  return tx.$queryRaw<
    { accountId: string; code: string; accountName: string; currencyCode: string; balance: bigint; balanceBase: bigint }[]
  >`
    SELECT a.id           AS "accountId",
           a.code         AS code,
           a.name         AS "accountName",
           l."currencyCode",
           (SUM(l.debit) - SUM(l.credit))::bigint             AS balance,
           (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS "balanceBase"
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE l."subsidiaryId" = ${subsidiaryId}
      AND e.status <> 'DRAFT'
      ${asOf ? Prisma.sql`AND e.date <= ${asOf}` : Prisma.empty}
    GROUP BY a.id, a.code, a.name, l."currencyCode"
    HAVING SUM(l.debit) - SUM(l.credit) <> 0
        OR SUM(l."debitBase") - SUM(l."creditBase") <> 0
    ORDER BY a.code, l."currencyCode"
  `;
}

/** گردش و ماندهٔ همهٔ تفصیلی‌های یک حساب معین — «دفتر تفصیلی» */
export async function subsidiaryLedger(
  tx: Prisma.TransactionClient,
  accountCode: string,
  asOf?: Date,
) {
  return tx.$queryRaw<
    { subsidiaryId: string; code: string; name: string; kind: string; currencyCode: string; balance: bigint; balanceBase: bigint }[]
  >`
    SELECT s.id AS "subsidiaryId", s.code, s.name, s.kind::text AS kind,
           l."currencyCode",
           (SUM(l.debit) - SUM(l.credit))::bigint             AS balance,
           (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS "balanceBase"
    FROM "GlLine" l
    JOIN "GlEntry" e      ON e.id = l."entryId"
    JOIN "GlAccount" a    ON a.id = l."accountId"
    JOIN "GlSubsidiary" s ON s.id = l."subsidiaryId"
    WHERE a.code = ${accountCode}
      AND e.status <> 'DRAFT'
      ${asOf ? Prisma.sql`AND e.date <= ${asOf}` : Prisma.empty}
    GROUP BY s.id, s.code, s.name, s.kind, l."currencyCode"
    HAVING SUM(l."debitBase") - SUM(l."creditBase") <> 0
    ORDER BY s.code, l."currencyCode"
  `;
}
