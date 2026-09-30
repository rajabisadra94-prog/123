import { useState } from 'react'

// ── مرتب‌سازی قابل‌کلیک ستون‌های جدول (مشترک بین همهٔ ماژول‌ها) ──
export type SortDir = 'asc' | 'desc'

export function useSort(initialKey: string, initialDir: SortDir = 'desc') {
  const [key, setKey] = useState(initialKey)
  const [dir, setDir] = useState<SortDir>(initialDir)
  const toggle = (k: string) => { if (k === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc')); else { setKey(k); setDir('asc') } }
  const apply = <T,>(rows: T[], accessors: Record<string, (r: T) => any>): T[] => {
    const acc = accessors[key]
    if (!acc) return rows
    return [...rows].sort((a, b) => {
      const va = acc(a), vb = acc(b)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      // رشته‌ها با ترتیب فارسی؛ عدد/تاریخ با مقایسهٔ معمول
      const c = (typeof va === 'string' && typeof vb === 'string')
        ? va.localeCompare(vb, 'fa')
        : (va < vb ? -1 : va > vb ? 1 : 0)
      return dir === 'asc' ? c : -c
    })
  }
  return { key, dir, toggle, apply }
}
export type Sort = ReturnType<typeof useSort>

// سرستون قابل‌کلیک با نشانگر ⇅ / ▲ / ▼
export function SortTH({ label, k, sort, style }: { label: string; k: string; sort: Sort; style?: any }) {
  const active = sort.key === k
  return (
    <th onClick={() => sort.toggle(k)} style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', ...style }} title="برای مرتب‌سازی کلیک کنید">
      {label} <span style={{ opacity: active ? 1 : 0.3, fontSize: 10 }}>{active ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
    </th>
  )
}
