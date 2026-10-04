/**
 * رفتار اثبات‌شدهٔ ۸ — سند باطل‌شده از تجمیع مانده حذف نمی‌شود.
 *
 * باگی که یک بار نوشته شد و پیش از استقرار گرفته شد:
 *   where: { status: { not: 'REVERSED' } }
 *
 * منطقش وسوسه‌کننده است («سند باطل‌شده را نشمار») ولی نتیجه‌اش وارونه است:
 * سند اصلی حذف می‌شود و **سند برگشتی‌اش می‌ماند**، پس مانده به‌جای صفر شدن،
 * قرینهٔ مبلغ اصلی می‌شود.
 *
 * قاعدهٔ درست: هر دو سند بمانند و خودشان همدیگر را خنثی کنند.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { db, resetLedger, seedChart, makeCashAccount, n } from '../helpers/fixtures';
import { postJournal, getOrCreateControl, reverseJournal } from '../../src/modules/accounting/accounting.service';
import { accountTotals, trialBalance } from '../../src/modules/accounting/reports';

vi.mock('../../src/shared/utils/rates', () => ({
  getRates: async () => ({
    USD_TO_IRR: 100_000, CNY_TO_IRR: 14_000, USD_TO_CNY: 7.142857142857143,
    source: 'test', fetchedAt: new Date(), isStale: false,
  }),
}));

const AS_OF = new Date('2026-06-01T00:00:00Z');
let cash: { id: string };

beforeAll(async () => { await resetLedger(); await seedChart(); });
afterAll(async () => { await db.$disconnect(); });

beforeEach(async () => {
  await db.journalLine.deleteMany({});
  await db.journalEntry.deleteMany({});
  await db.financialAccount.deleteMany({ where: { code: null } });
  await db.financialAccount.updateMany({ data: { balance: 0 } });
  cash = await makeCashAccount('IRR');
});

async function postAndReverse(amount: number) {
  const sales = await getOrCreateControl(db, 'SALES', 'IRR');
  const entry = await db.$transaction((tx) => postJournal(tx, {
    description: 'سند اصلی', eventType: 'MANUAL', date: AS_OF,
    lines: [
      { accountId: cash.id, debit: amount, currency: 'IRR', rateToIRR: 1 },
      { accountId: sales.id, credit: amount, currency: 'IRR', rateToIRR: 1 },
    ],
  }));
  await db.$transaction((tx) => reverseJournal(tx, entry.id, { reason: 'تست' }), { timeout: 30_000 });
  return entry;
}

describe('سند باطل‌شده و سند برگشتی', () => {
  it('پس از ابطال، ماندهٔ حساب دقیقاً صفر می‌شود', async () => {
    await postAndReverse(5_000_000);

    const totals = await accountTotals(db, { to: AS_OF });
    const row = totals.find((t: any) => t.accountId === cash.id);
    const net = row ? n(row.debit) - n(row.credit) : 0;
    expect(net).toBe(0);
  });

  it('هر دو سند در دفتر باقی می‌مانند — ابطال حذف نیست', async () => {
    const entry = await postAndReverse(5_000_000);

    const original = await db.journalEntry.findUnique({ where: { id: entry.id } });
    expect(original).not.toBeNull();
    expect(original!.status).toBe('REVERSED');

    const reversal = await db.journalEntry.findFirst({ where: { reversesId: entry.id } });
    expect(reversal).not.toBeNull();

    // چهار ردیف: دو تا اصلی، دو تا برگشتی
    expect(await db.journalLine.count()).toBe(4);
  });

  it('اگر سند باطل‌شده فیلتر شود، مانده قرینه می‌شود — نه صفر', async () => {
    await postAndReverse(5_000_000);

    // شبیه‌سازی همان باگ: فقط ردیف‌های اسنادِ غیر REVERSED را جمع بزن
    const buggy = await db.journalLine.findMany({
      where: { accountId: cash.id, entry: { status: { not: 'REVERSED' } } },
    });
    const buggyNet = buggy.reduce((s, l) => s + n(l.debit) - n(l.credit), 0);
    expect(buggyNet).toBe(-5_000_000); // ← نتیجهٔ غلطی که باید از آن پرهیز شود

    // روش درست: هیچ فیلتری روی وضعیت نیست
    const correct = await db.journalLine.findMany({ where: { accountId: cash.id } });
    const correctNet = correct.reduce((s, l) => s + n(l.debit) - n(l.credit), 0);
    expect(correctNet).toBe(0);
  });

  it('تراز آزمایشی بعد از ابطال همچنان تراز است', async () => {
    await postAndReverse(5_000_000);
    const tb: any = await trialBalance(db, AS_OF);
    expect(n(tb.totalDebit)).toBeCloseTo(n(tb.totalCredit), 2);
  });

  it('ابطالِ دوبارهٔ یک سند رد می‌شود', async () => {
    const sales = await getOrCreateControl(db, 'SALES', 'IRR');
    const entry = await db.$transaction((tx) => postJournal(tx, {
      description: 'سند', eventType: 'MANUAL', date: AS_OF,
      lines: [
        { accountId: cash.id, debit: 1_000_000, currency: 'IRR', rateToIRR: 1 },
        { accountId: sales.id, credit: 1_000_000, currency: 'IRR', rateToIRR: 1 },
      ],
    }));
    await db.$transaction((tx) => reverseJournal(tx, entry.id, { reason: 'یک' }), { timeout: 30_000 });
    await expect(
      db.$transaction((tx) => reverseJournal(tx, entry.id, { reason: 'دو' }), { timeout: 30_000 }),
    ).rejects.toThrow();
  });
});
