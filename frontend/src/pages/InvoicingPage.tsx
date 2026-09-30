import { useState, useMemo, useEffect, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { API_ORIGIN } from '../lib/api'
import { toShamsi, faDate } from '../lib/date'
import { useSort, SortTH } from '../components/shared/sortable'
import { TaskReminderButton } from '../components/shared/TaskReminder'
import NumberInput from '../components/shared/NumberInput'
import SearchableSelect from '../components/shared/SearchableSelect'
import { PageHeader, TabChips, FilterToggle, Loading, TableEmpty } from '../components/ui'
import { dialog } from '../components/ui/dialog'

const CUR: Record<string, string> = { IRR: 'تومان', USD: 'دلار', CNY: 'یوآن' }

function openInvoicePdf(invoiceId: string) {
  const token = localStorage.getItem('token') || ''
  window.open(`${API_ORIGIN}/api/invoicing/${invoiceId}/print?token=${encodeURIComponent(token)}`, '_blank')
}
const INV_STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'پیش‌نویس', cls: 'status-in_progress' },
  SENT: { label: 'ارسال شده', cls: 'status-in_progress' },
  APPROVED: { label: 'تأیید شده', cls: 'status-active' },
  REJECTED: { label: 'رد شده', cls: 'status-archived' },
  SUPERSEDED: { label: 'منسوخ شده', cls: 'status-archived' },
}

// ۴.۲ — جزئیات بازشوی فاکتور: توضیحات توافق + دلیل رد + زمان آماده‌سازی
function InvoiceExpandDetail({ inv }: any) {
  return (
    <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {inv.notes ? <div><b>توضیحات / توافقات:</b> {inv.notes}</div> : <div className="muted">توضیحات توافقی ثبت نشده است.</div>}
      {inv.rejectReason && <div style={{ color: 'var(--danger)' }}><b>دلیل رد توسط مشتری:</b> {inv.rejectReason}</div>}
      {(inv.prepDays || inv.prepNote) && <div><b>زمان آماده‌سازی:</b> {inv.prepDays ? `${inv.prepDays} روز کاری پس از پیش‌پرداخت` : ''}{inv.prepNote ? ` — ${inv.prepNote}` : ''}</div>}
      <div className="muted">مبلغ کل: {Number(inv.totalAmount).toLocaleString()} {CUR[inv.currency]} • تاریخ: {toShamsi(inv.createdAt)}</div>
    </div>
  )
}

export default function InvoicingPage() {
  const [tab, setTab] = useState<'ready' | 'all'>('ready')
  const [showFilters, setShowFilters] = useState(false)
  // تعداد فیلترهای فعالِ تبِ جاری را خود تب گزارش می‌کند تا روی دکمهٔ نوار فرمان نشان داده شود
  const [activeCount, setActiveCount] = useState(0)

  return (
    <div className="page" dir="rtl">
      <PageHeader title="صدور فاکتور" subtitle="پیش‌فاکتور و فاکتور فروش برای پروژه‌های آماده"
        filter={<FilterToggle open={showFilters} onToggle={() => setShowFilters((s) => !s)} count={activeCount} />}
        chips={<TabChips value={tab} onChange={setTab} tabs={[
          { key: 'ready', label: 'پروژه‌های آماده فاکتور' },
          { key: 'all', label: 'همه فاکتورها' },
        ]} />} />
      {tab === 'ready'
        ? <ReadyProjects showFilters={showFilters} onActiveCount={setActiveCount} />
        : <AllInvoices showFilters={showFilters} onActiveCount={setActiveCount} />}
    </div>
  )
}

// ─── READY PROJECTS ───────────────────────────────────
function ReadyProjects({ showFilters, onActiveCount }: { showFilters: boolean; onActiveCount: (n: number) => void }) {
  const [openProject, setOpenProject] = useState<any>(null)
  const [q, setQ] = useState('')
  const [hasInvoice, setHasInvoice] = useState('')
  const { data: all = [], isLoading } = useQuery({
    queryKey: ['invoice-ready'],
    queryFn: () => api.get('/invoicing/ready/projects').then((r) => r.data),
  })
  const projects = useMemo(() => (all as any[]).filter((p) => {
    if (hasInvoice === 'yes' && !p.invoices?.length) return false
    if (hasInvoice === 'no' && p.invoices?.length) return false
    if (q) { const s = q.trim().toLowerCase(); return [p.code, p.customer?.name].some((v) => (v || '').toLowerCase().includes(s)) }
    return true
  }), [all, q, hasInvoice])
  const activeFilters = [q, hasInvoice].filter(Boolean).length
  useEffect(() => { onActiveCount(activeFilters) }, [activeFilters, onActiveCount])
  const sort = useSort('code', 'asc')
  const rows = sort.apply(projects as any[], {
    code: (p) => p.code,
    customer: (p) => p.customer?.name,
    parts: (p) => p.parts?.length || 0,
    lastInvoice: (p) => p.invoices?.[0]?.versionCode,
    createdAt: (p) => p.createdAt,
  })

  if (isLoading) return <Loading />

  return (
    <>
      {showFilters && (
        <div className="filters-bar">
          <input className="search-input" style={{ maxWidth: 260 }} placeholder="جستجو: کد پروژه یا مشتری…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select style={{ width: 190 }} value={hasInvoice} onChange={(e) => setHasInvoice(e.target.value)}>
            <option value="">همه</option>
            <option value="no">هنوز فاکتوری صادر نشده</option>
            <option value="yes">دارای فاکتور</option>
          </select>
          <span className="hint" style={{ marginRight: 'auto'  }}>{rows.length} از {all.length} پروژه</span>
          {activeFilters > 0 && <button className="btn-ghost btn-sm" onClick={() => { setQ(''); setHasInvoice('') }}>پاک‌کردن فیلترها</button>}
        </div>
      )}
      <div className="table-container">
        <table className="data-table">
          <thead><tr>
            <SortTH label="پروژه" k="code" sort={sort} />
            <SortTH label="مشتری" k="customer" sort={sort} />
            <SortTH label="قطعات / کالاها" k="parts" sort={sort} />
            <SortTH label="آخرین فاکتور" k="lastInvoice" sort={sort} />
            <SortTH label="تاریخ ایجاد" k="createdAt" sort={sort} />
            <th>اقدام</th>
          </tr></thead>
          <tbody>
            {rows.map((p: any) => (
              <tr key={p.id}>
                <td className="code-text">{p.code}</td>
                <td>{p.customer.name}</td>
                <td>{p.parts.length} {p.type === 'TRADING' ? 'کالا' : 'قطعه'}</td>
                <td>{p.invoices[0] ? `${p.invoices[0].versionCode} (${INV_STATUS[p.invoices[0].status]?.label})` : '—'}</td>
                <td className="nowrap">{faDate(p.createdAt)}</td>
                <td><button className="btn-sm btn-primary" onClick={() => setOpenProject(p)}>مدیریت فاکتور</button></td>
              </tr>
            ))}
            {rows.length === 0 && <TableEmpty colSpan={6}>پروژه‌ای آماده صدور فاکتور نیست</TableEmpty>}
          </tbody>
        </table>
      </div>
      {openProject && <ProjectInvoicePanel project={openProject} onClose={() => setOpenProject(null)} />}
    </>
  )
}

// ─── PROJECT INVOICE PANEL (versions list + actions) ──
function ProjectInvoicePanel({ project, onClose }: any) {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [confirmInv, setConfirmInv] = useState<any>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const { data: fresh } = useQuery({
    queryKey: ['invoice-ready', project.id],
    queryFn: () => api.get('/invoicing/ready/projects').then((r) => r.data.find((p: any) => p.id === project.id)),
    initialData: project,
  })
  const proj = fresh || project

  const refresh = () => { qc.invalidateQueries({ queryKey: ['invoice-ready'] }); qc.invalidateQueries({ queryKey: ['invoices'] }) }

  const setStatus = useMutation({
    mutationFn: ({ id, status, rejectReason }: any) => api.patch(`/invoicing/${id}/status`, { status, rejectReason }),
    onSuccess: refresh,
  })

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 720 }}>
        <div className="modal-header">
          <h2>فاکتورهای پروژه {proj.code} — {proj.customer.name}</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ ایجاد پیش‌فاکتور جدید</button>
          </div>

          {proj.invoices.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 16 }}>هنوز پیش‌فاکتوری صادر نشده</p>
          ) : (
            <>
            <p className="hint" style={{ marginBottom: 8  }}>روی هر ردیف کلیک کنید تا توضیحات توافق و جزئیات آن نسخه (شامل نسخه‌های رد‌شدهٔ قبلی) باز شود.</p>
            <div className="table-container">
            <table className="data-table">
              <thead><tr><th></th><th>نسخه</th><th>وضعیت</th><th>مبلغ کل</th><th>تاریخ</th><th>اقدام</th></tr></thead>
              <tbody>
                {proj.invoices.map((inv: any) => (
                  <Fragment key={inv.id}>
                    <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === inv.id ? null : inv.id)}>
                      <td style={{ width: 22, color: 'var(--text-muted)' }}>{expanded === inv.id ? '▼' : '◀'}</td>
                      <td className="code-text">{inv.versionCode}</td>
                      <td><span className={`status-badge ${INV_STATUS[inv.status]?.cls}`}>{INV_STATUS[inv.status]?.label}</span></td>
                      <td className="nowrap num">{Number(inv.totalAmount).toLocaleString()} {CUR[inv.currency]}</td>
                      <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{toShamsi(inv.createdAt)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <button className="icon-btn" onClick={() => openInvoicePdf(inv.id)} title="باز کردن فاکتور برای چاپ یا ذخیره PDF" aria-label="دانلود PDF">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>
                          </button>
                          {inv.status !== 'APPROVED' && inv.status !== 'REJECTED' && (
                            <>
                              <button className="btn-primary btn-sm" onClick={() => setConfirmInv(inv)}>تأیید مشتری</button>
                              <button className="icon-btn danger" title="رد فاکتور توسط مشتری" aria-label="رد فاکتور" onClick={async () => { const r = await dialog.prompt({ title: 'رد فاکتور توسط مشتری', message: 'دلیل رد ثبت می‌شود تا در نسخهٔ بعدی لحاظ شود.', placeholder: 'دلیل رد…', multiline: true, required: true, tone: 'danger', confirmLabel: 'ثبت رد' }); if (r) setStatus.mutate({ id: inv.id, status: 'REJECTED', rejectReason: r }) }}>
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
                              </button>
                              <TaskReminderButton title={`پیگیری تأیید فاکتور ${inv.versionCode} از مشتری`} projectId={proj.id} entityType="Invoice" entityId={inv.id} />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expanded === inv.id && <tr><td colSpan={6} style={{ background: 'var(--surface-2, var(--surface-2))', padding: 12 }}><InvoiceExpandDetail inv={inv} /></td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
            </div>
            </>
          )}
        </div>
      </div>

      {showCreate && <CreateInvoiceModal project={proj} onClose={() => setShowCreate(false)} onSuccess={() => { setShowCreate(false); refresh() }} />}
      {confirmInv && <ConfirmInvoiceModal invoice={confirmInv} onClose={() => setConfirmInv(null)} onSuccess={() => { setConfirmInv(null); onClose(); refresh() }} />}
    </div>
  )
}

// ─── WINDOW F: CREATE PRE-INVOICE ─────────────────────
function CreateInvoiceModal({ project, onClose, onSuccess }: any) {
  const [currency, setCurrency] = useState('IRR') // واحد پولی فاکتور
  const [method, setMethod] = useState<'percent' | 'manual'>('percent')
  const [globalPercent, setGlobalPercent] = useState('30')
  // قیمت فروش واحد دستی (به ارز فاکتور) به ازای هر قطعه
  const [manual, setManual] = useState<Record<string, string>>({})
  const [excluded, setExcluded] = useState<Set<string>>(new Set()) // قطعاتی که از این فاکتور کنار گذاشته شده‌اند
  const [prepDays, setPrepDays] = useState('') // زمان آماده‌سازی (روز کاری پس از پیش‌پرداخت)
  const [prepNote, setPrepNote] = useState('')
  const [hasVat, setHasVat] = useState(false) // آیا این فاکتور شامل مالیات بر ارزش افزوده است؟
  const [error, setError] = useState('')

  // نرخ ارز زنده برای تبدیل قیمت سازنده به واحد پولی فاکتور
  const { data: rates } = useQuery({ queryKey: ['acc-rates'], queryFn: () => api.get('/accounting/rates').then((r) => r.data) })
  // درصد مالیات از تنظیمات فاکتور (پیش‌فرض ۱۰٪)
  const { data: invSettings } = useQuery({ queryKey: ['invoice-settings'], queryFn: () => api.get('/settings/config/INVOICE_SETTINGS').then((r) => r.data || {}) })
  const vatPercent = Number(invSettings?.vatPercent) > 0 ? Number(invSettings.vatPercent) : 10

  const parts = project.parts
  // در پروژهٔ خرید کالا به‌جای «قطعه» باید «کالا» نمایش داده شود
  const itemWord = project.type === 'TRADING' ? 'کالا' : 'قطعه'

  const toIRR = (amt: number, cur: string) =>
    !rates || cur === 'IRR' ? amt : cur === 'USD' ? amt * rates.USD_TO_IRR : amt * rates.CNY_TO_IRR
  const convert = (amt: number, from: string, to: string) => {
    if (from === to || !rates) return amt
    const irr = toIRR(amt, from)
    return to === 'IRR' ? irr : to === 'USD' ? irr / rates.USD_TO_IRR : irr / rates.CNY_TO_IRR
  }

  // محاسبه قیمت هر قطعه — قیمت‌ها «واحد»اند؛ هزینه سازنده به واحد پولی فاکتور تبدیل می‌شود
  const items = useMemo(() => parts.map((part: any) => {
    const qty = part.quantity || 1
    const costOrig = Number(part.selectedPrice?.amount || 0)       // قیمت تمام‌شده واحد، ارز اصلی سازنده
    const costCurrency = part.selectedPrice?.currency || 'IRR'
    const costConv = convert(costOrig, costCurrency, currency)     // قیمت تمام‌شده واحد، به ارز فاکتور (فقط نمایش/سود)
    let unitSale: number
    if (method === 'manual') unitSale = Number(manual[part.id] || 0)
    else unitSale = costConv * (1 + Number(globalPercent || 0) / 100)
    return { partId: part.id, name: part.name, qty, costOrig, costCurrency, costConv, unitSale }
  }), [parts, method, globalPercent, manual, currency, rates])

  // فقط قطعاتِ تیک‌خورده وارد فاکتور می‌شوند (مشتری می‌تواند بخشی را رد کند)
  const activeItems = items.filter((i: any) => !excluded.has(i.partId))
  const totalCost = activeItems.reduce((s: number, i: any) => s + i.costConv * i.qty, 0)
  const totalSale = activeItems.reduce((s: number, i: any) => s + i.unitSale * i.qty, 0)
  const commissionPct = (project.commissions || []).reduce((s: number, c: any) => s + Number(c.percentage || 0), 0)
  const commissionCost = totalSale * commissionPct / 100
  const totalWeightKg = (project.parts || []).filter((p: any) => !excluded.has(p.id)).reduce((s: number, p: any) => s + (p.quantity || 0) * (Number(p.weightGrams) || 0), 0) / 1000
  const shipCur = project.shippingCost?.ratePerKgCurrency || 'IRR'
  const shipRatePerKg = project.shippingCost?.ratePerKgAmount ? convert(Number(project.shippingCost.ratePerKgAmount), shipCur, currency) : 0
  const shippingCost = shipRatePerKg * totalWeightKg
  const estProfit = totalSale - totalCost - commissionCost - shippingCost

  // مالیات بر ارزش افزوده (پیش‌نمایش) — مبلغ نهایی که مشتری می‌پردازد
  const vatAmount = hasVat ? totalSale * vatPercent / 100 : 0
  const grandTotal = totalSale + vatAmount

  const curLabel = currency === 'IRR' ? 'تومان' : currency === 'USD' ? 'دلار' : 'یوآن'

  const create = useMutation({
    mutationFn: () => api.post('/invoicing', {
      projectId: project.id,
      currency,
      notes: '',
      prepDays: prepDays || null,
      prepNote: prepNote || null,
      hasVat,
      // قیمت تمام‌شده در ارز اصلی سازنده ذخیره می‌شود (برای بدهی صحیح سازنده)؛ فروش در ارز فاکتور
      items: activeItems.map((i: any) => ({ partId: i.partId, costAmount: i.costOrig, costCurrency: i.costCurrency, saleAmount: i.unitSale, saleCurrency: currency })),
    }),
    onSuccess,
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  const fmt = (n: number) => (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 })

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 820 }}>
        <div className="modal-header"><h2>ایجاد پیش‌فاکتور جدید</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 16, marginBottom: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>واحد پولی فاکتور</label>
              <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ width: 140 }}>
                <option value="IRR">تومان</option><option value="USD">دلار</option><option value="CNY">یوآن</option>
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>روش محاسبه</label>
              <select value={method} onChange={(e) => setMethod(e.target.value as any)} style={{ width: 160 }}>
                <option value="percent">درصد سود</option>
                <option value="manual">قیمت فروش دستی</option>
              </select>
            </div>
            {method === 'percent' && (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>درصد سود کل (%)</label>
                <input type="number" value={globalPercent} onChange={(e) => setGlobalPercent(e.target.value)} style={{ width: 120 }} />
              </div>
            )}
            {rates && <span className="hint-sm" style={{ alignSelf: 'center'  }}>نرخ زنده: دلار {Math.round(rates.USD_TO_IRR).toLocaleString()} • یوآن {Math.round(rates.CNY_TO_IRR).toLocaleString()} تومان</span>}
          </div>

          <table className="data-table">
            <thead><tr><th>شامل</th><th>{itemWord}</th><th>تعداد</th><th>قیمت تمام‌شده (واحد)</th><th>قیمت فروش (واحد)</th><th>قیمت کل فروش</th></tr></thead>
            <tbody>
              {items.map((i: any) => {
                const isOut = excluded.has(i.partId)
                return (
                <tr key={i.partId} style={isOut ? { opacity: 0.4 } : undefined}>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={!isOut}
                      onChange={(e) => { const n = new Set(excluded); e.target.checked ? n.delete(i.partId) : n.add(i.partId); setExcluded(n) }} />
                  </td>
                  <td>{i.name}</td>
                  <td><strong>{i.qty}</strong></td>
                  <td className="hint">
                    {fmt(i.costConv)} {curLabel}
                    {i.costCurrency !== currency && <span style={{ display: 'block', fontSize: 10 }}>({i.costOrig.toLocaleString()} {CUR[i.costCurrency]})</span>}
                  </td>
                  <td>
                    {method === 'manual'
                      ? <NumberInput placeholder={`قیمت واحد (${curLabel})`} value={manual[i.partId] || ''} onChange={(v) => setManual({ ...manual, [i.partId]: v })} style={{ width: 130 }} disabled={isOut} decimals />
                      : <strong>{fmt(i.unitSale)} {curLabel}</strong>}
                  </td>
                  <td><strong style={{ color: 'var(--primary)' }}>{fmt(i.unitSale * i.qty)} {curLabel}</strong></td>
                </tr>
                )
              })}
            </tbody>
          </table>

          <div style={{ marginTop: 16, padding: 12, background: 'var(--success-soft)', border: '1px solid var(--success-soft)', borderRadius: 'var(--radius-sm)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 13 }}>
              <span>مجموع فروش: {fmt(totalSale)} {curLabel}</span>
              <span>− مجموع تمام‌شده: {fmt(totalCost)} {curLabel}</span>
              <span>− کمیسیون ({commissionPct}%): {fmt(commissionCost)} {curLabel}</span>
              <span>− هزینه حمل تخمینی: {fmt(shippingCost)} {curLabel}</span>
            </div>
            <div style={{ borderTop: '1px solid var(--success-soft)', marginTop: 8, paddingTop: 8 }}>
              <strong style={{ color: estProfit >= 0 ? 'var(--success)' : 'var(--danger)', fontSize: 15 }}>سود تخمینی این فاکتور: {fmt(estProfit)} {curLabel}</strong>
            </div>
            <p className="hint-sm" style={{ marginTop: 6  }}>* قیمت‌ها «واحد»اند و در تعداد ضرب می‌شوند. هزینه سازنده با نرخ زنده به واحد پولی فاکتور تبدیل شده. مبالغ دقیق‌اند و گرد نمی‌شوند.</p>
          </div>

          {/* مالیات بر ارزش افزوده */}
          <div style={{ marginTop: 14, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 14 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={hasVat} onChange={(e) => setHasVat(e.target.checked)} />
              <span>این فاکتور شامل مالیات بر ارزش افزوده ({fmt(vatPercent)}٪) است</span>
            </label>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 13, flexWrap: 'wrap', gap: 8 }}>
              <span>مجموع اقلام: {fmt(totalSale)} {curLabel}</span>
              {hasVat && <span style={{ color: 'var(--danger)' }}>+ ارزش افزوده ({fmt(vatPercent)}٪): {fmt(vatAmount)} {curLabel}</span>}
              <strong style={{ color: 'var(--primary)', fontSize: 15 }}>مبلغ کل قابل پرداخت: {fmt(grandTotal)} {curLabel}</strong>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 16, marginTop: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>زمان آماده‌سازی (روز کاری پس از پیش‌پرداخت)</label>
              <input type="number" value={prepDays} onChange={(e) => setPrepDays(e.target.value)} placeholder="مثلاً ۲۵" style={{ width: 220 }} />
            </div>
            <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
              <label>یادداشت زمان آماده‌سازی (اختیاری)</label>
              <input type="text" value={prepNote} onChange={(e) => setPrepNote(e.target.value)} placeholder="توضیح تکمیلی روی فاکتور" />
            </div>
          </div>

          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          {excluded.size > 0 && <span className="hint" style={{ marginLeft: 'auto'  }}>{excluded.size} {itemWord} کنار گذاشته شد</span>}
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={create.isPending || activeItems.length === 0} onClick={() => create.mutate()}>صدور پیش‌فاکتور ({activeItems.length} {itemWord})</button>
        </div>
      </div>
    </div>
  )
}

// ─── CONFIRM INVOICE MODAL ────────────────────────────
function ConfirmInvoiceModal({ invoice, onClose, onSuccess }: any) {
  const [advanceAmount, setAdvanceAmount] = useState('')
  const [advanceCurrency, setAdvanceCurrency] = useState(invoice.currency || 'IRR')
  const [advanceAccountId, setAdvanceAccountId] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')

  const { data: companyAccounts = [] } = useQuery({
    queryKey: ['company-accounts'],
    queryFn: () => api.get('/accounting/accounts').then((r) => r.data),
  })
  const matchingAccounts = companyAccounts.filter((a: any) => a.currency === advanceCurrency)

  const confirm = useMutation({
    mutationFn: () => api.post(`/invoicing/${invoice.id}/confirm`, {
      advanceAmount: advanceAmount || 0, advanceCurrency, notes,
      advanceAccountId: advanceAccountId || undefined,
    }),
    onSuccess,
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>ثبت تأییدیه مشتری — {invoice.versionCode}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-group">
            <label>مبلغ پیش‌پرداخت</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <NumberInput value={advanceAmount} onChange={setAdvanceAmount} placeholder="مبلغ (مدیر می‌تواند صفر بگذارد)" decimals />
              <select style={{ width: 110 }} value={advanceCurrency} onChange={(e) => { setAdvanceCurrency(e.target.value); setAdvanceAccountId('') }}>
                <option value="IRR">تومان</option><option value="USD">دلار</option><option value="CNY">یوآن</option>
              </select>
            </div>
          </div>
          {Number(advanceAmount) > 0 && (
            <div className="form-group">
              <label>حساب واریز پیش‌پرداخت</label>
              <SearchableSelect value={advanceAccountId} onChange={setAdvanceAccountId} placeholder="صندوق پیش‌فرض"
                options={matchingAccounts.map((a: any) => ({ value: a.id, label: a.name }))} />
              <span className="hint-sm">حسابی که مبلغ به آن واریز شده — فقط حساب‌های هم‌ارز نمایش داده می‌شوند.</span>
            </div>
          )}
          <div className="form-group"><label>توضیحات / توافقات</label><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <div style={{ padding: 10, background: 'var(--warning-soft)', border: '1px solid var(--warning-soft)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}>
            با تأیید نهایی: پروژه فعال شده، سفارش‌های ساخت خودکار ایجاد و تراکنش‌های مالی ثبت می‌شوند.
          </div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={confirm.isPending} onClick={() => confirm.mutate()}>تأیید نهایی و شروع تولید</button>
        </div>
      </div>
    </div>
  )
}

// ─── ALL INVOICES ─────────────────────────────────────
function AllInvoices({ showFilters, onActiveCount }: { showFilters: boolean; onActiveCount: (n: number) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [currency, setCurrency] = useState('')
  const { data: allInvoices = [] } = useQuery({
    queryKey: ['invoices'],
    queryFn: () => api.get('/invoicing').then((r) => r.data),
  })
  const invoices = useMemo(() => (allInvoices as any[]).filter((i) => {
    if (status && i.status !== status) return false
    if (currency && i.currency !== currency) return false
    if (q) {
      const s = q.trim().toLowerCase()
      return [i.project?.code, i.project?.customer?.name, i.versionCode, i.notes].some((v) => (v || '').toLowerCase().includes(s))
    }
    return true
  }), [allInvoices, q, status, currency])
  const activeFilters = [status, currency, q].filter(Boolean).length
  useEffect(() => { onActiveCount(activeFilters) }, [activeFilters, onActiveCount])
  const sort = useSort('createdAt', 'desc')
  const rows = sort.apply(invoices as any[], {
    project: (i) => i.project?.code,
    version: (i) => i.versionCode,
    status: (i) => i.status,
    amount: (i) => Number(i.totalAmount),
    createdAt: (i) => i.createdAt,
  })
  return (
    <>
      {showFilters && (
        <div className="filters-bar">
          <input className="search-input" style={{ maxWidth: 260 }} placeholder="جستجو: کد پروژه، مشتری، شمارهٔ نسخه…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">همهٔ وضعیت‌ها</option>
            {Object.entries(INV_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select style={{ width: 130 }} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="">همهٔ ارزها</option>
            {Object.entries(CUR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="hint" style={{ marginRight: 'auto'  }}>{rows.length} از {allInvoices.length} فاکتور</span>
          {activeFilters > 0 && <button className="btn-ghost btn-sm" onClick={() => { setQ(''); setStatus(''); setCurrency('') }}>پاک‌کردن فیلترها</button>}
        </div>
      )}
      <div className="table-container">
      <p className="hint" style={{ padding: '10px 14px 0'  }}>روی هر ردیف کلیک کنید تا توضیحات توافق و دلیل رد آن فاکتور دیده شود (شامل فاکتورهای تأییدنشده و رد‌شده).</p>
      <table className="data-table">
        <thead><tr>
          <th></th>
          <SortTH label="پروژه" k="project" sort={sort} />
          <SortTH label="نسخه" k="version" sort={sort} />
          <SortTH label="وضعیت" k="status" sort={sort} />
          <SortTH label="مبلغ" k="amount" sort={sort} />
          <SortTH label="تاریخ" k="createdAt" sort={sort} />
          <th>اقدام</th>
        </tr></thead>
        <tbody>
          {rows.map((inv: any) => (
            <Fragment key={inv.id}>
              <tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === inv.id ? null : inv.id)}>
                <td style={{ width: 22, color: 'var(--text-muted)' }}>{expanded === inv.id ? '▼' : '◀'}</td>
                <td className="code-text">{inv.project.code}</td>
                <td>{inv.versionCode}</td>
                <td><span className={`status-badge ${INV_STATUS[inv.status]?.cls}`}>{INV_STATUS[inv.status]?.label}</span></td>
                <td>{Number(inv.totalAmount).toLocaleString()} {CUR[inv.currency]}</td>
                <td style={{ fontSize: 12 }}>{toShamsi(inv.createdAt)}</td>
                <td onClick={(e) => e.stopPropagation()}><button className="btn-secondary btn-sm" onClick={() => openInvoicePdf(inv.id)}>📄 دانلود PDF</button></td>
              </tr>
              {expanded === inv.id && <tr><td colSpan={7} style={{ background: 'var(--surface-2, var(--surface-2))', padding: 12 }}><InvoiceExpandDetail inv={inv} /></td></tr>}
            </Fragment>
          ))}
          {rows.length === 0 && <TableEmpty colSpan={7}>فاکتوری وجود ندارد</TableEmpty>}
        </tbody>
      </table>
      </div>
    </>
  )
}
