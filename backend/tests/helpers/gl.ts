import { PrismaClient, Prisma } from '@prisma/client';
import { testDatabaseUrl } from './db-url';
import { ensureChart } from '../../src/modules/ledger/chart';
import { resetBusinessData as sharedReset } from './cleanup';

export const gl = new PrismaClient({
  datasources: { db: { url: testDatabaseUrl() } },
  log: ['error'],
});

/** سال مالی نمونه — بازهٔ ۱۴۰۵ شمسی به میلادی */
export const FY_START = new Date('2026-03-21T00:00:00Z');
export const FY_END = new Date('2027-03-20T00:00:00Z');
export const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
export const DEFAULT_DATE = D('2026-06-01');

/**
 * پاک‌سازی کامل هستهٔ جدید.
 * ⚠️ ردیف‌ها با SQL خام حذف می‌شوند چون تریگر تغییرناپذیری (قاعدهٔ ۴) جلوی
 * حذف از مسیر عادی را می‌گیرد — و این دقیقاً همان چیزی است که باید بگیرد.
 */
export async function resetGl() {
  // ترتیب: هر چیزی که به سند یا تفصیلی ارجاع می‌دهد، پیش از خودشان می‌رود
  await gl.glPayrollItem.deleteMany({});
  await gl.glPayrollRun.deleteMany({});
  await gl.glEmployee.deleteMany({});
  await gl.glChequeTransition.deleteMany({});
  await gl.glCheque.deleteMany({});
  await gl.glPettyCashFund.deleteMany({});
  await gl.$executeRawUnsafe('ALTER TABLE "GlLine" DISABLE TRIGGER gl_line_immutable_trg');
  await gl.$executeRawUnsafe('ALTER TABLE "GlEntry" DISABLE TRIGGER gl_entry_transitions_trg');
  try {
    await gl.$executeRawUnsafe('DELETE FROM "GlLine"');
    await gl.$executeRawUnsafe('DELETE FROM "GlEntry"');
  } finally {
    await gl.$executeRawUnsafe('ALTER TABLE "GlLine" ENABLE TRIGGER gl_line_immutable_trg');
    await gl.$executeRawUnsafe('ALTER TABLE "GlEntry" ENABLE TRIGGER gl_entry_transitions_trg');
  }
  await gl.glSerialCounter.deleteMany({});
  await gl.glPeriodLock.deleteMany({});
  await gl.glFiscalYear.deleteMany({});
  await gl.glSubsidiary.deleteMany({});
  await gl.glCostCenter.deleteMany({});
}

export async function seedGlChart() {
  return gl.$transaction((tx) => ensureChart(tx), { timeout: 120_000 });
}

export async function makeFiscalYear(title = '۱۴۰۵') {
  const fy = await gl.glFiscalYear.create({
    data: { title, startDate: FY_START, endDate: FY_END },
  });
  await gl.glSerialCounter.create({ data: { fiscalYearId: fy.id, next: 1 } });
  return fy;
}

export const accountByCode = (code: string) =>
  gl.glAccount.findUniqueOrThrow({ where: { code } });

export async function makeSubsidiary(kind: any, name: string, code = name) {
  return gl.glSubsidiary.create({ data: { code, name, kind } });
}

export async function makeCostCenter(code: string, name: string) {
  return gl.glCostCenter.create({ data: { code, name } });
}

/** درج مستقیم ردیف، دور زدن موتور — برای سنجش اجبارهای سطح دیتابیس */
export async function rawInsertLine(
  tx: Prisma.TransactionClient,
  entryId: string,
  data: Record<string, unknown>,
) {
  const cols = Object.keys(data);
  const vals = cols.map((c) => (data as any)[c]);
  const placeholders = vals.map((_, i) => `$${i + 3}`).join(', ');
  return tx.$executeRawUnsafe(
    `INSERT INTO "GlLine" (id, "entryId", ${cols.map((c) => `"${c}"`).join(', ')})
     VALUES (gen_random_uuid()::text, $1, ${placeholders})`,
    entryId,
    null,
    ...vals,
  );
}

/** جمع مانده به ارز پایه از دفتر — هیچ ماندهٔ ذخیره‌شده‌ای وجود ندارد (قاعدهٔ ۳) */
export async function accountBalanceBase(accountId: string): Promise<bigint> {
  const rows = await gl.$queryRaw<{ bal: bigint | null }[]>`
    SELECT COALESCE(SUM(l."debitBase") - SUM(l."creditBase"), 0)::bigint AS bal
    FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE l."accountId" = ${accountId} AND e.status <> 'DRAFT'
  `;
  return BigInt(rows[0]?.bal ?? 0n);
}

/**
 * انتظار خطا با تطبیق پیام.
 *
 * ⚠️ چرا نرمال‌سازی لازم است: خطاهای تریگر از لایهٔ Rust پرسما رد می‌شوند و آنجا
 * **نیم‌فاصله (ZWNJ) به‌صورت `\u{200c}` متنی escape می‌شود**. پس regexهایی که
 * نیم‌فاصله دارند هرگز نمی‌خوانند، حتی وقتی خطا دقیقاً همان است.
 */
export async function expectRejects(fn: () => Promise<unknown>, fragment: RegExp) {
  let err: any;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error('انتظار خطا داشتیم ولی عملیات موفق شد');
  const msg = String(err.message ?? err).replace(/\\u\{200c\}/g, '\u200c');
  if (!fragment.test(msg)) {
    throw new Error(`پیام خطا با ${fragment} نمی‌خواند.\nپیام واقعی:\n${msg.slice(0, 900)}`);
  }
  return err;
}

/** پاک‌سازی دادهٔ کسب‌وکاری — تعریف مشترک در `cleanup.ts` */
export const resetBusinessData = () => sharedReset(gl);
