/**
 * ممیزی سوم — باگ‌هایی که با دادهٔ واقعی روی محیط آزمون مچ شدند.
 *
 * ب۱ جداکنندهٔ هزارگان · ب۲ پلاگ تسعیر بی‌سقف · ب۳ نرخ بهای تمام‌شده در تسویه ·
 * ب۴ پلکان مالیات تکراری · ب۵ مغایرت دفتر دارایی ثابت · ب۷ فروش معاف در
 * پایهٔ ارزش افزوده · ب۸ چک‌لیست بستن سال.
 *
 * هر تست عددِ اثبات‌شده روی staging را قفل می‌کند، نه یک مقدار دلخواه.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode,
  D, resetBusinessData, expectRejects, makeSubsidiary,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { parseAmount } from '../../src/modules/ledger/money';
import { doSettlement } from '../../src/modules/ledger/ops';
import { resolveRates, setRate, RATE_KEYS } from '../../src/modules/ledger/payroll/rates';
import { progressiveTax } from '../../src/modules/ledger/payroll/engine';
import { vatReturn } from '../../src/modules/ledger/reports/tax';
import { previewYearClose, closeFiscalYear } from '../../src/modules/ledger/year-close';
import { integrityCheck } from '../../src/modules/ledger/integrity';
import { upsertAsset, postDepreciation } from '../../src/modules/ledger/depreciation';
import { computeProvision } from '../../src/modules/ledger/provision';
import { receiveCheque, transitionCheque } from '../../src/modules/ledger/cheque';

let fy: any, cash: any, usdBank: any, capital: any, sales: any, payable: any, vatOut: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

const rate = (code: string, value: string, date: Date) =>
  gl.glExchangeRate.create({
    data: { from: code, to: 'IRR', rate: value, date, source: 'MANUAL' },
  });

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101');
  capital = await accountByCode('3101');
  sales = await accountByCode('4101');
  payable = await accountByCode('2101');
  vatOut = await accountByCode('2107');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await gl.glDepreciationRun.deleteMany({});
  await gl.glFixedAsset.deleteMany({});
  await resetGl(); await resetBusinessData();
  await gl.glExchangeRate.deleteMany({});
  await gl.glPayrollTaxBracket.deleteMany({});
  await gl.glPayrollRate.deleteMany({});
  fy = await makeFiscalYear();
});

// ═══════════════════════════════════════════════════════════════
describe('ب۱ — جداکنندهٔ هزارگان مبلغ را نابود نمی‌کند', () => {
  /**
   * ⚠️ عددِ اثبات: روی staging ورودی «1,234» ریال با مبلغ **۱** ثبت شد،
   * بدون هیچ خطایی. کاما نگه داشته می‌شد و بعد جداکنندهٔ اعشار خوانده
   * می‌شد؛ ریال صفر رقم اعشار دارد، پس ۱٫۲۳۴ گرد می‌شد به ۱.
   */
  it('کاما جداکنندهٔ هزارگان است، نه اعشار', () => {
    expect(parseAmount('1,234', 0)).toBe(1_234n);
    expect(parseAmount('1,234,567', 0)).toBe(1_234_567n);
    expect(parseAmount('20,000,000,000', 0)).toBe(20_000_000_000n);
  });

  it('ارقام فارسی و عربی پذیرفته می‌شوند', () => {
    expect(parseAmount('۱۲۳۴', 0)).toBe(1_234n);
    expect(parseAmount('١٢٣٤', 0)).toBe(1_234n);
    expect(parseAmount('۱٬۲۳۴٬۵۶۷', 0)).toBe(1_234_567n);
  });

  it('ممیز فارسی «٫» اعشار است', () => {
    expect(parseAmount('۱۲٫۵۰', 2)).toBe(1_250n);
    expect(parseAmount('12.50', 2)).toBe(1_250n);
  });

  it('نقطه هنوز اعشار است و گرد کردن نیم‌به‌بالا سرجایش', () => {
    expect(parseAmount('12.6', 0)).toBe(13n);
    expect(parseAmount('12.4', 0)).toBe(12n);
  });

  it('ورودیِ واقعاً خراب همچنان رد می‌شود', () => {
    expect(() => parseAmount('1e3', 0)).toThrow(/نامعتبر/);
    expect(() => parseAmount('12.3.4', 0)).toThrow(/نامعتبر/);
    expect(() => parseAmount('abc', 0)).toThrow(/نامعتبر/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ب۳ — تسویهٔ ارزی، نقد را به بهای تمام‌شده آزاد می‌کند', () => {
  /**
   * سناریوی اثبات‌شده روی staging (اسناد ۴۲ تا ۴۴):
   *   ۱۵٬۰۰۰ دلار به نرخ ۲٬۰۰۰٬۰۰۰ خریداری شد
   *   بدهی ۱۰٬۰۰۰ دلاری هم به همان نرخ ثبت شد
   *   بدهی در نرخ روز ۲٬۱۰۰٬۰۰۰ پرداخت شد
   *
   * موضع کاملاً پوشش‌دار بود ⇒ سود و زیان اقتصادی **صفر**. سیستم قبلی
   * ۱٬۰۰۰٬۰۰۰٬۰۰۰ ریال «زیان تسعیر» می‌ساخت و بهای تمام‌شدهٔ ماندهٔ حساب را
   * از ۲٬۰۰۰٬۰۰۰ به ۱٬۸۰۰٬۰۰۰ خراب می‌کرد.
   */
  async function hedgedPayment() {
    usdBank = cash;
    await rate('USD', '2000000', D('2026-05-01'));
    await rate('USD', '2100000', D('2026-07-01'));

    const supplier = await makeSubsidiary('SUPPLIER', 'تأمین‌کنندهٔ ارزی');

    // ۱۵٬۰۰۰ دلار به نرخ ۲٬۰۰۰٬۰۰۰
    await entry(D('2026-05-01'), 'آوردهٔ ارزی', [
      { accountId: usdBank.id, currencyCode: 'USD', debit: 1_500_000n, rate: '2000000' },
      { accountId: capital.id, currencyCode: 'IRR', credit: 30_000_000_000n },
    ]);
    // بدهی ۱۰٬۰۰۰ دلاری به همان نرخ
    await entry(D('2026-06-01'), 'خرید ارزی', [
      { accountId: (await accountByCode('5101')).id, currencyCode: 'IRR', debit: 20_000_000_000n },
      { accountId: payable.id, subsidiaryId: supplier.id, currencyCode: 'USD', credit: 1_000_000n, rate: '2000000' },
    ]);

    return tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: D('2026-07-01'), direction: 'PAYMENT',
      subsidiaryId: supplier.id, currency: 'USD', amount: '10000',
      cashAccountCode: '110101', dayRate: '2100000',
    }));
  }

  it('موضع پوشش‌دار هیچ سود و زیانی نمی‌سازد', async () => {
    const e: any = await hedgedPayment();
    const codes = await gl.glLine.findMany({
      where: { entryId: e.id }, include: { account: { select: { code: true } } },
    });
    // نه ۸۲۰۱ و نه ۸۱۰۱ نباید در سند باشند
    expect(codes.map((l) => l.account.code).sort()).toEqual(['110101', '2101']);
  });

  it('نرخ ردیف نقد، بهای تمام‌شده است نه نرخ روز', async () => {
    const e: any = await hedgedPayment();
    const cashLine = (await gl.glLine.findMany({
      where: { entryId: e.id, accountId: usdBank.id },
    }))[0];
    expect(cashLine.rate.toString()).toBe('2000000');
    expect(cashLine.creditBase).toBe(20_000_000_000n);
  });

  it('بهای تمام‌شدهٔ ماندهٔ حساب ارزی سالم می‌ماند', async () => {
    await hedgedPayment();
    const lines = await gl.glLine.findMany({ where: { accountId: usdBank.id } });
    const qty = lines.reduce((s, l) => s + l.debit - l.credit, 0n);
    const cost = lines.reduce((s, l) => s + l.debitBase - l.creditBase, 0n);
    expect(qty).toBe(500_000n);                 // ۵٬۰۰۰ دلار
    expect(cost).toBe(10_000_000_000n);         // نه ۹٬۰۰۰٬۰۰۰٬۰۰۰
  });

  it('اگر نرخ خرید و نرخ بدهی فرق کنند، سود واقعی ثبت می‌شود', async () => {
    usdBank = cash;
    await rate('USD', '1800000', D('2026-05-01'));
    await rate('USD', '2100000', D('2026-07-01'));
    const supplier = await makeSubsidiary('SUPPLIER', 'تأمین‌کنندهٔ دوم');

    // دلار ارزان خریده شده: ۱٬۸۰۰٬۰۰۰
    await entry(D('2026-05-01'), 'آوردهٔ ارزی ارزان', [
      { accountId: usdBank.id, currencyCode: 'USD', debit: 1_000_000n, rate: '1800000' },
      { accountId: capital.id, currencyCode: 'IRR', credit: 18_000_000_000n },
    ]);
    // بدهی گران‌تر ثبت شده: ۲٬۰۰۰٬۰۰۰
    await entry(D('2026-06-01'), 'خرید ارزی', [
      { accountId: (await accountByCode('5101')).id, currencyCode: 'IRR', debit: 20_000_000_000n },
      { accountId: payable.id, subsidiaryId: supplier.id, currencyCode: 'USD', credit: 1_000_000n, rate: '2000000' },
    ]);

    const e: any = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: D('2026-07-01'), direction: 'PAYMENT',
      subsidiaryId: supplier.id, currency: 'USD', amount: '10000',
      cashAccountCode: '110101', dayRate: '2100000',
    }));

    const gain = (await gl.glLine.findMany({
      where: { entryId: e.id }, include: { account: { select: { code: true } } },
    })).find((l) => l.account.code === '8101');
    // بدهی ۲۰ میلیارد، دلاری که ۱۸ میلیارد خریده شده ⇒ سود ۲ میلیارد
    expect(gain?.creditBase).toBe(2_000_000_000n);
  });

  it('دریافت ارزی همچنان به نرخ روز وارد می‌شود', async () => {
    const usd = cash;
    const receivable = await accountByCode('1104');
    await rate('USD', '2000000', D('2026-05-01'));
    await rate('USD', '2100000', D('2026-07-01'));
    const customer = await makeSubsidiary('CUSTOMER', 'مشتری ارزی');

    await entry(D('2026-06-01'), 'فروش ارزی', [
      { accountId: receivable.id, subsidiaryId: customer.id, currencyCode: 'USD', debit: 1_000_000n, rate: '2000000' },
      { accountId: sales.id, currencyCode: 'IRR', credit: 20_000_000_000n },
    ]);

    const e: any = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: D('2026-07-01'), direction: 'RECEIPT',
      subsidiaryId: customer.id, currency: 'USD', amount: '10000',
      cashAccountCode: '110101', dayRate: '2100000',
    }));

    const cashLine = (await gl.glLine.findMany({ where: { entryId: e.id, accountId: usd.id } }))[0];
    expect(cashLine.rate.toString()).toBe('2100000');   // ورودی = نرخ روز
    const gain = (await gl.glLine.findMany({
      where: { entryId: e.id }, include: { account: { select: { code: true } } },
    })).find((l) => l.account.code === '8101');
    expect(gain?.creditBase).toBe(1_000_000_000n);      // طلب گران شده ⇒ سود واقعی
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ب۲ — پلاگ تسعیر سقف تناسب دارد', () => {
  async function owedHundredDollars() {
    await rate('USD', '2000000', D('2026-06-01'));
    const supplier = await makeSubsidiary('SUPPLIER', 'تأمین‌کنندهٔ خرد');
    await entry(D('2026-06-01'), 'بدهی خرد ارزی', [
      { accountId: (await accountByCode('6213')).id, currencyCode: 'IRR', debit: 200_000_000n },
      { accountId: payable.id, subsidiaryId: supplier.id, currencyCode: 'USD', credit: 10_000n, rate: '2000000' },
    ]);
    // صندوق را پر می‌کنیم تا پرداخت ریالی ممکن باشد
    await entry(D('2026-05-01'), 'آوردهٔ ریالی', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 5_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 5_000_000_000n },
    ]);
    return supplier;
  }

  /**
   * ⚠️ سند ۴۶ روی staging: بدهی ۱۰۰ دلاری (۲۰۰٬۰۰۰٬۰۰۰ ریال) با پرداخت
   * ۹۰۰٬۰۰۰٬۰۰۰ ریالی تسویه شد و ۷۰۰٬۰۰۰٬۰۰۰ «زیان تسعیر» ثبت شد —
   * نرخ ضمنی ۹٬۰۰۰٬۰۰۰ در برابر نرخ روز ۲٬۰۰۰٬۰۰۰.
   */
  it('پرداخت ریالیِ نامتناسب رد می‌شود', async () => {
    const supplier = await owedHundredDollars();
    await expectRejects(
      () => tx((t) => doSettlement(t, {
        fiscalYearId: fy.id, date: D('2026-06-02'), direction: 'PAYMENT',
        subsidiaryId: supplier.id, currency: 'USD', amount: '100',
        cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: '900000000',
      })),
      /نمی‌خواند/,
    );
  });

  it('اختلاف کوچک (کارمزد و نوسان نرخ) همچنان می‌گذرد', async () => {
    const supplier = await owedHundredDollars();
    // ۲۱۰٬۰۰۰٬۰۰۰ در برابر ۲۰۰٬۰۰۰٬۰۰۰ ⇒ ۵٪ اختلاف
    const e: any = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: D('2026-06-02'), direction: 'PAYMENT',
      subsidiaryId: supplier.id, currency: 'USD', amount: '100',
      cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: '210000000',
    }));
    const loss = (await gl.glLine.findMany({
      where: { entryId: e.id }, include: { account: { select: { code: true } } },
    })).find((l) => l.account.code === '8201');
    expect(loss?.debitBase).toBe(10_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ب۴ — پلکان مالیات تکراری، مالیات را دو برابر نمی‌کند', () => {
  /** مقادیر نرخ فقط برای اینکه `resolveRates` به پلکان برسد — عددشان مهم نیست */
  const seedRateValues = () => tx(async (t) => {
    const dummy: Record<string, number> = {
      MIN_WAGE_DAILY: 2_000_000, HOUSING_MONTHLY: 9_000_000, FOOD_MONTHLY: 14_000_000,
      CHILD_PER_CHILD: 6_000_000, SENIORITY_DAILY: 70_000, INSURANCE_EMPLOYEE: 0.07,
      INSURANCE_EMPLOYER: 0.2, UNEMPLOYMENT: 0.03, INSURANCE_CEILING: 0,
      OVERTIME_FACTOR: 1.4, NIGHT_FACTOR: 0.35, HOLIDAY_FACTOR: 1.4,
      TAX_EXEMPTION_MONTHLY: 100_000_000, BONUS_ACCRUAL_FACTOR: 2 / 12,
      SEVERANCE_DAYS_PER_MONTH: 2.5, LEAVE_DAYS_PER_MONTH: 2.5,
      MONTH_DAYS: 30, MONTH_HOURS: 220,
    };
    for (const key of Object.values(RATE_KEYS)) {
      await setRate(t, { key, value: dummy[key], validFrom: D('2026-03-21') });
    }
  });

  beforeEach(seedRateValues);

  const bracketSet = (validFrom: Date) => ([
    { fromAmount: 0n, toAmount: 1_000_000_000n, rate: '0.10', validFrom },
    { fromAmount: 1_000_000_000n, toAmount: 3_000_000_000n, rate: '0.15', validFrom },
    { fromAmount: 3_000_000_000n, toAmount: null, rate: '0.20', validFrom },
  ]);

  it('دو مجموعهٔ یکسان ⇒ فقط یکی به‌کار می‌رود', async () => {
    const from = D('2026-03-21');
    await gl.glPayrollTaxBracket.createMany({ data: bracketSet(from) as any });
    await gl.glPayrollTaxBracket.createMany({ data: bracketSet(from) as any });
    expect(await gl.glPayrollTaxBracket.count()).toBe(6);

    const r = await resolveRates(gl as any, D('2026-06-01'));
    expect(r.brackets.length).toBe(3);
    // ⚠️ عددِ اثبات‌شده روی staging: مبنای ۷۹۰٬۰۰۰٬۰۰۰ باید ۷۹٬۰۰۰٬۰۰۰ بدهد،
    // نه ۱۵۸٬۰۰۰٬۰۰۰ که سیستمِ باگ‌دار می‌داد.
    expect(progressiveTax(790_000_000n, r.brackets)).toBe(79_000_000n);
  });

  it('نسخهٔ تازه‌تر برندهٔ نسخهٔ قدیمی است', async () => {
    await gl.glPayrollTaxBracket.createMany({ data: bracketSet(D('2025-03-21')) as any });
    await gl.glPayrollTaxBracket.createMany({
      data: [{ fromAmount: 0n, toAmount: null, rate: '0.05', validFrom: D('2026-03-21') }] as any,
    });
    const r = await resolveRates(gl as any, D('2026-06-01'));
    expect(r.brackets.length).toBe(1);
    expect(progressiveTax(1_000_000_000n, r.brackets)).toBe(50_000_000n);
  });

  it('بازه‌های هم‌پوشانِ یک نسخه، خطای صریح می‌دهند', async () => {
    const from = D('2026-03-21');
    await gl.glPayrollTaxBracket.createMany({
      data: [
        { fromAmount: 0n, toAmount: 2_000_000_000n, rate: '0.10', validFrom: from },
        { fromAmount: 1_000_000_000n, toAmount: null, rate: '0.15', validFrom: from },
      ] as any,
    });
    await expectRejects(() => resolveRates(gl as any, D('2026-06-01')), /هم‌پوشانی/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ب۷ — فروش معاف در پایهٔ ارزش افزوده نمی‌آید', () => {
  /**
   * ⚠️ سند ۵۴ روی staging: یک سند با فروش داخلیِ مشمولِ ۱ میلیارد،
   * فروش صادراتیِ معافِ ۵ میلیارد، و ارزش افزودهٔ ۱۰۰ میلیون.
   * پایهٔ اعلامی ۶ میلیارد بالا می‌رفت ⇒ نرخ ضمنیِ غیرممکنِ ۵٫۸٪.
   */
  it('فقط بخش مشمول در پایه می‌آید', async () => {
    const receivable = await accountByCode('1104');
    const customer = await makeSubsidiary('CUSTOMER', 'مشتری صادراتی');

    await entry(D('2026-07-15'), 'فروش داخلی مشمول + صادراتی معاف', [
      { accountId: receivable.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: 6_100_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 1_000_000_000n, memo: 'داخلی مشمول' },
      { accountId: sales.id, currencyCode: 'IRR', credit: 5_000_000_000n, memo: 'صادراتی معاف' },
      { accountId: vatOut.id, currencyCode: 'IRR', credit: 100_000_000n },
    ]);

    const r = await vatReturn(gl as any, { from: D('2026-06-22'), to: D('2026-09-22') });
    expect(r.outputVat).toBe('100000000');
    expect(r.taxableSales).toBe('1000000000');   // نه ۶٬۰۰۰٬۰۰۰٬۰۰۰
    expect(r.exemptSales).toBe('5000000000');
    // نرخ ضمنی دقیقاً برابر نرخ قانونی است
    expect(Number(r.outputVat) * 100 / Number(r.taxableSales)).toBe(r.vatPercent);
  });

  it('سود تسعیر ارز به‌عنوان فروش شمرده نمی‌شود', async () => {
    const receivable = await accountByCode('1104');
    const fxGain = await accountByCode('8101');
    const customer = await makeSubsidiary('CUSTOMER', 'مشتری با تسعیر');

    await entry(D('2026-07-15'), 'فروش همراه با سود تسعیر', [
      { accountId: receivable.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: 3_100_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 1_000_000_000n },
      { accountId: fxGain.id, currencyCode: 'IRR', credit: 2_000_000_000n },
      { accountId: vatOut.id, currencyCode: 'IRR', credit: 100_000_000n },
    ]);

    const r = await vatReturn(gl as any, { from: D('2026-06-22'), to: D('2026-09-22') });
    expect(r.taxableSales).toBe('1000000000');
    expect(r.exemptSales).toBe('0');   // سود تسعیر اصلاً درآمدِ این گزارش نیست
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ب۵ — دفتر دارایی ثابت با دفتر کل مغایرت‌گیری می‌شود', () => {
  it('استهلاک روی دارایی سرمایه‌ای‌نشده، مغایرت گزارش می‌دهد', async () => {
    await tx((t) => upsertAsset(t, {
      code: 'FA-AUDIT', name: 'دستگاه بدون سند خرید',
      cost: 12_000_000_000n, salvage: 1_200_000_000n,
      usefulLifeMonths: 36, inServiceAt: D('2026-03-25'),
    }));
    await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: D('2026-06-25') }));

    const r = await integrityCheck(gl as any);
    // ⚠️ پیش از این رفع، اینجا `ok: true` برمی‌گشت در حالی که ترازنامه
    // «دارایی غیرجاریِ منفی» نشان می‌داد.
    expect(r.ok).toBe(false);
    expect(r.assetRegisterMismatch.map((m) => m.code)).toContain('1201');
  });

  it('پس از سرمایه‌ای‌کردن، مغایرتی نمی‌ماند', async () => {
    const fixedAsset = await accountByCode('1201');
    await tx((t) => upsertAsset(t, {
      code: 'FA-AUDIT', name: 'دستگاه با سند خرید',
      cost: 12_000_000_000n, salvage: 1_200_000_000n,
      usefulLifeMonths: 36, inServiceAt: D('2026-03-25'),
    }));
    await entry(D('2026-03-25'), 'خرید دارایی ثابت', [
      { accountId: fixedAsset.id, currencyCode: 'IRR', debit: 12_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 12_000_000_000n },
    ]);
    await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: D('2026-06-25') }));

    const r = await integrityCheck(gl as any);
    expect(r.assetRegisterMismatch).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ب۸ — بستن سال چک‌لیست دارد', () => {
  async function profitableYear() {
    await entry(D('2026-05-01'), 'آورده', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 10_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 10_000_000_000n },
    ]);
    await entry(D('2026-06-01'), 'فروش', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 4_000_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 4_000_000_000n },
    ]);
  }

  it('پیش‌نمایش، ذخیرهٔ مالیات و اندوختهٔ قانونی را TODO می‌کند', async () => {
    await profitableYear();
    const p: any = await previewYearClose(gl as any, fy.id);
    expect(p.netProfit).toBe('4000000000');
    expect(p.readyToClose).toBe(false);
    const todo = p.checklist.filter((c: any) => c.status === 'TODO').map((c: any) => c.key);
    expect(todo).toContain('income-tax');
    expect(todo).toContain('legal-reserve');
  });

  it('بستن با کارِ ناتمام رد می‌شود', async () => {
    await profitableYear();
    await expectRejects(
      () => tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id })),
      /پیش از بستن سال/,
    );
  });

  it('با ثبت ذخیرهٔ مالیات و اندوخته، سال بسته می‌شود', async () => {
    await profitableYear();
    const taxExp = await accountByCode('8205');
    const taxProv = await accountByCode('2112');
    const reserve = await accountByCode('3103');
    const retained = await accountByCode('3102');

    await entry(D('2027-03-19'), 'ذخیرهٔ مالیات بر درآمد', [
      { accountId: taxExp.id, currencyCode: 'IRR', debit: 1_000_000_000n },
      { accountId: taxProv.id, currencyCode: 'IRR', credit: 1_000_000_000n },
    ]);
    await entry(D('2027-03-19'), 'اندوختهٔ قانونی', [
      { accountId: retained.id, currencyCode: 'IRR', debit: 1_000_000_000n },
      { accountId: reserve.id, currencyCode: 'IRR', credit: 1_000_000_000n },
    ]);

    const p: any = await previewYearClose(gl as any, fy.id);
    expect(p.readyToClose).toBe(true);
    const res: any = await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id }));
    expect(res.fiscalYear.closedAt).not.toBeNull();
  });

  it('پذیرش صریح، چک‌لیست را دور می‌زند', async () => {
    await profitableYear();
    const res: any = await tx((t) => closeFiscalYear(t, {
      fiscalYearId: fy.id, acknowledgeChecklist: true,
    }));
    expect(res.fiscalYear.closedAt).not.toBeNull();
  });

  it('سالِ زیان‌ده ذخیرهٔ مالیات نمی‌خواهد', async () => {
    await entry(D('2026-05-01'), 'آورده', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 10_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 10_000_000_000n },
    ]);
    await entry(D('2026-06-01'), 'هزینه', [
      { accountId: (await accountByCode('6213')).id, currencyCode: 'IRR', debit: 2_000_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 2_000_000_000n },
    ]);
    const p: any = await previewYearClose(gl as any, fy.id);
    expect(p.readyToClose).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ن۵ — محافظ تناسب، مسیر بدونِ نرخِ بازار را نمی‌بندد', () => {
  /**
   * ⚠️ رگرسیونی که خودِ محافظ ب۲ ساخت.
   *
   * `assertSettlementProportional` نرخ روزِ ارز تعهد را اجباری می‌کرد. اما
   * پیش از آن، تسویهٔ یک بدهی ارزی با پرداخت ریالی فقط به `carryingRate`
   * نیاز داشت. نتیجه: پرداخت بدهی درهمی در تاریخی که هنوز نرخ AED ثبت
   * نشده بود با «نرخ AED ثبت نشده است» رد می‌شد.
   */
  it('بدهی ارزیِ بدون نرخ بازار، با پرداخت ریالیِ متناسب تسویه می‌شود', async () => {
    const supplier = await makeSubsidiary('SUPPLIER', 'تأمین‌کنندهٔ درهمی');
    // هیچ نرخ AED ثبت نمی‌کنیم — فقط نرخ صریح روی خود سند
    await entry(D('2026-05-10'), 'بدهی درهمی', [
      { accountId: (await accountByCode('6213')).id, currencyCode: 'IRR', debit: 600_000_000n },
      { accountId: payable.id, subsidiaryId: supplier.id, currencyCode: 'AED', credit: 100_000n, rate: '600000' },
    ]);
    await entry(D('2026-05-01'), 'آوردهٔ ریالی', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 2_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 2_000_000_000n },
    ]);

    const e: any = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: D('2026-05-12'), direction: 'PAYMENT',
      subsidiaryId: supplier.id, currency: 'AED', amount: '1000',
      cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: '600000000',
    }));
    expect(e.id).toBeTruthy();
  });

  it('ولی پرداختِ نامتناسب همچنان رد می‌شود، حتی بدون نرخ بازار', async () => {
    const supplier = await makeSubsidiary('SUPPLIER', 'تأمین‌کنندهٔ درهمی دوم');
    await entry(D('2026-05-10'), 'بدهی درهمی', [
      { accountId: (await accountByCode('6213')).id, currencyCode: 'IRR', debit: 600_000_000n },
      { accountId: payable.id, subsidiaryId: supplier.id, currencyCode: 'AED', credit: 100_000n, rate: '600000' },
    ]);
    await entry(D('2026-05-01'), 'آوردهٔ ریالی', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 5_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 5_000_000_000n },
    ]);

    await expectRejects(
      () => tx((t) => doSettlement(t, {
        fiscalYearId: fy.id, date: D('2026-05-12'), direction: 'PAYMENT',
        subsidiaryId: supplier.id, currency: 'AED', amount: '1000',
        cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: '3000000000',
      })),
      /نمی‌خواند/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ن۶ — ورودی خراب، ۵۰۰ با dump انگلیسی نمی‌دهد', () => {
  /**
   * ⚠️ هر دو مورد پیش‌تر تا Prisma می‌رفتند و کاربر یک **HTTP 500** با متن
   * انگلیسیِ خام می‌گرفت — همان دسته‌ای که ممیزی ن۸ قرار بود حذفش کند.
   * (اینجا در سطح واحد سنجیده می‌شود؛ اعتبارسنجی در مسیر HTTP است.)
   */
  it('شناسهٔ حساب ناموجود، خطای فارسی می‌دهد نه نقض کلید خارجی', async () => {
    await expectRejects(
      () => tx((t) => post(t, {
        fiscalYearId: fy.id, date: D('2026-06-01'), description: 'حساب ناموجود',
        lines: [
          { accountId: 'nonexistent-account-id', currencyCode: 'IRR', debit: 100n },
          { accountId: sales.id, currencyCode: 'IRR', credit: 100n },
        ],
      })),
      /./,   // فقط باید رد شود، نه اینکه ردیف بی‌صدا درج گردد
    );
    expect(await gl.glEntry.count({ where: { description: 'حساب ناموجود' } })).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ن۸ — پیش‌دریافت یک مشتری، ذخیرهٔ مطالباتِ دیگری را کم نمی‌کند', () => {
  /**
   * ⚠️ محافظ «فقط ماندهٔ مثبت» روی **جمعِ سطل** اجرا می‌شد، نه روی هر
   * طرف‌حساب. جمعِ سطل مثبت و منفی را از قبل خنثی کرده بود، پس
   * ۹۰۰٬۰۰۰٬۰۰۰ پیش‌دریافتِ یک مشتری، ۹۰۰٬۰۰۰٬۰۰۰ از پایهٔ ذخیرهٔ طلبِ
   * مشکوکِ مشتری دیگر کم می‌کرد.
   */
  it('ماندهٔ بستانکارِ طرف‌حساب از پایهٔ ذخیره کنار گذاشته می‌شود', async () => {
    const receivable = await accountByCode('1104');
    const debtor = await makeSubsidiary('CUSTOMER', 'مشتری بدهکار');
    const prepayer = await makeSubsidiary('CUSTOMER', 'مشتری پیش‌پرداختی');

    // طلب مشکوک از مشتری اول
    await entry(D('2026-04-01'), 'فروش نسیه', [
      { accountId: receivable.id, subsidiaryId: debtor.id, currencyCode: 'IRR', debit: 10_000_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 10_000_000_000n },
    ]);
    // پیش‌دریافت از مشتری دوم، در همان بازهٔ سنی
    await entry(D('2026-04-01'), 'پیش‌دریافت', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 4_000_000_000n },
      { accountId: receivable.id, subsidiaryId: prepayer.id, currencyCode: 'IRR', credit: 4_000_000_000n },
    ]);

    const p: any = await computeProvision(gl as any, D('2026-09-01'));
    const total = p.lines.reduce((s: bigint, l: any) => s + BigInt(l.receivable), 0n);
    // پایه باید ۱۰ میلیارد باشد، نه ۶ میلیارد
    expect(total).toBe(10_000_000_000n);
    // ولی ماندهٔ خالص همچنان گزارش می‌شود — پنهان نمی‌شود
    const net = p.lines.reduce((s: bigint, l: any) => s + BigInt(l.balance), 0n);
    expect(net).toBe(6_000_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ن۹ — ظهرنویسی چک، تعهد را تا وصول باز نگه می‌دارد', () => {
  /**
   * ⚠️ مدل قبلی «بد ۲۱۰۱ / بس ۱۱۰۳۰۱» می‌زد: بدهی تسویه و چک ناپدید.
   * ولی طبق قانون تجارت ظهرنویس تا وصول مسئول می‌ماند، و اگر چک برگردد
   * طلبکار سراغ ما می‌آید — بدون هیچ ردی در دفتر. حساب «۱۱۰۳۰۴ چک
   * خرج‌شده» هم در چارت رزرو شده بود و `CHEQUE_CODES.endorsed` به آن
   * اشاره می‌کرد، ولی هیچ کدی نمی‌خواندش.
   */
  async function endorsed() {
    const customer = await makeSubsidiary('CUSTOMER', 'صادرکنندهٔ چک');
    const supplier = await makeSubsidiary('SUPPLIER', 'طرف سوم');
    const receivable = await accountByCode('1104');

    await entry(D('2026-06-01'), 'فروش نسیه', [
      { accountId: receivable.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: 5_000_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 5_000_000_000n },
    ]);
    await entry(D('2026-06-01'), 'خرید نسیه', [
      { accountId: (await accountByCode('5101')).id, currencyCode: 'IRR', debit: 5_000_000_000n },
      { accountId: payable.id, subsidiaryId: supplier.id, currencyCode: 'IRR', credit: 5_000_000_000n },
    ]);

    const { cheque } = await tx((t) => receiveCheque(t, {
      fiscalYearId: fy.id, date: D('2026-06-05'),
      number: 'END-1', bankName: 'ملی', amount: 5_000_000_000n, currencyCode: 'IRR',
      issueDate: D('2026-06-05'), dueDate: D('2026-09-05'), subsidiaryId: customer.id,
    }));
    await tx((t) => transitionCheque(t, {
      fiscalYearId: fy.id, date: D('2026-06-10'), chequeId: cheque.id,
      to: 'ENDORSED', endorseToSubsidiaryId: supplier.id,
    }));
    return { cheque, customer, supplier };
  }

  const bal = async (code: string) => {
    const rows = await gl.$queryRawUnsafe<{ b: bigint | null }[]>(
      `SELECT COALESCE(SUM(l."debitBase" - l."creditBase"),0)::bigint AS b
       FROM "GlLine" l JOIN "GlEntry" e ON e.id=l."entryId" JOIN "GlAccount" a ON a.id=l."accountId"
       WHERE a.code = $1 AND e.status <> 'DRAFT'`, code);
    return rows[0]?.b ?? 0n;
  };

  it('چک در ۱۱۰۳۰۴ می‌ماند و تعهد به ۲۱۰۲ منتقل می‌شود', async () => {
    await endorsed();
    expect(await bal('110301')).toBe(0n);              // از دست ما رفت
    expect(await bal('110304')).toBe(5_000_000_000n);  // ولی هنوز دارایی ماست
    expect(await bal('2101')).toBe(0n);                // بدهی تجاری بسته شد
    expect(await bal('2102')).toBe(-5_000_000_000n);   // و به اسناد پرداختنی رفت
  });

  it('وصول نزد طرف سوم، هر دو تعهد را می‌بندد', async () => {
    const { cheque } = await endorsed();
    await tx((t) => transitionCheque(t, {
      fiscalYearId: fy.id, date: D('2026-09-06'), chequeId: cheque.id, to: 'COLLECTED',
    }));
    expect(await bal('110304')).toBe(0n);
    expect(await bal('2102')).toBe(0n);
    // هیچ نقدی جابه‌جا نشد — پول از جیب صادرکننده رفت، نه ما
    expect(await bal('110101')).toBe(0n);
  });

  it('برگشت چکِ خرج‌شده، بدهی به طرف سوم را زنده می‌کند', async () => {
    const { cheque } = await endorsed();
    await tx((t) => transitionCheque(t, {
      fiscalYearId: fy.id, date: D('2026-09-06'), chequeId: cheque.id, to: 'BOUNCED',
    }));
    expect(await bal('110304')).toBe(0n);
    expect(await bal('110305')).toBe(5_000_000_000n);  // چک برگشتی، به نام صادرکننده
    expect(await bal('2102')).toBe(0n);
    expect(await bal('2101')).toBe(-5_000_000_000n);   // دوباره بدهکار طرف سوم شدیم
  });

  it('طرف‌حسابِ ظهرنویسی از سند خوانده می‌شود، نیازی به تکرار نیست', async () => {
    const { cheque, supplier } = await endorsed();
    await tx((t) => transitionCheque(t, {
      fiscalYearId: fy.id, date: D('2026-09-06'), chequeId: cheque.id, to: 'BOUNCED',
    }));
    const line = await gl.glLine.findFirst({
      where: { account: { code: '2101' }, subsidiaryId: supplier.id, credit: { gt: 0n } },
    });
    expect(line).toBeTruthy();
  });
});
