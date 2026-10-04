/**
 * رفتار اثبات‌شدهٔ ۱ — اجبار توازن در سطح دیتابیس با تریگر معوق.
 *
 * چرا تریگر معمولی کار نمی‌کند: ردیف‌های سند یکی‌یکی درج می‌شوند، پس یک تریگر
 * AFTER INSERT بعد از اولین ردیف شلیک می‌کند و همیشه سند را ناتراز می‌بیند.
 * راه‌حل: CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED که ارزیابی‌اش تا
 * پایان تراکنش عقب می‌افتد.
 *
 * ⚠️ نکتهٔ حیاتی که در فاز ۲الف کشف شد — «SET CONSTRAINTS ALL IMMEDIATE»:
 *
 * تریگر معوق در لحظهٔ COMMIT شلیک می‌کند. Prisma (۵.۲۲) خطای COMMIT را
 * **بی‌صدا می‌بلعد**: تراکنش رد می‌شود و هیچ داده‌ای ذخیره نمی‌شود، ولی
 * `$transaction` با موفقیت برمی‌گردد و شیء سند را تحویل می‌دهد. یعنی برنامه
 * فکر می‌کند سند ثبت شده در حالی که دفتر خالی است — گم‌شدن بی‌صدای داده.
 *
 * درمان: پیش از پایان callback، `SET CONSTRAINTS ALL IMMEDIATE` اجرا شود.
 * این کار تریگر معوق را همان‌جا داخل تراکنش شلیک می‌کند، جایی که خطا درست
 * منتشر می‌شود. موتور جدید **باید** هر تراکنش ثبت را این‌طور ببندد.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { db, resetLedger, seedChart, makeCashAccount } from '../helpers/fixtures';

let irrCash: { id: string };
let usdCash: { id: string };

type L = { accountId: string; debit?: number; credit?: number; currency: 'IRR' | 'USD'; rate: number };

beforeAll(async () => {
  await resetLedger();
  await seedChart();
  irrCash = await makeCashAccount('IRR');
  usdCash = await makeCashAccount('USD');
});

afterAll(async () => { await db.$disconnect(); });

beforeEach(async () => {
  await db.journalLine.deleteMany({});
  await db.journalEntry.deleteMany({});
});

/**
 * درج مستقیم سند، بدون عبور از سرویس — چون قاعده باید در دیتابیس بسته باشد
 * حتی اگر کسی مسیر اپلیکیشن را دور بزند.
 * @param immediate تریگر معوق را پیش از پایان تراکنش شلیک کن (رفتار موتور جدید)
 */
async function rawPost(lines: L[], immediate = true) {
  return db.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({
      data: { description: 'تست تریگر', eventType: 'MANUAL', date: new Date() },
    });
    for (const l of lines) {
      await tx.journalLine.create({
        data: {
          entryId: entry.id, accountId: l.accountId,
          debit: l.debit ?? 0, credit: l.credit ?? 0,
          currency: l.currency, rateToIRR: l.rate,
        },
      });
    }
    if (immediate) await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    return entry;
  });
}

describe('تریگر توازن سند', () => {
  it('سند تراز ثبت می‌شود', async () => {
    const entry = await rawPost([
      { accountId: irrCash.id, debit: 1_000_000, currency: 'IRR', rate: 1 },
      { accountId: usdCash.id, credit: 10, currency: 'USD', rate: 100_000 },
    ]);
    expect(await db.journalLine.count({ where: { entryId: entry.id } })).toBe(2);
  });

  it('سند ناتراز رد می‌شود و چیزی باقی نمی‌ماند', async () => {
    await expect(rawPost([
      { accountId: irrCash.id, debit: 1_000_000, currency: 'IRR', rate: 1 },
      { accountId: usdCash.id, credit: 9, currency: 'USD', rate: 100_000 }, // ۹۰۰٬۰۰۰ ≠ ۱٬۰۰۰٬۰۰۰
    ])).rejects.toThrow();

    expect(await db.journalLine.count()).toBe(0);
    expect(await db.journalEntry.count()).toBe(0);
  });

  it('سند تک‌ردیفی رد می‌شود (سند حداقل دو ردیف دارد)', async () => {
    await expect(rawPost([
      { accountId: irrCash.id, debit: 0, credit: 0, currency: 'IRR', rate: 1 },
    ])).rejects.toThrow();
  });

  it('ردیف‌های میانی می‌توانند ناتراز باشند — فقط پایان تراکنش سنجیده می‌شود', async () => {
    // اگر تریگر معوق نبود، همین سند سه‌ردیفی بعد از ردیف اول شکست می‌خورد
    const entry = await rawPost([
      { accountId: irrCash.id, debit: 3_000_000, currency: 'IRR', rate: 1 },
      { accountId: usdCash.id, credit: 10, currency: 'USD', rate: 100_000 },
      { accountId: irrCash.id, credit: 2_000_000, currency: 'IRR', rate: 1 },
    ]);
    expect(await db.journalLine.count({ where: { entryId: entry.id } })).toBe(3);
  });

  it('تراز به ارز پایه سنجیده می‌شود، نه به تفکیک ارز', async () => {
    // یک سمت دلار و سمت دیگر تومان — به تفکیک ارز ناتراز، به تومان تراز
    const entry = await rawPost([
      { accountId: usdCash.id, debit: 5, currency: 'USD', rate: 100_000 },
      { accountId: irrCash.id, credit: 500_000, currency: 'IRR', rate: 1 },
    ]);
    expect(await db.journalLine.count({ where: { entryId: entry.id } })).toBe(2);
  });

  it('حذف یکی از ردیف‌ها سند را ناتراز می‌کند و رد می‌شود', async () => {
    const entry = await rawPost([
      { accountId: irrCash.id, debit: 1_000_000, currency: 'IRR', rate: 1 },
      { accountId: usdCash.id, credit: 10, currency: 'USD', rate: 100_000 },
    ]);
    const line = await db.journalLine.findFirst({ where: { entryId: entry.id } });
    await expect(db.journalLine.delete({ where: { id: line!.id } })).rejects.toThrow();
  });

  describe('بدون SET CONSTRAINTS ALL IMMEDIATE — نقص شناخته‌شده', () => {
    it('سند ناتراز بی‌صدا گم می‌شود: تراکنش موفق برمی‌گردد ولی دفتر خالی است', async () => {
      // این تست نقص را **ثبت** می‌کند تا موتور جدید دوباره داخلش نیفتد.
      const entry = await rawPost([
        { accountId: irrCash.id, debit: 1_000_000, currency: 'IRR', rate: 1 },
        { accountId: usdCash.id, credit: 9, currency: 'USD', rate: 100_000 },
      ], /* immediate */ false);

      // Prisma یک سند کامل با شماره تحویل می‌دهد …
      expect(entry.entryNo).toBeGreaterThan(0);
      // … ولی PostgreSQL کل تراکنش را برگردانده و هیچ‌چیز ذخیره نشده
      expect(await db.journalEntry.count()).toBe(0);
      expect(await db.journalLine.count()).toBe(0);
    });
  });
});
