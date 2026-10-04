import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import { Loading, EmptyState } from '../../components/ui'
import Icon from '../../components/ui/Icon'
import { STATUSES, STATUS_MAP, CHANNEL_MAP, RESULT_MAP, toneOf, fmtUsd } from './shared'
import type { MarketFilters } from './MarketPage'

/** گزارش کمپین: قیف، پوشش شهرها، محصولات و عملکرد تماس‌گیرنده */
export default function Analytics({ onOpenCity }: { onOpenCity?: (f: MarketFilters) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['market-analytics'],
    queryFn: () => api.get('/market/analytics').then((r) => r.data),
  })

  if (isLoading) return <Loading />
  if (!data) return null
  if (data.total === 0) return <EmptyState icon={<Icon name="chart" size={26} />} title="هنوز داده‌ای برای گزارش نیست">اول چند مخاطب وارد کنید و با آن‌ها تماس بگیرید.</EmptyState>

  const maxStatus = Math.max(1, ...STATUSES.map((s) => data.byStatus[s.key] || 0))
  const maxProduct = Math.max(1, ...data.byProduct.map((p: any) => p.discussed))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="grid-4">
        <Kpi value={data.total} label="کل مخاطبین" color="var(--brand)" />
        <Kpi value={data.reached} label="تماس گرفته شده" color="#2563eb" sub={`${Math.round((data.reached / data.total) * 100)}٪ از لیست`} />
        <Kpi value={`${data.interestRate}٪`} label="نرخ علاقه‌مندی" color="#0891b2" sub={`${data.interested} نفر از ${data.reached} تماس`} />
        <Kpi value={data.customers} label="مشتری شده" color="var(--success)" sub={`نرخ تبدیل ${data.conversionRate}٪`} />
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="panel panel-pad">
          <h4 className="section-title">قیف — مخاطبین در هر وضعیت</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {STATUSES.map((s) => {
              const n = data.byStatus[s.key] || 0
              return (
                <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                  <span style={{ width: 118, fontSize: 12, flexShrink: 0 }}>{s.label}</span>
                  <div style={{ flex: 1, background: 'var(--bg)', borderRadius: 6, height: 17, overflow: 'hidden' }}>
                    <div style={{ width: `${(n / maxStatus) * 100}%`, background: s.color, height: '100%', minWidth: n ? 4 : 0 }} />
                  </div>
                  <span style={{ width: 34, textAlign: 'left', fontWeight: 700, fontSize: 12.5 }}>{n}</span>
                </div>
              )
            })}
          </div>
        </div>

        <div className="panel panel-pad">
          <h4 className="section-title">محصولات — بازار چه می‌گوید</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {data.byProduct.map((p: any) => (
              <div key={p.productId}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginBottom: 4 }}>
                  <strong>{p.name}</strong>
                  <span className="hint-sm">{p.discussed} بار مطرح شد</span>
                  {p.sampleRequests > 0 && <span className="chip-soft" style={{ color: '#7c3aed' }}><Icon name="package" size={13} /> {p.sampleRequests} نمونه</span>}
                  {p.avgTargetUsd != null && (
                    <span className="chip-soft" style={{ marginRight: 'auto' }} title="میانگین قیمتی که بازار می‌خواهد">
                      هدف بازار: {fmtUsd(p.avgTargetUsd)}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', height: 14, borderRadius: 5, overflow: 'hidden', background: 'var(--bg)' }}>
                  <Seg n={p.positive} max={maxProduct} color="#16a34a" title={`مثبت: ${p.positive}`} />
                  <Seg n={p.neutral} max={maxProduct} color="#d97706" title={`خنثی: ${p.neutral}`} />
                  <Seg n={p.negative} max={maxProduct} color="#dc2626" title={`منفی: ${p.negative}`} />
                </div>
                <div className="hint-sm" style={{ marginTop: 3 }}>
                  <Icon name="thumbs-up" size={12} /> {p.positive} · <Icon name="minus" size={12} /> {p.neutral} · <Icon name="thumbs-down" size={12} /> {p.negative}
                  {p.priceExpensive > 0 && <span style={{ color: 'var(--danger)' }}> · {p.priceExpensive} نفر گفتند گران است</span>}
                  {p.priceGood > 0 && <span style={{ color: 'var(--success)' }}> · {p.priceGood} نفر قیمت را پسندیدند</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ alignItems: 'start' }}>
        <CityCoverage data={data} onOpenCity={onOpenCity} />

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="panel panel-pad">
            <h4 className="section-title">کانال‌ها و نتیجهٔ تماس‌ها ({data.calls} تماس)</h4>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              {Object.entries(data.byChannel).map(([k, n]) => {
                const ch = toneOf(CHANNEL_MAP, k)
                return <span key={k} className="chip-soft" style={{ color: ch.color }}>{ch.icon && <Icon name={ch.icon} size={13} />}{ch.label}: {n as number}</span>
              })}
              {Object.keys(data.byChannel).length === 0 && <span className="hint-sm">هنوز تماسی ثبت نشده</span>}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {Object.entries(data.byResult).map(([k, n]) => {
                const r = toneOf(RESULT_MAP, k)
                return <span key={k} className="chip-soft" style={{ color: r.color }}>{r.icon && <Icon name={r.icon} size={13} />}{r.label}: {n as number}</span>
              })}
            </div>
          </div>

          <CallHoursPanel data={data.callHours} />

          <div className="panel panel-pad">
            <h4 className="section-title">عملکرد تماس‌گیرنده</h4>
            {data.callers.length === 0 ? <div className="hint-sm">—</div> : (
              <table className="data-table">
                <thead><tr><th>نفر</th><th>تعداد تماس</th><th>جواب داده</th><th>نرخ پاسخ</th></tr></thead>
                <tbody>
                  {data.callers.map((c: any) => (
                    <tr key={c.id}>
                      <td style={{ fontSize: 12.5 }}>{c.name}</td>
                      <td>{c.calls}</td>
                      <td>{c.answered}</td>
                      <td><strong>{c.calls ? Math.round((c.answered / c.calls) * 100) : 0}٪</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel panel-pad">
            <h4 className="section-title">منبع شماره‌ها</h4>
            {data.bySource.length === 0 ? <div className="hint-sm">—</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {data.bySource.slice(0, 8).map((s: any) => (
                  <div key={s.source} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
                    <span>{s.source}</span><strong>{s.count}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="panel panel-pad" style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        <div><strong style={{ fontSize: 20, color: 'var(--danger)' }}>{data.promises.pending}</strong> <span className="hint-sm">تعهد ارسالِ انجام‌نشده</span></div>
        <div><strong style={{ fontSize: 20, color: 'var(--success)' }}>{data.promises.sent}</strong> <span className="hint-sm">ارسال‌شده</span></div>
        <div style={{ marginRight: 'auto' }} className="hint-sm">
          وضعیت غالب: {toneOf(STATUS_MAP, Object.entries(data.byStatus).sort((a: any, b: any) => b[1] - a[1])[0]?.[0]).label}
        </div>
      </div>
    </div>
  )
}

/**
 * پوشش شهرها — جانشین تب «شهرها» که حذف شد.
 *
 * تفاوت کلیدی با یک جدول آمار ساده: از جدول ۸۷ شهر عراق ساخته می‌شود نه از
 * مخاطبین، پس شهری که هنوز هیچ شماره‌ای در آن ثبت نشده هم دیده می‌شود —
 * همان سؤالی که هیچ‌جای دیگر سیستم جواب نمی‌دهد: «کجا را اصلاً دست نزده‌ایم؟»
 */
function CityCoverage({ data, onOpenCity }: { data: any; onOpenCity?: (f: MarketFilters) => void }) {
  const [showUntouched, setShowUntouched] = useState(false)
  const all: any[] = data.byCity || []
  const active = all.filter((c) => c.total > 0).sort((a, b) => b.total - a.total)
  const untouched = all.filter((c) => c.total === 0)

  return (
    <div className="panel panel-pad">
      <h4 className="section-title">پوشش شهرها</h4>

      {active.length === 0 ? <div className="hint-sm">هنوز مخاطبی با شهر مشخص ثبت نشده.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {active.map((c) => {
            const pct = Math.round((c.contacted / c.total) * 100)
            const row = (
              <>
                <span style={{ fontSize: 12.5, fontWeight: 600, minWidth: 78 }}>{c.name}</span>
                <span className="hint-sm" style={{ minWidth: 54, fontSize: 10.5 }}>{c.governorate}</span>
                <span style={{ flex: 1, background: 'var(--bg)', borderRadius: 6, height: 8, overflow: 'hidden', minWidth: 40 }}>
                  <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: pct === 100 ? 'var(--success)' : 'var(--brand)' }} />
                </span>
                {c.interested > 0 && <span className="chip-soft" style={{ color: '#0891b2', fontSize: 10 }}><Icon name="star" size={11} />{c.interested}</span>}
                {c.customers > 0 && <span className="chip-soft" style={{ color: 'var(--success)', fontSize: 10 }}><Icon name="trophy" size={11} />{c.customers}</span>}
                <span className="hint-sm" style={{ minWidth: 46, textAlign: 'left' }} title="تماس‌گرفته از کل">{c.contacted}/{c.total}</span>
              </>
            )
            const style: React.CSSProperties = {
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 8,
              border: '1px solid var(--border)', background: 'var(--surface-2)', width: '100%',
              textAlign: 'right', fontFamily: 'inherit',
            }
            return onOpenCity
              ? <button key={c.id} onClick={() => onOpenCity({ cityId: c.id })} style={{ ...style, cursor: 'pointer' }} title="دیدن مخاطبین این شهر">{row}</button>
              : <div key={c.id} style={style}>{row}</div>
          })}
        </div>
      )}

      {data.noCityCount > 0 && (
        <button className="btn-ghost btn-sm" style={{ marginTop: 9, color: 'var(--warning)' }}
          onClick={() => onOpenCity?.({ cityId: 'none' })} disabled={!onOpenCity}>
          <Icon name="alert" /> {data.noCityCount} مخاطب بدون شهر — شهرشان را تعیین کنید
        </button>
      )}

      {untouched.length > 0 && (
        <div style={{ marginTop: 12, borderTop: '1px dashed var(--border)', paddingTop: 10 }}>
          <button className="btn-ghost btn-sm" onClick={() => setShowUntouched((v) => !v)}>
            <Icon name="chevron-left" style={{ transform: showUntouched ? 'rotate(90deg)' : 'none', transition: 'transform .15s ease' }} /> {untouched.length} شهر که هنوز اصلاً واردشان نشده‌ایم
          </button>
          {showUntouched && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
              {untouched.map((c) => (
                <span key={c.id} className="chip-soft" style={{ fontSize: 11, opacity: .85 }} title={c.governorate}>{c.name}</span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Kpi({ value, label, color, sub }: { value: React.ReactNode; label: string; color: string; sub?: string }) {
  return (
    <div className="panel panel-pad" style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 26, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
      <div className="hint-sm" style={{ marginTop: 6 }}>{label}</div>
      {sub && <div className="hint-sm" style={{ opacity: .7, marginTop: 2, fontSize: 11 }}>{sub}</div>}
    </div>
  )
}

function Seg({ n, max, color, title }: { n: number; max: number; color: string; title: string }) {
  if (!n) return null
  return <div title={title} style={{ width: `${(n / max) * 100}%`, background: color, height: '100%' }} />
}

/**
 * بهترین ساعت تماس — نرخ پاسخ به تفکیک ساعتِ بغداد.
 *
 * فقط تماس تلفنیِ نتیجه‌دار شمرده می‌شود (پیام واتساپ «جواب دادن» ندارد).
 * تا وقتی نمونه کافی نباشد هیچ ادعایی نمی‌کند — گفتنِ «ساعت ۱۰ بهترین است»
 * بر پایهٔ ۲ تماس، بدتر از نگفتن است.
 */
function CallHoursPanel({ data }: { data: any }) {
  if (!data) return null
  const hours: { hour: number; calls: number; answered: number }[] = data.byHour || []
  const fa = (h: number) => `${String(h).padStart(2, '0')}:00`

  return (
    <div className="panel panel-pad">
      <h4 className="section-title">بهترین ساعت تماس <span className="hint-sm" style={{ fontWeight: 400 }}>(به وقت عراق)</span></h4>

      {data.best ? (
        <div className="alert alert-success" style={{ marginBottom: 11 }}>
          بیشترین پاسخ‌گویی حوالی <strong>{fa(data.best.hour)}</strong> است —
          {' '}{data.best.rate}٪ از {data.best.calls} تماس جواب داده شده.
          {data.worst && data.worst.hour !== data.best.hour && (
            <> کمترین حوالی <strong>{fa(data.worst.hour)}</strong> با {data.worst.rate}٪.</>
          )}
        </div>
      ) : (
        <div className="hint-sm" style={{ marginBottom: 11 }}>
          هنوز داده کافی نیست. برای هر ساعت حداقل {data.minSample} تماسِ تلفنیِ نتیجه‌دار لازم است
          {data.totalCalls ? ` (تا الان ${data.totalCalls} تماس ثبت شده)` : ''}.
        </div>
      )}

      {hours.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {hours.map((h) => {
            const rate = h.calls ? Math.round((h.answered / h.calls) * 100) : 0
            const enough = h.calls >= data.minSample
            return (
              <div key={h.hour} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12 }}>
                <span style={{ width: 44, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fa(h.hour)}</span>
                <div style={{ flex: 1, background: 'var(--bg)', borderRadius: 5, height: 14, overflow: 'hidden' }}>
                  <div style={{
                    width: `${rate}%`, height: '100%', minWidth: rate ? 3 : 0,
                    background: enough ? 'var(--success)' : 'var(--border-strong)',
                  }} />
                </div>
                <span style={{ width: 38, textAlign: 'left', fontWeight: 700 }}>{rate}٪</span>
                <span className="hint-sm" style={{ width: 62, textAlign: 'left' }}>
                  {h.answered}/{h.calls}{!enough ? ' ·کم' : ''}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
