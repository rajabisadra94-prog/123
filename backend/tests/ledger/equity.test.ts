/**
 * صورت تغییرات حقوق صاحبان سهام — مرحلهٔ ۴ ب.
 *
 * تلهٔ اصلی: **سودِ دوره دو بار شمرده می‌شود.** صورت تغییرات همیشه سود خالص
 * را سطر مستقل نشان می‌دهد، ولی اگر سال بسته شده باشد همان سود از قبل با سند
 * اختتامیه در گردشِ ۳۱۰۲ هست. این تست‌ها هر دو حالت را قفل می‌کنند.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D, resetBusinessData,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { equityStatement, legalReserveSuggestion } from '../../src/modules/ledger/reports/equity';

let fy: any, cash: any, sales: any, rent: any, capital: any, retained: any, reserve: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

const YEAR = { from: D('2026-03-21'), to: D('2027-03-20') };
const col = (st: any, code: string) => st.columns.find((c: any) => c.code === code)!;

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
  rent = await accountByCode('6202'); capital = await accountByCode('3101');
  retained = await accountByCode('3102'); reserve = await accountByCode('3103');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await resetGl(); await resetBusinessData();
  fy = await makeFiscalYear();
});

/** سود ۴۰۰م: فروش ۵۰۰م منهای اجارهٔ ۱۰۰م */
const makeProfit = async () => {
  await entry(D('2026-05-01'), 'فروش', [
    { accountId: cash.id, currencyCode: 'IRR', debit: 500_000_000n },
    { accountId: sales.id, currencyCode: 'IRR', credit: 500_000_000n },
  ]);
  await entry(D('2026-05-10'), 'اجاره', [
    { accountId: rent.id, currencyCode: 'IRR', debit: 100_000_000n },
    { accountId: cash.id, currencyCode: 'IRR', credit: 100_000_000n },
  ]);
};

// ═══════════════════════════════════════════════════════════════
describe('ستون‌های حقوق صاحبان سهام', () => {
  it('آورده نقدی، ستون سرمایه را بالا می‌برد', async () => {
    await entry(D('2026-04-01'), 'آوردهٔ نقدی سهامداران', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 10_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 10_000_000_000n },
    ]);

    const st = await equityStatement(gl, YEAR);
    const c = col(st, '3101');
    expect(c.opening).toBe('0');
    expect(c.movement).toBe('10000000000');
    expect(c.closingPosted).toBe('10000000000');
  });

  it('حسابِ بدون گردش هم ستون خودش را دارد، نه اینکه غایب باشد', async () => {
    // ستونِ غایب در صورت مالی یعنی «این حساب وجود ندارد»، نه «صفر است»
    const st = await equityStatement(gl, YEAR);
    expect(st.columns.map((c: any) => c.code)).toContain('3103');
    expect(col(st, '3103').closingPosted).toBe('0');
  });

  it('ماندهٔ ابتدای دوره شاملِ خودِ روزِ شروع نیست', async () => {
    await entry(D('2026-03-21'), 'آورده در نخستین روز سال', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 5_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 5_000_000_000n },
    ]);
    const st = await equityStatement(gl, YEAR);
    // این سند «گردشِ دوره» است، نه «ماندهٔ ابتدا»
    expect(col(st, '3101').opening).toBe('0');
    expect(col(st, '3101').movement).toBe('5000000000');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('سودِ دوره — تلهٔ دو بار شمردن', () => {
  it('سال باز: سود سطر جداست و در ماندهٔ دفتری نیست', async () => {
    await makeProfit();
    const st = await equityStatement(gl, YEAR);

    expect(st.profit).toBe('400000000');
    expect(st.profitPosted).toBe(false);
    // در دفتر هنوز به انباشته نرفته …
    expect(col(st, '3102').closingPosted).toBe('0');
    // … ولی صورت مالی آن را در حقوق صاحبان سهام می‌آورد
    expect(col(st, '3102').closingEconomic).toBe('400000000');
  });

  it('سال بسته: سود در انباشته هست و دوباره اضافه نمی‌شود', async () => {
    await makeProfit();
    const { closeFiscalYear } = await import('../../src/modules/ledger/year-close');
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    const st = await equityStatement(gl, YEAR);
    expect(st.profitPosted).toBe(true);
    expect(st.profit).toBe('400000000');            // خودِ سود عوض نشده
    expect(col(st, '3102').closingPosted).toBe('400000000');
    // ⚠️ همان ۴۰۰م، نه ۸۰۰م
    expect(col(st, '3102').closingEconomic).toBe('400000000');
  });

  it('حقوق صاحبان سهامِ اقتصادی در هر دو حالت یکی است', async () => {
    await entry(D('2026-04-01'), 'آورده', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 10_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 10_000_000_000n },
    ]);
    await makeProfit();

    const open = await equityStatement(gl, YEAR);
    const { closeFiscalYear } = await import('../../src/modules/ledger/year-close');
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    const closed = await equityStatement(gl, YEAR);

    // این همان چیزی است که کل طراحی برای آن است
    expect(closed.totals.closingEconomic).toBe(open.totals.closingEconomic);
    expect(open.totals.closingEconomic).toBe('10400000000');
  });

  it('گردشِ سطرها سند اختتامیه را نمی‌شمارد', async () => {
    await makeProfit();
    const { closeFiscalYear } = await import('../../src/modules/ledger/year-close');
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    const st = await equityStatement(gl, YEAR);
    expect(col(st, '3102').movement).toBe('0');
    expect(st.movements).toHaveLength(0);
  });

  it('زیان، حقوق صاحبان سهام را پایین می‌آورد', async () => {
    await entry(D('2026-05-10'), 'اجارهٔ بدون درآمد', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 300_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 300_000_000n },
    ]);
    const st = await equityStatement(gl, YEAR);
    expect(st.profit).toBe('-300000000');
    expect(col(st, '3102').closingEconomic).toBe('-300000000');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('اسناد باطل‌شده', () => {
  it('سند باطل‌شده و برگشتی‌اش همدیگر را خنثی می‌کنند', async () => {
    // ⚠️ رگرسیون. نسخهٔ اول `status = 'POSTED'` فیلتر می‌کرد: سندِ اصلی
    // (REVERSED) می‌افتاد ولی آینه‌اش (POSTED) می‌ماند، و یک ماندهٔ منفیِ
    // ساختگی می‌ساخت. روی دادهٔ staging همین یک «سود انباشتهٔ ‎−۲۵۵ میلیاردی»
    // درست کرد که در ترازنامه اثری از آن نبود.
    const e = await entry(D('2026-04-01'), 'آوردهٔ اشتباه', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 3_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 3_000_000_000n },
    ]);
    const { reverse } = await import('../../src/modules/ledger/poster');
    await tx((t) => reverse(t, (e as any).id, { reason: 'اشتباه بود' }));

    const st = await equityStatement(gl, YEAR);
    expect(col(st, '3101').closingPosted).toBe('0');
    expect(col(st, '3101').movement).toBe('0');
  });

  it('سالِ بازگشایی‌شده، «بسته» گزارش نمی‌شود', async () => {
    // سندِ برگشتیِ اختتامیه هم `sourceType = 'YearClose'` دارد؛ شمردنِ صرفِ
    // منبع، سالِ باز را بسته نشان می‌داد و سود دوره از صورت مالی می‌افتاد.
    await makeProfit();
    const { closeFiscalYear, reopenFiscalYear } = await import('../../src/modules/ledger/year-close');
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    expect((await equityStatement(gl, YEAR)).profitPosted).toBe(true);

    await tx((t) => reopenFiscalYear(t, { fiscalYearId: fy.id, reason: 'اصلاح' }));
    const st = await equityStatement(gl, YEAR);
    expect(st.profitPosted).toBe(false);
    // و سود دوباره سطر جدای خودش را دارد، نه اینکه گم شود
    expect(col(st, '3102').closingEconomic).toBe('400000000');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ریزِ گردش‌ها', () => {
  it('هر سند یک سطر است، با اثرش روی هر ستون', async () => {
    await entry(D('2026-04-01'), 'آوردهٔ نقدی', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 10_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 10_000_000_000n },
    ]);
    const st = await equityStatement(gl, YEAR);
    expect(st.movements).toHaveLength(1);
    expect(st.movements[0].description).toBe('آوردهٔ نقدی');
    expect(st.movements[0].byAccount['3101']).toBe('10000000000');
  });

  it('انتقال بین دو حساب حقوق صاحبان سهام، جمعش صفر است ولی حذف نمی‌شود', async () => {
    // انباشته ← اندوختهٔ قانونی: خودِ جابه‌جایی خبر است
    await entry(D('2026-04-01'), 'آورده', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000_000n },
      { accountId: retained.id, currencyCode: 'IRR', credit: 1_000_000_000n },
    ]);
    await entry(D('2027-01-01'), 'انتقال به اندوختهٔ قانونی', [
      { accountId: retained.id, currencyCode: 'IRR', debit: 50_000_000n },
      { accountId: reserve.id, currencyCode: 'IRR', credit: 50_000_000n },
    ]);

    const st = await equityStatement(gl, YEAR);
    const move = st.movements.find((m: any) => m.description.includes('اندوخته'))!;
    expect(move.total).toBe('0');
    expect(move.byAccount['3102']).toBe('-50000000');
    expect(move.byAccount['3103']).toBe('50000000');
    // و جمعِ کل دست‌نخورده مانده
    expect(col(st, '3103').closingPosted).toBe('50000000');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('اندوختهٔ قانونی — مادهٔ ۱۴۰', () => {
  const setCapital = (amount: bigint) =>
    entry(D('2026-03-25'), 'سرمایه', [
      { accountId: cash.id, currencyCode: 'IRR', debit: amount },
      { accountId: capital.id, currencyCode: 'IRR', credit: amount },
    ]);

  it('پنج درصد سود خالص پیشنهاد می‌شود', async () => {
    await setCapital(100_000_000_000n);   // سقف: ۱۰ میلیارد
    await makeProfit();                    // سود ۴۰۰م ⇒ پنج درصد = ۲۰م
    const r = await legalReserveSuggestion(gl, YEAR);
    expect(r.suggested).toBe('20000000');
    expect(r.reason).toMatch(/مادهٔ ۱۴۰/);
  });

  it('از سقفِ ده درصد سرمایه فراتر نمی‌رود', async () => {
    await setCapital(1_000_000_000n);      // سقف: ۱۰۰م
    await entry(D('2026-04-01'), 'اندوختهٔ موجود', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 90_000_000n },
      { accountId: reserve.id, currencyCode: 'IRR', credit: 90_000_000n },
    ]);
    await makeProfit();                    // پنج درصد = ۲۰م، ولی فقط ۱۰م جا هست
    const r = await legalReserveSuggestion(gl, YEAR);
    expect(r.headroom).toBe('10000000');
    expect(r.suggested).toBe('10000000');
    expect(r.reason).toMatch(/سقفِ ده درصد/);
  });

  it('اندوختهٔ پُر ⇒ پیشنهاد صفر', async () => {
    await setCapital(1_000_000_000n);
    await entry(D('2026-04-01'), 'اندوختهٔ کامل', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 100_000_000n },
      { accountId: reserve.id, currencyCode: 'IRR', credit: 100_000_000n },
    ]);
    await makeProfit();
    const r = await legalReserveSuggestion(gl, YEAR);
    expect(r.suggested).toBe('0');
    expect(r.reason).toMatch(/به سقف/);
  });

  it('سالِ زیان‌ده ⇒ اندوخته برداشت نمی‌شود', async () => {
    await setCapital(100_000_000_000n);
    await entry(D('2026-05-10'), 'زیان', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 300_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 300_000_000n },
    ]);
    const r = await legalReserveSuggestion(gl, YEAR);
    expect(r.suggested).toBe('0');
    expect(r.reason).toMatch(/زیان‌ده/);
  });
});
