/**
 * ممیزی دوم — موارد ن۴ تا ن۹ (باگ‌های غیربحرانی).
 *
 * ن۴ فیلتر مرکز هزینه · ن۷ `cashAmount` نادیده‌گرفته‌شده · ن۸ سرریز مبلغ ·
 * ن۹ نخستین نرخِ هر ارز بی‌گارد.
 *
 * (ن۵ پرچم `draft` و ن۶ ردِ پای عملیات انجام‌نشده در سطح مسیر HTTP اند و
 *  اینجا در سطح واحد سنجیده نمی‌شوند؛ توضیح در انتهای فایل.)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, makeCostCenter, accountByCode,
  D, FY_START, FY_END, resetBusinessData, expectRejects,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { incomeStatement } from '../../src/modules/ledger/reports/statements';
import { checkRateOutlier } from '../../src/modules/ledger/fx';
import { parseAmount, MAX_MINOR } from '../../src/modules/ledger/money';
import { doSettlement } from '../../src/modules/ledger/ops';
import { ensureSubsidiary } from '../../src/modules/ledger/subsidiary';

let fy: any, cash: any, capital: any, sales: any, cogs: any, salary: any;
const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); capital = await accountByCode('3101');
  sales = await accountByCode('4101'); cogs = await accountByCode('5101');
  salary = await accountByCode('6101');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await resetGl(); await resetBusinessData();
  await gl.customer.deleteMany({});
  await gl.glExchangeRate.deleteMany({});
  fy = await makeFiscalYear();
});

// ═══════════════════════════════════════════════════════════════
describe('ن۴ — فیلتر مرکز هزینه واقعاً فیلتر می‌کند', () => {
  async function twoCentres() {
    const prod = await makeCostCenter('91', 'تولید');
    const admin = await makeCostCenter('92', 'اداری');
    // درآمد بی‌مرکز (همان چیزی که در عمل اکثر ردیف‌ها هستند)
    await entry(D('2026-05-01'), 'فروش', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 900_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 900_000_000n },
    ]);
    await entry(D('2026-05-02'), 'حقوق تولید', [
      { accountId: salary.id, costCenterId: prod.id, currencyCode: 'IRR', debit: 300_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 300_000_000n },
    ]);
    await entry(D('2026-05-03'), 'حقوق اداری', [
      { accountId: salary.id, costCenterId: admin.id, currencyCode: 'IRR', debit: 100_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 100_000_000n },
    ]);
    return { prod, admin };
  }

  it('هر مرکز فقط سهم خودش را می‌بیند — نه کلِ شرکت', async () => {
    const { prod, admin } = await twoCentres();
    const range = { from: FY_START, to: FY_END };

    const all = await incomeStatement(gl, range);
    const p: any = await incomeStatement(gl, { ...range, costCenterIds: [prod.id] });
    const a: any = await incomeStatement(gl, { ...range, costCenterIds: [admin.id] });

    expect(all.totals.admin).toBe(400_000_000n);
    expect(p.totals.admin).toBe(300_000_000n);
    expect(a.totals.admin).toBe(100_000_000n);
    // و مهم‌تر: دو مرکز نباید عددِ یکسان بدهند (باگِ قبلی دقیقاً همین بود)
    expect(p.totals.admin).not.toBe(a.totals.admin);
  });

  it('درآمدِ بی‌مرکز به هیچ مرکزی چسبانده نمی‌شود', async () => {
    const { prod } = await twoCentres();
    const p: any = await incomeStatement(gl, { from: FY_START, to: FY_END, costCenterIds: [prod.id] });
    expect(p.totals.revenue).toBe(0n);
  });

  it('سهمِ تخصیص‌نیافته صریحاً گزارش می‌شود تا گزارشِ جزئی گمراه نکند', async () => {
    const { prod } = await twoCentres();
    const p: any = await incomeStatement(gl, { from: FY_START, to: FY_END, costCenterIds: [prod.id] });
    expect(p.unallocated).toBeDefined();
    expect(p.unallocated.revenue).toBe(900_000_000n);
    expect(p.unallocated.admin).toBe(0n);
  });

  it('بدون فیلتر، `unallocated` اصلاً نمی‌آید و همه‌چیز شمرده می‌شود', async () => {
    await twoCentres();
    const all: any = await incomeStatement(gl, { from: FY_START, to: FY_END });
    expect(all.unallocated).toBeUndefined();
    expect(all.totals.revenue).toBe(900_000_000n);
  });

  it('چند مرکز با هم جمع می‌شوند', async () => {
    const { prod, admin } = await twoCentres();
    const both: any = await incomeStatement(gl, {
      from: FY_START, to: FY_END, costCenterIds: [prod.id, admin.id],
    });
    expect(both.totals.admin).toBe(400_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ن۸ — سقف مبلغ', () => {
  it('مبلغِ فراتر از سقفِ int8 خطای فارسی می‌دهد، نه dump داخلی', () => {
    expect(() => parseAmount('99999999999999999999', 0)).toThrow(/حد مجاز/);
  });

  it('دقیقاً روی سقف پذیرفته است', () => {
    expect(parseAmount(MAX_MINOR.toString(), 0)).toBe(MAX_MINOR);
  });

  it('منفیِ فراتر از سقف هم رد می‌شود', () => {
    expect(() => parseAmount('-99999999999999999999', 0)).toThrow(/حد مجاز/);
  });

  it('اعشار هم در سقف حساب می‌شود', () => {
    // با ۲ رقم اعشار، ۱۰¹⁷ واحد ⇒ ۱۰¹⁹ در کوچک‌ترین واحد ⇒ فراتر از سقف
    expect(() => parseAmount('100000000000000000', 2)).toThrow(/حد مجاز/);
  });

  it('خطا از نوع دامنه است تا errorHandler آن را ۴۰۰ کند، نه ۵۰۰', () => {
    // errorHandler با **نام کلاس** تصمیم می‌گیرد؛ اگر این نام عوض شود یا کلاس
    // ساده‌ای بیرون از فهرست دامنه پرتاب شود، کاربر دوباره ۵۰۰ می‌گیرد.
    try {
      parseAmount('99999999999999999999', 0);
      throw new Error('باید پرتاب می‌کرد');
    } catch (e: any) {
      expect(e.constructor.name).toBe('AmountError');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ن۹ — نخستین نرخِ هر ارز بی‌گارد نیست', () => {
  it('نخستین نرخ تأیید صریح می‌خواهد', async () => {
    const c = await checkRateOutlier(gl, 'USD', 'IRR', '2100000', D('2026-06-01'));
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('FIRST_RATE');
    expect(c.last).toBeNull();
  });

  it('پس از ثبتِ نخستین نرخ، نرخِ نزدیک بدون تأیید می‌گذرد', async () => {
    await gl.glExchangeRate.create({
      data: { from: 'USD', to: 'IRR', date: D('2026-06-01'), rate: '2000000', source: 'MANUAL' },
    });
    const c = await checkRateOutlier(gl, 'USD', 'IRR', '2100000', D('2026-06-02'));
    expect(c.ok).toBe(true);
    expect(c.reason).toBeNull();
  });

  it('نرخِ بیرون از بازهٔ مطلق خطاست — با تأیید هم نمی‌شود ثبتش کرد', async () => {
    await expectRejects(
      () => checkRateOutlier(gl, 'USD', 'IRR', '1e20', D('2026-06-01')),
      /بازهٔ معقول/,
    );
    await expectRejects(
      () => checkRateOutlier(gl, 'USD', 'IRR', '0.0000001', D('2026-06-01')),
      /بازهٔ معقول/,
    );
  });

  it('انحرافِ بزرگ، دلیلش OUTLIER است نه FIRST_RATE', async () => {
    await gl.glExchangeRate.create({
      data: { from: 'USD', to: 'IRR', date: D('2026-06-01'), rate: '2000000', source: 'MANUAL' },
    });
    const c = await checkRateOutlier(gl, 'USD', 'IRR', '6000000', D('2026-06-02'));
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('OUTLIER');
    expect(c.last?.rate).toBe('2000000');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ن۷ — مبلغ نقدِ ناسازگار در تسویهٔ هم‌ارز', () => {
  let customer: any;
  beforeEach(async () => {
    const c = await gl.customer.create({ data: { name: 'مشتری ن۷', shortCode: 'N7' } });
    customer = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
    const ar = await accountByCode('1104');
    await entry(D('2026-05-01'), 'فاکتور', [
      { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: 500_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 500_000_000n },
    ]);
  });

  it('مبلغ نقدِ متفاوت در تسویهٔ هم‌ارز، بی‌صدا دور ریخته نمی‌شود', async () => {
    await expectRejects(
      () => tx((t) => doSettlement(t, {
        fiscalYearId: fy.id, date: D('2026-06-01'), direction: 'RECEIPT',
        subsidiaryId: customer.id, currency: 'IRR', amount: '500000000',
        cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: '499000000',
      })),
      /مبلغ نقد باید برابر مبلغ تعهد باشد/,
    );
  });

  it('مبلغ نقدِ برابر پذیرفته است', async () => {
    const e: any = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: D('2026-06-01'), direction: 'RECEIPT',
      subsidiaryId: customer.id, currency: 'IRR', amount: '500000000',
      cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: '500000000',
    }));
    expect(e.lines.length).toBeGreaterThanOrEqual(2);
  });

  it('بدون cashAmount هم مثل قبل کار می‌کند', async () => {
    const e: any = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: D('2026-06-01'), direction: 'RECEIPT',
      subsidiaryId: customer.id, currency: 'IRR', amount: '500000000',
      cashAccountCode: '110101',
    }));
    expect(e.lines.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ن۴ — مالیات بر درآمد هم فیلتر مرکز هزینه را رعایت می‌کند', () => {
  it('مالیاتِ بی‌مرکز، زیر هر مرکز تکرار نمی‌شود', async () => {
    // با سخت‌گیر شدن فیلتر (ن۴)، کوئریِ جداگانهٔ حساب ۸۲۰۵ جا مانده بود و
    // ۵ میلیارد مالیات زیر «تولید»، «فروش» و «اداری» — هر سه — دیده می‌شد.
    const cc = await makeCostCenter('93', 'مرکز مالیاتی')
    const tax = await accountByCode('8205')
    const prov = await accountByCode('2112')
    await entry(D('2026-06-01'), 'ذخیرهٔ مالیات', [
      { accountId: tax.id, currencyCode: 'IRR', debit: 900_000_000n },
      { accountId: prov.id, currencyCode: 'IRR', credit: 900_000_000n },
    ])

    const all = await incomeStatement(gl, { from: FY_START, to: FY_END })
    expect(all.totals.taxExpense).toBe(900_000_000n)

    const filtered: any = await incomeStatement(gl, {
      from: FY_START, to: FY_END, costCenterIds: [cc.id],
    })
    expect(filtered.totals.taxExpense).toBe(0n)
    expect(filtered.unallocated.taxExpense).toBe(900_000_000n)
  })
})
