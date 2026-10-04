import { useState, useRef, useEffect } from 'react'

export interface Option { value: string; label: string }

/** منوی کشویی با جستجو — جایگزین <select> برای فهرست‌های بلند (مشتری، سازنده، پروژه و...). */
export default function SearchableSelect({
  options, value, onChange, placeholder = 'انتخاب کنید...', disabled, style, allowClear = true,
}: {
  options: Option[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  style?: React.CSSProperties
  allowClear?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQ('') } }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const selected = options.find((o) => o.value === value)
  const filtered = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%', textAlign: 'right', padding: '8px 12px', border: '1px solid var(--border)',
          borderRadius: 8, background: disabled ? 'var(--bg)' : 'var(--surface)', cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: 'inherit', fontSize: 13, color: selected ? 'inherit' : 'var(--text-muted)', display: 'flex',
          justifyContent: 'space-between', alignItems: 'center', gap: 6,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected ? selected.label : placeholder}</span>
        <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {allowClear && value && !disabled && (
            <span onClick={(e) => { e.stopPropagation(); onChange('') }} style={{ color: 'var(--text-muted)', fontSize: 14 }}>✕</span>
          )}
          <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>▼</span>
        </span>
      </button>

      {open && !disabled && (
        <div style={{
          position: 'absolute', top: '100%', right: 0, left: 0, marginTop: 4, background: 'var(--surface)',
          border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 100, maxHeight: 280, display: 'flex', flexDirection: 'column',
        }}>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="جستجو..."
            style={{ margin: 8, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontSize: 13 }}
          />
          <div style={{ overflowY: 'auto' }}>
            {filtered.map((o) => (
              <div
                key={o.value}
                onClick={() => { onChange(o.value); setOpen(false); setQ('') }}
                style={{
                  padding: '8px 12px', cursor: 'pointer', fontSize: 13,
                  background: o.value === value ? 'var(--bg)' : 'transparent',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = o.value === value ? 'var(--bg)' : 'transparent')}
              >{o.label}</div>
            ))}
            {filtered.length === 0 && <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>موردی یافت نشد</div>}
          </div>
        </div>
      )}
    </div>
  )
}
