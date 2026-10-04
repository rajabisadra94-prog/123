/**
 * رفتار اثبات‌شدهٔ ۳ — تسعیر محقق‌شده هنگام تسویه (روش temporal).
 *
 * مسئله: مشتری ۱۰۰ دلار بدهکار است که با نرخ ۹۰٬۰۰۰ ثبت شده. حالا ۹٬۵۰۰٬۰۰۰
 * تومان می‌پردازد. اگر طلب را به نرخ روز ببندیم، کیف دلاری‌اش هرگز صفر نمی‌شود.
 *
 * قاعدهٔ درست:
 *  - تعهد در **ارز خودش** و با **نرخ میانگین ثبتِ خودش** بسته می‌شود ⇒ کیف دقیقاً صفر
 *  - وجه نقد به ارز و نرخ واقعی خودش ثبت می‌شود
 *  - اختلاف ریالی دو سمت = سود/زیان تسعیر محقق‌شده
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  db, resetLedger, seedChart, makeCashAccount, makeCustomer, makeProducer, n,
} from '../helpers/fixtures';
import {
  postSettlement, postJournal, getOrCreateWallet, getOrCreateControl,
} from '../../src/modules/accounting/accounting.service';

vi.mock('../../src/shared/utils/rates', () => ({
  getRates: async () => ({
    USD_TO_IRR: 100_000, CNY_TO_IRR: 14_000, USD_TO_CNY: 7.142857142857143,
    source: 'test', fetchedAt: new Date(), isStale: false,
  }),
}));

beforeAll(async () => { await resetLedger(); await seedChart(); });
afterAll(async () => { await db.$disconnect(); });

beforeEach(async () => {
  await db.journalLine.deleteMany({});
  await db.journalEntry.deleteMany({});
  await db.financialAccount.deleteMany({ where: { type: { in: ['WALLET', 'CASH'] } } });
  await db.customer.deleteMany({});
  await db.producer.deleteMany({});
});

/** یک طلب دلاری روی مشتری با نرخ دلخواه باز می‌کند */
async function openReceivable(customerId: string, amountUSD: number, rate: number) {
  return db.$transaction(async (tx) => {
    const wallet = await getOrCreateWallet(tx, 'CUSTOMER', customerId, 'USD');
    const sales = await getOrCreateControl(tx, 'SALES', 'IRR');
    await postJournal(tx, {
      description: 'فروش دلاری', eventType: 'MANUAL', date: new Date('2026-01-01'),
      lines: [
        { accountId: wallet.id, debit: amountUSD, currency: 'USD', rateToIRR: rate },
        { accountId: sales.id, credit: amountUSD * rate, currency: 'IRR', rateToIRR: 1 },
      ],
    });
    return wallet;
  });
}

async function walletBalance(accountId: string) {
  const lines = await db.journalLine.findMany({ where: { accountId } });
  return lines.reduce((s, l) => s + n(l.debit) - n(l.credit), 0);
}

async function fxLineOf(entryId: string) {
  const lines = await db.journalLine.findMany({
    where: { entryId },
    include: { account: { select: { controlKind: true } } },
  });
  return lines.find((l) => l.account.controlKind?.startsWith('FX_'));
}

describe('تسویه با طرف حساب — تسعیر محقق‌شده', () => {
  it('دریافت بیشتر از ارزش دفتری ⇒ سود محقق، و کیف ارزی دقیقاً صفر', async () => {
    const cust = await makeCustomer('مشتری الف', 'MA1');
    const wallet = await openReceivable(cust.id, 100, 90_000);
    const cash = await makeCashAccount('IRR');

    const entry = await db.$transaction((tx) => postSettlement(tx, {
      direction: 'RECEIPT', ownerType: 'CUSTOMER', ownerId: cust.id,
      obligationCurrency: 'USD', settledAmount: 100,
      companyAccountId: cash.id, cashAmount: 9_500_000,
    }));

    // طلب دلاری کاملاً بسته شده — نه ۰٫۰۱ دلار باقی می‌ماند نه چیزی
    expect(await walletBalance(wallet.id)).toBe(0);

    const fx = await fxLineOf(entry.id);
    expect(fx!.account.controlKind).toBe('FX_GAIN_REALIZED');
    expect(n(fx!.credit)).toBeCloseTo(500_000, 2);
  });

  it('دریافت کمتر از ارزش دفتری ⇒ زیان محقق', async () => {
    const cust = await makeCustomer('مشتری ب', 'MB1');
    await openReceivable(cust.id, 100, 90_000);
    const cash = await makeCashAccount('IRR');

    const entry = await db.$transaction((tx) => postSettlement(tx, {
      direction: 'RECEIPT', ownerType: 'CUSTOMER', ownerId: cust.id,
      obligationCurrency: 'USD', settledAmount: 100,
      companyAccountId: cash.id, cashAmount: 8_700_000,
    }));

    const fx = await fxLineOf(entry.id);
    expect(fx!.account.controlKind).toBe('FX_LOSS_REALIZED');
    expect(n(fx!.debit)).toBeCloseTo(300_000, 2);
  });

  it('تسویه به همان ارزش دفتری ⇒ هیچ ردیف تسعیری ثبت نمی‌شود', async () => {
    const cust = await makeCustomer('مشتری ج', 'MC1');
    await openReceivable(cust.id, 100, 90_000);
    const cash = await makeCashAccount('IRR');

    const entry = await db.$transaction((tx) => postSettlement(tx, {
      direction: 'RECEIPT', ownerType: 'CUSTOMER', ownerId: cust.id,
      obligationCurrency: 'USD', settledAmount: 100,
      companyAccountId: cash.id, cashAmount: 9_000_000,
    }));
    expect(await fxLineOf(entry.id)).toBeUndefined();
  });

  it('نرخ تعهد میانگین موزون است، نه نرخ آخرین سند', async () => {
    const cust = await makeCustomer('مشتری د', 'MD1');
    // ۱۰۰ دلار با ۹۰٬۰۰۰ و ۱۰۰ دلار با ۱۱۰٬۰۰۰ ⇒ میانگین ۱۰۰٬۰۰۰
    await openReceivable(cust.id, 100, 90_000);
    await openReceivable(cust.id, 100, 110_000);
    const cash = await makeCashAccount('IRR');

    // کل ۲۰۰ دلار را به ارزش میانگین (۲۰ میلیون) تسویه می‌کنیم ⇒ سود صفر
    const entry = await db.$transaction((tx) => postSettlement(tx, {
      direction: 'RECEIPT', ownerType: 'CUSTOMER', ownerId: cust.id,
      obligationCurrency: 'USD', settledAmount: 200,
      companyAccountId: cash.id, cashAmount: 20_000_000,
    }));
    expect(await fxLineOf(entry.id)).toBeUndefined();
  });

  it('پرداخت به سازنده: کمتر از بدهی دفتری ⇒ سود محقق', async () => {
    const prod = await makeProducer('سازنده الف');
    await db.$transaction(async (tx) => {
      const wallet = await getOrCreateWallet(tx, 'PRODUCER', prod.id, 'USD');
      const purchase = await getOrCreateControl(tx, 'PURCHASE', 'IRR');
      await postJournal(tx, {
        description: 'خرید دلاری', eventType: 'MANUAL', date: new Date('2026-01-01'),
        lines: [
          { accountId: purchase.id, debit: 100 * 95_000, currency: 'IRR', rateToIRR: 1 },
          { accountId: wallet.id, credit: 100, currency: 'USD', rateToIRR: 95_000 },
        ],
      });
    });
    const cash = await makeCashAccount('IRR');

    const entry = await db.$transaction((tx) => postSettlement(tx, {
      direction: 'PAYMENT', ownerType: 'PRODUCER', ownerId: prod.id,
      obligationCurrency: 'USD', settledAmount: 100,
      companyAccountId: cash.id, cashAmount: 9_000_000, // بدهی دفتری ۹٬۵۰۰٬۰۰۰ بود
    }));

    const fx = await fxLineOf(entry.id);
    expect(fx!.account.controlKind).toBe('FX_GAIN_REALIZED');
    expect(n(fx!.credit)).toBeCloseTo(500_000, 2);
  });

  it('تسویه با حساب داخلی شرکت رد می‌شود', async () => {
    const cash = await makeCashAccount('IRR');
    await expect(db.$transaction((tx) => postSettlement(tx, {
      direction: 'RECEIPT', ownerType: 'COMPANY', ownerId: 'x',
      obligationCurrency: 'USD', settledAmount: 1,
      companyAccountId: cash.id, cashAmount: 1,
    }))).rejects.toThrow();
  });

  it('مبلغ صفر یا منفی رد می‌شود', async () => {
    const cust = await makeCustomer('مشتری ه', 'ME1');
    const cash = await makeCashAccount('IRR');
    await expect(db.$transaction((tx) => postSettlement(tx, {
      direction: 'RECEIPT', ownerType: 'CUSTOMER', ownerId: cust.id,
      obligationCurrency: 'USD', settledAmount: 0,
      companyAccountId: cash.id, cashAmount: 100,
    }))).rejects.toThrow();
  });
});
