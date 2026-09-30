/**
 * دفاتر قانونی و صورتحساب طرف‌حساب — مرحلهٔ ۵ الف.
 *
 * حساس‌ترین بخش **زنجیرهٔ نقل صفحه** است: «نقل به صفحهٔ بعد»ِ هر صفحه باید
 * دقیقاً «نقل از صفحهٔ قبل»ِ صفحهٔ بعدی باشد. اگر این زنجیره جایی بشکند،
 * دفتری که به ممیز داده می‌شود با خودش نمی‌خواند.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, makeSubsidiary, accountByCode,
  D, resetBusinessData, expectRejects,
} from '../helpers/gl';
import { post, reverse, createDraft } from '../../src/modules/ledger/poster';
import {
  journalBook, generalLedgerBook, partyStatement,
} from '../../src/modules/ledger/reports/statutory';

let fy: any, cash: any, sales: any, ar: any, ap: any, rent: any;
let alpha: any, vendor: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

const YEAR = { from: D('2026-03-21'), to: D('2027-03-20') };

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
  vendor = await makeSubsidiary('SUPPLIER', 'تأمین‌کنندهٔ ب');
});

const invoice = (amount: bigint, date: Date) =>
  entry(date, `فاکتور ${amount}`, [
    { accountId: ar.id, subsidiaryId: alpha.id, currencyCode: 'IRR', debit: amount },
    { accountId: sales.id, currencyCode: 'IRR', credit: amount },
  ]);

const receipt = (amount: bigint, date: Date) =>
  entry(date, `دریافت ${amount}`, [
    { accountId: cash.id, currencyCode: 'IRR', debit: amount },
    { accountId: ar.id, subsidiaryId: alpha.id, currencyCode: 'IRR', credit: amount },
  ]);

// ═══════════════════════════════════════════════════════════════
describe('دفتر روزنامهٔ قانونی', () => {
  it('صفحه‌بندی می‌شود و زنجیرهٔ نقل صفحه نمی‌شکند', async () => {
    // ⚠️ قلبِ ماجرا: «نقل به بعد»ِ هر صفحه = «نقل از قبل»ِ صفحهٔ بعد
    for (let i = 0; i < 12; i++) {
      await invoice(BigInt(1_000_000 * (i + 1)), D('2026-04-01'));
    }
    const b = await journalBook(gl, { ...YEAR, rowsPerPage: 5 });
    expect(b.lineCount).toBe(24);            // ۱۲ سندِ دو ردیفی
    expect(b.pages).toHaveLength(5);         // ۲۴ ÷ ۵ = ۵ صفحه

    expect(b.pages[0].broughtForward.debit).toBe('0');
    for (let i = 1; i < b.pages.length; i++) {
      expect(b.pages[i].broughtForward).toEqual(b.pages[i - 1].carriedForward);
    }
  });

  it('جمعِ صفحه با جمعِ ردیف‌های همان صفحه می‌خواند', async () => {
    for (let i = 0; i < 6; i++) await invoice(1_000_000n, D('2026-04-01'));
    const b = await journalBook(gl, { ...YEAR, rowsPerPage: 4 });
    for (const p of b.pages) {
      const sum = p.lines.reduce((s, l) => s + BigInt(l.debit), 0n);
      expect(p.pageTotal.debit).toBe(sum.toString());
      expect(BigInt(p.carriedForward.debit))
        .toBe(BigInt(p.broughtForward.debit) + BigInt(p.pageTotal.debit));
    }
  });

  it('دفتر در جمع نهایی تراز است', async () => {
    await invoice(5_000_000n, D('2026-04-01'));
    await receipt(2_000_000n, D('2026-05-01'));
    const b = await journalBook(gl, YEAR);
    expect(b.balanced).toBe(true);
    expect(b.total.debit).toBe(b.total.credit);
  });

  it('پیش‌نویس در دفتر قانونی نمی‌آید', async () => {
    await invoice(1_000_000n, D('2026-04-01'));
    await tx((t) => createDraft(t, {
      fiscalYearId: fy.id, date: D('2026-04-02'), description: 'پیش‌نویس',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 9_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 9_000_000n },
      ],
    }));
    const b = await journalBook(gl, YEAR);
    expect(b.lineCount).toBe(2);
    expect(b.pages[0].lines.every((l) => l.status !== 'DRAFT')).toBe(true);
  });

  it('سند باطل‌شده و برگشتی‌اش هر دو می‌آیند', async () => {
    // دفتر قانونی تاریخ است نه خلاصه
    const e: any = await invoice(3_000_000n, D('2026-04-01'));
    await tx((t) => reverse(t, e.id, { reason: 'اشتباه' }));

    const b = await journalBook(gl, YEAR);
    expect(b.lineCount).toBe(4);
    expect(b.pages[0].lines.some((l) => l.status === 'REVERSED')).toBe(true);
    // و با وجود هر دو، جمع تراز می‌ماند
    expect(b.balanced).toBe(true);
  });

  it('دورهٔ خالی یک صفحهٔ صفر می‌دهد، نه خطا', async () => {
    const b = await journalBook(gl, YEAR);
    expect(b.pages).toHaveLength(1);
    expect(b.pages[0].lines).toHaveLength(0);
    expect(b.total.debit).toBe('0');
    expect(b.balanced).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('دفتر کل قانونی', () => {
  it('به تفکیک حساب کل و ماه تجمیع می‌شود', async () => {
    await invoice(1_000_000n, D('2026-04-01'));    // ۱۱ و ۴۱
    await invoice(2_000_000n, D('2026-05-01'));
    const b = await generalLedgerBook(gl, YEAR);

    const ar11 = b.sections.find((s) => s.code === '11')!;
    expect(ar11.rows).toHaveLength(2);             // دو ماه
    expect(ar11.totalDebit).toBe('3000000');
    expect(ar11.closing).toBe('3000000');
  });

  it('ماندهٔ در حال حرکت درست انباشته می‌شود', async () => {
    await invoice(5_000_000n, D('2026-04-01'));
    await receipt(2_000_000n, D('2026-05-01'));
    const b = await generalLedgerBook(gl, YEAR);
    const s = b.sections.find((x) => x.code === '11')!;
    // فروردین: +۵ دریافتنی · اردیبهشت: +۲ نقد −۲ دریافتنی ⇒ خالص ۵
    expect(s.closing).toBe('5000000');
  });

  it('ماندهٔ پیش از بازه به‌عنوان ابتدای دوره می‌آید', async () => {
    await invoice(4_000_000n, D('2026-04-01'));
    const b = await generalLedgerBook(gl, {
      from: D('2026-06-01'), to: D('2027-03-20'),
    });
    const s = b.sections.find((x) => x.code === '11');
    // در بازهٔ انتخابی گردشی نیست، ولی مانده باید منتقل شده باشد
    if (s) expect(s.opening).toBe('4000000');
  });

  it('جمع کل دفتر کل تراز است', async () => {
    await invoice(7_000_000n, D('2026-04-01'));
    await entry(D('2026-05-05'), 'اجاره', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 500_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 500_000n },
    ]);
    const b = await generalLedgerBook(gl, YEAR);
    expect(b.balanced).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('صورتحساب طرف‌حساب', () => {
  it('ماندهٔ ابتدا، گردش و ماندهٔ پایان را می‌دهد', async () => {
    await invoice(5_000_000n, D('2026-04-01'));
    await receipt(2_000_000n, D('2026-05-01'));

    const st = await partyStatement(gl, {
      subsidiaryId: alpha.id, from: D('2026-04-15'), to: D('2027-03-20'),
    });
    const irr = st.currencies.find((c) => c.currencyCode === 'IRR')!;
    expect(irr.opening).toBe('5000000');        // فاکتور پیش از بازه
    expect(irr.totalCredit).toBe('2000000');    // دریافتِ داخل بازه
    expect(irr.closing).toBe('3000000');
    expect(irr.verdict).toBe('بدهکار به ما');
  });

  it('ماندهٔ در حال حرکت با هر سطر جلو می‌رود', async () => {
    await invoice(1_000_000n, D('2026-04-01'));
    await invoice(2_000_000n, D('2026-04-02'));
    await receipt(500_000n, D('2026-04-03'));

    const st = await partyStatement(gl, { subsidiaryId: alpha.id, ...YEAR });
    const irr = st.currencies[0];
    expect(irr.lines.map((l) => l.running)).toEqual(['1000000', '3000000', '2500000']);
  });

  it('پیش‌پرداختِ مشتری، جملهٔ برعکس می‌گیرد', async () => {
    await receipt(3_000_000n, D('2026-04-01'));
    const st = await partyStatement(gl, { subsidiaryId: alpha.id, ...YEAR });
    expect(st.currencies[0].closing).toBe('-3000000');
    expect(st.currencies[0].verdict).toMatch(/ما به او بدهکاریم/);
  });

  it('پرداختنی: جهت برعکس است و جمله هم', async () => {
    // ⚠️ همان چیزی که اول اشتباه نوشته بودم: `closing` مثبت روی پرداختنی
    // یعنی **ما** بدهکاریم، نه او.
    await entry(D('2026-04-01'), 'فاکتور خرید', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 4_000_000n },
      { accountId: ap.id, subsidiaryId: vendor.id, currencyCode: 'IRR', credit: 4_000_000n },
    ]);
    const st = await partyStatement(gl, { subsidiaryId: vendor.id, ...YEAR });
    const c = st.currencies[0];
    expect(c.totalDebit).toBe('4000000');       // ستون اول = افزایش تعهد
    expect(c.closing).toBe('4000000');
    expect(c.verdict).toBe('ما به او بدهکاریم');
  });

  it('هر ارز بخش خودش را دارد — جمع ریال و دلار قابل پرداخت نیست', async () => {
    await invoice(1_000_000n, D('2026-04-01'));
    await entry(D('2026-04-02'), 'فاکتور دلاری', [
      { accountId: ar.id, subsidiaryId: alpha.id, currencyCode: 'USD', debit: 10_000n, rate: '900000' },
      { accountId: sales.id, currencyCode: 'USD', credit: 10_000n, rate: '900000' },
    ]);
    const st = await partyStatement(gl, { subsidiaryId: alpha.id, ...YEAR });
    expect(st.currencies).toHaveLength(2);
    expect(st.currencies.find((c) => c.currencyCode === 'USD')!.closing).toBe('10000');
  });

  it('طرف‌حسابِ بی‌تراکنش، `empty` برمی‌گرداند نه خطا', async () => {
    const st = await partyStatement(gl, { subsidiaryId: alpha.id, ...YEAR });
    expect(st.empty).toBe(true);
    expect(st.currencies).toHaveLength(0);
  });

  it('طرف‌حسابِ ناموجود خطای روشن می‌دهد', async () => {
    await expectRejects(
      () => partyStatement(gl, { subsidiaryId: 'nope', ...YEAR }),
      /یافت نشد/,
    );
  });
});
