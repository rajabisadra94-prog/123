/**
 * رفتار اثبات‌شدهٔ ۵ — تبدیل ارز به‌خودی‌خود سود نمی‌سازد.
 *
 * باگی که این رفتار رفعش کرد: نسخهٔ قبلی هر تبدیل ارز را با نرخ روز ارزیابی می‌کرد
 * و اختلافش را «سود تسعیر» ثبت می‌کرد. نتیجه: صرفِ خریدن دلار، سود می‌ساخت.
 *
 * قاعدهٔ درست:
 *  - سمت خروجی به بهای تمام‌شدهٔ خودش از دفتر خارج می‌شود
 *  - سمت ورودی دقیقاً به همان بهایی می‌نشیند که بابتش پرداخت شده
 *  - سود/زیان فقط وقتی محقق می‌شود که ارز به تومان (نرخ قطعی ۱) فروخته شود
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { db, resetLedger, seedChart, makeCashAccount, n } from '../helpers/fixtures';
import { postConversion } from '../../src/modules/accounting/accounting.service';

vi.mock('../../src/shared/utils/rates', () => ({
  getRates: async () => ({
    USD_TO_IRR: 100_000, CNY_TO_IRR: 14_000, USD_TO_CNY: 7.142857142857143,
    source: 'test', fetchedAt: new Date(), isStale: false,
  }),
}));

let irrCash: { id: string };
let usdCash: { id: string };

beforeAll(async () => {
  await resetLedger();
  await seedChart();
});

afterAll(async () => { await db.$disconnect(); });

beforeEach(async () => {
  await db.journalLine.deleteMany({});
  await db.journalEntry.deleteMany({});
  await db.financialAccount.updateMany({ data: { balance: 0 } });
  irrCash = await makeCashAccount('IRR', `صندوق تومان ${Date.now()}`);
  usdCash = await makeCashAccount('USD', `صندوق دلار ${Date.now()}`);
});

/** ردیف‌های سند به‌همراه کد حساب */
async function linesOf(entryId: string) {
  return db.journalLine.findMany({
    where: { entryId },
    include: { account: { select: { code: true, controlKind: true, name: true } } },
  });
}

describe('تبدیل ارز', () => {
  it('خرید ارز هیچ سود یا زیانی ثبت نمی‌کند', async () => {
    // ۱۰ میلیون تومان می‌دهیم، ۱۰۰ دلار می‌گیریم ⇒ بهای تمام‌شده ۱۰۰٬۰۰۰ به‌ازای هر دلار
    const entry = await db.$transaction((tx) => postConversion(tx, {
      fromAccountId: irrCash.id, toAccountId: usdCash.id,
      fromAmount: 10_000_000, toAmount: 100,
    }));

    const lines = await linesOf(entry.id);
    expect(lines).toHaveLength(2); // فقط دو سمت تبدیل — هیچ ردیف تسعیری
    expect(lines.some((l) => l.account.controlKind?.startsWith('FX_'))).toBe(false);

    const usdLine = lines.find((l) => l.currency === 'USD')!;
    expect(n(usdLine.debit)).toBe(100);
    expect(n(usdLine.rateToIRR)).toBe(100_000); // نرخ واقعی پرداخت‌شده، نه نرخ روز
  });

  it('خرید ارز با نرخی متفاوت از نرخ روز هم سود نمی‌سازد', async () => {
    // نرخ روز ۱۰۰٬۰۰۰ است ولی ما گران‌تر خریدیم (۱۲۰٬۰۰۰). این ضرر نیست — بهای تمام‌شده است.
    const entry = await db.$transaction((tx) => postConversion(tx, {
      fromAccountId: irrCash.id, toAccountId: usdCash.id,
      fromAmount: 12_000_000, toAmount: 100,
    }));
    const lines = await linesOf(entry.id);
    expect(lines.some((l) => l.account.controlKind?.startsWith('FX_'))).toBe(false);
    expect(n(lines.find((l) => l.currency === 'USD')!.rateToIRR)).toBe(120_000);
  });

  it('فروش ارز بالاتر از بهای تمام‌شده، سود محقق ثبت می‌کند', async () => {
    // مرحله ۱: ۱۰۰ دلار به بهای ۱۰۰٬۰۰۰ می‌خریم
    await db.$transaction((tx) => postConversion(tx, {
      fromAccountId: irrCash.id, toAccountId: usdCash.id,
      fromAmount: 10_000_000, toAmount: 100,
    }));

    // مرحله ۲: همان ۱۰۰ دلار را ۱۲ میلیون تومان می‌فروشیم ⇒ سود واقعی ۲ میلیون
    const sale = await db.$transaction((tx) => postConversion(tx, {
      fromAccountId: usdCash.id, toAccountId: irrCash.id,
      fromAmount: 100, toAmount: 12_000_000,
    }));

    const lines = await linesOf(sale.id);
    const fx = lines.find((l) => l.account.controlKind?.startsWith('FX_'));
    expect(fx, 'ردیف تسعیر باید وجود داشته باشد').toBeTruthy();
    expect(fx!.account.controlKind).toBe('FX_GAIN_REALIZED');
    expect(n(fx!.credit)).toBeCloseTo(2_000_000, 2);
  });

  it('فروش ارز پایین‌تر از بهای تمام‌شده، زیان محقق ثبت می‌کند', async () => {
    await db.$transaction((tx) => postConversion(tx, {
      fromAccountId: irrCash.id, toAccountId: usdCash.id,
      fromAmount: 10_000_000, toAmount: 100,
    }));
    const sale = await db.$transaction((tx) => postConversion(tx, {
      fromAccountId: usdCash.id, toAccountId: irrCash.id,
      fromAmount: 100, toAmount: 9_000_000,
    }));
    const fx = (await linesOf(sale.id)).find((l) => l.account.controlKind?.startsWith('FX_'));
    expect(fx!.account.controlKind).toBe('FX_LOSS_REALIZED');
    expect(n(fx!.debit)).toBeCloseTo(1_000_000, 2);
  });

  it('خرید و فروش به همان نرخ ⇒ سود صفر و مانده ارزی صفر', async () => {
    await db.$transaction((tx) => postConversion(tx, {
      fromAccountId: irrCash.id, toAccountId: usdCash.id,
      fromAmount: 10_000_000, toAmount: 100,
    }));
    const sale = await db.$transaction((tx) => postConversion(tx, {
      fromAccountId: usdCash.id, toAccountId: irrCash.id,
      fromAmount: 100, toAmount: 10_000_000,
    }));
    expect((await linesOf(sale.id)).some((l) => l.account.controlKind?.startsWith('FX_'))).toBe(false);

    const usdLines = await db.journalLine.findMany({ where: { accountId: usdCash.id } });
    const net = usdLines.reduce((s, l) => s + n(l.debit) - n(l.credit), 0);
    expect(net).toBe(0);
  });

  it('تبدیل بین دو حساب هم‌ارز رد می‌شود', async () => {
    const other = await makeCashAccount('IRR', `صندوق دوم ${Date.now()}`);
    await expect(
      db.$transaction((tx) => postConversion(tx, {
        fromAccountId: irrCash.id, toAccountId: other.id,
        fromAmount: 1000, toAmount: 1000,
      })),
    ).rejects.toThrow();
  });
});
