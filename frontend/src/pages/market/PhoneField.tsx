import { normalizeIraqPhone, prettyPhone } from './shared'

/** پیش‌شماره‌هایی که در این کمپین به کار می‌آیند. عراق پیش‌فرض است. */
export const DIAL_CODES: { code: string; label: string }[] = [
  { code: '964', label: 'عراق ‎+964' },
  { code: '98', label: 'ایران ‎+98' },
  { code: '90', label: 'ترکیه ‎+90' },
  { code: '971', label: 'امارات ‎+971' },
  { code: '963', label: 'سوریه ‎+963' },
  { code: '962', label: 'اردن ‎+962' },
  { code: '965', label: 'کویت ‎+965' },
]

/**
 * شمارهٔ ذخیره‌شده را به «پیش‌شماره + بقیه» می‌شکند.
 * طولانی‌ترین پیش‌شمارهٔ منطبق برنده است تا مثلاً `964` جلوی `96` را نگیرد.
 */
export function splitDial(stored?: string | null): { dial: string; rest: string } {
  const digits = String(stored || '').replace(/\D/g, '')
  if (!digits) return { dial: '964', rest: '' }
  const hit = [...DIAL_CODES].sort((a, b) => b.code.length - a.code.length)
    .find((d) => digits.startsWith(d.code))
  if (hit) return { dial: hit.code, rest: digits.slice(hit.code.length) }
  return { dial: '964', rest: digits.replace(/^0+/, '') }
}

/** پیش‌شماره و شمارهٔ ملی را به شکل ذخیره‌سازی می‌چسباند */
export const joinDial = (dial: string, rest: string) => {
  const national = String(rest || '').replace(/\D/g, '').replace(/^0+/, '')
  return national ? `+${dial}${national}` : ''
}

/**
 * ورودی شمارهٔ تلفن با پیش‌شمارهٔ کشور جدا.
 *
 * چرا دو تکه: قبلاً یک کادر آزاد بود و کاربر هر بار جور دیگری می‌نوشت
 * (`07701234567`، `+964 770…`، `00964770…`). با جدا کردن پیش‌شماره، شکلِ
 * ذخیره‌شده همیشه یکسان است و تشخیص تکراری قابل اتکا می‌شود.
 * صفرِ ابتدای شمارهٔ ملی خودکار حذف می‌شود — کاربر عادت دارد `0770…` بزند.
 */
export default function PhoneField({ value, onChange, autoFocus, placeholder = '7701234567', disabled }: {
  value: string
  onChange: (stored: string) => void
  autoFocus?: boolean
  placeholder?: string
  disabled?: boolean
}) {
  const { dial, rest } = splitDial(value)
  const stored = joinDial(dial, rest)
  // اعتبارسنجی فقط برای عراق سخت‌گیر است؛ بقیه فقط طول منطقی را می‌سنجند
  const ok = !rest ? null : dial === '964' ? !!normalizeIraqPhone(stored) : rest.length >= 6 && rest.length <= 12

  return (
    <>
      <div style={{ display: 'flex', gap: 6 }}>
        <select value={dial} disabled={disabled} aria-label="پیش‌شمارهٔ کشور"
          style={{ width: 132, flex: 'none' }}
          onChange={(e) => onChange(joinDial(e.target.value, rest))}>
          {DIAL_CODES.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}
        </select>
        <input dir="ltr" inputMode="tel" autoFocus={autoFocus} disabled={disabled}
          style={{ flex: 1, minWidth: 0 }} placeholder={placeholder} value={rest}
          aria-label="شمارهٔ تلفن بدون پیش‌شماره"
          onChange={(e) => onChange(joinDial(dial, e.target.value))} />
      </div>
      {rest && ok === false && (
        <div className="hint-sm" style={{ color: 'var(--danger)' }}>
          این شماره معتبر به نظر نمی‌رسد{dial === '964' ? ' — موبایل عراق ۱۰ رقم است و با ۷ شروع می‌شود' : ''}
        </div>
      )}
      {rest && ok && <div className="hint-sm" dir="ltr" style={{ textAlign: 'right' }}>{prettyPhone(stored)}</div>}
    </>
  )
}
