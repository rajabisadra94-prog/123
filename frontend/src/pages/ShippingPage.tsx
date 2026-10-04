import { useState, useMemo, useEffect, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { API_ORIGIN } from '../lib/api'
import { toShamsi, faDate } from '../lib/date'
import { useSort, SortTH } from '../components/shared/sortable'
import NumberInput from '../components/shared/NumberInput'
import SearchableSelect from '../components/shared/SearchableSelect'
import DateField from '../components/shared/DateField'
import { PageHeader, TableEmpty } from '../components/ui'
import { dialog, toast } from '../components/ui/dialog'

// ۶.۱۰ — فیلتر «در جریان / تکمیل‌شده / همه» مشترک برای هر ۴ بخش حمل
function SubFilter({ value, onChange, active, done }: { value: string; onChange: (v: string) => void; active: number; done: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
      {([['active', `در جریان (${active})`], ['done', `تکمیل‌شده (${done})`], ['all', `همه (${active + done})`]] as const).map(([k, l]) => (
        <button key={k} className={`tab-btn ${value === k ? 'active' : ''}`} onClick={() => onChange(k)}>{l}</button>
      ))}
    </div>
  )
}

// ردیف جزئیاتِ بازشو (۶.۱۱)
function ExpandRow({ colSpan, children }: { colSpan: number; children: any }) {
  return (
    <tr><td colSpan={colSpan} style={{ background: 'var(--surface-2, var(--surface-2))', padding: 12 }}>{children}</td></tr>
  )
}

const SHIP_TYPE: Record<string, string> = { AIR: 'هوایی', SEA: 'دریایی', LAND: 'زمینی', RAIL: 'ریلی' }

// ۶.۱۳ — بستهٔ کاملاً داخلی (همهٔ سفارش‌ها از سازندهٔ ایرانی): مسیر کوتاه، مستقیم به تحویل (بدون حمل اصلی بین‌المللی)
const isDomesticPkg = (p: any) => (p.items?.length > 0) && p.items.every((it: any) => it.order?.producer?.isDomestic)

// نوار مرحله‌ای بصری برای دیدن دقیق موقعیت هر محموله
const SHP_STEPS = ['ایجاد', 'در حال حمل', 'رسیده', 'تحویل به ما']
const shpStep = (status: string) => (status === 'ARRIVED' ? 2 : status === 'DELIVERED_TO_US' ? 3 : 1)
const DOM_STEPS = ['ایجاد', 'در حال ارسال', 'تحویل به فورواردر']
const DOM_STEPS_DOMESTIC = ['ایجاد', 'در حال ارسال', 'رسیده به دست ما'] // ۶.۱۳ — مسیر سازندهٔ داخلی
const domStep = (status: string) => (status === 'DELIVERED_TO_FORWARDER' ? 2 : 1)

function Stepper({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: i === current ? 700 : 400, color: i < current ? 'var(--success)' : i === current ? 'var(--brand)' : 'var(--text-muted)' }}>
            <span style={{ width: 15, height: 15, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, color: 'var(--surface)', background: i < current ? 'var(--success)' : i === current ? 'var(--brand)' : 'var(--border)' }}>{i < current ? '✓' : i + 1}</span>
            {s}
          </span>
          {i < steps.length - 1 && <span style={{ width: 14, height: 2, background: i < current ? 'var(--success)' : 'var(--border)', margin: '0 3px' }} />}
        </div>
      ))}
    </div>
  )
}

// ── پایپ‌لاین افقی مراحل حمل با شمارش زندهٔ «در جریان» ──
const STAGES = [
  { key: 'ready', label: 'آماده‌سازی ارسال', icon: '📦' },
  { key: 'domestic', label: 'حمل داخلی', icon: '🚚' },
  { key: 'main', label: 'حمل اصلی', icon: '✈️' },
  { key: 'delivery', label: 'تحویل مشتری', icon: '✅' },
]
function StagePipeline({ current, onSelect, counts }: { current: string; onSelect: (k: string) => void; counts: Record<string, number> }) {
  const activeIdx = STAGES.findIndex((s) => s.key === current)
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', flexWrap: 'wrap', gap: 6, marginBottom: 22 }}>
      {STAGES.map((s, i) => {
        const isActive = i === activeIdx
        const isPast = i < activeIdx
        const bg = isActive ? 'var(--brand)' : isPast ? 'var(--brand-soft, #eef6f7)' : 'var(--surface, #fff)'
        const fg = isActive ? '#fff' : isPast ? 'var(--brand)' : 'var(--text-muted)'
        const bd = isActive || isPast ? 'var(--brand)' : 'var(--border)'
        return (
          <Fragment key={s.key}>
            <button onClick={() => onSelect(s.key)} style={{
              flex: '1 1 150px', minWidth: 138, textAlign: 'right', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
              background: bg, color: fg, border: `1.5px solid ${bd}`, borderRadius: 12,
              transition: 'all .15s ease', boxShadow: isActive ? '0 6px 16px -8px var(--brand)' : 'none',
            }}>
              <span style={{
                width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13,
                background: isActive ? 'rgba(255,255,255,.22)' : isPast ? 'var(--brand)' : 'var(--border)',
                color: isActive || isPast ? 'var(--surface)' : 'var(--text-muted)',
              }}>{isPast ? '✓' : i + 1}</span>
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35, minWidth: 0 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{s.icon} {s.label}</span>
                <span style={{ fontSize: 11, opacity: isActive ? 0.92 : 0.8 }}>{counts[s.key] ?? 0} مورد در جریان</span>
              </span>
            </button>
            {i < STAGES.length - 1 && <span style={{ display: 'flex', alignItems: 'center', color: 'var(--border)', fontSize: 18, fontWeight: 700 }}>‹</span>}
          </Fragment>
        )
      })}
    </div>
  )
}

export default function ShippingPage() {
  const [tab, setTab] = useState('ready')
  // شمارش زنده برای پایپ‌لاین — همان query keyها که تب‌ها استفاده می‌کنند (کش مشترک، بدون درخواست اضافه)
  const { data: ready = [] } = useQuery({ queryKey: ['ship-ready'], queryFn: () => api.get('/shipping/ready').then((r) => r.data) })
  const { data: domestic = [] } = useQuery({ queryKey: ['ship-domestic'], queryFn: () => api.get('/shipping/domestic').then((r) => r.data) })
  const { data: main = [] } = useQuery({ queryKey: ['ship-main'], queryFn: () => api.get('/shipping/shipments').then((r) => r.data) })
  const { data: delivery = [] } = useQuery({ queryKey: ['ship-delivery'], queryFn: () => api.get('/shipping/delivery').then((r) => r.data) })
  const counts: Record<string, number> = {
    ready: ready.length,
    domestic: domestic.filter((p: any) => p.status !== 'DELIVERED_TO_FORWARDER').length,
    main: main.filter((s: any) => s.status !== 'DELIVERED_TO_US').length,
    delivery: delivery.filter((p: any) => !(p.status === 'COMPLETED' || ((p.parts?.length || 0) > 0 && p.parts.every((pt: any) => pt.milestone === 'DELIVERED')))).length,
  }
  return (
    <div className="page" dir="rtl">
      <PageHeader title="حمل و نقل" subtitle="از بستهٔ داخلی تا محمولهٔ بین‌المللی و تحویل نهایی به مشتری" />
      <StagePipeline current={tab} onSelect={setTab} counts={counts} />
      {tab === 'ready' && <ReadyTab />}
      {tab === 'domestic' && <DomesticTab />}
      {tab === 'main' && <MainTab />}
      {tab === 'delivery' && <DeliveryTab />}
    </div>
  )
}

// ─── STAGE 1: READY TO SHIP ───────────────────────────
function ReadyTab() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showCreate, setShowCreate] = useState(false)
  const { data: orders = [] } = useQuery({ queryKey: ['ship-ready'], queryFn: () => api.get('/shipping/ready').then((r) => r.data) })

  const toggle = (id: string) => { const n = new Set(selected); n.has(id) ? n.delete(id) : n.add(id); setSelected(n) }
  const sort = useSort('createdAt', 'desc')
  const rows = sort.apply(orders as any[], {
    code: (o) => o.code,
    project: (o) => o.project?.code,
    customer: (o) => o.project?.customer?.name,
    producer: (o) => o.producer?.name ?? o.supplier?.name,
    createdAt: (o) => o.createdAt,
    updatedAt: (o) => o.updatedAt,
  })

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn-primary" disabled={selected.size === 0} onClick={() => setShowCreate(true)}>📦 ایجاد بسته حمل داخلی</button>
      </div>
      <div className="table-container">
      <table className="data-table">
        <thead><tr>
          <th></th>
          <SortTH label="کد سفارش" k="code" sort={sort} />
          <SortTH label="پروژه" k="project" sort={sort} />
          <SortTH label="مشتری" k="customer" sort={sort} />
          <SortTH label="سازنده / تامین‌کننده" k="producer" sort={sort} />
          <SortTH label="تاریخ ایجاد" k="createdAt" sort={sort} />
          <SortTH label="آخرین رویداد" k="updatedAt" sort={sort} />
        </tr></thead>
        <tbody>
          {rows.map((o: any) => (
            <tr key={o.id}>
              <td><input type="checkbox" style={{ width: 'auto' }} checked={selected.has(o.id)} onChange={() => toggle(o.id)} /></td>
              <td className="code-text">{o.code}</td>
              <td>{o.project.code}</td>
              <td>{o.project.customer.name}</td>
              <td>{o.producer?.name ?? o.supplier?.name ?? '—'}</td>
              <td className="nowrap">{faDate(o.createdAt)}</td>
              <td className="nowrap">{faDate(o.updatedAt)}</td>
            </tr>
          ))}
          {rows.length === 0 && <TableEmpty colSpan={7}>سفارش تکمیل‌شده‌ای برای ارسال نیست</TableEmpty>}
        </tbody>
      </table>
      </div>
      {showCreate && <CreatePackageModal orderIds={[...selected]} onClose={() => setShowCreate(false)} onSuccess={() => { setShowCreate(false); setSelected(new Set()); qc.invalidateQueries({ queryKey: ['ship-ready'] }); qc.invalidateQueries({ queryKey: ['ship-domestic'] }) }} />}
    </div>
  )
}

function CreatePackageModal({ orderIds, onClose, onSuccess }: any) {
  const [shippingCompanyId, setShippingCompanyId] = useState('')
  const [referenceNo, setReferenceNo] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const { data: companies = [] } = useQuery({ queryKey: ['shipping-companies'], queryFn: () => api.get('/settings/shipping-companies').then((r) => r.data) })
  const mut = useMutation({
    mutationFn: () => api.post('/shipping/domestic', { orderIds, shippingCompanyId, referenceNo, notes }),
    onSuccess, onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>ایجاد بسته حمل داخلی</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <p className="hint-lg" style={{ marginBottom: 12  }}>{orderIds.length} سفارش انتخاب شده</p>
          <div className="form-group">
            <label>شرکت حمل (فورواردر) *</label>
            <SearchableSelect value={shippingCompanyId} onChange={setShippingCompanyId} placeholder="انتخاب..."
              options={companies.map((c: any) => ({ value: c.id, label: c.name }))} />
          </div>
          <div className="form-group"><label>شماره رفرنس بسته</label><input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} /></div>
          <div className="form-group"><label>یادداشت</label><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="یادداشت دلخواه دربارهٔ این بسته" /></div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={!shippingCompanyId || mut.isPending} onClick={() => mut.mutate()}>ایجاد بسته</button>
        </div>
      </div>
    </div>
  )
}

// ─── STAGE 2: DOMESTIC SHIPPING ───────────────────────
function DomesticTab() {
  const [openPkg, setOpenPkg] = useState<any>(null)
  const [filter, setFilter] = useState('active')
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data: packages = [] } = useQuery({ queryKey: ['ship-domestic'], queryFn: () => api.get('/shipping/domestic').then((r) => r.data) })

  const isDone = (p: any) => p.status === 'DELIVERED_TO_FORWARDER'
  const active = packages.filter((p: any) => !isDone(p)).length
  const done = packages.filter(isDone).length
  const shown = packages.filter((p: any) => (filter === 'all' ? true : filter === 'done' ? isDone(p) : !isDone(p)))
  const sort = useSort('createdAt', 'desc')
  const rows = sort.apply(shown as any[], {
    code: (p) => p.code,
    forwarder: (p) => p.shippingCompany?.name,
    ref: (p) => p.referenceNo,
    items: (p) => p.items?.length || 0,
    status: (p) => p.status,
    createdAt: (p) => p.createdAt,
    updatedAt: (p) => p.updatedAt,
  })

  return (
    <div>
      <SubFilter value={filter} onChange={setFilter} active={active} done={done} />
      <div className="table-container">
      <table className="data-table">
        <thead><tr>
          <th></th>
          <SortTH label="کد بسته" k="code" sort={sort} />
          <SortTH label="فورواردر" k="forwarder" sort={sort} />
          <SortTH label="رفرنس" k="ref" sort={sort} />
          <SortTH label="سفارش‌ها" k="items" sort={sort} />
          <SortTH label="وضعیت" k="status" sort={sort} />
          <SortTH label="تاریخ ایجاد" k="createdAt" sort={sort} />
          <SortTH label="آخرین رویداد" k="updatedAt" sort={sort} />
          <th>اقدام</th>
        </tr></thead>
        <tbody>
          {rows.map((p: any) => (
            <Fragment key={p.id}>
              <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
                <td style={{ width: 22, color: 'var(--text-muted)' }}>{expanded === p.id ? '▼' : '◀'}</td>
                <td className="code-text">{p.code}{isDomesticPkg(p) && <span title="سازندهٔ داخلی — مسیر کوتاه، مستقیم به تحویل مشتری (بدون حمل اصلی بین‌المللی)" style={{ marginRight: 4, fontSize: 10, background: 'var(--success-soft)', color: 'var(--success)', padding: '1px 6px', borderRadius: 'var(--radius)' }}>داخلی</span>}</td>
                <td>{p.shippingCompany.name}</td>
                <td>{p.referenceNo || '-'}{p.notes ? <span title={p.notes} style={{ marginRight: 4, cursor: 'help' }}>📝</span> : null}</td>
                <td>{p.items.length}</td>
                <td style={{ minWidth: 230 }}><Stepper steps={isDomesticPkg(p) ? DOM_STEPS_DOMESTIC : DOM_STEPS} current={domStep(p.status)} /></td>
                <td className="nowrap">{faDate(p.createdAt)}</td>
                <td className="nowrap">{faDate(p.updatedAt)}</td>
                <td><button className="btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); setOpenPkg(p) }}>مدیریت</button></td>
              </tr>
              {expanded === p.id && (
                <ExpandRow colSpan={9}>
                  <div style={{ marginBottom: 8, fontSize: 12 }}>
                    <b>رفرنس بسته:</b> {p.referenceNo || '—'}{p.notes ? <> • <b>یادداشت:</b> {p.notes}</> : ''}
                  </div>
                  <table className="data-table" style={{ background: 'var(--surface)' }}>
                    <thead><tr><th>سفارش</th><th>پروژه</th><th>مشتری</th><th>سازنده</th><th>رهگیری</th><th>تحویل فورواردر</th></tr></thead>
                    <tbody>
                      {p.items.map((it: any) => (
                        <tr key={it.id}>
                          <td className="code-text">{it.order.code}</td>
                          <td className="code-text">{it.order.project.code}</td>
                          <td>{it.order.project.customer?.name || '—'}</td>
                          <td>{it.order.producer?.name || it.order.supplier?.name || '—'}</td>
                          <td>{it.trackingNo || '—'}</td>
                          <td>{it.isDelivered ? `✓ ${it.deliveredAt ? toShamsi(it.deliveredAt) : ''}` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ExpandRow>
              )}
            </Fragment>
          ))}
          {rows.length === 0 && <TableEmpty colSpan={9}>موردی در این دسته نیست</TableEmpty>}
        </tbody>
      </table>
      </div>
      {openPkg && <PackageDetailModal pkg={openPkg} onClose={() => setOpenPkg(null)} />}
    </div>
  )
}

function PackageDetailModal({ pkg, onClose }: any) {
  const qc = useQueryClient()
  const [tracking, setTracking] = useState<Record<string, string>>(
    Object.fromEntries(pkg.items.map((i: any) => [i.id, i.trackingNo || ''])),
  )
  const refresh = () => qc.invalidateQueries({ queryKey: ['ship-domestic'] })
  const updateItem = useMutation({
    mutationFn: ({ itemId, body }: any) => api.patch(`/shipping/domestic/${pkg.id}/item/${itemId}`, body),
    onSuccess: refresh,
  })
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 720 }}>
        <div className="modal-header"><h2>بسته {pkg.code} — {pkg.shippingCompany.name}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <table className="data-table">
            <thead><tr><th>سفارش</th><th>پروژه</th><th>شماره رهگیری</th><th>تحویل به فورواردر</th></tr></thead>
            <tbody>
              {pkg.items.map((it: any) => (
                <tr key={it.id}>
                  <td className="code-text">{it.order.code}</td>
                  <td>{it.order.project.code}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input value={tracking[it.id]} onChange={(e) => setTracking({ ...tracking, [it.id]: e.target.value })} placeholder="Tracking #" />
                      <button className="btn-secondary btn-sm" onClick={() => updateItem.mutate({ itemId: it.id, body: { trackingNo: tracking[it.id] } })}>ذخیره</button>
                    </div>
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" style={{ width: 'auto' }} defaultChecked={it.isDelivered}
                      onChange={(e) => updateItem.mutate({ itemId: it.id, body: { isDelivered: e.target.checked } })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint" style={{ marginTop: 10  }}>وقتی همه سفارش‌ها تحویل فورواردر شوند، وضعیت بسته خودکار به «رسیده به فورواردر» تغییر می‌کند.</p>
        </div>
        <div className="modal-footer"><button onClick={onClose} className="btn-secondary">بستن</button></div>
      </div>
    </div>
  )
}

// ─── STAGE 3: MAIN SHIPMENTS ──────────────────────────
function MainTab() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showCreate, setShowCreate] = useState(false)
  const [freightShipment, setFreightShipment] = useState<any>(null)
  const [filter, setFilter] = useState('active')
  const [expanded, setExpanded] = useState<string | null>(null)
  const { data: packages = [] } = useQuery({ queryKey: ['ship-domestic'], queryFn: () => api.get('/shipping/domestic').then((r) => r.data) })
  const { data: shipments = [] } = useQuery({ queryKey: ['ship-main'], queryFn: () => api.get('/shipping/shipments').then((r) => r.data) })

  const isShipDone = (s: any) => s.status === 'DELIVERED_TO_US'
  const shActive = shipments.filter((s: any) => !isShipDone(s)).length
  const shDone = shipments.filter(isShipDone).length
  const shownShipments = shipments.filter((s: any) => (filter === 'all' ? true : filter === 'done' ? isShipDone(s) : !isShipDone(s)))
  const sort = useSort('createdAt', 'desc')
  const rows = sort.apply(shownShipments as any[], {
    code: (s) => s.code,
    forwarder: (s) => s.shippingCompany?.name,
    type: (s) => s.type,
    ref: (s) => s.forwarderRef,
    status: (s) => s.status,
    createdAt: (s) => s.createdAt,
    updatedAt: (s) => s.updatedAt,
  })

  // packages already in a shipment
  const usedPkgIds = useMemo(() => new Set(shipments.flatMap((s: any) => s.packages.map((p: any) => p.packageId))), [shipments])
  // ۶.۱۳ — بستهٔ کاملاً داخلی (سازندهٔ ایرانی) وارد «حمل اصلی» بین‌المللی نمی‌شود؛ مستقیم به تحویل می‌رود
  const availablePkgs = packages.filter((p: any) => p.status === 'DELIVERED_TO_FORWARDER' && !usedPkgIds.has(p.id) && !isDomesticPkg(p))

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: any) => api.patch(`/shipping/shipments/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ship-main'] }),
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  const toggle = (id: string) => { const n = new Set(selected); n.has(id) ? n.delete(id) : n.add(id); setSelected(n) }

  return (
    <div>
      {availablePkgs.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 16 }}>
          <h3 className="section-title">📥 بسته‌های آماده برای محموله اصلی</h3>
          <table className="data-table" style={{ marginBottom: 10 }}>
            <thead><tr><th></th><th>کد بسته</th><th>فورواردر</th><th>سفارش‌ها</th></tr></thead>
            <tbody>
              {availablePkgs.map((p: any) => (
                <tr key={p.id}>
                  <td><input type="checkbox" style={{ width: 'auto' }} checked={selected.has(p.id)} onChange={() => toggle(p.id)} /></td>
                  <td className="code-text">{p.code}</td>
                  <td>{p.shippingCompany.name}</td>
                  <td>{p.items.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn-primary btn-sm" disabled={selected.size === 0} onClick={() => setShowCreate(true)}>🚢 ایجاد محموله اصلی</button>
        </div>
      )}

      <h3 className="section-title">✈️ محموله‌های اصلی</h3>
      <SubFilter value={filter} onChange={setFilter} active={shActive} done={shDone} />
      <div className="table-container">
      <table className="data-table">
        <thead><tr>
          <th></th>
          <SortTH label="کد محموله" k="code" sort={sort} />
          <SortTH label="فورواردر" k="forwarder" sort={sort} />
          <SortTH label="نوع" k="type" sort={sort} />
          <SortTH label="کد مرجع" k="ref" sort={sort} />
          <SortTH label="وضعیت" k="status" sort={sort} />
          <SortTH label="تاریخ ایجاد" k="createdAt" sort={sort} />
          <SortTH label="آخرین رویداد" k="updatedAt" sort={sort} />
          <th>اقدام</th>
        </tr></thead>
        <tbody>
          {rows.map((s: any) => (
            <Fragment key={s.id}>
              <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === s.id ? null : s.id)}>
                <td style={{ width: 22, color: 'var(--text-muted)' }}>{expanded === s.id ? '▼' : '◀'}</td>
                <td className="code-text">{s.code}</td>
                <td>{s.shippingCompany.name}</td>
                <td>{SHIP_TYPE[s.type]}</td>
                <td>{s.forwarderRef || '-'}{s.notes ? <span title={s.notes} style={{ marginRight: 4, cursor: 'help' }}>📝</span> : null}</td>
                <td style={{ minWidth: 270 }}><Stepper steps={SHP_STEPS} current={shpStep(s.status)} /></td>
                <td className="nowrap">{faDate(s.createdAt)}</td>
                <td className="nowrap">{faDate(s.updatedAt)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {s.status === 'IN_TRANSIT' && <button className="btn-secondary btn-sm" onClick={() => updateStatus.mutate({ id: s.id, status: 'ARRIVED' })}>ثبت «رسیده»</button>}
                    {s.status === 'ARRIVED' && !s.freightInvoice && <button className="btn-secondary btn-sm" onClick={() => setFreightShipment(s)}>🧾 ثبت فاکتور حمل</button>}
                    {s.status === 'ARRIVED' && (
                      <button className="btn-primary btn-sm" disabled={!s.freightInvoice} title={s.freightInvoice ? '' : 'ابتدا باید فاکتور حمل ثبت شود'}
                        onClick={() => updateStatus.mutate({ id: s.id, status: 'DELIVERED_TO_US' })}>
                        {s.freightInvoice ? 'تحویل شده به ما' : '🔒 تحویل'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              {expanded === s.id && (
                <ExpandRow colSpan={9}>
                  <div style={{ fontSize: 12, marginBottom: 8 }}>
                    <b>کد مرجع فورواردر:</b> {s.forwarderRef || '—'} • <b>نوع حمل:</b> {SHIP_TYPE[s.type]}
                    {s.notes ? <> • <b>یادداشت:</b> {s.notes}</> : ''}
                    {s.arrivedAt ? <> • رسیده: {toShamsi(s.arrivedAt)}</> : ''}
                    {s.deliveredToUsAt ? <> • تحویل به ما: {toShamsi(s.deliveredToUsAt)}</> : ''}
                  </div>
                  <table className="data-table" style={{ background: 'var(--surface)' }}>
                    <thead><tr><th>بسته</th><th>سفارش</th><th>پروژه</th><th>مشتری</th></tr></thead>
                    <tbody>
                      {s.packages.flatMap((sp: any) => sp.package.items.map((it: any) => (
                        <tr key={it.id}>
                          <td className="code-text">{sp.package.code}</td>
                          <td className="code-text">{it.order.code}</td>
                          <td className="code-text">{it.order.project.code}</td>
                          <td>{it.order.project.customer?.name || '—'}</td>
                        </tr>
                      )))}
                    </tbody>
                  </table>
                  <ShipmentDocs shipment={s} />
                </ExpandRow>
              )}
            </Fragment>
          ))}
          {rows.length === 0 && <TableEmpty colSpan={9}>موردی در این دسته نیست</TableEmpty>}
        </tbody>
      </table>
      </div>

      {showCreate && <CreateShipmentModal packageIds={[...selected]} onClose={() => setShowCreate(false)} onSuccess={() => { setShowCreate(false); setSelected(new Set()); qc.invalidateQueries({ queryKey: ['ship-main'] }) }} />}
      {freightShipment && <FreightInvoiceModal shipment={freightShipment} onClose={() => setFreightShipment(null)} onSuccess={() => { setFreightShipment(null); qc.invalidateQueries({ queryKey: ['ship-main'] }) }} />}
    </div>
  )
}

// ─── WINDOW K: FREIGHT INVOICE (تسهیم دستی درصدی — ۶.۷/۶.۸) ───
function FreightInvoiceModal({ shipment, onClose, onSuccess }: any) {
  const [title, setTitle] = useState('')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [referenceNo, setReferenceNo] = useState('')
  const [invoiceDate, setInvoiceDate] = useState('')
  const [exchangeRate, setExchangeRate] = useState('')
  const [totalWeightKg, setTotalWeightKg] = useState('')
  const [notes, setNotes] = useState('')
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null)
  const [costRows, setCostRows] = useState<{ description: string; amountToman: string; amountUSD: string }[]>([{ description: '', amountToman: '', amountUSD: '' }])
  const [pct, setPct] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  const { data: preview = [] } = useQuery({
    queryKey: ['freight-preview', shipment.id],
    queryFn: () => api.get(`/accounting/freight-invoices/${shipment.id}/preview`).then((r) => r.data),
  })

  // پیش‌فرض: تسهیم بر اساس وزن + پرکردن وزن کل (گرم → کیلوگرم)
  useEffect(() => {
    if (!preview.length) return
    const totalW = preview.reduce((s: number, p: any) => s + (p.weight || 0), 0)
    const init: Record<string, string> = {}
    preview.forEach((p: any) => { init[p.id] = totalW > 0 ? String(Math.round((p.weight || 0) / totalW * 1000) / 10) : String(Math.round(1000 / preview.length) / 10) })
    setPct(init)
    setTotalWeightKg((cur) => cur || (totalW > 0 ? String(Math.round(totalW / 1000 * 100) / 100) : ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview])

  const rate = Number(exchangeRate) || 0
  const totalToman = costRows.reduce((s, r) => s + (Number(r.amountToman) || 0), 0)
  const totalUSD = costRows.reduce((s, r) => s + (Number(r.amountUSD) || 0), 0)
  const grandTomanEquiv = Math.round(totalToman + totalUSD * rate)
  const totalPct = preview.reduce((s: number, p: any) => s + (Number(pct[p.id]) || 0), 0)
  const shareOf = (pid: string) => { const f = (Number(pct[pid]) || 0) / 100; return { toman: Math.round(f * totalToman), usd: Math.round(f * totalUSD * 100) / 100 } }
  const pctOk = preview.length === 0 || Math.abs(totalPct - 100) < 0.5
  const canSubmit = (totalToman > 0 || totalUSD > 0) && (totalUSD === 0 || rate > 0) && pctOk

  const setEqualPct = () => { const each = Math.floor(1000 / preview.length) / 10; const n: Record<string, string> = {}; preview.forEach((p: any, i: number) => { n[p.id] = String(i === preview.length - 1 ? Math.round((100 - each * (preview.length - 1)) * 10) / 10 : each) }); setPct(n) }
  const setWeightPct = () => { const totalW = preview.reduce((s: number, p: any) => s + (p.weight || 0), 0); const n: Record<string, string> = {}; preview.forEach((p: any) => { n[p.id] = totalW > 0 ? String(Math.round((p.weight || 0) / totalW * 1000) / 10) : '0' }); setPct(n) }

  const mut = useMutation({
    mutationFn: async () => {
      await api.post('/accounting/freight-invoices', {
        shipmentId: shipment.id, title, invoiceNo, referenceNo, invoiceDate: invoiceDate || undefined,
        exchangeRate: rate, totalWeightKg: Number(totalWeightKg) || undefined, notes,
        costRows: costRows
          .filter((r) => Number(r.amountToman) > 0 || Number(r.amountUSD) > 0)
          .map((r) => ({ description: r.description, amountToman: Number(r.amountToman) || 0, amountUSD: Number(r.amountUSD) || 0 })),
        allocations: preview.map((p: any) => ({ projectId: p.id, percentage: Number(pct[p.id]) || 0 })),
      })
      // آپلود فایل فاکتور حمل (اختیاری) — در سطح محموله ذخیره و در اسناد همهٔ پروژه‌های آن دیده می‌شود
      if (invoiceFile) {
        const fd = new FormData()
        fd.append('files', invoiceFile)
        fd.append('fileType', 'FREIGHT_INVOICE')
        await api.post(`/shipping/shipments/${shipment.id}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      }
    },
    onSuccess, onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 760 }}>
        <div className="modal-header"><h2>ایجاد فاکتور حمل — {shipment.code}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="form-group"><label>عنوان فاکتور</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً کرایهٔ حمل دریایی شانگهای" /></div>
            <div className="form-group"><label>شماره فاکتور</label><input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} /></div>
            <div className="form-group"><label>شرکت حمل</label><input value={shipment.shippingCompany?.name || ''} disabled title="فورواردر این محموله" /></div>
            <div className="form-group"><label>شماره رفرنس</label><input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} /></div>
            <div className="form-group"><label>تاریخ فاکتور</label><DateField value={invoiceDate} onChange={setInvoiceDate} /></div>
            <div className="form-group"><label>وزن کل (KG)</label><NumberInput value={totalWeightKg} onChange={setTotalWeightKg} decimals /></div>
            <div className="form-group"><label>نرخ تبدیل دلار (تومان)</label><NumberInput value={exchangeRate} onChange={setExchangeRate} decimals /></div>
            <div className="form-group"><label>واحد پرداخت نهایی</label><input value="تومان (ریال)" disabled /></div>
          </div>
          <div className="form-group"><label>توضیحات</label><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <div className="form-group">
            <label>📎 فایل فاکتور حمل (PDF یا تصویر) — اختیاری</label>
            <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => setInvoiceFile(e.target.files?.[0] || null)} />
            {invoiceFile && <span style={{ fontSize: 11, color: 'var(--success)' }}>✓ {invoiceFile.name}</span>}
          </div>

          <h3 style={{ fontSize: 13, margin: '12px 0 6px' }}>ریز هزینه‌ها (بدهی به شرکت حمل)</h3>
          <table className="data-table">
            <thead><tr><th>شرح</th><th>تومان</th><th>دلار</th><th></th></tr></thead>
            <tbody>
              {costRows.map((r, i) => (
                <tr key={i}>
                  <td><input placeholder="شرح هزینه (کرایه، ترخیص، انبارداری...)" value={r.description} onChange={(e) => { const n = [...costRows]; n[i].description = e.target.value; setCostRows(n) }} style={{ width: '100%' }} /></td>
                  <td><NumberInput value={r.amountToman} onChange={(v) => { const n = [...costRows]; n[i].amountToman = v; setCostRows(n) }} decimals style={{ width: 130 }} /></td>
                  <td><NumberInput value={r.amountUSD} onChange={(v) => { const n = [...costRows]; n[i].amountUSD = v; setCostRows(n) }} decimals style={{ width: 110 }} /></td>
                  <td><button className="btn-danger btn-sm" disabled={costRows.length === 1} onClick={() => setCostRows(costRows.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="btn-secondary btn-sm" onClick={() => setCostRows([...costRows, { description: '', amountToman: '', amountUSD: '' }])}>+ افزودن هزینه</button>
          <div style={{ marginTop: 8, fontSize: 13, textAlign: 'left', fontWeight: 600 }}>
            جمع هزینه‌ها: {totalToman.toLocaleString()} تومان + {totalUSD.toLocaleString()} دلار
            {rate > 0 && <span style={{ color: 'var(--brand)' }}> — معادل کل: {grandTomanEquiv.toLocaleString()} تومان</span>}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '14px 0 6px' }}>
            <h3 style={{ fontSize: 13 }}>تسهیم بین مشتریان (درصدی — دستی)</h3>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn-secondary btn-sm" style={{ fontSize: 10 }} onClick={setWeightPct}>بر اساس وزن</button>
              <button className="btn-secondary btn-sm" style={{ fontSize: 10 }} onClick={setEqualPct}>تقسیم مساوی</button>
            </div>
          </div>
          <table className="data-table">
            <thead><tr><th>پروژه</th><th>مشتری</th><th>وزن (گرم)</th><th>درصد ٪</th><th>سهم تومان</th><th>سهم دلار</th></tr></thead>
            <tbody>
              {preview.map((p: any) => {
                const sh = shareOf(p.id)
                return (
                  <tr key={p.id}>
                    <td className="code-text">{p.code}</td>
                    <td>{p.customer}</td>
                    <td>{(p.weight || 0).toLocaleString()}</td>
                    <td><NumberInput value={pct[p.id] || ''} onChange={(v) => setPct({ ...pct, [p.id]: v })} decimals style={{ width: 70 }} /></td>
                    <td>{sh.toman.toLocaleString()}</td>
                    <td>{sh.usd.toLocaleString()}</td>
                  </tr>
                )
              })}
              {preview.length === 0 && <TableEmpty colSpan={6}>—</TableEmpty>}
            </tbody>
          </table>
          <div style={{ marginTop: 6, fontSize: 13, textAlign: 'left', fontWeight: 600, color: pctOk ? 'var(--success)' : 'var(--danger)' }}>
            مجموع درصدها: {Math.round(totalPct * 10) / 10}٪ {pctOk ? '✓' : '(باید ۱۰۰ باشد)'}
          </div>

          {totalUSD > 0 && rate <= 0 && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 6 }}>برای هزینهٔ دلاری، نرخ تبدیل دلار الزامی است.</div>}
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={!canSubmit || mut.isPending} onClick={() => mut.mutate()}>ثبت فاکتور حمل</button>
        </div>
      </div>
    </div>
  )
}

// اسناد یک محموله (فاکتور حمل، بارنامه، ترخیص...) — نمایش + آپلود + حذف؛ در سطح محموله ذخیره می‌شود
const SHIP_FILE_LABEL: Record<string, string> = {
  FREIGHT_INVOICE: 'فاکتور حمل',
  BILL_OF_LADING: 'بارنامه',
  CUSTOMS: 'ترخیص گمرک',
  FORWARDER_RECEIPT: 'رسید فورواردر',
  LOADING_PHOTO: 'عکس بارگیری',
}

function ShipmentDocs({ shipment }: any) {
  const qc = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [type, setType] = useState('FREIGHT_INVOICE')
  const [busy, setBusy] = useState(false)
  const files: any[] = shipment.files || []

  const uploadIt = async () => {
    if (!file) return
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('files', file)
      fd.append('fileType', type)
      await api.post(`/shipping/shipments/${shipment.id}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      setFile(null)
      qc.invalidateQueries({ queryKey: ['ship-main'] })
    } catch (e: any) { toast.error(e.response?.data?.message || 'خطا در آپلود') }
    finally { setBusy(false) }
  }
  const del = useMutation({
    mutationFn: (fileId: string) => api.delete(`/shipping/shipments/files/${fileId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ship-main'] }),
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>📎 اسناد محموله (فاکتور حمل و مدارک)</div>
      {files.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
          {files.map((f) => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--brand)', background: 'var(--brand-soft, var(--brand-50))', borderRadius: 'var(--radius-sm)', padding: '1px 7px' }}>{SHIP_FILE_LABEL[f.fileType] || f.fileType}</span>
              <span className="code-text" style={{ flex: 1, wordBreak: 'break-all' }}>{f.storedName}</span>
              <a href={`${API_ORIGIN}${f.url}`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">دانلود</a>
              <button className="btn-danger btn-sm" onClick={async () => { if (await dialog.confirm({ title: 'حذف این سند؟', message: 'فایل از سرور هم پاک می‌شود و برگشت‌پذیر نیست.', confirmLabel: 'حذف', tone: 'danger' })) del.mutate(f.id) }}>✕</button>
            </div>
          ))}
        </div>
      ) : <div className="hint-sm" style={{ marginBottom: 8  }}>سندی بارگذاری نشده است.</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <select value={type} onChange={(e) => setType(e.target.value)} style={{ fontSize: 12, padding: '3px 6px' }}>
          {Object.entries(SHIP_FILE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ fontSize: 12 }} />
        <button className="btn-primary btn-sm" disabled={!file || busy} onClick={uploadIt}>{busy ? 'در حال آپلود...' : 'آپلود سند'}</button>
      </div>
    </div>
  )
}

function CreateShipmentModal({ packageIds, onClose, onSuccess }: any) {
  const [shippingCompanyId, setShippingCompanyId] = useState('')
  const [type, setType] = useState('SEA')
  const [forwarderRef, setForwarderRef] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const { data: companies = [] } = useQuery({ queryKey: ['shipping-companies'], queryFn: () => api.get('/settings/shipping-companies').then((r) => r.data) })
  const mut = useMutation({
    mutationFn: () => api.post('/shipping/shipments', { packageIds, shippingCompanyId, type, forwarderRef, notes }),
    onSuccess, onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>ایجاد محموله اصلی</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <p className="hint-lg" style={{ marginBottom: 12  }}>{packageIds.length} بسته انتخاب شده</p>
          <div className="form-group">
            <label>فورواردر *</label>
            <SearchableSelect value={shippingCompanyId} onChange={setShippingCompanyId} placeholder="انتخاب..."
              options={companies.map((c: any) => ({ value: c.id, label: c.name }))} />
          </div>
          <div className="form-group">
            <label>نوع حمل *</label>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="AIR">هوایی</option><option value="SEA">دریایی</option><option value="LAND">زمینی</option><option value="RAIL">ریلی</option>
            </select>
          </div>
          <div className="form-group"><label>کد مرجع فورواردر (بارنامه)</label><input value={forwarderRef} onChange={(e) => setForwarderRef(e.target.value)} /></div>
          <div className="form-group"><label>یادداشت</label><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="یادداشت دلخواه دربارهٔ این محموله" /></div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={!shippingCompanyId || mut.isPending} onClick={() => mut.mutate()}>ایجاد محموله</button>
        </div>
      </div>
    </div>
  )
}

// ─── STAGE 4: CUSTOMER DELIVERY ───────────────────────
function DeliveryTab() {
  const qc = useQueryClient()
  const [deliverProject, setDeliverProject] = useState<any>(null)
  const [filter, setFilter] = useState('active')
  const [expanded, setExpanded] = useState<string | null>(null)
  // backend فهرست تخت پروژه‌های آمادهٔ تحویل را برمی‌گرداند (بین‌المللی + ساخت‌داخل)
  const { data: projects = [] } = useQuery({ queryKey: ['ship-delivery'], queryFn: () => api.get('/shipping/delivery').then((r) => r.data) })

  const isDone = (proj: any) => proj.status === 'COMPLETED' || ((proj.parts?.length || 0) > 0 && proj.parts.every((pt: any) => pt.milestone === 'DELIVERED'))
  const active = projects.filter((p: any) => !isDone(p)).length
  const done = projects.filter(isDone).length
  const shown = projects.filter((p: any) => (filter === 'all' ? true : filter === 'done' ? isDone(p) : !isDone(p)))
  const sort = useSort('createdAt', 'desc')
  const rows = sort.apply(shown as any[], {
    project: (p) => p.code,
    customer: (p) => p.customer?.name,
    status: (p) => (isDone(p) ? 1 : 0),
    createdAt: (p) => p.createdAt,
    updatedAt: (p) => p.updatedAt,
  })

  return (
    <div>
      <SubFilter value={filter} onChange={setFilter} active={active} done={done} />
      <div className="table-container">
      <table className="data-table">
        <thead><tr>
          <th></th>
          <SortTH label="پروژه" k="project" sort={sort} />
          <SortTH label="مشتری" k="customer" sort={sort} />
          <SortTH label="وضعیت" k="status" sort={sort} />
          <SortTH label="تاریخ ایجاد" k="createdAt" sort={sort} />
          <SortTH label="آخرین رویداد" k="updatedAt" sort={sort} />
          <th>اقدام</th>
        </tr></thead>
        <tbody>
          {rows.map((proj: any) => {
            const allDelivered = isDone(proj)
            const deliveredCount = (proj.parts || []).filter((pt: any) => pt.milestone === 'DELIVERED').length
            return (
              <Fragment key={proj.id}>
                <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === proj.id ? null : proj.id)}>
                  <td style={{ width: 22, color: 'var(--text-muted)' }}>{expanded === proj.id ? '▼' : '◀'}</td>
                  <td className="code-text">{proj.code}</td>
                  <td>{proj.customer.name}</td>
                  <td>{allDelivered ? <span className="status-badge status-completed">تحویل شده</span> : <span className="status-badge status-in_progress">آماده تحویل</span>}</td>
                  <td className="nowrap">{faDate(proj.createdAt)}</td>
                  <td className="nowrap">{faDate(proj.updatedAt)}</td>
                  <td onClick={(e) => e.stopPropagation()}>{!allDelivered && <button className="btn-sm btn-primary" onClick={() => setDeliverProject(proj)}>ثبت تحویل کالا</button>}</td>
                </tr>
                {expanded === proj.id && (
                  <ExpandRow colSpan={7}>
                    <div style={{ fontSize: 12 }}>
                      <b>قطعات:</b> {deliveredCount} از {(proj.parts || []).length} قطعه تحویل‌شده — یادداشت‌ها و دلیل «ادامه با مسئولیت» پس از ثبت تحویل، در «ردپای مراحل» پروژه قابل‌مشاهده است.
                    </div>
                  </ExpandRow>
                )}
              </Fragment>
            )
          })}
          {rows.length === 0 && <TableEmpty colSpan={7}>موردی در این دسته نیست</TableEmpty>}
        </tbody>
      </table>
      </div>
      {deliverProject && <DeliveryModal project={deliverProject} onClose={() => setDeliverProject(null)} onSuccess={() => { setDeliverProject(null); qc.invalidateQueries({ queryKey: ['ship-delivery'] }) }} />}
    </div>
  )
}

function DeliveryModal({ project, onClose, onSuccess }: any) {
  const [packagingOk, setPackagingOk] = useState(false)
  const [packagingNotes, setPackagingNotes] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [error, setError] = useState('')

  // Check customer debt for this project
  const { data: debt } = useQuery({
    queryKey: ['project-debt', project.id],
    queryFn: () => api.get(`/accounting/project-balance/${project.id}`).then((r) => r.data).catch(() => null),
  })
  const hasDebt = debt && Number(debt.balance) > 0

  const mut = useMutation({
    mutationFn: () => api.post(`/shipping/delivery/${project.id}`, { packagingOk, notes: packagingNotes, overrideReason: hasDebt ? overrideReason : undefined }),
    onSuccess, onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>ثبت تحویل کالا — {project.code}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {hasDebt && (
            <div style={{ marginBottom: 16, padding: 12, background: 'var(--danger-soft)', border: '2px solid var(--danger)', borderRadius: 'var(--radius-sm)' }}>
              <strong style={{ color: 'var(--danger)' }}>⚠ هشدار!</strong>
              <p style={{ fontSize: 13, marginTop: 6 }}>مشتری {project.customer.name} مبلغ {Number(debt.balance).toLocaleString()} تومان برای این پروژه بدهکار است. تحویل کالا توصیه نمی‌شود.</p>
              {debt.customerTotalIRR !== undefined && (
                <p style={{ fontSize: 12, marginTop: 4, color: 'var(--text-muted)' }}>
                  مانده کل مشتری (همه پروژه‌ها): {Number(debt.customerTotalIRR).toLocaleString()} تومان
                  {Number(debt.customerTotalIRR) < Number(debt.balance) ? ' — بخشی از پرداخت‌ها بدون لینک پروژه ثبت شده است.' : ''}
                </p>
              )}
              <div className="form-group" style={{ marginTop: 8, marginBottom: 0 }}>
                <label>دلیل ادامه با مسئولیت خودتان *</label>
                <textarea rows={2} value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
              </div>
            </div>
          )}

          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={packagingOk} onChange={(e) => setPackagingOk(e.target.checked)} />
              تأیید می‌کنم بسته‌بندی مطابق الگوی سازمان انجام شده است
            </label>
          </div>
          <div className="form-group"><label>توضیحات بسته‌بندی (اختیاری)</label><textarea rows={2} value={packagingNotes} onChange={(e) => setPackagingNotes(e.target.value)} /></div>
          {/* ۶.۱۲ — همهٔ شرط‌های باقی‌ماندهٔ فعال‌شدن دکمه یکجا (تا کاربر بداند چرا «کار نمی‌کند») */}
          {(!packagingOk || (hasDebt && !overrideReason)) && (
            <div style={{ fontSize: 12, color: 'var(--warning)', background: 'var(--warning-soft)', border: '1px solid var(--warning-soft)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', marginTop: 6 }}>
              برای فعال‌شدن دکمهٔ «ثبت تحویل نهایی»:
              <ul style={{ margin: '4px 18px 0 0', padding: 0 }}>
                {!packagingOk && <li>تیک «تأیید بسته‌بندی مطابق الگو» را بزنید</li>}
                {hasDebt && !overrideReason && <li style={{ color: 'var(--danger)' }}>«دلیل ادامه با مسئولیت خودتان» را وارد کنید (مشتری {Number(debt?.balance || 0).toLocaleString()} تومان بدهکار است)</li>}
              </ul>
            </div>
          )}
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={!packagingOk || (hasDebt && !overrideReason) || mut.isPending} onClick={() => mut.mutate()}>ثبت تحویل نهایی</button>
        </div>
      </div>
    </div>
  )
}
