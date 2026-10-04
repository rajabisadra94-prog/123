import { useMutation } from '@tanstack/react-query'
import api from '../../lib/api'
import { toast } from '../../components/ui/dialog'
import Icon from '../../components/ui/Icon'
import { faDate } from '../../lib/date'
import { PROMISE_MAP, toneOf, prettyPhone, telLink, dueBucket } from './shared'
import WhatsAppButton from './WhatsAppButton'

/**
 * یک تعهد ارسال. از کامل‌ترین نسخهٔ قبلی (که فقط داخل پروندهٔ مخاطب بود)
 * عمومی شد — آن یکی فیلد حمل‌ونقل/کد رهگیری داشت که نسخهٔ تب «تعهد ارسال»
 * نداشت، پس همه‌جا از همین یکی استفاده می‌شود.
 *
 * `showContact` فقط جایی لازم است که تعهدهای چند مخاطب کنار هم دیده می‌شوند
 * (تب «تعهد ارسال»)؛ داخل پروندهٔ خودِ مخاطب (`ContactWorkspace`) لازم نیست
 * چون نام و تماس همان مخاطب از قبل بالای صفحه هست.
 */
export default function PromiseCard({ p, onChanged, showContact = false, onOpenContact }: {
  p: any
  onChanged: () => void
  showContact?: boolean
  onOpenContact?: () => void
}) {
  const kind = toneOf(PROMISE_MAP, p.kind)
  const overdue = p.status === 'PENDING' && dueBucket(p.dueAt) === 'overdue'

  const patch = useMutation({
    mutationFn: (b: any) => api.patch(`/market/promises/${p.id}`, b),
    onSuccess: () => { onChanged(); toast.success('به‌روز شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const del = useMutation({
    mutationFn: () => api.delete(`/market/promises/${p.id}`),
    onSuccess: () => { onChanged(); toast.success('حذف شد') },
  })

  return (
    <div className="panel panel-pad" style={{
      padding: 11, borderRightWidth: 3, borderRightStyle: 'solid',
      borderRightColor: p.status !== 'PENDING' ? 'var(--success)' : overdue ? 'var(--danger)' : kind.color,
    }}>
      {showContact && (
        <button onClick={onOpenContact} style={{ display: 'block', border: 'none', background: 'none', padding: 0, marginBottom: 6, cursor: 'pointer', textAlign: 'right', fontFamily: 'inherit' }}>
          <div style={{ fontSize: 12.5, fontWeight: 700 }}>{p.contact.name}</div>
          <div className="hint-sm">{p.contact.city ? `${p.contact.city.governorate} / ${p.contact.city.name}` : ''}</div>
        </button>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', fontSize: 12 }}>
        <strong style={{ color: kind.color, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {kind.icon && <Icon name={kind.icon} size={14} />}{kind.label}
        </strong>
        {p.product && <span className="chip-soft">{p.product.name}</span>}
        {p.qty ? <span className="hint-sm">{p.qty} عدد</span> : null}
        {p.dueAt && <span className="hint-sm" style={overdue ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>موعد: {faDate(p.dueAt)}</span>}
        {p.status === 'PENDING' ? (
          <button className="btn-primary btn-sm" style={{ marginRight: 'auto' }} onClick={() => patch.mutate({ status: 'SENT' })}>
            <Icon name="check" /> فرستادم
          </button>
        ) : (
          <span className="chip-soft" style={{ marginRight: 'auto', color: 'var(--success)' }}>
            <Icon name="check" size={13} /> ارسال شد {p.sentAt ? faDate(p.sentAt) : ''}
          </span>
        )}
        <button className="icon-btn danger" onClick={() => del.mutate()} title="حذف" aria-label={`حذف تعهد ${kind.label}`}><Icon name="trash" /></button>
      </div>

      {p.description && <div style={{ fontSize: 13, marginTop: 5 }}>{p.description}</div>}

      {p.status !== 'PENDING' && (
        <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
          <input placeholder="شرکت حمل" defaultValue={p.carrier || ''} style={{ fontSize: 12 }}
            onBlur={(e) => e.target.value !== (p.carrier || '') && patch.mutate({ carrier: e.target.value })} />
          <input placeholder="کد رهگیری" dir="ltr" defaultValue={p.trackingNo || ''} style={{ fontSize: 12 }}
            onBlur={(e) => e.target.value !== (p.trackingNo || '') && patch.mutate({ trackingNo: e.target.value })} />
        </div>
      )}

      {showContact && (
        <div style={{ display: 'flex', gap: 5, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {telLink(p.contact.phone) && <a className="icon-btn" href={telLink(p.contact.phone)!} title={prettyPhone(p.contact.phone)} aria-label={`تماس با ${p.contact.name}`}><Icon name="phone" /></a>}
          <WhatsAppButton contact={p.contact} iconOnly />
        </div>
      )}
    </div>
  )
}
