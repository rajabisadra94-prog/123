import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import { formatDateTime } from '../lib/date'
import DateField from '../components/shared/DateField'
import SearchableSelect from '../components/shared/SearchableSelect'
import { PageHeader, FilterToggle, TableEmpty } from '../components/ui'

const ACTION_LABELS: Record<string, string> = {
  CREATE: 'ایجاد', UPDATE: 'ویرایش', DELETE: 'حذف', LOGIN_SUCCESS: 'ورود',
}
const ENTITY_LABELS: Record<string, string> = {
  Project: 'پروژه', Part: 'قطعه', Invoice: 'فاکتور', PricingRequest: 'درخواست قیمت',
  ProductionOrder: 'سفارش', TechnicalReview: 'بازبینی فنی', Transaction: 'تراکنش',
  JournalEntry: 'سند مالی', ProjectFile: 'سند/نقشه', Customer: 'مشتری', User: 'کاربر',
  MainShipment: 'محموله', FreightInvoice: 'فاکتور حمل', Producer: 'سازنده',
}

// ── برگردان تغییرات JSON به فارسیِ خوانا ──
const KEY_LABELS: Record<string, string> = {
  status: 'وضعیت', notes: 'یادداشت', rejectReason: 'دلیل رد', reason: 'دلیل', name: 'نام', code: 'کد',
  amount: 'مبلغ', currency: 'ارز', description: 'شرح', type: 'نوع رویداد', percentage: 'درصد',
  partIds: 'قطعات', producerIds: 'سازندگان', email: 'ایمیل', phone: 'تلفن', isActive: 'فعال',
  projectCounter: 'شمارهٔ شروع پروژه', deliveryDays: 'روز تحویل', address: 'آدرس',
  drawingApproved: 'نقشهٔ تأییدشده', drawingRejected: 'نقشهٔ ردشده', partStatus: 'وضعیت قطعه',
  archivedFromPricing: 'بایگانی از قیمت‌گیری', rebuild: 'بازسازی دفاتر', ip: 'آی‌پی',
  invoicesReposted: 'فاکتورهای بازسازی‌شده', openingsPosted: 'سندهای افتتاحیه', deletedEntries: 'اسناد حذف‌شده',
  newEntries: 'اسناد جدید', freightsReposted: 'حمل‌های بازسازی‌شده', advanceAmount: 'پیش‌پرداخت',
  totalAmount: 'مبلغ کل', versionCode: 'کد نسخه', title: 'عنوان',
}
const VALUE_LABELS: Record<string, string> = {
  APPROVED: 'تأیید', REJECTED: 'رد', PENDING: 'در انتظار', COMPLETED: 'تکمیل', NEW: 'جدید',
  IN_PRODUCTION: 'در حال ساخت', QUALITY_CONTROL: 'کنترل کیفیت',
  TRANSFER: 'انتقال وجه', RECEIPT: 'دریافت', PAYMENT: 'پرداخت', CONVERSION: 'تبدیل ارز',
  ADVANCE_RECEIVED: 'دریافت پیش‌پرداخت', REFUND: 'برگشت وجه',
  IRR: 'تومان', USD: 'دلار', CNY: 'یوآن',
}
const COUNT_NOUN: Record<string, string> = { partIds: 'قطعه', producerIds: 'سازنده' }

function fmtValue(key: string, v: any): string {
  if (v === null || v === undefined || v === '') return '—'
  if (Array.isArray(v)) return `${v.length.toLocaleString('fa-IR')} ${COUNT_NOUN[key] || 'مورد'}`
  if (typeof v === 'boolean') return v ? 'بله' : 'خیر'
  if (typeof v === 'object') return Object.entries(v).map(([k, val]) => `${KEY_LABELS[k] || k}: ${fmtValue(k, val)}`).join('، ')
  if (typeof v === 'number') return v.toLocaleString('fa-IR')
  if (typeof v === 'string' && VALUE_LABELS[v]) return VALUE_LABELS[v]
  return String(v)
}
function humanize(changes: any): { label: string; value: string }[] {
  if (!changes || typeof changes !== 'object') return []
  return Object.entries(changes).map(([k, v]) => ({ label: KEY_LABELS[k] || k, value: fmtValue(k, v) }))
}
function summary(changes: any): string {
  const parts = humanize(changes)
  return parts.length ? parts.map((p) => `${p.label}: ${p.value}`).join(' • ') : '—'
}

const LIMIT = 50

export default function AuditLogPage() {
  const [action, setAction] = useState('')
  const [userId, setUserId] = useState('')
  const [entity, setEntity] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<any>(null)
  const [showFilters, setShowFilters] = useState(false)
  const activeFilterCount = [action, userId, entity, from, to].filter(Boolean).length

  const params = { action: action || undefined, userId: userId || undefined, entity: entity || undefined, from: from || undefined, to: to || undefined, page, limit: LIMIT }
  const { data } = useQuery({
    queryKey: ['audit-log', action, userId, entity, from, to, page],
    queryFn: () => api.get('/audit-log', { params }).then((r) => r.data),
  })
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users').then((r) => r.data).catch(() => []) })

  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / LIMIT))
  const resetPage = (fn: () => void) => { fn(); setPage(1) }

  return (
    <div className="page" dir="rtl">
      <PageHeader title="تاریخچه و ردپای سیستم" subtitle="ثبت همهٔ رویدادها و تغییرات کاربران در سامانه"
        filter={<FilterToggle open={showFilters} onToggle={() => setShowFilters((s) => !s)} count={activeFilterCount} />} />

      {showFilters && (
        <div className="filters-bar" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
          <select style={{ maxWidth: 150 }} value={action} onChange={(e) => resetPage(() => setAction(e.target.value))}>
            <option value="">همه عملیات‌ها</option>
            {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select style={{ maxWidth: 170 }} value={entity} onChange={(e) => resetPage(() => setEntity(e.target.value))}>
            <option value="">همه موجودیت‌ها</option>
            {Object.entries(ENTITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <SearchableSelect style={{ minWidth: 170 }} value={userId} onChange={(v) => resetPage(() => setUserId(v))} placeholder="همه کاربران"
            options={users.map((u: any) => ({ value: u.id, label: u.name }))} />
          <DateField value={from} onChange={(d) => resetPage(() => setFrom(d))} placeholder="از تاریخ" style={{ minWidth: 140 }} />
          <DateField value={to} onChange={(d) => resetPage(() => setTo(d))} placeholder="تا تاریخ" style={{ minWidth: 140 }} />
        </div>
      )}
      <p className="hint" style={{ margin: '-10px 2px 14px'  }}>{total.toLocaleString('fa-IR')} رویداد</p>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr><th>زمان</th><th>کاربر</th><th>عملیات</th><th>موجودیت</th><th>تغییرات</th><th></th></tr>
          </thead>
          <tbody>
            {data?.logs?.map((log: any) => (
              <tr key={log.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(log)}>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{formatDateTime(log.createdAt)}</td>
                <td>{log.user?.name || 'سیستم'}</td>
                <td><span className="status-badge status-active">{ACTION_LABELS[log.action] || log.action}</span></td>
                <td>{ENTITY_LABELS[log.entity] || log.entity}</td>
                <td style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {summary(log.changes)}
                </td>
                <td style={{ fontSize: 11, color: 'var(--brand)' }}>جزئیات ›</td>
              </tr>
            ))}
            {(!data?.logs || data.logs.length === 0) && <TableEmpty colSpan={6}>رویدادی یافت نشد</TableEmpty>}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button className="btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹ جدیدتر</button>
          <span style={{ fontSize: 13 }}>صفحهٔ {page.toLocaleString('fa-IR')} از {totalPages.toLocaleString('fa-IR')}</span>
          <button className="btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>قدیمی‌تر ›</button>
        </div>
      )}

      {selected && <DetailModal log={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

function DetailModal({ log, onClose }: any) {
  const [showRaw, setShowRaw] = useState(false)
  const rows = humanize(log.changes)
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 560 }}>
        <div className="modal-header"><h2>جزئیات رویداد</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px', fontSize: 13, marginBottom: 14 }}>
            <b>زمان:</b><span>{formatDateTime(log.createdAt)}</span>
            <b>کاربر:</b><span>{log.user?.name || 'سیستم'}</span>
            <b>عملیات:</b><span>{ACTION_LABELS[log.action] || log.action}</span>
            <b>موجودیت:</b><span>{ENTITY_LABELS[log.entity] || log.entity}{log.entityId ? ` (${log.entityId.slice(-8)})` : ''}</span>
          </div>

          <h4 style={{ fontSize: 13, marginBottom: 8 }}>تغییرات</h4>
          {rows.length === 0 && <p className="hint-lg">جزئیاتی ثبت نشده.</p>}
          {rows.length > 0 && (
            <table className="data-table" style={{ fontSize: 13 }}>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}><td style={{ fontWeight: 600, width: 160 }}>{r.label}</td><td>{r.value}</td></tr>
                ))}
              </tbody>
            </table>
          )}

          {log.changes && (
            <div style={{ marginTop: 12 }}>
              <button className="btn-secondary btn-sm" onClick={() => setShowRaw((s) => !s)}>{showRaw ? 'پنهان کردن داده خام' : 'نمایش داده خام'}</button>
              {showRaw && <pre style={{ background: 'var(--bg)', padding: 10, borderRadius: 'var(--radius-sm)', fontSize: 11, marginTop: 8, overflow: 'auto', direction: 'ltr' }}>{JSON.stringify(log.changes, null, 2)}</pre>}
            </div>
          )}
        </div>
        <div className="modal-footer"><button onClick={onClose} className="btn-secondary">بستن</button></div>
      </div>
    </div>
  )
}
