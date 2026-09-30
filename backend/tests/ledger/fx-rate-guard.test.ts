/**
 * گاردِ نرخ ارز — ممیزی دوم، ن۲ و ن۳.
 *
 * ن۲: نرخِ نامثبت باید **خطا** باشد، نه «پرت»ی که با تأیید بشود ثبتش کرد؛
 *     و دیتابیس هم باید خودش جلویش را بگیرد.
 * ن۳: مرجعِ سنجشِ انحراف باید نرخِ مؤثرِ **همان تاریخ** باشد، نه تازه‌ترین
 *     ردیفِ جدول — وگرنه یک نرخِ تاریخ‌آینده گارد را وارونه می‌کند.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { gl, resetGl, seedGlChart, D, expectRejects } from '../helpers/gl';
import { checkRateOutlier, resolveRate, FxError } from '../../src/modules/ledger/fx';

const rate = (from: string, r: string, date: Date, source = 'MANUAL') =>
  gl.glExchangeRate.upsert({
    where: { from_to_date_source: { from, to: 'IRR', date, source } },
    update: { rate: r }, create: { from, to: 'IRR', date, rate: r, source },
  });

beforeAll(async () => { await resetGl(); await seedGlChart(); }, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => { await gl.glExchangeRate.deleteMany({}); });

// ═══════════════════════════════════════════════════════════════
describe('ن۲ — نرخِ نامثبت', () => {
  it('نرخ صفر رد می‌شود', async () => {
    await expectRejects(() => checkRateOutlier(gl, 'USD', 'IRR', '0', D('2026-06-01')), /بزرگ‌تر از صفر/);
  });

  it('نرخ منفی رد می‌شود', async () => {
    await expectRejects(() => checkRateOutlier(gl, 'USD', 'IRR', '-999999', D('2026-06-01')), /بزرگ‌تر از صفر/);
  });

  it('نرخِ غیرعددی رد می‌شود', async () => {
    await expectRejects(() => checkRateOutlier(gl, 'USD', 'IRR', 'abc', D('2026-06-01')), /بزرگ‌تر از صفر/);
  });

  it('خطا از نوع FxError است — همان چیزی که مسیر HTTP به ۴۰۰ ترجمه‌اش می‌کند', async () => {
    // مسیر HTTP فقط وقتی سراغ confirmOutlier می‌رود که تابع **مقدار** برگرداند.
    // اگر روزی این throw به return {ok:false} تبدیل شود، تأییدِ کاربر می‌شود راهِ
    // فرار از قیدِ دیتابیس. و نوعِ خطا هم مهم است: errorHandler با نامِ کلاس
    // تصمیم می‌گیرد ۴۰۰ بدهد یا ۵۰۰.
    await expect(checkRateOutlier(gl, 'USD', 'IRR', '0', D('2026-06-01')))
      .rejects.toBeInstanceOf(FxError);
  });

  it('دیتابیس هم نرخِ نامثبت را نمی‌پذیرد (قید gl_exchange_rate_positive)', async () => {
    await expect(
      gl.glExchangeRate.create({ data: { from: 'USD', to: 'IRR', date: D('2026-06-01'), rate: '0', source: 'MANUAL' } }),
    ).rejects.toThrow();
    await expect(
      gl.glExchangeRate.create({ data: { from: 'USD', to: 'IRR', date: D('2026-06-02'), rate: '-5', source: 'MANUAL' } }),
    ).rejects.toThrow();
  });

  it('resolveRate روی ردیفِ آلودهٔ از پیش موجود هم خطا می‌دهد، نه نرخِ صفر', async () => {
    // قید را موقتاً برمی‌داریم تا دقیقاً همان دادهٔ آلوده‌ای را بسازیم که پیش از
    // این رفع، روی سرور نشسته بود — و ثابت کنیم لایهٔ برنامه هم می‌گیردش.
    await gl.$executeRawUnsafe('ALTER TABLE "GlExchangeRate" DROP CONSTRAINT gl_exchange_rate_positive');
    try {
      await gl.glExchangeRate.create({ data: { from: 'AED', to: 'IRR', date: D('2026-06-01'), rate: '0', source: 'MANUAL' } });
      await expectRejects(() => resolveRate(gl, 'AED', D('2026-06-05')), /نامعتبر/);
    } finally {
      await gl.$executeRawUnsafe('DELETE FROM "GlExchangeRate" WHERE rate <= 0');
      await gl.$executeRawUnsafe('ALTER TABLE "GlExchangeRate" ADD CONSTRAINT gl_exchange_rate_positive CHECK (rate > 0)');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ن۳ — مرجعِ انحراف، نرخِ مؤثرِ همان تاریخ است', () => {
  it('نرخِ تاریخ‌آینده مرجع نمی‌شود — سناریوی دقیقِ ممیزی', async () => {
    // بازار در ۱۰ مرداد: ۲٬۰۹۳٬۰۰۰. یک نرخِ غلطِ ۷۰۰٬۰۰۰ با تاریخِ آینده در جدول.
    await rate('USD', '2093000', D('2026-09-01'), 'AUTO');
    await rate('USD', '700000', D('2026-09-10'));

    // نرخِ درستِ بازار برای ۲ شهریور ⇒ باید پذیرفته شود
    const good = await checkRateOutlier(gl, 'USD', 'IRR', '2100000', D('2026-09-02'));
    expect(good.ok).toBe(true);
    expect(good.last?.date).toBe('2026-09-01');   // مرجع، نرخِ گذشته است نه آینده

    // نرخِ غلطِ یک‌سومِ بازار ⇒ باید رد شود
    const bad = await checkRateOutlier(gl, 'USD', 'IRR', '600000', D('2026-09-02'));
    expect(bad.ok).toBe(false);
  });

  it('در تساویِ تاریخ، همان نرخی مرجع است که resolveRate استفاده می‌کند', async () => {
    await rate('USD', '1000000', D('2026-06-01'), 'AUTO');
    await rate('USD', '2000000', D('2026-06-01'), 'MANUAL');   // دستی اولویت دارد
    const c = await checkRateOutlier(gl, 'USD', 'IRR', '2100000', D('2026-06-01'));
    expect(c.last?.rate).toBe('2000000');
    expect(c.ok).toBe(true);   // ۵٪ با ۲٬۰۰۰٬۰۰۰
  });

  it('نرخِ عقب‌تاریخ بی‌گارد نمی‌ماند — نزدیک‌ترین نرخِ بعدی مرجع می‌شود', async () => {
    await rate('USD', '2000000', D('2026-09-01'));
    const c = await checkRateOutlier(gl, 'USD', 'IRR', '200000', D('2026-05-01'));   // ۱۰ برابر کمتر
    expect(c.ok).toBe(false);
    expect(c.last?.date).toBe('2026-09-01');
  });

  it('نخستین نرخِ یک ارز در کل جدول ⇒ مرجعی نیست، پس تأیید می‌خواهد (ن۹)', async () => {
    const c = await checkRateOutlier(gl, 'CNY', 'IRR', '310000', D('2026-06-01'));
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('FIRST_RATE');
    expect(c.last).toBeNull();
  });
});
