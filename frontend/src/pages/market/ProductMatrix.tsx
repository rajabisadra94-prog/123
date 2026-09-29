import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import { Loading, EmptyState } from '../../components/ui'
import { LEVELS, LEVEL_MAP, PRICE_MAP, STATUS_MAP, toneOf, stars } from './shared'
import Icon from '../../components/ui/Icon'

/**
 * ماتریس مخاطب × محصول.
 * هر سلول: رنگ = نظر دربارهٔ محصول، حرف داخلش = نظر دربارهٔ قیمت،
 * نقطهٔ گوشه = نمونه خواسته. یک نگاه، وضعیت کل بازار.
 */
export default function ProductMatrix({ onOpen }: { onOpen: (id: string) => void }) {
  const [governorate, setGovernorate] = useState('')
  const [onlyDiscussed, setOnlyDiscussed] = useState(true)

  const { data, isLoading } = useQuery({
    queryKey: ['market-matrix', governorate],
    queryFn: () => api.get('/market/matrix', { params: governorate ? { governorate } : {} }).then((r) => r.data),
  })
  const { data: cities = [] } = useQuery({ queryKey: ['market-cities'], queryFn: () => api.get('/market/cities').then((r) => r.data) })

  if (isLoading) return <Loading />
  if (!data) return null

  const products: any[] = data.products || []
  let contacts: any[] = data.contacts || []
  if (onlyDiscussed) contacts = contacts.filter((c) => c.interests.some((i: any) => i.level !== 'NOT_DISCUSSED'))

  // جمع ستونی: هر محصول چند «مثبت» دارد
  const totals = products.map((p) => ({
    id: p.id,
    positive: contacts.filter((c) => c.interests.some((i: any) => i.productId === p.id && i.level === 'POSITIVE')).length,
  }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="panel panel-pad" style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <select style={{ maxWidth: 190 }} value={governorate} onChange={(e) => setGovernorate(e.target.value)}>
          <option value="">همه استان‌ها</option>
          {[...new Set(cities.map((c: any) => c.governorate))].map((g: any) => <option key={g} value={g}>{g}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
          <input type="checkbox" checked={onlyDiscussed} onChange={(e) => setOnlyDiscussed(e.target.checked)} />
          فقط کسانی که دربارهٔ محصولی صحبت شده
        </label>
        <div style={{ display: 'flex', gap: 10, marginRight: 'auto', flexWrap: 'wrap', fontSize: 11.5 }}>
          {LEVELS.map((l) => (
            <span key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, background: l.key === 'NOT_DISCUSSED' ? 'var(--bg)' : l.color, border: '1px solid var(--border)' }} />
              {l.label}
            </span>
          ))}
          <span className="hint-sm">حرف داخل خانه = نظر قیمت · نقطه = نمونه خواسته</span>
        </div>
      </div>

      {contacts.length === 0 ? (
        <EmptyState icon={<Icon name="grid" size={26} />} title="هنوز نظری دربارهٔ محصولات ثبت نشده">
          در پروفایل هر مخاطب یا در اتاق تماس، نظرش دربارهٔ هر محصول را بزنید تا این ماتریس پر شود.
        </EmptyState>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ minWidth: 170 }}>مخاطب</th>
                <th>شهر</th>
                {products.map((p, i) => (
                  <th key={p.id} style={{ textAlign: 'center', minWidth: 74 }}>
                    {p.name}
                    <div className="hint-sm" style={{ fontWeight: 400 }}><Icon name="thumbs-up" size={12} /> {totals[i].positive}</div>
                  </th>
                ))}
                <th>رتبه</th>
                <th>امتیاز</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <button onClick={() => onOpen(c.id)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', textAlign: 'right', fontFamily: 'inherit' }}>
                      <div style={{ fontWeight: 700, fontSize: 12.5 }}>{c.name}</div>
                      <div className="hint-sm" style={{ color: toneOf(STATUS_MAP, c.status).color }}>{toneOf(STATUS_MAP, c.status).label}</div>
                    </button>
                  </td>
                  <td className="hint-sm">{c.city?.name || '—'}</td>
                  {products.map((p) => {
                    const it = c.interests.find((i: any) => i.productId === p.id)
                    const lv = toneOf(LEVEL_MAP, it?.level || 'NOT_DISCUSSED')
                    const pr = it ? toneOf(PRICE_MAP, it.priceOpinion) : null
                    const on = it && it.level !== 'NOT_DISCUSSED'
                    const priceChar = it?.priceOpinion === 'GOOD' ? '✓' : it?.priceOpinion === 'ACCEPTABLE' ? '~' : it?.priceOpinion === 'EXPENSIVE' ? '$' : ''
                    return (
                      <td key={p.id} style={{ textAlign: 'center' }}>
                        <span title={`${p.name} — ${lv.label}${pr && pr.key !== 'NOT_DISCUSSED' ? ` · ${pr.label}` : ''}${it?.sampleRequested ? ' · نمونه خواسته' : ''}`}
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
                            width: 30, height: 24, borderRadius: 5, fontSize: 12, fontWeight: 700,
                            background: on ? lv.color : 'var(--bg)', color: on ? '#fff' : 'var(--text-muted)',
                            border: '1px solid var(--border)',
                          }}>
                          {priceChar}
                          {it?.sampleRequested && (
                            <span style={{ position: 'absolute', top: 1, left: 2, width: 5, height: 5, borderRadius: '50%', background: '#fff' }} />
                          )}
                        </span>
                      </td>
                    )
                  })}
                  <td className="nowrap" style={{ color: '#d97706', fontSize: 11 }}>{stars(c.rating) || '—'}</td>
                  <td><strong style={{ fontSize: 12.5 }}>{c.score}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
