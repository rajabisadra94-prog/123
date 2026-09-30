/**
 * بودجه و مقایسه با عملکرد — ممیزی سوم، ب۲.
 *
 * حساس‌ترین بخش، **علامتِ انحراف** است: برای هزینه کمتر خرج کردن مطلوب است و
 * برای درآمد بیشتر فروختن. یک ستون خامِ «عملکرد − بودجه» هر دو را یک‌جور نشان
 * می‌دهد و خواننده را گمراه می‌کند.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, makeCostCenter, accountByCode,
  D, resetBusinessData, expectRejects,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { upsertBudget, budgetVsActual, listBudgets, deleteBudget } from '../../src/modules/ledger/budget';

let fy: any, cash: any, sales: any, rent: any, capital: any;
const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

/** ۱۲ ماه با مبلغ یکسان */
const flat = (per: bigint) => Array.from({ length: 12 }, () => per);

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
  rent = await accountByCode('6202'); capital = await accountByCode('3101');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await gl.glBudget.deleteMany({});
  await resetGl(); await resetBusinessData();
  fy = await makeFiscalYear();
});

// ═══════════════════════════════════════════════════════════════
describe('ثبت بودجه', () => {
  it('بودجهٔ ماهانه ذخیره و جمع سالانه‌اش محاسبه می‌شود', async () => {
    await tx((t) => upsertBudget(t, {
      fiscalYearId: fy.id, accountCode: '6202', months: flat(100_000_000n),
    }));
    const rows = await listBudgets(gl, fy.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].annual).toBe('1200000000');
    expect(rows[0].months).toHaveLength(12);
  });

  it('ثبت دوباره روی همان حساب، جایگزین می‌شود نه تکراری', async () => {
    for (const per of [100_000_000n, 250_000_000n]) {
      await tx((t) => upsertBudget(t, { fiscalYearId: fy.id, accountCode: '6202', months: flat(per) }));
    }
    const rows = await listBudgets(gl, fy.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].annual).toBe('3000000000');
  });

  it('بودجه به تفکیک مرکز هزینه، ردیف جدا می‌گیرد', async () => {
    const cc = await makeCostCenter('81', 'واحد الف');
    await tx((t) => upsertBudget(t, { fiscalYearId: fy.id, accountCode: '6202', months: flat(100_000_000n) }));
    await tx((t) => upsertBudget(t, {
      fiscalYearId: fy.id, accountCode: '6202', costCenterCode: cc.code, months: flat(50_000_000n),
    }));
    expect(await listBudgets(gl, fy.id)).toHaveLength(2);
  });

  it('روی حساب سرگروه بودجه گذاشته نمی‌شود', async () => {
    await expectRejects(
      () => tx((t) => upsertBudget(t, { fiscalYearId: fy.id, accountCode: '62', months: flat(1n) })),
      /سرگروه/,
    );
  });

  it('روی حساب ترازنامه‌ای بودجه گذاشته نمی‌شود', async () => {
    await expectRejects(
      () => tx((t) => upsertBudget(t, { fiscalYearId: fy.id, accountCode: '110101', months: flat(1n) })),
      /ترازنامه‌ای/,
    );
  });

  it('کمتر یا بیشتر از ۱۲ ماه رد می‌شود', async () => {
    await expectRejects(
      () => tx((t) => upsertBudget(t, { fiscalYearId: fy.id, accountCode: '6202', months: [1n, 2n] })),
      /12 عدد/,
    );
  });

  it('بودجهٔ منفی رد می‌شود', async () => {
    const bad = flat(100n); bad[3] = -5n;
    await expectRejects(
      () => tx((t) => upsertBudget(t, { fiscalYearId: fy.id, accountCode: '6202', months: bad })),
      /منفی/,
    );
  });

  it('حذف می‌شود', async () => {
    await tx((t) => upsertBudget(t, { fiscalYearId: fy.id, accountCode: '6202', months: flat(1n) }));
    const [row] = await listBudgets(gl, fy.id);
    await tx((t) => deleteBudget(t, row.id));
    expect(await listBudgets(gl, fy.id)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('بودجه در برابر عملکرد', () => {
  it('هزینهٔ کمتر از بودجه ⇒ انحراف مطلوب', async () => {
    await tx((t) => upsertBudget(t, {
      fiscalYearId: fy.id, accountCode: '6202', months: flat(100_000_000n),
    }));
    // اجارهٔ واقعی فروردین: ۸۰م — یعنی ۲۰م کمتر از بودجه
    await entry(D('2026-03-25'), 'اجاره فروردین', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 80_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 80_000_000n },
    ]);

    const v = await budgetVsActual(gl, { fiscalYearId: fy.id, fromMonth: 1, toMonth: 1 });
    const row = v.rows.find((r) => r.accountCode === '6202')!;
    expect(row.budget).toBe('100000000');
    expect(row.actual).toBe('80000000');
    expect(row.variance).toBe('-20000000');
    expect(row.favorable).toBe(true);      // کمتر خرج شد ⇒ مطلوب
    expect(row.variancePct).toBe('-0.2000');
  });

  it('هزینهٔ بیشتر از بودجه ⇒ انحراف نامطلوب', async () => {
    await tx((t) => upsertBudget(t, {
      fiscalYearId: fy.id, accountCode: '6202', months: flat(100_000_000n),
    }));
    await entry(D('2026-03-25'), 'اجاره گران', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 130_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 130_000_000n },
    ]);
    const row = (await budgetVsActual(gl, { fiscalYearId: fy.id, fromMonth: 1, toMonth: 1 }))
      .rows.find((r) => r.accountCode === '6202')!;
    expect(row.variance).toBe('30000000');
    expect(row.favorable).toBe(false);
  });

  it('درآمدِ بیشتر از بودجه ⇒ مطلوب (علامت برعکسِ هزینه)', async () => {
    await tx((t) => upsertBudget(t, {
      fiscalYearId: fy.id, accountCode: '4101', months: flat(500_000_000n),
    }));
    await entry(D('2026-03-25'), 'فروش فروردین', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 700_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 700_000_000n },
    ]);
    const row = (await budgetVsActual(gl, { fiscalYearId: fy.id, fromMonth: 1, toMonth: 1 }))
      .rows.find((r) => r.accountCode === '4101')!;
    // درآمد در دفتر بستانکار است؛ برای مقایسه علامتش برمی‌گردد
    expect(row.actual).toBe('700000000');
    expect(row.variance).toBe('200000000');
    expect(row.favorable).toBe(true);      // بیشتر فروخت ⇒ مطلوب
  });

  it('درآمدِ کمتر از بودجه ⇒ نامطلوب', async () => {
    await tx((t) => upsertBudget(t, {
      fiscalYearId: fy.id, accountCode: '4101', months: flat(500_000_000n),
    }));
    await entry(D('2026-03-25'), 'فروش کم', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 300_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 300_000_000n },
    ]);
    const row = (await budgetVsActual(gl, { fiscalYearId: fy.id, fromMonth: 1, toMonth: 1 }))
      .rows.find((r) => r.accountCode === '4101')!;
    expect(row.variance).toBe('-200000000');
    expect(row.favorable).toBe(false);
  });

  it('بازهٔ ماهانه فقط بودجهٔ همان ماه‌ها را جمع می‌زند', async () => {
    // این دقیقاً دلیلِ ذخیرهٔ ماهانه است: با عدد سالانه، انحرافِ ماه اول
    // همیشه مثبت درمی‌آمد.
    await tx((t) => upsertBudget(t, {
      fiscalYearId: fy.id, accountCode: '6202', months: flat(100_000_000n),
    }));
    const m1 = await budgetVsActual(gl, { fiscalYearId: fy.id, fromMonth: 1, toMonth: 1 });
    const m3 = await budgetVsActual(gl, { fiscalYearId: fy.id, fromMonth: 1, toMonth: 3 });
    const all = await budgetVsActual(gl, { fiscalYearId: fy.id });
    expect(m1.totals.budget).toBe('100000000');
    expect(m3.totals.budget).toBe('300000000');
    expect(all.totals.budget).toBe('1200000000');
  });

  it('بودجهٔ صفر ⇒ درصد انحراف null است، نه بی‌نهایت', async () => {
    const months = flat(0n);
    await tx((t) => upsertBudget(t, { fiscalYearId: fy.id, accountCode: '6202', months }));
    await entry(D('2026-03-25'), 'هزینهٔ بی‌بودجه', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 5_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 5_000_000n },
    ]);
    const row = (await budgetVsActual(gl, { fiscalYearId: fy.id, fromMonth: 1, toMonth: 1 }))
      .rows.find((r) => r.accountCode === '6202')!;
    expect(row.variancePct).toBeNull();
    expect(row.favorable).toBe(false);
  });

  it('سند اختتامیه در عملکرد شمرده نمی‌شود', async () => {
    // وگرنه بستنِ سال، عملکرد هر حساب را صفر نشان می‌داد و همهٔ انحراف‌ها
    // ناگهان «مطلوب» می‌شدند.
    await tx((t) => upsertBudget(t, {
      fiscalYearId: fy.id, accountCode: '6202', months: flat(100_000_000n),
    }));
    await entry(D('2026-03-25'), 'اجاره', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 80_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 80_000_000n },
    ]);
    const before = await budgetVsActual(gl, { fiscalYearId: fy.id });

    const { closeFiscalYear } = await import('../../src/modules/ledger/year-close');
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    const after = await budgetVsActual(gl, { fiscalYearId: fy.id });
    expect(after.totals.actual).toBe(before.totals.actual);
    expect(after.totals.actual).toBe('80000000');
  });
});
