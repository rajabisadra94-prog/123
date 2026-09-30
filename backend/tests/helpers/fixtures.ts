import { PrismaClient, Currency } from '@prisma/client';
import { testDatabaseUrl } from './db-url';
import { ensureChartOfAccounts, CASH_PARENT_CODE } from '../../src/modules/accounting/chartOfAccounts';
import { resetBusinessData } from './cleanup';

/**
 * کلاینت مخصوص تست — صراحتاً به دیتابیس تست وصل می‌شود.
 * به singleton برنامه تکیه نمی‌کنیم تا هیچ تستی به‌اشتباه روی دیتابیس توسعه ننویسد.
 */
export const db = new PrismaClient({
  datasources: { db: { url: testDatabaseUrl() } },
  log: ['error'],
});

/** نرخ‌های ثابت تست — هیچ تستی نباید به شبکه یا نرخ روز وابسته باشد */
export const FIXED_RATES = {
  USD_TO_IRR: 100_000,
  CNY_TO_IRR: 14_000,
  USD_TO_CNY: 7.142857142857143,
  source: 'test',
  isStale: false,
};

/**
 * پاک‌کردن کامل دفتر و حساب‌ها بین تست‌ها.
 *
 * دادهٔ کسب‌وکاری با ترتیب مشترک `cleanup.ts` پاک می‌شود، نه با فهرست دستی —
 * فهرست ناقص اینجا باعث می‌شد `beforeAll` این فایل‌ها با خطای کلید خارجی بشکند
 * و **کل** تست‌هایشان skip شود، آن هم فقط وقتی فایل دیگری پروژه‌ای جا گذاشته بود.
 */
export async function resetLedger() {
  await db.$transaction(async (tx) => {
    await tx.journalLine.deleteMany({});
    await tx.journalEntryRevision.deleteMany({});
    await tx.journalEntry.deleteMany({});
    await tx.financialAccount.deleteMany({});
    await tx.fiscalPeriod.deleteMany({});
  });
  await resetBusinessData(db);
}

/** چارت استاندارد را می‌سازد و نگاشت کد→شناسه می‌دهد */
export async function seedChart() {
  return db.$transaction((tx) => ensureChartOfAccounts(tx), { timeout: 60_000 });
}

/** یک حساب نقدی شرکت زیر گرهٔ «نقد و بانک» */
export async function makeCashAccount(currency: Currency, name = `صندوق ${currency}`) {
  const parent = await db.financialAccount.findUnique({
    where: { code: CASH_PARENT_CODE },
    select: { id: true },
  });
  return db.financialAccount.create({
    data: {
      name, type: 'CASH', currency, ownerType: 'COMPANY',
      accountType: 'ASSET', parentId: parent?.id ?? null, isPostable: true,
    },
  });
}

export async function makeCustomer(name = 'مشتری تست', shortCode = 'TS1') {
  return db.customer.create({ data: { name, shortCode } });
}

export async function makeProducer(name = 'سازنده تست') {
  return db.producer.create({ data: { name } });
}

/** مبلغ‌ها به‌صورت Decimal برمی‌گردند؛ برای مقایسه به عدد تبدیلشان می‌کنیم */
export const n = (v: unknown) => Number(v);

/** جمع بدهکار و بستانکار یک سند به تومان */
export async function entryTotals(entryId: string) {
  const lines = await db.journalLine.findMany({ where: { entryId } });
  const debit = lines.reduce((s, l) => s + n(l.debit) * n(l.rateToIRR), 0);
  const credit = lines.reduce((s, l) => s + n(l.credit) * n(l.rateToIRR), 0);
  return { debit, credit, lines };
}
