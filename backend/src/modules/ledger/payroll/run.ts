/**
 * چرخهٔ لیست حقوق و آداپتور سند.
 *
 * **مرز معماری:** `engine.ts` هیچ نمی‌داند سند چیست. این فایل تنها جایی است که
 * لیست حقوق به سند تبدیل می‌شود. تغییر قانون در موتور می‌ماند و به دفترداری
 * دست نمی‌زند؛ تغییر چارت اینجا می‌ماند و به محاسبه دست نمی‌زند.
 */
import { Prisma, GlPayrollStatus } from '@prisma/client';
import { post, DraftLine } from '../poster';
import { Minor, rateFrom } from '../money';
import { resolveRates } from './rates';
import { computePayrollItem, summarize, EmployeeInput, PayrollItemResult } from './engine';

export const PAYROLL_CODES = {
  salaryExpense: '6101',      // هزینهٔ حقوق و دستمزد
  employerInsurance: '6102',  // بیمهٔ سهم کارفرما
  bonusExpense: '6103',       // عیدی
  severanceExpense: '6104',   // سنوات
  leaveExpense: '6105',       // مرخصی استفاده‌نشده

  salaryPayable: '2104',      // حقوق پرداختنی
  insurancePayable: '2105',   // بیمهٔ پرداختنی
  taxPayable: '2106',         // مالیات حقوق پرداختنی
  bonusProvision: '2108',     // ذخیرهٔ عیدی
  severanceProvision: '2109', // ذخیرهٔ سنوات
  leaveProvision: '2110',     // ذخیرهٔ مرخصی

  employeeLoan: '1107',       // وام و مساعدهٔ کارکنان
} as const;

export class PayrollError extends Error {}

const accountByCode = (tx: Prisma.TransactionClient, code: string) =>
  tx.glAccount.findUniqueOrThrow({ where: { code } });

/** میانهٔ ماه شمسی به میلادی — مبنای انتخاب نرخ معتبر آن دوره */
export function periodDate(year: number, month: number): Date {
  // تقویم شمسی: ۱ فروردین ≈ ۲۱ مارس. برای انتخاب نرخ، دقتِ ماه کافی است.
  const gYear = year + 621;
  const monthStart = new Date(Date.UTC(gYear, 2, 21));
  monthStart.setUTCDate(monthStart.getUTCDate() + (month - 1) * 30 + 15);
  return monthStart;
}

export interface PayrollInputRow extends Omit<EmployeeInput, 'employeeId' | 'baseSalary' | 'childrenCount' | 'seniorityYears'> {
  employeeId: string;
}

/**
 * ساخت لیست حقوق یک دوره.
 *
 * نرخ‌ها با **تاریخ همان دوره** حل می‌شوند، نه امروز — پس بازمحاسبهٔ یک ماه
 * قدیمی همان نتیجهٔ قبلی را می‌دهد.
 */
export async function buildRun(
  tx: Prisma.TransactionClient,
  input: { year: number; month: number; rows: PayrollInputRow[]; note?: string },
) {
  const existing = await tx.glPayrollRun.findFirst({
    where: { year: input.year, month: input.month, amendsId: null },
  });
  if (existing) {
    throw new PayrollError(`لیست حقوق ${input.year}/${input.month} از قبل وجود دارد`);
  }

  const at = periodDate(input.year, input.month);
  const rates = await resolveRates(tx, at);

  /*
    مرکز هزینه را **همین‌جا** می‌سنجیم، نه در لحظهٔ نهایی‌سازی.

    ⚠️ چرا: حساب «۶۱۰۱ حقوق و دستمزد» مرکز هزینهٔ اجباری دارد، پس کارمندِ
    بی‌مرکز، سند حقوق را می‌شکند. ولی خطا از تریگرِ دفتر می‌آمد و می‌گفت
    «حساب ۶۱۰۱ مرکز هزینهٔ اجباری دارد» — بی‌آنکه بگوید کدام کارمند. حسابدار
    با پنج نفر در لیست، پیامی می‌دید که هیچ کاری با آن نمی‌شد کرد، و آن هم
    در آخرین قدم، بعد از پر کردنِ روزهای کارکردِ همه.

    حالا پیش از ساختنِ پیش‌نویس، نام‌ها را می‌گوییم.
  */
  const missingCc: string[] = [];
  for (const row of input.rows) {
    const e = await tx.glEmployee.findUnique({
      where: { id: row.employeeId },
      select: { name: true, code: true, costCenterId: true },
    });
    if (e && !e.costCenterId) missingCc.push(`${e.code} ${e.name}`);
  }
  if (missingCc.length) {
    throw new PayrollError(
      `این ${missingCc.length} کارمند مرکز هزینه ندارند و هزینهٔ حقوقشان قابل ثبت نیست: ` +
      `${missingCc.join('، ')}. مرکز هزینهٔ هرکدام را در «کارکنان» تعیین کنید.`,
    );
  }

  const run = await tx.glPayrollRun.create({
    data: { year: input.year, month: input.month, status: 'DRAFT', note: input.note ?? null },
  });

  const results: PayrollItemResult[] = [];
  for (const row of input.rows) {
    const emp = await tx.glEmployee.findUnique({ where: { id: row.employeeId } });
    if (!emp) throw new PayrollError(`کارمند ${row.employeeId} یافت نشد`);
    if (!emp.isActive) throw new PayrollError(`کارمند ${emp.name} غیرفعال است`);

    const seniorityYears = Math.max(
      0,
      Math.floor((at.getTime() - emp.hireDate.getTime()) / (365.25 * 86_400_000)),
    );

    const result = computePayrollItem(
      {
        employeeId: emp.id,
        baseSalary: emp.baseSalary,
        childrenCount: emp.childrenCount,
        seniorityYears,
        workedDays: row.workedDays,
        overtimeHours: row.overtimeHours,
        nightHours: row.nightHours,
        holidayHours: row.holidayHours,
        loanDeduction: row.loanDeduction,
        advanceDeduction: row.advanceDeduction,
        otherDeduction: row.otherDeduction,
      },
      rates,
    );
    results.push(result);

    await tx.glPayrollItem.create({
      data: {
        runId: run.id, employeeId: emp.id,
        workedDays: row.workedDays,
        overtimeHours: new Prisma.Decimal(row.overtimeHours),
        nightHours: new Prisma.Decimal(row.nightHours),
        holidayHours: new Prisma.Decimal(row.holidayHours),
        baseSalary: result.baseSalary,
        seniorityPay: result.seniorityPay,
        housingAllowance: result.housingAllowance,
        foodAllowance: result.foodAllowance,
        childAllowance: result.childAllowance,
        overtimePay: result.overtimePay,
        nightPay: result.nightPay,
        holidayPay: result.holidayPay,
        grossPay: result.grossPay,
        insuranceEmployee: result.insuranceEmployee,
        incomeTax: result.incomeTax,
        loanDeduction: result.loanDeduction,
        advanceDeduction: result.advanceDeduction,
        otherDeduction: result.otherDeduction,
        netPay: result.netPay,
        insuranceEmployer: result.insuranceEmployer,
        unemploymentDue: result.unemploymentDue,
        accrualBonus: result.accrualBonus,
        accrualSeverance: result.accrualSeverance,
        accrualLeave: result.accrualLeave,
      },
    });
  }

  return { run, results, totals: summarize(results) };
}

/**
 * نهایی‌کردن لیست و ساخت سند.
 *
 * سند از **ردیف‌های ذخیره‌شده** ساخته می‌شود، نه از محاسبهٔ دوباره — تا سندی که
 * ثبت می‌شود دقیقاً همان چیزی باشد که تأیید شده.
 *
 * ساختار سند:
 *   بدهکار  هزینهٔ حقوق (ناخالص)           ← به تفکیک مرکز هزینه
 *   بدهکار  بیمهٔ سهم کارفرما + بیکاری
 *   بدهکار  عیدی، سنوات، مرخصی (ذخیره)
 *   بستانکار بیمهٔ پرداختنی (سهم کارگر + کارفرما + بیکاری)
 *   بستانکار مالیات پرداختنی
 *   بستانکار وام و مساعده (بازپرداخت)
 *   بستانکار ذخیرهٔ عیدی / سنوات / مرخصی
 *   بستانکار حقوق پرداختنی (خالص)          ← به تفکیک کارمند
 */
export async function finalizeRun(
  tx: Prisma.TransactionClient,
  input: { runId: string; fiscalYearId: string; date: Date; createdById?: string | null },
) {
  const run = await tx.glPayrollRun.findUnique({
    where: { id: input.runId },
    include: { items: { include: { employee: true } } },
  });
  if (!run) throw new PayrollError('لیست حقوق یافت نشد');
  if (run.status !== 'DRAFT') throw new PayrollError('فقط لیست پیش‌نویس نهایی می‌شود');
  if (!run.items.length) throw new PayrollError('لیست حقوق خالی است');

  const rate = rateFrom(1); // حقوق همیشه به ارز پایه
  const base = (await tx.glCurrency.findFirstOrThrow({ where: { isBase: true } })).code;
  const acc = async (code: string) => (await accountByCode(tx, code)).id;

  const lines: DraftLine[] = [];
  const push = (accountId: string, side: 'debit' | 'credit', amount: Minor, memo: string, extra: Partial<DraftLine> = {}) => {
    if (amount <= 0n) return;
    lines.push({ accountId, currencyCode: base, [side]: amount, rate, memo, ...extra } as DraftLine);
  };

  // ── هزینهٔ حقوق، به تفکیک مرکز هزینه ──
  // حساب ۶۱۰۱ مرکز هزینهٔ اجباری دارد؛ اگر کارمند مرکز نداشته باشد سند رد می‌شود
  // و همین درست است: هزینهٔ حقوق بدون واحد، گزارش سود و زیان را بی‌معنا می‌کند.
  const salaryAcc = await acc(PAYROLL_CODES.salaryExpense);
  for (const item of run.items) {
    push(salaryAcc, 'debit', item.grossPay, `حقوق ${item.employee.name}`, {
      costCenterId: item.employee.costCenterId,
    });
  }

  const totals = run.items.reduce(
    (s, i) => ({
      insuranceEmployee: s.insuranceEmployee + i.insuranceEmployee,
      insuranceEmployer: s.insuranceEmployer + i.insuranceEmployer,
      unemployment: s.unemployment + i.unemploymentDue,
      tax: s.tax + i.incomeTax,
      loan: s.loan + i.loanDeduction + i.advanceDeduction,
      other: s.other + i.otherDeduction,
      bonus: s.bonus + i.accrualBonus,
      severance: s.severance + i.accrualSeverance,
      leave: s.leave + i.accrualLeave,
    }),
    { insuranceEmployee: 0n, insuranceEmployer: 0n, unemployment: 0n, tax: 0n, loan: 0n, other: 0n, bonus: 0n, severance: 0n, leave: 0n },
  );

  // ── سهم کارفرما: هزینهٔ شرکت است، نه کسر از کارمند ──
  const employerAcc = await acc(PAYROLL_CODES.employerInsurance);
  for (const item of run.items) {
    push(employerAcc, 'debit', item.insuranceEmployer + item.unemploymentDue,
      `بیمهٔ سهم کارفرما — ${item.employee.name}`, { costCenterId: item.employee.costCenterId });
  }

  // ── ذخیره‌های ماهانه ──
  for (const [expCode, provCode, key, label] of [
    [PAYROLL_CODES.bonusExpense, PAYROLL_CODES.bonusProvision, 'accrualBonus', 'عیدی'],
    [PAYROLL_CODES.severanceExpense, PAYROLL_CODES.severanceProvision, 'accrualSeverance', 'سنوات'],
    [PAYROLL_CODES.leaveExpense, PAYROLL_CODES.leaveProvision, 'accrualLeave', 'مرخصی'],
  ] as const) {
    const expAcc = await acc(expCode);
    for (const item of run.items) {
      push(expAcc, 'debit', item[key], `ذخیرهٔ ${label} — ${item.employee.name}`,
        { costCenterId: item.employee.costCenterId });
    }
  }

  // ── بدهی‌ها ──
  push(await acc(PAYROLL_CODES.insurancePayable), 'credit',
    totals.insuranceEmployee + totals.insuranceEmployer + totals.unemployment,
    'بیمهٔ پرداختنی (سهم کارگر و کارفرما و بیکاری)');
  push(await acc(PAYROLL_CODES.taxPayable), 'credit', totals.tax, 'مالیات حقوق پرداختنی');

  const loanAcc = await acc(PAYROLL_CODES.employeeLoan);
  for (const item of run.items) {
    push(loanAcc, 'credit', item.loanDeduction + item.advanceDeduction,
      `بازپرداخت وام/مساعده — ${item.employee.name}`, { subsidiaryId: item.employee.subsidiaryId });
  }

  const bonusProv = await acc(PAYROLL_CODES.bonusProvision);
  const sevProv = await acc(PAYROLL_CODES.severanceProvision);
  const leaveProv = await acc(PAYROLL_CODES.leaveProvision);
  push(bonusProv, 'credit', totals.bonus, 'ذخیرهٔ عیدی');
  push(sevProv, 'credit', totals.severance, 'ذخیرهٔ سنوات');
  push(leaveProv, 'credit', totals.leave, 'ذخیرهٔ مرخصی');

  // ── خالص پرداختنی، به تفکیک کارمند (تفصیلی شناور) ──
  const payableAcc = await acc(PAYROLL_CODES.salaryPayable);
  for (const item of run.items) {
    push(payableAcc, 'credit', item.netPay, `خالص حقوق ${item.employee.name}`,
      { subsidiaryId: item.employee.subsidiaryId });
  }

  // سایر کسورات جایی جز کاهش خالص ندارند؛ اگر باشند باید حساب مقصدشان مشخص شود
  if (totals.other > 0n) {
    throw new PayrollError('کسورات «سایر» حساب مقصد ندارند — فعلاً پشتیبانی نمی‌شود');
  }

  const entry = await post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.date,
    description: `لیست حقوق ${run.year}/${String(run.month).padStart(2, '0')}`,
    entryType: 'NORMAL',
    sourceType: 'PayrollRun',
    sourceId: run.id,
    createdById: input.createdById ?? null,
    lines,
  });

  const updated = await tx.glPayrollRun.update({
    where: { id: run.id },
    data: { status: 'FINAL', entryId: entry.id, finalizedAt: new Date() },
  });

  return { run: updated, entry };
}

/**
 * لیست اصلاحی — تنها راه تغییر لیست نهایی‌شده (الزام بند ۳-۶).
 *
 * لیست قبلی دست نمی‌خورد؛ سندش با سند برگشتی خنثی می‌شود و لیست جدید
 * سند خودش را می‌زند.
 */
export async function amendRun(
  tx: Prisma.TransactionClient,
  input: { runId: string; rows: PayrollInputRow[]; note?: string },
) {
  const original = await tx.glPayrollRun.findUnique({ where: { id: input.runId } });
  if (!original) throw new PayrollError('لیست حقوق یافت نشد');
  if (original.status !== 'FINAL') throw new PayrollError('فقط لیست نهایی‌شده اصلاحیه می‌گیرد');

  const at = periodDate(original.year, original.month);
  const rates = await resolveRates(tx, at);

  const run = await tx.glPayrollRun.create({
    data: {
      year: original.year, month: original.month, status: 'DRAFT',
      amendsId: original.id, note: input.note ?? 'لیست اصلاحی',
    },
  });

  const results: PayrollItemResult[] = [];
  for (const row of input.rows) {
    const emp = await tx.glEmployee.findUniqueOrThrow({ where: { id: row.employeeId } });
    const seniorityYears = Math.max(
      0, Math.floor((at.getTime() - emp.hireDate.getTime()) / (365.25 * 86_400_000)),
    );
    const result = computePayrollItem(
      {
        employeeId: emp.id, baseSalary: emp.baseSalary, childrenCount: emp.childrenCount,
        seniorityYears, workedDays: row.workedDays, overtimeHours: row.overtimeHours,
        nightHours: row.nightHours, holidayHours: row.holidayHours,
        loanDeduction: row.loanDeduction, advanceDeduction: row.advanceDeduction,
        otherDeduction: row.otherDeduction,
      },
      rates,
    );
    results.push(result);
    await tx.glPayrollItem.create({
      data: {
        runId: run.id, employeeId: emp.id, workedDays: row.workedDays,
        overtimeHours: new Prisma.Decimal(row.overtimeHours),
        nightHours: new Prisma.Decimal(row.nightHours),
        holidayHours: new Prisma.Decimal(row.holidayHours),
        baseSalary: result.baseSalary, seniorityPay: result.seniorityPay,
        housingAllowance: result.housingAllowance, foodAllowance: result.foodAllowance,
        childAllowance: result.childAllowance, overtimePay: result.overtimePay,
        nightPay: result.nightPay, holidayPay: result.holidayPay, grossPay: result.grossPay,
        insuranceEmployee: result.insuranceEmployee, incomeTax: result.incomeTax,
        loanDeduction: result.loanDeduction, advanceDeduction: result.advanceDeduction,
        otherDeduction: result.otherDeduction, netPay: result.netPay,
        insuranceEmployer: result.insuranceEmployer, unemploymentDue: result.unemploymentDue,
        accrualBonus: result.accrualBonus, accrualSeverance: result.accrualSeverance,
        accrualLeave: result.accrualLeave,
      },
    });
  }

  await tx.glPayrollRun.update({ where: { id: original.id }, data: { status: 'AMENDED' } });
  return { run, results, totals: summarize(results) };
}
