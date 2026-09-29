/**
 * بستن سال مالی (ممیزی ب۲ + رفعِ ن۱) — سند اختتامیه و سود انباشته.
 *
 * آنچه این تست‌ها می‌سنجند:
 *   • حساب‌های موقت (۴–۸) پس از بستن، ماندهٔ **پایه**‌شان صفر می‌شود
 *   • سود/زیان دوره دقیقاً به ۳۱۰۲ می‌رود
 *   • سالِ بسته سند نمی‌پذیرد (تریگر)
 *   • **ماندهٔ حساب‌های دائمی تغییر نمی‌کند** — نه سند افتتاحیه‌ای ثبت می‌شود
 *     و نه ترازنامه در مرز دو سال جابه‌جا می‌شود (ن۱)
 *   • **صورت سود و زیانِ سالِ بسته‌شده دست‌نخورده می‌ماند** (ن۱-ب)
 *   • برگشت‌پذیر است، و سال‌هایی که با نسخهٔ قدیمی بسته شده‌اند هنوز قابل
 *     بازکردن‌اند (سازگاری با گذشته)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D, resetBusinessData, expectRejects,
  FY_START, FY_END, makeCostCenter,
} from '../helpers/gl';
import { ensureSubsidiary } from '../../src/modules/ledger/subsidiary';
import { post } from '../../src/modules/ledger/poster';
import {
  previewYearClose, closeFiscalYear, reopenFiscalYear,
} from '../../src/modules/ledger/year-close';
import { balanceSheet, incomeStatement } from '../../src/modules/ledger/reports/statements';
import { journal, trialBalance } from '../../src/modules/ledger/reports/ledgers';
import { costCenterTotals } from '../../src/modules/ledger/costcenter';

let fy: any, ar: any, sales: any, cash: any, cogs: any, capital: any, retained: any;
let customer: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[], fyId = fy.id) =>
  tx((t) => post(t, { fiscalYearId: fyId, date, description, lines }));

async function makeNextYear() {
  const f = await gl.glFiscalYear.create({
    data: { title: '۱۴۰۶', startDate: D('2027-03-21'), endDate: D('2028-03-19') },
  });
  await gl.glSerialCounter.create({ data: { fiscalYearId: f.id, next: 1 } });
  return f;
}

async function baseBal(code: string): Promise<bigint> {
  const a = await accountByCode(code);
  const r = await gl.$queryRaw<{ b: bigint | null }[]>`
    SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS b
    FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE l."accountId" = ${a.id} AND e.status <> 'DRAFT'
  `;
  return BigInt(r[0]?.b ?? 0n);
}

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
  ar = await accountByCode('1104');
  sales = await accountByCode('4101');
  cash = await accountByCode('110101');
  cogs = await accountByCode('5101');
  capital = await accountByCode('3101');
  retained = await accountByCode('3102');
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl();
  await resetBusinessData();
  await gl.customer.deleteMany({});
  await gl.glExchangeRate.deleteMany({});
  fy = await makeFiscalYear();
  const c = await gl.customer.create({ data: { name: 'مشتری بستن', shortCode: 'YC1' } });
  customer = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
});

/** سرمایه + فروش + خرید ⇒ سود ناخالص مشخص */
async function tradingYear() {
  await entry(D('2026-04-01'), 'آورده', [
    { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000_000n },
    { accountId: capital.id, currencyCode: 'IRR', credit: 1_000_000_000n },
  ]);
  await entry(D('2026-05-10'), 'فروش', [
    { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: 600_000_000n },
    { accountId: sales.id, currencyCode: 'IRR', credit: 600_000_000n },
  ]);
  await entry(D('2026-05-20'), 'بهای تمام‌شده', [
    { accountId: cogs.id, currencyCode: 'IRR', debit: 380_000_000n },
    { accountId: cash.id, currencyCode: 'IRR', credit: 380_000_000n },
  ]);
  // سود دوره = ۶۰۰م − ۳۸۰م = ۲۲۰م
}

// ═══════════════════════════════════════════════════════════════
describe('سند اختتامیه', () => {
  it('پیش‌نمایش، درآمد و هزینه و سود را می‌دهد', async () => {
    await tradingYear();
    const p = await previewYearClose(gl, fy.id);
    expect(p.totalIncome).toBe('600000000');
    expect(p.totalExpense).toBe('380000000');
    expect(p.netProfit).toBe('220000000');
    expect(p.alreadyClosed).toBe(false);
    expect(p).not.toHaveProperty('permanentPositionCount');
  });

  it('بستن، حساب‌های موقت را صفر و سود را به ۳۱۰۲ می‌برد', async () => {
    await tradingYear();
    const res: any = await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    expect(res.closingEntry.entryType).toBe('CLOSING');
    expect(res.netProfit).toBe('220000000');
    expect(await baseBal('4101')).toBe(0n);      // فروش صفر شد
    expect(await baseBal('5101')).toBe(0n);      // بهای تمام‌شده صفر شد
    expect(await baseBal('3102')).toBe(-220_000_000n);   // ۳۱۰۲ بستانکارِ ۲۲۰م (سود)

    const closed = await gl.glFiscalYear.findUniqueOrThrow({ where: { id: fy.id } });
    expect(closed.closedAt).not.toBeNull();
  });

  it('زیان دوره، ۳۱۰۲ را بدهکار می‌کند', async () => {
    await entry(D('2026-04-01'), 'آورده', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 1_000_000_000n },
    ]);
    await entry(D('2026-06-01'), 'هزینهٔ بدون درآمد', [
      { accountId: cogs.id, currencyCode: 'IRR', debit: 50_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 50_000_000n },
    ]);
    const res: any = await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    expect(res.netProfit).toBe('-50000000');
    expect(await baseBal('3102')).toBe(50_000_000n);   // بدهکار = زیان
  });

  it('سالِ بسته دیگر سند نمی‌پذیرد', async () => {
    await tradingYear();
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    await expectRejects(
      () => entry(D('2026-07-01'), 'سند بعد از بستن', [
        { accountId: cash.id, currencyCode: 'IRR', debit: 1_000n },
        { accountId: capital.id, currencyCode: 'IRR', credit: 1_000n },
      ]),
      /بسته/,
    );
  });

  it('بستن دوباره رد می‌شود', async () => {
    await tradingYear();
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    await expectRejects(
      () => tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true })),
      /از قبل بسته/,
    );
  });

  it('حسابِ با مرکز هزینهٔ اجباری هم بسته می‌شود — ردیف اختتامیه بُعدش را می‌برد', async () => {
    // ۶۱۰۱ حقوق مرکز هزینهٔ اجباری دارد. اگر ردیف اختتامیه بی‌مرکز ساخته شود،
    // تریگر کلِ سند را رد می‌کند و بستنِ سال روی هر دفتری که حقوق دارد
    // غیرممکن می‌شود. (با دادهٔ واقعی روی نسخهٔ آزمایشی مچ شد.)
    const salary = await accountByCode('6101');
    const cc1 = await makeCostCenter('91', 'تولید-تست');
    const cc2 = await makeCostCenter('92', 'اداری-تست');
    await entry(D('2026-04-05'), 'حقوق تولید', [
      { accountId: salary.id, costCenterId: cc1.id, currencyCode: 'IRR', debit: 40_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 40_000_000n },
    ]);
    await entry(D('2026-04-06'), 'حقوق اداری', [
      { accountId: salary.id, costCenterId: cc2.id, currencyCode: 'IRR', debit: 25_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 25_000_000n },
    ]);

    const res: any = await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    expect(await baseBal('6101')).toBe(0n);

    // هر مرکز هزینه ردیف بستنِ خودش را گرفت
    const lines = await gl.glLine.findMany({
      where: { entryId: res.closingEntry.id, accountId: salary.id },
    });
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.costCenterId).sort()).toEqual([cc1.id, cc2.id].sort());
    expect(lines.every((l) => l.costCenterId !== null)).toBe(true);
  });

  it('بدون حساب موقت، خطا می‌دهد', async () => {
    await entry(D('2026-04-01'), 'فقط آورده', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 1_000_000n },
    ]);
    await expectRejects(() => tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true })), /چیزی برای بستن/);
  });
});

// ═══════════════════════════════════════════════════════════════
// ن۱ — رگرسیونِ دوبرابرشدن
//
// نسخهٔ اول، ماندهٔ حساب‌های دائمی را در سند افتتاحیهٔ سال بعد دوباره ثبت می‌کرد.
// چون همهٔ گزارش‌های این سامانه تجمعی‌اند، هر مانده دو بار شمرده می‌شد.
// تست‌های قبلی این را نگرفتند چون فقط **خودِ سند افتتاحیه** را می‌سنجیدند
// (که درست ساخته می‌شد)، نه ماندهٔ تجمعیِ پس از بستن.
// ═══════════════════════════════════════════════════════════════
describe('ن۱ — ماندهٔ دائمی پس از بستن', () => {
  it('ترازنامهٔ اولین روز سال بعد دقیقاً برابر آخرین روز سال بسته‌شده است', async () => {
    await tradingYear();
    await makeNextYear();
    const before = await balanceSheet(gl, FY_END);
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    const after = await balanceSheet(gl, D('2027-03-21'));

    expect(after.totals.assets).toBe(before.totals.assets);
    expect(after.totals.liabilities).toBe(before.totals.liabilities);
    // دارایی = نقد (۱۰۰۰م − ۳۸۰م) + دریافتنی ۶۰۰م = ۱٬۲۲۰م، نه ۲٬۴۴۰م
    expect(after.totals.assets).toBe(1_220_000_000n);
  });

  it('هیچ سند افتتاحیه‌ای در سال بعد ساخته نمی‌شود', async () => {
    await tradingYear();
    const next = await makeNextYear();
    const res: any = await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    expect(res.openingEntry).toBeNull();
    const openings = await gl.glEntry.count({
      where: { fiscalYearId: next.id, entryType: 'OPENING' },
    });
    expect(openings).toBe(0);
    // و سریال ۱ سال بعد هنوز آزاد است
    const counter = await gl.glSerialCounter.findUniqueOrThrow({ where: { fiscalYearId: next.id } });
    expect(counter.next).toBe(1);
  });

  it('حتی اگر nextFiscalYearId پاس داده شود، سال بعد دست‌نخورده می‌ماند', async () => {
    // قرارداد را در **مرزِ تابع** قفل می‌کند، نه در فراخوانِ پیش‌فرض. باگِ اصلی
    // مشروط بود (فقط وقتی این پارامتر می‌آمد)، پس تستی که هرگز پاسش نمی‌دهد
    // نمی‌تواند بازگشتش را بگیرد.
    await tradingYear();
    const next = await makeNextYear();
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true, nextFiscalYearId: next.id } as any));

    expect(await gl.glEntry.count({ where: { fiscalYearId: next.id } })).toBe(0);
    expect((await balanceSheet(gl, D('2027-03-21'))).totals.assets).toBe(1_220_000_000n);
  });

  it('ماندهٔ حساب دائمی تک‌تک هم عوض نمی‌شود', async () => {
    await tradingYear();
    const cashBefore = await baseBal('110101');
    const capBefore = await baseBal('3101');
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    expect(await baseBal('110101')).toBe(cashBefore);
    expect(await baseBal('3101')).toBe(capBefore);
  });

  it('بستنِ سالِ دوم هم چیزی را تصاعدی نمی‌کند', async () => {
    await tradingYear();
    const next = await makeNextYear();
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    // یک گردش کوچک در سال دوم تا حساب موقتی برای بستن باشد
    await entry(D('2027-05-01'), 'هزینهٔ سال بعد', [
      { accountId: cogs.id, currencyCode: 'IRR', debit: 20_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 20_000_000n },
    ], next.id);

    const before = await balanceSheet(gl, D('2028-03-19'));
    await tx((t) => closeFiscalYear(t, { fiscalYearId: next.id, acknowledgeChecklist: true }));
    const after = await balanceSheet(gl, D('2028-03-19'));
    expect(after.totals.assets).toBe(before.totals.assets);
    expect(after.totals.assets).toBe(1_200_000_000n);   // ۱٬۲۲۰م − ۲۰م
  });

  it('موضع ارزی هم دو برابر نمی‌شود', async () => {
    await entry(D('2026-04-01'), 'آوردهٔ دلاری', [
      { accountId: cash.id, currencyCode: 'USD', debit: 100_000n, rate: '900000' },
      { accountId: capital.id, currencyCode: 'USD', credit: 100_000n, rate: '900000' },
    ]);
    await entry(D('2026-05-01'), 'هزینه', [
      { accountId: cogs.id, currencyCode: 'IRR', debit: 1_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 1_000_000n },
    ]);
    await makeNextYear();
    const before = await baseBal('110101');
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    expect(await baseBal('110101')).toBe(before);

    const usdRows = await gl.$queryRaw<{ amount: bigint | null }[]>`
      SELECT (SUM(l.debit) - SUM(l.credit))::bigint AS amount
      FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
      WHERE l."accountId" = ${cash.id} AND l."currencyCode" = 'USD' AND e.status <> 'DRAFT'
    `;
    expect(BigInt(usdRows[0]?.amount ?? 0n)).toBe(100_000n);   // نه ۲۰۰٬۰۰۰
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ن۱-ب — صورت سود و زیانِ سالِ بسته‌شده', () => {
  it('پس از بستن، همان اعداد را نگه می‌دارد', async () => {
    await tradingYear();
    const range = { from: FY_START, to: FY_END };
    const before = await incomeStatement(gl, range);
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    const after = await incomeStatement(gl, range);

    expect(after.totals.revenue).toBe(600_000_000n);
    expect(after.totals.netProfit).toBe(220_000_000n);
    expect(after.totals.revenue).toBe(before.totals.revenue);
    expect(after.totals.netProfit).toBe(before.totals.netProfit);
  });

  it('تفکیک سطح معین هم دست‌نخورده می‌ماند', async () => {
    await tradingYear();
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    const r: any = await incomeStatement(gl, { from: FY_START, to: FY_END, byAccount: true });
    const s4101 = r.accounts.find((a: any) => a.code === '4101');
    expect(s4101?.amount).toBe(600_000_000n);
  });

  it('ولی سند اختتامیه در دفتر روزنامه و تراز آزمایشی هست — پنهان نمی‌شود', async () => {
    // ادعا دربارهٔ **گزارش** است نه ردیف جدول: اگر روزی کسی همین فیلتر را در
    // journal() یا trialBalance() کپی کند، ردِ حسابرسی گم می‌شود و باید بشکند.
    await tradingYear();
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    const rows: any[] = await journal(gl, { from: FY_START, to: FY_END });
    expect(rows.some((r) => r.entryType === 'CLOSING')).toBe(true);

    const tb: any = await trialBalance(gl, { from: FY_START, to: FY_END }, 4);
    const r4101 = tb.rows.find((r: any) => r.code === '4101');
    expect(r4101.periodDebit).toBe(600_000_000n);    // خودِ اختتامیه
    expect(r4101.periodCredit).toBe(600_000_000n);   // فروش سال
    expect(r4101.closingCredit).toBe(0n);            // و مانده صفر شد
  });

  it('گزارش مراکز هزینه هم سطلِ جعلیِ «بدون مرکز» نمی‌سازد', async () => {
    await tradingYear();
    const before = await costCenterTotals(gl, { from: FY_START, to: FY_END });
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    const after = await costCenterTotals(gl, { from: FY_START, to: FY_END });
    expect(after).toEqual(before);
  });

  it('سندِ دستیِ جعلی با entryType=CLOSING از سود و زیان پنهان نمی‌شود', async () => {
    // فیلتر مرکب است: sourceType در مسیر سند دستی هاردکد 'Manual' است، پس
    // کاربر نمی‌تواند با ادعای CLOSING هزینه‌اش را از صورت سود و زیان حذف کند.
    await tradingYear();
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-06-01'), description: 'هزینهٔ مخفی؟',
      entryType: 'CLOSING', sourceType: 'Manual',
      lines: [
        { accountId: cogs.id, currencyCode: 'IRR', debit: 7_000_000n },
        { accountId: cash.id, currencyCode: 'IRR', credit: 7_000_000n },
      ],
    }));
    const r = await incomeStatement(gl, { from: FY_START, to: FY_END });
    expect(r.totals.cogs).toBe(387_000_000n);   // ۳۸۰م + ۷م — دیده می‌شود
  });
});

// ═══════════════════════════════════════════════════════════════
describe('بازکردن سال مالی', () => {
  it('اختتامیه با سند برگشتی خنثی و closedAt پاک می‌شود', async () => {
    await tradingYear();
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    const res: any = await tx((t) => reopenFiscalYear(t, { fiscalYearId: fy.id, reason: 'رسیدگی مالیاتی' }));
    expect(res.reversedClosing).not.toBeNull();
    expect(res.reversedOpening).toBeNull();   // دیگر افتتاحیه‌ای ساخته نمی‌شود

    const fyAfter = await gl.glFiscalYear.findUniqueOrThrow({ where: { id: fy.id } });
    expect(fyAfter.closedAt).toBeNull();

    expect(await baseBal('4101')).toBe(-600_000_000n);
    await entry(D('2026-08-01'), 'سند پس از بازکردن', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 5_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 5_000n },
    ]);
  });

  it('سالِ بازِ نبسته، بازکردن ندارد', async () => {
    await expectRejects(() => tx((t) => reopenFiscalYear(t, { fiscalYearId: fy.id })), /بسته نیست/);
  });

  it('پس از بازکردن، صورت سود و زیان دو برابر نمی‌شود', async () => {
    // نسخهٔ اولِ رفعِ ن۱-ب فقط ('CLOSING','YearClose') را کنار می‌گذاشت، ولی آینهٔ
    // برگشتیِ اختتامیه ('REVERSING','YearClose') است — پس پس از بازکردن، آینه
    // می‌ماند و چون نقیضِ نقیضِ فعالیت است، همه‌چیز دو برابر می‌شد.
    await tradingYear();
    const range = { from: FY_START, to: FY_END };
    const before = await incomeStatement(gl, range);
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    await tx((t) => reopenFiscalYear(t, { fiscalYearId: fy.id, reason: 'اصلاح' }));
    const after = await incomeStatement(gl, range);

    expect(after.totals.revenue).toBe(600_000_000n);
    expect(after.totals.netProfit).toBe(220_000_000n);
    expect(after.totals.revenue).toBe(before.totals.revenue);

    const byAcc: any = await incomeStatement(gl, { ...range, byAccount: true });
    expect(byAcc.accounts.find((a: any) => a.code === '4101')?.amount).toBe(600_000_000n);
  });

  it('بستن ← بازکردن ← بستنِ دوباره، اعداد را جابه‌جا نمی‌کند', async () => {
    await tradingYear();
    const range = { from: FY_START, to: FY_END };
    const bsBefore = await balanceSheet(gl, FY_END);
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    await tx((t) => reopenFiscalYear(t, { fiscalYearId: fy.id, reason: 'اصلاح' }));
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    const inc = await incomeStatement(gl, range);
    expect(inc.totals.revenue).toBe(600_000_000n);
    expect(inc.totals.netProfit).toBe(220_000_000n);
    expect((await balanceSheet(gl, FY_END)).totals.assets).toBe(bsBefore.totals.assets);
    // سود دو بار به ۳۱۰۲ نرفته باشد
    expect(await baseBal('3102')).toBe(-220_000_000n);
  });

  // ── سازگاری با گذشته: سال‌هایی که با نسخهٔ باگ‌دار بسته شده‌اند ──
  it('سندِ افتتاحیهٔ به‌جامانده از نسخهٔ قدیمی هنوز برگشت می‌خورد', async () => {
    await tradingYear();
    const next = await makeNextYear();
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));

    // شبیه‌سازیِ دقیقِ آنچه نسخهٔ باگ‌دار می‌ساخت
    const legacyOpening: any = await tx((t) => post(t, {
      fiscalYearId: next.id, date: D('2027-03-21'),
      description: 'سند افتتاحیه سال مالی ۱۴۰۶ (نسخهٔ قدیمی)',
      entryType: 'OPENING', sourceType: 'YearClose', sourceId: fy.id,
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 620_000_000n },
        { accountId: capital.id, currencyCode: 'IRR', credit: 620_000_000n },
      ],
    }));
    // مانده الان دو برابر است — همان باگ
    expect(await baseBal('110101')).toBe(1_240_000_000n);

    const res: any = await tx((t) => reopenFiscalYear(t, { fiscalYearId: fy.id, reason: 'اصلاح ن۱' }));
    expect(res.reversedOpening).not.toBeNull();
    expect(res.reversedOpening.reversesId).toBe(legacyOpening.id);
    // و مانده به جای درستش برگشت
    expect(await baseBal('110101')).toBe(620_000_000n);
  });

  it('اگر سال بعد سند دیگری داشته باشد، بازکردنِ سالِ قدیمی رد می‌شود', async () => {
    await tradingYear();
    const next = await makeNextYear();
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    await tx((t) => post(t, {
      fiscalYearId: next.id, date: D('2027-03-21'), description: 'افتتاحیهٔ قدیمی',
      entryType: 'OPENING', sourceType: 'YearClose', sourceId: fy.id,
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 620_000_000n },
        { accountId: capital.id, currencyCode: 'IRR', credit: 620_000_000n },
      ],
    }));
    await entry(D('2027-04-01'), 'فعالیت سال بعد', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 10_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 10_000n },
    ], next.id);

    await expectRejects(
      () => tx((t) => reopenFiscalYear(t, { fiscalYearId: fy.id })),
      /سند دیگر دارد/,
    );
  });
});
