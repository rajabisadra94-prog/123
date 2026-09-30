/**
 * نسبت‌های مالی و ترازنامهٔ مقایسه‌ای — ممیزی سوم، ب۱۱ و ب۱۲.
 *
 * اعداد عمداً گِرد انتخاب شده‌اند تا نسبت‌ها دستی قابل بازحساب باشند.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D,
  FY_START, FY_END, resetBusinessData,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { balanceSheet, financialRatios } from '../../src/modules/ledger/reports/statements';
import { ensureSubsidiary } from '../../src/modules/ledger/subsidiary';

let fy: any, cash: any, capital: any, sales: any, cogs: any, ar: any, ap: any, rent: any;
let customer: any, supplier: any;
const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); capital = await accountByCode('3101');
  sales = await accountByCode('4101'); cogs = await accountByCode('5101');
  ar = await accountByCode('1104'); ap = await accountByCode('2101');
  rent = await accountByCode('6202');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl(); await resetBusinessData();
  await gl.customer.deleteMany({});
  fy = await makeFiscalYear();
  const c = await gl.customer.create({ data: { name: 'مشتری نسبت', shortCode: 'RT1' } });
  customer = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
  const s = await gl.supplier.create({ data: { name: 'تأمین نسبت' } });
  supplier = await tx((t) => ensureSubsidiary(t, 'SUPPLIER', 'Supplier', s.id, s.name));
});

/**
 * دفترِ نمونه با اعداد گِرد:
 *   نقد ۱٬۴۰۰م (۹۰۰ آورده + ۶۰۰ فروش نقدی − ۱۰۰ اجاره) · دریافتنی ۶۰۰م
 *   ⇒ دارایی جاری ۲٬۰۰۰م · بدهی جاری ۵۰۰م
 *   فروش ۱٬۲۰۰م · بهای تمام‌شده ۵۰۰م · اجاره ۱۰۰م
 */
async function sample() {
  await entry(D('2026-04-01'), 'آورده', [
    { accountId: cash.id, currencyCode: 'IRR', debit: 900_000_000n },
    { accountId: capital.id, currencyCode: 'IRR', credit: 900_000_000n },
  ]);
  await entry(D('2026-05-01'), 'فروش نقدی', [
    { accountId: cash.id, currencyCode: 'IRR', debit: 600_000_000n },
    { accountId: sales.id, currencyCode: 'IRR', credit: 600_000_000n },
  ]);
  await entry(D('2026-05-02'), 'فروش نسیه', [
    { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: 600_000_000n },
    { accountId: sales.id, currencyCode: 'IRR', credit: 600_000_000n },
  ]);
  await entry(D('2026-05-03'), 'خرید نسیه', [
    { accountId: cogs.id, currencyCode: 'IRR', debit: 500_000_000n },
    { accountId: ap.id, subsidiaryId: supplier.id, currencyCode: 'IRR', credit: 500_000_000n },
  ]);
  await entry(D('2026-05-04'), 'اجاره', [
    { accountId: rent.id, currencyCode: 'IRR', debit: 100_000_000n },
    { accountId: cash.id, currencyCode: 'IRR', credit: 100_000_000n },
  ]);
}

// ═══════════════════════════════════════════════════════════════
describe('ب۱۱ — نسبت‌های مالی', () => {
  it('نسبت‌های نقدینگی درست محاسبه می‌شوند', async () => {
    await sample();
    const r = await financialRatios(gl, { from: FY_START, to: FY_END });
    // نقد ۱٬۴۰۰م (۹۰۰ + ۶۰۰ − ۱۰۰) + دریافتنی ۶۰۰م = دارایی جاری ۲٬۰۰۰م
    // ÷ بدهی جاری ۵۰۰م = ۴٫۰
    expect(r.liquidity.currentRatio).toBe('4.0000');
    // بدون موجودی کالا، نسبت آنی همان نسبت جاری است
    expect(r.liquidity.quickRatio).toBe('4.0000');
    expect(r.liquidity.workingCapital).toBe('1500000000');
    // حساب ۱۱۰۶ در چارتِ پیش‌فرض فعال است ولی سندی نگرفته ⇒ حالتِ هشدار
    expect(r.inventory).toEqual({ applicable: true, posted: false });
  });

  /**
   * تفاوتِ «موجودی صفر است» با «موجودی را ثبت نمی‌کنیم».
   *
   * اولی یعنی کالا تمام شده، دومی یعنی نسبت آنی بی‌معنی است. ماندهٔ صفر
   * هر دو را یک‌شکل نشان می‌دهد، پس از خودِ ردیف‌های دفتر می‌پرسیم.
   */
  it('موجودیِ خریده و کاملاً فروخته‌شده، «ثبت‌شده» حساب می‌شود هرچند مانده صفر است', async () => {
    await sample();
    const inv = await accountByCode('1106');
    await entry(D('2026-05-05'), 'خرید کالا', [
      { accountId: inv.id, currencyCode: 'IRR', debit: 200_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 200_000_000n },
    ]);
    let r = await financialRatios(gl, { from: FY_START, to: FY_END });
    expect(r.inventory.posted).toBe(true);
    // دارایی جاری ۲٬۰۰۰م بدون تغییر (نقد ↓۲۰۰ و موجودی ↑۲۰۰)
    expect(r.liquidity.currentRatio).toBe('4.0000');
    // ولی نسبت آنی حالا واقعاً کمتر است: ۱٬۸۰۰ ÷ ۵۰۰ = ۳٫۶
    expect(r.liquidity.quickRatio).toBe('3.6000');

    // کالا فروخته می‌شود؛ مانده صفر، ولی دفتر ردش را دارد
    await entry(D('2026-05-06'), 'فروش کالا', [
      { accountId: cogs.id, currencyCode: 'IRR', debit: 200_000_000n },
      { accountId: inv.id, currencyCode: 'IRR', credit: 200_000_000n },
    ]);
    r = await financialRatios(gl, { from: FY_START, to: FY_END });
    expect(r.inventory.posted).toBe(true);
    expect(r.liquidity.quickRatio).toBe(r.liquidity.currentRatio);
  });

  /**
   * شرکت خدماتی: حساب موجودی کالا غیرفعال است.
   *
   * تساویِ نسبت آنی با نسبت جاری این‌جا **درست** است، نه یک خلأ — و هشدار
   * دادن درباره‌اش یعنی هشداری که هر بار دیده می‌شود و هیچ‌وقت کاری برایش
   * نمی‌شود کرد. چنین هشداری بقیهٔ هشدارها را هم بی‌اثر می‌کند.
   */
  it('با حساب ۱۱۰۶ غیرفعال، موجودی کالا اصلاً موضوع نیست', async () => {
    await sample();
    await gl.glAccount.update({ where: { code: '1106' }, data: { isActive: false } });
    const r = await financialRatios(gl, { from: FY_START, to: FY_END });
    expect(r.inventory).toEqual({ applicable: false, posted: false });
    expect(r.liquidity.quickRatio).toBe(r.liquidity.currentRatio);
  });

  it('حاشیه‌های سود درست محاسبه می‌شوند', async () => {
    await sample();
    const r = await financialRatios(gl, { from: FY_START, to: FY_END });
    // فروش ۱٬۲۰۰م − بهای ۵۰۰م = سود ناخالص ۷۰۰م ⇒ حاشیه ۰٫۵۸۳۳
    expect(r.profitability.grossMargin).toBe('0.5833');
    // سود عملیاتی = ۷۰۰م − اجاره ۱۰۰م = ۶۰۰م ⇒ ۰٫۵
    expect(r.profitability.operatingMargin).toBe('0.5000');
    expect(r.profitability.netMargin).toBe('0.5000');
  });

  it('گردش مطالبات و دورهٔ وصول', async () => {
    await sample();
    const r = await financialRatios(gl, { from: FY_START, to: FY_END });
    // فروش ۱٬۲۰۰م ÷ دریافتنی ۶۰۰م = ۲ بار
    expect(r.activity.receivableTurnover).toBe('2.0000');
    // ۳۶۵ ÷ ۲ = ۱۸۲٫۵ روز
    expect(r.activity.daysSalesOutstanding).toBe('182.5000');
  });

  it('اهرم مالی', async () => {
    await sample();
    const r = await financialRatios(gl, { from: FY_START, to: FY_END });
    // بدهی ۵۰۰م ÷ دارایی ۲٬۰۰۰م
    expect(r.leverage.debtToAssets).toBe('0.2500');
  });

  it('مخرجِ صفر ⇒ null، نه صفر — «محاسبه‌نشدنی» با «صفر» فرق دارد', async () => {
    await entry(D('2026-04-01'), 'فقط آورده', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 100_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 100_000_000n },
    ]);
    const r = await financialRatios(gl, { from: FY_START, to: FY_END });
    expect(r.liquidity.currentRatio).toBeNull();      // بدهی جاری صفر
    expect(r.profitability.grossMargin).toBeNull();   // فروش صفر
    expect(r.activity.receivableTurnover).toBeNull(); // دریافتنی صفر
  });

  it('ورودی‌های محاسبه برگردانده می‌شوند تا عدد قابل ردیابی باشد', async () => {
    await sample();
    const r = await financialRatios(gl, { from: FY_START, to: FY_END });
    expect(r.inputs.currentAssets).toBe('2000000000');
    expect(r.inputs.currentLiabilities).toBe('500000000');
    expect(r.inputs.revenue).toBe('1200000000');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ب۱۲ — ترازنامهٔ مقایسه‌ای', () => {
  it('ستون دورهٔ قبل پیش‌فرض می‌آید', async () => {
    await sample();
    const bs: any = await balanceSheet(gl, FY_END);
    expect(bs.comparison).toBeDefined();
    expect(bs.compareAsOf).toBeDefined();
    // یک سال پیش از پایان سال مالی، هنوز هیچ سندی نبوده
    expect(bs.comparison.totals.assets).toBe(0n);
  });

  it('هر سطر ماندهٔ دورهٔ قبلِ خودش را دارد', async () => {
    await sample();
    // ترازنامه در پایان مرداد، با مقایسه نسبت به اول اردیبهشت
    const bs: any = await balanceSheet(gl, D('2026-05-31'), { compareAsOf: D('2026-04-30') });
    const cashRow = bs.assets.find((a: any) => a.code === '110101');
    expect(BigInt(cashRow.amount)).toBe(1_400_000_000n);   // ۹۰۰ + ۶۰۰ − ۱۰۰
    expect(BigInt(cashRow.prior)).toBe(900_000_000n);      // فقط آورده
  });

  it('compare=false ستون مقایسه را حذف می‌کند', async () => {
    await sample();
    const bs: any = await balanceSheet(gl, FY_END, { compare: false });
    expect(bs.comparison).toBeUndefined();
  });

  it('مقایسه، خودِ اعداد دورهٔ اصلی را دست نمی‌زند', async () => {
    await sample();
    const withCmp: any = await balanceSheet(gl, FY_END);
    const without: any = await balanceSheet(gl, FY_END, { compare: false });
    expect(withCmp.totals).toEqual(without.totals);
    expect(withCmp.balanced).toBe(true);
  });
});
