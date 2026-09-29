/**
 * رفتار اثبات‌شدهٔ ۴ — تجدید ارزیابی پایان دوره با سند برگشت اجباری.
 *
 * چرا برگشت اجباری است: بدون آن، وقتی همان تعهد بعداً واقعاً تسویه شود
 * postSettlement دوباره تسعیر محقق را حساب می‌کند و سود **دوبار** شمرده می‌شود.
 * برای همین سند برگشت در **همان تراکنش** ساخته می‌شود، نه اینکه به یادآوری
 * انسانی سپرده شود.
 *
 * دو نکتهٔ دیگر که اینجا قفل می‌شوند:
 *  - ماندهٔ ارزی حساب‌ها دست نمی‌خورد؛ تعدیل فقط تومانی است (حساب‌های ۱۹۰۰/۲۹۰۰)
 *  - حساب سود/زیان از علامت netIRR اصلی انتخاب می‌شود، نه از مقدار معکوس‌شده،
 *    وگرنه سند برگشت به حساب مقابل می‌خورد و صورت سود و زیان دو قلم جعلی می‌گیرد
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { db, resetLedger, seedChart, makeCustomer, makeProducer, n } from '../helpers/fixtures';
import { postJournal, getOrCreateWallet, getOrCreateControl } from '../../src/modules/accounting/accounting.service';
import { previewRevaluation, postRevaluation } from '../../src/modules/accounting/revaluation';

vi.mock('../../src/shared/utils/rates', () => ({
  getRates: async () => ({
    USD_TO_IRR: 100_000, CNY_TO_IRR: 14_000, USD_TO_CNY: 7.142857142857143,
    source: 'test', fetchedAt: new Date(), isStale: false,
  }),
}));

const AS_OF = new Date('2026-03-20T12:00:00Z');

beforeAll(async () => { await resetLedger(); await seedChart(); });
afterAll(async () => { await db.$disconnect(); });

beforeEach(async () => {
  await db.journalLine.deleteMany({});
  await db.journalEntry.deleteMany({});
  await db.financialAccount.deleteMany({ where: { type: 'WALLET' } });
  await db.customer.deleteMany({});
  await db.producer.deleteMany({});
});

/** طلب دلاری روی مشتری با نرخ دفتری مشخص */
async function openUsdReceivable(customerId: string, amountUSD: number, rate: number) {
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

describe('تجدید ارزیابی پایان دوره', () => {
  it('پیش‌نمایش، سود تحقق‌نیافته را از اختلاف نرخ دفتری و نرخ دوره می‌سازد', async () => {
    const cust = await makeCustomer('مشتری ز', 'MZ1');
    await openUsdReceivable(cust.id, 100, 90_000);

    const preview = await db.$transaction((tx) =>
      previewRevaluation(tx, AS_OF, { USD: 100_000 }));

    // ۱۰۰ دلار: دفتری ۹٬۰۰۰٬۰۰۰ ، به نرخ دوره ۱۰٬۰۰۰٬۰۰۰ ⇒ سود ۱٬۰۰۰٬۰۰۰
    expect(preview.netIRR).toBeCloseTo(1_000_000, 2);
    expect(preview.totalGain).toBeCloseTo(1_000_000, 2);
    expect(preview.totalLoss).toBe(0);
    expect(preview.alreadyPosted).toBe(false);
  });

  it('ثبت، دو سند می‌سازد: تعدیل و برگشتِ روز بعد', async () => {
    const cust = await makeCustomer('مشتری ح', 'MH1');
    await openUsdReceivable(cust.id, 100, 90_000);

    const res: any = await db.$transaction((tx) =>
      postRevaluation(tx, { asOf: AS_OF, overrideRates: { USD: 100_000 } }), { timeout: 30_000 });

    expect(res.posted).toBe(true);
    expect(res.entryNo).toBeGreaterThan(0);
    expect(res.reversalEntryNo).toBeGreaterThan(res.entryNo);

    const adj = await db.journalEntry.findFirst({ where: { entryNo: res.entryNo } });
    const rev = await db.journalEntry.findFirst({ where: { entryNo: res.reversalEntryNo } });
    expect(adj!.eventType).toBe('FX_REVALUATION');
    expect(rev!.eventType).toBe('FX_REVALUATION_REVERSAL');
    // برگشت باید بعد از تاریخ تعدیل باشد (اول دورهٔ بعد)
    expect(rev!.date.getTime()).toBeGreaterThan(adj!.date.getTime());
  });

  it('تعدیل و برگشت روی هم اثر خالص صفر دارند', async () => {
    const cust = await makeCustomer('مشتری ط', 'MT1');
    await openUsdReceivable(cust.id, 100, 90_000);

    await db.$transaction((tx) =>
      postRevaluation(tx, { asOf: AS_OF, overrideRates: { USD: 100_000 } }), { timeout: 30_000 });

    const revalLines = await db.journalLine.findMany({
      where: { entry: { eventType: { in: ['FX_REVALUATION', 'FX_REVALUATION_REVERSAL'] } } },
    });
    const net = revalLines.reduce((s, l) => s + n(l.debit) * n(l.rateToIRR) - n(l.credit) * n(l.rateToIRR), 0);
    expect(net).toBeCloseTo(0, 2);
  });

  it('برگشت به همان حساب سود می‌خورد، نه به حساب زیان', async () => {
    // اگر انتخاب حساب از علامتِ معکوس‌شده انجام شود، برگشت روی حساب «زیان»
    // می‌نشیند و صورت سود و زیان دو قلم قرینهٔ جعلی می‌گیرد.
    const cust = await makeCustomer('مشتری ی', 'MY1');
    await openUsdReceivable(cust.id, 100, 90_000);

    await db.$transaction((tx) =>
      postRevaluation(tx, { asOf: AS_OF, overrideRates: { USD: 100_000 } }), { timeout: 30_000 });

    const fxLines = await db.journalLine.findMany({
      where: { entry: { eventType: { in: ['FX_REVALUATION', 'FX_REVALUATION_REVERSAL'] } } },
      include: { account: { select: { controlKind: true } } },
    });
    const kinds = new Set(
      fxLines.map((l) => l.account.controlKind).filter((k) => k?.startsWith('FX_')),
    );
    expect(kinds).toEqual(new Set(['FX_GAIN_UNREALIZED']));
    // یک بار بستانکار (تعدیل) و یک بار بدهکار (برگشت) روی همان حساب
    const gain = fxLines.filter((l) => l.account.controlKind === 'FX_GAIN_UNREALIZED');
    expect(gain).toHaveLength(2);
    expect(gain.some((l) => n(l.credit) > 0)).toBe(true);
    expect(gain.some((l) => n(l.debit) > 0)).toBe(true);
  });

  it('ماندهٔ ارزی حساب طرف‌حساب دست‌نخورده می‌ماند', async () => {
    const cust = await makeCustomer('مشتری ک', 'MK1');
    const wallet = await openUsdReceivable(cust.id, 100, 90_000);

    await db.$transaction((tx) =>
      postRevaluation(tx, { asOf: AS_OF, overrideRates: { USD: 100_000 } }), { timeout: 30_000 });

    const lines = await db.journalLine.findMany({ where: { accountId: wallet.id } });
    const usdBalance = lines.reduce((s, l) => s + n(l.debit) - n(l.credit), 0);
    expect(usdBalance).toBe(100); // هنوز دقیقاً ۱۰۰ دلار
  });

  it('تجدید ارزیابی تکراری برای همان دوره رد می‌شود', async () => {
    const cust = await makeCustomer('مشتری ل', 'ML1');
    await openUsdReceivable(cust.id, 100, 90_000);

    await db.$transaction((tx) =>
      postRevaluation(tx, { asOf: AS_OF, overrideRates: { USD: 100_000 } }), { timeout: 30_000 });

    await expect(db.$transaction((tx) =>
      postRevaluation(tx, { asOf: AS_OF, overrideRates: { USD: 100_000 } }), { timeout: 30_000 },
    )).rejects.toThrow();
  });

  it('بدهی ارزی با بالا رفتن نرخ، زیان تحقق‌نیافته می‌دهد', async () => {
    const prod = await makeProducer('سازنده ب');
    await db.$transaction(async (tx) => {
      const wallet = await getOrCreateWallet(tx, 'PRODUCER', prod.id, 'USD');
      const purchase = await getOrCreateControl(tx, 'PURCHASE', 'IRR');
      await postJournal(tx, {
        description: 'خرید دلاری', eventType: 'MANUAL', date: new Date('2026-01-01'),
        lines: [
          { accountId: purchase.id, debit: 100 * 90_000, currency: 'IRR', rateToIRR: 1 },
          { accountId: wallet.id, credit: 100, currency: 'USD', rateToIRR: 90_000 },
        ],
      });
    });

    const preview = await db.$transaction((tx) =>
      previewRevaluation(tx, AS_OF, { USD: 100_000 }));

    // بدهی ۱۰۰ دلاری گران‌تر شده ⇒ زیان
    expect(preview.totalLoss).toBeCloseTo(1_000_000, 2);
    expect(preview.netIRR).toBeCloseTo(-1_000_000, 2);
  });

  it('وقتی هیچ قلم ارزی بازی نیست، چیزی ثبت نمی‌شود', async () => {
    const res: any = await db.$transaction((tx) =>
      postRevaluation(tx, { asOf: AS_OF, overrideRates: { USD: 100_000 } }), { timeout: 30_000 });
    expect(res.posted).toBe(false);
    expect(await db.journalEntry.count()).toBe(0);
  });
});
