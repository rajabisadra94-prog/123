/**
 * وصلهٔ هستهٔ قدیمی — قاعدهٔ توازن انتها‌به‌انتها اجبار می‌شود.
 *
 * پیش از این وصله، `postJournal` فقط با `assertBalanced` در لایهٔ برنامه محافظت
 * می‌شد. تریگر دیتابیس هم وجود داشت ولی چون در لحظهٔ COMMIT شلیک می‌کرد و
 * **Prisma خطای COMMIT را بی‌صدا می‌بلعد**، هر مسیری که `assertBalanced` را دور
 * می‌زد، سند را بی‌صدا گم می‌کرد.
 *
 * وصله: بعد از درج ردیف‌ها، `SET CONSTRAINTS "journal_must_balance" IMMEDIATE`
 * و بلافاصله `DEFERRED`.
 *
 * تلهٔ ظریفی که این تست قفل می‌کند: اگر به DEFERRED برنگردیم، حالت IMMEDIATE تا
 * پایان تراکنش می‌ماند و **سند دومِ همان تراکنش** بعد از اولین ردیفش ناتراز دیده
 * می‌شود و می‌شکند — یعنی تجدید ارزیابی (که سند تعدیل و سند برگشت را با هم می‌زند)
 * از کار می‌افتد.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { db, resetLedger, seedChart, makeCashAccount, n } from '../helpers/fixtures';
import { postJournal, getOrCreateControl } from '../../src/modules/accounting/accounting.service';

vi.mock('../../src/shared/utils/rates', () => ({
  getRates: async () => ({
    USD_TO_IRR: 100_000, CNY_TO_IRR: 14_000, USD_TO_CNY: 7.142857142857143,
    source: 'test', fetchedAt: new Date(), isStale: false,
  }),
}));

const AS_OF = new Date('2026-06-01T00:00:00Z');
let cash: { id: string };
let sales: { id: string };

beforeAll(async () => { await resetLedger(); await seedChart(); });
afterAll(async () => { await db.$disconnect(); });

beforeEach(async () => {
  await db.journalLine.deleteMany({});
  await db.journalEntry.deleteMany({});
  await db.financialAccount.deleteMany({ where: { code: null } });
  await db.financialAccount.updateMany({ data: { balance: 0 } });
  cash = await makeCashAccount('IRR');
  sales = await getOrCreateControl(db, 'SALES', 'IRR');
});

const pair = (amount: number) => ([
  { accountId: cash.id, debit: amount, currency: 'IRR' as const, rateToIRR: 1 },
  { accountId: sales.id, credit: amount, currency: 'IRR' as const, rateToIRR: 1 },
]);

describe('postJournal — اجبار توازن انتها‌به‌انتها', () => {
  it('سند تراز ثبت می‌شود و واقعاً در دفتر می‌ماند', async () => {
    const entry = await db.$transaction((tx) => postJournal(tx, {
      description: 'سند تراز', eventType: 'MANUAL', date: AS_OF, lines: pair(1_000_000),
    }));

    // نکتهٔ اصلی: شیء برگشتی وجود دارد **و** داده واقعاً ذخیره شده
    const persisted = await db.journalEntry.findUnique({ where: { id: entry.id } });
    expect(persisted).not.toBeNull();
    expect(await db.journalLine.count({ where: { entryId: entry.id } })).toBe(2);
  });

  it('دو سند در یک تراکنش هر دو ثبت می‌شوند — الگوی تجدید ارزیابی', async () => {
    // اگر وصله به DEFERRED برنگردد، همین تست می‌شکند.
    const [a, b] = await db.$transaction(async (tx) => {
      const first = await postJournal(tx, {
        description: 'تعدیل', eventType: 'MANUAL', date: AS_OF, lines: pair(1_000_000),
      });
      const second = await postJournal(tx, {
        description: 'برگشت', eventType: 'MANUAL', date: AS_OF, lines: pair(2_000_000),
      });
      return [first, second];
    }, { timeout: 30_000 });

    expect(await db.journalEntry.count()).toBe(2);
    expect(await db.journalLine.count()).toBe(4);
    expect(a.id).not.toBe(b.id);
  });

  it('سه سند پشت سر هم در یک تراکنش هم مشکلی ندارد', async () => {
    await db.$transaction(async (tx) => {
      for (const amount of [100_000, 200_000, 300_000]) {
        await postJournal(tx, {
          description: `سند ${amount}`, eventType: 'MANUAL', date: AS_OF, lines: pair(amount),
        });
      }
    }, { timeout: 30_000 });

    expect(await db.journalEntry.count()).toBe(3);
    expect(await db.journalLine.count()).toBe(6);
  });

  it('ماندهٔ مادی‌شده با دفتر هم‌خوان می‌ماند', async () => {
    await db.$transaction((tx) => postJournal(tx, {
      description: 'سند', eventType: 'MANUAL', date: AS_OF, lines: pair(1_500_000),
    }));

    const acc = await db.financialAccount.findUnique({ where: { id: cash.id } });
    const lines = await db.journalLine.findMany({ where: { accountId: cash.id } });
    const ledger = lines.reduce((s, l) => s + n(l.debit) - n(l.credit), 0);
    expect(n(acc!.balance)).toBe(ledger);
  });

  it('سند ناتراز در لایهٔ برنامه رد می‌شود — پیش از رسیدن به دیتابیس', async () => {
    await expect(db.$transaction((tx) => postJournal(tx, {
      description: 'ناتراز', eventType: 'MANUAL', date: AS_OF,
      lines: [
        { accountId: cash.id, debit: 1_000_000, currency: 'IRR', rateToIRR: 1 },
        { accountId: sales.id, credit: 900_000, currency: 'IRR', rateToIRR: 1 },
      ],
    }))).rejects.toThrow(/تراز نیست/);

    expect(await db.journalEntry.count()).toBe(0);
  });

  it('ثبت روی سرگروه رد می‌شود', async () => {
    const group = await db.financialAccount.findFirst({ where: { isPostable: false } });
    expect(group, 'چارت باید سرگروه داشته باشد').toBeTruthy();

    await expect(db.$transaction((tx) => postJournal(tx, {
      description: 'روی سرگروه', eventType: 'MANUAL', date: AS_OF,
      lines: [
        { accountId: group!.id, debit: 1_000, currency: 'IRR', rateToIRR: 1 },
        { accountId: sales.id, credit: 1_000, currency: 'IRR', rateToIRR: 1 },
      ],
    }))).rejects.toThrow();
  });
});
