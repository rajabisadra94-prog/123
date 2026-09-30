import { useState, useRef, useEffect } from 'react'
// @ts-ignore
import jalaali from 'jalaali-js'

const J_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند']
const G_MONTHS = ['ژانویه', 'فوریه', 'مارس', 'آوریل', 'مه', 'ژوئن', 'ژوئیه', 'اوت', 'سپتامبر', 'اکتبر', 'نوامبر', 'دسامبر']
const WEEK = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'] // شنبه..جمعه

const pad = (n: number) => String(n).padStart(2, '0')
// خروجی به صورت YYYY-MM-DD (بدون ساعت) تا با بک‌اند و فرمت قبلی سازگار بماند
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
// اندیس روز هفته با شروع شنبه (شنبه=۰ ... جمعه=۶)
const satIndex = (d: Date) => (d.getDay() + 1) % 7

/**
 * انتخابگر تاریخ تقویمی با کلید تغییر شمسی↔میلادی در بالای تقویم.
 * هر تاریخی انتخاب شود، معادلش در تقویم دیگر زیر فیلد نمایش داده می‌شود.
 * خروجی onChange: رشتهٔ YYYY-MM-DD میلادی (یا '' برای خالی).
 */
export default function DateField({ value, onChange, style, placeholder }: {
  value?: string
  onChange: (date: string) => void
  style?: React.CSSProperties
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'jalali' | 'gregorian'>('jalali')
  const ref = useRef<HTMLDivElement>(null)

  const selected = value ? new Date(value) : null
  const valid = !!selected && !isNaN(selected.getTime())

  const computeView = () => {
    const base = valid ? (selected as Date) : new Date()
    if (mode === 'jalali') {
      const { jy, jm } = jalaali.toJalaali(base.getFullYear(), base.getMonth() + 1, base.getDate())
      return { y: jy, m: jm }
    }
    return { y: base.getFullYear(), m: base.getMonth() + 1 }
  }
  const [view, setView] = useState(computeView)

  // با تغییر حالت تقویم/مقدار/بازشدن، ماه نمایش‌داده‌شده را به تاریخ انتخابی یا امروز ببر
  useEffect(() => { setView(computeView()) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [mode, value, open])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const shamsiOf = (d: Date) => { const { jy, jm, jd } = jalaali.toJalaali(d.getFullYear(), d.getMonth() + 1, d.getDate()); return `${jy}/${pad(jm)}/${pad(jd)}` }
  const gregOf = (d: Date) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`

  const displayText = !valid ? '' : (mode === 'jalali' ? shamsiOf(selected as Date) : gregOf(selected as Date))
  const equivText = !valid ? '' : (mode === 'jalali' ? `میلادی: ${gregOf(selected as Date)}` : `شمسی: ${shamsiOf(selected as Date)}`)

  // ساخت سلول‌های روزهای ماه جاری
  const cells: ({ day: number; date: Date; isSelected: boolean; isToday: boolean } | null)[] = []
  let monthLabel = ''
  {
    let firstWeekday = 0, daysInMonth = 0, dayToDate: (d: number) => Date
    if (mode === 'jalali') {
      daysInMonth = jalaali.jalaaliMonthLength(view.y, view.m)
      const g1 = jalaali.toGregorian(view.y, view.m, 1)
      firstWeekday = satIndex(new Date(g1.gy, g1.gm - 1, g1.gd))
      dayToDate = (d: number) => { const g = jalaali.toGregorian(view.y, view.m, d); return new Date(g.gy, g.gm - 1, g.gd) }
      monthLabel = `${J_MONTHS[view.m - 1]} ${view.y}`
    } else {
      daysInMonth = new Date(view.y, view.m, 0).getDate()
      firstWeekday = satIndex(new Date(view.y, view.m - 1, 1))
      dayToDate = (d: number) => new Date(view.y, view.m - 1, d)
      monthLabel = `${G_MONTHS[view.m - 1]} ${view.y}`
    }
    const today = new Date()
    const same = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
    for (let i = 0; i < firstWeekday; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) {
      const dt = dayToDate(d)
      cells.push({ day: d, date: dt, isSelected: valid && same(dt, selected as Date), isToday: same(dt, today) })
    }
  }

  const navMonth = (delta: number) => {
    let m = view.m + delta, y = view.y
    if (m < 1) { m = 12; y-- } else if (m > 12) { m = 1; y++ }
    setView({ y, m })
  }

  const navBtn: React.CSSProperties = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, width: 26, height: 26, cursor: 'pointer', fontSize: 16, lineHeight: 1 }

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      <input
        type="text" readOnly value={displayText} placeholder={placeholder || 'انتخاب تاریخ'}
        onClick={() => setOpen((o) => !o)} style={{ cursor: 'pointer', textAlign: 'right', width: '100%' }}
      />
      {equivText && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{equivText}</div>}

      {open && (
        <div dir="rtl" style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', zIndex: 200, padding: 10, width: 264 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
            <button type="button" onClick={() => setMode('jalali')} className={`btn-sm ${mode === 'jalali' ? 'btn-primary' : 'btn-secondary'}`} style={{ flex: 1 }}>شمسی</button>
            <button type="button" onClick={() => setMode('gregorian')} className={`btn-sm ${mode === 'gregorian' ? 'btn-primary' : 'btn-secondary'}`} style={{ flex: 1 }}>میلادی</button>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <button type="button" onClick={() => navMonth(-1)} style={navBtn}>‹</button>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{monthLabel}</span>
            <button type="button" onClick={() => navMonth(1)} style={navBtn}>›</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 2 }}>
            {WEEK.map((w) => <div key={w} style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', padding: 2 }}>{w}</div>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {cells.map((c, i) => c === null ? <div key={i} /> : (
              <button key={i} type="button" onClick={() => { onChange(fmt(c.date)); setOpen(false) }}
                style={{
                  padding: 6, fontSize: 12, borderRadius: 6, border: c.isToday && !c.isSelected ? '1px solid var(--brand)' : 'none',
                  cursor: 'pointer', fontFamily: 'inherit',
                  background: c.isSelected ? 'var(--brand)' : 'transparent',
                  color: c.isSelected ? '#fff' : 'inherit',
                }}>{c.day}</button>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
            <button type="button" className="btn-sm btn-secondary" onClick={() => { onChange(fmt(new Date())); setOpen(false) }}>امروز</button>
            {value && <button type="button" className="btn-sm btn-secondary" onClick={() => { onChange(''); setOpen(false) }}>پاک کردن</button>}
          </div>
        </div>
      )}
    </div>
  )
}
