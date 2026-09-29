/**
 * تغذیهٔ خودکار نرخ ارز هستهٔ جدید (ب۳ ممیزی) — `GlExchangeRate`.
 *
 * حساس‌ترین نکته: `getRates()` تومان می‌دهد، هستهٔ جدید ریال ⇒ **×۱۰**. اشتباه
 * در این ضریب یعنی هر سند ارزی ۱۰ برابر غلط.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { gl, resetGl, seedGlChart, accountByCode } from '../helpers/gl';
import { resolveRate } from '../../src/modules/ledger/fx';

// getRates و er-api شبکه می‌خواهند — mock می‌شوند
const getRatesMock = vi.fn();
vi.mock('../../src/shared/utils/rates', () => ({
  getRates: (...a: any[]) => getRatesMock(...a),
}));
const axiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: (...a: any[]) => axiosGet(...a) } }));

import { syncGlRates, backfillGlRatesFromSnapshots, GL_AUTO_SOURCE } from '../../src/modules/ledger/fx-sync';

const D = (s: string) => new Date(`${s}T00:00:00Z`);

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await gl.glExchangeRate.deleteMany({});
  await gl.exchangeRateSnapshot.deleteMany({});
  getRatesMock.mockReset();
  axiosGet.mockReset();
  // پیش‌فرض: بازار آزاد سالم (تومان)
  getRatesMock.mockResolvedValue({
    USD_TO_IRR: 92_000, CNY_TO_IRR: 12_800, USD_TO_CNY: 7.1875,
    source: 'tgju+er-api', fetchedAt: new Date(), isStale: false,
  });
  // er-api: USD→AED و USD→CNY
  axiosGet.mockResolvedValue({ data: { rates: { AED: 3.6725, CNY: 7.19 } } });
});

describe('syncGlRates', () => {
  it('تومان را ×۱۰ می‌کند و ردیف AUTO می‌نویسد', async () => {
    const r = await syncGlRates({ date: D('2026-08-20') });
    expect(r.ok).toBe(true);
    const usd = await gl.glExchangeRate.findFirstOrThrow({ where: { from: 'USD', source: GL_AUTO_SOURCE } });
    expect(Number(usd.rate)).toBe(920_000);            // ۹۲٬۰۰۰ تومان ⇒ ۹۲۰٬۰۰۰ ریال
    const cny = await gl.glExchangeRate.findFirstOrThrow({ where: { from: 'CNY', source: GL_AUTO_SOURCE } });
    expect(Number(cny.rate)).toBe(128_000);
  });

  it('درهم را از نرخ متقاطع er-api می‌سازد', async () => {
    await syncGlRates({ date: D('2026-08-20') });
    const aed = await gl.glExchangeRate.findFirst({ where: { from: 'AED', source: GL_AUTO_SOURCE } });
    expect(aed).not.toBeNull();
    // ۹۲۰٬۰۰۰ ریال/دلار ÷ ۳٫۶۷۲۵ ≈ ۲۵۰٬۵۱۰
    expect(Number(aed!.rate)).toBeGreaterThan(240_000);
    expect(Number(aed!.rate)).toBeLessThan(260_000);
  });

  it('منبعِ غیرواقعی (default/کهنه) نوشته نمی‌شود', async () => {
    getRatesMock.mockResolvedValue({ USD_TO_IRR: 100_000, CNY_TO_IRR: 14_000, USD_TO_CNY: 7.15, source: 'default', fetchedAt: new Date(), isStale: true });
    const r = await syncGlRates({ date: D('2026-08-20') });
    expect(r.ok).toBe(false);
    expect(r.skipped).toMatch(/منبع زنده/);
    expect(await gl.glExchangeRate.count()).toBe(0);
  });

  it('idempotent — اجرای دوباره همان روز، ردیف را به‌روز می‌کند نه اضافه', async () => {
    await syncGlRates({ date: D('2026-08-20') });
    getRatesMock.mockResolvedValue({ USD_TO_IRR: 95_000, CNY_TO_IRR: 13_000, USD_TO_CNY: 7.3, source: 'tetherland', fetchedAt: new Date(), isStale: false });
    await syncGlRates({ date: D('2026-08-20') });
    const usd = await gl.glExchangeRate.findMany({ where: { from: 'USD', source: GL_AUTO_SOURCE } });
    expect(usd).toHaveLength(1);
    expect(Number(usd[0].rate)).toBe(950_000);
  });

  it('نرخ MANUAL همان روز دست‌نخورده می‌ماند و resolveRate آن را می‌بیند', async () => {
    await gl.glExchangeRate.create({ data: { from: 'USD', to: 'IRR', date: D('2026-08-20'), rate: '880000', source: 'MANUAL' } });
    await syncGlRates({ date: D('2026-08-20') });
    const manual = await gl.glExchangeRate.findFirstOrThrow({ where: { from: 'USD', source: 'MANUAL' } });
    expect(Number(manual.rate)).toBe(880_000);   // بازنویسی نشد
    // هر دو ردیف برای همان روز هستند
    expect(await gl.glExchangeRate.count({ where: { from: 'USD', to: 'IRR', date: D('2026-08-20') } })).toBe(2);
  });

  it('نرخ نوشته‌شده در سند واقعی قابل حل است', async () => {
    await syncGlRates({ date: D('2026-08-20') });
    const rate = await resolveRate(gl, 'USD', D('2026-08-25'));
    // Rate.scaled = plain × 10^10
    expect(rate.scaled).toBe(920_000n * 10_000_000_000n);
  });

  it('در تساویِ تاریخ، resolveRate نرخِ MANUAL را انتخاب می‌کند نه AUTO', async () => {
    await syncGlRates({ date: D('2026-08-20') });   // AUTO = 920000
    await gl.glExchangeRate.create({ data: { from: 'USD', to: 'IRR', date: D('2026-08-20'), rate: '905000', source: 'MANUAL' } });
    const rate = await resolveRate(gl, 'USD', D('2026-08-22'));
    expect(rate.scaled).toBe(905_000n * 10_000_000_000n);
  });

  it('er-api که نیامد ⇒ فقط USD و CNY، بدون شکست', async () => {
    axiosGet.mockRejectedValue(new Error('network'));
    const r = await syncGlRates({ date: D('2026-08-20') });
    expect(r.ok).toBe(true);
    expect(r.written.map((w) => w.from).sort()).toEqual(['CNY', 'USD']);
  });
});

describe('backfillGlRatesFromSnapshots', () => {
  it('آخرین snapshot هر روز را به ریال منتقل می‌کند (source=BACKFILL)', async () => {
    await gl.exchangeRateSnapshot.createMany({
      data: [
        { usdToIrr: '90000', cnyToIrr: '12500', usdToCny: '7.2', source: 'tgju', createdAt: new Date('2026-08-18T06:00:00Z') },
        { usdToIrr: '91000', cnyToIrr: '12600', usdToCny: '7.22', source: 'tgju', createdAt: new Date('2026-08-18T18:00:00Z') },  // این باید برنده شود
        { usdToIrr: '93000', cnyToIrr: '12900', usdToCny: '7.21', source: 'er-api', createdAt: new Date('2026-08-19T10:00:00Z') },
      ],
    });
    const res = await backfillGlRatesFromSnapshots();
    expect(res.days).toBe(2);
    expect(res.rows).toBe(4);   // ۲ روز × (USD + CNY)
    const d18 = await gl.glExchangeRate.findFirstOrThrow({ where: { from: 'USD', date: D('2026-08-18'), source: 'BACKFILL' } });
    expect(Number(d18.rate)).toBe(910_000);   // ۹۱٬۰۰۰ تومانِ snapshot ساعت ۱۸ ⇒ ۹۱۰٬۰۰۰ ریال
  });

  it('بدون snapshot ⇒ صفر، بدون خطا', async () => {
    const res = await backfillGlRatesFromSnapshots();
    expect(res).toMatchObject({ days: 0, rows: 0 });
  });
});
