import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import { toShamsi } from '../lib/date'
import DateField from '../components/shared/DateField'
import SearchableSelect from '../components/shared/SearchableSelect'
import FilterBar, { type FilterState } from '../components/shared/FilterBar'
import { usePermission } from '../lib/permissions'
import { Badge, PageHeader, TabChips, FilterToggle } from '../components/ui'
import type { Tint } from '../components/ui'

const STATUS_OPTIONS = [
  { value: 'ACTIVE', label: 'فعال' },
  { value: 'READY_FOR_INVOICE', label: 'آماده فاکتور' },
  { value: 'IN_PRODUCTION', label: 'در حال تولید' },
  { value: 'COMPLETED', label: 'تکمیل شده' },
  { value: 'ARCHIVED', label: 'بایگانی' },
]
const STATUS_LABELS: Record<string, string> = Object.fromEntries(STATUS_OPTIONS.map((o) => [o.value, o.label]))
const STATUS_TINT: Record<string, Tint> = {
  ACTIVE: 'info',
  READY_FOR_INVOICE: 'violet',
  IN_PRODUCTION: 'warning',
  COMPLETED: 'success',
  ARCHIVED: 'brand',
}
const SORT_OPTIONS = [
  { value: 'createdAt:desc', label: 'جدیدترین' },
  { value: 'createdAt:asc', label: 'قدیمی‌ترین' },
  { value: 'updatedAt:desc', label: 'آخرین ویرایش' },
  { value: 'amount:desc', label: 'بیشترین مبلغ' },
  { value: 'amount:asc', label: 'کمترین مبلغ' },
]
// انواع پروژه — ساخت (پیش‌فرض و قدیمی‌ها)، خرید کالای آماده، حمل بار (فورواردینگ)
const PROJECT_TYPE_OPTIONS = [
  { value: 'MANUFACTURING', icon: '🏭', label: 'ساخت قطعه', desc: 'ساخت سفارشی' },
  { value: 'TRADING', icon: '🛒', label: 'خرید کالا', desc: 'کالای آماده' },
  { value: 'FORWARDING', icon: '🚚', label: 'حمل بار', desc: 'فورواردینگ' },
]
const TYPE_META: Record<string, { icon: string; label: string; tint: Tint }> = {
  MANUFACTURING: { icon: '🏭', label: 'ساخت', tint: 'brand' },
  TRADING: { icon: '🛒', label: 'خرید', tint: 'violet' },
  FORWARDING: { icon: '🚚', label: 'حمل', tint: 'info' },
}

export default function ProjectsPage() {
  const qc = useQueryClient()
  const canCreate = usePermission('projects', 'create')
  const [showCreate, setShowCreate] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState<FilterState>({ sortBy: 'createdAt', sortDir: 'desc' })
  const [typeFilter, setTypeFilter] = useState('')
  // تعداد فیلترهای فعال (به‌جز مرتب‌سازی که همیشه مقدار دارد) — روی دکمهٔ «فیلتر» نشان داده می‌شود
  const activeFilterCount = (['search', 'customerId', 'producerId', 'status', 'dateFrom', 'dateTo'] as const)
    .filter((k) => (filters as any)[k]).length

  const { data: projects = [], isLoading } = useQuery({
    queryKey: ['projects', filters],
    queryFn: () => api.get('/projects', { params: filters }).then((r) => r.data),
  })

  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get('/settings/customers').then((r) => r.data),
  })

  const typeCounts: Record<string, number> = { MANUFACTURING: 0, TRADING: 0, FORWARDING: 0 }
  projects.forEach((p: any) => { if (typeCounts[p.type] !== undefined) typeCounts[p.type]++ })
  const shownProjects = typeFilter ? projects.filter((p: any) => p.type === typeFilter) : projects

  return (
    <div className="page" dir="rtl">
      <PageHeader
        title="پروژه‌ها"
        subtitle="مدیریت و پیگیری پروژه‌های سفارش"
        actions={canCreate && <button className="band-btn-primary" onClick={() => setShowCreate(true)}>+ پروژه جدید</button>}
        filter={<FilterToggle open={showFilters} onToggle={() => setShowFilters((s) => !s)} count={activeFilterCount} />}
        chips={<TabChips value={typeFilter} onChange={setTypeFilter} tabs={[
          { key: '', label: 'همه', count: projects.length },
          { key: 'MANUFACTURING', label: '🏭 ساخت', count: typeCounts.MANUFACTURING },
          { key: 'TRADING', label: '🛒 خرید', count: typeCounts.TRADING },
          { key: 'FORWARDING', label: '🚚 حمل', count: typeCounts.FORWARDING },
        ]} />}
      />

      {showFilters && (
        <div className="mb-1">
          <FilterBar
            value={filters}
            onChange={setFilters}
            show={{ search: true, customer: true, producer: true, date: true }}
            statusOptions={STATUS_OPTIONS}
            sortOptions={SORT_OPTIONS}
          />
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mt-4">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[150px] rounded-2xl bg-surface border border-line animate-pulse" />)}
        </div>
      ) : shownProjects.length === 0 ? (
        <div className="mt-8 flex flex-col items-center justify-center text-center py-16">
          <div className="w-16 h-16 rounded-2xl bg-brand-50 text-brand grid place-items-center text-3xl mb-4">📁</div>
          <div className="font-bold text-ink">پروژه‌ای یافت نشد</div>
          <div className="text-sm text-muted mt-1">با فیلترهای دیگر جستجو کنید یا پروژهٔ جدید بسازید</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mt-4">
          {shownProjects.map((p: any) => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="group no-underline block bg-surface border border-line rounded-2xl shadow-sm p-5 transition duration-200 hover:shadow-md hover:-translate-y-0.5 hover:border-line-strong"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-extrabold text-brand-800 text-[15px] tabular-nums">{p.code}</span>
                  {p.type && p.type !== 'MANUFACTURING' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-surface-2 text-muted shrink-0 whitespace-nowrap">{TYPE_META[p.type]?.icon} {TYPE_META[p.type]?.label}</span>
                  )}
                </div>
                <Badge tint={STATUS_TINT[p.status] || 'brand'}>{STATUS_LABELS[p.status] || p.status}</Badge>
              </div>
              <div className="mt-2.5 text-ink font-bold">{p.customer.name}</div>
              {p.needDate && <div className="mt-1 text-xs text-muted">تاریخ نیاز: {toShamsi(p.needDate)}</div>}
              <div className="mt-4 flex items-center gap-2.5">
                <div className="flex-1 h-2 rounded-full bg-surface-2 overflow-hidden">
                  <div className="h-full rounded-full bg-brand transition-all duration-500" style={{ width: `${p.progress}%` }} />
                </div>
                <span className="text-xs font-extrabold text-brand tabular-nums shrink-0">{p.progress}%</span>
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-xs text-muted">
                <span className="inline-grid place-items-center w-5 h-5 rounded-md bg-surface-2 text-[11px]">🔩</span>
                {p.parts.length} قطعه
              </div>
            </Link>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateProjectModal
          customers={customers}
          onClose={() => setShowCreate(false)}
          onSuccess={() => { setShowCreate(false); qc.invalidateQueries({ queryKey: ['projects'] }) }}
        />
      )}
    </div>
  )
}

function CreateProjectModal({ customers, onClose, onSuccess }: any) {
  const [customerId, setCustomerId] = useState('')
  const [type, setType] = useState('MANUFACTURING')
  const [specApproval, setSpecApproval] = useState(false)
  const [needDate, setNeedDate] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')

  const mutation = useMutation({
    mutationFn: (data: any) => api.post('/projects', data),
    onSuccess,
    onError: (err: any) => setError(err.response?.data?.message || 'خطا'),
  })

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header">
          <h2>پروژه جدید</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* نوع پروژه — سه کاشیِ فشرده در یک ردیف، توضیح در tooltip تا ارتفاع نگیرد */}
          <div className="form-group">
            <label>نوع پروژه <span className="req">*</span></label>
            <div className="type-picker">
              {PROJECT_TYPE_OPTIONS.map((t) => (
                <button key={t.value} type="button" onClick={() => setType(t.value)} title={t.desc}
                  className={`type-option ${type === t.value ? 'is-active' : ''}`} aria-pressed={type === t.value}>
                  <span className="type-icon">{t.icon}</span>
                  <span className="type-label">{t.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label>مشتری <span className="req">*</span></label>
              <SearchableSelect value={customerId} onChange={setCustomerId} placeholder="انتخاب مشتری..."
                options={customers.map((c: any) => ({ value: c.id, label: c.name }))} />
            </div>
            <div className="form-group">
              <label>تاریخ نیاز</label>
              <DateField value={needDate} onChange={setNeedDate} />
            </div>
          </div>
          <div className="form-group">
            <label>توضیحات</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="اختیاری" />
          </div>
          {type === 'TRADING' && (
            <label className="check-row">
              <input type="checkbox" style={{ width: 'auto' }} checked={specApproval} onChange={(e) => setSpecApproval(e.target.checked)} />
              <span>مشخصات کالا قبل از استعلام قیمت نیاز به تأیید دارد</span>
            </label>
          )}
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button
            className="btn-primary"
            disabled={!customerId || mutation.isPending}
            onClick={() => mutation.mutate({ customerId, needDate: needDate || undefined, description, type, specApprovalRequired: specApproval })}
          >
            {mutation.isPending ? 'در حال ذخیره...' : 'ذخیره'}
          </button>
        </div>
      </div>
    </div>
  )
}
