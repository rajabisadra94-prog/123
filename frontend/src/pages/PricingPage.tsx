import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { API_ORIGIN } from '../lib/api'
import { toShamsi } from '../lib/date'
import { useSort, SortTH } from '../components/shared/sortable'
import FilterBar, { type FilterState } from '../components/shared/FilterBar'
import { TaskReminderButton } from '../components/shared/TaskReminder'
import NumberInput from '../components/shared/NumberInput'
import { PageHeader, TabChips, EmptyState, FilterToggle, ModalLoading, TableEmpty } from '../components/ui'
import { dialog, toast } from '../components/ui/dialog'

const STATUS_LABELS: Record<string, string> = {
  IN_PROGRESS: 'در جریان',
  COMPLETED: 'تکمیل شده',
  ARCHIVED: 'بایگانی شده',
}
const CUR: Record<string, string> = { IRR: 'تومان', USD: 'دلار', CNY: 'یوآن' }

export default function PricingPage() {
  const [openId, setOpenId] = useState<string | null>(null)
  const [group, setGroup] = useState<'active' | 'done' | 'all'>('active')
  const [filters, setFilters] = useState<FilterState>({})
  const [showFilters, setShowFilters] = useState(false)
  const activeFilterCount = [filters.search, filters.customerId].filter(Boolean).length
  const { data: requests = [] } = useQuery({
    queryKey: ['pricing', filters.customerId],
    queryFn: () => api.get('/pricing', { params: { customerId: filters.customerId } }).then((r) => r.data),
  })

  const counts = useMemo(() => ({
    active: requests.filter((r: any) => r.status === 'IN_PROGRESS').length,
    done: requests.filter((r: any) => r.status === 'COMPLETED' || r.status === 'ARCHIVED').length,
  }), [requests])

  const filtered = useMemo(() => requests.filter((r: any) => {
    if (group === 'active' && r.status !== 'IN_PROGRESS') return false
    if (group === 'done' && !(r.status === 'COMPLETED' || r.status === 'ARCHIVED')) return false
    if (filters.search) {
      const s = filters.search.toLowerCase()
      if (!(r.project.code?.toLowerCase().includes(s) || r.project.customer.name?.toLowerCase().includes(s))) return false
    }
    return true
  }), [requests, group, filters.search])

  const sort = useSort('createdAt', 'desc')
  const rows = sort.apply(filtered, {
    project: (r: any) => r.project?.code,
    customer: (r: any) => r.project?.customer?.name,
    status: (r: any) => r.status,
    producers: (r: any) => r.producers?.length || 0,
    createdAt: (r: any) => r.createdAt,
  })

  return (
    <div className="page" dir="rtl">
      <PageHeader title="قیمت‌گیری" subtitle="استعلام قیمت از سازندگان و تامین‌کنندگان و انتخاب برنده"
        filter={<FilterToggle open={showFilters} onToggle={() => setShowFilters((s) => !s)} count={activeFilterCount} />}
        chips={<TabChips value={group} onChange={setGroup} tabs={[
          { key: 'active', label: 'در جریان', count: counts.active },
          { key: 'done', label: 'تکمیل‌شده و بایگانی', count: counts.done },
          { key: 'all', label: 'همه' },
        ]} />} />
      {showFilters && <FilterBar value={filters} onChange={setFilters} show={{ search: true, customer: true }} />}
      <div className="table-container">
        <table className="data-table">
          <thead><tr>
            <SortTH label="پروژه" k="project" sort={sort} />
            <SortTH label="مشتری" k="customer" sort={sort} />
            <SortTH label="وضعیت" k="status" sort={sort} />
            <SortTH label="فروشندگان" k="producers" sort={sort} />
            <SortTH label="تاریخ" k="createdAt" sort={sort} />
            <th>اقدام</th>
          </tr></thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.id}>
                <td className="code-text">{r.project.code}</td>
                <td>{r.project.customer.name}</td>
                <td><span className={`status-badge status-${r.status.toLowerCase()}`}>{STATUS_LABELS[r.status] || r.status}</span></td>
                <td>{r.producers.length} {r.project.type === 'TRADING' ? 'تامین‌کننده' : 'سازنده'}</td>
                <td style={{ fontSize: 12 }}>{toShamsi(r.createdAt)}</td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn-sm btn-primary" onClick={() => setOpenId(r.id)}>مشاهده</button>
                    <TaskReminderButton title={`پیگیری قیمت پروژه ${r.project.code}`} projectId={r.projectId} entityType="PricingRequest" entityId={r.id} />
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={6}><EmptyState title="درخواست قیمتی نیست">در این نما درخواست قیمتی وجود ندارد. از صفحهٔ پروژه، قطعات را برای قیمت‌گیری ارسال کنید.</EmptyState></td></tr>}
          </tbody>
        </table>
      </div>

      {openId && <PricingDetail id={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}

// ─── WINDOW D: COMPARISON BOARD ───────────────────────
function PricingDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [prices, setPrices] = useState<Record<string, { amount: string; currency: string }>>({})
  const [delivery, setDelivery] = useState<Record<string, string>>({})
  const [showFinalize, setShowFinalize] = useState(false)
  const [showAddProducers, setShowAddProducers] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  const [notes, setNotes] = useState('') // یادداشت کلی زیر فرم قیمت‌گیری
  const [proformaFor, setProformaFor] = useState<any>(null) // سازنده‌ای که پرفرمایش باز است
  const [msg, setMsg] = useState('')
  const [isErr, setIsErr] = useState(false)

  const { data: pr } = useQuery({ queryKey: ['pricing', id], queryFn: () => api.get(`/pricing/${id}`).then((r) => r.data) })

  useEffect(() => {
    if (!pr) return
    const p: Record<string, { amount: string; currency: string }> = {}
    pr.partPrices.forEach((pp: any) => { p[`${pp.partId}_${pp.producerId ?? pp.supplierId}`] = { amount: String(pp.amount), currency: pp.currency } })
    setPrices(p)
    const d: Record<string, string> = {}
    pr.producers.forEach((pp: any) => { if (pp.deliveryDays) d[pp.producerId ?? pp.supplierId] = String(pp.deliveryDays) })
    setDelivery(d)
    setNotes(pr.notes || '')
  }, [pr])

  const savePrices = useMutation({
    mutationFn: () => {
      const arr = Object.entries(prices)
        .filter(([, v]) => v.amount)
        .map(([key, v]) => {
          const [partId, vendorId] = key.split('_')
          // نوع فروشنده (سازنده/تامین‌کننده) از ردیف فروشنده تعیین می‌شود
          const vrow = (pr?.producers || []).find((x: any) => (x.producerId ?? x.supplierId) === vendorId)
          const vkey = vrow?.supplierId ? { supplierId: vendorId } : { producerId: vendorId }
          return { partId, ...vkey, amount: Number(v.amount), currency: v.currency }
        })
      return api.put(`/pricing/${id}/prices`, { prices: arr })
    },
    onSuccess: async () => {
      try {
        // save delivery days too
        await Promise.all(Object.entries(delivery).filter(([, d]) => d).map(([producerId, days]) =>
          api.patch(`/pricing/${id}/producers/${producerId}`, { deliveryDays: days })))
        await api.patch(`/pricing/${id}`, { notes }) // ذخیرهٔ یادداشت کلی همراه قیمت‌ها
      } catch { /* delivery/notes save is non-critical */ }
      setIsErr(false); setMsg('ذخیره شد ✓'); setTimeout(() => setMsg(''), 2500)
      qc.invalidateQueries({ queryKey: ['pricing', id] })
    },
    onError: (e: any) => {
      setIsErr(true)
      const status = e.response?.status ? `[${e.response.status}] ` : ''
      setMsg(status + (e.response?.data?.message || e.message || 'خطای ناشناخته'))
    },
  })

  // ۳.۴ — بازگشایی برای تغییر سازنده (فقط تا پیش از تأیید فاکتور توسط مشتری)
  const reopen = useMutation({
    mutationFn: () => api.post(`/pricing/${id}/reopen`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pricing', id] }),
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  if (!pr) return <ModalLoading />

  const parts = pr.project.parts
  const producers = pr.producers
  const isLocked = pr.status !== 'IN_PROGRESS'

  // فروشنده = سازنده (ساخت) یا تامین‌کننده (خرید). شناسه و نام یکپارچه:
  const isTrading = pr.project?.type === 'TRADING'
  const vendorWord = isTrading ? 'تامین‌کننده' : 'سازنده'
  const itemWord = isTrading ? 'کالا' : 'قطعه'
  const vid = (pp: any): string => pp.producerId ?? pp.supplierId
  const vname = (pp: any): string => pp.producer?.name ?? pp.supplier?.name ?? '—'

  // تخصیص per-part: هر فروشنده فقط برای قطعات تخصیص‌یافته‌اش قیمت وارد می‌کند (خالی = همهٔ قطعات، برای سازگاری با داده‌های قبلی)
  const isAssigned = (vendorId: string, partId: string) => {
    const a: string[] = (producers.find((x: any) => vid(x) === vendorId)?.parts || []).map((x: any) => x.partId)
    return a.length === 0 || a.includes(partId)
  }

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 980 }}>
        <div className="modal-header">
          <h2>قیمت‌گیری — {pr.project.code} ({pr.project.customer.name})</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {isLocked && <div style={{ marginBottom: 12, padding: 8, background: '#dbeafe', borderRadius: 'var(--radius-sm)', fontSize: 13 }}>این درخواست {STATUS_LABELS[pr.status]} است (فقط‌خواندنی).</div>}

          <div className="table-container">
            <table className="data-table pricing-grid">
              <thead>
                <tr>
                  <th>{itemWord}</th>
                  {producers.map((pp: any) => (
                    <th key={vid(pp)} style={{ minWidth: 150 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'stretch' }}>
                        <div style={{ fontWeight: 700, fontSize: 12.5, color: 'var(--brand-800)' }}>{vname(pp)}</div>
                        <input type="number" placeholder="تحویل (روز)" style={{ fontSize: 11 }}
                          disabled={isLocked} value={delivery[vid(pp)] || ''}
                          onChange={(e) => setDelivery({ ...delivery, [vid(pp)]: e.target.value })} />
                        <button type="button" title={`آپلود/مشاهدهٔ پرفرمای این ${vendorWord}`}
                          onClick={() => setProformaFor(pp)}
                          style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                            width: '100%', height: 30, boxSizing: 'border-box', padding: '0 8px',
                            fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                            borderRadius: 8, border: '1px solid', whiteSpace: 'nowrap', transition: 'background .15s, border-color .15s',
                            ...(pp.proformaFileUrl
                              ? { background: 'var(--success-soft)', color: '#0c6b73', borderColor: '#bce3e5' }
                              : { background: 'var(--surface-2)', color: 'var(--brand)', borderColor: 'var(--border-strong)' }),
                          }}>
                          <span aria-hidden="true">📎</span>{pp.proformaFileUrl ? 'پرفرما ✓' : 'افزودن پرفرما'}
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parts.map((part: any) => (
                  <tr key={part.id} style={part.group ? { background: part.group.color } : undefined}>
                    <td>
                      {part.name}{part.group && <span className="hint-sm"> ⛓</span>}
                      {!isLocked && (
                        <button type="button" title="حذف این قطعه از قیمت‌گیری (بایگانی می‌شود و بعداً قابل قیمت‌گیری مجدد است)" className="btn-danger btn-sm" style={{ marginRight: 6, fontSize: 10, padding: '1px 6px' }}
                          onClick={async () => { const reason = await dialog.prompt({ title: `حذف «${part.name}» از قیمت‌گیری`, message: 'قطعه بایگانی می‌شود و بعداً قابل قیمت‌گیری مجدد است.', placeholder: 'دلیل حذف…', multiline: true, tone: 'danger', confirmLabel: 'حذف از قیمت‌گیری' }); if (reason === null) return; await api.post(`/pricing/${id}/parts/${part.id}/archive`, { reason }); qc.invalidateQueries({ queryKey: ['pricing', id] }) }}>✕</button>
                      )}
                    </td>
                    {producers.map((pp: any) => {
                      const key = `${part.id}_${vid(pp)}`
                      const val = prices[key] || { amount: '', currency: 'IRR' }
                      if (!isAssigned(vid(pp), part.id)) {
                        return <td key={vid(pp)} style={{ textAlign: 'center', color: 'var(--text-muted)', background: 'var(--surface-2)' }} title={`این ${itemWord} به این ${vendorWord} تخصیص نیافته است`}>—</td>
                      }
                      return (
                        <td key={vid(pp)}>
                          <div style={{ display: 'flex', gap: 4 }}>
                            <NumberInput placeholder="قیمت" style={{ fontSize: 12 }} disabled={isLocked} decimals
                              value={val.amount} onChange={(v) => setPrices({ ...prices, [key]: { ...val, amount: v } })} />
                            <select style={{ width: 70, fontSize: 11 }} disabled={isLocked}
                              value={val.currency} onChange={(e) => setPrices({ ...prices, [key]: { ...val, currency: e.target.value } })}>
                              <option value="IRR">تومان</option><option value="USD">دلار</option><option value="CNY">یوآن</option>
                            </select>
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
                {parts.length === 0 && <TableEmpty colSpan={producers.length + 1}>قطعه‌ای در این درخواست نیست</TableEmpty>}
              </tbody>
            </table>
          </div>

          <div className="form-group" style={{ marginTop: 12 }}>
            <label>یادداشت کلی این قیمت‌گیری</label>
            <textarea rows={2} value={notes} disabled={isLocked} onChange={(e) => setNotes(e.target.value)} placeholder="یادداشت‌های مربوط به مذاکره، شرایط و... — با «ذخیره موقت» ذخیره می‌شود" />
          </div>

          {msg && <div style={{ marginTop: 10, color: isErr ? 'var(--danger)' : 'var(--success)', fontSize: 13 }}>{msg}</div>}
        </div>
        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {!isLocked && <button className="btn-secondary btn-sm" onClick={() => setShowAddProducers(true)}>+ قیمت‌گیری مجدد</button>}
            {!isLocked && <button className="btn-danger btn-sm" onClick={() => setShowArchive(true)}>رد و بایگانی</button>}
            {isLocked && pr.status === 'COMPLETED' && <button className="btn-secondary btn-sm" disabled={reopen.isPending} title={`بازگشت به حالت «در جریان» برای انتخاب ${vendorWord} دیگر (فقط تا پیش از تأیید فاکتور)`} onClick={async () => { if (await dialog.confirm({ title: `تغییر ${vendorWord}؟`, message: 'این درخواست به حالت «در جریان» برمی‌گردد و فاکتورهای تأییدنشدهٔ این پروژه باطل می‌شوند.', confirmLabel: 'برگردان به در جریان', tone: 'danger' })) reopen.mutate() }}>🔄 تغییر {vendorWord}</button>}
          </div>
          {!isLocked && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-secondary" disabled={savePrices.isPending} onClick={() => savePrices.mutate()}>💾 ذخیره موقت</button>
              {/* قبل از نهایی‌سازی، قیمت‌های واردشده خودکار ذخیره می‌شوند تا با دیتابیس هم‌خوان باشند */}
              <button className="btn-primary" disabled={savePrices.isPending} onClick={async () => { try { await savePrices.mutateAsync(); setShowFinalize(true) } catch { /* پیام خطا توسط onError نمایش داده می‌شود */ } }}>نهایی‌سازی قیمت‌ها</button>
            </div>
          )}
        </div>
      </div>

      {showFinalize && <FinalizeModal pr={pr} prices={prices} isTrading={isTrading} onClose={() => setShowFinalize(false)} onDone={() => { setShowFinalize(false); qc.invalidateQueries({ queryKey: ['pricing'] }); onClose() }} />}
      {showAddProducers && <AddProducersModal id={id} isTrading={isTrading} existing={producers.map((p: any) => vid(p))} onClose={() => setShowAddProducers(false)} onDone={() => { setShowAddProducers(false); qc.invalidateQueries({ queryKey: ['pricing', id] }) }} />}
      {showArchive && <ArchivePricingModal id={id} onClose={() => setShowArchive(false)} onDone={() => { setShowArchive(false); qc.invalidateQueries({ queryKey: ['pricing'] }); onClose() }} />}
      {proformaFor && <ProformaModal id={id} vendor={proformaFor} vendorWord={vendorWord} vendorId={vid(proformaFor)} vendorName={vname(proformaFor)} locked={isLocked} onClose={() => setProformaFor(null)} onDone={() => qc.invalidateQueries({ queryKey: ['pricing', id] })} />}
    </div>
  )
}

// ─── پرفرمای فروشنده: آپلود نسخهٔ جدید + یادداشت + آرشیو نسخه‌ها ───
function ProformaModal({ id, vendorId, vendorName, locked, onClose, onDone }: any) {
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')
  const qc = useQueryClient()

  const { data: history = [] } = useQuery({
    queryKey: ['proformas', id, vendorId],
    queryFn: () => api.get(`/pricing/${id}/producers/${vendorId}/proformas`).then((r) => r.data),
  })

  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      if (file) fd.append('proforma', file)
      if (note) fd.append('proformaNote', note)
      return api.patch(`/pricing/${id}/producers/${vendorId}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    },
    onSuccess: () => {
      setFile(null); setNote('')
      qc.invalidateQueries({ queryKey: ['proformas', id, vendorId] })
      onDone()
    },
    onError: (e: any) => setErr(e.response?.data?.message || 'خطا در آپلود'),
  })

  const fileUrl = (u: string) => (u.startsWith('http') ? u : `${API_ORIGIN}${u}`)

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 520 }}>
        <div className="modal-header"><h2>پرفرمای {vendorName}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {!locked && (
            <div style={{ padding: 12, background: 'var(--bg, var(--surface-2))', borderRadius: 'var(--radius-sm)', marginBottom: 12 }}>
              <div className="form-group"><label>فایل پرفرمای جدید</label><input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></div>
              <div className="form-group"><label>توضیح (اختیاری)</label><input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: پس از مذاکره مجدد" /></div>
              <button className="btn-primary btn-sm" disabled={(!file && !note) || upload.isPending} onClick={() => upload.mutate()}>بارگذاری نسخهٔ جدید</button>
              <p className="hint-sm" style={{ marginTop: 6  }}>نسخهٔ قبلی حذف نمی‌شود؛ در آرشیو زیر می‌ماند.</p>
              {err && <div className="error-msg">{err}</div>}
            </div>
          )}
          <h4 style={{ fontSize: 13, marginBottom: 8 }}>آرشیو نسخه‌ها ({history.length})</h4>
          {history.length === 0 && <p className="hint-lg">هنوز پرفرمایی بارگذاری نشده.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {history.map((h: any, i: number) => (
              <div key={h.id} style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <a href={fileUrl(h.url)} target="_blank" rel="noreferrer">نسخه {history.length - i} {i === 0 && '(جدیدترین)'}</a>
                  {h.note && <div className="muted">{h.note}</div>}
                </div>
                <span className="hint-sm">{toShamsi(h.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer"><button onClick={onClose} className="btn-secondary">بستن</button></div>
      </div>
    </div>
  )
}

// ─── WINDOW E: WINNER SELECTION ───────────────────────
function FinalizeModal({ pr, prices, isTrading, onClose, onDone }: any) {
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const parts = pr.project.parts
  const vendorWord = isTrading ? 'تامین‌کننده' : 'سازنده'
  const itemWord = isTrading ? 'کالا' : 'قطعه'
  const vidOf = (pp: any): string => pp.producerId ?? pp.supplierId
  const vnameOf = (pp: any): string => pp.producer?.name ?? pp.supplier?.name ?? '—'
  // نگاشت شناسهٔ فروشنده → نوع (برای ارسال درست producerId/supplierId هنگام نهایی‌سازی)
  const vendorIsSupplier: Record<string, boolean> = Object.fromEntries((pr.producers || []).map((pp: any) => [vidOf(pp), !!pp.supplierId]))

  // Build groups: groupId -> parts[]; standalone parts have their own row
  const { groups, standalone } = useMemo(() => {
    const g: Record<string, any[]> = {}
    const s: any[] = []
    parts.forEach((p: any) => { if (p.groupId) { (g[p.groupId] ||= []).push(p) } else s.push(p) })
    return { groups: g, standalone: s }
  }, [parts])

  // For a set of partIds, which vendors priced ALL of them?
  function producersFor(partIds: string[]): { vendorId: string; name: string; total: number; currency: string; days?: number }[] {
    return pr.producers
      .map((pp: any) => {
        let total = 0; let currency = ''
        for (const pid of partIds) {
          const v = prices[`${pid}_${vidOf(pp)}`]
          if (!v || !v.amount) return null
          total += Number(v.amount); currency = v.currency
        }
        return { vendorId: vidOf(pp), name: vnameOf(pp), total, currency, days: pp.deliveryDays }
      })
      .filter(Boolean) as any[]
  }

  const rows = [
    ...Object.entries(groups).map(([gid, gparts]) => ({ key: `g_${gid}`, label: `گروه: ${gparts.map((p) => p.name).join(' + ')}`, partIds: gparts.map((p) => p.id) })),
    ...standalone.map((p: any) => ({ key: `p_${p.id}`, label: p.name, partIds: [p.id] })),
  ]

  const SKIP = '__SKIP__'

  const finalize = useMutation({
    mutationFn: () => {
      const sels: any[] = []
      rows.forEach((row) => {
        const vendorId = selections[row.key]
        if (vendorId && vendorId !== SKIP) {
          const vkey = vendorIsSupplier[vendorId] ? { supplierId: vendorId } : { producerId: vendorId }
          row.partIds.forEach((pid) => sels.push({ partId: pid, ...vkey }))
        }
      })
      return api.post(`/pricing/${pr.id}/finalize`, { selections: sels })
    },
    onSuccess: onDone,
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  // ردیف‌هایی که برنده دارند نهایی می‌شوند؛ بقیه (بدون قیمت یا صرف‌نظر) رد می‌شوند
  const chosenRows = rows.filter((r) => selections[r.key] && selections[r.key] !== SKIP)
  const skippedCount = rows.length - chosenRows.length

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>انتخاب {vendorWord} برنده</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <p className="hint" style={{ marginBottom: 12  }}>
            برای هر {itemWord} {vendorWord}ٔ برنده را انتخاب کن. {itemWord}‌هایی که {vendorWord} قیمت نداده یا نمی‌خواهی را روی «صرف‌نظر» بگذار — فقط {itemWord}‌های انتخاب‌شده به صدور فاکتور می‌روند.
          </p>
          {rows.map((row) => {
            const opts = producersFor(row.partIds)
            return (
              <div className="form-group" key={row.key}>
                <label>{row.label}</label>
                <select value={selections[row.key] || ''} onChange={(e) => setSelections({ ...selections, [row.key]: e.target.value })}>
                  <option value="">انتخاب {vendorWord}...</option>
                  {opts.map((o) => (
                    <option key={o.vendorId} value={o.vendorId}>
                      {o.name} — {o.total.toLocaleString()} {CUR[o.currency]}{o.days ? ` (تحویل: ${o.days} روز)` : ''}
                    </option>
                  ))}
                  <option value={SKIP}>صرف‌نظر — این {itemWord} را نمی‌خواهیم</option>
                </select>
                {opts.length === 0 && <p style={{ fontSize: 11, color: 'var(--warning, var(--warning))', marginTop: 4 }}>هیچ {vendorWord}ای برای همهٔ {itemWord}‌های این ردیف قیمت نداده — در صورت ادامه، رد می‌شود.</p>}
              </div>
            )
          })}
          {skippedCount > 0 && chosenRows.length > 0 && (
            <div style={{ marginTop: 8, padding: 8, background: 'var(--warning-soft)', border: '1px solid var(--warning-soft)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}>
              {skippedCount} ردیف بدون برنده است و در این نهایی‌سازی رد می‌شود (می‌توانی بعداً با «قیمت‌گیری مجدد» آن‌ها را پیگیری کنی).
            </div>
          )}
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={chosenRows.length === 0 || finalize.isPending} onClick={() => finalize.mutate()}>
            تأیید {chosenRows.length} {itemWord} و انتقال به صدور فاکتور
          </button>
        </div>
      </div>
    </div>
  )
}

function AddProducersModal({ id, isTrading, existing, onClose, onDone }: any) {
  const [sel, setSel] = useState<Set<string>>(new Set())
  const vendorWord = isTrading ? 'تامین‌کننده' : 'سازنده'
  const { data: vendors = [] } = useQuery({ queryKey: [isTrading ? 'suppliers' : 'producers'], queryFn: () => api.get(isTrading ? '/settings/suppliers' : '/settings/producers').then((r) => r.data) })
  const avail = vendors.filter((p: any) => !existing.includes(p.id))
  const mut = useMutation({ mutationFn: () => api.post(`/pricing/${id}/producers`, isTrading ? { supplierIds: [...sel] } : { producerIds: [...sel] }), onSuccess: onDone })
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>افزودن {vendorWord}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {avail.map((p: any) => (
            <label key={p.id} style={{ display: 'flex', gap: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', marginBottom: 6 }}>
              <input type="checkbox" style={{ width: 'auto' }} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(p.id) : n.delete(p.id); setSel(n) }} />{p.name}
            </label>
          ))}
          {avail.length === 0 && <p className="muted">{vendorWord} دیگری موجود نیست</p>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">بستن</button>
          <button className="btn-primary" disabled={sel.size === 0 || mut.isPending} onClick={() => mut.mutate()}>افزودن</button>
        </div>
      </div>
    </div>
  )
}

function ArchivePricingModal({ id, onClose, onDone }: any) {
  const [reason, setReason] = useState('')
  const mut = useMutation({ mutationFn: () => api.post(`/pricing/${id}/archive`, { reason }), onSuccess: onDone })
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>رد و بایگانی درخواست قیمت</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-group"><label>دلیل *</label><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-danger" disabled={!reason || mut.isPending} onClick={() => mut.mutate()}>بایگانی</button>
        </div>
      </div>
    </div>
  )
}
