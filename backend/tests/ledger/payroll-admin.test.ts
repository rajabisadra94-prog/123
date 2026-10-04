/**
 * فاز ۵ نقشهٔ پاریتی — کارِ اداریِ حقوق (کنارِ موتور).
 *
 * سه چیزی که این تست‌ها می‌سنجند:
 *   • کارمند = تفصیلی شناور EMPLOYEE؛ نامش با کارمند هم‌گام می‌ماند
 *   • `reviseRun` سند قبلی را برگشت می‌زند و اصلاحیهٔ پیش‌نویس می‌سازد — یک‌جا
 *   • `ratesSnapshot` سرِ نرخِ غایب خطا نمی‌دهد؛ همه را با فهرست کمبود برمی‌گرداند
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, resetBusinessData, seedGlChart, makeFiscalYear,
  D, expectRejects,
} from '../helpers/gl';
import { ensureDefaultCostCenters } from '../../src/modules/ledger/costcenter';
import { setRate, setTaxBrackets, RATE_KEYS } from '../../src/modules/ledger/payroll/rates';
import { buildRun, finalizeRun } from '../../src/modules/ledger/payroll/run';
import {
  createEmployee, updateEmployee, reviseRun, ratesSnapshot,
} from '../../src/modules/ledger/payroll/admin';

let fy: { id: string };
let costCenter: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
let seq = 0;
const nextId = () => String(++seq).padStart(3, '0');

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
      { from: 500_000_000n, to: null, rate: 0.20 },
    ]);
  });
}

const rowFor = (employeeId: string, over: Partial<any> = {}) => ({
  employeeId, workedDays: 30, overtimeHours: 0, nightHours: 0, holidayHours: 0, ...over,
});

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
});

// ═══════════════════════════════════════════════════════════════
describe('کارکنان', () => {
  it('ساخت کارمند یک تفصیلی EMPLOYEE هم می‌سازد', async () => {
    const emp = await tx((t) => createEmployee(t, {
      code: `EMP-${nextId()}`, name: 'رضا محمدی',
      hireDate: D('2024-01-01'), baseSalary: 120_000_000n, costCenterId: costCenter.id,
    }));
    const sub = await gl.glSubsidiary.findUniqueOrThrow({ where: { id: emp.subsidiaryId } });
    expect(sub.kind).toBe('EMPLOYEE');
    expect(sub.name).toBe('رضا محمدی');
  });

  it('کد تکراری رد می‌شود', async () => {
    const code = `EMP-${nextId()}`;
    await tx((t) => createEmployee(t, { code, name: 'الف', hireDate: D('2024-01-01'), baseSalary: 100_000_000n }));
    await expectRejects(
      () => tx((t) => createEmployee(t, { code, name: 'ب', hireDate: D('2024-01-01'), baseSalary: 100_000_000n })),
      /تکراری/,
    );
  });

  it('حقوق پایهٔ صفر یا منفی رد می‌شود', async () => {
    await expectRejects(
      () => tx((t) => createEmployee(t, { code: `EMP-${nextId()}`, name: 'ج', hireDate: D('2024-01-01'), baseSalary: 0n })),
      /حقوق پایه/,
    );
  });

  it('تغییر نام کارمند، نام تفصیلی را هم‌گام می‌کند', async () => {
    const emp = await tx((t) => createEmployee(t, {
      code: `EMP-${nextId()}`, name: 'نام اول', hireDate: D('2024-01-01'), baseSalary: 100_000_000n,
    }));
    await tx((t) => updateEmployee(t, emp.id, { name: 'نام دوم' }));
    const sub = await gl.glSubsidiary.findUniqueOrThrow({ where: { id: emp.subsidiaryId } });
    expect(sub.name).toBe('نام دوم');
  });

  it('غیرفعال‌کردن کارمند نگه داشته می‌شود', async () => {
    const emp = await tx((t) => createEmployee(t, {
      code: `EMP-${nextId()}`, name: 'د', hireDate: D('2024-01-01'), baseSalary: 100_000_000n,
    }));
    const updated = await tx((t) => updateEmployee(t, emp.id, { isActive: false }));
    expect(updated.isActive).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('نمای نرخ‌ها', () => {
  it('نرخِ غایب خطا نمی‌دهد؛ در فهرست کمبود می‌آید', async () => {
    const snap = await ratesSnapshot(gl, D('2026-05-01'));
    expect(snap.ready).toBe(false);
    expect(snap.missing.length).toBe(Object.values(RATE_KEYS).length);
    expect(snap.brackets).toHaveLength(0);
  });

  it('بعد از seed کامل، ready می‌شود', async () => {
    await seedRates(D('2026-03-21'));
    const snap = await ratesSnapshot(gl, D('2026-05-01'));
    expect(snap.ready).toBe(true);
    expect(snap.missing).toHaveLength(0);
    expect(snap.active[RATE_KEYS.HOUSING_MONTHLY].value).toBe('9000000');
    expect(snap.brackets.length).toBe(2);
  });

  it('نرخِ نسخهٔ جدید در تاریخِ خودش برنده است', async () => {
    await seedRates(D('2026-03-21'));
    await seedRates(D('2026-09-22'), { [RATE_KEYS.HOUSING_MONTHLY]: 15_000_000 });
    expect((await ratesSnapshot(gl, D('2026-05-01'))).active[RATE_KEYS.HOUSING_MONTHLY].value).toBe('9000000');
    expect((await ratesSnapshot(gl, D('2026-11-01'))).active[RATE_KEYS.HOUSING_MONTHLY].value).toBe('15000000');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('اصلاح لیست — یک‌گام', () => {
  async function finalRun() {
    await seedRates(D('2026-03-21'));
    const emp = await tx((t) => createEmployee(t, {
      code: `EMP-${nextId()}`, name: 'کارمند اصلاح', hireDate: D('2023-03-21'),
      baseSalary: 100_000_000n, costCenterId: costCenter.id,
    }));
    const built: any = await tx((t) => buildRun(t, { year: 1405, month: 3, rows: [rowFor(emp.id)] }));
    const fin: any = await tx((t) => finalizeRun(t, { runId: built.run.id, fiscalYearId: fy.id, date: D('2026-06-20') }));
    return { emp, built, fin };
  }

  it('سند قبلی برگشت می‌خورد و اصلاحیهٔ پیش‌نویس ساخته می‌شود', async () => {
    const { emp, built } = await finalRun();

    const amended: any = await tx((t) => reviseRun(t, {
      runId: built.run.id, rows: [rowFor(emp.id, { workedDays: 25 })],
    }));

    expect(amended.run.status).toBe('DRAFT');
    expect(amended.run.amendsId).toBe(built.run.id);

    const original = await gl.glPayrollRun.findUniqueOrThrow({ where: { id: built.run.id } });
    expect(original.status).toBe('AMENDED');

    // سند لیست اول باطل شده و سند برگشتی‌اش هست
    const entries = await gl.glEntry.findMany({ where: { sourceType: 'PayrollRun' } });
    expect(entries.some((e) => e.status === 'REVERSED')).toBe(true);
    expect(entries.some((e) => e.entryType === 'REVERSING')).toBe(true);

    // کارکرد کمتر ⇒ ناخالص کمتر
    expect(amended.totals.grossPay).toBeLessThan(built.totals.grossPay);
  });

  it('اصلاحیه با نرخِ همان دوره حساب می‌شود، نه نرخِ امروز', async () => {
    const { emp, built } = await finalRun();
    await seedRates(D('2026-09-22'), { [RATE_KEYS.HOUSING_MONTHLY]: 40_000_000 });

    const amended: any = await tx((t) => reviseRun(t, { runId: built.run.id, rows: [rowFor(emp.id)] }));
    expect(amended.results[0].housingAllowance).toBe(9_000_000n);
    expect(amended.results[0].grossPay).toBe(built.results[0].grossPay);
  });

  it('اصلاحیهٔ پیش‌نویس دوباره نهایی می‌شود و سند تراز می‌سازد', async () => {
    const { emp, built } = await finalRun();
    const amended: any = await tx((t) => reviseRun(t, { runId: built.run.id, rows: [rowFor(emp.id, { workedDays: 20 })] }));
    const fin2: any = await tx((t) => finalizeRun(t, { runId: amended.run.id, fiscalYearId: fy.id, date: D('2026-06-25') }));

    expect(fin2.run.status).toBe('FINAL');
    const lines = await gl.glLine.findMany({ where: { entryId: fin2.entry.id } });
    const dr = lines.reduce((s, l) => s + l.debitBase, 0n);
    const cr = lines.reduce((s, l) => s + l.creditBase, 0n);
    expect(dr).toBe(cr);
  });

  it('لیست پیش‌نویس اصلاحیه نمی‌گیرد', async () => {
    await seedRates(D('2026-03-21'));
    const emp = await tx((t) => createEmployee(t, {
      code: `EMP-${nextId()}`, name: 'ه', hireDate: D('2024-01-01'), baseSalary: 100_000_000n, costCenterId: costCenter.id,
    }));
    const built: any = await tx((t) => buildRun(t, { year: 1405, month: 4, rows: [rowFor(emp.id)] }));
    await expectRejects(
      () => tx((t) => reviseRun(t, { runId: built.run.id, rows: [rowFor(emp.id)] })),
      /نهایی‌شده/,
    );
  });
});
