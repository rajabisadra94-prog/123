/**
 * روند ماهانه و مرزهای ماه شمسی — ممیزی سوم، ب۱۵.
 *
 * حساس‌ترین بخش، **مرزهای ماه** است. تقریبِ ۳۰ روزه‌ای که نسخهٔ اول بودجه
 * داشت، ۳۱ فروردین را به اردیبهشت می‌برد و انحرافِ هر دو ماه را خراب می‌کرد.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D, resetBusinessData,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { shamsiMonths, shamsiRange } from '../../src/modules/ledger/shamsi';
import { monthlyTrend } from '../../src/modules/ledger/reports/trend';
import { upsertBudget, budgetVsActual } from '../../src/modules/ledger/budget';

let fy: any, cash: any, sales: any, rent: any;
const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

const iso = (d: Date) => d.toISOString().slice(0, 10);
const flat = (per: bigint) => Array.from({ length: 12 }, () => per);

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
  rent = await accountByCode('6202');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await gl.glBudget.deleteMany({});
  await resetGl(); await resetBusinessData();
  fy = await makeFiscalYear();
});

// ═══════════════════════════════════════════════════════════════
describe('مرزهای ماه شمسی', () => {
  // سال مالی تست: ۱ فروردین ۱۴۰۵ = ۲۰۲۶-۰۳-۲۱ تا ۲۹ اسفند = ۲۰۲۷-۰۳-۲۰
  const FY = { startDate: new Date('2026-03-21T00:00:00Z'), endDate: new Date('2027-03-20T00:00:00Z') };

  it('شش ماه اول ۳۱ روزه‌اند و پنج ماه بعد ۳۰ روزه', () => {
    const m = shamsiMonths(FY);
    const len = (i: number) =>
      Math.round((m[i].to.getTime() - m[i].from.getTime()) / 86_400_000) + 1;
    expect([0, 1, 2, 3, 4, 5].map(len)).toEqual([31, 31, 31, 31, 31, 31]);
    expect([6, 7, 8, 9, 10].map(len)).toEqual([30, 30, 30, 30, 30]);
    expect(len(11)).toBe(29);   // ۱۴۰۵ کبیسه نیست
  });

  it('فروردین ۳۱ روز است، نه ۳۰ — همان خطایی که بودجه داشت', () => {
    const m = shamsiMonths(FY);
    expect(iso(m[0].from)).toBe('2026-03-21');
    expect(iso(m[0].to)).toBe('2026-04-20');      // ۳۱ فروردین
    expect(iso(m[1].from)).toBe('2026-04-21');    // ۱ اردیبهشت
    // تقریبِ ۳۰ روزه، اردیبهشت را از ۲۰ آوریل شروع می‌کرد و یک روز می‌دزدید
  });

  it('ماه دوازدهم دقیقاً روی پایان سال مالی تمام می‌شود', () => {
    const m = shamsiMonths(FY);
    expect(iso(m[11].to)).toBe(iso(FY.endDate));
  });

  it('سال کبیسه اسفندِ ۳۰ روزه می‌گیرد', () => {
    // ۱۴۰۳ کبیسه است: ۲۰۲۴-۰۳-۲۰ تا ۲۰۲۵-۰۳-۲۰ ⇒ ۳۶۶ روز
    const leap = { startDate: new Date('2024-03-20T00:00:00Z'), endDate: new Date('2025-03-20T00:00:00Z') };
    const m = shamsiMonths(leap);
    expect(Math.round((m[11].to.getTime() - m[11].from.getTime()) / 86_400_000) + 1).toBe(30);
    expect(iso(m[11].to)).toBe(iso(leap.endDate));
  });

  it('بازهٔ چندماهه از ابتدای ماه اول تا انتهای ماه آخر است', () => {
    const r = shamsiRange(FY, 1, 3);
    expect(iso(r.from)).toBe('2026-03-21');
    expect(iso(r.to)).toBe('2026-06-21');   // ۳۱ خرداد
    // ماه‌های خارج از محدوده بریده می‌شوند، نه اینکه خطا بدهند
    expect(iso(shamsiRange(FY, 0, 99).from)).toBe(iso(FY.startDate));
    expect(iso(shamsiRange(FY, 0, 99).to)).toBe(iso(FY.endDate));
  });
});

// ═══════════════════════════════════════════════════════════════
describe('بودجه با مرز واقعیِ ماه', () => {
  it('هزینهٔ ۳۱ فروردین در عملکردِ فروردین می‌نشیند، نه اردیبهشت', async () => {
    await tx((t) => upsertBudget(t, {
      fiscalYearId: fy.id, accountCode: '6202', months: flat(100_000_000n),
    }));
    // ۳۱ فروردین ۱۴۰۵ = ۲۰۲۶-۰۴-۲۰ — دقیقاً روزی که تقریبِ ۳۰ روزه گم می‌کرد
    await entry(D('2026-04-20'), 'اجارهٔ آخر فروردین', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 80_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 80_000_000n },
    ]);

    const far = await budgetVsActual(gl, { fiscalYearId: fy.id, fromMonth: 1, toMonth: 1 });
    const ord = await budgetVsActual(gl, { fiscalYearId: fy.id, fromMonth: 2, toMonth: 2 });
    expect(far.rows[0].actual).toBe('80000000');
    expect(ord.rows[0].actual).toBe('0');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('روند ماهانه', () => {
  it('درآمد و هزینهٔ هر ماه جدا و غیرتجمعی است', async () => {
    await entry(D('2026-04-01'), 'فروش فروردین', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 500_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 500_000_000n },
    ]);
    await entry(D('2026-05-01'), 'فروش اردیبهشت', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 300_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 300_000_000n },
    ]);
    await entry(D('2026-05-05'), 'اجاره اردیبهشت', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 120_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 120_000_000n },
    ]);

    const t = await monthlyTrend(gl, fy.id, new Date('2027-03-01'));
    expect(t.months).toHaveLength(12);

    const [far, ord] = t.months;
    expect(far.label).toBe('فروردین');
    expect(far.income).toBe('500000000');
    expect(far.expense).toBe('0');
    expect(far.profit).toBe('500000000');

    // اردیبهشت فقط عددِ خودش را دارد — تجمعی نیست
    expect(ord.income).toBe('300000000');
    expect(ord.expense).toBe('120000000');
    expect(ord.profit).toBe('180000000');

    expect(t.totals.income).toBe('800000000');
    expect(t.totals.expense).toBe('120000000');
    expect(t.totals.profit).toBe('680000000');
  });

  it('ماندهٔ نقد تجمعی است، برخلاف درآمد و هزینه', async () => {
    await entry(D('2026-04-01'), 'فروش', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 500_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 500_000_000n },
    ]);
    await entry(D('2026-05-05'), 'اجاره', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 120_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 120_000_000n },
    ]);

    const t = await monthlyTrend(gl, fy.id, new Date('2027-03-01'));
    expect(t.months[0].cash).toBe('500000000');
    expect(t.months[1].cash).toBe('380000000');
    // ماهی که سندی ندارد، مانده را نگه می‌دارد نه اینکه صفر کند
    expect(t.months[2].cash).toBe('380000000');
  });

  it('ماه‌های نیامده علامت‌گذاری می‌شوند تا صفر کشیده نشوند', async () => {
    // «امروز» وسط اردیبهشت
    const t = await monthlyTrend(gl, fy.id, new Date('2026-05-05'));
    expect(t.months[0].future).toBe(false);   // فروردین
    expect(t.months[1].future).toBe(false);   // اردیبهشت، شروع شده
    expect(t.months[2].future).toBe(true);    // خرداد هنوز نیامده
    expect(t.months[11].future).toBe(true);
  });

  it('سند اختتامیه روند را صفر نمی‌کند', async () => {
    await entry(D('2026-04-01'), 'فروش', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 500_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 500_000_000n },
    ]);
    const before = await monthlyTrend(gl, fy.id, new Date('2027-03-01'));

    const { closeFiscalYear } = await import('../../src/modules/ledger/year-close');
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    const after = await monthlyTrend(gl, fy.id, new Date('2027-03-01'));
    expect(after.totals.income).toBe(before.totals.income);
    expect(after.totals.income).toBe('500000000');
  });
});
