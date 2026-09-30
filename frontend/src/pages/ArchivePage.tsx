import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useAuthStore } from '../store/authStore'
import { formatDateTime, toShamsi } from '../lib/date'
import { useSort, SortTH } from '../components/shared/sortable'
import DateField from '../components/shared/DateField'
import { PageHeader, FilterToggle, TableEmpty } from '../components/ui'
import { dialog, toast } from '../components/ui/dialog'

const REASON_LABELS: Record<string, string> = {
  PROJECT_COMPLETED: 'تکمیل موفق',
  PRICE_REJECTED_BY_CUSTOMER: 'رد قیمت توسط مشتری',
  TECHNICAL_ISSUES: 'مشکلات فنی',
  CUSTOMER_CANCELLED: 'لغو توسط مشتری',
  OTHER: 'دیگر',
}
const ENTITY_LABELS: Record<string, string> = {
  Project: 'پروژه', Part: 'قطعه', Invoice: 'فاکتور', PricingRequest: 'درخواست قیمت',
}

// ── تبدیل snapshot خام به فارسیِ خوانا ──
const SNAP_LABELS: Record<string, string> = {
  code: 'کد', name: 'نام', quantity: 'تعداد', status: 'وضعیت', milestone: 'مرحله', technicalStatus: 'وضعیت فنی',
  customerName: 'مشتری', customer: 'مشتری', shortCode: 'کد مشتری', createdAt: 'تاریخ ایجاد', updatedAt: 'آخرین تغییر',
  targetAmount: 'قیمت هدف', targetCurrency: 'ارز هدف', weightGrams: 'وزن (گرم)', description: 'توضیحات', notes: 'یادداشت',
  versionCode: 'کد نسخه', totalAmount: 'مبلغ کل', totalCurrency: 'ارز', partCount: 'تعداد قطعه', producerCount: 'تعداد سازنده',
  materialName: 'جنس', coatingName: 'پوشش', material: 'جنس', coating: 'پوشش', phone: 'تلفن', email: 'ایمیل', address: 'آدرس',
}
const SNAP_VALUES: Record<string, string> = {
  ACTIVE: 'فعال', COMPLETED: 'تکمیل‌شده', APPROVED: 'تأیید', REJECTED: 'رد', PENDING: 'در انتظار', DRAFT: 'پیش‌نویس',
  CREATED: 'ایجادشده', IN_PRODUCTION: 'در حال ساخت', PRICED_AND_INVOICED: 'قیمت‌گیری‌شده', IRR: 'تومان', USD: 'دلار', CNY: 'یوآن',
}
function snapVal(k: string, v: any): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'بله' : 'خیر'
  if (Array.isArray(v)) return `${v.length.toLocaleString('fa-IR')} مورد`
  if (typeof v === 'object') return Object.entries(v).map(([kk, vv]) => `${SNAP_LABELS[kk] || kk}: ${snapVal(kk, vv)}`).join('، ')
  if (/(At|Date)$/.test(k) && typeof v === 'string' && v.includes('T')) { try { return toShamsi(v) } catch { return String(v) } }
  if (typeof v === 'string' && SNAP_VALUES[v]) return SNAP_VALUES[v]
  if (typeof v === 'number') return v.toLocaleString('fa-IR')
  return String(v)
}

export default function ArchivePage() {
  const qc = useQueryClient()
  const { user } = useAuthStore()
  const [entityType, setEntityType] = useState('')
  const [reason, setReason] = useState('')
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [detail, setDetail] = useState<any>(null)
  const [showFilters, setShowFilters] = useState(false)
  const activeFilterCount = [search, entityType, reason, from, to].filter(Boolean).length

  const { data: entries = [] } = useQuery({
    queryKey: ['archive', entityType, reason, from, to],
    queryFn: () => api.get('/archive', { params: { entityType: entityType || undefined, reason: reason || undefined, from: from || undefined, to: to || undefined } }).then((r) => r.data),
  })

  const filtered = entries.filter((e: any) => {
    if (!search) return true
    const s = search.toLowerCase()
    return [e.snapshot?.code, e.snapshot?.name, e.snapshot?.customerName, e.reasonNotes, e.entityId]
      .some((x: any) => (x || '').toString().toLowerCase().includes(s))
  })
  const sort = useSort('archivedAt', 'desc')
  const rows = sort.apply(filtered, {
    type: (e: any) => ENTITY_LABELS[e.entityType] || e.entityType,
    code: (e: any) => e.snapshot?.code || e.entityId,
    reason: (e: any) => REASON_LABELS[e.reason] || e.reason,
    notes: (e: any) => e.reasonNotes,
    archivedAt: (e: any) => e.archivedAt,
  })

  const restore = useMutation({
    mutationFn: (id: string) => api.post(`/archive/restore/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['archive'] }),
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/archive/${id}`, { data: { confirm: 'حذف دائمی' } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['archive'] }),
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  return (
    <div className="page" dir="rtl">
      <PageHeader title="بایگانی" subtitle="پروژه‌ها، قطعات و فاکتورهای بایگانی‌شده — با امکان بازیابی"
        filter={<FilterToggle open={showFilters} onToggle={() => setShowFilters((s) => !s)} count={activeFilterCount} />} />

      {showFilters && (
        <div className="filters-bar" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
          <input className="search-input" placeholder="جستجو (کد، نام، مشتری، توضیح)..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
          <select style={{ maxWidth: 170 }} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">همه انواع</option>
            <option value="Project">پروژه</option>
            <option value="Part">قطعه</option>
            <option value="Invoice">فاکتور</option>
            <option value="PricingRequest">درخواست قیمت</option>
          </select>
          <select style={{ maxWidth: 200 }} value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">همه دلایل</option>
            {Object.entries(REASON_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <DateField value={from} onChange={setFrom} placeholder="از تاریخ" style={{ minWidth: 140 }} />
          <DateField value={to} onChange={setTo} placeholder="تا تاریخ" style={{ minWidth: 140 }} />
          <span className="hint" style={{ alignSelf: 'center'  }}>{filtered.length} مورد</span>
        </div>
      )}

      <table className="data-table">
        <thead><tr>
          <SortTH label="نوع" k="type" sort={sort} />
          <SortTH label="شناسه" k="code" sort={sort} />
          <SortTH label="دلیل بایگانی" k="reason" sort={sort} />
          <SortTH label="توضیحات" k="notes" sort={sort} />
          <SortTH label="تاریخ بایگانی" k="archivedAt" sort={sort} />
          <th>اقدام</th>
        </tr></thead>
        <tbody>
          {rows.map((e: any) => (
            <tr key={e.id}>
              <td>{ENTITY_LABELS[e.entityType] || e.entityType}</td>
              <td className="code-text">{e.snapshot?.code || e.entityId.slice(-6)}</td>
              <td><span className="status-badge status-archived">{REASON_LABELS[e.reason] || e.reason}</span></td>
              <td style={{ fontSize: 12 }}>{e.reasonNotes || '-'}</td>
              <td style={{ fontSize: 12 }}>{formatDateTime(e.archivedAt)}</td>
              <td>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn-secondary btn-sm" onClick={() => setDetail(e)}>مشاهده</button>
                  <button className="btn-secondary btn-sm" onClick={async () => { if (await dialog.confirm({ title: 'بازیابی به بخش فعال؟', message: 'این آیتم از بایگانی خارج و دوباره در جریان کاری قابل استفاده می‌شود.', confirmLabel: 'بازیابی' })) restore.mutate(e.id) }}>بازیابی</button>
                  {user?.role === 'SUPER_ADMIN' && (
                    <button className="btn-danger btn-sm" onClick={async () => {
                      const phrase = await dialog.prompt({ title: 'حذف دائمی و بازگشت‌ناپذیر', message: 'این آیتم برای همیشه پاک می‌شود. برای تأیید، عبارت «حذف دائمی» را تایپ کنید.', placeholder: 'حذف دائمی', required: true, tone: 'danger', confirmLabel: 'حذف دائمی' })
                      if (phrase === 'حذف دائمی') remove.mutate(e.id)
                      else if (phrase !== null) toast.error('عبارت واردشده مطابقت ندارد — حذف انجام نشد.')
                    }}>حذف دائمی</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
          {rows.length === 0 && <TableEmpty colSpan={6}>آیتم بایگانی‌شده‌ای وجود ندارد</TableEmpty>}
        </tbody>
      </table>

      {detail && <ArchiveDetailModal entry={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

function ArchiveDetailModal({ entry, onClose }: any) {
  const [showRaw, setShowRaw] = useState(false)
  const snap = entry.snapshot || {}
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 560 }}>
        <div className="modal-header"><h2>جزئیات آیتم بایگانی‌شده</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', fontSize: 13, marginBottom: 14 }}>
            <b>نوع:</b><span>{ENTITY_LABELS[entry.entityType] || entry.entityType}</span>
            <b>دلیل بایگانی:</b><span>{REASON_LABELS[entry.reason] || entry.reason}</span>
            <b>توضیحات:</b><span>{entry.reasonNotes || '—'}</span>
            <b>تاریخ بایگانی:</b><span>{formatDateTime(entry.archivedAt)}</span>
          </div>

          <h3 style={{ fontSize: 13, marginBottom: 8 }}>وضعیت آیتم در لحظهٔ بایگانی</h3>
          <table className="data-table" style={{ fontSize: 13 }}>
            <tbody>
              {Object.entries(snap).map(([k, v]) => (
                <tr key={k}><td style={{ fontWeight: 600, width: 170 }}>{SNAP_LABELS[k] || k}</td><td>{snapVal(k, v)}</td></tr>
              ))}
              {Object.keys(snap).length === 0 && <tr><td colSpan={2} className="muted">اطلاعاتی ثبت نشده</td></tr>}
            </tbody>
          </table>

          <div style={{ marginTop: 12 }}>
            <button className="btn-secondary btn-sm" onClick={() => setShowRaw((s) => !s)}>{showRaw ? 'پنهان کردن داده خام' : 'نمایش داده خام (فنی)'}</button>
            {showRaw && <pre style={{ background: 'var(--bg)', padding: 10, borderRadius: 'var(--radius-sm)', fontSize: 11, marginTop: 8, overflow: 'auto', direction: 'ltr' }}>{JSON.stringify(snap, null, 2)}</pre>}
          </div>
        </div>
        <div className="modal-footer"><button onClick={onClose} className="btn-secondary">بستن</button></div>
      </div>
    </div>
  )
}
