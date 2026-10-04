/**
 * گزارش‌های قانونی — مرحلهٔ ۴: ماده ۱۶۹ و اظهارنامهٔ ارزش افزوده.
 *
 * دو چیز اینجا قفل می‌شود:
 *
 * ۱) **طرف‌حساب از سند خوانده می‌شود، نه از ردیف.** ردیف‌های درآمد و هزینه
 *    تفصیلی ندارند؛ تفصیلی روی معین کنترلیِ همان سند است.
 * ۲) **سندِ چندطرف‌حسابی حدس زده نمی‌شود.** کنار گذاشته می‌شود و در فهرست
 *    «قابل انتساب نیست» با دلیل می‌آید. گزارش مالیاتی جای حدس نیست.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, makeSubsidiary, accountByCode,
  D, resetBusinessData,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { article169, vatReturn, readinessProblems } from '../../src/modules/ledger/reports/tax';

let fy: any, cash: any, sales: any, ar: any, ap: any, rent: any, vatOut: any, vatIn: any;
let alpha: any, beta: any, vendor: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

const PERIOD = { from: D('2026-03-21'), to: D('2026-06-21') };

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
  ar = await accountByCode('1104'); ap = await accountByCode('2101');
  rent = await accountByCode('6202');
  vatOut = await accountByCode('2107'); vatIn = await accountByCode('1109');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await resetGl(); await resetBusinessData();
  fy = await makeFiscalYear();
  alpha = await makeSubsidiary('CUSTOMER', 'شرکت الف');
  beta = await makeSubsidiary('CUSTOMER', 'شرکت ب');
  vendor = await makeSubsidiary('SUPPLIER', 'تأمین‌کنندهٔ پ');
});

/** فاکتور فروش: دریافتنی بدهکار = فروش + ارزش افزوده */
const invoice = (party: any, net: bigint, vat: bigint, date = D('2026-04-01')) =>
  entry(date, `فاکتور فروش به ${party.name}`, [
    { accountId: ar.id, subsidiaryId: party.id, currencyCode: 'IRR', debit: net + vat },
    { accountId: sales.id, currencyCode: 'IRR', credit: net },
    { accountId: vatOut.id, currencyCode: 'IRR', credit: vat },
  ]);

/** فاکتور خرید */
const bill = (party: any, net: bigint, vat: bigint, date = D('2026-04-05')) =>
  entry(date, `فاکتور خرید از ${party.name}`, [
    { accountId: rent.id, currencyCode: 'IRR', debit: net },
    { accountId: vatIn.id, currencyCode: 'IRR', debit: vat },
    { accountId: ap.id, subsidiaryId: party.id, currencyCode: 'IRR', credit: net + vat },
  ]);

// ═══════════════════════════════════════════════════════════════
describe('ماده ۱۶۹ — انتساب به طرف‌حساب', () => {
  it('فروش از سند به مشتری منتسب می‌شود، هرچند ردیف فروش تفصیلی ندارد', async () => {
    await invoice(alpha, 1_000_000_000n, 100_000_000n);

    const r = await article169(gl, PERIOD);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].name).toBe('شرکت الف');
    expect(r.rows[0].sales).toBe('1000000000');
    expect(r.rows[0].salesVat).toBe('100000000');
    expect(r.rows[0].salesCount).toBe(1);
    expect(r.unattributed).toHaveLength(0);
  });

  it('خرید از تأمین‌کننده جدا از فروش شمرده می‌شود', async () => {
    await bill(vendor, 500_000_000n, 50_000_000n);

    const r = await article169(gl, PERIOD);
    const row = r.rows.find((x) => x.name === 'تأمین‌کنندهٔ پ')!;
    expect(row.purchases).toBe('500000000');
    expect(row.purchasesVat).toBe('50000000');
    expect(row.sales).toBe('0');
  });

  it('چند فاکتور همان مشتری روی هم جمع می‌شود', async () => {
    await invoice(alpha, 1_000_000_000n, 100_000_000n, D('2026-04-01'));
    await invoice(alpha, 2_000_000_000n, 200_000_000n, D('2026-05-01'));

    const r = await article169(gl, PERIOD);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].sales).toBe('3000000000');
    expect(r.rows[0].salesCount).toBe(2);
  });

  it('سندِ دوطرف‌حسابی حدس زده نمی‌شود — کنار می‌رود با دلیل', async () => {
    await entry(D('2026-04-10'), 'فروش ترکیبی به دو مشتری', [
      { accountId: ar.id, subsidiaryId: alpha.id, currencyCode: 'IRR', debit: 600_000_000n },
      { accountId: ar.id, subsidiaryId: beta.id, currencyCode: 'IRR', debit: 400_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 1_000_000_000n },
    ]);

    const r = await article169(gl, PERIOD);
    expect(r.rows).toHaveLength(0);              // به هیچ‌کس منتسب نشد
    expect(r.unattributed).toHaveLength(1);
    expect(r.unattributed[0].reason).toMatch(/۲ طرف‌حساب|2 طرف‌حساب/);
    expect(r.unattributed[0].amount).toBe('1000000000');
  });

  it('سندِ بی‌طرف‌حساب هم گزارش می‌شود، نه اینکه بی‌صدا گم شود', async () => {
    // هزینهٔ نقدیِ بدون تفصیلی — در ماده ۱۶۹ جایی ندارد ولی حسابدار باید بداند
    await entry(D('2026-04-12'), 'هزینهٔ نقدی بدون طرف‌حساب', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 80_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 80_000_000n },
    ]);

    const r = await article169(gl, PERIOD);
    expect(r.rows).toHaveLength(0);
    expect(r.unattributed[0].reason).toMatch(/هیچ طرف‌حسابی/);
  });

  it('سند خارج از بازه شمرده نمی‌شود', async () => {
    await invoice(alpha, 1_000_000_000n, 100_000_000n, D('2026-08-01'));   // تابستان
    const r = await article169(gl, PERIOD);
    expect(r.rows).toHaveLength(0);
  });

  it('سند اختتامیه در گزارش نمی‌آید', async () => {
    await invoice(alpha, 1_000_000_000n, 100_000_000n);
    const before = await article169(gl, PERIOD);

    const { closeFiscalYear } = await import('../../src/modules/ledger/year-close');
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    const after = await article169(gl, PERIOD);
    expect(after.totals.sales).toBe(before.totals.sales);
    expect(after.totals.sales).toBe('1000000000');
  });

  it('بزرگ‌ترین طرف‌حساب اول می‌آید', async () => {
    await invoice(alpha, 1_000_000_000n, 0n);
    await invoice(beta, 5_000_000_000n, 0n);
    const r = await article169(gl, PERIOD);
    expect(r.rows.map((x) => x.name)).toEqual(['شرکت ب', 'شرکت الف']);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('آمادگی هویت مالیاتی', () => {
  it('نبودِ نوع شخص، اولین ایراد است', () => {
    expect(readinessProblems({ taxPersonType: null, nationalId: null, economicCode: null }))
      .toEqual(['نوع شخص (حقیقی/حقوقی) مشخص نشده']);
  });

  it('شخص حقوقی شناسهٔ ۱۱ رقمی می‌خواهد و حقیقی ۱۰ رقمی', () => {
    expect(readinessProblems({ taxPersonType: 'LEGAL', nationalId: '12345678901', economicCode: null }))
      .toEqual([]);
    expect(readinessProblems({ taxPersonType: 'LEGAL', nationalId: '1234567890', economicCode: null }))
      .toEqual(['شناسه باید 11 رقم باشد']);
    expect(readinessProblems({ taxPersonType: 'NATURAL', nationalId: '1234567890', economicCode: null }))
      .toEqual([]);
  });

  it('مصرف‌کنندهٔ نهایی شناسه لازم ندارد', () => {
    expect(readinessProblems({ taxPersonType: 'CONSUMER', nationalId: null, economicCode: null }))
      .toEqual([]);
  });

  it('کد اقتصادیِ ثبت‌شده باید ۱۲ رقم باشد؛ نبودنش ایراد نیست', () => {
    expect(readinessProblems({ taxPersonType: 'LEGAL', nationalId: '12345678901', economicCode: '123' }))
      .toEqual(['کد اقتصادی باید ۱۲ رقم باشد']);
    expect(readinessProblems({ taxPersonType: 'LEGAL', nationalId: '12345678901', economicCode: null }))
      .toEqual([]);
  });

  it('گزارش، ردیف‌های ناقص را می‌شمارد ولی حذفشان نمی‌کند', async () => {
    await invoice(alpha, 1_000_000_000n, 0n);
    await gl.glSubsidiary.update({
      where: { id: alpha.id },
      data: { taxPersonType: 'LEGAL', nationalId: '12345678901' },
    });
    await invoice(beta, 500_000_000n, 0n);   // بدون هویت مالیاتی

    const r = await article169(gl, PERIOD);
    expect(r.rows).toHaveLength(2);
    expect(r.notReady).toBe(1);
    expect(r.rows.find((x) => x.name === 'شرکت الف')!.problems).toEqual([]);
    expect(r.rows.find((x) => x.name === 'شرکت ب')!.problems.length).toBeGreaterThan(0);
    // جمع کامل است، هرچند یک ردیف ناقص باشد
    expect(r.totals.sales).toBe('1500000000');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('اظهارنامهٔ ارزش افزوده', () => {
  it('مالیات فروش منهای اعتبار خرید، بدهی به سازمان است', async () => {
    await invoice(alpha, 1_000_000_000n, 100_000_000n);
    await bill(vendor, 400_000_000n, 40_000_000n);

    const v = await vatReturn(gl, PERIOD);
    expect(v.outputVat).toBe('100000000');
    expect(v.inputVat).toBe('40000000');
    expect(v.net).toBe('60000000');
    expect(v.position).toBe('PAYABLE');
    expect(v.amount).toBe('60000000');
  });

  it('اعتبارِ بیشتر از مالیات فروش ⇒ قابل انتقال، نه «مالیات منفی»', async () => {
    await invoice(alpha, 100_000_000n, 10_000_000n);
    await bill(vendor, 900_000_000n, 90_000_000n);

    const v = await vatReturn(gl, PERIOD);
    expect(v.net).toBe('-80000000');
    expect(v.position).toBe('CREDIT');
    // رقمی که در فرم نوشته می‌شود همیشه مثبت است
    expect(v.amount).toBe('80000000');
  });

  it('فروشِ بدون ارزش افزوده در پایهٔ مشمول نمی‌آید', async () => {
    await invoice(alpha, 1_000_000_000n, 100_000_000n);
    await invoice(beta, 700_000_000n, 0n);          // معاف

    const v = await vatReturn(gl, PERIOD);
    expect(v.taxableSales).toBe('1000000000');
    expect(v.outputVat).toBe('100000000');
  });

  it('دورهٔ بی‌تراکنش، صفر می‌دهد نه خطا', async () => {
    const v = await vatReturn(gl, { from: D('2026-10-01'), to: D('2026-12-01') });
    expect(v.net).toBe('0');
    expect(v.position).toBe('NIL');
  });
});
