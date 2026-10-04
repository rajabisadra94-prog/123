/**
 * ذخیرهٔ مطالبات مشکوک‌الوصول — مرحلهٔ ۴ د.
 *
 * حساس‌ترین بخش **روشِ مانده** است: سند فقط تفاوتِ برآورد با ذخیرهٔ موجود را
 * می‌زند. اگر هر بار کلِ برآورد هزینه می‌شد، اجرای ماهانه ذخیره را دوازده
 * برابر می‌کرد.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, makeSubsidiary, accountByCode,
  D, resetBusinessData, expectRejects,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import {
  computeProvision, postProvision, getRates, setRates,
  DEFAULT_RATES, ALLOWANCE_CODE, PROVISION_SETTING_KEY,
} from '../../src/modules/ledger/provision';
import { balanceSheet } from '../../src/modules/ledger/reports/statements';

let fy: any, cash: any, sales: any, ar: any, alpha: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

// دیرتر در سال مالی، تا `daysBefore(200)` هم داخل بازهٔ سال بماند
const AS_OF = D('2026-11-01');
const daysBefore = (n: number) => new Date(AS_OF.getTime() - n * 86_400_000);

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
  ar = await accountByCode('1104');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await gl.systemSetting.deleteMany({ where: { key: PROVISION_SETTING_KEY } });
  await resetGl(); await resetBusinessData();
  fy = await makeFiscalYear();
  alpha = await makeSubsidiary('CUSTOMER', 'مشتری الف');
});

const invoice = (amount: bigint, date: Date) =>
  entry(date, `فاکتور ${amount}`, [
    { accountId: ar.id, subsidiaryId: alpha.id, currencyCode: 'IRR', debit: amount },
    { accountId: sales.id, currencyCode: 'IRR', credit: amount },
  ]);

// ═══════════════════════════════════════════════════════════════
describe('برآورد ذخیره', () => {
  it('هر سطل نرخ خودش را می‌گیرد', async () => {
    await invoice(1_000_000_000n, daysBefore(10));    // ۰٪
    await invoice(1_000_000_000n, daysBefore(45));    // ۵٪  = ۵۰م
    await invoice(1_000_000_000n, daysBefore(75));    // ۱۵٪ = ۱۵۰م
    await invoice(1_000_000_000n, daysBefore(200));   // ۵۰٪ = ۵۰۰م

    const c = await computeProvision(gl, AS_OF);
    expect(c.required).toBe('700000000');
    expect(c.existing).toBe('0');
    expect(c.delta).toBe('700000000');
    expect(c.lines.find((l) => l.bucket === '0-30')!.required).toBe('0');
    expect(c.lines.find((l) => l.bucket === '90+')!.required).toBe('500000000');
  });

  it('طلبِ تازه ذخیره نمی‌خواهد', async () => {
    await invoice(5_000_000_000n, daysBefore(5));
    const c = await computeProvision(gl, AS_OF);
    expect(c.required).toBe('0');
    expect(c.coverageRate).toBe(0);
  });

  it('پیش‌پرداختِ مشتری (ماندهٔ منفی) ذخیره نمی‌گیرد', async () => {
    // بدهیِ ماست نه طلبمان؛ درصد گرفتن از آن یعنی ذخیرهٔ منفی
    await entry(daysBefore(100), 'پیش‌پرداخت مشتری', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000_000n },
      { accountId: ar.id, subsidiaryId: alpha.id, currencyCode: 'IRR', credit: 1_000_000_000n },
    ]);
    const c = await computeProvision(gl, AS_OF);
    expect(BigInt(c.required)).toBeGreaterThanOrEqual(0n);
    expect(c.required).toBe('0');
  });

  it('نرخ پوشش، ذخیره را نسبت به کل مطالبات می‌سنجد', async () => {
    await invoice(1_000_000_000n, daysBefore(200));   // ۵۰٪ ⇒ ۵۰۰م از ۱ میلیارد
    const c = await computeProvision(gl, AS_OF);
    expect(c.coverageRate).toBe(500);
  });

  it('بدون مطالبات، نرخ پوشش null است نه صفر', async () => {
    const c = await computeProvision(gl, AS_OF);
    expect(c.coverageRate).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
describe('درصدها', () => {
  it('پیش‌فرض وقتی تنظیمی نیست', async () => {
    expect(await getRates(gl)).toEqual(DEFAULT_RATES);
  });

  it('درصد تنظیم‌شده جای پیش‌فرض را می‌گیرد', async () => {
    await tx((t) => setRates(t, { '0-30': 0, '31-60': 100, '61-90': 300, '90+': 1000 }));
    await invoice(1_000_000_000n, daysBefore(200));
    const c = await computeProvision(gl, AS_OF);
    expect(c.required).toBe('1000000000');   // صد درصد
  });

  it('درصد خارج از محدوده رد می‌شود', async () => {
    await expectRejects(
      () => tx((t) => setRates(t, { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 1500 })),
      /بین ۰ تا ۱۰۰۰/,
    );
  });

  it('تنظیماتِ خراب گزارش را نمی‌اندازد — پیش‌فرض جایش می‌نشیند', async () => {
    await gl.systemSetting.create({
      data: { key: PROVISION_SETTING_KEY, value: 'این JSON نیست' },
    });
    expect(await getRates(gl)).toEqual(DEFAULT_RATES);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ثبت سند — روشِ مانده', () => {
  it('نخستین اجرا، کلِ برآورد را هزینه می‌کند', async () => {
    await invoice(1_000_000_000n, daysBefore(200));
    const out = await tx((t) => postProvision(t, { fiscalYearId: fy.id, asOf: AS_OF }));
    expect(out.posted).toBe(true);
    expect(out.calc.delta).toBe('500000000');

    const after = await computeProvision(gl, AS_OF);
    expect(after.existing).toBe('500000000');
    expect(after.delta).toBe('0');
  });

  it('اجرای دوباره سند نمی‌زند — وگرنه ذخیره دو برابر می‌شد', async () => {
    // ⚠️ همان چیزی که روشِ مانده برای آن است
    await invoice(1_000_000_000n, daysBefore(200));
    await tx((t) => postProvision(t, { fiscalYearId: fy.id, asOf: AS_OF }));
    const second = await tx((t) => postProvision(t, { fiscalYearId: fy.id, asOf: AS_OF }));

    expect(second.posted).toBe(false);
    expect((await computeProvision(gl, AS_OF)).existing).toBe('500000000');
  });

  it('طلبِ تازه، فقط تفاوت را هزینه می‌کند', async () => {
    await invoice(1_000_000_000n, daysBefore(200));
    await tx((t) => postProvision(t, { fiscalYearId: fy.id, asOf: AS_OF }));   // ۵۰۰م

    await invoice(1_000_000_000n, daysBefore(199));                            // ۵۰۰م دیگر لازم
    const out = await tx((t) => postProvision(t, { fiscalYearId: fy.id, asOf: AS_OF }));
    expect(out.posted).toBe(true);
    expect(out.calc.delta).toBe('500000000');                                  // نه ۱ میلیارد
    expect((await computeProvision(gl, AS_OF)).existing).toBe('1000000000');
  });

  it('وصولِ طلبِ معوق، ذخیره را برمی‌گرداند', async () => {
    await invoice(1_000_000_000n, daysBefore(200));
    await tx((t) => postProvision(t, { fiscalYearId: fy.id, asOf: AS_OF }));
    expect((await computeProvision(gl, AS_OF)).existing).toBe('500000000');

    await entry(daysBefore(1), 'وصول', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000_000n },
      { accountId: ar.id, subsidiaryId: alpha.id, currencyCode: 'IRR', credit: 1_000_000_000n },
    ]);
    const out = await tx((t) => postProvision(t, { fiscalYearId: fy.id, asOf: AS_OF }));
    expect(out.posted).toBe(true);
    expect(out.calc.delta).toBe('-500000000');
    expect((await computeProvision(gl, AS_OF)).existing).toBe('0');
  });

  it('سند تعدیلی است و منبعش Provision', async () => {
    await invoice(1_000_000_000n, daysBefore(200));
    const out: any = await tx((t) => postProvision(t, { fiscalYearId: fy.id, asOf: AS_OF }));
    expect(out.entry.entryType).toBe('ADJUSTING');
    expect(out.entry.sourceType).toBe('Provision');
  });

  it('ذخیره از دریافتنی کم می‌شود ولی خودِ ۱۱۰۴ دست‌نخورده می‌ماند', async () => {
    // طلبِ حقوقیِ ما عوض نشده؛ ذخیره یک برآورد است، نه بخشش طلب
    await invoice(1_000_000_000n, daysBefore(200));
    await tx((t) => postProvision(t, { fiscalYearId: fy.id, asOf: AS_OF }));

    const [arRow] = await gl.$queryRaw<{ amount: bigint }[]>`
      SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS amount
      FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
      JOIN "GlAccount" a ON a.id = l."accountId"
      WHERE a.code = '1104' AND e.status <> 'DRAFT'`;
    expect(BigInt(arRow.amount)).toBe(1_000_000_000n);   // دست‌نخورده

    const bs: any = await balanceSheet(gl, AS_OF, { compare: false });
    const allowance = bs.assets.find((a: any) => a.code === ALLOWANCE_CODE);
    // حسابِ کاهنده با ماندهٔ منفی زیر دارایی‌ها می‌نشیند
    expect(allowance).toBeTruthy();
    expect(BigInt(allowance!.amount)).toBe(-500_000_000n);
  });

  it('ترازنامه بعد از ثبت ذخیره همچنان تراز است', async () => {
    await invoice(1_000_000_000n, daysBefore(200));
    await tx((t) => postProvision(t, { fiscalYearId: fy.id, asOf: AS_OF }));
    const bs: any = await balanceSheet(gl, AS_OF, { compare: false });
    expect(bs.balanced).toBe(true);
  });
});
