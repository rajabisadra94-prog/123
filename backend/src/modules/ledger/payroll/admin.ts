/**
 * حقوق — کارِ اداری کنارِ موتور: کارکنان، نمای نرخ‌ها، و اصلاح لیست.
 *
 * محاسبه در `engine.ts` است و چرخهٔ سند در `run.ts`. این فایل فقط منطقی را که
 * لایهٔ HTTP لازم دارد از مسیر جدا می‌کند تا تست‌پذیر بماند — مثل `../admin.ts`
 * برای چارت.
 */
import { Prisma } from '@prisma/client';
import { Minor } from '../money';
import { createStandalone } from '../subsidiary';
import { reverse } from '../poster';
import { RATE_KEYS, OPTIONAL_RATE_KEYS, OPTIONAL_RATE_DEFAULTS } from './rates';
import { amendRun, PayrollError, PayrollInputRow } from './run';
import { nationalIdProblem, normalizeNationalId } from '../national-id';

/**
 * کد ملی، اگر داده شود، همین‌جا سنجیده و **یکدست** ذخیره می‌شود.
 *
 * جای درستِ این بررسی همین‌جاست نه لایهٔ HTTP، چون فهرست مالیات از پایگاه
 * داده می‌خوانَد نه از فرم؛ هر مسیرِ دیگری که کارمند بسازد باید از همین در
 * رد شود. ارقام فارسی هم به لاتین تبدیل می‌شوند — کاربر با کیبورد فارسی
 * تایپ می‌کند و `۱۲۳…` در فایل مالیاتی بی‌معنی است.
 */
function cleanNationalId(raw: unknown): string | null {
  if (raw == null || String(raw).trim() === '') return null;
  const p = nationalIdProblem(String(raw));
  if (p) throw new PayrollError(p);
  return normalizeNationalId(String(raw));
}

// ───────────────────────────────────────────────────────────────
// کارکنان — هر کارمند یک تفصیلی شناور از نوع EMPLOYEE (الزام بند ۳-۶)
// ───────────────────────────────────────────────────────────────

export interface CreateEmployeeInput {
  code: string;
  name: string;
  nationalId?: string | null;
  insuranceNo?: string | null;
  hireDate: Date;
  endDate?: Date | null;
  baseSalary: Minor;
  childrenCount?: number;
  isMarried?: boolean;
  costCenterId?: string | null;
}

export async function createEmployee(tx: Prisma.TransactionClient, input: CreateEmployeeInput) {
  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) throw new PayrollError('کد کارمند لازم است');
  if (!name) throw new PayrollError('نام کارمند لازم است');
  if (input.baseSalary <= 0n) throw new PayrollError('حقوق پایه باید بزرگ‌تر از صفر باشد');

  const dup = await tx.glEmployee.findUnique({ where: { code } });
  if (dup) throw new PayrollError(`کد کارمند «${code}» تکراری است`);

  const sub = await createStandalone(tx, 'EMPLOYEE', name);
  return tx.glEmployee.create({
    data: {
      code,
      subsidiaryId: sub.id,
      name,
      nationalId: cleanNationalId(input.nationalId),
      insuranceNo: input.insuranceNo ?? null,
      hireDate: input.hireDate,
      endDate: input.endDate ?? null,
      baseSalary: input.baseSalary,
      childrenCount: input.childrenCount ?? 0,
      isMarried: input.isMarried ?? false,
      costCenterId: input.costCenterId ?? null,
    },
    include: { subsidiary: { select: { code: true } } },
  });
}

const EMP_EDITABLE = [
  'name', 'nationalId', 'insuranceNo', 'hireDate', 'endDate',
  'baseSalary', 'childrenCount', 'isMarried', 'costCenterId', 'isActive',
] as const;

export async function updateEmployee(
  tx: Prisma.TransactionClient,
  id: string,
  patch: Record<string, unknown>,
) {
  const emp = await tx.glEmployee.findUnique({ where: { id } });
  if (!emp) throw new PayrollError('کارمند یافت نشد');

  const data: Record<string, unknown> = {};
  for (const k of EMP_EDITABLE) if (k in patch) data[k] = patch[k];
  if ('nationalId' in data) data.nationalId = cleanNationalId(data.nationalId);

  if ('baseSalary' in data && typeof data.baseSalary === 'bigint' && data.baseSalary <= 0n) {
    throw new PayrollError('حقوق پایه باید بزرگ‌تر از صفر باشد');
  }
  if ('name' in data && !String(data.name).trim()) {
    throw new PayrollError('نام کارمند نمی‌تواند خالی باشد');
  }

  const updated = await tx.glEmployee.update({ where: { id }, data });

  // نامِ تفصیلی، ارجاع است نه کپی — با نام کارمند هم‌گام می‌ماند
  if (typeof data.name === 'string' && data.name.trim() !== emp.name) {
    await tx.glSubsidiary.update({ where: { id: emp.subsidiaryId }, data: { name: data.name.trim() } });
  }
  return updated;
}

// ───────────────────────────────────────────────────────────────
// اصلاح لیست نهایی‌شده — سند قبلی برگشت می‌خورد، اصلاحیهٔ پیش‌نویس ساخته می‌شود
// ───────────────────────────────────────────────────────────────

/**
 * تنها راه تغییر لیست نهایی‌شده (الزام بند ۳-۶).
 *
 * دو کار در یک تراکنش: (۱) سند لیست قبلی با سند برگشتی خنثی می‌شود،
 * (۲) لیست اصلاحیِ **پیش‌نویس** ساخته می‌شود. نهایی‌کردن اصلاحیه گام جداست
 * (`finalizeRun`) تا کاربر ردیف‌های بازمحاسبه‌شده را ببیند.
 */
export async function reviseRun(
  tx: Prisma.TransactionClient,
  input: { runId: string; rows: PayrollInputRow[]; note?: string; reason?: string; createdById?: string | null },
) {
  const run = await tx.glPayrollRun.findUnique({ where: { id: input.runId } });
  if (!run) throw new PayrollError('لیست حقوق یافت نشد');
  if (run.status !== 'FINAL') throw new PayrollError('فقط لیست نهایی‌شده اصلاحیه می‌گیرد');

  if (run.entryId) {
    await reverse(tx, run.entryId, {
      reason: input.reason?.trim() || `اصلاح لیست حقوق ${run.year}/${String(run.month).padStart(2, '0')}`,
      createdById: input.createdById ?? null,
    });
  }

  return amendRun(tx, { runId: input.runId, rows: input.rows, note: input.note });
}

// ───────────────────────────────────────────────────────────────
// نمای نرخ‌های قانونی — بدون پرتاب خطا (برخلاف resolveRates)
// ───────────────────────────────────────────────────────────────

/**
 * وضعیت نرخ‌ها در یک تاریخ برای صفحهٔ مدیریت: کدام تعریف شده، کدام غایب،
 * تاریخچهٔ نسخه‌ها، و پلکان مالیات معتبر.
 *
 * `resolveRates` سرِ اولین نرخِ غایب خطا می‌دهد؛ اینجا همه را برمی‌گردانیم تا
 * کاربر ببیند دقیقاً چه چیزی مانده.
 */
export async function ratesSnapshot(tx: Prisma.TransactionClient, at: Date) {
  const rows = await tx.glPayrollRate.findMany({
    orderBy: [{ key: 'asc' }, { validFrom: 'desc' }],
  });

  const active: Record<string, { id: string; value: string; validFrom: Date; validTo: Date | null; note: string | null }> = {};
  for (const r of rows) {
    const inRange = r.validFrom <= at && (r.validTo == null || r.validTo >= at);
    if (inRange && !(r.key in active)) {
      active[r.key] = { id: r.id, value: r.value.toString(), validFrom: r.validFrom, validTo: r.validTo, note: r.note };
    }
  }
  const missing = Object.values(RATE_KEYS).filter((k) => !(k in active));

  const bracketRows = await tx.glPayrollTaxBracket.findMany({
    orderBy: [{ validFrom: 'desc' }, { fromAmount: 'asc' }],
  });
  const activeBrackets = bracketRows.filter(
    (b) => b.validFrom <= at && (b.validTo == null || b.validTo >= at),
  );

  return {
    at,
    keys: Object.values(RATE_KEYS),
    /** کلیدهای اختیاری با پیش‌فرضِ قانونی — نبودشان مانعِ `ready` نیست */
    optionalKeys: Object.values(OPTIONAL_RATE_KEYS).map((k) => ({
      key: k, default: OPTIONAL_RATE_DEFAULTS[k], value: active[k]?.value ?? null,
    })),
    active,
    missing,
    ready: missing.length === 0 && activeBrackets.length > 0,
    history: rows.map((r) => ({
      id: r.id, key: r.key, value: r.value.toString(),
      validFrom: r.validFrom, validTo: r.validTo, note: r.note,
    })),
    brackets: activeBrackets.map((b) => ({
      id: b.id, from: b.fromAmount.toString(), to: b.toAmount?.toString() ?? null,
      rate: b.rate.toString(), validFrom: b.validFrom, validTo: b.validTo,
    })),
    bracketHistory: bracketRows.map((b) => ({
      id: b.id, from: b.fromAmount.toString(), to: b.toAmount?.toString() ?? null,
      rate: b.rate.toString(), validFrom: b.validFrom, validTo: b.validTo,
    })),
  };
}
