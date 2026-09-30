/**
 * پنج قاعدهٔ تخطی‌ناپذیر — docs/ACCOUNTING_SPEC.md بخش ۲
 *
 * الزام سند: «برای هر پنج مورد تست بنویس. تست‌ها باید تلاش برای نقض هر قاعده را
 * شکست‌خورده نشان دهند.»
 *
 * پس این تست‌ها عمداً از موتور **عبور نمی‌کنند** هرجا که هدف، سنجش اجبار در سطح
 * دیتابیس است — چون قاعده باید حتی وقتی کسی لایهٔ برنامه را دور می‌زند برقرار بماند.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode,
  makeSubsidiary, makeCostCenter, accountBalanceBase, DEFAULT_DATE, D, expectRejects,
} from '../helpers/gl';
import { post, reverse, nextSerial, LedgerError } from '../../src/modules/ledger/poster';
import { rateFrom } from '../../src/modules/ledger/money';

let fy: { id: string };
let cash: { id: string };          // ۱۱۰۱۰۱ صندوق
let sales: { id: string };         // ۴۱۰۱ فروش کالا
let ar: { id: string };            // ۱۱۰۴ دریافتنی تجاری — تفصیلی اجباری
let payroll: { id: string };       // ۶۱۰۱ حقوق — مرکز هزینه اجباری
let assetsRoot: { id: string };    // ۱ — سرگروه

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
  cash = await accountByCode('110101');
  sales = await accountByCode('4101');
  ar = await accountByCode('1104');
  payroll = await accountByCode('6101');
  assetsRoot = await accountByCode('1');
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl();
  fy = await makeFiscalYear();
});


/** یک سند ساده و تراز: بدهکار صندوق / بستانکار فروش */
const simple = (amount: bigint) => ({
  fiscalYearId: fy.id,
  date: DEFAULT_DATE,
  description: 'سند آزمایشی',
  lines: [
    { accountId: cash.id, currencyCode: 'IRR', debit: amount },
    { accountId: sales.id, currencyCode: 'IRR', credit: amount },
  ],
});

// ═══════════════════════════════════════════════════════════════
describe('قاعدهٔ ۱ — توازن', () => {
  it('سند تراز ثبت می‌شود', async () => {
    const entry = await gl.$transaction((tx) => post(tx, simple(1_000_000n)));
    expect(entry.lines).toHaveLength(2);
    expect(entry.status).toBe('POSTED');
    expect(await gl.glLine.count({ where: { entryId: entry.id } })).toBe(2);
  });

  it('سند ناتراز از مسیر موتور رد می‌شود', async () => {
    await expect(gl.$transaction((tx) => post(tx, {
      ...simple(1_000_000n),
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 900_000n },
      ],
    }))).rejects.toThrow(LedgerError);

    expect(await gl.glEntry.count()).toBe(0);
  });

  it('سند ناتراز از مسیر مستقیم دیتابیس هم رد می‌شود', async () => {
    // لایهٔ برنامه دور زده می‌شود — قاعده باید در دیتابیس بسته باشد
    await expect(gl.$transaction(async (tx) => {
      const e = await tx.glEntry.create({
        data: {
          fiscalYearId: fy.id, serial: 1, date: DEFAULT_DATE,
          description: 'دور زدن موتور', status: 'POSTED',
          lines: {
            create: [
              { lineNo: 1, accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000n, credit: 0n, rate: '1', debitBase: 1_000_000n, creditBase: 0n },
              { lineNo: 2, accountId: sales.id, currencyCode: 'IRR', debit: 0n, credit: 900_000n, rate: '1', debitBase: 0n, creditBase: 900_000n },
            ],
          },
        },
      });
      await tx.$executeRawUnsafe('SET CONSTRAINTS "gl_entry_must_balance" IMMEDIATE');
      return e;
    })).rejects.toThrow(/تراز نیست/);

    expect(await gl.glEntry.count()).toBe(0);
  });

  it('سند تک‌ردیفی رد می‌شود', async () => {
    await expect(gl.$transaction((tx) => post(tx, {
      ...simple(1n),
      lines: [{ accountId: cash.id, currencyCode: 'IRR', debit: 1_000n }],
    }))).rejects.toThrow(/دو ردیف/);
  });

  it('ردیف دوسویه رد می‌شود', async () => {
    await expect(gl.$transaction((tx) => post(tx, {
      ...simple(1n),
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 1_000n, credit: 500n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 500n },
      ],
    }))).rejects.toThrow(/همزمان بدهکار و بستانکار/);
  });

  it('تراز به ارز پایه سنجیده می‌شود، نه به تفکیک ارز', async () => {
    // ۱۰ دلار = ۱۰٬۰۰۰٬۰۰۰ ریال ⇒ به تفکیک ارز ناتراز، به ریال تراز
    const entry = await gl.$transaction((tx) => post(tx, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'تبدیل',
      lines: [
        { accountId: cash.id, currencyCode: 'USD', debit: 1_000n, rate: rateFrom(1_000_000) },
        { accountId: sales.id, currencyCode: 'IRR', credit: 10_000_000n },
      ],
    }));
    expect(entry.lines).toHaveLength(2);
    const usd = entry.lines.find((l) => l.currencyCode === 'USD')!;
    expect(usd.debitBase).toBe(10_000_000n); // ۱۰٫۰۰ دلار × ۱٬۰۰۰٬۰۰۰ ریال
  });

  it('ثبت روی سرگروه رد می‌شود', async () => {
    await expect(gl.$transaction((tx) => post(tx, {
      ...simple(1n),
      lines: [
        { accountId: assetsRoot.id, currencyCode: 'IRR', debit: 1_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 1_000n },
      ],
    }))).rejects.toThrow(/سرگروه/);
  });

  it('حساب با تفصیلی اجباری، بدون تفصیلی رد می‌شود', async () => {
    await expect(gl.$transaction((tx) => post(tx, {
      ...simple(1n),
      lines: [
        { accountId: ar.id, currencyCode: 'IRR', debit: 1_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 1_000n },
      ],
    }))).rejects.toThrow(/تفصیلی اجباری/);
  });

  it('حساب با مرکز هزینهٔ اجباری، بدون مرکز هزینه رد می‌شود', async () => {
    await expect(gl.$transaction((tx) => post(tx, {
      ...simple(1n),
      lines: [
        { accountId: payroll.id, currencyCode: 'IRR', debit: 1_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 1_000n },
      ],
    }))).rejects.toThrow(/مرکز هزینه/);
  });

  it('تفصیلی از نوع نامجاز رد می‌شود', async () => {
    // ۱۱۰۴ فقط CUSTOMER می‌پذیرد
    const emp = await makeSubsidiary('EMPLOYEE', 'کارمند الف');
    await expect(gl.$transaction((tx) => post(tx, {
      ...simple(1n),
      lines: [
        { accountId: ar.id, subsidiaryId: emp.id, currencyCode: 'IRR', debit: 1_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 1_000n },
      ],
    }))).rejects.toThrow(/مجاز نیست/);
  });

  it('با تفصیلی و مرکز هزینهٔ درست، ثبت می‌شود', async () => {
    const cust = await makeSubsidiary('CUSTOMER', 'مشتری الف');
    const cc = await makeCostCenter('CC1', 'واحد اداری');

    const entry = await gl.$transaction((tx) => post(tx, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش و حقوق',
      lines: [
        { accountId: ar.id, subsidiaryId: cust.id, currencyCode: 'IRR', debit: 3_000_000n },
        { accountId: payroll.id, costCenterId: cc.id, currencyCode: 'IRR', debit: 1_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 4_000_000n },
      ],
    }));
    expect(entry.lines).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('قاعدهٔ ۲ — اتمیک بودن', () => {
  it('شکست وسط کار، هیچ اثری باقی نمی‌گذارد', async () => {
    await expect(gl.$transaction(async (tx) => {
      await post(tx, simple(1_000_000n));           // این موفق است
      await post(tx, {                               // این می‌شکند
        ...simple(1n),
        lines: [
          { accountId: cash.id, currencyCode: 'IRR', debit: 500n },
          { accountId: sales.id, currencyCode: 'IRR', credit: 400n },
        ],
      });
    }, { timeout: 30_000 })).rejects.toThrow();

    expect(await gl.glEntry.count()).toBe(0);
    expect(await gl.glLine.count()).toBe(0);
  });

  it('شمارندهٔ سریال هم با تراکنش برمی‌گردد — بدون شکاف', async () => {
    await expect(gl.$transaction(async (tx) => {
      await post(tx, simple(1_000_000n));
      throw new Error('شکست عمدی');
    }, { timeout: 30_000 })).rejects.toThrow('شکست عمدی');

    const counter = await gl.glSerialCounter.findUniqueOrThrow({ where: { fiscalYearId: fy.id } });
    expect(counter.next).toBe(1); // مصرف نشده

    const entry = await gl.$transaction((tx) => post(tx, simple(2_000_000n)));
    expect(entry.serial).toBe(1); // شمارهٔ ۱ هنوز در دسترس است
  });

  it('چند سند در یک تراکنش، سریال پیوسته می‌گیرند', async () => {
    const entries = await gl.$transaction(async (tx) => {
      const a = await post(tx, simple(100n));
      const b = await post(tx, simple(200n));
      const c = await post(tx, simple(300n));
      return [a, b, c];
    }, { timeout: 30_000 });

    expect(entries.map((e) => e.serial)).toEqual([1, 2, 3]);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('قاعدهٔ ۳ — ماندهٔ محاسبه‌شونده', () => {
  it('هیچ ستون ماندهٔ ذخیره‌شده‌ای در مدل وجود ندارد', async () => {
    const cols = await gl.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'GlAccount'
    `;
    const names = cols.map((c) => c.column_name.toLowerCase());
    expect(names).not.toContain('balance');
    expect(names).not.toContain('amount');
  });

  it('مانده از جمع ردیف‌ها می‌آید و با هر سند به‌روز است', async () => {
    await gl.$transaction((tx) => post(tx, simple(1_000_000n)));
    expect(await accountBalanceBase(cash.id)).toBe(1_000_000n);

    await gl.$transaction((tx) => post(tx, simple(500_000n)));
    expect(await accountBalanceBase(cash.id)).toBe(1_500_000n);
  });

  it('ماندهٔ سرگروه = جمع نوادگانش، بدون ذخیره‌سازی', async () => {
    await gl.$transaction((tx) => post(tx, simple(2_000_000n)));

    const rows = await gl.$queryRaw<{ bal: bigint }[]>`
      WITH RECURSIVE tree AS (
        SELECT id FROM "GlAccount" WHERE code = '1'
        UNION ALL
        SELECT a.id FROM "GlAccount" a JOIN tree t ON a."parentId" = t.id
      )
      SELECT COALESCE(SUM(l."debitBase") - SUM(l."creditBase"), 0)::bigint AS bal
      FROM "GlLine" l WHERE l."accountId" IN (SELECT id FROM tree)
    `;
    expect(BigInt(rows[0].bal)).toBe(2_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('قاعدهٔ ۴ — تغییرناپذیری', () => {
  it('ویرایش ردیف سند ثبت‌شده رد می‌شود', async () => {
    const entry = await gl.$transaction((tx) => post(tx, simple(1_000_000n)));
    const line = entry.lines[0];

    await expectRejects(
      () => gl.glLine.update({ where: { id: line.id }, data: { memo: 'دستکاری' } }),
      /اصلاح فقط با سند برگشتی/,
    );
  });

  it('حذف ردیف سند ثبت‌شده رد می‌شود', async () => {
    const entry = await gl.$transaction((tx) => post(tx, simple(1_000_000n)));
    await expectRejects(
      () => gl.glLine.delete({ where: { id: entry.lines[0].id } }),
      /اصلاح فقط با سند برگشتی/,
    );
  });

  it('حذف سند ثبت‌شده رد می‌شود', async () => {
    const entry = await gl.$transaction((tx) => post(tx, simple(1_000_000n)));
    await expectRejects(
      () => gl.glEntry.delete({ where: { id: entry.id } }),
      /اصلاح فقط با سند برگشتی/,
    );
  });

  it('ویرایش سربرگ سند ثبت‌شده رد می‌شود', async () => {
    const entry = await gl.$transaction((tx) => post(tx, simple(1_000_000n)));
    await expectRejects(
      () => gl.glEntry.update({ where: { id: entry.id }, data: { description: 'دستکاری' } }),
      /اصلاح فقط با سند برگشتی/,
    );
  });

  it('گذار وضعیت غیرمجاز رد می‌شود', async () => {
    const entry = await gl.$transaction((tx) => post(tx, simple(1_000_000n)));
    await expect(
      gl.glEntry.update({ where: { id: entry.id }, data: { status: 'DRAFT' } }),
    ).rejects.toThrow(/مجاز نیست/);
  });

  it('اصلاح فقط با سند برگشتی — و مانده دقیقاً صفر می‌شود', async () => {
    const entry = await gl.$transaction((tx) => post(tx, simple(1_000_000n)));
    expect(await accountBalanceBase(cash.id)).toBe(1_000_000n);

    const rev = await gl.$transaction((tx) => reverse(tx, entry.id, { reason: 'اشتباه' }), { timeout: 30_000 });

    expect(rev.entryType).toBe('REVERSING');
    expect(rev.reversesId).toBe(entry.id);
    expect(await accountBalanceBase(cash.id)).toBe(0n);

    const original = await gl.glEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(original.status).toBe('REVERSED');
    // هر دو سند در دفتر می‌مانند — ابطال حذف نیست
    expect(await gl.glEntry.count()).toBe(2);
  });

  it('ابطال دوبارهٔ یک سند رد می‌شود', async () => {
    const entry = await gl.$transaction((tx) => post(tx, simple(1_000_000n)));
    await gl.$transaction((tx) => reverse(tx, entry.id, { reason: 'یک' }), { timeout: 30_000 });
    await expect(
      gl.$transaction((tx) => reverse(tx, entry.id, { reason: 'دو' }), { timeout: 30_000 }),
    ).rejects.toThrow(/قبلاً باطل/);
  });

  it('سند داخل دورهٔ قفل‌شده ثبت نمی‌شود', async () => {
    await gl.glPeriodLock.create({
      data: { module: 'ALL', lockToDate: D('2026-07-01'), reason: 'بستن دوره' },
    });
    await expect(gl.$transaction((tx) => post(tx, {
      ...simple(1_000_000n), date: D('2026-06-15'),
    }))).rejects.toThrow(/بسته است/);
  });

  it('سند بعد از تاریخ قفل ثبت می‌شود', async () => {
    await gl.glPeriodLock.create({
      data: { module: 'ALL', lockToDate: D('2026-07-01'), reason: 'بستن دوره' },
    });
    const entry = await gl.$transaction((tx) => post(tx, {
      ...simple(1_000_000n), date: D('2026-07-15'),
    }));
    expect(entry.serial).toBe(1);
  });

  it('سند بیرون از بازهٔ سال مالی رد می‌شود', async () => {
    await expect(gl.$transaction((tx) => post(tx, {
      ...simple(1_000_000n), date: D('2028-01-01'),
    }))).rejects.toThrow(/سال مالی/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('قاعدهٔ ۵ — ثبت کامل ارز', () => {
  it('هر ردیف مبلغ ارزی، مبلغ پایه و نرخ را با هم نگه می‌دارد', async () => {
    const entry = await gl.$transaction((tx) => post(tx, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش دلاری',
      lines: [
        { accountId: cash.id, currencyCode: 'USD', debit: 10_000n, rate: rateFrom('95000.5') },
        { accountId: sales.id, currencyCode: 'IRR', credit: 9_500_050n },
      ],
    }));

    const usd = entry.lines.find((l) => l.currencyCode === 'USD')!;
    expect(usd.debit).toBe(10_000n);              // ۱۰۰٫۰۰ دلار به سنت
    expect(usd.debitBase).toBe(9_500_050n);       // ۱۰۰ × ۹۵۰۰۰٫۵ ریال
    expect(usd.rate.toString()).toBe('95000.5');  // نرخ snapshot شده
  });

  it('نرخ روی ردیف قفل می‌شود و تغییر بعدیِ جدول نرخ اثری ندارد', async () => {
    const entry = await gl.$transaction((tx) => post(tx, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'خرید دلاری',
      lines: [
        { accountId: cash.id, currencyCode: 'USD', debit: 10_000n, rate: rateFrom(90_000) },
        { accountId: sales.id, currencyCode: 'IRR', credit: 9_000_000n },
      ],
    }));

    // نرخ «جاری» بعداً عوض می‌شود
    await gl.glExchangeRate.create({
      data: { from: 'USD', to: 'IRR', rate: '120000', date: DEFAULT_DATE, source: 'API' },
    });

    const again = await gl.glLine.findUniqueOrThrow({ where: { id: entry.lines[0].id } });
    expect(again.rate.toString()).toBe('90000');
    expect(again.debitBase).toBe(9_000_000n);
  });

  it('مبلغ پایهٔ ناسازگار با نرخ رد می‌شود', async () => {
    await expectRejects(() => gl.$transaction(async (tx) => {
      const e = await tx.glEntry.create({
        data: { fiscalYearId: fy.id, serial: 1, date: DEFAULT_DATE, description: 'دستکاری', status: 'POSTED' },
      });
      await tx.glLine.create({
        data: {
          entryId: e.id, lineNo: 1, accountId: cash.id, currencyCode: 'USD',
          debit: 10_000n, credit: 0n, rate: '90000',
          debitBase: 1n, creditBase: 0n,      // ← دروغ
        },
      });
    }), /مبلغ پایه با نرخ/);
  });

  it('نرخ صفر یا منفی رد می‌شود', async () => {
    await expect(gl.$transaction(async (tx) => {
      const e = await tx.glEntry.create({
        data: { fiscalYearId: fy.id, serial: 1, date: DEFAULT_DATE, description: 'نرخ صفر', status: 'POSTED' },
      });
      await tx.glLine.create({
        data: {
          entryId: e.id, lineNo: 1, accountId: cash.id, currencyCode: 'USD',
          debit: 10_000n, credit: 0n, rate: '0', debitBase: 0n, creditBase: 0n,
        },
      });
    })).rejects.toThrow();
  });

  it('ارز غیرپایه بدون نرخ رد می‌شود', async () => {
    await expect(gl.$transaction((tx) => post(tx, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'بدون نرخ',
      lines: [
        { accountId: cash.id, currencyCode: 'USD', debit: 10_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 1n },
      ],
    }))).rejects.toThrow(/نرخ الزامی/);
  });

  it('اعشار هر ارز رعایت می‌شود: ریال ۰، دلار ۲', async () => {
    const irr = await gl.glCurrency.findUniqueOrThrow({ where: { code: 'IRR' } });
    const usd = await gl.glCurrency.findUniqueOrThrow({ where: { code: 'USD' } });
    expect(irr.decimalPlaces).toBe(0);
    expect(irr.isBase).toBe(true);
    expect(usd.decimalPlaces).toBe(2);
  });

  it('سند برگشتی نرخ اصلی را حفظ می‌کند تا خنثی‌سازی دقیق باشد', async () => {
    const entry = await gl.$transaction((tx) => post(tx, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش دلاری',
      lines: [
        { accountId: cash.id, currencyCode: 'USD', debit: 10_000n, rate: rateFrom(90_000) },
        { accountId: sales.id, currencyCode: 'IRR', credit: 9_000_000n },
      ],
    }));
    const rev = await gl.$transaction((tx) => reverse(tx, entry.id, { reason: 'ابطال' }), { timeout: 30_000 });

    const revUsd = rev.lines.find((l) => l.currencyCode === 'USD')!;
    expect(revUsd.rate.toString()).toBe('90000');
    expect(revUsd.creditBase).toBe(9_000_000n);
    expect(await accountBalanceBase(cash.id)).toBe(0n);
  });
});
