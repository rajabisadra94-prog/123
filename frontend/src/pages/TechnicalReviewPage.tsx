import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api, { API_ORIGIN } from '../lib/api'
import { toShamsi } from '../lib/date'
import { useSort, SortTH } from '../components/shared/sortable'
import { PageHeader, TabChips, Loading, FilterToggle, TableEmpty } from '../components/ui'
import { dialog } from '../components/ui/dialog'

const STATUS_LABELS: Record<string, string> = {
  PENDING: '🟡 در انتظار بازبینی',
  APPROVED: '🟢 تأیید شده',
  REJECTED: '🔴 رد شده / نیازمند اصلاح',
}

const FILE_HOST = API_ORIGIN

const STATUS_META: Record<string, { t: string; c: string; b: string }> = {
  PENDING: { t: 'در انتظار بازبینی', c: '#92400e', b: '#fef3c7' },
  APPROVED: { t: 'تأیید شده', c: '#166534', b: '#dcfce7' },
  REJECTED: { t: 'نیازمند اصلاح', c: '#991b1b', b: '#fee2e2' },
}
const drawingsOf = (r: any) => (r.part.files || []).filter((f: any) => f.fileType === 'DRAWING_CUSTOMER' || f.fileType === 'DRAWING_ENGINEERING')

export default function TechnicalReviewPage() {
  const [statusFilter, setStatusFilter] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<any>(null)
  const sort = useSort('createdAt', 'desc')

  // همهٔ موارد را می‌گیریم و سمت کلاینت فیلتر می‌کنیم (برای شمارش تب‌ها + جستجو) — هم‌کلید با مودال
  const { data: all = [], isLoading } = useQuery({ queryKey: ['technical-review'], queryFn: () => api.get('/technical-review').then((r) => r.data) })

  const counts: Record<string, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0 }
  all.forEach((r: any) => { if (counts[r.status] !== undefined) counts[r.status]++ })

  const filtered = all.filter((r: any) => {
    if (statusFilter && r.status !== statusFilter) return false
    if (search) {
      const s = search.toLowerCase()
      return r.part.name?.toLowerCase().includes(s) || r.part.project.code?.toLowerCase().includes(s) || r.part.project.customer.name?.toLowerCase().includes(s)
    }
    return true
  })

  const sorted = sort.apply(filtered, {
    project: (r: any) => r.part.project.code,
    customer: (r: any) => r.part.project.customer?.name,
    part: (r: any) => r.part.name,
    status: (r: any) => r.status,
    createdAt: (r: any) => r.createdAt,
  })

  if (isLoading) return <div className="page" dir="rtl"><Loading /></div>

  return (
    <div className="page" dir="rtl">
      <PageHeader title="بازبینی فنی" subtitle="بازبینی و تأیید نقشه‌های فنی قطعات پیش از قیمت‌گیری"
        chips={<TabChips value={statusFilter} onChange={setStatusFilter} tabs={[
          { key: '', label: 'همه' },
          { key: 'PENDING', label: 'در انتظار', count: counts.PENDING },
          { key: 'APPROVED', label: 'تأیید', count: counts.APPROVED },
          { key: 'REJECTED', label: 'نیازمند اصلاح', count: counts.REJECTED },
        ]} />}
        filter={<FilterToggle open={showFilters} onToggle={() => setShowFilters((s) => !s)} count={search ? 1 : 0} />} />

      {showFilters && (
        <div className="filters-bar">
          <input className="search-input" placeholder="جستجو (قطعه، پروژه، مشتری)..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 280 }} />
          <span className="hint-sm" style={{ marginRight: 'auto'  }}>برای مرتب‌سازی روی سرستون‌ها کلیک کنید ⇅</span>
          {search && <button className="btn-ghost btn-sm" onClick={() => setSearch('')}>پاک‌کردن</button>}
        </div>
      )}

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <SortTH label="پروژه" k="project" sort={sort} />
              <SortTH label="مشتری" k="customer" sort={sort} />
              <SortTH label="قطعه" k="part" sort={sort} />
              <th>پیشرفت نقشه‌ها</th>
              <SortTH label="وضعیت" k="status" sort={sort} />
              <SortTH label="تاریخ دریافت" k="createdAt" sort={sort} />
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r: any) => {
              const drawings = drawingsOf(r)
              const approved = drawings.filter((f: any) => f.reviewStatus === 'APPROVED').length
              const pct = drawings.length ? (approved / drawings.length) * 100 : 0
              const st = STATUS_META[r.status] || STATUS_META.PENDING
              return (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setActive(r)}>
                  <td className="code-text">{r.part.project.code}</td>
                  <td>{r.part.project.customer.name}</td>
                  <td>{r.part.name}</td>
                  <td>
                    {drawings.length === 0 ? <span className="hint">بدون نقشه</span> : (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <span style={{ width: 70, height: 6, background: 'var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                          <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: pct === 100 ? '#16a34a' : 'var(--brand)' }} />
                        </span>
                        <span><b>{approved}</b>/{drawings.length}</span>
                      </span>
                    )}
                  </td>
                  <td>
                    <span className="status-badge" style={{ background: st.b, color: st.c }}>{st.t}</span>
                    {r.milestone && r.milestone !== 'CREATED' && <div className="hint-sm" style={{ marginTop: 2  }}>↪ به مرحلهٔ بعد رفته</div>}
                    {r.reviewer && <div className="hint-sm">{r.reviewer.name}{r.reviewedAt ? ` • ${toShamsi(r.reviewedAt)}` : ''}</div>}
                  </td>
                  <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{toShamsi(r.createdAt)}</td>
                  <td><button className="btn-sm btn-primary" onClick={(e) => { e.stopPropagation(); setActive(r) }}>{r.status === 'APPROVED' ? 'مشاهده' : 'بازبینی'}</button></td>
                </tr>
              )
            })}
            {sorted.length === 0 && (
              <TableEmpty colSpan={7}>موردی یافت نشد</TableEmpty>
            )}
          </tbody>
        </table>
      </div>

      {active && <ReviewModal review={active} onClose={() => setActive(null)} />}
    </div>
  )
}

function ReviewModal({ review, onClose }: any) {
  const qc = useQueryClient()
  const partId = review.part.id
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notes, setNotes] = useState(review.notes || '')
  const [historyFor, setHistoryFor] = useState<any>(null)

  // دادهٔ زندهٔ قطعه — پس از هر اقدام per-drawing تازه می‌شود
  const { data: list } = useQuery({ queryKey: ['technical-review'], queryFn: () => api.get('/technical-review').then((r) => r.data) })
  const current = (list || []).find((x: any) => x.part.id === partId) || review
  const part = current.part
  const drawings = (part.files || []).filter((f: any) => f.fileType === 'DRAWING_CUSTOMER' || f.fileType === 'DRAWING_ENGINEERING')

  const refetch = () => qc.invalidateQueries({ queryKey: ['technical-review'] })
  const run = async (fn: () => Promise<any>) => {
    setError(''); setBusy(true)
    try { await fn(); refetch() } catch (e: any) { setError(e.response?.data?.message || 'خطا') } finally { setBusy(false) }
  }

  const approveDrawing = (fid: string) => run(() => api.post(`/technical-review/drawing/${fid}/approve`))
  const rejectDrawing = async (fid: string) => { const reason = await dialog.prompt({ title: 'رد این نقشه', message: 'دلیل رد برای طراح ثبت می‌شود.', placeholder: 'دلیل رد…', multiline: true, required: true, tone: 'danger', confirmLabel: 'ثبت رد' }); if (!reason) return; run(() => api.post(`/technical-review/drawing/${fid}/reject`, { reason })) }
  // ۲.۳ — آپلود نسخهٔ اصلاح‌شدهٔ مهندسی (بدون نیاز به رد) → نقشه تأیید می‌شود
  const correctDrawing = async (fid: string, file: File) => { const note = (await dialog.prompt({ title: 'بارگذاری نقشهٔ اصلاح‌شده', message: 'توضیح اصلاح — اختیاری.', placeholder: 'مثلاً: ابعاد فلنج اصلاح شد', multiline: true, confirmLabel: 'بارگذاری' })) || ''; const fd = new FormData(); fd.append('drawing', file); if (note) fd.append('note', note); run(() => api.post(`/technical-review/drawing/${fid}/correct`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })) }
  const approvePartNoDrawing = () => run(async () => { const fd = new FormData(); if (notes) fd.append('notes', notes); await api.post(`/technical-review/part/${partId}/approve`, fd, { headers: { 'Content-Type': 'multipart/form-data' } }) })
  const rejectPartNoDrawing = async () => { const reason = await dialog.prompt({ title: 'رد این قطعه', message: 'قطعه بدون نقشه رد می‌شود؛ دلیل ثبت خواهد شد.', placeholder: 'دلیل رد…', multiline: true, required: true, tone: 'danger', confirmLabel: 'ثبت رد' }); if (!reason) return; run(() => api.post(`/technical-review/part/${partId}/reject`, { rejectReason: reason })) }

  const DBADGE: Record<string, { t: string; c: string; b: string }> = {
    APPROVED: { t: 'تأیید شده', c: '#166534', b: '#dcfce7' },
    REJECTED: { t: 'رد شده', c: '#991b1b', b: '#fee2e2' },
    PENDING: { t: 'در انتظار', c: '#92400e', b: '#fef3c7' },
  }
  const typeLabel = (t: string) => (t === 'DRAWING_CUSTOMER' ? 'مشتری' : 'مهندسی')

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <h2>بازبینی فنی: {part.name}</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p style={{ marginBottom: 6, fontSize: 13, color: 'var(--text-muted)' }}>
            پروژه {part.project.code} — وضعیت کلی قطعه: <strong>{STATUS_LABELS[current.status]}</strong>
          </p>
          <p style={{ marginBottom: 12, fontSize: 12, color: 'var(--text-muted)' }}>
            وضعیت قطعه از روی تک‌تک نقشه‌ها محاسبه می‌شود؛ تا همهٔ نقشه‌ها تأیید نشوند، قطعه آمادهٔ قیمت‌گیری نیست.
          </p>

          {drawings.length === 0 ? (
            <div style={{ padding: 12, background: 'var(--warning-soft)', border: '1px solid var(--warning-soft)', borderRadius: 'var(--radius-sm)', marginBottom: 12 }}>
              <p style={{ fontSize: 13, marginBottom: 8 }}>برای این قطعه نقشه‌ای آپلود نشده — می‌توانید کل قطعه را تأیید یا رد کنید.</p>
              <div className="form-group"><label>یادداشت فنی (اختیاری)</label><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-primary btn-sm" disabled={busy} onClick={approvePartNoDrawing}>✅ تأیید قطعه</button>
                {current.status !== 'APPROVED' && <button className="btn-danger btn-sm" disabled={busy} onClick={rejectPartNoDrawing}>🔴 رد قطعه</button>}
              </div>
            </div>
          ) : (
            <table className="data-table" style={{ marginBottom: 12 }}>
              <thead><tr><th>نقشه</th><th>نوع</th><th>وضعیت</th><th>اقدام</th></tr></thead>
              <tbody>
                {drawings.map((f: any) => {
                  const st = DBADGE[f.reviewStatus || 'PENDING']
                  return (
                    <tr key={f.id}>
                      <td>
                        <a href={`${FILE_HOST}${f.url}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>{(f.storedName || 'دانلود').slice(0, 26)}</a>
                        <div className="hint-sm">دریافت: {toShamsi(f.createdAt)}</div>
                      </td>
                      <td style={{ fontSize: 11 }}>{typeLabel(f.fileType)}</td>
                      <td>
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 'var(--radius-lg)', background: st.b, color: st.c }}>{st.t}</span>
                        {f.reviewStatus === 'REJECTED' && f.reviewReason && <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 2 }}>{f.reviewReason}</div>}
                        {f.reviewedAt && <div className="hint-sm" style={{ marginTop: 2  }}>بازبینی: {toShamsi(f.reviewedAt)}</div>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {f.reviewStatus !== 'APPROVED' && <button className="btn-primary btn-sm" disabled={busy} style={{ fontSize: 10 }} onClick={() => approveDrawing(f.id)}>تأیید</button>}
                          {f.reviewStatus !== 'APPROVED' && <button className="btn-danger btn-sm" disabled={busy} style={{ fontSize: 10 }} onClick={() => rejectDrawing(f.id)}>رد</button>}
                          {f.reviewStatus !== 'APPROVED' && (
                            <label className="btn-secondary btn-sm" style={{ fontSize: 10, cursor: 'pointer' }} title="آپلود نسخهٔ اصلاح‌شدهٔ مهندسی — نقشه تأیید می‌شود">
                              📐 اصلاح و تأیید
                              <input type="file" style={{ display: 'none' }} onChange={(e) => { const file = e.target.files?.[0]; if (file) correctDrawing(f.id, file) }} />
                            </label>
                          )}
                          <button className="btn-secondary btn-sm" style={{ fontSize: 10 }} onClick={() => setHistoryFor(f)}>تاریخچه</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}

          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">بستن</button>
        </div>
      </div>
      {historyFor && <DrawingHistoryModal file={historyFor} onClose={() => setHistoryFor(null)} />}
    </div>
  )
}

function DrawingHistoryModal({ file, onClose }: any) {
  const { data: history = [] } = useQuery({
    queryKey: ['drawing-history', file.id],
    queryFn: () => api.get(`/technical-review/drawing/${file.id}/history`).then((r) => r.data),
  })
  const SB: Record<string, string> = { APPROVED: '🟢 تأیید', REJECTED: '🔴 رد', PENDING: '🟡 در انتظار' }
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 520 }}>
        <div className="modal-header"><h2>تاریخچهٔ بازبینی نقشه</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {history.length === 0 && <p className="muted">تاریخچه‌ای ثبت نشده.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.map((h: any) => (
              <div key={h.id} style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}>
                <div><strong>{SB[h.status] || h.status}</strong> — {h.reviewerName || 'کاربر'} • {toShamsi(h.reviewedAt)}</div>
                {h.reason && <div style={{ color: 'var(--danger)', marginTop: 2 }}>دلیل: {h.reason}</div>}
                {h.fileUrl && <a href={`${FILE_HOST}${h.fileUrl}`} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>دانلود همان نسخه</a>}
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer"><button onClick={onClose} className="btn-secondary">بستن</button></div>
      </div>
    </div>
  )
}
