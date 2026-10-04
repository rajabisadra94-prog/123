/**
 * قالب‌بندی مشترکِ مبالغ دفترداری.
 *
 * ⚠️ **همهٔ مبالغ از سرور به‌صورت رشته می‌آیند** و در کوچک‌ترین واحد ارز هستند
 * (ریال، سنت، فِن). با `Number()` کار نمی‌کنیم چون مبالغ ریالی از محدودهٔ امن
 * عدد جاوااسکریپت بیرون می‌زنند — همان گم‌شدن ریالی که کل بازنویسی برای رفعش بود.
 * قالب‌بندی با `BigInt` انجام می‌شود.
 *
 * چرا اینجا و نه کپی در هر صفحه: تا پیش از این، همین تابع **چهار بار** در
 * `LedgerPage`، `LedgerReports`، `LedgerInstruments` و `LedgerPayroll` کپی شده
 * بود (و نسخهٔ حقوق اصلاً پارامتر ارز نمی‌گرفت). نتیجه‌اش این شد که باگِ
 * «صفر با رقم فارسی کنار اعداد لاتین» در بعضی نسخه‌ها بود و در بعضی نه.
 */

export const CUR_LABEL: Record<string, string> = {
  IRR: 'ریال', USD: 'دلار', CNY: 'یوآن', AED: 'درهم', EUR: 'یورو',
}

export const CUR_DECIMALS: Record<string, number> = {
  IRR: 0, USD: 2, CNY: 2, AED: 2, EUR: 2,
}

/** ارزهای قابل انتخاب در فرم‌ها — ترتیب نمایش */
export const CUR_LIST = ['IRR', 'USD', 'CNY', 'AED']

/**
 * کوچک‌ترین واحد → رشتهٔ خوانا با جداکنندهٔ هزارگان.
 *
 * صفر هم مثل بقیهٔ اعداد با رقم لاتین برمی‌گردد. نسخهٔ قبلی `'۰'` فارسی
 * می‌داد و در یک ستون، `301,791,267,895` بالای `۰` می‌نشست.
 */
export function fmt(minor: string | bigint | null | undefined, currency = 'IRR'): string {
  if (minor === null || minor === undefined || minor === '') return '—'
  const decimals = CUR_DECIMALS[currency] ?? 0
  let v: bigint
  try { v = BigInt(minor) } catch { return String(minor) }
  const neg = v < 0n
  const abs = neg ? -v : v
  const p = 10n ** BigInt(decimals)
  const int = (abs / p).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = decimals ? '.' + (abs % p).toString().padStart(decimals, '0') : ''
  return (neg ? '−' : '') + int + frac
}

/** رنگ بر اساس علامت — منفی قرمز */
export const signColor = (v: string | bigint): string => {
  try {
    const n = BigInt(v)
    return n < 0n ? 'var(--danger)' : n > 0n ? 'var(--text)' : 'var(--text-muted)'
  } catch { return 'var(--text)' }
}
