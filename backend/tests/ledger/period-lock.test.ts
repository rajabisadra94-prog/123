/**
 * قفل دوره — مرحلهٔ ۵ و.
 *
 * ─── باگی که این فایل برایش نوشته شد ───────────────────────────
 *
 * تریگرِ `gl_entry_period_open` با `module IN ('ALL', NEW."sourceType")`
 * می‌سنجد — مقایسهٔ رشته‌ایِ حساس به حروف. ولی `setPeriodLock` هر رشته‌ای را
 * همان‌طور که آمده ذخیره می‌کرد.
 *
 * نتیجه: قفلی که با `module: 'all'` ساخته می‌شد **بی‌صدا بی‌اثر** بود. API
 * کد ۲۰۰ می‌داد، قفل در دیتابیس می‌نشست، و سند گذشته‌نگر همچنان ثبت می‌شد.
 * روی staging یک سند با تاریخ ۱۴۰۵/۰۲/۱۱ در دورهٔ «قفل‌شده» ثبت شد.
 *
 * قفلی که کار نکند از نبودِ قفل بدتر است — چون حسابدار خیالش راحت است.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D, resetBusinessData, expectRejects,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { setPeriodLock, removePeriodLock, LOCK_MODULES } from '../../src/modules/ledger/admin';

let fy: any, cash: any, sales: any;
const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

const entry = (date: Date, description = 'سند') =>
  tx((t) => post(t, {
    fiscalYearId: fy.id, date, description,
    lines: [
      { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 1_000_000n },
    ],
  }));

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await gl.glPeriodLock.deleteMany({});
  await resetGl(); await resetBusinessData();
  fy = await makeFiscalYear();
});

// ═══════════════════════════════════════════════════════════════
describe('نام ماژول', () => {
  it('حروف کوچک به شکل معتبر تبدیل می‌شود', async () => {
    // ⚠️ قلبِ باگ: `'all'` باید `'ALL'` ذخیره شود تا تریگر بشناسدش
    const lock = await tx((t) => setPeriodLock(t, {
      module: 'all', lockToDate: D('2026-06-30'), reason: 'آزمون',
    }));
    expect(lock.module).toBe('ALL');
  });

  it('نامِ ماژولِ ناشناخته رد می‌شود، نه اینکه قفلِ مرده بسازد', async () => {
    await expectRejects(
      () => tx((t) => setPeriodLock(t, {
        module: 'HichChiz', lockToDate: D('2026-06-30'), reason: 'آزمون',
      })),
      /قابل قفل نیست/,
    );
  });

  it('نبودِ ماژول یعنی همه', async () => {
    const lock = await tx((t) => setPeriodLock(t, {
      lockToDate: D('2026-06-30'), reason: 'آزمون',
    }));
    expect(lock.module).toBe('ALL');
  });

  it('ماژول‌های مجاز همه پذیرفته می‌شوند', async () => {
    for (const m of LOCK_MODULES) {
      await gl.glPeriodLock.deleteMany({});
      const lock = await tx((t) => setPeriodLock(t, {
        module: m, lockToDate: D('2026-06-30'), reason: 'آزمون',
      }));
      expect(lock.module).toBe(m);
    }
  });

  it('دلیلِ خالی رد می‌شود', async () => {
    await expectRejects(
      () => tx((t) => setPeriodLock(t, { lockToDate: D('2026-06-30'), reason: '  ' })),
      /دلیل قفل/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
describe('اثرِ واقعیِ قفل', () => {
  it('قفلِ ساخته‌شده با حروف کوچک، واقعاً قفل می‌کند', async () => {
    // ⚠️ رگرسیون. پیش از این، همین سند ثبت می‌شد.
    await tx((t) => setPeriodLock(t, {
      module: 'all', lockToDate: D('2026-06-30'), reason: 'بستن سه‌ماههٔ اول',
    }));
    await expectRejects(() => entry(D('2026-05-01')), /بسته است/);
  });

  it('سند پس از تاریخ قفل، آزاد است', async () => {
    await tx((t) => setPeriodLock(t, {
      module: 'ALL', lockToDate: D('2026-06-30'), reason: 'بستن',
    }));
    const e: any = await entry(D('2026-07-15'));
    expect(e.serial).toBeGreaterThan(0);
  });

  it('سندِ دقیقاً روی تاریخ قفل رد می‌شود', async () => {
    // تریگر `date <= locked` است، پس خودِ روزِ قفل هم بسته است
    await tx((t) => setPeriodLock(t, {
      module: 'ALL', lockToDate: D('2026-06-30'), reason: 'بستن',
    }));
    await expectRejects(() => entry(D('2026-06-30')), /بسته است/);
  });

  it('برداشتن قفل، دوره را باز می‌کند', async () => {
    const lock = await tx((t) => setPeriodLock(t, {
      module: 'ALL', lockToDate: D('2026-06-30'), reason: 'بستن',
    }));
    await expectRejects(() => entry(D('2026-05-01')), /بسته است/);

    await tx((t) => removePeriodLock(t, lock.id));
    const e: any = await entry(D('2026-05-01'));
    expect(e.serial).toBeGreaterThan(0);
  });

  it('یک قفل به‌ازای هر ماژول — به‌روزرسانی، نه انباشت', async () => {
    await tx((t) => setPeriodLock(t, { module: 'all', lockToDate: D('2026-05-30'), reason: 'اول' }));
    await tx((t) => setPeriodLock(t, { module: 'ALL', lockToDate: D('2026-06-30'), reason: 'دوم' }));
    const all = await gl.glPeriodLock.findMany();
    expect(all).toHaveLength(1);
    expect(all[0].reason).toBe('دوم');
  });
});
