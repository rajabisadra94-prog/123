/**
 * رفتار اثبات‌شدهٔ ۷ — تشخیص حساب طبقه‌بندی‌نشده.
 *
 * باگ واقعی که این را ساخت: `getOrCreateDefaultCash` حسابی می‌ساخت که
 * `accountType` نداشت. آن حساب در ترازنامه در هیچ طبقه‌ای نمی‌نشست و معادلهٔ
 * حسابداری دقیقاً به اندازهٔ ماندهٔ همان حساب برقرار نمی‌شد — بدون هیچ خطایی.
 * ۲۱٬۲۴۵٬۰۸۲ تومان اختلاف که هیچ‌کس دلیلش را نمی‌دانست.
 *
 * درس: حسابی که گردش دارد ولی طبقه‌بندی ندارد باید **داد بزند**، نه اینکه
 * ساکت از تراز بیفتد.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { db, resetLedger, seedChart, makeCashAccount, n } from '../helpers/fixtures';
import { postJournal, getOrCreateControl, getOrCreateDefaultCash } from '../../src/modules/accounting/accounting.service';
import { integrityCheck, balanceSheet } from '../../src/modules/accounting/reports';

vi.mock('../../src/shared/utils/rates', () => ({
  getRates: async () => ({
    USD_TO_IRR: 100_000, CNY_TO_IRR: 14_000, USD_TO_CNY: 7.142857142857143,
    source: 'test', fetchedAt: new Date(), isStale: false,
  }),
}));

const AS_OF = new Date('2026-06-01T00:00:00Z');

beforeAll(async () => { await resetLedger(); await seedChart(); });
afterAll(async () => { await db.$disconnect(); });

beforeEach(async () => {
  await db.journalLine.deleteMany({});
  await db.journalEntry.deleteMany({});
  await db.financialAccount.deleteMany({ where: { code: null } });
  await db.financialAccount.updateMany({ data: { balance: 0 } });
});

describe('تشخیص سلامت دفاتر', () => {
  it('حسابِ دارای گردش بدون طبقه‌بندی گزارش می‌شود', async () => {
    // حسابی که عمداً accountType ندارد — همان اشتباهی که در تولید رخ داد
    const orphan = await db.financialAccount.create({
      data: { name: 'حساب بی‌طبقه', type: 'CASH', currency: 'IRR', ownerType: 'COMPANY', isPostable: true },
    });
    const sales = await getOrCreateControl(db, 'SALES', 'IRR');
    await db.$transaction((tx) => postJournal(tx, {
      description: 'گردش روی حساب بی‌طبقه', eventType: 'MANUAL', date: AS_OF,
      lines: [
        { accountId: orphan.id, debit: 5_000_000, currency: 'IRR', rateToIRR: 1 },
        { accountId: sales.id, credit: 5_000_000, currency: 'IRR', rateToIRR: 1 },
      ],
    }));

    const check = await integrityCheck(db);
    expect(check.ok).toBe(false);
    expect(check.unclassified.map((u: any) => u.id)).toContain(orphan.id);
    expect(check.unclassified.find((u: any) => u.id === orphan.id)!.balance).toBe(5_000_000);
  });

  it('ترازنامه مبلغ طبقه‌بندی‌نشده را جدا نشان می‌دهد، نه اینکه ساکت بیندازدش', async () => {
    const orphan = await db.financialAccount.create({
      data: { name: 'حساب بی‌طبقه ۲', type: 'CASH', currency: 'IRR', ownerType: 'COMPANY', isPostable: true },
    });
    const sales = await getOrCreateControl(db, 'SALES', 'IRR');
    await db.$transaction((tx) => postJournal(tx, {
      description: 'گردش', eventType: 'MANUAL', date: AS_OF,
      lines: [
        { accountId: orphan.id, debit: 7_000_000, currency: 'IRR', rateToIRR: 1 },
        { accountId: sales.id, credit: 7_000_000, currency: 'IRR', rateToIRR: 1 },
      ],
    }));

    const bs: any = await balanceSheet(db, AS_OF);
    // فهرست صریح حساب‌های بی‌طبقه، نه یک عدد مبهم
    expect(bs.unclassified.map((u: any) => u.id)).toContain(orphan.id);
    const row = bs.unclassified.find((u: any) => u.id === orphan.id);
    expect(Math.abs(n(row.balanceIRR))).toBeCloseTo(7_000_000, 2);
    // و معادلهٔ حسابداری دقیقاً به اندازهٔ همان مبلغ می‌شکند
    expect(Math.abs(n(bs.difference))).toBeCloseTo(7_000_000, 2);
  });

  it('حساب بدون گردش، حتی بدون طبقه‌بندی، هشدار نمی‌دهد', async () => {
    await db.financialAccount.create({
      data: { name: 'حساب خالی', type: 'CASH', currency: 'IRR', ownerType: 'COMPANY', isPostable: true },
    });
    const check = await integrityCheck(db);
    expect(check.unclassified).toHaveLength(0);
  });

  it('صندوق پیش‌فرض با طبقه‌بندی ساخته می‌شود — همان باگی که رفع شد', async () => {
    const cash = await db.$transaction((tx) => getOrCreateDefaultCash(tx, 'IRR'));
    expect(cash.accountType).toBe('ASSET');
    expect(cash.parentId).not.toBeNull();
    expect(cash.isPostable).toBe(true);
  });

  it('دفتر سالم ⇒ ok=true', async () => {
    const cash = await makeCashAccount('IRR');
    const sales = await getOrCreateControl(db, 'SALES', 'IRR');
    await db.$transaction((tx) => postJournal(tx, {
      description: 'سند سالم', eventType: 'MANUAL', date: AS_OF,
      lines: [
        { accountId: cash.id, debit: 1_000_000, currency: 'IRR', rateToIRR: 1 },
        { accountId: sales.id, credit: 1_000_000, currency: 'IRR', rateToIRR: 1 },
      ],
    }));

    const check = await integrityCheck(db);
    expect(check.unclassified).toHaveLength(0);
    expect(check.unbalanced).toHaveLength(0);
    expect(check.ok).toBe(true);
  });
});
