import { useState, useEffect } from 'react'

// نمایش عدد با جداکنندهٔ هزارگان؛ مقدار ذخیره‌شده «رشتهٔ عددی تمیز» است (بدون جداکننده).
function withSeparators(v: string): string {
  if (v === '' || v == null) return ''
  const neg = v.startsWith('-')
  let cleaned = v.replace(/[^\d.]/g, '')
  if (cleaned === '') return neg ? '-' : ''
  const dot = cleaned.indexOf('.')
  let intPart = dot >= 0 ? cleaned.slice(0, dot) : cleaned
  const decPart = dot >= 0 ? cleaned.slice(dot + 1) : ''
  intPart = intPart.replace(/^0+(?=\d)/, '')
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-' : '') + grouped + (dot >= 0 ? '.' + decPart : '')
}

/** ورودی عددی با ممیز هزارگان. value و onChange با «رشتهٔ عددی تمیز» کار می‌کنند (drop-in برای input عددی رشته‌ای). */
export default function NumberInput({
  value, onChange, placeholder, style, disabled, decimals = false, className,
}: {
  value: string | number | null | undefined
  onChange: (clean: string) => void
  placeholder?: string
  style?: React.CSSProperties
  disabled?: boolean
  decimals?: boolean
  className?: string
}) {
  const [text, setText] = useState('')

  useEffect(() => {
    const s = value === null || value === undefined ? '' : String(value)
    setText(withSeparators(s))
  }, [value])

  const handle = (raw: string) => {
    // فقط رقم، نقطه و منفی نگه می‌داریم
    let cleaned = raw.replace(/[^\d.-]/g, '')
    if (!decimals) cleaned = cleaned.replace(/\./g, '')
    setText(withSeparators(cleaned))
    onChange(cleaned === '-' ? '' : cleaned)
  }

  return (
    <input
      type="text"
      dir="ltr"
      inputMode={decimals ? 'decimal' : 'numeric'}
      className={className}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      style={{ textAlign: 'right', ...style }}
      onChange={(e) => handle(e.target.value)}
    />
  )
}
