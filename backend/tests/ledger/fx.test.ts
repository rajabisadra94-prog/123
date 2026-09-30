/**
 * فاز ۴ — چندارزی و تسعیر روی هستهٔ جدید.
 *
 * این تست‌ها آینهٔ `tests/proven/03` تا `05` هستند: **همان رفتارهای اثبات‌شده**،
 * این بار روی مدل جدید (عدد صحیح، تفصیلی شناور، ارز روی ردیف).
 * اگر رفتاری اینجا با آنجا فرق کند، یعنی چیزی در انتقال گم شده.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, DEFAULT_DATE, D, FY_END, expectRejects, resetBusinessData,
} from '../helpers/gl';
import { ensureSubsidiary } from '../../src/modules/ledger/subsidiary';
import { post } from '../../src/modules/ledger/poster';
import { rateFrom } from '../../src/modules/ledger/money';
import {
  carryingRate, positionBalance, postSettlement, postConversion,
  previewRevaluation, postRevaluation, resolveRate, FX_CODES, FxError,
} from '../../src/modules/ledger/fx';

let fy: { id: string };
let ar: { id: string };
let payable: { id: string };
let sales: { id: string };
let cash: { id: string };
let cogs: { id: string };
let customer: { id: string };
let producer: { id: string };

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

/** نرخ‌های ثابت: ۱ دلار = ۱٬۰۰۰٬۰۰۰ ریال ، ۱ یوآن = ۱۴۰٬۰۰۰ ریال */
async function seedRates(date = DEFAULT_DATE) {
  for (const [from, rate] of [['USD', '1000000'], ['CNY', '140000']] as const) {
    await gl.glExchangeRate.upsert({
      where: { from_to_date_source: { from, to: 'IRR', date, source: 'MANUAL' } },
      update: { rate },
      create: { from, to: 'IRR', date, rate, source: 'MANUAL' },
    });
  }
}

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
  ar = await accountByCode('1104');
  payable = await accountByCode('2101');
  sales = await accountByCode('4101');
  cash = await accountByCode('110101');
  cogs = await accountByCode('5101');
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl();
  await resetBusinessData();
  await gl.glExchangeRate.deleteMany({});
  await gl.customer.deleteMany({});
  await gl.producer.deleteMany({});
  fy = await makeFiscalYear();
  await seedRates();

  const c = await gl.customer.create({ data: { name: 'مشتری ارزی', shortCode: 'FX1' } });
  const p = await gl.producer.create({ data: { name: 'Sun' } });
  customer = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
  producer = await tx((t) => ensureSubsidiary(t, 'PRODUCER', 'Producer', p.id, p.name));
});

/** طلب دلاری روی مشتری با نرخ دفتری دلخواه */
const openReceivable = (amountCents: bigint, rate: string) =>
  tx((t) => post(t, {
    fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش دلاری',
    lines: [
      { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD', debit: amountCents, rate },
      { accountId: sales.id, currencyCode: 'USD', credit: amountCents, rate },
    ],
  }));

const fxLineOf = async (entryId: string) => {
  const lines = await gl.glLine.findMany({
    where: { entryId }, include: { account: { select: { code: true } } },
  });
  return lines.find((l) => l.account.code.startsWith('81') || l.account.code.startsWith('82'));
};

// ═══════════════════════════════════════════════════════════════
describe('نرخ', () => {
  it('آخرین نرخ تا تاریخ خوانده می‌شود', async () => {
    const r = await resolveRate(gl, 'USD', DEFAULT_DATE);
    expect(r.scaled).toBe(rateFrom('1000000').scaled);
  });

  it('ارز پایه نرخ قطعی ۱ دارد', async () => {
    expect((await resolveRate(gl, 'IRR', DEFAULT_DATE)).scaled).toBe(rateFrom(1).scaled);
  });

  it('نبودِ نرخ خطا می‌دهد — حدس زده نمی‌شود', async () => {
    await expectRejects(() => resolveRate(gl, 'AED', DEFAULT_DATE), /ثبت نشده/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('بهای تمام‌شدهٔ ماندهٔ باز', () => {
  it('میانگین موزون است، نه نرخ آخرین سند', async () => {
    await openReceivable(10_000n, '900000');    // ۱۰۰ دلار @ ۹۰۰٬۰۰۰
    await openReceivable(10_000n, '1100000');   // ۱۰۰ دلار @ ۱٬۱۰۰٬۰۰۰

    const r = await carryingRate(gl, {
      accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD',
    });
    expect(r!.scaled).toBe(rateFrom('1000000').scaled);   // میانگین
  });

  it('هر کاهش سهم خودش را از بهای انباشته برمی‌دارد', async () => {
    await openReceivable(10_000n, '900000');
    await openReceivable(10_000n, '1100000');
    // نصف مانده تسویه می‌شود — نرخ باقی‌مانده نباید تغییر کند
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'تسویهٔ جزئی',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 100_000_000n },
        { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD', credit: 10_000n, rate: '1000000' },
      ],
    }));

    const r = await carryingRate(gl, { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD' });
    expect(r!.scaled).toBe(rateFrom('1000000').scaled);
  });

  it('بسته‌شدن کامل مانده، سابقهٔ نرخ را هم پاک می‌کند', async () => {
    await openReceivable(10_000n, '900000');
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'تسویهٔ کامل',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 90_000_000n },
        { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD', credit: 10_000n, rate: '900000' },
      ],
    }));

    const r = await carryingRate(gl, { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD' });
    expect(r).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
describe('تسویه — تسعیر محقق‌شده', () => {
  it('دریافت بیشتر از ارزش دفتری ⇒ سود، و موضع ارزی دقیقاً صفر', async () => {
    await openReceivable(10_000n, '900000');   // ۱۰۰ دلار، دفتری ۹۰ میلیون ریال

    const entry = await tx((t) => postSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT',
      obligationAccountCode: '1104', subsidiaryId: customer.id,
      obligationCurrency: 'USD', settledAmount: 10_000n,
      cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: 95_000_000n,
    }));

    const pos = await positionBalance(gl, { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD' });
    expect(pos.amount).toBe(0n);          // نه «تقریباً صفر»

    const fx = await fxLineOf(entry.id);
    expect(fx!.account.code).toBe(FX_CODES.gainRealized);
    expect(fx!.credit).toBe(5_000_000n);
  });

  it('دریافت کمتر از ارزش دفتری ⇒ زیان', async () => {
    await openReceivable(10_000n, '900000');
    const entry = await tx((t) => postSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT',
      obligationAccountCode: '1104', subsidiaryId: customer.id,
      obligationCurrency: 'USD', settledAmount: 10_000n,
      cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: 87_000_000n,
    }));

    const fx = await fxLineOf(entry.id);
    expect(fx!.account.code).toBe(FX_CODES.lossRealized);
    expect(fx!.debit).toBe(3_000_000n);
  });

  it('تسویه به همان ارزش دفتری ⇒ هیچ ردیف تسعیری', async () => {
    await openReceivable(10_000n, '900000');
    const entry = await tx((t) => postSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT',
      obligationAccountCode: '1104', subsidiaryId: customer.id,
      obligationCurrency: 'USD', settledAmount: 10_000n,
      cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: 90_000_000n,
    }));
    expect(await fxLineOf(entry.id)).toBeUndefined();
  });

  it('پرداخت به سازنده کمتر از بدهی دفتری ⇒ سود', async () => {
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'خرید یوآنی',
      lines: [
        { accountId: cogs.id, currencyCode: 'CNY', debit: 100_000n, rate: '150000' },
        { accountId: payable.id, subsidiaryId: producer.id, currencyCode: 'CNY', credit: 100_000n, rate: '150000' },
      ],
    }));

    const entry = await tx((t) => postSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'PAYMENT',
      obligationAccountCode: '2101', subsidiaryId: producer.id,
      obligationCurrency: 'CNY', settledAmount: 100_000n,
      cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: 140_000_000n,
    }));

    const fx = await fxLineOf(entry.id);
    expect(fx!.account.code).toBe(FX_CODES.gainRealized);
    expect(fx!.credit).toBe(10_000_000n);   // بدهی دفتری ۱۵۰ م، پرداخت ۱۴۰ م

    const pos = await positionBalance(gl, { accountId: payable.id, subsidiaryId: producer.id, currencyCode: 'CNY' });
    expect(pos.amount).toBe(0n);
  });

  it('مبلغ صفر رد می‌شود', async () => {
    await expectRejects(() => tx((t) => postSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT',
      obligationAccountCode: '1104', subsidiaryId: customer.id,
      obligationCurrency: 'USD', settledAmount: 0n,
      cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: 1n,
    })), /بزرگ‌تر از صفر/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('تبدیل ارز — سود جعلی ساخته نمی‌شود', () => {
  const buyUsd = (irr: bigint, cents: bigint) =>
    tx((t) => postConversion(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', fromCurrency: 'IRR', fromAmount: irr,
      toAccountCode: '110101', toCurrency: 'USD', toAmount: cents,
    }));

  it('خرید ارز هیچ سود یا زیانی ثبت نمی‌کند', async () => {
    const entry = await buyUsd(100_000_000n, 10_000n);   // ۱۰۰ دلار به ۱۰۰ میلیون ریال
    const lines = await gl.glLine.findMany({ where: { entryId: entry.id } });
    expect(lines).toHaveLength(2);
    expect(await fxLineOf(entry.id)).toBeUndefined();

    const usd = lines.find((l) => l.currencyCode === 'USD')!;
    expect(usd.rate.toString()).toBe('1000000');   // نرخ واقعی پرداخت‌شده
  });

  it('خرید گران‌تر از نرخ روز هم سود/زیان نمی‌سازد — بهای تمام‌شده است', async () => {
    const entry = await buyUsd(120_000_000n, 10_000n);   // ۱٬۲۰۰٬۰۰۰ به ازای هر دلار
    expect(await fxLineOf(entry.id)).toBeUndefined();
    const usd = (await gl.glLine.findMany({ where: { entryId: entry.id } }))
      .find((l) => l.currencyCode === 'USD')!;
    expect(usd.rate.toString()).toBe('1200000');
  });

  it('فروش ارز بالاتر از بهای تمام‌شده ⇒ سود محقق', async () => {
    await buyUsd(100_000_000n, 10_000n);          // بهای تمام‌شده ۱٬۰۰۰٬۰۰۰

    const sale = await tx((t) => postConversion(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', fromCurrency: 'USD', fromAmount: 10_000n,
      toAccountCode: '110101', toCurrency: 'IRR', toAmount: 120_000_000n,
    }));

    const fx = await fxLineOf(sale.id);
    expect(fx!.account.code).toBe(FX_CODES.gainRealized);
    expect(fx!.credit).toBe(20_000_000n);
  });

  it('فروش پایین‌تر از بهای تمام‌شده ⇒ زیان محقق', async () => {
    await buyUsd(100_000_000n, 10_000n);
    const sale = await tx((t) => postConversion(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', fromCurrency: 'USD', fromAmount: 10_000n,
      toAccountCode: '110101', toCurrency: 'IRR', toAmount: 90_000_000n,
    }));
    const fx = await fxLineOf(sale.id);
    expect(fx!.account.code).toBe(FX_CODES.lossRealized);
    expect(fx!.debit).toBe(10_000_000n);
  });

  it('خرید و فروش به همان نرخ ⇒ سود صفر و موضع ارزی صفر', async () => {
    await buyUsd(100_000_000n, 10_000n);
    const sale = await tx((t) => postConversion(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', fromCurrency: 'USD', fromAmount: 10_000n,
      toAccountCode: '110101', toCurrency: 'IRR', toAmount: 100_000_000n,
    }));
    expect(await fxLineOf(sale.id)).toBeUndefined();

    const pos = await positionBalance(gl, { accountId: cash.id, currencyCode: 'USD' });
    expect(pos.amount).toBe(0n);
  });

  it('تبدیل بین دو ارز یکسان رد می‌شود', async () => {
    await expectRejects(() => tx((t) => postConversion(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110101', fromCurrency: 'IRR', fromAmount: 1000n,
      toAccountCode: '110101', toCurrency: 'IRR', toAmount: 1000n,
    })), /متفاوت/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('تجدید ارزیابی — تسعیر تحقق‌نیافته', () => {
  it('سود از اختلاف نرخ دفتری و نرخ دوره می‌آید', async () => {
    await openReceivable(10_000n, '900000');   // دفتری ۹۰ میلیون
    const preview = await previewRevaluation(gl, DEFAULT_DATE, { USD: rateFrom('1000000') });

    expect(preview.netBase).toBe(10_000_000n);
    expect(preview.totalLoss).toBe(0n);
    expect(preview.alreadyPosted).toBe(false);
  });

  it('بدهی ارزی با بالا رفتن نرخ ⇒ زیان', async () => {
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'خرید یوآنی',
      lines: [
        { accountId: cogs.id, currencyCode: 'CNY', debit: 100_000n, rate: '140000' },
        { accountId: payable.id, subsidiaryId: producer.id, currencyCode: 'CNY', credit: 100_000n, rate: '140000' },
      ],
    }));
    const preview = await previewRevaluation(gl, DEFAULT_DATE, { CNY: rateFrom('150000') });
    expect(preview.netBase).toBe(-10_000_000n);
  });

  it('ثبت، دو سند می‌سازد و اثر خالصشان صفر است', async () => {
    await openReceivable(10_000n, '900000');
    const res: any = await tx((t) => postRevaluation(t, {
      fiscalYearId: fy.id, asOf: DEFAULT_DATE, overrideRates: { USD: rateFrom('1000000') },
    }));

    expect(res.posted).toBe(true);
    expect(res.adjustment.entryType).toBe('ADJUSTING');
    expect(res.reversal.entryType).toBe('REVERSING');
    expect(res.reversal.date.getTime()).toBeGreaterThan(res.adjustment.date.getTime());

    const rows = await gl.$queryRaw<{ bal: bigint }[]>`
      SELECT COALESCE(SUM(l."debitBase") - SUM(l."creditBase"), 0)::bigint AS bal
      FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
      WHERE e."sourceType" = 'Revaluation'
    `;
    expect(BigInt(rows[0].bal)).toBe(0n);
  });

  it('برگشت به همان حساب سود می‌خورد، نه به حساب زیان', async () => {
    await openReceivable(10_000n, '900000');
    await tx((t) => postRevaluation(t, {
      fiscalYearId: fy.id, asOf: DEFAULT_DATE, overrideRates: { USD: rateFrom('1000000') },
    }));

    const lines = await gl.glLine.findMany({
      where: { entry: { sourceType: 'Revaluation' } },
      include: { account: { select: { code: true } } },
    });
    const fxCodes = new Set(
      lines.map((l) => l.account.code).filter((c) => c.startsWith('81') || c.startsWith('82')),
    );
    expect(fxCodes).toEqual(new Set([FX_CODES.gainUnrealized]));

    const gain = lines.filter((l) => l.account.code === FX_CODES.gainUnrealized);
    expect(gain).toHaveLength(2);
    expect(gain.some((l) => l.credit > 0n)).toBe(true);   // تعدیل
    expect(gain.some((l) => l.debit > 0n)).toBe(true);    // برگشت
  });

  it('موضع ارزی طرف‌حساب دست‌نخورده می‌ماند', async () => {
    await openReceivable(10_000n, '900000');
    await tx((t) => postRevaluation(t, {
      fiscalYearId: fy.id, asOf: DEFAULT_DATE, overrideRates: { USD: rateFrom('1000000') },
    }));

    const pos = await positionBalance(gl, { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD' });
    expect(pos.amount).toBe(10_000n);   // هنوز دقیقاً ۱۰۰ دلار
  });

  it('تجدید ارزیابی تکراری برای همان تاریخ رد می‌شود', async () => {
    await openReceivable(10_000n, '900000');
    const run = () => tx((t) => postRevaluation(t, {
      fiscalYearId: fy.id, asOf: DEFAULT_DATE, overrideRates: { USD: rateFrom('1000000') },
    }));
    await run();
    await expectRejects(run, /قبلاً تجدید ارزیابی/);
  });

  it('وقتی قلم ارزی بازی نیست، چیزی ثبت نمی‌شود', async () => {
    const res: any = await tx((t) => postRevaluation(t, {
      fiscalYearId: fy.id, asOf: DEFAULT_DATE, overrideRates: { USD: rateFrom('1000000') },
    }));
    expect(res.posted).toBe(false);
    expect(await gl.glEntry.count()).toBe(0);
  });

  it('حساب‌های تعدیل خودشان تجدید ارزیابی نمی‌شوند', async () => {
    await openReceivable(10_000n, '900000');
    await tx((t) => postRevaluation(t, {
      fiscalYearId: fy.id, asOf: DEFAULT_DATE, overrideRates: { USD: rateFrom('1000000') },
    }));
    const second = await previewRevaluation(gl, DEFAULT_DATE, { USD: rateFrom('1000000') });
    // تعدیل قبلی نباید خودش قلم ارزی جدید بسازد
    expect(second.lines.some((l) => l.code === FX_CODES.assetAdjustment)).toBe(false);
  });

  it('تجدید ارزیابی پایان سال، بدون سال مالی بعد، خطای روشن می‌دهد', async () => {
    // برگشت باید در دورهٔ بعد بنشیند؛ اگر سال مالی بعد نباشد، جایی برای ثبتش نیست
    await openReceivable(10_000n, '900000');
    await gl.glExchangeRate.create({
      data: { from: 'USD', to: 'IRR', date: FY_END, rate: '1000000', source: 'MANUAL' },
    });
    await expectRejects(
      () => tx((t) => postRevaluation(t, {
        fiscalYearId: fy.id, asOf: FY_END, overrideRates: { USD: rateFrom('1000000') },
      })),
      /سال مالی بعد/,
    );
  });

  // ── ممیزی ج۱۴: حالت دائمیِ پایان سال ──
  it('حالت دائمی: یک سند، بدون برگشت؛ نرخ دفتریِ موضع به نرخ پایان سال می‌رود', async () => {
    await openReceivable(10_000n, '900000');            // ۱۰۰ دلار، دفتری ۹۰ م
    const res: any = await tx((t) => postRevaluation(t, {
      fiscalYearId: fy.id, asOf: DEFAULT_DATE, mode: 'permanent',
      overrideRates: { USD: rateFrom('1000000') },
    }));

    expect(res.posted).toBe(true);
    expect(res.mode).toBe('permanent');
    expect(res.reversal).toBeNull();
    expect(await gl.glEntry.count({ where: { entryType: 'REVERSING' } })).toBe(0);

    // موضع دلاری دست‌نخورده، ولی نرخ دفتری‌اش حالا ۱٬۰۰۰٬۰۰۰ است
    const pos = await positionBalance(gl, { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD' });
    expect(pos.amount).toBe(10_000n);
    const rate = await carryingRate(gl, { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD' });
    expect(rate!.scaled).toBe(rateFrom('1000000').scaled);

    // سند متوازن، سود ۱۰ م به ۸۱۰۲ (۱۰۰ دلار × (۱٬۰۰۰٬۰۰۰ − ۹۰۰٬۰۰۰))
    const bal = await gl.$queryRaw<{ b: bigint }[]>`
      SELECT COALESCE(SUM(l."debitBase") - SUM(l."creditBase"), 0)::bigint AS b
      FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId" WHERE e."sourceType" = 'Revaluation'`;
    expect(BigInt(bal[0].b)).toBe(0n);
    const fxLine = await gl.glLine.findFirst({
      where: { entry: { sourceType: 'Revaluation' }, account: { code: FX_CODES.gainUnrealized } },
    });
    expect(fxLine!.credit).toBe(10_000_000n);
  });

  it('حالت دائمی: تسویهٔ بعدی از نرخ پایان سال اندازه می‌گیرد، نه نرخ اصلی', async () => {
    await openReceivable(10_000n, '900000');            // نرخ اصلی ۹۰۰٬۰۰۰ ⇒ دفتری ۹۰ م
    await tx((t) => postRevaluation(t, {
      fiscalYearId: fy.id, asOf: DEFAULT_DATE, mode: 'permanent',
      overrideRates: { USD: rateFrom('1000000') },     // پایان سال ۱٬۰۰۰٬۰۰۰ ⇒ دفتری ۱۰۰ م
    }));
    // دریافت کاملِ ۱۰۰ دلار، ۱۰۵ م ریال واقعاً دریافت شد (نرخِ مؤثرِ روز در مبلغ نهفته است)
    const entry: any = await tx((t) => postSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT',
      obligationAccountCode: '1104', subsidiaryId: customer.id, obligationCurrency: 'USD',
      settledAmount: 10_000n, cashAccountCode: '110101', cashCurrency: 'IRR', cashAmount: 105_000_000n,
    }));
    // تسعیرِ محقق = ۱۰۵ م − ۱۰۰ م = ۵ م (از نرخ پایان سال) — نه ۱۵ م (از نرخ اصلی)
    const fx = await gl.glLine.findFirst({
      where: { entryId: entry.id, account: { code: FX_CODES.gainRealized } },
    });
    expect(fx!.credit).toBe(5_000_000n);
  });
});
