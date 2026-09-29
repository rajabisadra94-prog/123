/**
 * لایهٔ پول — عدد صحیح در کوچک‌ترین واحد، بدون float.
 *
 * الزام بند ۳-۳: «اعداد پولی هرگز float نباشند.»
 * این تست‌ها همان مسیرهایی را می‌سنجند که با شناور خراب می‌شدند.
 */
import { describe, it, expect } from 'vitest';
import {
  rateFrom, rateToString, toBase, divRound, allocate, parseAmount, formatAmount,
} from '../../src/modules/ledger/money';

describe('نرخ', () => {
  it('نرخ از رشته بدون از دست دادن دقت خوانده می‌شود', () => {
    expect(rateToString(rateFrom('95000.5'))).toBe('95000.5000000000');
    expect(rateToString(rateFrom('0.0000000001'))).toBe('0.0000000001');
  });

  it('نرخ از عدد صحیح هم پذیرفته می‌شود', () => {
    expect(rateToString(rateFrom(1))).toBe('1.0000000000');
    expect(rateToString(rateFrom(1_000_000))).toBe('1000000.0000000000');
  });
});

describe('تبدیل به ارز پایه', () => {
  it('دلار (۲ رقم) به ریال (۰ رقم)', () => {
    // ۱۰۰٫۰۰ دلار × ۱٬۰۰۰٬۰۰۰ ریال = ۱۰۰٬۰۰۰٬۰۰۰ ریال
    expect(toBase(10_000n, rateFrom(1_000_000), 2, 0)).toBe(100_000_000n);
  });

  it('ریال به ریال با نرخ ۱ تغییری نمی‌کند', () => {
    expect(toBase(123_456n, rateFrom(1), 0, 0)).toBe(123_456n);
  });

  it('نرخ اعشاری درست گرد می‌شود', () => {
    // ۱٫۰۰ دلار × ۹۵۰۰۰٫۵ = ۹۵۰۰۰٫۵ ریال ⇒ گرد به ۹۵٬۰۰۱
    expect(toBase(100n, rateFrom('95000.5'), 2, 0)).toBe(95_001n);
    // ۹۵۰۰۰٫۴ ⇒ گرد به ۹۵٬۰۰۰
    expect(toBase(100n, rateFrom('95000.4'), 2, 0)).toBe(95_000n);
  });

  it('مبالغ بزرگ بدون سرریز — جایی که شناور دقت را از دست می‌داد', () => {
    // ۹۹۹٬۹۹۹٬۹۹۹٬۹۹۹٫۹۹ دلار × ۱٬۰۰۰٬۰۰۰ ریال
    const got = toBase(99_999_999_999_999n, rateFrom(1_000_000), 2, 0);
    expect(got).toBe(999_999_999_999_990_000n);

    // همین عدد از محدودهٔ امنِ Number بیرون است؛ با شناور، ریال‌ها گم می‌شدند
    expect(Number.isSafeInteger(Number(got))).toBe(false);
    expect(BigInt(Number(got))).not.toBe(got);
  });
});

describe('گرد کردن تقسیم', () => {
  it('نیم به بالا', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(4n, 2n)).toBe(2n);
    expect(divRound(3n, 2n)).toBe(2n);
    expect(divRound(1n, 3n)).toBe(0n);
    expect(divRound(2n, 3n)).toBe(1n);
  });

  it('برای اعداد منفی متقارن است', () => {
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(5n, -2n)).toBe(-3n);
  });

  it('تقسیم بر صفر خطا می‌دهد', () => {
    expect(() => divRound(1n, 0n)).toThrow();
  });
});

describe('سرشکن — بزرگ‌ترین باقی‌مانده', () => {
  const sum = (a: bigint[]) => a.reduce((s, v) => s + v, 0n);

  it('۱۰۰۰ بین سه سهم مساوی گم نمی‌شود', () => {
    const parts = allocate(1000n, [1n, 1n, 1n]);
    expect(sum(parts)).toBe(1000n);
    expect([...parts].sort()).toEqual([333n, 333n, 334n]);
  });

  it('جمع سهم‌ها همیشه دقیقاً برابر کل است', () => {
    const cases: Array<[bigint, bigint[]]> = [
      [1_000_000n, [1n, 2n, 3n]],
      [999_999n, [7n, 11n, 13n, 17n]],
      [100n, [1n, 1n, 1n, 1n, 1n, 1n, 1n]],
      [1n, [1n, 1n, 1n]],
      [7n, [1n, 0n, 0n]],
      [999_999_999_999_999n, [1n, 1n, 1n]],
    ];
    for (const [total, w] of cases) {
      expect(sum(allocate(total, w)), `total=${total}`).toBe(total);
    }
  });

  it('وزن صفر سهمی نمی‌گیرد', () => {
    const parts = allocate(500n, [0n, 1n, 1n]);
    expect(parts[0]).toBe(0n);
    expect(sum(parts)).toBe(500n);
  });

  it('وزن‌های تماماً صفر ⇒ همه صفر', () => {
    expect(allocate(500n, [0n, 0n, 0n])).toEqual([0n, 0n, 0n]);
  });

  it('فهرست خالی ⇒ خروجی خالی', () => {
    expect(allocate(100n, [])).toEqual([]);
  });

  it('مبلغ منفی هم دقیق سرشکن می‌شود', () => {
    expect(sum(allocate(-1000n, [1n, 1n, 1n]))).toBe(-1000n);
  });
});

describe('خواندن و نمایش مبلغ', () => {
  it('رشتهٔ اعشاری به کوچک‌ترین واحد', () => {
    expect(parseAmount('123.45', 2)).toBe(12_345n);
    expect(parseAmount('123', 2)).toBe(12_300n);
    expect(parseAmount('0.01', 2)).toBe(1n);
    expect(parseAmount('1000', 0)).toBe(1000n);
  });

  it('رقم اضافی نیم‌به‌بالا گرد می‌شود', () => {
    expect(parseAmount('1.005', 2)).toBe(101n);
    expect(parseAmount('1.004', 2)).toBe(100n);
  });

  it('منفی درست خوانده می‌شود', () => {
    expect(parseAmount('-5.50', 2)).toBe(-550n);
  });

  it('نمایش، همان مقدار را برمی‌گرداند', () => {
    expect(formatAmount(12_345n, 2)).toBe('123.45');
    expect(formatAmount(1n, 2)).toBe('0.01');
    expect(formatAmount(1000n, 0)).toBe('1000');
    expect(formatAmount(-550n, 2)).toBe('-5.50');
  });

  it('رفت‌وبرگشت مقدار را حفظ می‌کند', () => {
    for (const s of ['0.00', '1.23', '999999.99', '-42.05']) {
      expect(formatAmount(parseAmount(s, 2), 2)).toBe(s);
    }
  });

  it('ورودی نامعتبر خطا می‌دهد', () => {
    expect(() => parseAmount('abc', 2)).toThrow();
    expect(() => parseAmount('', 2)).toThrow();
  });
});
