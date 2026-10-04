/**
 * آزمون خاصیت‌محور (property-based) روی هستهٔ ریاضی دفترداری.
 *
 * چرا این شکل: تست‌های نمونه‌ای فقط حالت‌هایی را می‌سنجند که نویسنده به آن‌ها
 * فکر کرده. اینجا به‌جای «ورودی ثابت ⇒ خروجی ثابت»، **خاصیت‌هایی** بیان
 * می‌شوند که باید برای *هر* ورودی برقرار باشند، و ده‌ها هزار ورودی تصادفی
 * به آن‌ها زده می‌شود.
 *
 * مولد **بذردار** است: هر شکست با همان بذر عیناً بازتولید می‌شود.
 */
import { describe, it, expect } from 'vitest';
import {
  parseAmount, formatAmount, allocate, divRound, toBase, rateFrom,
  RATE_SCALE, MAX_MINOR,
} from '../../src/modules/ledger/money';
import { progressiveTax } from '../../src/modules/ledger/payroll/engine';
import { monthlyAmount } from '../../src/modules/ledger/depreciation';

/** مولد شبه‌تصادفیِ بذردار — mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const R = rng(20260905);
const int = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];

/** عدد صحیح بزرگ تصادفی تا `digits` رقم */
function bigOf(digits: number): bigint {
  let s = '';
  for (let i = 0; i < digits; i++) s += int(i === 0 ? 1 : 0, 9);
  return BigInt(s);
}

const CASES = 20_000;

// ═══════════════════════════════════════════════════════════════
describe('لایهٔ پول — رفت و برگشتِ نمایش و ذخیره', () => {
  it(`${CASES} مبلغ تصادفی: parse(format(x)) === x`, () => {
    for (let i = 0; i < CASES; i++) {
      const decimals = pick([0, 2, 3] as const);
      const v = bigOf(int(1, 15)) * BigInt(pick([1, -1]));
      if (v > MAX_MINOR || v < -MAX_MINOR) continue;
      expect(parseAmount(formatAmount(v, decimals), decimals)).toBe(v);
    }
  });

  it('جداکنندهٔ هزارگان هرگز مقدار را عوض نمی‌کند', () => {
    for (let i = 0; i < CASES; i++) {
      const v = bigOf(int(1, 15));
      const plain = v.toString();
      // همان عدد با کاما، فاصله، ممیز فارسی، و ارقام فارسی
      const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const spaced = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      const persianSep = plain.replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
      const persianDigits = plain.replace(/\d/g, (d) => String.fromCharCode(0x06f0 + Number(d)));
      for (const form of [plain, grouped, spaced, persianSep, persianDigits]) {
        expect(parseAmount(form, 0)).toBe(v);
      }
    }
  });

  it('ورودیِ بی‌معنی همیشه خطا می‌دهد، نه عددِ بی‌سر و ته', () => {
    const junk = ['', ' ', 'abc', '1e5', '1.2.3', '--5', '1,,2', '.', '-', '+', '١٢٣abc', '0x1F'];
    for (const s of junk) expect(() => parseAmount(s, 0)).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
describe('سرشکن — هیچ ریالی گم یا اضافه نمی‌شود', () => {
  it(`${CASES} سرشکنِ تصادفی: sum(parts) === total دقیقاً`, () => {
    for (let i = 0; i < CASES; i++) {
      const n = int(1, 8);
      const weights = Array.from({ length: n }, () => bigOf(int(1, 6)));
      const total = bigOf(int(1, 13)) * BigInt(pick([1, -1]));
      const parts = allocate(total, weights);
      expect(parts.length).toBe(n);
      expect(parts.reduce((s, x) => s + x, 0n)).toBe(total);
    }
  });

  it('وزنِ صفر سهم نمی‌گیرد و کل همچنان حفظ می‌شود', () => {
    for (let i = 0; i < 2_000; i++) {
      const weights = [0n, bigOf(int(1, 5)), 0n, bigOf(int(1, 5))];
      const total = bigOf(int(1, 10));
      const parts = allocate(total, weights);
      expect(parts[0]).toBe(0n);
      expect(parts[2]).toBe(0n);
      expect(parts.reduce((s, x) => s + x, 0n)).toBe(total);
    }
  });

  it('همهٔ وزن‌ها صفر ⇒ همهٔ سهم‌ها صفر (بدون تقسیم بر صفر)', () => {
    expect(allocate(1_000n, [0n, 0n, 0n])).toEqual([0n, 0n, 0n]);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('گرد کردن — متقارن و بدون سوگیری ساختاری', () => {
  it(`${CASES} تقسیم تصادفی: |q×den − num| ≤ den/2`, () => {
    for (let i = 0; i < CASES; i++) {
      const den = bigOf(int(1, 10));
      const num = bigOf(int(1, 16)) * BigInt(pick([1, -1]));
      const q = divRound(num, den);
      const err = q * den - num;
      const abs = err < 0n ? -err : err;
      expect(abs * 2n).toBeLessThanOrEqual(den);
    }
  });

  it('منفی، آینهٔ دقیقِ مثبت است', () => {
    for (let i = 0; i < CASES; i++) {
      const den = bigOf(int(1, 8));
      const num = bigOf(int(1, 14));
      expect(divRound(-num, den)).toBe(-divRound(num, den));
    }
  });
});

// ═══════════════════════════════════════════════════════════════
describe('تبدیل به ارز پایه', () => {
  it('یکنواخت است: مبلغ بیشتر ⇒ معادل پایهٔ بیشتر یا برابر', () => {
    for (let i = 0; i < CASES; i++) {
      const rate = rateFrom(String(int(1, 3_000_000)));
      const a = BigInt(int(1, 10_000_000));
      const b = a + BigInt(int(1, 1_000_000));
      expect(toBase(b, rate, 2, 0)).toBeGreaterThanOrEqual(toBase(a, rate, 2, 0));
    }
  });

  it('نرخ ۱ روی ارز هم‌اعشار، مبلغ را عوض نمی‌کند', () => {
    for (let i = 0; i < 5_000; i++) {
      const a = bigOf(int(1, 12));
      expect(toBase(a, { scaled: RATE_SCALE }, 2, 2)).toBe(a);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
describe('مالیات پلکانی', () => {
  const brackets = [
    { from: 0n, to: 1_000_000_000n, rate: 0.10 },
    { from: 1_000_000_000n, to: 3_000_000_000n, rate: 0.15 },
    { from: 3_000_000_000n, to: 6_000_000_000n, rate: 0.20 },
    { from: 6_000_000_000n, to: null, rate: 0.30 },
  ];

  it(`${CASES} مبنای تصادفی: مالیات هرگز از مبنا بیشتر نمی‌شود و منفی نیست`, () => {
    for (let i = 0; i < CASES; i++) {
      const base = bigOf(int(1, 13));
      const tax = progressiveTax(base, brackets);
      expect(tax).toBeGreaterThanOrEqual(0n);
      expect(tax).toBeLessThanOrEqual(base);
    }
  });

  it('یکنواخت است: درآمد بیشتر هرگز مالیات کمتر نمی‌دهد', () => {
    for (let i = 0; i < CASES; i++) {
      const a = bigOf(int(1, 12));
      const b = a + BigInt(int(1, 5_000_000));
      expect(progressiveTax(b, brackets)).toBeGreaterThanOrEqual(progressiveTax(a, brackets));
    }
  });

  it('نرخ نهاییِ مؤثر هرگز از بالاترین پله بیشتر نیست', () => {
    for (let i = 0; i < 5_000; i++) {
      const base = bigOf(int(4, 13));
      const tax = progressiveTax(base, brackets);
      expect(tax * 10n).toBeLessThanOrEqual(base * 3n);   // ≤ ۳۰٪
    }
  });

  it('مبنای صفر یا منفی ⇒ مالیات صفر', () => {
    expect(progressiveTax(0n, brackets)).toBe(0n);
    expect(progressiveTax(-500n, brackets)).toBe(0n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('استهلاک خط مستقیم', () => {
  it(`${CASES} دارایی تصادفی: جمع دوره‌ها دقیقاً برابر بها منهای اسقاط`, () => {
    for (let i = 0; i < CASES; i++) {
      const cost = bigOf(int(4, 14));
      const salvage = (cost * BigInt(int(0, 40))) / 100n;
      const life = int(1, 240);
      let sum = 0n;
      for (let p = 1; p <= life; p++) sum += monthlyAmount(cost, salvage, life, p);
      expect(sum).toBe(cost - salvage);
    }
  });

  it('هیچ دوره‌ای منفی نیست و آخرین دوره باقی‌ماندهٔ گرد کردن را می‌گیرد', () => {
    for (let i = 0; i < 5_000; i++) {
      const cost = bigOf(int(3, 12));
      const life = int(2, 60);
      const first = monthlyAmount(cost, 0n, life, 1);
      const last = monthlyAmount(cost, 0n, life, life);
      expect(first).toBeGreaterThanOrEqual(0n);
      expect(last).toBeGreaterThanOrEqual(first);
      expect(last - first).toBeLessThan(BigInt(life));
    }
  });
});
