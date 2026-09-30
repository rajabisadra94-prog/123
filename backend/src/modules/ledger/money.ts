/**
 * لایهٔ پول — همهٔ مبالغ عدد صحیح در **کوچک‌ترین واحد ارز** (ریال، سنت، فِن).
 *
 * قاعدهٔ ۳-۳ سند مرجع: «اعداد پولی هرگز float نباشند.»
 * پس در کل این ماژول هیچ `number` پولی وجود ندارد — فقط `bigint`.
 * تنها جایی که کسر ظاهر می‌شود نرخ ارز است که با `Rate` (اعداد صحیح مقیاس‌دار)
 * مدل می‌شود، نه با شناور.
 */

/** مقیاس نرخ: نرخ‌ها با ۱۰ رقم اعشار نگه داشته می‌شوند (هم‌تراز با Decimal(24,10)) */
export const RATE_SCALE = 10n ** 10n;

export type Minor = bigint;

/** نرخ به‌صورت عدد صحیح مقیاس‌دار — `scaled = rate × 10^10` */
export interface Rate {
  scaled: bigint;
}

/** ساخت نرخ از رشته یا عدد، بدون از دست دادن دقت در مسیر رشته‌ای */
export function rateFrom(value: string | number | bigint): Rate {
  if (typeof value === 'bigint') return { scaled: value * RATE_SCALE };
  const s = typeof value === 'number' ? formatNumberExact(value) : value.trim();
  return { scaled: parseScaled(s, 10) };
}

export const rateToString = (r: Rate): string => unscale(r.scaled, 10);

/**
 * تبدیل مبلغ ارزی به ارز پایه.
 *
 *   base_minor = round( foreign_minor / 10^fd × rate × 10^bd )
 *
 * همه‌چیز در عدد صحیح انجام می‌شود؛ گرد کردن «نیم به بالا» و متقارن حول صفر.
 */
export function toBase(
  amount: Minor,
  rate: Rate,
  foreignDecimals: number,
  baseDecimals: number,
): Minor {
  const num = amount * rate.scaled * 10n ** BigInt(baseDecimals);
  const den = RATE_SCALE * 10n ** BigInt(foreignDecimals);
  return divRound(num, den);
}

/** تقسیم صحیح با گرد کردن نیم‌به‌بالا (متقارن برای اعداد منفی) */
export function divRound(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error('تقسیم بر صفر');
  const neg = (num < 0n) !== (den < 0n);
  const a = num < 0n ? -num : num;
  const b = den < 0n ? -den : den;
  const q = (a * 2n + b) / (b * 2n);
  return neg ? -q : q;
}

/**
 * سرشکن یک مبلغ بین چند سهم با روش **بزرگ‌ترین باقی‌مانده**.
 *
 * تضمین: `sum(result) === total` دقیقاً — بدون گم‌شدن حتی یک ریال.
 * این همان رفتار اثبات‌شدهٔ `allocate` هستهٔ قدیمی است، اینجا روی bigint.
 */
export function allocate(total: Minor, weights: bigint[]): Minor[] {
  const n = weights.length;
  if (n === 0) return [];
  const sumW = weights.reduce((s, w) => s + w, 0n);
  if (sumW === 0n) return new Array(n).fill(0n);

  const neg = total < 0n;
  const abs = neg ? -total : total;

  const base: bigint[] = [];
  const rem: bigint[] = [];
  let used = 0n;
  for (const w of weights) {
    const exact = abs * w;
    const q = exact / sumW;
    base.push(q);
    rem.push(exact - q * sumW);
    used += q;
  }

  let left = abs - used;
  const order = rem
    .map((r, i) => ({ i, r }))
    .sort((a, b) => (b.r === a.r ? a.i - b.i : b.r > a.r ? 1 : -1));

  for (let k = 0; k < order.length && left > 0n; k++, left--) base[order[k].i] += 1n;
  // وزن‌های به‌شدت نامتوازن: باقی‌مانده به بزرگ‌ترین سهم
  if (left !== 0n && order.length) base[order[0].i] += left;

  return neg ? base.map((v) => -v) : base;
}

// ───────────────────────────────────────────────
// تبدیل نمایش ↔ ذخیره‌سازی
// ───────────────────────────────────────────────

/** «۱۲۳٫۴۵» با ۲ رقم اعشار ⇒ 12345n */
/**
 * سقفِ ستون `BigInt` پستگرس (`int8`). فراتر از این، Prisma پیش از رسیدن به
 * دیتابیس با یک خطای انگلیسیِ خام می‌شکند و کاربر ۵۰۰ می‌گیرد (ممیزی ن۸).
 * ۹٫۲۲ × ۱۰¹⁸ ریال ≈ ۹۲۲ هزار همت — هیچ مبلغ واقعی به آن نمی‌رسد.
 */
export const MAX_MINOR: Minor = 9_223_372_036_854_775_807n;

export class AmountError extends Error {}

/** بازهٔ مجاز را می‌سنجد و خطای فارسیِ روشن می‌دهد، نه dump داخلی */
function assertInRange(v: Minor, raw: string): Minor {
  if (v > MAX_MINOR || v < -MAX_MINOR) {
    throw new AmountError(`مبلغ «${raw}» از حد مجاز بیشتر است`);
  }
  return v;
}

export function parseAmount(input: string | number | bigint, decimals: number): Minor {
  if (typeof input === 'bigint') return assertInRange(input, input.toString());
  const s = typeof input === 'number' ? formatNumberExact(input) : input.trim();
  return assertInRange(parseScaled(s, decimals), s);
}

/** 12345n با ۲ رقم اعشار ⇒ «۱۲۳.۴۵» */
export const formatAmount = (v: Minor, decimals: number): string => unscale(v, decimals);

/**
 * ارقام فارسی (۰-۹) و عربی-هندی (٠-٩) به لاتین.
 *
 * چرا لازم است: صفحه‌کلید فارسی به‌طور پیش‌فرض همین ارقام را می‌دهد. بدون این،
 * حسابداری که «۱۲۳۴» تایپ می‌کند «عدد نامعتبر» می‌گیرد — در نرم‌افزاری فارسی.
 */
function latinDigits(s: string): string {
  return s.replace(/[۰-۹٠-٩]/g, (c) => {
    const code = c.charCodeAt(0);
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

/**
 * جداکننده‌های هزارگان — همه حذف می‌شوند، هیچ‌کدام اعشار نیستند.
 *
 * ⚠️ کاما **باید** اینجا باشد (ممیزی ب۱). پیش‌تر کاما نگه داشته می‌شد و بعد
 * جداکنندهٔ اعشار خوانده می‌شد؛ نتیجه این بود که «1,234» ریال بی‌هیچ خطایی
 * ۱ ریال ثبت می‌شد — چون ریال صفر رقم اعشار دارد و ۱٫۲۳۴ گرد می‌شد به ۱.
 * جداکنندهٔ اعشار فقط «.» و «٫» (ممیز فارسی) است.
 */
const GROUP_SEPARATORS = /[\s_,٬']/g;   // \s فاصلهٔ باریک و بدون‌شکست را هم می‌گیرد

/**
 * جداکنندهٔ بدساخت — دو تا پشت سر هم، یا در ابتدا/انتهای عدد.
 *
 * ⚠️ توسط fuzz پیدا شد: «1,,2» بی‌صدا ۱۲ می‌شد. حذفِ بی‌قیدِ جداکننده‌ها
 * همان دستهٔ خطای ب۱ را از در دیگر برمی‌گرداند — ورودیِ خرابِ کاربر، به‌جای
 * خطا، به عددی تبدیل می‌شود که هیچ‌کس نخواسته. «1,234» درست است و باید
 * بگذرد؛ «1,,2» و «,12» و «12,» غلط‌اند و باید بشکنند.
 */
const MALFORMED_SEPARATOR = /[\s_,٬'](?=[\s_,٬'])|^[\s_,٬']|[\s_,٬']$/;

function parseScaled(s: string, decimals: number): bigint {
  const raw = latinDigits(s).trim();
  if (MALFORMED_SEPARATOR.test(raw)) throw new AmountError(`عدد نامعتبر: ${s}`);
  const cleaned = raw.replace(GROUP_SEPARATORS, '').replace(/٫/g, '.');
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(cleaned);
  if (!m) throw new AmountError(`عدد نامعتبر: ${s}`);
  const [, sign, intPart = '', fracRaw = ''] = m;
  if (!intPart && !fracRaw) throw new AmountError(`عدد نامعتبر: ${s}`);

  const frac = fracRaw.padEnd(decimals + 1, '0');
  const kept = frac.slice(0, decimals);
  const nextDigit = frac.charCodeAt(decimals) - 48;

  let v = BigInt(intPart || '0') * 10n ** BigInt(decimals) + BigInt(kept || '0');
  if (nextDigit >= 5) v += 1n;                 // گرد کردن نیم‌به‌بالا
  return sign === '-' ? -v : v;
}

function unscale(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const p = 10n ** BigInt(decimals);
  const int = abs / p;
  const frac = abs % p;
  const s = decimals === 0 ? `${int}` : `${int}.${frac.toString().padStart(decimals, '0')}`;
  return neg ? `-${s}` : s;
}

/**
 * نمایش دقیق یک `number` بدون نماد علمی.
 * فقط برای پذیرش ورودی‌های عددی قدیمی است؛ مسیر ترجیحی، رشته است.
 */
function formatNumberExact(n: number): string {
  if (!Number.isFinite(n)) throw new AmountError(`عدد نامعتبر: ${n}`);
  if (!/e/i.test(String(n))) return String(n);
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}
