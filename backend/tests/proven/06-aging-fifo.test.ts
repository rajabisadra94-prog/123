/**
 * رفتار اثبات‌شدهٔ ۶ — سن‌بندی مطالبات و بدهی‌ها با تخصیص FIFO.
 *
 * قاعده: هر دریافتی، قدیمی‌ترین تعهد باز را می‌بندد. بدون FIFO، سن‌بندی یعنی
 * «کل مانده به تاریخ آخرین سند» که هیچ اطلاعاتی نمی‌دهد.
 *
 * ⚠️ درسی که اینجا قفل می‌شود: سن‌بندی از **تاریخ سند** می‌خواند، نه از تاریخ درج.
 * یک بار کشف شد که rebuildLedger تاریخ همهٔ فاکتورها را به امروز منتقل کرده بود و
 * همه چیز «۱ روزه» نشان می‌داد.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { db, resetLedger, seedChart, makeCustomer, n } from '../helpers/fixtures';
import { postJournal, getOrCreateWallet, getOrCreateControl } from '../../src/modules/accounting/accounting.service';
import { aging } from '../../src/modules/accounting/reports';

vi.mock('../../src/shared/utils/rates', () => ({
  getRates: async () => ({
    USD_TO_IRR: 100_000, CNY_TO_IRR: 14_000, USD_TO_CNY: 7.142857142857143,
    source: 'test', fetchedAt: new Date(), isStale: false,
  }),
}));

const AS_OF = new Date('2026-06-01T00:00:00Z');
const daysBefore = (d: number) => new Date(AS_OF.getTime() - d * 86_400_000);

beforeAll(async () => { await resetLedger(); await seedChart(); });
afterAll(async () => { await db.$disconnect(); });

beforeEach(async () => {
  await db.journalLine.deleteMany({});
  await db.journalEntry.deleteMany({});
  await db.financialAccount.deleteMany({ where: { type: 'WALLET' } });
  await db.customer.deleteMany({});
});

/** بدهکار کردن مشتری (تعهد جدید) در تاریخ مشخص */
async function invoice(customerId: string, amount: number, date: Date) {
  return db.$transaction(async (tx) => {
    const wallet = await getOrCreateWallet(tx, 'CUSTOMER', customerId, 'IRR');
    const sales = await getOrCreateControl(tx, 'SALES', 'IRR');
    await postJournal(tx, {
      description: 'فاکتور', eventType: 'MANUAL', date,
      lines: [
        { accountId: wallet.id, debit: amount, currency: 'IRR', rateToIRR: 1 },
        { accountId: sales.id, credit: amount, currency: 'IRR', rateToIRR: 1 },
      ],
    });
    return wallet;
  });
}

/** بستانکار کردن مشتری (دریافت) در تاریخ مشخص */
async function receipt(customerId: string, amount: number, date: Date) {
  await db.$transaction(async (tx) => {
    const wallet = await getOrCreateWallet(tx, 'CUSTOMER', customerId, 'IRR');
    const sales = await getOrCreateControl(tx, 'SALES', 'IRR');
    await postJournal(tx, {
      description: 'دریافت', eventType: 'MANUAL', date,
      lines: [
        { accountId: sales.id, debit: amount, currency: 'IRR', rateToIRR: 1 },
        { accountId: wallet.id, credit: amount, currency: 'IRR', rateToIRR: 1 },
      ],
    });
  });
}

const bucketOf = (row: any, key: string) => row.buckets[key] ?? 0;

describe('سن‌بندی FIFO', () => {
  it('تعهدها در سطل سنیِ تاریخ خودشان می‌نشینند', async () => {
    const cust = await makeCustomer('مشتری سن', 'AG1');
    await invoice(cust.id, 1_000_000, daysBefore(10));   // ۰-۳۰
    await invoice(cust.id, 2_000_000, daysBefore(45));   // ۳۱-۶۰
    await invoice(cust.id, 3_000_000, daysBefore(100));  // ۹۰+

    const res = await aging(db, 'RECEIVABLE', AS_OF);
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(bucketOf(row, '0-30')).toBe(1_000_000);
    expect(bucketOf(row, '31-60')).toBe(2_000_000);
    expect(bucketOf(row, '90+')).toBe(3_000_000);
    expect(row.balance).toBe(6_000_000);
  });

  it('دریافت، قدیمی‌ترین تعهد را اول می‌بندد', async () => {
    const cust = await makeCustomer('مشتری فیفو', 'AG2');
    await invoice(cust.id, 1_000_000, daysBefore(100)); // قدیمی
    await invoice(cust.id, 1_000_000, daysBefore(10));  // جدید
    await receipt(cust.id, 1_000_000, daysBefore(1));

    const res = await aging(db, 'RECEIVABLE', AS_OF);
    const row = res.rows[0];
    // تعهد قدیمی بسته شده؛ فقط تعهد ۱۰ روزه باید بماند
    expect(row.balance).toBe(1_000_000);
    expect(bucketOf(row, '0-30')).toBe(1_000_000);
    expect(bucketOf(row, '90+')).toBe(0);
    expect(row.oldestDays).toBe(10);
  });

  it('دریافت جزئی، تعهد قدیمی را نصفه می‌بندد', async () => {
    const cust = await makeCustomer('مشتری جزئی', 'AG3');
    await invoice(cust.id, 1_000_000, daysBefore(100));
    await invoice(cust.id, 1_000_000, daysBefore(10));
    await receipt(cust.id, 400_000, daysBefore(1));

    const row = (await aging(db, 'RECEIVABLE', AS_OF)).rows[0];
    expect(row.balance).toBe(1_600_000);
    expect(bucketOf(row, '90+')).toBe(600_000);   // ۱٬۰۰۰٬۰۰۰ − ۴۰۰٬۰۰۰
    expect(bucketOf(row, '0-30')).toBe(1_000_000);
  });

  it('تسویهٔ کامل، طرف‌حساب را از گزارش حذف می‌کند', async () => {
    const cust = await makeCustomer('مشتری تسویه', 'AG4');
    await invoice(cust.id, 1_000_000, daysBefore(50));
    await receipt(cust.id, 1_000_000, daysBefore(2));

    const res = await aging(db, 'RECEIVABLE', AS_OF);
    expect(res.rows).toHaveLength(0);
  });

  it('اسناد بعد از تاریخ گزارش دیده نمی‌شوند', async () => {
    const cust = await makeCustomer('مشتری آینده', 'AG5');
    await invoice(cust.id, 1_000_000, daysBefore(20));
    await invoice(cust.id, 5_000_000, new Date(AS_OF.getTime() + 10 * 86_400_000));

    const row = (await aging(db, 'RECEIVABLE', AS_OF)).rows[0];
    expect(row.balance).toBe(1_000_000);
  });

  it('سن از تاریخ سند خوانده می‌شود، نه از تاریخ درج رکورد', async () => {
    // همهٔ این اسناد همین الان درج می‌شوند ولی تاریخشان قدیمی است.
    // اگر پیاده‌سازی createdAt را بخواند، همه «۰ روزه» می‌شوند.
    const cust = await makeCustomer('مشتری تاریخ', 'AG6');
    await invoice(cust.id, 1_000_000, daysBefore(200));

    const row = (await aging(db, 'RECEIVABLE', AS_OF)).rows[0];
    expect(row.oldestDays).toBe(200);
    expect(bucketOf(row, '90+')).toBe(1_000_000);
  });

  it('طرف بدهی هم همان منطق را دارد', async () => {
    const cust = await makeCustomer('مشتری بدهی', 'AG7');
    await invoice(cust.id, 1_000_000, daysBefore(40));
    // سمت بدهی نباید مشتری را نشان دهد
    const payable = await aging(db, 'PAYABLE', AS_OF);
    expect(payable.rows.find((r: any) => r.ownerType === 'CUSTOMER')).toBeUndefined();
  });
});
