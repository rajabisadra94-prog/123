import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { Loading, EmptyState } from '../../components/ui'
import Icon from '../../components/ui/Icon'
import { toast } from '../../components/ui/dialog'
import { faDate } from '../../lib/date'
import UrgencyBoard from './UrgencyBoard'
import PromiseCard from './PromiseCard'
import { PROMISE_MAP, toneOf } from './shared'

/**
 * تعهدهای ارسال — «قرار شد چیزی برایش بفرستیم».
 * چیدمان بر اساس فوریت است نه تاریخ ثبت، چون تنها سؤال مهم این است:
 * «الان چه چیزی عقب افتاده؟»
 */
export default function Promises({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['market-promises'],
    queryFn: () => api.get('/market/promises').then((r) => r.data),
  })

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api.patch(`/market/promises/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['market-promises'] })
      qc.invalidateQueries({ queryKey: ['market-contacts'] })
      toast.success('به‌روز شد')
    },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  if (isLoading) return <Loading />
  if (!data) return null

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['market-promises'] })
    qc.invalidateQueries({ queryKey: ['market-contacts'] })
  }

  // upcoming از بک‌اند شامل بی‌تاریخ‌ها هم هست (برای سازگاری با مصرف‌کننده‌های قدیمی)؛
  // این‌جا که سطل «بدون موعد» جدا داریم، از upcoming بیرونشان می‌کشیم تا دوبار دیده نشوند
  const groups = [
    { title: 'عقب‌افتاده', icon: 'alert' as const, color: 'var(--danger)', items: data.overdue || [] },
    { title: 'موعدش امروز', icon: 'alarm' as const, color: '#d97706', items: data.today || [] },
    { title: 'در انتظار ارسال', icon: 'clock' as const, color: 'var(--brand)', items: (data.upcoming || []).filter((p: any) => p.dueAt) },
    { title: 'بدون موعد', icon: 'minus' as const, color: 'var(--text-muted)', items: data.noDate || [] },
  ]
  const pendingTotal = groups.reduce((s, g) => s + g.items.length, 0)

  if (pendingTotal === 0 && (data.done || []).length === 0) {
    return <EmptyState icon={<Icon name="package" size={26} />} title="تعهد ارسالی ثبت نشده">هر وقت به کسی قول نمونه، کاتالوگ یا لیست قیمت دادید، این‌جا ثبتش کنید تا یادتان نرود.</EmptyState>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <UrgencyBoard groups={groups}
        renderItem={(p: any) => <PromiseCard key={p.id} p={p} showContact onOpenContact={() => onOpen(p.contact.id)} onChanged={invalidate} />} />

      {(data.done || []).length > 0 && (
        <div className="panel panel-pad">
          <h4 className="section-title">ارسال‌شده‌ها ({data.done.length})</h4>
          <div className="table-container">
            <table className="data-table">
              <thead><tr><th>مخاطب</th><th>چه چیزی</th><th>تاریخ ارسال</th><th>شرکت حمل</th><th>رهگیری</th><th style={{ width: 80 }}></th></tr></thead>
              <tbody>
                {data.done.map((p: any) => {
                  const kind = toneOf(PROMISE_MAP, p.kind)
                  return (
                    <tr key={p.id}>
                      <td>
                        <button onClick={() => onOpen(p.contact.id)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, fontSize: 13 }}>{p.contact.name}</button>
                        <div className="hint-sm">{p.contact.city?.name || ''}</div>
                      </td>
                      <td style={{ fontSize: 13 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          {kind.icon && <Icon name={kind.icon} size={13} style={{ color: kind.color }} />}
                          {p.description || kind.label}{p.product ? ` — ${p.product.name}` : ''}
                        </span>
                      </td>
                      <td className="hint-sm nowrap">{p.sentAt ? faDate(p.sentAt) : '—'}</td>
                      <td className="hint-sm">{p.carrier || '—'}</td>
                      <td className="hint-sm" dir="ltr">{p.trackingNo || '—'}</td>
                      <td>
                        <button className="btn-ghost btn-sm" onClick={() => patch.mutate({ id: p.id, body: { status: 'PENDING' } })}>بازگردانی</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
