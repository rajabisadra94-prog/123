/**
 * فاز ۱ نقشهٔ پاریتی — عملیات روزمره روی هستهٔ جدید.
 *
 * `ops.ts` لایهٔ نازکی است روی `postSettlement`/`postConversion`/`post`. این تست‌ها
 * نگاشتِ ورودی (طرف‌حساب → تفصیلی + معین، مبلغ نمایشی → کوچک‌ترین واحد) و
 * **موضع ارزی عدد‌به‌عدد** را می‌سنجند — همان چیزی که خانوادهٔ باگ ریال را لو می‌دهد
 * و تریگر توازن نمی‌گیردش (`LEDGER_ARCHITECTURE.md` بخش «خانوادهٔ باگ»).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, DEFAULT_DATE,
  expectRejects, resetBusinessData,
} from '../helpers/gl';
import { ensureSubsidiary } from '../../src/modules/ledger/subsidiary';
import { createAccount } from '../../src/modules/ledger/codes';
import { post } from '../../src/modules/ledger/poster';
import { positionBalance, FX_CODES } from '../../src/modules/ledger/fx';
import {
  doSettlement, doConversion, doTransfer, doExpense, settlementPreview,
} from '../../src/modules/ledger/ops';

let fy: { id: string };
let ar: { id: string };
let payable: { id: string };
let sales: { id: string };
let cash: { id: string };
let cogs: { id: string };
let equity: { id: string };
let customer: { id: string };
let producer: { id: string };

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

async function seedRates(date = DEFAULT_DATE) {
  for (const [from, rate] of [['USD', '1000000'], ['CNY', '140000']] as const) {
    await gl.glExchangeRate.upsert({
      where: { from_to_date_source: { from, to: 'IRR', date, source: 'MANUAL' } },
      update: { rate }, create: { from, to: 'IRR', date, rate, source: 'MANUAL' },
    });
  }
}

const fxLineOf = async (entryId: string) => {
  const lines = await gl.glLine.findMany({
    where: { entryId }, include: { account: { select: { code: true } } },
  });
  return lines.find((l) => l.account.code.startsWith('81') || l.account.code.startsWith('82'));
};

/** طلب دلاری روی مشتری با نرخ دفتری دلخواه */
const openReceivable = (cents: bigint, rate: string) =>
  tx((t) => post(t, {
    fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش دلاری',
    lines: [
      { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD', debit: cents, rate },
      { accountId: sales.id, currencyCode: 'USD', credit: cents, rate },
    ],
  }));

/**
 * ارزِ نقد در صندوق — بدون این، پرداخت‌های ارزی به نگهبانِ پوششِ ارزی می‌خورند.
 *
 * پیش از افزودنِ آن نگهبان، این تست‌ها ۱۰۰۰ یوآنی خرج می‌کردند که صندوق اصلاً
 * نداشت. تست سبز بود چون سامانه اجازه می‌داد — همان اجازه‌ای که روی staging
 * ماندهٔ منفیِ ده‌میلیون‌دلاری ساخت.
 */
const fundCash = (currency: string, amount: bigint, rate: string) =>
  tx((t) => post(t, {
    fiscalYearId: fy.id, date: DEFAULT_DATE, description: `تأمین نقدِ ${currency}`,
    lines: [
      { accountId: cash.id, currencyCode: currency, debit: amount, rate },
      { accountId: equity.id, currencyCode: 'IRR', credit: amount * BigInt(rate) / 100n },
    ],
  }));

/** بدهی یوآنی به سازنده */
const openPayable = (fen: bigint, rate: string) =>
  tx((t) => post(t, {
    fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'خرید یوآنی',
    lines: [
      { accountId: cogs.id, currencyCode: 'CNY', debit: fen, rate },
      { accountId: payable.id, subsidiaryId: producer.id, currencyCode: 'CNY', credit: fen, rate },
    ],
  }));

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
  ar = await accountByCode('1104');
  payable = await accountByCode('2101');
  sales = await accountByCode('4101');
  cash = await accountByCode('110101');
  cogs = await accountByCode('5101');
  equity = await accountByCode('3101');
}, 180_000);

afterAll(async () => {
  await resetGl();
  await gl.glAccount.deleteMany({ where: { isSystem: false } });
  await gl.$disconnect();
});

beforeEach(async () => {
  await resetGl();
  // حساب‌های تستِ اجرای قبلی را بردار (چارت سیستمی دست‌نخورده)
  await gl.glAccount.deleteMany({ where: { isSystem: false } });
  await resetBusinessData();
  await gl.glExchangeRate.deleteMany({});
  await gl.customer.deleteMany({});
  await gl.producer.deleteMany({});
  fy = await makeFiscalYear();
  await seedRates();

  // حساب بانکی ریالی برای تست انتقال (چارت پیش‌فرض فقط «صندوق» دارد)
  await tx((t) => createAccount(t, {
    code: '110102', name: 'بانک ملت (ریالی)', currencyMode: 'SINGLE', currencyCode: 'IRR',
  }));

  const c = await gl.customer.create({ data: { name: 'مشتری ارزی', shortCode: 'OP1' } });
  const p = await gl.producer.create({ data: { name: 'Sun' } });
  customer = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
  producer = await tx((t) => ensureSubsidiary(t, 'PRODUCER', 'Producer', p.id, p.name));
});

// ═══════════════════════════════════════════════════════════════
describe('دریافت / پرداخت', () => {
  it('دریافت هم‌ارز از مشتری — موضع دلاری دقیقاً صفر، تسعیر از نرخ روز', async () => {
    await openReceivable(10_000n, '900000');          // ۱۰۰ دلار، دفتری ۹۰ م ریال
    await seedRates();                                 // نرخ روز ۱٬۰۰۰٬۰۰۰
    await gl.glExchangeRate.updateMany({ where: { from: 'USD' }, data: { rate: '950000' } });

    const entry = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT',
      subsidiaryId: customer.id, currency: 'USD', amount: '100',
      cashAccountCode: '110101',
    }));

    const pos = await positionBalance(gl, { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD' });
    expect(pos.amount).toBe(0n);                       // نه «تقریباً صفر»

    const fx = await fxLineOf(entry.id);
    expect(fx!.account.code).toBe(FX_CODES.gainRealized);
    expect(fx!.credit).toBe(5_000_000n);              // (۹۵۰٬۰۰۰ − ۹۰۰٬۰۰۰) × ۱۰۰
  });

  it('نرخ صریح روی درخواست، بر جدول نرخ اولویت دارد', async () => {
    await fundCash('CNY', 100_000n, '140000');        // یوآنِ نقد برای پرداخت
    await openPayable(100_000n, '150000');            // ۱۰۰۰ یوآن، دفتری ۱۵۰ م
    const entry = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'PAYMENT',
      subsidiaryId: producer.id, currency: 'CNY', amount: '1000',
      cashAccountCode: '110101', dayRate: '140000',
    }));
    const fx = await fxLineOf(entry.id);
    expect(fx!.account.code).toBe(FX_CODES.gainRealized);
    expect(fx!.credit).toBe(10_000_000n);            // بدهی ۱۵۰م، پرداخت ۱۴۰م
    const pos = await positionBalance(gl, { accountId: payable.id, subsidiaryId: producer.id, currencyCode: 'CNY' });
    expect(pos.amount).toBe(0n);
  });

  it('معین کنترلی از نوع تفصیلی مشتق می‌شود (مشتری→۱۱۰۴)', async () => {
    await openReceivable(5_000n, '1000000');
    const entry = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT',
      subsidiaryId: customer.id, currency: 'USD', amount: '50', cashAccountCode: '110101',
    }));
    const lines = await gl.glLine.findMany({
      where: { entryId: entry.id }, include: { account: { select: { code: true } } },
    });
    expect(lines.some((l) => l.account.code === '1104' && l.subsidiaryId === customer.id)).toBe(true);
  });

  it('مبلغ نمایشیِ اعشاری درست به سنت تبدیل می‌شود', async () => {
    await openReceivable(12_345n, '1000000');          // ۱۲۳٫۴۵ دلار
    const entry = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT',
      subsidiaryId: customer.id, currency: 'USD', amount: '123.45', cashAccountCode: '110101',
    }));
    const usdLine = (await gl.glLine.findMany({ where: { entryId: entry.id } }))
      .find((l) => l.currencyCode === 'USD' && l.credit > 0n)!;
    expect(usdLine.credit).toBe(12_345n);
  });

  it('تسویهٔ بین‌ارزی بدون مبلغِ نقد رد می‌شود (ممیزی ج۹)', async () => {
    await openReceivable(10_000n, '1000000');
    await expectRejects(() => tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT',
      subsidiaryId: customer.id, currency: 'USD', amount: '100',
      cashAccountCode: '110102',                       // بانک ریالی — ارز حساب ≠ ارز تعهد
    })), /بین‌ارزی/);
  });

  it('تسویهٔ بین‌ارزی در یک سند: تعهد به نرخ دفتری، نقد به ریال، مابه‌التفاوت تسعیر (ممیزی ج۹)', async () => {
    await openReceivable(10_000n, '1000000');          // ۱۰۰ دلار، دفتری ۱۰۰ م ریال
    const entry = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT',
      subsidiaryId: customer.id, currency: 'USD', amount: '100',
      cashAccountCode: '110102',                       // بانک ریالی
      cashCurrency: 'IRR', cashAmount: '105000000',     // ۱۰۵ م ریال واقعاً دریافت شد
    }));

    const lines = await gl.glLine.findMany({
      where: { entryId: entry.id }, include: { account: { select: { code: true } } },
      orderBy: { lineNo: 'asc' },
    });
    // موضع دلاریِ مشتری دقیقاً صفر
    const pos = await positionBalance(gl, { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD' });
    expect(pos.amount).toBe(0n);
    // نقد ریالی: ۱۰۵ م بدهکار روی بانک ریالی
    const bank = lines.find((l) => l.account.code === '110102')!;
    expect(bank.debit).toBe(105_000_000n);
    expect(bank.currencyCode).toBe('IRR');
    // تعهد: ۱۰۰ دلار بستانکار به نرخ دفتریِ ۱٬۰۰۰٬۰۰۰
    const obl = lines.find((l) => l.account.code === '1104')!;
    expect(obl.credit).toBe(10_000n);
    expect(obl.rate.toString()).toBe('1000000');
    // تسعیر محقق: ۱۰۵ م − ۱۰۰ م = ۵ م سود
    const fx = await fxLineOf(entry.id);
    expect(fx!.account.code).toBe(FX_CODES.gainRealized);
    expect(fx!.credit).toBe(5_000_000n);
  });

  it('پیش‌نمایش: مانده و نرخ دفتری موضع را می‌دهد', async () => {
    await openReceivable(10_000n, '900000');
    const pv = await settlementPreview(gl, customer.id, 'USD', DEFAULT_DATE);
    expect(pv.balance).toBe('10000');
    expect(pv.carryingRate).toBe('900000');
    expect(pv.obligationAccountCode).toBe('1104');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('تبدیل ارز', () => {
  it('خرید دلار با ریالِ صندوق — بدون سود جعلی، نرخ واقعی روی ردیف', async () => {
    const { entry } = await tx((t) => doConversion(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', fromCurrency: 'IRR', fromAmount: '120000000',
      toAccountCode: '110101', toCurrency: 'USD', toAmount: '100',
    }));
    expect(await fxLineOf(entry.id)).toBeUndefined();
    const usd = (await gl.glLine.findMany({ where: { entryId: entry.id } }))
      .find((l) => l.currencyCode === 'USD')!;
    expect(usd.rate.toString()).toBe('1200000');       // بهای واقعیِ پرداخت‌شده
  });

  it('کارمزد صرافی سند جدا می‌زند و هزینه شناسایی می‌کند', async () => {
    const { entry, feeEntry } = await tx((t) => doConversion(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', fromCurrency: 'IRR', fromAmount: '100000000',
      toAccountCode: '110101', toCurrency: 'USD', toAmount: '100',
      fee: { amount: '500000', currency: 'IRR', accountCode: '110101' },
    }));
    expect(feeEntry).toBeDefined();
    expect(entry.id).not.toBe(feeEntry!.id);
    const feeLines = await gl.glLine.findMany({
      where: { entryId: feeEntry!.id }, include: { account: { select: { code: true } } },
    });
    const feeExpense = feeLines.find((l) => l.account.code === '7102')!;
    expect(feeExpense.debit).toBe(500_000n);
  });

  it('ارز یکسان مبدأ و مقصد رد می‌شود', async () => {
    await expectRejects(() => tx((t) => doConversion(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', fromCurrency: 'IRR', fromAmount: '1000',
      toAccountCode: '110102', toCurrency: 'IRR', toAmount: '1000',
    })), /متفاوت/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('انتقال داخلی', () => {
  it('انتقال ریالی صندوق ← بانک، تراز و بدون تسعیر', async () => {
    // اول صندوق را شارژ کن
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'سرمایهٔ نقدی',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 50_000_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 50_000_000n },
      ],
    }));

    const entry = await tx((t) => doTransfer(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', toAccountCode: '110102', currency: 'IRR', amount: '20000000',
    }));
    expect(await fxLineOf(entry.id)).toBeUndefined();

    const bank = await accountByCode('110102');
    const pos = await positionBalance(gl, { accountId: bank.id, currencyCode: 'IRR' });
    expect(pos.base).toBe(20_000_000n);
  });

  it('حساب یکسان مبدأ و مقصد رد می‌شود', async () => {
    await expectRejects(() => tx((t) => doTransfer(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', toAccountCode: '110101', currency: 'IRR', amount: '1000',
    })), /یکی/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ثبت هزینه', () => {
  it('هزینه با مرکز هزینه، بدهکار حساب هزینه و بستانکار صندوق', async () => {
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'شارژ صندوق',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 10_000_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 10_000_000n },
      ],
    }));

    const entry = await tx((t) => doExpense(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', currency: 'IRR', amount: '2500000',
      description: 'اجارهٔ دفتر',
    }));

    const lines = await gl.glLine.findMany({
      where: { entryId: entry.id }, include: { account: { select: { code: true } } },
    });
    const debit = lines.find((l) => l.debit > 0n)!;
    expect(debit.account.code).toBe('6201');
    expect(debit.debit).toBe(2_500_000n);
    const credit = lines.find((l) => l.credit > 0n)!;
    expect(credit.account.code).toBe('110101');
  });

  it('حساب هزینهٔ صریح پذیرفته می‌شود', async () => {
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'شارژ صندوق',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 10_000_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 10_000_000n },
      ],
    }));
    const entry = await tx((t) => doExpense(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', expenseAccountCode: '6202', currency: 'IRR', amount: '1000000',
    }));
    const debit = (await gl.glLine.findMany({
      where: { entryId: entry.id }, include: { account: { select: { code: true } } },
    })).find((l) => l.debit > 0n)!;
    expect(debit.account.code).toBe('6202');
  });
});
