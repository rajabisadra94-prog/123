/**
 * فاز ۸ — حقوق و دستمزد.
 *
 * سه چیزی که این تست‌ها بیش از همه می‌سنجند:
 *   • **نرخ‌های نسخه‌دار**: بازمحاسبهٔ یک ماه قدیمی باید همان نتیجهٔ قبلی را بدهد
 *   • **تفکیک معماری**: موتور محاسبه تابع خالص است و هیچ از سند نمی‌داند
 *   • **ذخیره‌گیری ماهانه**: عیدی و سنوات و مرخصی هر ماه شناسایی می‌شوند
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, resetBusinessData, seedGlChart, makeFiscalYear, accountByCode,
  D, expectRejects,
} from '../helpers/gl';
import { createStandalone } from '../../src/modules/ledger/subsidiary';
import { ensureDefaultCostCenters } from '../../src/modules/ledger/costcenter';
import { setRate, setTaxBrackets, resolveRates, RATE_KEYS } from '../../src/modules/ledger/payroll/rates';
import { computePayrollItem, progressiveTax, summarize } from '../../src/modules/ledger/payroll/engine';
import { buildRun, finalizeRun, amendRun, periodDate, PAYROLL_CODES } from '../../src/modules/ledger/payroll/run';
import { reverse } from '../../src/modules/ledger/poster';

let fy: { id: string };
let costCenter: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
let seq = 0;
const nextId = () => String(++seq).padStart(3, '0');

/** نرخ‌های ۱۴۰۵ — اعداد نمونه، نه واقعیِ قانونی */
const RATES_1405 = {
  [RATE_KEYS.MIN_WAGE_DAILY]: 2_000_000,
  [RATE_KEYS.HOUSING_MONTHLY]: 9_000_000,
  [RATE_KEYS.FOOD_MONTHLY]: 14_000_000,
  [RATE_KEYS.CHILD_PER_CHILD]: 6_000_000,
  [RATE_KEYS.SENIORITY_DAILY]: 70_000,
  [RATE_KEYS.INSURANCE_EMPLOYEE]: 0.07,
  [RATE_KEYS.INSURANCE_EMPLOYER]: 0.20,
  [RATE_KEYS.UNEMPLOYMENT]: 0.03,
  [RATE_KEYS.INSURANCE_CEILING]: 0,
  [RATE_KEYS.OVERTIME_FACTOR]: 1.4,
  [RATE_KEYS.NIGHT_FACTOR]: 0.35,
  [RATE_KEYS.HOLIDAY_FACTOR]: 1.4,
  [RATE_KEYS.TAX_EXEMPTION_MONTHLY]: 100_000_000,
  [RATE_KEYS.BONUS_ACCRUAL_FACTOR]: 2 / 12,
  [RATE_KEYS.SEVERANCE_DAYS_PER_MONTH]: 2.5,
  [RATE_KEYS.LEAVE_DAYS_PER_MONTH]: 2.5,
  [RATE_KEYS.MONTH_DAYS]: 30,
  [RATE_KEYS.MONTH_HOURS]: 220,
};

async function seedRates(validFrom: Date, overrides: Record<string, number> = {}) {
  const values = { ...RATES_1405, ...overrides };
  await tx(async (t) => {
    for (const [key, value] of Object.entries(values)) {
      await setRate(t, { key: key as any, value, validFrom });
    }
    await setTaxBrackets(t, validFrom, [
      { from: 0n, to: 500_000_000n, rate: 0.10 },
      { from: 500_000_000n, to: 1_000_000_000n, rate: 0.15 },
      { from: 1_000_000_000n, to: null, rate: 0.20 },
    ]);
  });
}

async function makeEmployee(over: Partial<any> = {}) {
  const id = nextId();
  const sub = await tx((t) => createStandalone(t, 'EMPLOYEE', over.name ?? `کارمند ${id}`));
  return gl.glEmployee.create({
    data: {
      code: `EMP-${id}`, subsidiaryId: sub.id, name: over.name ?? `کارمند ${id}`,
      hireDate: over.hireDate ?? D('2023-03-21'),
      baseSalary: over.baseSalary ?? 100_000_000n,
      childrenCount: over.childrenCount ?? 0,
      // `??` اینجا کار نمی‌کند: null هم پیش‌فرض را برمی‌گرداند و تستِ
      // «کارمند بدون مرکز هزینه» را بی‌اثر می‌کند.
      costCenterId: 'costCenterId' in over ? over.costCenterId : costCenter.id,
    },
  });
}

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl();
  await resetBusinessData();
  await gl.glPayrollRate.deleteMany({});
  await gl.glPayrollTaxBracket.deleteMany({});
  fy = await makeFiscalYear();
  await tx((t) => ensureDefaultCostCenters(t));
  costCenter = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '3' } });
  await seedRates(D('2026-03-21'));
});

const row = (employeeId: string, over: Partial<any> = {}) => ({
  employeeId, workedDays: 30, overtimeHours: 0, nightHours: 0, holidayHours: 0, ...over,
});

// ═══════════════════════════════════════════════════════════════
describe('نرخ‌های نسخه‌دار', () => {
  it('نرخ معتبر همان تاریخ خوانده می‌شود، نه نرخ جاری', async () => {
    // نرخ جدید از نیمهٔ سال
    await seedRates(D('2026-09-22'), { [RATE_KEYS.HOUSING_MONTHLY]: 15_000_000 });

    const early = await resolveRates(gl, D('2026-05-01'));
    const late = await resolveRates(gl, D('2026-10-01'));

    expect(early.values[RATE_KEYS.HOUSING_MONTHLY]).toBe(9_000_000);
    expect(late.values[RATE_KEYS.HOUSING_MONTHLY]).toBe(15_000_000);
  });

  it('نرخ تعریف‌نشده خطا می‌دهد — پیش‌فرض گذاشته نمی‌شود', async () => {
    await gl.glPayrollRate.deleteMany({ where: { key: RATE_KEYS.HOUSING_MONTHLY } });
    await expectRejects(() => resolveRates(gl, D('2026-05-01')), /تعریف نشده/);
  });

  it('نبودِ پلکان مالیات خطا می‌دهد', async () => {
    await gl.glPayrollTaxBracket.deleteMany({});
    await expectRejects(() => resolveRates(gl, D('2026-05-01')), /پلکان مالیات/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('موتور محاسبه — تابع خالص', () => {
  it('مالیات پلکانی فقط روی بخشِ داخل هر پله اعمال می‌شود', async () => {
    const rates = await resolveRates(gl, D('2026-05-01'));
    // ۷۰۰ میلیون: ۵۰۰ اول با ۱۰٪ و ۲۰۰ بعدی با ۱۵٪
    expect(progressiveTax(700_000_000n, rates.brackets)).toBe(50_000_000n + 30_000_000n);
    expect(progressiveTax(0n, rates.brackets)).toBe(0n);
    expect(progressiveTax(-5n, rates.brackets)).toBe(0n);
  });

  it('حق اولاد از بیمه و مالیات معاف است', async () => {
    const rates = await resolveRates(gl, D('2026-05-01'));
    const withKids = computePayrollItem(
      { employeeId: 'x', baseSalary: 100_000_000n, childrenCount: 2, seniorityYears: 0,
        workedDays: 30, overtimeHours: 0, nightHours: 0, holidayHours: 0 }, rates);
    const without = computePayrollItem(
      { employeeId: 'x', baseSalary: 100_000_000n, childrenCount: 0, seniorityYears: 0,
        workedDays: 30, overtimeHours: 0, nightHours: 0, holidayHours: 0 }, rates);

    expect(withKids.childAllowance).toBe(12_000_000n);
    expect(withKids.grossPay).toBe(without.grossPay + 12_000_000n);
    // ولی مبنای بیمه و مالیات تکان نمی‌خورد
    expect(withKids.insuranceBase).toBe(without.insuranceBase);
    expect(withKids.taxableBase).toBe(without.taxableBase);
  });

  it('کارکرد ناقص، مزایای ثابت را به نسبت کم می‌کند', async () => {
    const rates = await resolveRates(gl, D('2026-05-01'));
    const full = computePayrollItem(
      { employeeId: 'x', baseSalary: 100_000_000n, childrenCount: 0, seniorityYears: 0,
        workedDays: 30, overtimeHours: 0, nightHours: 0, holidayHours: 0 }, rates);
    const half = computePayrollItem(
      { employeeId: 'x', baseSalary: 100_000_000n, childrenCount: 0, seniorityYears: 0,
        workedDays: 15, overtimeHours: 0, nightHours: 0, holidayHours: 0 }, rates);

    expect(half.baseSalary).toBe(full.baseSalary / 2n);
    expect(half.housingAllowance).toBe(full.housingAllowance / 2n);
  });

  it('سقف بیمه رعایت می‌شود', async () => {
    await seedRates(D('2026-09-22'), { [RATE_KEYS.INSURANCE_CEILING]: 50_000_000 });
    const rates = await resolveRates(gl, D('2026-10-01'));
    const r = computePayrollItem(
      { employeeId: 'x', baseSalary: 500_000_000n, childrenCount: 0, seniorityYears: 0,
        workedDays: 30, overtimeHours: 0, nightHours: 0, holidayHours: 0 }, rates);

    expect(r.insuranceBase).toBe(50_000_000n);
    expect(r.insuranceEmployee).toBe(3_500_000n);   // ۷٪ از سقف
  });

  it('خالص = ناخالص منهای کسورات', async () => {
    const rates = await resolveRates(gl, D('2026-05-01'));
    const r = computePayrollItem(
      { employeeId: 'x', baseSalary: 100_000_000n, childrenCount: 1, seniorityYears: 2,
        workedDays: 30, overtimeHours: 20, nightHours: 10, holidayHours: 8,
        loanDeduction: 5_000_000n }, rates);

    expect(r.netPay).toBe(
      r.grossPay - r.insuranceEmployee - r.incomeTax - r.loanDeduction,
    );
  });

  it('ذخیره‌ها ماهانه شناسایی می‌شوند، نه یک‌جا در پایان سال', async () => {
    const rates = await resolveRates(gl, D('2026-05-01'));
    const r = computePayrollItem(
      { employeeId: 'x', baseSalary: 120_000_000n, childrenCount: 0, seniorityYears: 0,
        workedDays: 30, overtimeHours: 0, nightHours: 0, holidayHours: 0 }, rates);

    expect(r.accrualBonus).toBeGreaterThan(0n);       // عیدی
    expect(r.accrualSeverance).toBeGreaterThan(0n);   // سنوات
    expect(r.accrualLeave).toBeGreaterThan(0n);       // مرخصی
    // سنوات: ۲٫۵ روز از دستمزد روزانه (۱۲۰م / ۳۰ = ۴م) ⇒ ۱۰م
    expect(r.accrualSeverance).toBe(10_000_000n);
  });

  it('همان ورودی، همیشه همان خروجی', async () => {
    const rates = await resolveRates(gl, D('2026-05-01'));
    const input = {
      employeeId: 'x', baseSalary: 137_500_000n, childrenCount: 3, seniorityYears: 4,
      workedDays: 27, overtimeHours: 13.5, nightHours: 6.25, holidayHours: 3,
    };
    const a = computePayrollItem(input, rates);
    const b = computePayrollItem(input, rates);
    expect(a).toEqual(b);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('لیست حقوق و سند', () => {
  it('لیست ساخته می‌شود و جمع‌ها با ردیف‌ها می‌خوانند', async () => {
    const e1 = await makeEmployee();
    const e2 = await makeEmployee({ baseSalary: 150_000_000n, childrenCount: 2 });

    const res: any = await tx((t) => buildRun(t, {
      year: 1405, month: 3, rows: [row(e1.id), row(e2.id, { overtimeHours: 10 })],
    }));

    expect(res.run.status).toBe('DRAFT');
    expect(res.results).toHaveLength(2);
    expect(res.totals.grossPay).toBe(res.results[0].grossPay + res.results[1].grossPay);
  });

  it('لیست تکراری برای همان دوره رد می‌شود', async () => {
    const e = await makeEmployee();
    await tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e.id)] }));
    await expectRejects(
      () => tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e.id)] })),
      /از قبل وجود دارد/,
    );
  });

  it('نهایی‌کردن، سند تراز می‌سازد', async () => {
    const e1 = await makeEmployee();
    const e2 = await makeEmployee({ baseSalary: 150_000_000n });
    const built: any = await tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e1.id), row(e2.id)] }));

    const res: any = await tx((t) => finalizeRun(t, {
      runId: built.run.id, fiscalYearId: fy.id, date: D('2026-06-20'),
    }));

    expect(res.run.status).toBe('FINAL');
    const lines = await gl.glLine.findMany({ where: { entryId: res.entry.id } });
    const dr = lines.reduce((s, l) => s + l.debitBase, 0n);
    const cr = lines.reduce((s, l) => s + l.creditBase, 0n);
    expect(dr).toBe(cr);
  });

  it('خالص هر کارمند روی تفصیلی خودش می‌نشیند', async () => {
    const e = await makeEmployee();
    const built: any = await tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e.id)] }));
    const res: any = await tx((t) => finalizeRun(t, { runId: built.run.id, fiscalYearId: fy.id, date: D('2026-06-20') }));

    const payable = await accountByCode(PAYROLL_CODES.salaryPayable);
    const line = await gl.glLine.findFirstOrThrow({
      where: { entryId: res.entry.id, accountId: payable.id },
      include: { subsidiary: true },
    });
    expect(line.subsidiary!.kind).toBe('EMPLOYEE');
    expect(line.credit).toBe(built.results[0].netPay);
  });

  it('هزینهٔ حقوق مرکز هزینه می‌گیرد', async () => {
    const e = await makeEmployee();
    const built: any = await tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e.id)] }));
    const res: any = await tx((t) => finalizeRun(t, { runId: built.run.id, fiscalYearId: fy.id, date: D('2026-06-20') }));

    const salaryAcc = await accountByCode(PAYROLL_CODES.salaryExpense);
    const line = await gl.glLine.findFirstOrThrow({
      where: { entryId: res.entry.id, accountId: salaryAcc.id },
      include: { costCenter: true },
    });
    expect(line.costCenter!.code).toBe('3');
  });

  /**
   * ⚠️ این تست عوض شد: پیش از این، ردشدن در **نهایی‌سازی** اتفاق می‌افتاد و
   * پیامش از تریگرِ دفتر می‌آمد — «حساب ۶۱۰۱ مرکز هزینهٔ اجباری دارد». درست
   * بود ولی بی‌فایده: حسابدارِ با پنج نفر در لیست نمی‌فهمید کدام‌شان مشکل
   * دارد، و آن هم بعد از پر کردنِ روزهای کارکردِ همه.
   *
   * حالا پیش‌نویس اصلاً ساخته نمی‌شود و نامِ کارمند در پیام است.
   */
  it('کارمندِ بدون مرکز هزینه، همان اول با نامِ خودش رد می‌شود', async () => {
    const e = await makeEmployee({ costCenterId: null });
    const err = await expectRejects(
      () => tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e.id)] })),
      /مرکز هزینه ندارند/,
    );
    expect(String(err.message)).toContain(e.name);
    expect(String(err.message)).toContain(e.code);
    // و لیستِ نیم‌ساخته‌ای هم جا نمی‌ماند
    expect(await gl.glPayrollRun.count({ where: { year: 1405, month: 3 } })).toBe(0);
  });

  it('کارمندِ بی‌مرکز، بقیهٔ لیست را هم متوقف می‌کند — نه اینکه بی‌صدا کنار برود', async () => {
    const good = await makeEmployee();
    const bad = await makeEmployee({ costCenterId: null });
    await expectRejects(
      () => tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(good.id), row(bad.id)] })),
      /مرکز هزینه ندارند/,
    );
    expect(await gl.glPayrollRun.count({ where: { year: 1405, month: 3 } })).toBe(0);
  });

  it('بیمه و مالیات به حساب‌های بدهی خودشان می‌روند', async () => {
    const e = await makeEmployee();
    const built: any = await tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e.id)] }));
    const res: any = await tx((t) => finalizeRun(t, { runId: built.run.id, fiscalYearId: fy.id, date: D('2026-06-20') }));

    const lines = await gl.glLine.findMany({
      where: { entryId: res.entry.id }, include: { account: { select: { code: true } } },
    });
    const byCode = (c: string) => lines.filter((l) => l.account.code === c);

    const r = built.results[0];
    expect(byCode(PAYROLL_CODES.insurancePayable)[0].credit)
      .toBe(r.insuranceEmployee + r.insuranceEmployer + r.unemploymentDue);
    expect(byCode(PAYROLL_CODES.taxPayable)[0].credit).toBe(r.incomeTax);
  });

  it('ذخیره‌ها هم هزینه و هم بدهی می‌سازند', async () => {
    const e = await makeEmployee();
    const built: any = await tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e.id)] }));
    const res: any = await tx((t) => finalizeRun(t, { runId: built.run.id, fiscalYearId: fy.id, date: D('2026-06-20') }));

    const lines = await gl.glLine.findMany({
      where: { entryId: res.entry.id }, include: { account: { select: { code: true } } },
    });
    const r = built.results[0];
    const find = (c: string) => lines.find((l) => l.account.code === c)!;

    expect(find(PAYROLL_CODES.severanceExpense).debit).toBe(r.accrualSeverance);
    expect(find(PAYROLL_CODES.severanceProvision).credit).toBe(r.accrualSeverance);
  });

  it('لیست پیش‌نویس دوباره نهایی نمی‌شود', async () => {
    const e = await makeEmployee();
    const built: any = await tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e.id)] }));
    await tx((t) => finalizeRun(t, { runId: built.run.id, fiscalYearId: fy.id, date: D('2026-06-20') }));
    await expectRejects(
      () => tx((t) => finalizeRun(t, { runId: built.run.id, fiscalYearId: fy.id, date: D('2026-06-20') })),
      /پیش‌نویس/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
describe('اصلاح لیست', () => {
  it('لیست نهایی‌شده مستقیم عوض نمی‌شود؛ اصلاحیه می‌گیرد', async () => {
    const e = await makeEmployee();
    const built: any = await tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e.id)] }));
    const fin: any = await tx((t) => finalizeRun(t, { runId: built.run.id, fiscalYearId: fy.id, date: D('2026-06-20') }));

    // سند لیست اول با سند برگشتی خنثی می‌شود
    await tx((t) => reverse(t, fin.entry.id, { reason: 'اصلاح لیست حقوق' }));

    const amended: any = await tx((t) => amendRun(t, {
      runId: built.run.id, rows: [row(e.id, { workedDays: 25 })],
    }));

    expect(amended.run.amendsId).toBe(built.run.id);
    const original = await gl.glPayrollRun.findUniqueOrThrow({ where: { id: built.run.id } });
    expect(original.status).toBe('AMENDED');

    // لیست اصلاحی با کارکرد کمتر، ناخالص کمتری دارد
    expect(amended.totals.grossPay).toBeLessThan(built.totals.grossPay);
  });

  it('اصلاحیه با نرخ همان دوره حساب می‌شود، نه نرخ امروز', async () => {
    const e = await makeEmployee();
    const built: any = await tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e.id)] }));
    const fin: any = await tx((t) => finalizeRun(t, { runId: built.run.id, fiscalYearId: fy.id, date: D('2026-06-20') }));

    // نرخ‌ها بعداً عوض می‌شوند
    await seedRates(D('2026-09-22'), { [RATE_KEYS.HOUSING_MONTHLY]: 30_000_000 });

    await tx((t) => reverse(t, fin.entry.id, { reason: 'اصلاح' }));
    const amended: any = await tx((t) => amendRun(t, { runId: built.run.id, rows: [row(e.id)] }));

    // با همان ورودی و نرخ دورهٔ خرداد ⇒ همان نتیجهٔ قبلی
    expect(amended.results[0].grossPay).toBe(built.results[0].grossPay);
    expect(amended.results[0].housingAllowance).toBe(9_000_000n);
  });

  it('لیست پیش‌نویس اصلاحیه نمی‌گیرد', async () => {
    const e = await makeEmployee();
    const built: any = await tx((t) => buildRun(t, { year: 1405, month: 3, rows: [row(e.id)] }));
    await expectRejects(
      () => tx((t) => amendRun(t, { runId: built.run.id, rows: [row(e.id)] })),
      /نهایی‌شده/,
    );
  });
});

describe('تاریخ دوره', () => {
  it('ماه شمسی به تاریخ میلادیِ داخل همان ماه نگاشت می‌شود', () => {
    const farvardin = periodDate(1405, 1);
    const esfand = periodDate(1405, 12);
    expect(farvardin.getUTCFullYear()).toBe(2026);
    expect(esfand.getTime()).toBeGreaterThan(farvardin.getTime());
  });
});
