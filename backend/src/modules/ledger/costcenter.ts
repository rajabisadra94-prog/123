/**
 * مراکز هزینه — docs/ACCOUNTING_SPEC.md بند ۳-۲
 *
 * بُعدی **مستقل و عمود بر کدینگ**: «این هزینه مال کدام واحد/پروژه بود».
 * هیچ ربطی به درخت حساب‌ها ندارد و با آن قاطی نمی‌شود.
 *
 * اجباری‌بودنش در سطح **حساب** تنظیم می‌شود (`GlAccount.requiresCostCenter`)،
 * نه سراسری — چون «هزینهٔ حقوق» مرکز می‌خواهد ولی «موجودی بانک» نه.
 */
import { Prisma } from '@prisma/client';
import { EXCLUDE_YEAR_CLOSE } from './year-close';

export class CostCenterError extends Error {}

/**
 * درخت پیش‌فرض.
 *
 * سه واحد سازمانی و یک سرگروه برای پروژه‌ها. پروژه‌ها زیر «۹» می‌نشینند تا
 * گزارش سود و زیان بتواند «کل پروژه‌ها» را یک‌جا یا تک‌تک نشان دهد.
 */
export const DEFAULT_COST_CENTERS = [
  { code: '1', name: 'تولید' },
  { code: '2', name: 'فروش و بازاریابی' },
  { code: '3', name: 'اداری و مالی' },
  { code: '9', name: 'پروژه‌ها' },
];

export async function ensureDefaultCostCenters(tx: Prisma.TransactionClient) {
  for (const cc of DEFAULT_COST_CENTERS) {
    await tx.glCostCenter.upsert({
      where: { code: cc.code },
      update: { name: cc.name },
      create: cc,
    });
  }
}

/**
 * ساخت مرکز هزینه زیر یک والد.
 *
 * والدی که فرزند می‌گیرد دیگر خودش سند نمی‌پذیرد — همان قاعدهٔ برگ که در
 * درخت حساب‌ها هم هست. اگر والد گردش داشته باشد، تبدیلش خطا می‌دهد تا
 * گردش موجود بی‌صدا از گزارش‌ها نیفتد.
 */
export async function createCostCenter(
  tx: Prisma.TransactionClient,
  input: { code: string; name: string; parentCode?: string | null },
) {
  if (!/^[0-9A-Za-z._-]+$/.test(input.code)) {
    throw new CostCenterError(`کد مرکز هزینه نامعتبر است: «${input.code}»`);
  }

  let parentId: string | null = null;
  if (input.parentCode) {
    const parent = await tx.glCostCenter.findUnique({ where: { code: input.parentCode } });
    if (!parent) throw new CostCenterError(`مرکز هزینهٔ والد «${input.parentCode}» وجود ندارد`);

    if (parent.isPostable) {
      const used = await tx.glLine.count({ where: { costCenterId: parent.id } });
      if (used > 0) {
        throw new CostCenterError(
          `مرکز هزینهٔ «${parent.code} ${parent.name}» گردش دارد و نمی‌تواند سرگروه شود`,
        );
      }
      await tx.glCostCenter.update({ where: { id: parent.id }, data: { isPostable: false } });
    }
    parentId = parent.id;
  }

  return tx.glCostCenter.create({
    data: { code: input.code, name: input.name, parentId },
  });
}

/** مرکز هزینهٔ یک پروژه — زیر سرگروه «۹ پروژه‌ها» */
export async function ensureProjectCostCenter(tx: Prisma.TransactionClient, projectId: string) {
  const project = await tx.project.findUnique({
    where: { id: projectId },
    select: { id: true, code: true },
  });
  if (!project) throw new CostCenterError('پروژه یافت نشد');

  const code = `9.${project.code}`;
  const existing = await tx.glCostCenter.findUnique({ where: { code } });
  if (existing) return existing;

  await ensureDefaultCostCenters(tx);
  return createCostCenter(tx, { code, name: `پروژهٔ ${project.code}`, parentCode: '9' });
}

/**
 * شناسهٔ یک مرکز هزینه و همهٔ نوادگانش.
 *
 * تجمیع گزارش‌ها روی این مجموعه انجام می‌شود، پس «تولید» جمع همهٔ زیرمجموعه‌هایش
 * را نشان می‌دهد نه فقط گردش مستقیم خودش.
 */
export async function costCenterSubtree(
  tx: Prisma.TransactionClient,
  costCenterId: string,
): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE tree AS (
      SELECT id FROM "GlCostCenter" WHERE id = ${costCenterId}
      UNION ALL
      SELECT c.id FROM "GlCostCenter" c JOIN tree t ON c."parentId" = t.id
    )
    SELECT id FROM tree
  `;
  return rows.map((r) => r.id);
}

/**
 * گردش هزینه به تفکیک مرکز هزینه — پایهٔ تفکیک صورت سود و زیان (بند ۳-۲).
 *
 * ردیف‌های بدون مرکز هزینه هم برمی‌گردند با `costCenterId = null`، تا در گزارش
 * زیر «تخصیص‌نیافته» دیده شوند نه اینکه ساکت از جمع بیفتند.
 */
export async function costCenterTotals(
  tx: Prisma.TransactionClient,
  opts: { from?: Date; to?: Date } = {},
) {
  return tx.$queryRaw<
    { costCenterId: string | null; code: string | null; name: string | null; rootType: string; totalBase: bigint }[]
  >`
    SELECT c.id       AS "costCenterId",
           c.code     AS code,
           c.name     AS name,
           a."rootType"::text AS "rootType",
           (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS "totalBase"
    FROM "GlLine" l
    JOIN "GlEntry" e         ON e.id = l."entryId"
    JOIN "GlAccount" a       ON a.id = l."accountId"
    LEFT JOIN "GlCostCenter" c ON c.id = l."costCenterId"
    WHERE e.status <> 'DRAFT'
      AND a."statement" = 'INCOME_STATEMENT'
      ${opts.from ? Prisma.sql`AND e.date >= ${opts.from}` : Prisma.empty}
      ${opts.to ? Prisma.sql`AND e.date <= ${opts.to}` : Prisma.empty}
      -- دومین گزارشِ دوره‌ایِ سود و زیان؛ همان کنارگذاری‌ای که صورت سود و زیان
      -- دارد، وگرنه سند اختتامیه به‌صورت یک سطلِ «بدون مرکز هزینه» ظاهر می‌شود
      -- که دقیقاً قرینهٔ جمعِ همهٔ مراکز است (ممیزی ن۱-ب).
      ${EXCLUDE_YEAR_CLOSE}
    GROUP BY c.id, c.code, c.name, a."rootType"
    ORDER BY c.code NULLS LAST, a."rootType"
  `;
}
