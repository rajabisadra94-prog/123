/**
 * دروازهٔ برش — کنار گذاشتنِ منابعِ فقط-جدید (مرحلهٔ ۵ ج).
 *
 * ماجرا: روی staging دروازه ۷۱۷ میلیارد ریال اختلاف نشان می‌داد و رشتهٔ روزهای
 * پاک صفر مانده بود. علتش خرابیِ دونویسی نبود — هستهٔ قدیمی اصلاً حقوق و
 * دستمزد، چک، تنخواه، ذخایر و استهلاک ندارد، پس مقایسهٔ آن‌ها مقایسهٔ چیزی با
 * هیچ است و همیشه ناهماهنگ درمی‌آید.
 *
 * دو چیز اینجا قفل می‌شود: **منابعِ فقط-جدید از مقایسه بیرون‌اند**، و
 * **پیش‌فرضِ هر منبعِ ناشناخته، مقایسه‌شدن است** — تا آداپتوری که فردا اضافه
 * شود و دونویسی‌اش را یادشان برود، بی‌صدا سبز نشود.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D, resetBusinessData,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { compareCores, NEW_CORE_ONLY_SOURCES } from '../../src/modules/ledger/diff';

let fy: any, cash: any, sales: any, rent: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, sourceType: string | null, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, sourceType, lines } as any));

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
  rent = await accountByCode('6202');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => { await resetGl(); await resetBusinessData(); fy = await makeFiscalYear(); });

const sale = (amount: bigint, sourceType: string | null) =>
  entry(D('2026-05-01'), `فروش ${sourceType ?? 'بی‌منبع'}`, sourceType, [
    { accountId: cash.id, currencyCode: 'IRR', debit: amount },
    { accountId: sales.id, currencyCode: 'IRR', credit: amount },
  ]);

// ═══════════════════════════════════════════════════════════════
describe('کنار گذاشتنِ منابعِ فقط-جدید', () => {
  it('حقوق و دستمزد در مقایسه نمی‌آید', async () => {
    await entry(D('2026-05-01'), 'لیست حقوق', 'PayrollRun', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 5_000_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 5_000_000_000n },
    ]);
    const d = await compareCores();
    // هستهٔ قدیمی خالی است؛ اگر شمرده می‌شد، اختلاف ۵ میلیارد می‌داد
    expect(d.mismatchCount).toBe(0);
    expect(d.totalBaseDelta).toBe('0');
  });

  it('هر منبعِ فقط-جدید کنار می‌رود', async () => {
    for (const src of NEW_CORE_ONLY_SOURCES) await sale(1_000_000_000n, src);
    const d = await compareCores();
    expect(d.mismatchCount).toBe(0);
    expect(d.excluded.length).toBe(NEW_CORE_ONLY_SOURCES.length);
  });

  it('حجمِ کنارگذاشته‌شده پنهان نمی‌شود', async () => {
    // اگر بی‌صدا حذف می‌شد، دروازه سبز می‌شد بی‌آنکه کسی بداند چقدر کنار رفته
    await entry(D('2026-05-01'), 'لیست حقوق', 'PayrollRun', [
      { accountId: rent.id, currencyCode: 'IRR', debit: 3_000_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 3_000_000_000n },
    ]);
    const d = await compareCores();
    const row = d.excluded.find((e) => e.sourceType === 'PayrollRun')!;
    expect(row).toBeTruthy();
    expect(row.entries).toBe(1);
    // هر دو ردیفِ سند، قدرمطلق
    expect(row.base).toBe('6000000000');
    expect(d.excludedBase).toBe('6000000000');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('پیش‌فرضِ امن: ناشناخته مقایسه می‌شود', () => {
  it('منبعِ تازه‌ای که در فهرست نیست، اختلاف نشان می‌دهد', async () => {
    // ⚠️ قلبِ طراحی. آداپتوری که فردا اضافه شود و دونویسی‌اش را یادشان برود،
    // باید دیده شود نه اینکه بی‌صدا سبز بماند.
    await sale(2_000_000_000n, 'SomeNewAdapter');
    const d = await compareCores();
    expect(d.mismatchCount).toBeGreaterThan(0);
    expect(BigInt(d.totalBaseDelta)).toBeGreaterThan(0n);
  });

  it('سند بی‌منبع هم مقایسه می‌شود', async () => {
    await sale(1_000_000_000n, null);
    const d = await compareCores();
    expect(d.mismatchCount).toBeGreaterThan(0);
  });

  it('منابعِ دونویسی‌شده همچنان مقایسه می‌شوند', async () => {
    // اگر روزی `Invoice` را هم کنار می‌گذاشتیم، دروازه بی‌فایده می‌شد
    await sale(4_000_000_000n, 'Invoice');
    const d = await compareCores();
    expect(d.mismatchCount).toBeGreaterThan(0);
    expect(d.excluded.find((e) => e.sourceType === 'Invoice')).toBeUndefined();
  });

  it('سند مهاجرت مقایسه می‌شود — نمایندهٔ ماندهٔ قدیمی است', async () => {
    // سند افتتاحیهٔ مهاجرت همان ماندهٔ هستهٔ قدیمی را به جدید می‌آورد؛
    // کنار گذاشتنش یعنی کلِ ماندهٔ ابتدایی از مقایسه بیفتد.
    expect(NEW_CORE_ONLY_SOURCES).not.toContain('Migration');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('تسویه — دونویسی‌شده در برابر بومی', () => {
  const settlement = (amount: bigint, sourceId: string | null) =>
    tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-05-01'),
      description: sourceId ? 'تسویهٔ دونویسی‌شده' : 'تسویهٔ بومی',
      sourceType: 'Settlement', sourceId,
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: amount },
        { accountId: sales.id, currencyCode: 'IRR', credit: amount },
      ],
    } as any));

  it('تسویهٔ بومی (بدون sourceId) کنار می‌رود', async () => {
    // روی staging هر سه تسویه همین شکلی بودند و ۸ ناهماهنگی می‌ساختند
    await settlement(9_000_000_000n, null);
    const d = await compareCores();
    expect(d.mismatchCount).toBe(0);
    expect(d.excluded.find((e) => e.sourceType === 'Settlement')).toBeTruthy();
  });

  it('تسویهٔ دونویسی‌شده (با sourceId) مقایسه می‌شود', async () => {
    // ⚠️ تسویه مهم‌ترین عملیاتی است که دروازه باید بسنجد؛ کنار گذاشتنِ
    // یک‌کاسهٔ آن، دروازه را بی‌فایده می‌کرد.
    await settlement(9_000_000_000n, 'legacy-entry-id');
    const d = await compareCores();
    expect(d.mismatchCount).toBeGreaterThan(0);
    expect(d.excluded.find((e) => e.sourceType === 'Settlement')).toBeUndefined();
  });

  it('هر دو با هم: فقط بومی کنار می‌رود', async () => {
    await settlement(5_000_000_000n, null);
    await settlement(3_000_000_000n, 'legacy-x');
    const d = await compareCores();
    // فقط سهمِ دونویسی‌شده در اختلاف می‌آید
    const cash11 = d.rows.find((r) => r.concept === '1101' && r.currency === 'IRR')!;
    expect(cash11.glBase).toBe('3000000000');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('سند اختتامیه', () => {
  it('همچنان کنار گذاشته می‌شود', async () => {
    await sale(1_000_000_000n, 'Invoice');
    const before = await compareCores();
    const { closeFiscalYear } = await import('../../src/modules/ledger/year-close');
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    const after = await compareCores();
    // بستنِ سال نباید عددِ مقایسه را تکان دهد
    expect(after.totalBaseDelta).toBe(before.totalBaseDelta);
  });
});
