/**
 * فاز ۵ — دفاتر و گزارش‌ها.
 *
 * سنجهٔ اصلی هر گزارش این است که با **دفتر** بخواند، نه با انتظار من.
 * پس هرجا ممکن بوده، به‌جای عدد ثابت، رابطهٔ حسابداری سنجیده می‌شود:
 * تراز آزمایشی باید تراز باشد، ترازنامه باید معادله را ببندد، و جمع سه دستهٔ
 * جریان نقد باید برابر تغییر واقعی ماندهٔ نقد باشد.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D, DEFAULT_DATE, resetBusinessData,
} from '../helpers/gl';
import { ensureSubsidiary } from '../../src/modules/ledger/subsidiary';
import { ensureDefaultCostCenters } from '../../src/modules/ledger/costcenter';
import { post, reverse } from '../../src/modules/ledger/poster';
import { journal, accountLedger, trialBalance } from '../../src/modules/ledger/reports/ledgers';
import {
  balanceSheet, incomeStatement, cashFlow, aging, classifyCounterpart,
} from '../../src/modules/ledger/reports/statements';

let fy: { id: string };
let ar: any, payable: any, sales: any, cash: any, cogs: any, capital: any, payrollAcc: any;
let customer: any, producer: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
  ar = await accountByCode('1104');
  payable = await accountByCode('2101');
  sales = await accountByCode('4101');
  cash = await accountByCode('110101');
  cogs = await accountByCode('5101');
  capital = await accountByCode('3101');
  payrollAcc = await accountByCode('6101');
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl();
  await resetBusinessData();
  await gl.customer.deleteMany({});
  await gl.producer.deleteMany({});
  fy = await makeFiscalYear();
  await tx((t) => ensureDefaultCostCenters(t));

  const c = await gl.customer.create({ data: { name: 'احترامیان', shortCode: 'RP1' } });
  const p = await gl.producer.create({ data: { name: 'Sun' } });
  customer = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
  producer = await tx((t) => ensureSubsidiary(t, 'PRODUCER', 'Producer', p.id, p.name));
});

const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

/** سرمایه‌گذاری اولیه + یک فروش + یک خرید + یک دریافت */
async function seedActivity() {
  await entry(D('2026-04-01'), 'آوردهٔ سرمایه', [
    { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000_000n },
    { accountId: capital.id, currencyCode: 'IRR', credit: 1_000_000_000n },
  ]);
  await entry(D('2026-05-01'), 'فروش نسیه', [
    { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: 300_000_000n },
    { accountId: sales.id, currencyCode: 'IRR', credit: 300_000_000n },
  ]);
  await entry(D('2026-05-10'), 'خرید نسیه', [
    { accountId: cogs.id, currencyCode: 'IRR', debit: 180_000_000n },
    { accountId: payable.id, subsidiaryId: producer.id, currencyCode: 'IRR', credit: 180_000_000n },
  ]);
  await entry(D('2026-06-01'), 'دریافت از مشتری', [
    { accountId: cash.id, currencyCode: 'IRR', debit: 120_000_000n },
    { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', credit: 120_000_000n },
  ]);
}

// ═══════════════════════════════════════════════════════════════
describe('دفتر روزنامه', () => {
  it('اسناد به ترتیب تاریخ و سریال می‌آیند', async () => {
    await seedActivity();
    const rows = await journal(gl);

    expect(rows).toHaveLength(8);      // چهار سند دوردیفی
    const serials = [...new Set(rows.map((r) => r.serial))];
    expect(serials).toEqual([1, 2, 3, 4]);

    const dates = rows.map((r) => r.date.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it('بازهٔ تاریخی فیلتر می‌شود', async () => {
    await seedActivity();
    const rows = await journal(gl, { from: D('2026-05-01'), to: D('2026-05-31') });
    expect([...new Set(rows.map((r) => r.serial))]).toEqual([2, 3]);
  });

  it('سند باطل‌شده و برگشتی‌اش هر دو در دفتر می‌مانند', async () => {
    const e = await entry(DEFAULT_DATE, 'سند اشتباه', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 5_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 5_000_000n },
    ]);
    await tx((t) => reverse(t, e.id, { reason: 'اشتباه' }));

    const rows = await journal(gl);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.status === 'REVERSED')).toHaveLength(2);
  });

  it('ممیزی ب۱۲: جستجوی متنِ شرح', async () => {
    await seedActivity();
    const rows = await journal(gl, { q: 'خرید' });
    expect([...new Set(rows.map((r) => r.serial))]).toEqual([3]);
  });

  it('ممیزی ب۱۲: فیلتر شمارهٔ سند', async () => {
    await seedActivity();
    const rows = await journal(gl, { serial: 2 });
    expect([...new Set(rows.map((r) => r.serial))]).toEqual([2]);
    expect(rows.every((r) => r.description === 'فروش نسیه')).toBe(true);
  });

  it('ممیزی ب۱۲: فیلتر پیشوندِ کد حساب (همهٔ گروه ۵)', async () => {
    await seedActivity();
    const rows = await journal(gl, { accountCode: '5' });
    // فقط سندِ خرید یک ردیفِ گروه ۵ دارد ⟵ کل آن سند (۲ ردیف) برمی‌گردد
    expect([...new Set(rows.map((r) => r.serial))]).toEqual([3]);
    expect(rows).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('دفتر حساب', () => {
  it('مانده در حال حرکت درست جمع می‌شود', async () => {
    await seedActivity();
    const led = await accountLedger(gl, '110101');

    expect(led.rows).toHaveLength(2);
    expect(led.rows[0].running).toBe(1_000_000_000n);
    expect(led.rows[1].running).toBe(1_120_000_000n);
    expect(led.closingBalance).toBe(1_120_000_000n);
  });

  it('مانده ابتدای بازه به‌عنوان نقطهٔ شروع می‌آید', async () => {
    await seedActivity();
    const led = await accountLedger(gl, '110101', { from: D('2026-05-15') });

    expect(led.openingBalance).toBe(1_000_000_000n);   // آوردهٔ فروردین
    expect(led.rows).toHaveLength(1);                   // فقط دریافت خرداد
    expect(led.closingBalance).toBe(1_120_000_000n);
  });

  it('فیلتر تفصیلی، دفتر یک طرف‌حساب را می‌دهد', async () => {
    await seedActivity();
    const led = await accountLedger(gl, '1104', {}, { subsidiaryId: customer.id });
    expect(led.closingBalance).toBe(180_000_000n);      // ۳۰۰ − ۱۲۰
  });
});

// ═══════════════════════════════════════════════════════════════
describe('تراز آزمایشی', () => {
  it('در هر چهار حالت ستونی، تراز است', async () => {
    await seedActivity();
    for (const columns of [2, 4, 6, 8] as const) {
      const tb = await trialBalance(gl, { from: D('2026-05-01'), to: D('2026-06-30') }, columns);
      expect(tb.valueColumns).toHaveLength(columns);

      // هر جفت ستون بدهکار/بستانکار باید با هم برابر باشند
      for (let i = 0; i < columns; i += 2) {
        const dr = tb.totals[tb.valueColumns[i]];
        const cr = tb.totals[tb.valueColumns[i + 1]];
        expect(dr, `ستون ${tb.valueColumns[i]} در حالت ${columns}`).toBe(cr);
      }
    }
  });

  it('۸ ستونی: گردش تجمعی = مانده ابتدا + گردش دوره', async () => {
    await seedActivity();
    const tb = await trialBalance(gl, { from: D('2026-05-01') }, 8);
    for (const r of tb.rows) {
      expect(BigInt(r.cumulativeDebit)).toBe(BigInt(r.openingDebit) + BigInt(r.periodDebit));
      expect(BigInt(r.cumulativeCredit)).toBe(BigInt(r.openingCredit) + BigInt(r.periodCredit));
    }
  });

  it('تجمیع سطحی: سرگروه جمع نوادگانش را نشان می‌دهد', async () => {
    await seedActivity();
    const tb = await trialBalance(gl, {}, 2);
    const assets = tb.rows.find((r) => r.code === '1')!;
    const cashRow = tb.rows.find((r) => r.code === '110101')!;
    const arRow = tb.rows.find((r) => r.code === '1104')!;

    expect(BigInt(assets.closingDebit))
      .toBe(BigInt(cashRow.closingDebit) + BigInt(arRow.closingDebit));
  });

  it('فیلتر سطح، تفصیلی‌ها را کنار می‌گذارد', async () => {
    await seedActivity();
    const tb = await trialBalance(gl, { level: 2 }, 2);
    expect(tb.rows.every((r) => r.level <= 2)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ترازنامه', () => {
  it('معادلهٔ حسابداری برقرار است', async () => {
    await seedActivity();
    const bs = await balanceSheet(gl, D('2026-06-30'));

    expect(bs.balanced).toBe(true);
    expect(bs.difference).toBe(0n);
    // دارایی = نقد ۱٬۱۲۰ + دریافتنی ۱۸۰
    expect(bs.totals.assets).toBe(1_300_000_000n);
    // بدهی ۱۸۰ + سرمایه ۱٬۰۰۰ + سود انباشته ۱۲۰
    expect(bs.totals.liabilities).toBe(180_000_000n);
    expect(bs.totals.equity).toBe(1_000_000_000n);
    expect(bs.totals.retainedEarnings).toBe(120_000_000n);
  });

  it('بعد از ابطال یک سند، همچنان تراز می‌ماند', async () => {
    await seedActivity();
    const e = await entry(D('2026-06-15'), 'سند اشتباه', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 50_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 50_000_000n },
    ]);
    await tx((t) => reverse(t, e.id, { reason: 'اشتباه' }));

    const bs = await balanceSheet(gl, D('2026-06-30'));
    expect(bs.balanced).toBe(true);
    expect(bs.totals.assets).toBe(1_300_000_000n);   // اثر سند خنثی شده
  });

  it('ممیزی ج۱۳: زیرجمعِ جاری/غیرجاری و سرمایه در گردش', async () => {
    await seedActivity();
    const bs = await balanceSheet(gl, D('2026-06-30'));
    // نقد ۱٬۱۲۰م + دریافتنی ۱۸۰م، همه زیر ۱۱ (جاری)
    expect(bs.totals.currentAssets).toBe(1_300_000_000n);
    expect(bs.totals.nonCurrentAssets).toBe(0n);
    // پرداختنی ۱۸۰م زیر ۲۱ (جاری)
    expect(bs.totals.currentLiabilities).toBe(180_000_000n);
    expect(bs.totals.longTermLiabilities).toBe(0n);
    expect(bs.totals.workingCapital).toBe(1_120_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('صورت سود و زیان', () => {
  it('سود ناخالص و خالص از ساختار سرفصل‌ها می‌آید', async () => {
    await seedActivity();
    const is = await incomeStatement(gl, { from: D('2026-04-01'), to: D('2026-06-30') });

    expect(is.totals.revenue).toBe(300_000_000n);
    expect(is.totals.cogs).toBe(180_000_000n);
    expect(is.totals.grossProfit).toBe(120_000_000n);
    expect(is.totals.netProfit).toBe(120_000_000n);
  });

  it('سود خالص با سود انباشتهٔ ترازنامه می‌خواند', async () => {
    await seedActivity();
    const is = await incomeStatement(gl, { to: D('2026-06-30') });
    const bs = await balanceSheet(gl, D('2026-06-30'));
    expect(is.totals.netProfit).toBe(bs.totals.retainedEarnings);
  });

  it('تفکیک به مرکز هزینه', async () => {
    const prod = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '1' } });
    const admin = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '3' } });
    await entry(DEFAULT_DATE, 'حقوق دو واحد', [
      { accountId: payrollAcc.id, costCenterId: prod.id, currencyCode: 'IRR', debit: 70_000_000n },
      { accountId: payrollAcc.id, costCenterId: admin.id, currencyCode: 'IRR', debit: 30_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 100_000_000n },
    ]);

    const is = await incomeStatement(gl, { byCostCenter: true });
    const byCc = Object.fromEntries(is.lines.map((l) => [l.costCenterCode, BigInt(l.amount)]));
    expect(byCc['1']).toBe(70_000_000n);
    expect(byCc['3']).toBe(30_000_000n);
  });

  it('فیلتر مرکز هزینه فقط همان واحد را می‌آورد', async () => {
    const prod = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '1' } });
    const admin = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '3' } });
    await entry(DEFAULT_DATE, 'حقوق', [
      { accountId: payrollAcc.id, costCenterId: prod.id, currencyCode: 'IRR', debit: 70_000_000n },
      { accountId: payrollAcc.id, costCenterId: admin.id, currencyCode: 'IRR', debit: 30_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 100_000_000n },
    ]);

    const is = await incomeStatement(gl, { costCenterIds: [prod.id] });
    expect(is.totals.admin).toBe(70_000_000n);
  });

  it('ممیزی ج۱۱: تفکیک سطح معین', async () => {
    await seedActivity();
    const is: any = await incomeStatement(gl, { from: D('2026-04-01'), to: D('2026-06-30'), byAccount: true });
    const byCode = Object.fromEntries(is.accounts.map((a: any) => [a.code, BigInt(a.amount)]));
    expect(byCode['4101']).toBe(300_000_000n);   // فروش، علامتِ نمایشیِ مثبت
    expect(byCode['5101']).toBe(180_000_000n);   // بهای تمام‌شده
  });

  it('ممیزی ج۱۱: ستون مقایسه‌ای دورهٔ قبل', async () => {
    await seedActivity();
    // دورهٔ اصلی خرداد (فقط دریافت، بدون فروش/خرید)، مقایسه با اردیبهشت (فروش ۳۰۰ + خرید ۱۸۰)
    const is: any = await incomeStatement(gl, {
      from: D('2026-06-01'), to: D('2026-06-30'),
      compareFrom: D('2026-05-01'), compareTo: D('2026-05-31'),
    });
    expect(is.totals.revenue).toBe(0n);
    expect(is.comparison.totals.revenue).toBe(300_000_000n);
    expect(is.comparison.totals.cogs).toBe(180_000_000n);
    expect(is.comparison.totals.grossProfit).toBe(120_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('صورت جریان وجوه نقد', () => {
  it('طبقه‌بندی طرف مقابل', () => {
    expect(classifyCounterpart('1201')).toBe('INVESTING');
    expect(classifyCounterpart('2201')).toBe('FINANCING');
    expect(classifyCounterpart('3101')).toBe('FINANCING');
    expect(classifyCounterpart('4101')).toBe('OPERATING');
    expect(classifyCounterpart('1104')).toBe('OPERATING');
  });

  it('جمع سه دسته برابر تغییر واقعی ماندهٔ نقد است', async () => {
    await seedActivity();
    const cf = await cashFlow(gl, { from: D('2026-04-01'), to: D('2026-06-30') });

    expect(cf.netChange).toBe(1_120_000_000n);
    expect(cf.unclassified).toBe(0n);
    expect(cf.operating + cf.investing + cf.financing).toBe(cf.netChange);
  });

  it('آوردهٔ سرمایه تأمین مالی است و دریافت از مشتری عملیاتی', async () => {
    await seedActivity();
    const cf = await cashFlow(gl, { from: D('2026-04-01'), to: D('2026-06-30') });

    expect(cf.financing).toBe(1_000_000_000n);
    expect(cf.operating).toBe(120_000_000n);
    expect(cf.investing).toBe(0n);
  });

  it('ممیزی ج۱۳: ماندهٔ ابتدا + جریان = ماندهٔ انتها', async () => {
    await seedActivity();
    // بازه از ۵ اردیبهشت — آوردهٔ ۱ فروردین در ماندهٔ ابتدا می‌نشیند
    const cf: any = await cashFlow(gl, { from: D('2026-05-05'), to: D('2026-06-30') });
    expect(cf.openingCash).toBe(1_000_000_000n);
    expect(cf.closingCash).toBe(1_120_000_000n);
    expect(cf.netChange).toBe(120_000_000n);
    expect(cf.reconciliation).toBe(0n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('سن‌بندی', () => {
  // تاریخ مبنا باید آن‌قدر جلو باشد که «۲۰۰ روز قبل» هم داخل سال مالی بماند،
  // وگرنه تریگر بازهٔ سال مالی سند را رد می‌کند.
  const AS_OF = D('2026-12-01');
  const daysBefore = (n: number) => D(new Date(AS_OF.getTime() - n * 86_400_000).toISOString().slice(0, 10));

  const invoice = (amount: bigint, date: Date) =>
    entry(date, 'فاکتور', [
      { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: amount },
      { accountId: sales.id, currencyCode: 'IRR', credit: amount },
    ]);

  const receipt = (amount: bigint, date: Date) =>
    entry(date, 'دریافت', [
      { accountId: cash.id, currencyCode: 'IRR', debit: amount },
      { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', credit: amount },
    ]);

  it('تعهدها در سطل سنی تاریخ خودشان می‌نشینند', async () => {
    await invoice(10_000_000n, daysBefore(10));
    await invoice(20_000_000n, daysBefore(45));
    await invoice(30_000_000n, daysBefore(100));

    const res = await aging(gl, '1104', AS_OF);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].buckets['0-30']).toBe(10_000_000n);
    expect(res.rows[0].buckets['31-60']).toBe(20_000_000n);
    expect(res.rows[0].buckets['90+']).toBe(30_000_000n);
  });

  it('دریافت، قدیمی‌ترین تعهد را اول می‌بندد', async () => {
    await invoice(10_000_000n, daysBefore(100));
    await invoice(10_000_000n, daysBefore(10));
    await receipt(10_000_000n, daysBefore(1));

    const res = await aging(gl, '1104', AS_OF);
    expect(res.rows[0].currencies[0].balance).toBe(10_000_000n);
    expect(res.rows[0].buckets['90+']).toBe(0n);
    expect(res.rows[0].buckets['0-30']).toBe(10_000_000n);
    expect(res.rows[0].oldestDays).toBe(10);
  });

  it('تسویهٔ کامل، طرف‌حساب را از گزارش حذف می‌کند', async () => {
    await invoice(10_000_000n, daysBefore(50));
    await receipt(10_000_000n, daysBefore(2));
    const res = await aging(gl, '1104', AS_OF);
    expect(res.rows).toHaveLength(0);
  });

  it('سن از تاریخ سند خوانده می‌شود نه تاریخ درج', async () => {
    // سند همین الان درج می‌شود ولی تاریخش ۲۰۰ روز قبل است
    await invoice(10_000_000n, daysBefore(200));
    const res = await aging(gl, '1104', AS_OF);
    expect(res.rows[0].oldestDays).toBe(200);
  });

  it('جمع سطل‌ها برابر ماندهٔ پایه است', async () => {
    await invoice(10_000_000n, daysBefore(10));
    await invoice(20_000_000n, daysBefore(70));
    await receipt(5_000_000n, daysBefore(1));

    const res = await aging(gl, '1104', AS_OF);
    const sum = Object.values(res.rows[0].buckets).reduce((a, b) => a + b, 0n);
    // ریالی: پایه == خام
    expect(sum).toBe(res.rows[0].currencies[0].balance);
    expect(res.rows[0].totalBase).toBe(25_000_000n);
  });

  it('ب۱ ممیزی: سطل‌ها به ریال پر می‌شوند، نه واحد خامِ ارز', async () => {
    // فروش ۱۰۰ دلاری (۱۰٬۰۰۰ سنت) با نرخ ۹۰۰٬۰۰۰ ⇒ پایه ۹۰٬۰۰۰٬۰۰۰ ریال
    await entry(daysBefore(10), 'فروش دلاری', [
      { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD', debit: 10_000n, rate: '900000' },
      { accountId: sales.id, currencyCode: 'USD', credit: 10_000n, rate: '900000' },
    ]);
    // و یک فروش ریالی از همان مشتری
    await invoice(50_000_000n, daysBefore(40));

    const res = await aging(gl, '1104', AS_OF);
    // یک مشتری ⇒ یک ردیف، با دو موضع ارزی زیرش (ج۴)
    expect(res.rows).toHaveLength(1);
    expect(res.positionCount).toBe(2);
    expect(res.rows[0].singleCurrency).toBeNull();
    const usdRow = res.rows[0].currencies.find((c: any) => c.currencyCode === 'USD')!;

    // سطل به ریال است، نه ۱۰٬۰۰۰ سنت
    expect(usdRow.buckets['0-30']).toBe(90_000_000n);
    expect(usdRow.bucketsForeign['0-30']).toBe(10_000n);   // خام هم نگه داشته شده
    expect(usdRow.balance).toBe(10_000n);                   // مانده همچنان به ارز خودش

    // جمعِ کل حالا معنادار است: ۹۰م (دلاری) + ۵۰م (ریالی) = ۱۴۰م ریال
    expect(res.bucketTotals['0-30']).toBe(90_000_000n);
    expect(res.bucketTotals['31-60']).toBe(50_000_000n);
    expect(res.grandTotalBase).toBe(140_000_000n);
  });

  it('ج۴ ممیزی: یک طرف‌حساب یک ردیف است، هرچند چند ارز داشته باشد', async () => {
    // پیش از این، مشتریِ دوارزی دو ردیف می‌گرفت و پاورقی «۲ طرف‌حساب» می‌گفت.
    // تخصیص FIFO باید per-currency بماند (دریافت دلاری فاکتور ریالی را
    // نمی‌بندد) ولی نمایش باید per-party باشد.
    await invoice(50_000_000n, daysBefore(40));
    await entry(daysBefore(10), 'فروش دلاری', [
      { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD', debit: 10_000n, rate: '900000' },
      { accountId: sales.id, currencyCode: 'USD', credit: 10_000n, rate: '900000' },
    ]);

    const res = await aging(gl, '1104', AS_OF);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].currencies).toHaveLength(2);

    // سطل‌های ردیفِ طرف‌حساب = جمعِ سطل‌های ارزهایش، به ریال
    expect(res.rows[0].buckets['0-30']).toBe(90_000_000n);
    expect(res.rows[0].buckets['31-60']).toBe(50_000_000n);
    expect(res.rows[0].totalBase).toBe(140_000_000n);

    // قدیمی‌ترین = قدیمی‌ترین در هر ارزی که باشد
    expect(res.rows[0].oldestDays).toBe(40);

    // ارزها از بزرگ به کوچک، تا نگاه اول روی مبلغ مهم بیفتد
    expect(res.rows[0].currencies.map((c: any) => c.currencyCode)).toEqual(['USD', 'IRR']);
  });

  it('ج۴: دریافت دلاری فاکتور ریالی را نمی‌بندد', async () => {
    // همان چیزی که اجازه نمی‌دهد تجمیعِ نمایشی به تجمیعِ تخصیص تبدیل شود
    await invoice(50_000_000n, daysBefore(40));
    await entry(daysBefore(5), 'دریافت دلاری', [
      { accountId: cash.id, currencyCode: 'USD', debit: 10_000n, rate: '900000' },
      { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD', credit: 10_000n, rate: '900000' },
    ]);

    const res = await aging(gl, '1104', AS_OF);
    const irr = res.rows[0].currencies.find((c: any) => c.currencyCode === 'IRR')!;
    const usd = res.rows[0].currencies.find((c: any) => c.currencyCode === 'USD')!;
    // طلبِ ریالی دست‌نخورده مانده …
    expect(irr.balance).toBe(50_000_000n);
    // … و دریافتِ دلاری یک پیش‌پرداختِ دلاری ساخته، نه تسویهٔ ریالی
    expect(usd.balance).toBe(-10_000n);
  });
});
