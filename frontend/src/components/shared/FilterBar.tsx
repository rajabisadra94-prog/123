import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import DateField from './DateField'

export interface FilterState {
  search?: string
  customerId?: string
  producerId?: string
  status?: string
  dateFrom?: string
  dateTo?: string
  sortBy?: string
  sortDir?: 'asc' | 'desc'
}

interface Props {
  value: FilterState
  onChange: (next: FilterState) => void
  show?: {
    search?: boolean
    customer?: boolean
    producer?: boolean
    date?: boolean
  }
  statusOptions?: { value: string; label: string }[]
  sortOptions?: { value: string; label: string }[]
}

/**
 * Reusable filter/search/sort bar (Module 11).
 * Renders only the controls enabled via `show` + optional status/sort dropdowns.
 */
export default function FilterBar({ value, onChange, show = {}, statusOptions, sortOptions }: Props) {
  const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch })

  const { data: customers = [] } = useQuery({
    queryKey: ['customers'], queryFn: () => api.get('/settings/customers').then((r) => r.data), enabled: !!show.customer,
  })
  const { data: producers = [] } = useQuery({
    queryKey: ['producers'], queryFn: () => api.get('/settings/producers').then((r) => r.data), enabled: !!show.producer,
  })

  return (
    <div className="filters-bar" style={{ flexWrap: 'wrap' }}>
      {show.search && (
        <input className="search-input" placeholder="جستجو..." value={value.search || ''} onChange={(e) => set({ search: e.target.value })} />
      )}
      {show.customer && (
        <select style={{ maxWidth: 180 }} value={value.customerId || ''} onChange={(e) => set({ customerId: e.target.value || undefined })}>
          <option value="">همه مشتریان</option>
          {customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      {show.producer && (
        <select style={{ maxWidth: 180 }} value={value.producerId || ''} onChange={(e) => set({ producerId: e.target.value || undefined })}>
          <option value="">همه سازندگان</option>
          {producers.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
      {statusOptions && (
        <select style={{ maxWidth: 170 }} value={value.status || ''} onChange={(e) => set({ status: e.target.value || undefined })}>
          <option value="">همه وضعیت‌ها</option>
          {statusOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {show.date && (
        <>
          <DateField placeholder="از تاریخ" style={{ minWidth: 150 }} value={value.dateFrom || ''} onChange={(d) => set({ dateFrom: d || undefined })} />
          <DateField placeholder="تا تاریخ" style={{ minWidth: 150 }} value={value.dateTo || ''} onChange={(d) => set({ dateTo: d || undefined })} />
        </>
      )}
      {sortOptions && (
        <select style={{ maxWidth: 200 }} value={`${value.sortBy || ''}:${value.sortDir || 'desc'}`}
          onChange={(e) => { const [sortBy, sortDir] = e.target.value.split(':'); set({ sortBy: sortBy || undefined, sortDir: sortDir as 'asc' | 'desc' }) }}>
          {sortOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </div>
  )
}
