/**
 * تخصیص پرداخت به فاکتور — مرحلهٔ ۴ ج.
 *
 * دو دستهٔ آزمون: **قواعدی که تخصیص را قابل اعتماد می‌کنند** (یک طرف‌حساب،
 * یک ارز، جهت مخالف، سقفِ مبلغ)، و **اثرش روی سن‌بندی** — که کلِ دلیلِ وجودِ
 * این ماژول است.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, makeSubsidiary, accountByCode,
  D, resetBusinessData, expectRejects,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { allocate, unallocate, openItems, allocationsOf } from '../../src/modules/ledger/allocation';
import { aging } from '../../src/modules/ledger/reports/statements';

let fy: any, cash: any, sales: any, ar: any, ap: any, rent: any;
let alpha: any, beta: any, vendor: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

const AS_OF = D('2026-07-01');
const daysBefore = (n: number) => new Date(AS_OF.getTime() - n * 86_400_000);

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
  ar = await accountByCode('1104'); ap = await accountByCode('2101');
  rent = await accountByCode('6202');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await resetGl(); await resetBusinessData();
  fy = await makeFiscalYear();
  alpha = await makeSubsidiary('CUSTOMER', 'مشتری الف');
  beta = await makeSubsidiary('CUSTOMER', 'مشتری ب');
  vendor = await makeSubsidiary('SUPPLIER', 'تأمین‌کننده');
});

/** فاکتور فروش؛ شناسهٔ ردیفِ دریافتنی برمی‌گردد */
const invoice = async (party: any, amount: bigint, date: Date, cur = 'IRR', rate?: string) => {
  const e: any = await entry(date, `فاکتور ${amount}`, [
    { accountId: ar.id, subsidiaryId: party.id, currencyCode: cur, debit: amount, ...(rate ? { rate } : {}) },
    { accountId: sales.id, currencyCode: cur, credit: amount, ...(rate ? { rate } : {}) },
  ]);
  return e.lines.find((l: any) => l.accountId === ar.id).id as string;
};

/** دریافت از مشتری؛ شناسهٔ ردیفِ دریافتنی برمی‌گردد */
const receipt = async (party: any, amount: bigint, date: Date, cur = 'IRR', rate?: string) => {
  const e: any = await entry(date, `دریافت ${amount}`, [
    { accountId: cash.id, currencyCode: cur, debit: amount, ...(rate ? { rate } : {}) },
    { accountId: ar.id, subsidiaryId: party.id, currencyCode: cur, credit: amount, ...(rate ? { rate } : {}) },
  ]);
  return e.lines.find((l: any) => l.accountId === ar.id).id as string;
};

const link = (o: string, s2: string, amount?: bigint) =>
  tx((t) => allocate(t, { obligationLineId: o, settlementLineId: s2, amount: amount ?? null }));

// ═══════════════════════════════════════════════════════════════
describe('قواعد تخصیص', () => {
  it('تخصیص ساده، هر دو سر را می‌بندد', async () => {
    const inv = await invoice(alpha, 1_000_000n, daysBefore(30));
    const rec = await receipt(alpha, 1_000_000n, daysBefore(5));
    const a = await link(inv, rec);
    expect(a.amount).toBe(1_000_000n);

    const open = await openItems(gl, { subsidiaryId: alpha.id });
    expect(open.obligations).toHaveLength(0);
    expect(open.settlements).toHaveLength(0);
  });

  it('بدون مبلغ، کمترینِ دو ماندهٔ باز برداشته می‌شود', async () => {
    const inv = await invoice(alpha, 1_000_000n, daysBefore(30));
    const rec = await receipt(alpha, 3_000_000n, daysBefore(5));
    const a = await link(inv, rec);
    expect(a.amount).toBe(1_000_000n);   // نه ۳ میلیون

    const open = await openItems(gl, { subsidiaryId: alpha.id });
    expect(open.obligations).toHaveLength(0);
    expect(open.settlements[0].open).toBe(2_000_000n);
  });

  it('پرداخت قسطی: یک فاکتور با چند دریافت بسته می‌شود', async () => {
    const inv = await invoice(alpha, 1_000_000n, daysBefore(30));
    const r1 = await receipt(alpha, 400_000n, daysBefore(20));
    const r2 = await receipt(alpha, 600_000n, daysBefore(5));
    await link(inv, r1);
    await link(inv, r2);

    const rows = await allocationsOf(gl, inv);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + BigInt(r.amount), 0n)).toBe(1_000_000n);
    expect((await openItems(gl, { subsidiaryId: alpha.id })).obligations).toHaveLength(0);
  });

  it('طرف‌حساب متفاوت رد می‌شود', async () => {
    const inv = await invoice(alpha, 1_000_000n, daysBefore(30));
    const rec = await receipt(beta, 1_000_000n, daysBefore(5));
    await expectRejects(() => link(inv, rec), /یک طرف‌حساب/);
  });

  it('ارز متفاوت رد می‌شود — بستنِ فاکتور دلاری با ریال، تبدیل ارز است', async () => {
    const inv = await invoice(alpha, 10_000n, daysBefore(30), 'USD', '900000');
    const rec = await receipt(alpha, 1_000_000n, daysBefore(5));
    await expectRejects(() => link(inv, rec), /ارزها یکی نیستند/);
  });

  it('دو ردیف هم‌جهت رد می‌شوند', async () => {
    const i1 = await invoice(alpha, 1_000_000n, daysBefore(30));
    const i2 = await invoice(alpha, 1_000_000n, daysBefore(20));
    await expectRejects(() => link(i1, i2), /جهت مخالف/);
  });

  it('بیش از ماندهٔ باز تعهد، رد می‌شود', async () => {
    const inv = await invoice(alpha, 1_000_000n, daysBefore(30));
    const rec = await receipt(alpha, 5_000_000n, daysBefore(5));
    await expectRejects(() => link(inv, rec, 2_000_000n), /ماندهٔ باز تعهد/);
  });

  it('بیش از ماندهٔ باز تسویه، رد می‌شود', async () => {
    const inv = await invoice(alpha, 5_000_000n, daysBefore(30));
    const rec = await receipt(alpha, 1_000_000n, daysBefore(5));
    await expectRejects(() => link(inv, rec, 2_000_000n), /ماندهٔ باز تسویه/);
  });

  it('تعهدِ کاملاً تسویه‌شده دوباره تخصیص نمی‌گیرد', async () => {
    const inv = await invoice(alpha, 1_000_000n, daysBefore(30));
    const r1 = await receipt(alpha, 1_000_000n, daysBefore(20));
    const r2 = await receipt(alpha, 1_000_000n, daysBefore(5));
    await link(inv, r1);
    await expectRejects(() => link(inv, r2), /کاملاً تسویه/);
  });

  it('همان زوج دو بار ثبت نمی‌شود', async () => {
    const inv = await invoice(alpha, 5_000_000n, daysBefore(30));
    const rec = await receipt(alpha, 5_000_000n, daysBefore(5));
    await link(inv, rec, 1_000_000n);
    await expectRejects(() => link(inv, rec, 1_000_000n), /قبلاً به همین تعهد/);
  });

  it('حساب غیرکنترلی رد می‌شود', async () => {
    const e: any = await entry(daysBefore(10), 'هزینهٔ نقدی', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 500_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 500_000n },
    ]);
    const rentLine = e.lines.find((l: any) => l.accountId === rent.id).id;
    const rec = await receipt(alpha, 500_000n, daysBefore(5));
    await expectRejects(() => link(rentLine, rec), /معین‌های/);
  });

  it('حذف تخصیص، هر دو سر را دوباره باز می‌کند', async () => {
    const inv = await invoice(alpha, 1_000_000n, daysBefore(30));
    const rec = await receipt(alpha, 1_000_000n, daysBefore(5));
    const a = await link(inv, rec);
    await tx((t) => unallocate(t, a.id));

    const open = await openItems(gl, { subsidiaryId: alpha.id });
    expect(open.obligations).toHaveLength(1);
    expect(open.settlements).toHaveLength(1);
    expect(open.obligations[0].open).toBe(1_000_000n);
  });

  it('پرداختنی: جهت‌ها برعکس‌اند و باز هم کار می‌کند', async () => {
    const bill: any = await entry(daysBefore(30), 'فاکتور خرید', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 2_000_000n },
      { accountId: ap.id, subsidiaryId: vendor.id, currencyCode: 'IRR', credit: 2_000_000n },
    ]);
    const pay: any = await entry(daysBefore(5), 'پرداخت به تأمین‌کننده', [
      { accountId: ap.id, subsidiaryId: vendor.id, currencyCode: 'IRR', debit: 2_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 2_000_000n },
    ]);
    const o = bill.lines.find((l: any) => l.accountId === ap.id).id;
    const s = pay.lines.find((l: any) => l.accountId === ap.id).id;

    // تعهدِ پرداختنی بستانکار است، تسویه‌اش بدهکار
    const before = await openItems(gl, { subsidiaryId: vendor.id });
    expect(before.obligations[0].id).toBe(o);
    expect(before.settlements[0].id).toBe(s);

    await link(o, s);
    expect((await openItems(gl, { subsidiaryId: vendor.id })).obligations).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('اثر روی سن‌بندی — دلیلِ وجودِ این ماژول', () => {
  it('بدون تخصیص، FIFO قدیمی‌ترین را می‌بندد (رفتار قبلی)', async () => {
    await invoice(alpha, 1_000_000n, daysBefore(100));
    await invoice(alpha, 1_000_000n, daysBefore(10));
    await receipt(alpha, 1_000_000n, daysBefore(1));

    const r = await aging(gl, '1104', AS_OF);
    const row = r.rows[0];
    expect(row.buckets['90+']).toBe(0n);           // قدیمی بسته شد
    expect(row.buckets['0-30']).toBe(1_000_000n);  // تازه باز ماند
    expect(r.explicitCoverage).toBe(0);
  });

  it('با تخصیص صریح، همان فاکتوری بسته می‌شود که کاربر گفته', async () => {
    // ⚠️ همان حالتی که FIFO در آن دروغ می‌گفت: مشتری فاکتور تازه را پرداخت
    // می‌کند ولی سیستم قدیمی را می‌بست، و بعد «قدیمی‌ترین ۱۰ روز» می‌گفت
    // درحالی‌که یک بدهیِ ۱۰۰ روزه سرِ جایش بود.
    const old = await invoice(alpha, 1_000_000n, daysBefore(100));
    const fresh = await invoice(alpha, 1_000_000n, daysBefore(10));
    const rec = await receipt(alpha, 1_000_000n, daysBefore(1));
    await link(fresh, rec);

    const r = await aging(gl, '1104', AS_OF);
    const row = r.rows[0];
    expect(row.buckets['90+']).toBe(1_000_000n);   // قدیمی هنوز باز است ✓
    expect(row.buckets['0-30']).toBe(0n);          // تازه بسته شد ✓
    expect(row.oldestDays).toBe(100);
    expect(r.explicitCoverage).toBe(1000);         // هزارِ هزار: بدون حدس
    expect(old).toBeTruthy();
  });

  it('تخصیص جزئی: بقیه‌اش FIFO می‌شود', async () => {
    const old = await invoice(alpha, 1_000_000n, daysBefore(100));
    const fresh = await invoice(alpha, 1_000_000n, daysBefore(10));
    const rec = await receipt(alpha, 1_000_000n, daysBefore(1));
    await link(fresh, rec, 400_000n);   // فقط ۴۰۰ هزارش صریح

    const r = await aging(gl, '1104', AS_OF);
    const row = r.rows[0];
    // ۴۰۰ هزار صریح روی فاکتور تازه، ۶۰۰ هزار باقی‌مانده FIFO روی قدیمی
    expect(row.buckets['90+']).toBe(400_000n);
    expect(row.buckets['0-30']).toBe(600_000n);
    expect(r.explicitCoverage).toBe(400);   // چهل درصد
    expect(old).toBeTruthy();
  });

  it('جمعِ ماندهٔ باز با تخصیص عوض نمی‌شود — فقط جایش', async () => {
    // تخصیص یک واقعیتِ توضیحی است، نه یک سند؛ نباید ماندهٔ کل را تکان دهد
    const old = await invoice(alpha, 3_000_000n, daysBefore(100));
    const fresh = await invoice(alpha, 2_000_000n, daysBefore(10));
    const rec = await receipt(alpha, 1_500_000n, daysBefore(1));

    const before = await aging(gl, '1104', AS_OF);
    await link(fresh, rec);
    const after = await aging(gl, '1104', AS_OF);

    expect(after.grandTotalBase).toBe(before.grandTotalBase);
    expect(after.grandTotalBase).toBe(3_500_000n);
    // ولی توزیعِ سطل‌ها فرق کرده
    expect(before.rows[0].buckets['90+']).toBe(1_500_000n);
    expect(after.rows[0].buckets['90+']).toBe(3_000_000n);
    expect(old).toBeTruthy();
  });

  it('تخصیص به تسویهٔ آینده، ماندهٔ امروز را کم نمی‌کند', async () => {
    // ⚠️ رگرسیون. این را دادهٔ زندهٔ staging گرفت، نه تست‌ها: یک تخصیص به
    // دریافتی با تاریخِ سال بعد ثبت شد و ماندهٔ باز **امروز** ۵۷ میلیون کم
    // شد — پرداختی که هنوز نشده بود. سن‌بندی «در تاریخ X» است، پس تخصیصی که
    // یک سرش بعد از X است در آن تاریخ وجود ندارد.
    const inv = await invoice(alpha, 1_000_000n, daysBefore(50));
    const future = await receipt(alpha, 1_000_000n, new Date(AS_OF.getTime() + 30 * 86_400_000));
    await link(inv, future);

    const r = await aging(gl, '1104', AS_OF);
    expect(r.grandTotalBase).toBe(1_000_000n);        // هنوز طلبکاریم
    expect(r.rows[0].buckets['31-60']).toBe(1_000_000n);
    expect(r.explicitCoverage).toBeNull();            // تسویه‌ای در بازه نیست

    // ولی در تاریخِ بعد از پرداخت، تخصیص اثر می‌کند
    const later = await aging(gl, '1104', new Date(AS_OF.getTime() + 60 * 86_400_000));
    expect(later.grandTotalBase).toBe(0n);
    expect(later.explicitCoverage).toBe(1000);
  });

  it('تخصیص به فاکتورِ آینده، تسویهٔ امروز را از FIFO نمی‌دزدد', async () => {
    // تقارنِ همان قاعده: اگر فقط سرِ تسویه فیلتر می‌شد، این حالت مانده را
    // بیشتر نشان می‌داد.
    const oldInv = await invoice(alpha, 1_000_000n, daysBefore(50));
    const futureInv = await invoice(alpha, 1_000_000n, new Date(AS_OF.getTime() + 30 * 86_400_000));
    const rec = await receipt(alpha, 1_000_000n, daysBefore(2));
    await link(futureInv, rec);

    const r = await aging(gl, '1104', AS_OF);
    // فاکتور آینده هنوز وجود ندارد؛ دریافتِ امروز باید FIFO فاکتور قدیمی را ببندد
    expect(r.grandTotalBase).toBe(0n);
    expect(r.explicitCoverage).toBe(0);
    expect(oldInv).toBeTruthy();
  });

  it('تخصیصِ کامل، طرف‌حساب را از گزارش حذف می‌کند', async () => {
    const inv = await invoice(alpha, 1_000_000n, daysBefore(50));
    const rec = await receipt(alpha, 1_000_000n, daysBefore(2));
    await link(inv, rec);
    expect((await aging(gl, '1104', AS_OF)).rows).toHaveLength(0);
  });
});
