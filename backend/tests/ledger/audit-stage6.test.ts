/**
 * ممیزی — مرحلهٔ ۶ (بلوغ).
 *   ج۱۰ پرداختِ ذخیره‌ها (عیدی/سنوات/مرخصی/تسویه‌حساب)
 *   ج۱۷ عیدی بر مزد ثابت، با سقفِ قانونیِ ۹۰ روزِ حداقل‌دستمزد
 *
 * (ج۹ تسویهٔ بین‌ارزی در tests/ledger/ops.test.ts پوشش دارد.)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D, DEFAULT_DATE,
  resetBusinessData, expectRejects,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { positionBalance } from '../../src/modules/ledger/fx';
import { ensureDefaultCostCenters } from '../../src/modules/ledger/costcenter';
import { payProvision, provisionBalances } from '../../src/modules/ledger/payroll/provisions';
import { setRate, setTaxBrackets, resolveRates, RATE_KEYS, OPTIONAL_RATE_KEYS } from '../../src/modules/ledger/payroll/rates';
import { computePayrollItem } from '../../src/modules/ledger/payroll/engine';
import { recordGlAudit, readGlAudit, assertChecker, MakerCheckerError } from '../../src/modules/ledger/audit-log';
import { bankReconciliation } from '../../src/modules/ledger/bank-recon';
import { createAccount } from '../../src/modules/ledger/codes';

let fy: any, cash: any, equity: any, adminCc: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

/** نرخ‌های نمونه — اعداد آزمایشی، نه واقعیِ قانونی */
const RATES = {
  [RATE_KEYS.MIN_WAGE_DAILY]: 3_000_000,        // ⇒ سقفِ عیدیِ سالانه = ۹۰ × ۳م = ۲۷۰م ⇒ ماهانه ۲۲٫۵م
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
  [RATE_KEYS.BONUS_ACCRUAL_FACTOR]: 0.25,       // ۳ ماه ÷ ۱۲ — سقفِ قانونیِ عیدی
  [RATE_KEYS.SEVERANCE_DAYS_PER_MONTH]: 2.5,
  [RATE_KEYS.LEAVE_DAYS_PER_MONTH]: 2.5,
  [RATE_KEYS.MONTH_DAYS]: 30,
  [RATE_KEYS.MONTH_HOURS]: 220,
};

async function seedRates(validFrom: Date, overrides: Record<string, number> = {}) {
  const values = { ...RATES, ...overrides };
  await tx(async (t) => {
    for (const [key, value] of Object.entries(values)) {
      await setRate(t, { key: key as any, value, validFrom });
    }
    await setTaxBrackets(t, validFrom, [{ from: 0n, to: null, rate: 0.10 }]);
  });
}

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101');
  equity = await accountByCode('3101');
}, 180_000);

afterAll(async () => {
  await resetGl();
  await gl.glAccount.deleteMany({ where: { isSystem: false } });
  await gl.$disconnect();
});

beforeEach(async () => {
  await resetGl();
  await gl.glAccount.deleteMany({ where: { isSystem: false } });   // حساب‌های تستِ اجرای قبلی
  await resetBusinessData();
  await gl.glPayrollRate.deleteMany({});
  await gl.glPayrollTaxBracket.deleteMany({});
  await gl.glAuditLog.deleteMany({});
  delete process.env.LEDGER_MAKER_CHECKER;
  fy = await makeFiscalYear();
  await tx((t) => ensureDefaultCostCenters(t));
  adminCc = await gl.glCostCenter.findFirstOrThrow({ where: { code: '3' } });
});

// ═══════════════════════════════════════════════════════════════
describe('ج۱۷ — عیدی بر مزد ثابت با سقف قانونی', () => {
  it('پایهٔ عیدی مزد ثابت است نه ناخالص — اضافه‌کاری اثری ندارد', async () => {
    await seedRates(D('2026-03-21'));
    const rates = await resolveRates(gl, D('2026-05-01'));

    const noOt = computePayrollItem(
      { employeeId: 'x', baseSalary: 60_000_000n, childrenCount: 0, seniorityYears: 0,
        workedDays: 30, overtimeHours: 0, nightHours: 0, holidayHours: 0 }, rates);
    const withOt = computePayrollItem(
      { employeeId: 'x', baseSalary: 60_000_000n, childrenCount: 0, seniorityYears: 0,
        workedDays: 30, overtimeHours: 80, nightHours: 40, holidayHours: 16 }, rates);

    expect(withOt.grossPay).toBeGreaterThan(noOt.grossPay);   // اضافه‌کاری ناخالص را بالا برد
    expect(withOt.accrualBonus).toBe(noOt.accrualBonus);       // ولی عیدی تکان نخورد
    expect(noOt.accrualBonus).toBe(15_000_000n);               // ۶۰م × ۰٫۲۵ (زیرِ سقفِ ۲۲٫۵م)
  });

  it('سقفِ ۹۰ روزِ حداقل‌دستمزد اعمال می‌شود', async () => {
    await seedRates(D('2026-03-21'));
    const rates = await resolveRates(gl, D('2026-05-01'));
    const r = computePayrollItem(
      { employeeId: 'x', baseSalary: 300_000_000n, childrenCount: 0, seniorityYears: 0,
        workedDays: 30, overtimeHours: 0, nightHours: 0, holidayHours: 0 }, rates);
    // بی‌سقف = ۷۵م؛ سقفِ ماهانه = (۹۰ × ۳م) ÷ ۱۲ = ۲۲٫۵م
    expect(r.accrualBonus).toBe(22_500_000n);
  });

  it('سقف با روزهای کارکردِ ناقص نصف می‌شود', async () => {
    await seedRates(D('2026-03-21'));
    const rates = await resolveRates(gl, D('2026-05-01'));
    const r = computePayrollItem(
      { employeeId: 'x', baseSalary: 300_000_000n, childrenCount: 0, seniorityYears: 0,
        workedDays: 15, overtimeHours: 0, nightHours: 0, holidayHours: 0 }, rates);
    expect(r.accrualBonus).toBe(11_250_000n);   // نصفِ سقفِ کامل
  });

  it('کلیدِ BONUS_INCLUDE_ALLOWANCES حق مسکن و بن را به پایه اضافه می‌کند', async () => {
    await seedRates(D('2026-03-21'), { [OPTIONAL_RATE_KEYS.BONUS_INCLUDE_ALLOWANCES]: 1 });
    const rates = await resolveRates(gl, D('2026-05-01'));
    const r = computePayrollItem(
      { employeeId: 'x', baseSalary: 60_000_000n, childrenCount: 0, seniorityYears: 0,
        workedDays: 30, overtimeHours: 0, nightHours: 0, holidayHours: 0 }, rates);
    // پایه = ۶۰م + ۹م مسکن + ۱۴م بن = ۸۳م ⇒ × ۰٫۲۵ = ۲۰٬۷۵۰٬۰۰۰ (زیرِ سقفِ ۲۲٫۵م)
    expect(r.accrualBonus).toBe(20_750_000n);
  });

  it('نبودِ کلیدهای اختیاری، resolveRates را رد نمی‌کند و پیش‌فرض می‌گیرد', async () => {
    await seedRates(D('2026-03-21'));
    const rates = await resolveRates(gl, D('2026-05-01'));
    expect(rates.values[OPTIONAL_RATE_KEYS.BONUS_CAP_DAYS]).toBe(90);
    expect(rates.values[OPTIONAL_RATE_KEYS.BONUS_INCLUDE_ALLOWANCES]).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ج۱۰ — پرداختِ ذخیره‌ها', () => {
  /** ذخیره می‌سازد: بدهکار هزینهٔ ۶۱۰x (مرکز اجباری)، بستانکار ذخیرهٔ ۲۱۰x */
  async function accrue(provCode: string, amount: bigint) {
    const expCode = provCode === '2108' ? '6103' : provCode === '2109' ? '6104' : '6105';
    const exp = await accountByCode(expCode);
    const prov = await accountByCode(provCode);
    return tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-05-31'), description: 'ذخیرهٔ ماهانه',
      lines: [
        { accountId: exp.id, currencyCode: 'IRR', debit: amount, costCenterId: adminCc.id },
        { accountId: prov.id, currencyCode: 'IRR', credit: amount },
      ],
    }));
  }

  it('پرداختِ جزئی از ذخیره: بدهکار ۲۱۰۸، بستانکار نقد، بدون اثرِ هزینه', async () => {
    await accrue('2108', 50_000_000n);
    const entry: any = await tx((t) => payProvision(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, kind: 'BONUS',
      amount: '30000000', cashAccountCode: '110101',
    }));
    const lines = await gl.glLine.findMany({
      where: { entryId: entry.id }, include: { account: { select: { code: true } } },
    });
    const prov = lines.find((l) => l.account.code === '2108')!;
    expect(prov.debit).toBe(30_000_000n);
    expect(lines.find((l) => l.account.code === '110101')!.credit).toBe(30_000_000n);
    expect(lines.some((l) => l.account.code === '6103')).toBe(false);
    const pos = await positionBalance(gl, { accountId: prov.accountId, currencyCode: 'IRR', subsidiaryId: null });
    expect(pos.amount).toBe(20_000_000n);   // ۵۰م − ۳۰م
  });

  it('پرداختِ بیش از ذخیره: مازاد هزینهٔ همین دوره است', async () => {
    await accrue('2109', 10_000_000n);
    const entry: any = await tx((t) => payProvision(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, kind: 'SEVERANCE',
      amount: '15000000', cashAccountCode: '110101', forWhom: 'رضایی',
    }));
    const lines = await gl.glLine.findMany({
      where: { entryId: entry.id }, include: { account: { select: { code: true } } },
    });
    expect(lines.find((l) => l.account.code === '2109')!.debit).toBe(10_000_000n);
    expect(lines.find((l) => l.account.code === '6104')!.debit).toBe(5_000_000n);
    expect(lines.find((l) => l.account.code === '110101')!.credit).toBe(15_000_000n);
  });

  it('trueUp: کلِ ذخیره بسته می‌شود؛ مازادِ ذخیره برگشتِ هزینه', async () => {
    await accrue('2110', 20_000_000n);
    const entry: any = await tx((t) => payProvision(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, kind: 'LEAVE',
      amount: '12000000', cashAccountCode: '110101', trueUp: true,
    }));
    const lines = await gl.glLine.findMany({
      where: { entryId: entry.id }, include: { account: { select: { code: true } } },
    });
    expect(lines.find((l) => l.account.code === '2110')!.debit).toBe(20_000_000n);
    expect(lines.find((l) => l.account.code === '110101')!.credit).toBe(12_000_000n);
    expect(lines.find((l) => l.account.code === '6105')!.credit).toBe(8_000_000n);   // ۸م مازاد
    const pos = await positionBalance(gl, {
      accountId: (await accountByCode('2110')).id, currencyCode: 'IRR', subsidiaryId: null,
    });
    expect(pos.amount).toBe(0n);
  });

  it('provisionBalances هر سه ذخیره را برمی‌گرداند', async () => {
    await accrue('2108', 7_000_000n);
    await accrue('2109', 3_000_000n);
    const b = await provisionBalances(gl);
    expect(b.BONUS).toBe('7000000');
    expect(b.SEVERANCE).toBe('3000000');
    expect(b.LEAVE).toBe('0');
  });

  it('مبلغ صفر رد می‌شود', async () => {
    await accrue('2108', 5_000_000n);
    await expectRejects(() => tx((t) => payProvision(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, kind: 'BONUS',
      amount: '0', cashAccountCode: '110101',
    })), /بزرگ‌تر از صفر/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ج۱۶ — ردِ پا و تفکیک وظایف', () => {
  it('recordGlAudit یک رویداد می‌نویسد و readGlAudit فیلتر می‌کند', async () => {
    await recordGlAudit(gl as any, { action: 'POST', summary: 'سند الف', actorId: 'u1', actorName: 'علی', entrySerial: 3 });
    await recordGlAudit(gl as any, { action: 'REVERSE', summary: 'ابطال ب', actorId: 'u2', entryId: 'e9', meta: { big: 5n } });

    const all = await readGlAudit(gl as any);
    expect(all.total).toBe(2);
    expect(all.rows[0].summary).toBe('ابطال ب');          // نزولی بر اساس زمان

    const onlyPost = await readGlAudit(gl as any, { action: 'POST' });
    expect(onlyPost.total).toBe(1);
    expect(onlyPost.rows[0].actorName).toBe('علی');
    // BigInt در meta رشته می‌شود
    const rev = await readGlAudit(gl as any, { action: 'REVERSE' });
    expect((rev.rows[0].meta as any).big).toBe('5');
  });

  it('نوشتنِ ردِ پا هرگز پرتاب نمی‌کند حتی با ورودیِ خراب', async () => {
    // actorId بیش از حد بلند — create می‌شکند ولی بی‌صدا
    await expect(recordGlAudit(gl as any, {
      action: 'POST', summary: 'x'.repeat(10), actorId: 'a'.repeat(5000),
    })).resolves.toBeUndefined();
  });

  it('assertChecker: خاموش ⟵ هیچ‌وقت خطا نمی‌دهد', () => {
    expect(() => assertChecker('u1', 'u1')).not.toThrow();
  });

  it('assertChecker: روشن ⟵ سازنده = تأییدکننده رد می‌شود، متفاوت مجاز', () => {
    process.env.LEDGER_MAKER_CHECKER = 'true';
    expect(() => assertChecker('u1', 'u1')).toThrow(MakerCheckerError);
    expect(() => assertChecker('u1', 'u2')).not.toThrow();
    expect(() => assertChecker(null, 'u2')).not.toThrow();   // سند بدون سازنده
  });
});

// ═══════════════════════════════════════════════════════════════
describe('صورت مغایرت بانکی', () => {
  let bank: { code: string };
  beforeEach(async () => {
    bank = await tx((t) => createAccount(t, {
      code: '110190', name: 'بانک تست', currencyMode: 'SINGLE', currencyCode: 'IRR',
    }));
  });

  it('ماندهٔ دفتر با صورتحساب می‌خواند ⟵ مغایرتِ صفر', async () => {
    const bankAcc = await accountByCode(bank.code);
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-05-10'), description: 'واریز اولیه',
      lines: [
        { accountId: bankAcc.id, currencyCode: 'IRR', debit: 500_000_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 500_000_000n },
      ],
    }));
    const r = await bankReconciliation(gl, {
      accountCode: bank.code, asOf: D('2026-06-30'), statementBalance: 500_000_000n,
    });
    expect(r.bookBalance).toBe(500_000_000n);
    expect(r.difference).toBe(0n);
    expect(r.reconciled).toBe(true);
  });

  it('اقلامِ مغایرت ماندهٔ دفتر را تعدیل می‌کند', async () => {
    const bankAcc = await accountByCode(bank.code);
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-05-10'), description: 'واریز',
      lines: [
        { accountId: bankAcc.id, currencyCode: 'IRR', debit: 500_000_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 500_000_000n },
      ],
    }));
    // بانک ۴۹۸ م نشان می‌دهد: ۲ م کارمزدِ ثبت‌نشده
    const r = await bankReconciliation(gl, {
      accountCode: bank.code, asOf: D('2026-06-30'),
      statementBalance: 498_000_000n,
      adjustments: [{ amount: -2_000_000n, note: 'کارمزد بانکی ثبت‌نشده' }],
    });
    expect(r.adjustedBook).toBe(498_000_000n);
    expect(r.difference).toBe(0n);
    expect(r.reconciled).toBe(true);
  });

  it('بدون statementBalance فقط ماندهٔ دفتر و گردش برمی‌گردد', async () => {
    const bankAcc = await accountByCode(bank.code);
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-06-01'), description: 'واریز',
      lines: [
        { accountId: bankAcc.id, currencyCode: 'IRR', debit: 100_000_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 100_000_000n },
      ],
    }));
    const r = await bankReconciliation(gl, { accountCode: bank.code, asOf: D('2026-06-30') });
    expect(r.bookBalance).toBe(100_000_000n);
    expect(r.difference).toBeNull();
    expect(r.reconciled).toBe(false);
    expect(r.movements.length).toBe(1);
  });

  it('حساب غیرِ ۱۱۰۱ رد می‌شود', async () => {
    await expectRejects(
      () => bankReconciliation(gl, { accountCode: '1104', asOf: D('2026-06-30') }),
      /نقد و بانک/,
    );
  });
});
