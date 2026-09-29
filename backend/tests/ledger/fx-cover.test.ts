/**
 * ارزی که نداریم، خرج نمی‌شود.
 *
 * ⚠️ این فایل از یک باگِ واقعی روی staging آمد: تبدیلِ ۹٬۹۹۹٬۹۹۹ دلار از
 * حسابی که چند صد دلار داشت، با HTTP 200 پذیرفته شد و دو چیزِ بی‌معنی ساخت —
 * ماندهٔ دلاریِ منفیِ ده‌میلیونی، و «زیان تسعیر»ِ ۹٬۱۲۹ میلیارد ریالی که از
 * هیچ درآمده بود.
 *
 * دلیلِ نشکستنِ خودبه‌خودی: `carryingRate` نرخِ متوسطِ همان چند صد دلار را به
 * ده میلیون دلار تعمیم می‌دهد. فرمول درست کار می‌کرد؛ فرضش غلط بود.
 *
 * ۶۸۱ تستِ پیشین این را ندیدند چون همه‌شان از حسابی خرج می‌کردند که موجودی
 * کافی داشت — یعنی حالتِ خوش‌بینانه را آزموده بودند، نه مرزِ آن.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, DEFAULT_DATE, expectRejects, resetBusinessData,
} from '../helpers/gl';
import { ensureSubsidiary } from '../../src/modules/ledger/subsidiary';
import { post } from '../../src/modules/ledger/poster';
import { postConversion, positionBalance } from '../../src/modules/ledger/fx';
import { doTransfer, doExpense, doSettlement } from '../../src/modules/ledger/ops';
import { createAccount } from '../../src/modules/ledger/codes';

let fy: { id: string };
let cash: any, equity: any, ar: any, sales: any, customer: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
  cash = await accountByCode('110101');
  equity = await accountByCode('3101');
  ar = await accountByCode('1104');
  sales = await accountByCode('4101');
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl();
  await resetBusinessData();
  await gl.glExchangeRate.deleteMany({});
  await gl.customer.deleteMany({});
  fy = await makeFiscalYear();
  await gl.glExchangeRate.create({
    data: { from: 'USD', to: 'IRR', date: DEFAULT_DATE, rate: '1000000', source: 'MANUAL' },
  });
  const c = await gl.customer.create({ data: { name: 'مشتری پوشش', shortCode: 'CVR' } });
  customer = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
});

/** ۱۰۰ دلار می‌خریم تا موجودیِ واقعی داشته باشیم */
async function buyUsd(cents: bigint, irr: bigint) {
  return tx((t) => postConversion(t, {
    fiscalYearId: fy.id, date: DEFAULT_DATE,
    fromAccountCode: '110101', fromCurrency: 'IRR', fromAmount: irr,
    toAccountCode: '110101', toCurrency: 'USD', toAmount: cents,
  }));
}

async function fundRial(amount: bigint) {
  return tx((t) => post(t, {
    fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'آورده',
    lines: [
      { accountId: cash.id, currencyCode: 'IRR', debit: amount },
      { accountId: equity.id, currencyCode: 'IRR', credit: amount },
    ],
  }));
}

describe('پوشش ارزی — ارزِ نداشته خرج نمی‌شود', () => {
  it('تبدیلِ بیش از موجودیِ ارزی رد می‌شود', async () => {
    await fundRial(200_000_000n);
    await buyUsd(10_000n, 100_000_000n);   // $۱۰۰
    const before = await positionBalance(gl, { accountId: cash.id, currencyCode: 'USD', subsidiaryId: null });
    expect(before.amount).toBe(10_000n);

    await expectRejects(
      () => tx((t) => postConversion(t, {
        fiscalYearId: fy.id, date: DEFAULT_DATE,
        fromAccountCode: '110101', fromCurrency: 'USD', fromAmount: 999_999_900n,
        toAccountCode: '110101', toCurrency: 'IRR', toAmount: 1_000n,
      })),
      /موجودیِ USD|کافی نیست/,
    );

    const after = await positionBalance(gl, { accountId: cash.id, currencyCode: 'USD', subsidiaryId: null });
    expect(after.amount).toBe(10_000n);   // دست نخورده
  });

  it('تبدیلِ دقیقاً به‌اندازهٔ موجودی مجاز است — مرز باز است، نه بسته', async () => {
    await fundRial(200_000_000n);
    await buyUsd(10_000n, 100_000_000n);
    const e = await tx((t) => postConversion(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', fromCurrency: 'USD', fromAmount: 10_000n,
      toAccountCode: '110101', toCurrency: 'IRR', toAmount: 100_000_000n,
    }));
    expect(e.status).toBe('POSTED');
    const after = await positionBalance(gl, { accountId: cash.id, currencyCode: 'USD', subsidiaryId: null });
    expect(after.amount).toBe(0n);
  });

  it('یک سنتِ بیشتر از موجودی رد می‌شود', async () => {
    await fundRial(200_000_000n);
    await buyUsd(10_000n, 100_000_000n);
    await expectRejects(
      () => tx((t) => postConversion(t, {
        fiscalYearId: fy.id, date: DEFAULT_DATE,
        fromAccountCode: '110101', fromCurrency: 'USD', fromAmount: 10_001n,
        toAccountCode: '110101', toCurrency: 'IRR', toAmount: 100_010_000n,
      })),
      /کافی نیست/,
    );
  });

  it('انتقالِ ارزیِ بیش از موجودی رد می‌شود', async () => {
    await fundRial(200_000_000n);
    await buyUsd(10_000n, 100_000_000n);
    await tx((t) => createAccount(t, { code: '110109', name: 'صندوق دوم', currencyMode: 'MULTI' }));
    await expectRejects(
      () => tx((t) => doTransfer(t, {
        fiscalYearId: fy.id, date: DEFAULT_DATE,
        fromAccountCode: '110101', toAccountCode: '110109',
        currency: 'USD', amount: '500',
      })),
      /کافی نیست/,
    );
  });

  it('هزینهٔ ارزیِ بیش از موجودی رد می‌شود', async () => {
    await fundRial(200_000_000n);
    await buyUsd(10_000n, 100_000_000n);
    await expectRejects(
      () => tx((t) => doExpense(t, {
        fiscalYearId: fy.id, date: DEFAULT_DATE,
        fromAccountCode: '110101', currency: 'USD', amount: '500',
        description: 'هزینهٔ بی‌پشتوانه',
      })),
      /کافی نیست/,
    );
  });

  it('پرداختِ ارزی به طرف‌حساب، بیش از موجودی رد می‌شود', async () => {
    await fundRial(1_000_000_000n);
    await buyUsd(10_000n, 100_000_000n);
    // بدهیِ دلاری به تأمین‌کننده می‌سازیم
    const s = await gl.supplier.create({ data: { name: 'تأمین پوشش' } });
    const sup = await tx((t) => ensureSubsidiary(t, 'SUPPLIER', 'Supplier', s.id, s.name));
    const payable = await accountByCode('2101');
    const expense = await accountByCode('5101');
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'خرید دلاری',
      lines: [
        { accountId: expense.id, currencyCode: 'USD', debit: 100_000n, rate: { scaled: 1_000_000n * 1_000_000n } },
        { accountId: payable.id, subsidiaryId: sup.id, currencyCode: 'USD', credit: 100_000n, rate: { scaled: 1_000_000n * 1_000_000n } },
      ],
    }));
    await expectRejects(
      () => tx((t) => doSettlement(t, {
        fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'PAYMENT',
        subsidiaryId: sup.id, currency: 'USD', amount: '1000',
        cashAccountCode: '110101',
      })),
      /کافی نیست/,
    );
  });

  /**
   * ریال فرق دارد: ماندهٔ منفیِ حساب بانکی «اضافه‌برداشت» است و در دنیای واقعی
   * وجود دارد. بستنش کارِ درست را هم می‌بندد. نمای کلی از قبل هشدارش را می‌دهد.
   */
  it('ماندهٔ ریالیِ منفی بسته نمی‌شود — اضافه‌برداشت غلط نیست', async () => {
    await fundRial(10_000_000n);
    const e = await tx((t) => doExpense(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', currency: 'IRR', amount: '50000000',
      description: 'اضافه‌برداشت',
    }));
    expect(e.status).toBe('POSTED');
    const pos = await positionBalance(gl, { accountId: cash.id, currencyCode: 'IRR', subsidiaryId: null });
    expect(pos.amount).toBe(-40_000_000n);
  });

  /**
   * دریافتِ ارزی هرگز بسته نمی‌شود — پول دارد **وارد** می‌شود. اگر نگهبان
   * جهت را اشتباه بگیرد، مشتری نمی‌تواند به ما دلار بدهد.
   */
  it('دریافتِ ارزی از مشتری، بی‌آنکه دلاری داشته باشیم، مجاز است', async () => {
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش ریالی',
      lines: [
        { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: 500_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 500_000_000n },
      ],
    }));
    const e = await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT',
      subsidiaryId: customer.id, currency: 'IRR', amount: '500000000',
      cashAccountCode: '110101', cashCurrency: 'USD', cashAmount: '500',
      dayRate: '1000000',
    }));
    expect(e.status).toBe('POSTED');
    const pos = await positionBalance(gl, { accountId: cash.id, currencyCode: 'USD', subsidiaryId: null });
    expect(pos.amount).toBe(50_000n);   // $۵۰۰ وارد شد
    const irr = await positionBalance(gl, { accountId: ar.id, currencyCode: 'IRR', subsidiaryId: customer.id });
    expect(irr.amount).toBe(0n);        // و بدهیِ ریالی دقیقاً صفر شد
  });
});
