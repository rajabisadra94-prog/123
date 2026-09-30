import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { API_ORIGIN } from '../lib/api'
import { toShamsi } from '../lib/date'
import DateField from '../components/shared/DateField'
import SearchableSelect from '../components/shared/SearchableSelect'
import CommentThread from '../components/shared/CommentThread'
import { PageHeader, FilterToggle, ModalLoading, TableEmpty } from '../components/ui'
import { dialog, toast } from '../components/ui/dialog'

const COLUMNS = [
  { key: 'NEW', label: 'سفارش جدید', color: '#3b82f6' },
  { key: 'IN_PRODUCTION', label: 'در حال ساخت', color: '#f59e0b' },
  { key: 'QUALITY_CONTROL', label: 'کنترل کیفیت', color: '#8b5cf6' },
  { key: 'COMPLETED', label: 'تکمیل شده', color: '#22c55e' },
]
// مراحل سفارش خرید (فاز ۴) — «اتاق وضعیت چین»
const PURCHASE_COLUMNS = [
  { key: 'ORDERED', label: 'ثبت سفارش', color: '#3b82f6' },
  { key: 'DEPOSIT_PAID', label: 'بیعانه پرداخت‌شده', color: '#06b6d4' },
  { key: 'PREPARING', label: 'آماده‌سازی', color: '#f59e0b' },
  { key: 'SETTLED', label: 'تسویه قبل ارسال', color: '#eab308' },
  { key: 'SHIPPED', label: 'ارسال شد', color: '#8b5cf6' },
  { key: 'RECEIVED', label: 'دریافت (+بازرسی)', color: '#ec4899' },
  { key: 'READY', label: 'آمادهٔ حمل', color: '#22c55e' },
]
// مراحل بار فورواردینگ (فاز ۶)
const CARGO_COLUMNS = [
  { key: 'AWAITING_CHINA', label: 'در انتظار انبار چین', color: '#3b82f6' },
  { key: 'WAREHOUSE_CONFIRMED', label: 'تأییدیهٔ انبار چین', color: '#0ea5e9' },
  { key: 'RECEIVED_CHINA', label: 'رسید به انبار چین', color: '#06b6d4' },
  { key: 'IN_TRANSIT', label: 'در حال حمل', color: '#8b5cf6' },
  { key: 'ARRIVED', label: 'رسید به مقصد', color: '#ec4899' },
  { key: 'DELIVERED', label: 'تحویل مشتری', color: '#22c55e' },
]
const ROUTE_LABELS: Record<string, string> = { AIR: 'هوایی', SEA: 'دریایی', LAND: 'زمینی', RAIL: 'ریلی' }
const TRANSIT_LABELS: Record<string, string> = { DIRECT: 'مستقیم ایران', VIA_DUBAI: 'ترانزیت دبی' }
const FMODE_LABELS: Record<string, string> = { BY_WEIGHT: 'نرخ × وزن', BY_VOLUME: 'نرخ × حجم', FLAT: 'مقطوع' }
const INBOUND_LABELS: Record<string, string> = { CUSTOMER_SENDS: 'مشتری خودش بار را به انبار چین می‌فرستد', WE_ARRANGE: 'آدرس می‌دهد و ما ارسال به انبار چین را هماهنگ می‌کنیم' }
const FILE_HOST = API_ORIGIN

export default function OrdersPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [producerId, setProducerId] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [showPackaged, setShowPackaged] = useState(false)

  const { data: orders = [] } = useQuery({
    queryKey: ['orders', producerId],
    queryFn: () => api.get('/orders', { params: { producerId: producerId || undefined } }).then((r) => r.data),
  })
  const { data: producers = [] } = useQuery({ queryKey: ['producers'], queryFn: () => api.get('/settings/producers').then((r) => r.data) })
  const { data: cargos = [] } = useQuery({ queryKey: ['forwarding-cargos'], queryFn: () => api.get('/forwarding').then((r) => r.data) })
  const [openCargoId, setOpenCargoId] = useState<string | null>(null)
  const [showAddCargo, setShowAddCargo] = useState(false)

  const moveStatus = useMutation({
    mutationFn: ({ id, status }: any) => api.patch(`/orders/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  const filtered = orders.filter((o: any) => {
    if (!search) return true
    const s = search.toLowerCase()
    return o.code?.toLowerCase().includes(s) || o.project?.code?.toLowerCase().includes(s) || (o.producer?.name || o.supplier?.name || '').toLowerCase().includes(s)
  })
  // تفکیک سفارش‌ها بر اساس نوع: ساخت (PRODUCTION/legacy) و خرید (PURCHASE)
  const manufOrders = filtered.filter((o: any) => o.kind !== 'PURCHASE')
  const purchaseOrders = filtered.filter((o: any) => o.kind === 'PURCHASE')
  const manufCount = orders.filter((o: any) => o.kind !== 'PURCHASE').length
  const purchaseCount = orders.filter((o: any) => o.kind === 'PURCHASE').length

  function onDrop(colKey: string) {
    if (dragId) {
      const order = orders.find((o: any) => o.id === dragId)
      if (order && order.kind !== 'PURCHASE' && order.status !== colKey) moveStatus.mutate({ id: dragId, status: colKey })
    }
    setDragId(null)
  }

  const activeFilterCount = [search, producerId, showPackaged ? '1' : ''].filter(Boolean).length

  return (
    <div className="page" dir="rtl">
      <PageHeader title="سفارش‌ها" subtitle="اتاق وضعیت چین — ساخت، خرید و بار امانی در یک نگاه"
        filter={<FilterToggle open={showFilters} onToggle={() => setShowFilters((s) => !s)} count={activeFilterCount} />}
        chips={<>
          <span className="band-chip" style={{ cursor: 'default' }}>🏭 ساخت سفارشی <span className="n">{manufCount}</span></span>
          <span className="band-chip" style={{ cursor: 'default' }}>🛒 خرید کالا <span className="n">{purchaseCount}</span></span>
          <span className="band-chip" style={{ cursor: 'default' }}>📦 بار امانی <span className="n">{cargos.length}</span></span>
        </>} />

      {showFilters && <div className="filters-bar">
        <input className="search-input" placeholder="جستجو (کد سفارش، پروژه، فروشنده)..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <SearchableSelect style={{ maxWidth: 220 }} value={producerId} onChange={setProducerId} placeholder="همه سازندگان"
          options={producers.map((p: any) => ({ value: p.id, label: p.name }))} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={showPackaged} onChange={(e) => setShowPackaged(e.target.checked)} />
          نمایش سفارش‌های دارای بستهٔ حمل
        </label>
      </div>}

      {/* بخش ساخت */}
      <h2 style={{ fontSize: 16, margin: '8px 0', color: 'var(--brand)' }}>🏭 ساخت سفارشی</h2>
      <div className="kanban-board">
        {COLUMNS.map((col) => {
          const cards = manufOrders.filter((o: any) => {
            if (o.status !== col.key) return false
            // سفارش تکمیل‌شده‌ای که بستهٔ حمل داخلی دارد، به‌صورت پیش‌فرض از این ستون حذف می‌شود
            if (col.key === 'COMPLETED' && !showPackaged && (o._count?.domesticItems || 0) > 0) return false
            return true
          })
          return (
            <div key={col.key} className="kanban-column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(col.key)}>
              <div className="kanban-col-header" style={{ borderTopColor: col.color }}>
                <span>{col.label}</span>
                <span className="kanban-count">{cards.length}</span>
              </div>
              <div className="kanban-cards">
                {cards.map((order: any) => {
                  const overdue = order.estimatedEndDate && order.status === 'IN_PRODUCTION' && new Date(order.estimatedEndDate) < new Date()
                  return (
                    <div key={order.id} className="kanban-card"
                      draggable
                      onDragStart={() => setDragId(order.id)}
                      onClick={() => setOpenId(order.id)}
                      style={overdue ? { borderRight: '3px solid var(--danger)' } : { borderRight: `3px solid ${col.color}` }}>
                      <div className="card-code">{order.code}</div>
                      <div className="card-project">پروژه: {order.project.code} — {order.project.customer.name}</div>
                      <div className="card-producer">🏭 {order.producer?.name || '—'}</div>
                      {(order._count?.domesticItems || 0) > 0 && <div style={{ fontSize: 10, color: 'var(--success)', marginTop: 3 }}>📦 در بستهٔ حمل داخلی</div>}
                      {overdue && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>⚠ تأخیر در تولید</div>}
                    </div>
                  )
                })}
                {cards.length === 0 && <div className="hint" style={{ textAlign: 'center', padding: 12  }}>—</div>}
              </div>
            </div>
          )
        })}
      </div>
      <p className="hint" style={{ marginTop: 8, marginBottom: 20  }}>💡 کارت‌ها را بین ستون‌ها بکشید یا روی هر کارت کلیک کنید. این قابلیت برای سه ردیف ساخت، خرید و بار امانی کار می‌کند.</p>

      {/* بخش خرید کالا */}
      <PurchaseSection orders={purchaseOrders} showPackaged={showPackaged} onOpen={(pid: string) => setOpenId(pid)} />

      {/* بخش بار امانی (فورواردینگ) */}
      <ForwardingSection cargos={cargos} onOpen={(cid: string) => setOpenCargoId(cid)} onAdd={() => setShowAddCargo(true)} />

      {openId && <OrderRouter id={openId} orders={orders} onClose={() => setOpenId(null)} />}
      {openCargoId && <CargoModal id={openCargoId} onClose={() => setOpenCargoId(null)} />}
      {showAddCargo && <CreateCargoModal onClose={() => setShowAddCargo(false)} onCreated={(cid: string) => { setShowAddCargo(false); qc.invalidateQueries({ queryKey: ['forwarding-cargos'] }); setOpenCargoId(cid) }} />}
    </div>
  )
}

// ─── بخش «بار امانی» — کانبان ۵ مرحله‌ای فورواردینگ ───
function ForwardingSection({ cargos, onOpen, onAdd }: any) {
  const qc = useQueryClient()
  const [dragId, setDragId] = useState<string | null>(null)
  const move = useMutation({
    mutationFn: ({ id, stage }: any) => api.patch(`/forwarding/${id}/stage`, { stage }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['forwarding-cargos'] }); qc.invalidateQueries({ queryKey: ['cargo'] }) },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  async function onDrop(colKey: string) {
    const id = dragId
    setDragId(null)
    const cargo = cargos.find((c: any) => c.id === id)
    if (!cargo || (cargo.stage || 'AWAITING_CHINA') === colKey) return
    if (cargo.stage === 'DELIVERED') { toast.error('باری که تحویل مشتری شده قابل جابه‌جایی نیست'); return }
    if (colKey === 'DELIVERED' && !(await dialog.confirm({ title: 'ثبت تحویل نهایی به مشتری؟', message: `بار پروژهٔ ${cargo.project.code} به مشتری تحویل داده می‌شود و پروژه «تکمیل‌شده» می‌گردد.`, confirmLabel: 'ثبت تحویل' }))) return
    move.mutate({ id, stage: colKey })
  }
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '8px 0' }}>
        <h2 style={{ fontSize: 16, color: 'var(--brand)', margin: 0 }}>📦 بار امانی (فورواردینگ)</h2>
        <button className="btn-primary btn-sm" onClick={onAdd}>+ ثبت بار جدید</button>
      </div>
      <div className="kanban-board">
        {CARGO_COLUMNS.map((col) => {
          const cards = cargos.filter((c: any) => (c.stage || 'AWAITING_CHINA') === col.key)
          return (
            <div key={col.key} className="kanban-column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(col.key)}>
              <div className="kanban-col-header" style={{ borderTopColor: col.color }}>
                <span>{col.label}</span>
                <span className="kanban-count">{cards.length}</span>
              </div>
              <div className="kanban-cards">
                {cards.map((c: any) => (
                  <div key={c.id} className="kanban-card" draggable onDragStart={() => setDragId(c.id)} onClick={() => onOpen(c.id)} style={{ borderRight: `3px solid ${col.color}` }}>
                    <div className="card-code">{c.project.code}</div>
                    <div className="card-project">{c.project.customer.name}</div>
                    <div className="card-producer">📦 {c.weightKg ? `${Number(c.weightKg)} kg` : '—'}{c.route ? ` · ${ROUTE_LABELS[c.route] || c.route}` : ''}</div>
                    {c.quoteConfirmedAt && <div style={{ fontSize: 10, color: 'var(--success)', marginTop: 3 }}>✅ کرایه ثبت شد</div>}
                    {c.shipment && <div style={{ fontSize: 10, color: 'var(--success)', marginTop: 3 }}>🚢 {c.shipment.code}</div>}
                  </div>
                ))}
                {cards.length === 0 && <div className="hint" style={{ textAlign: 'center', padding: 12  }}>—</div>}
              </div>
            </div>
          )
        })}
      </div>
      {cargos.length === 0 && <p className="hint-lg" style={{ marginTop: 8  }}>هنوز باری ثبت نشده. برای پروژهٔ نوع «فورواردینگ» با دکمهٔ «ثبت بار جدید» بار را تعریف کنید.</p>}
    </>
  )
}

// نمایش مودال درست بر اساس نوع سفارش
function OrderRouter({ id, orders, onClose }: any) {
  const order = orders.find((o: any) => o.id === id)
  if (order?.kind === 'PURCHASE') return <PurchaseOrderModal id={id} onClose={onClose} />
  return <OrderDetailModal id={id} onClose={onClose} />
}

// ─── بخش «خرید کالا» — کانبان ۷ مرحله‌ای ───
function PurchaseSection({ orders, showPackaged, onOpen }: any) {
  const qc = useQueryClient()
  const [dragId, setDragId] = useState<string | null>(null)
  const move = useMutation({
    mutationFn: ({ id, stage }: any) => api.patch(`/orders/${id}/purchase-stage`, { stage }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  function onDrop(colKey: string) {
    const id = dragId
    setDragId(null)
    const order = orders.find((o: any) => o.id === id)
    if (!order || (order.purchaseStage || 'ORDERED') === colKey) return
    // مراحل پرداخت باید با ثبت پرداخت انجام شوند تا حسابداری ثبت شود
    if (colKey === 'DEPOSIT_PAID' || colKey === 'SETTLED') {
      toast.error(colKey === 'DEPOSIT_PAID' ? 'برای این مرحله، پرداخت بیعانه را در کارت ثبت کنید' : 'برای این مرحله، پرداخت تسویه را در کارت ثبت کنید')
      onOpen(order.id)
      return
    }
    move.mutate({ id, stage: colKey })
  }
  return (
    <>
      <h2 style={{ fontSize: 16, margin: '8px 0', color: 'var(--brand)' }}>🛒 خرید کالا (اتاق وضعیت چین)</h2>
      <div className="kanban-board">
        {PURCHASE_COLUMNS.map((col) => {
          const cards = orders.filter((o: any) => {
            const stage = o.purchaseStage || 'ORDERED'
            if (stage !== col.key) return false
            if (col.key === 'READY' && !showPackaged && (o._count?.domesticItems || 0) > 0) return false
            return true
          })
          return (
            <div key={col.key} className="kanban-column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(col.key)}>
              <div className="kanban-col-header" style={{ borderTopColor: col.color }}>
                <span>{col.label}</span>
                <span className="kanban-count">{cards.length}</span>
              </div>
              <div className="kanban-cards">
                {cards.map((order: any) => (
                  <div key={order.id} className="kanban-card" draggable onDragStart={() => setDragId(order.id)} onClick={() => onOpen(order.id)}
                    style={{ borderRight: `3px solid ${col.color}` }}>
                    <div className="card-code">{order.code}</div>
                    <div className="card-project">پروژه: {order.project.code} — {order.project.customer.name}</div>
                    <div className="card-producer">🛒 {order.supplier?.name || '—'}</div>
                    {order.inspectionStatus === 'PASSED' && <div style={{ fontSize: 10, color: 'var(--success)', marginTop: 3 }}>✅ بازرسی تأیید</div>}
                    {order.inspectionStatus === 'SKIPPED' && <div className="hint-sm" style={{ marginTop: 3  }}>⏭ بازرسی رد شد</div>}
                    {(order._count?.domesticItems || 0) > 0 && <div style={{ fontSize: 10, color: 'var(--success)', marginTop: 3 }}>📦 در بستهٔ حمل</div>}
                  </div>
                ))}
                {cards.length === 0 && <div className="hint" style={{ textAlign: 'center', padding: 12  }}>—</div>}
              </div>
            </div>
          )
        })}
      </div>
      {orders.length === 0 && <p className="hint-lg" style={{ marginTop: 8  }}>هنوز سفارش خریدی ثبت نشده. با نهایی‌سازی قیمت‌گیریِ پروژهٔ «خرید کالا»، سفارش‌های خرید خودکار اینجا می‌آیند.</p>}
    </>
  )
}

// ─── WINDOW G: ORDER DETAIL ───────────────────────────
function OrderDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: order } = useQuery({ queryKey: ['order', id], queryFn: () => api.get(`/orders/${id}`).then((r) => r.data) })
  const [tab, setTab] = useState('info')

  const refresh = () => { qc.invalidateQueries({ queryKey: ['order', id] }); qc.invalidateQueries({ queryKey: ['orders'] }) }

  const updateStatus = useMutation({
    mutationFn: (body: any) => api.patch(`/orders/${id}/status`, body),
    onSuccess: refresh,
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  if (!order) return <ModalLoading />

  const statusIdx = COLUMNS.findIndex((c) => c.key === order.status)
  const nextCol = COLUMNS[statusIdx + 1]

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <h2>{order.code} — {order.producer?.name || order.supplier?.name || ''}</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12, fontSize: 13 }}>
            <span>پروژه: <strong>{order.project.code}</strong> ({order.project.customer.name})</span>
            <span className="status-badge" style={{ background: COLUMNS[statusIdx]?.color, color: 'var(--surface)' }}>{COLUMNS[statusIdx]?.label}</span>
          </div>

          <h3 style={{ fontSize: 13, marginBottom: 6 }}>قطعات این سفارش</h3>
          <table className="data-table" style={{ marginBottom: 16 }}>
            <thead><tr><th>قطعه</th><th>تعداد</th><th>وزن (گرم)</th></tr></thead>
            <tbody>
              {order.parts.map((p: any) => (
                <tr key={p.id}><td>{p.name}</td><td>{p.quantity}</td><td>{p.weightGrams || '-'}</td></tr>
              ))}
              {order.parts.length === 0 && <TableEmpty colSpan={3}>—</TableEmpty>}
            </tbody>
          </table>

          <div className="settings-tabs">
            <button className={`tab-btn ${tab === 'info' ? 'active' : ''}`} onClick={() => setTab('info')}>اطلاعات</button>
            <button className={`tab-btn ${tab === 'production' ? 'active' : ''}`} onClick={() => setTab('production')}>در حال ساخت</button>
            <button className={`tab-btn ${tab === 'qc' ? 'active' : ''}`} onClick={() => setTab('qc')}>کنترل کیفیت</button>
            <button className={`tab-btn ${tab === 'done' ? 'active' : ''}`} onClick={() => setTab('done')}>تکمیل شده</button>
          </div>

          {tab === 'info' && (
            <div>
              <p style={{ fontSize: 13, marginBottom: 6 }}>تاریخ ایجاد: {toShamsi(order.createdAt)}</p>
              {order.notes && <p style={{ fontSize: 13 }}>یادداشت: {order.notes}</p>}
            </div>
          )}
          {tab === 'production' && (
            <ProductionTab order={order} onUpdate={updateStatus.mutate} onUploaded={refresh} />
          )}
          {tab === 'qc' && (
            <FileTab orderId={id} fileType="QC_REPORT" label="گزارش کنترل کیفیت" files={order.orderFiles.filter((f: any) => f.fileType === 'QC_REPORT')} onUploaded={refresh} />
          )}
          {tab === 'done' && (
            <CompletedTab order={order} onUpdate={updateStatus.mutate} onUploaded={refresh} />
          )}

          {/* ۵.۱ — گفتگوی حین ساخت: همیشه‌باز، زیر تب‌ها (نه تب مخفی) */}
          <div style={{ marginTop: 18, borderTop: '2px solid var(--border)', paddingTop: 14 }}>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>💬 گفتگوی حین ساخت</h3>
            {order.reminderTasks?.length ? (
              <>
                <p className="hint" style={{ marginBottom: 10  }}>گفتگوها، تغییرات و تصمیمات حین تولید را همین‌جا ثبت کنید — همیشه در دسترس، مستقل از تب فعال.</p>
                <CommentThread base={`/comments/task/${order.reminderTasks[0].id}`} queryKey={['order-task-comments', order.reminderTasks[0].id]} />
              </>
            ) : <OrderDiscussionStarter orderId={id} onStarted={refresh} />}
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">بستن</button>
          {nextCol && (
            <button className="btn-primary" onClick={() => updateStatus.mutate({ status: nextCol.key })}>
              انتقال به «{nextCol.label}» ←
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ۵.۱ — برای سفارش‌های قدیمی بدون وظیفهٔ حین ساخت، ایجاد on-demand گفتگو
function OrderDiscussionStarter({ orderId, onStarted }: { orderId: string; onStarted: () => void }) {
  const mut = useMutation({ mutationFn: () => api.post(`/orders/${orderId}/discussion`), onSuccess: onStarted })
  return (
    <div>
      <p className="hint-lg" style={{ marginBottom: 8  }}>برای این سفارش هنوز گفتگوی حین ساخت ایجاد نشده (سفارش قدیمی). با یک کلیک فعالش کنید:</p>
      <button className="btn-primary btn-sm" disabled={mut.isPending} onClick={() => mut.mutate()}>💬 شروع گفتگوی حین ساخت</button>
    </div>
  )
}

function ProductionTab({ order, onUpdate, onUploaded }: any) {
  const [estimatedEndDate, setEstimatedEndDate] = useState(order.estimatedEndDate ? order.estimatedEndDate.slice(0, 10) : '')
  const [notes, setNotes] = useState(order.notes || '')
  return (
    <div>
      <p className="hint" style={{ marginBottom: 10  }}>
        تاریخ شروع تولید: {order.startDate ? toShamsi(order.startDate) : 'هنوز شروع نشده (با انتقال به «در حال ساخت» ثبت می‌شود)'}
      </p>
      <div className="form-group"><label>تاریخ تخمینی اتمام</label><DateField value={estimatedEndDate} onChange={setEstimatedEndDate} /></div>
      <div className="form-group"><label>یادداشت‌ها</label><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <button className="btn-secondary btn-sm" onClick={() => onUpdate({ status: 'IN_PRODUCTION', estimatedEndDate: estimatedEndDate || undefined, notes })}>ذخیره اطلاعات تولید</button>
      <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <FileTab orderId={order.id} fileType="PRODUCTION_PHOTO" label="تصاویر در حال ساخت محصول (یک یا چند تصویر)"
          files={order.orderFiles.filter((f: any) => f.fileType === 'PRODUCTION_PHOTO')} onUploaded={onUploaded} />
      </div>
    </div>
  )
}

function CompletedTab({ order, onUpdate, onUploaded }: any) {
  const [finalWeightGrams, setFinalWeightGrams] = useState(order.finalWeightGrams || '')
  const [packagingDetails, setPackagingDetails] = useState(order.packagingDetails || '')
  return (
    <div>
      <div className="form-group"><label>وزن دقیق نهایی (گرم)</label><input type="number" value={finalWeightGrams} onChange={(e) => setFinalWeightGrams(e.target.value)} /></div>
      <div className="form-group"><label>جزئیات بسته‌بندی</label><textarea rows={2} value={packagingDetails} onChange={(e) => setPackagingDetails(e.target.value)} /></div>
      <button className="btn-secondary btn-sm" style={{ marginBottom: 16 }} onClick={() => onUpdate({ status: 'COMPLETED', finalWeightGrams: finalWeightGrams || undefined, packagingDetails })}>ذخیره اطلاعات تکمیل</button>
      <FileTab orderId={order.id} fileType="PACKING_LIST" label="پکینگ لیست و تصاویر نهایی" files={order.orderFiles.filter((f: any) => f.fileType === 'PACKING_LIST')} onUploaded={onUploaded} />
    </div>
  )
}

function FileTab({ orderId, fileType, label, files, onUploaded }: any) {
  const [selected, setSelected] = useState<FileList | null>(null)
  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      if (selected) Array.from(selected).forEach((f) => fd.append('files', f))
      fd.append('fileType', fileType)
      return api.post(`/orders/${orderId}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    },
    onSuccess: () => { setSelected(null); onUploaded() },
  })
  const isImage = (u: string) => /\.(png|jpe?g|gif|webp)$/i.test(u)
  return (
    <div>
      <h3 style={{ fontSize: 13, marginBottom: 8 }}>{label}</h3>
      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {files.map((f: any) => (
            isImage(f.url)
              ? <a key={f.id} href={`${FILE_HOST}${f.url}`} target="_blank" rel="noreferrer" title={f.storedName}><img src={`${FILE_HOST}${f.url}`} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }} /></a>
              : <a key={f.id} href={`${FILE_HOST}${f.url}`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">{(f.storedName || 'دانلود').slice(0, 22)}</a>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="file" multiple accept="image/*,.pdf" onChange={(e) => setSelected(e.target.files)} />
        <button className="btn-primary btn-sm" disabled={!selected?.length || upload.isPending} onClick={() => upload.mutate()}>آپلود {selected?.length ? `(${selected.length})` : ''}</button>
      </div>
    </div>
  )
}

// ─── مودال سفارش خرید (فاز ۴): مراحل + پرداخت بیعانه/تسویه + بازرسی ───
function PurchaseOrderModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: order } = useQuery({ queryKey: ['order', id], queryFn: () => api.get(`/orders/${id}`).then((r) => r.data) })
  const { data: accounts = [] } = useQuery({ queryKey: ['company-accounts'], queryFn: () => api.get('/accounting/accounts').then((r) => r.data) })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['order', id] }); qc.invalidateQueries({ queryKey: ['orders'] }) }

  const advance = useMutation({
    mutationFn: (body: any) => api.patch(`/orders/${id}/purchase-stage`, body),
    onSuccess: refresh,
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const pay = useMutation({
    mutationFn: (body: any) => api.post(`/orders/${id}/purchase-payment`, body),
    onSuccess: refresh,
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا در ثبت پرداخت'),
  })

  const [payKind, setPayKind] = useState<'DEPOSIT' | 'SETTLEMENT'>('DEPOSIT')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [fromAccountId, setFromAccountId] = useState('')

  if (!order) return <ModalLoading />

  const stage = order.purchaseStage || 'ORDERED'
  const stageIdx = PURCHASE_COLUMNS.findIndex((c) => c.key === stage)
  const nextCol = PURCHASE_COLUMNS[stageIdx + 1]

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 680 }}>
        <div className="modal-header">
          <h2>🛒 {order.code} — {order.supplier?.name || ''}</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 13, marginBottom: 12 }}>پروژه: <strong>{order.project.code}</strong> ({order.project.customer.name})</div>

          {/* استپر مراحل */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 16 }}>
            {PURCHASE_COLUMNS.map((c, i) => (
              <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 100,
                  background: i <= stageIdx ? c.color : 'var(--border)', color: i <= stageIdx ? 'var(--surface)' : 'var(--text-muted)' }}>
                  {i < stageIdx ? '✓ ' : ''}{c.label}
                </span>
                {i < PURCHASE_COLUMNS.length - 1 && <span className="muted">‹</span>}
              </div>
            ))}
          </div>

          {/* قطعات */}
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>کالاهای این سفارش</h3>
          <table className="data-table" style={{ marginBottom: 16 }}>
            <thead><tr><th>کالا</th><th>تعداد</th><th>وزن (گرم)</th></tr></thead>
            <tbody>
              {order.parts.map((p: any) => <tr key={p.id}><td>{p.name}</td><td>{p.quantity}</td><td>{p.weightGrams || '-'}</td></tr>)}
              {order.parts.length === 0 && <TableEmpty colSpan={3}>—</TableEmpty>}
            </tbody>
          </table>

          {/* پرداخت بیعانه/تسویه */}
          <div style={{ padding: 12, background: 'var(--bg, var(--surface-2))', borderRadius: 'var(--radius-sm)', marginBottom: 14 }}>
            <h3 style={{ fontSize: 13, marginBottom: 8 }}>💳 پرداخت به تامین‌کننده</h3>
            <div className="grid-2" style={{ gap: 8 }}>
              <div className="form-group">
                <label>نوع پرداخت</label>
                <select value={payKind} onChange={(e) => setPayKind(e.target.value as any)}>
                  <option value="DEPOSIT">بیعانه</option>
                  <option value="SETTLEMENT">تسویه قبل ارسال</option>
                </select>
              </div>
              <div className="form-group">
                <label>حساب پرداخت‌کننده (شرکت)</label>
                <SearchableSelect value={fromAccountId} onChange={setFromAccountId} placeholder="انتخاب حساب..."
                  options={accounts.map((a: any) => ({ value: a.id, label: `${a.name}` }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div className="form-group" style={{ flex: 1 }}>
                <label>مبلغ</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input type="number" style={{ flex: 1 }} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="مبلغ" />
                  <select style={{ width: 90 }} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                    <option value="USD">دلار</option><option value="CNY">یوآن</option><option value="IRR">تومان</option>
                  </select>
                </div>
              </div>
              <button className="btn-primary btn-sm" style={{ marginBottom: 12 }} disabled={!amount || !fromAccountId || pay.isPending}
                onClick={() => { pay.mutate({ amount: Number(amount), currency, fromAccountId, kind: payKind }); setAmount('') }}>ثبت پرداخت</button>
            </div>
            <p className="hint-sm">پرداخت، بدهی به تامین‌کننده را کم می‌کند و مرحله را (بیعانه/تسویه) جلو می‌برد.</p>
          </div>

          {/* بازرسی در مرحلهٔ دریافت */}
          {stage === 'RECEIVED' && (
            <div style={{ padding: 12, background: '#fdf2f8', borderRadius: 'var(--radius-sm)', marginBottom: 14 }}>
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>🔍 بازرسی دریافت (اختیاری)</h3>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 13 }}>وضعیت فعلی: <strong>{order.inspectionStatus === 'PASSED' ? '✅ تأیید شد' : order.inspectionStatus === 'SKIPPED' ? '⏭ رد شد' : '⏳ در انتظار'}</strong></span>
                <button className="btn-secondary btn-sm" onClick={() => advance.mutate({ inspectionStatus: 'PASSED' })}>✅ تأیید بازرسی</button>
                <button className="btn-secondary btn-sm" onClick={() => advance.mutate({ inspectionStatus: 'SKIPPED' })}>⏭ رد بازرسی</button>
              </div>
            </div>
          )}

          {/* گفتگوی حین خرید */}
          <div style={{ marginTop: 8, borderTop: '2px solid var(--border)', paddingTop: 14 }}>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>💬 گفتگوی حین خرید</h3>
            {order.reminderTasks?.length
              ? <CommentThread base={`/comments/task/${order.reminderTasks[0].id}`} queryKey={['order-task-comments', order.reminderTasks[0].id]} />
              : <OrderDiscussionStarter orderId={id} onStarted={refresh} />}
          </div>
        </div>
        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <button onClick={onClose} className="btn-secondary">بستن</button>
          {nextCol && (
            <button className="btn-primary" disabled={advance.isPending} onClick={() => advance.mutate({ stage: nextCol.key })}>
              انتقال به «{nextCol.label}» ←
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── ثبت بار فورواردینگ برای یک پروژهٔ FORWARDING ───
function CreateCargoModal({ onClose, onCreated }: any) {
  const { data: projects = [] } = useQuery({ queryKey: ['forwarding-pending'], queryFn: () => api.get('/forwarding/pending-projects').then((r) => r.data) })
  const [projectId, setProjectId] = useState('')
  const [err, setErr] = useState('')
  const create = useMutation({
    mutationFn: () => api.post('/forwarding', { projectId }).then((r) => r.data),
    onSuccess: (c: any) => onCreated(c.id),
    onError: (e: any) => setErr(e.response?.data?.message || 'خطا'),
  })
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>ثبت بار فورواردینگ</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-group">
            <label>پروژهٔ فورواردینگ *</label>
            <SearchableSelect value={projectId} onChange={setProjectId} placeholder="انتخاب پروژه..."
              options={projects.map((p: any) => ({ value: p.id, label: `${p.code} — ${p.customer.name}` }))} />
            {projects.length === 0 && <p className="hint" style={{ marginTop: 6  }}>پروژهٔ فورواردینگِ بدون بار موجود نیست. ابتدا در «پروژه‌ها» یک پروژهٔ نوع «حمل بار (فورواردینگ)» بسازید.</p>}
          </div>
          {err && <div className="error-msg">{err}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={!projectId || create.isPending} onClick={() => create.mutate()}>ایجاد و ادامه</button>
        </div>
      </div>
    </div>
  )
}

// ─── مودال بار فورواردینگ: مشخصات + کرایه + مراحل + اتصال محموله ───
function CargoModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: cargo } = useQuery({ queryKey: ['cargo', id], queryFn: () => api.get(`/forwarding/${id}`).then((r) => r.data) })
  const { data: shipments = [] } = useQuery({ queryKey: ['shipments-for-cargo'], queryFn: () => api.get('/shipping/shipments').then((r) => r.data) })
  const refresh = () => { qc.invalidateQueries({ queryKey: ['cargo', id] }); qc.invalidateQueries({ queryKey: ['forwarding-cargos'] }) }

  const [f, setF] = useState<any>(null)
  const [attachShip, setAttachShip] = useState('')
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }))

  useEffect(() => {
    if (!cargo) return
    setF({
      weightKg: cargo.weightKg ?? '', volumeCbm: cargo.volumeCbm ?? '', packagesCount: cargo.packagesCount ?? '',
      senderName: cargo.senderName ?? '', senderContact: cargo.senderContact ?? '', goodsDescription: cargo.goodsDescription ?? '',
      declaredValue: cargo.declaredValue ?? '', declaredCurrency: cargo.declaredCurrency ?? 'USD', route: cargo.route ?? '', transit: cargo.transit ?? '',
      freightMode: cargo.freightMode ?? '', freightRate: cargo.freightRate ?? '', flatAmount: cargo.flatAmount ?? '', quoteCurrency: cargo.quoteCurrency ?? 'USD', notes: cargo.notes ?? '',
      targetAmount: cargo.targetAmount ?? '', targetCurrency: cargo.targetCurrency ?? 'USD', desiredArrivalDate: cargo.desiredArrivalDate ? String(cargo.desiredArrivalDate).slice(0, 10) : '',
      inboundMode: cargo.inboundMode ?? '', pickupAddress: cargo.pickupAddress ?? '',
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cargo?.id, cargo?.updatedAt])

  const save = useMutation({ mutationFn: () => api.patch(`/forwarding/${id}`, f), onSuccess: refresh, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })
  const confirmQuote = useMutation({ mutationFn: () => api.post(`/forwarding/${id}/confirm-quote`), onSuccess: refresh, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })
  const advanceStage = useMutation({ mutationFn: (stage: string) => api.patch(`/forwarding/${id}/stage`, { stage }), onSuccess: refresh, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })
  const sendInfo = useMutation({ mutationFn: async () => { await api.patch(`/forwarding/${id}`, f); await api.post(`/forwarding/${id}/send-warehouse-info`) }, onSuccess: refresh, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })
  const warehouseConfirm = useMutation({ mutationFn: () => api.post(`/forwarding/${id}/warehouse-confirm`), onSuccess: refresh, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })
  const uploadPhoto = useMutation({
    mutationFn: async (file: File) => { const fd = new FormData(); fd.append('files', file); fd.append('fileType', 'GOODS_PHOTO'); await api.post(`/forwarding/${id}/files`, fd) },
    onSuccess: refresh, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا در بارگذاری عکس'),
  })
  const { data: accounts = [] } = useQuery({ queryKey: ['company-accounts'], queryFn: () => api.get('/accounting/accounts').then((r) => r.data) })
  const [payAmount, setPayAmount] = useState('')
  const [payCurrency, setPayCurrency] = useState('USD')
  const [payAccount, setPayAccount] = useState('')
  const pay = useMutation({
    mutationFn: (kind: string) => api.post(`/forwarding/${id}/payment`, { kind, amount: Number(payAmount), currency: payCurrency, fromAccountId: payAccount }),
    onSuccess: () => { setPayAmount(''); refresh() }, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const attach = useMutation({ mutationFn: () => api.post(`/forwarding/${id}/attach-shipment`, { shipmentId: attachShip }), onSuccess: refresh, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })

  if (!cargo) return <ModalLoading />
  const c = f ?? cargo
  const stageIdx = CARGO_COLUMNS.findIndex((s) => s.key === (cargo.stage || 'AWAITING_CHINA'))
  const nextStage = CARGO_COLUMNS[stageIdx + 1]
  const confirmed = !!cargo.quoteConfirmedAt

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 720 }}>
        <div className="modal-header">
          <h2>📦 بار {cargo.project.code} — {cargo.project.customer.name}</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* استپر مراحل */}
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 14 }}>
            {CARGO_COLUMNS.map((s, i) => (
              <span key={s.key} style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 100, background: i <= stageIdx ? s.color : 'var(--border)', color: i <= stageIdx ? 'var(--surface)' : 'var(--text-muted)' }}>
                {i < stageIdx ? '✓ ' : ''}{s.label}
              </span>
            ))}
          </div>

          {f && (
          <>
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>ثبت سفارش و هدف مشتری</h3>
          <div className="grid-2" style={{ gap: 8 }}>
            <div className="form-group"><label>هدف قیمت مشتری (کرایه)</label><div style={{ display: 'flex', gap: 6 }}><input type="number" style={{ flex: 1 }} value={c.targetAmount} onChange={(e) => set('targetAmount', e.target.value)} /><select style={{ width: 80 }} value={c.targetCurrency} onChange={(e) => set('targetCurrency', e.target.value)}><option value="USD">دلار</option><option value="CNY">یوآن</option><option value="IRR">تومان</option></select></div></div>
            <div className="form-group"><label>زمان مورد نظر مشتری برای رسیدن</label><DateField value={c.desiredArrivalDate} onChange={(v) => set('desiredArrivalDate', v)} /></div>
          </div>
          <div className="form-group">
            <label>عکس محصول</label>
            <input type="file" accept=".png,.jpg,.jpeg,.webp" disabled={uploadPhoto.isPending} onChange={(e) => { const file = e.target.files?.[0]; if (file) uploadPhoto.mutate(file); e.target.value = '' }} />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {(cargo.files || []).filter((x: any) => x.fileType === 'GOODS_PHOTO').map((x: any) => (
                <a key={x.id} href={`${FILE_HOST}${x.url}`} target="_blank" rel="noreferrer"><img src={`${FILE_HOST}${x.url}`} alt="عکس محصول" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--border)' }} /></a>
              ))}
            </div>
          </div>

          <h3 style={{ fontSize: 13, marginBottom: 6 }}>مشخصات بار</h3>
          <div className="grid-2" style={{ gap: 8 }}>
            <div className="form-group"><label>وزن (kg)</label><input type="number" value={c.weightKg} onChange={(e) => set('weightKg', e.target.value)} /></div>
            <div className="form-group"><label>حجم (CBM)</label><input type="number" value={c.volumeCbm} onChange={(e) => set('volumeCbm', e.target.value)} /></div>
            <div className="form-group"><label>تعداد نگله</label><input type="number" value={c.packagesCount} onChange={(e) => set('packagesCount', e.target.value)} /></div>
            <div className="form-group"><label>مسیر</label><select value={c.route} onChange={(e) => set('route', e.target.value)}><option value="">—</option>{Object.entries(ROUTE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="form-group"><label>ترانزیت</label><select value={c.transit} onChange={(e) => set('transit', e.target.value)}><option value="">—</option>{Object.entries(TRANSIT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="form-group"><label>فرستنده (چین)</label><input value={c.senderName} onChange={(e) => set('senderName', e.target.value)} /></div>
            <div className="form-group"><label>تماس فرستنده</label><input value={c.senderContact} onChange={(e) => set('senderContact', e.target.value)} /></div>
            <div className="form-group"><label>ارزش اظهاری</label><div style={{ display: 'flex', gap: 6 }}><input type="number" style={{ flex: 1 }} value={c.declaredValue} onChange={(e) => set('declaredValue', e.target.value)} /><select style={{ width: 80 }} value={c.declaredCurrency} onChange={(e) => set('declaredCurrency', e.target.value)}><option value="USD">دلار</option><option value="CNY">یوآن</option><option value="IRR">تومان</option></select></div></div>
          </div>
          <div className="form-group"><label>شرح کالا</label><textarea rows={2} value={c.goodsDescription} onChange={(e) => set('goodsDescription', e.target.value)} /></div>

          <h3 style={{ fontSize: 13, margin: '10px 0 6px' }}>کرایهٔ فورواردینگ</h3>
          <div className="grid-2" style={{ gap: 8 }}>
            <div className="form-group"><label>روش محاسبه</label><select disabled={confirmed} value={c.freightMode} onChange={(e) => set('freightMode', e.target.value)}><option value="">—</option>{Object.entries(FMODE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
            <div className="form-group"><label>ارز کرایه</label><select disabled={confirmed} value={c.quoteCurrency} onChange={(e) => set('quoteCurrency', e.target.value)}><option value="USD">دلار</option><option value="CNY">یوآن</option><option value="IRR">تومان</option></select></div>
            {c.freightMode !== 'FLAT' && c.freightMode && <div className="form-group"><label>نرخ (به‌ازای {c.freightMode === 'BY_VOLUME' ? 'CBM' : 'kg'})</label><input type="number" disabled={confirmed} value={c.freightRate} onChange={(e) => set('freightRate', e.target.value)} /></div>}
            {c.freightMode === 'FLAT' && <div className="form-group"><label>مبلغ مقطوع</label><input type="number" disabled={confirmed} value={c.flatAmount} onChange={(e) => set('flatAmount', e.target.value)} /></div>}
          </div>
          <p style={{ fontSize: 13 }}>کرایهٔ محاسبه‌شده: <strong>{cargo.quotedAmount ? `${Number(cargo.quotedAmount).toLocaleString()} ${c.quoteCurrency}` : '—'}</strong> {confirmed && <span style={{ color: 'var(--success)' }}>✅ ثبت‌شده در حسابداری</span>}</p>

          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="btn-secondary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>💾 ذخیره مشخصات</button>
            {!confirmed && <button className="btn-primary btn-sm" disabled={confirmQuote.isPending} onClick={async () => { if (await dialog.confirm({ title: 'کرایه تأیید و ثبت شود؟', message: 'به‌عنوان درآمد فورواردینگ در حسابداری ثبت می‌شود و به‌صورت طلب از مشتری منظور می‌گردد.', confirmLabel: 'تأیید و ثبت' })) confirmQuote.mutate() }}>✅ تأیید و ثبت کرایه (درآمد)</button>}
          </div>

          {/* انبار چین */}
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <h3 style={{ fontSize: 13, marginBottom: 6 }}>انبار چین</h3>
            <div className="form-group">
              <label>نحوهٔ رسیدن بار به انبار چین</label>
              <select value={c.inboundMode} disabled={!!cargo.warehouseInfoSentAt} onChange={(e) => set('inboundMode', e.target.value)}>
                <option value="">—</option>
                {Object.entries(INBOUND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            {c.inboundMode === 'WE_ARRANGE' && <div className="form-group"><label>آدرس تحویل بار در چین</label><textarea rows={2} disabled={!!cargo.warehouseInfoSentAt} value={c.pickupAddress} onChange={(e) => set('pickupAddress', e.target.value)} /></div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {cargo.warehouseInfoSentAt
                ? <span style={{ fontSize: 13, color: 'var(--success)' }}>✅ اطلاعات مشتری برای انبار چین ارسال شد ({toShamsi(cargo.warehouseInfoSentAt)})</span>
                : <button className="btn-secondary btn-sm" disabled={!c.inboundMode || sendInfo.isPending} onClick={() => sendInfo.mutate()}>📨 ارسال اطلاعات مشتری به انبار چین</button>}
              {cargo.warehouseInfoSentAt && (cargo.warehouseConfirmedAt
                ? <span style={{ fontSize: 13, color: 'var(--success)' }}>✅ تأییدیهٔ انبار چین ثبت شد ({toShamsi(cargo.warehouseConfirmedAt)})</span>
                : <button className="btn-primary btn-sm" disabled={warehouseConfirm.isPending} onClick={() => warehouseConfirm.mutate()}>✅ ثبت تأییدیهٔ انبار چین</button>)}
            </div>
          </div>

          {/* پرداخت‌های مشتری */}
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <h3 style={{ fontSize: 13, marginBottom: 6 }}>پرداخت‌های مشتری</h3>
            <p style={{ fontSize: 13 }}>
              پیش‌پرداخت: {cargo.prepaymentReceivedAt ? <span style={{ color: 'var(--success)' }}>✅ {Number(cargo.prepaymentAmount).toLocaleString()} {cargo.prepaymentCurrency} ({toShamsi(cargo.prepaymentReceivedAt)})</span> : <span className="hint">هنوز دریافت نشده</span>}
              {' • '}تکمیل وجه: {cargo.fullPaymentReceivedAt ? <span style={{ color: 'var(--success)' }}>✅ ثبت شد ({toShamsi(cargo.fullPaymentReceivedAt)})</span> : <span className="hint">هنوز دریافت نشده</span>}
            </p>
            {(!cargo.prepaymentReceivedAt || (!cargo.fullPaymentReceivedAt && cargo.stage === 'ARRIVED')) && (
              <>
                <div className="grid-2" style={{ gap: 8 }}>
                  <div className="form-group"><label>مبلغ دریافتی</label><div style={{ display: 'flex', gap: 6 }}><input type="number" style={{ flex: 1 }} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} /><select style={{ width: 80 }} value={payCurrency} onChange={(e) => setPayCurrency(e.target.value)}><option value="USD">دلار</option><option value="CNY">یوآن</option><option value="IRR">تومان</option></select></div></div>
                  <div className="form-group"><label>حساب دریافت‌کنندهٔ شرکت</label><SearchableSelect value={payAccount} onChange={setPayAccount} placeholder="انتخاب حساب..." options={accounts.map((a: any) => ({ value: a.id, label: a.name }))} /></div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {!cargo.prepaymentReceivedAt && <button className="btn-secondary btn-sm" disabled={!payAmount || !payAccount || pay.isPending || !cargo.warehouseConfirmedAt} title={!cargo.warehouseConfirmedAt ? 'پس از تأییدیهٔ انبار چین' : undefined} onClick={() => pay.mutate('PREPAYMENT')}>💰 ثبت پیش‌پرداخت</button>}
                  {!cargo.fullPaymentReceivedAt && cargo.stage === 'ARRIVED' && <button className="btn-primary btn-sm" disabled={!payAmount || !payAccount || pay.isPending} onClick={() => pay.mutate('FULL')}>💰 ثبت تکمیل وجه</button>}
                </div>
              </>
            )}
            <p className="hint-sm" style={{ marginTop: 4 }}>پیش‌پرداخت پس از تأییدیهٔ انبار چین و حتی پیش از رسیدن کل بار قابل ثبت است و برای حمل به ایران لازم است. تکمیل وجه پس از رسیدن به ایران و پیش از تحویل به مشتری ثبت می‌شود.</p>
          </div>

          {/* اتصال به محموله */}
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <h3 style={{ fontSize: 13, marginBottom: 6 }}>اتصال به محمولهٔ اصلی</h3>
            {cargo.shipment
              ? <p style={{ fontSize: 13, color: 'var(--success)' }}>🚢 متصل به محمولهٔ {cargo.shipment.code}</p>
              : <div style={{ display: 'flex', gap: 8 }}>
                  <SearchableSelect value={attachShip} onChange={setAttachShip} placeholder="انتخاب محموله..."
                    options={shipments.map((s: any) => ({ value: s.id, label: `${s.code} (${s.shippingCompany?.name || ''})` }))} />
                  <button className="btn-secondary btn-sm" disabled={!attachShip || attach.isPending} onClick={() => attach.mutate()}>اتصال</button>
                </div>}
            <p className="hint-sm" style={{ marginTop: 4  }}>با اتصال، بار وارد کانتینر مشترک می‌شود و سهم هزینهٔ حمل هنگام ثبت فاکتور حمل بر اساس وزن محاسبه می‌شود.</p>
          </div>
          </>
          )}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <button onClick={onClose} className="btn-secondary">بستن</button>
          {nextStage && <button className="btn-primary" disabled={advanceStage.isPending} onClick={async () => {
            if (nextStage.key === 'DELIVERED') {
              if (!(await dialog.confirm({ title: 'ثبت تحویل نهایی به مشتری؟', message: `بار پروژهٔ ${cargo.project.code} به مشتری تحویل داده می‌شود و پروژه «تکمیل‌شده» می‌گردد.`, confirmLabel: 'ثبت تحویل' }))) return
            }
            advanceStage.mutate(nextStage.key)
          }}>انتقال به «{nextStage.label}» ←</button>}
        </div>
      </div>
    </div>
  )
}
