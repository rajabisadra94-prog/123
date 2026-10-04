/**
 * رفتار اثبات‌شدهٔ ۲ — سرشکن با روش «بزرگ‌ترین باقی‌مانده».
 *
 * قرارداد: جمع سهم‌های خروجی باید **دقیقاً** برابر مبلغ کل باشد، در هر ترکیبی از
 * وزن‌ها و هر تعداد رقم اعشار. گرد کردن سادهٔ هر سهم این قرارداد را می‌شکند
 * (۱۰۰۰ بین ۳ نفر ⇒ ۹۹۹) و همین‌جا گرفته می‌شود.
 *
 * این تست تابع خالص است و به دیتابیس کار ندارد.
 */
import { describe, it, expect } from 'vitest';
import { allocate } from '../../src/modules/accounting/accounting.service';

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);

describe('allocate — بزرگ‌ترین باقی‌مانده', () => {
  it('۱۰۰۰ تومان بین سه سهم مساوی گم نمی‌شود', () => {
    const parts = allocate(1000, [1, 1, 1], 0);
    expect(sum(parts)).toBe(1000);
    // یک نفر باید ۳۳۴ بگیرد، نه اینکه یک تومان بخارشود
    expect(parts.slice().sort((a, b) => a - b)).toEqual([333, 333, 334]);
  });

  it('جمع سهم‌ها برای وزن‌های نامنظم هم دقیقاً برابر کل است', () => {
    const cases: Array<[number, number[], number]> = [
      [1_000_000, [1, 2, 3], 0],
      [999_999, [7, 11, 13, 17], 0],
      [100, [1, 1, 1, 1, 1, 1, 1], 2],
      [12_345.67, [3, 5], 2],
      [1, [1, 1, 1], 2],
      [0.03, [1, 1, 1], 2],
      [7, [1, 0, 0], 0],
    ];
    for (const [total, weights, decimals] of cases) {
      const parts = allocate(total, weights, decimals);
      expect(Number(sum(parts).toFixed(decimals)), `total=${total} w=${weights}`).toBe(
        Number(total.toFixed(decimals)),
      );
      expect(parts).toHaveLength(weights.length);
    }
  });

  it('واحدهای اضافی به سهم‌هایی می‌روند که بیشترین کسر را داشته‌اند', () => {
    // ۱۰ بین وزن‌های ۱ و ۱ و ۱: سهم دقیق ۳٫۳۳ برای هرکدام؛ یک واحد اضافه می‌ماند
    const parts = allocate(10, [1, 1, 1], 0);
    expect(sum(parts)).toBe(10);
    expect(parts.filter((p) => p === 4)).toHaveLength(1);
  });

  it('وزن صفر سهمی نمی‌گیرد', () => {
    const parts = allocate(500, [0, 1, 1], 0);
    expect(parts[0]).toBe(0);
    expect(sum(parts)).toBe(500);
  });

  it('وزن‌های تماماً صفر ⇒ همه صفر (نه تقسیم بر صفر)', () => {
    expect(allocate(500, [0, 0, 0], 0)).toEqual([0, 0, 0]);
  });

  it('فهرست خالی ⇒ خروجی خالی', () => {
    expect(allocate(100, [], 0)).toEqual([]);
  });

  it('مبلغ منفی هم دقیقاً سرشکن می‌شود', () => {
    const parts = allocate(-1000, [1, 1, 1], 0);
    expect(sum(parts)).toBe(-1000);
  });

  it('اعشار ارزی (۲ رقم) نویز شناور تولید نمی‌کند', () => {
    const parts = allocate(0.1, [1, 1, 1], 2);
    // هیچ سهمی نباید چیزی مثل 0.30000000000000004 باشد
    for (const p of parts) expect(p).toBe(Number(p.toFixed(2)));
    expect(Number(sum(parts).toFixed(2))).toBe(0.1);
  });
});
