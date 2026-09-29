import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import { Loading, EmptyState } from '../../components/ui'
import { faDate } from '../../lib/date'
import Icon from '../../components/ui/Icon'
import UrgencyBoard from './UrgencyBoard'
import WhatsAppButton from './WhatsAppButton'
import { STATUS_MAP, toneOf, prettyPhone, telLink, stars } from './shared'

/** پیگیری‌های معلق در سه سطل: عقب‌افتاده، امروز، آینده */
export default function FollowUps({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['market-followups'],
    queryFn: () => api.get('/market/contacts/follow-ups').then((r) => r.data),
  })

  if (isLoading) return <Loading />
  if (!data) return null

  const groups = [
    { title: 'عقب‌افتاده', icon: 'alert' as const, color: 'var(--danger)', items: data.overdue || [] },
    { title: 'امروز', icon: 'alarm' as const, color: '#d97706', items: data.today || [] },
    { title: 'آینده', icon: 'clock' as const, color: 'var(--brand)', items: data.upcoming || [] },
  ]
  const total = groups.reduce((s, g) => s + g.items.length, 0)

  if (total === 0) {
    return <EmptyState icon={<Icon name="check" size={26} />} title="پیگیری معلقی ندارید">هر وقت موقع ثبت صحبت تاریخ پیگیری بگذارید، این‌جا ظاهر می‌شود و اعلان هم می‌گیرید.</EmptyState>
  }

  return (
    <UrgencyBoard groups={groups}
      renderItem={(c: any, g) => <ContactMiniCard key={c.id} c={c} color={g.color} onOpen={() => onOpen(c.id)} />} />
  )
}

export function ContactMiniCard({ c, color, onOpen }: { c: any; color?: string; onOpen: () => void }) {
  const status = toneOf(STATUS_MAP, c.status)
  const tel = telLink(c.phone)
  return (
    <div className="panel panel-pad" style={{ padding: 10 }}>
      <button onClick={onOpen} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', textAlign: 'right', width: '100%', fontFamily: 'inherit' }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{c.name}</div>
        <div className="hint-sm">
          {c.city ? `${c.city.name} · ` : ''}<span style={{ color: status.color }}>{status.label}</span>
          {c.rating ? <span style={{ color: '#d97706' }}> · {stars(c.rating)}</span> : null}
        </div>
        {c.nextFollowUpAt && (
          <div className="hint-sm" style={{ marginTop: 4, color: color || 'inherit', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Icon name="alarm" size={13} />{faDate(c.nextFollowUpAt)}{c.followUpReason ? ` — ${c.followUpReason}` : ''}
          </div>
        )}
      </button>
      <div style={{ display: 'flex', gap: 5, marginTop: 7, alignItems: 'center' }}>
        {tel && <a className="btn-secondary btn-sm" href={tel} dir="ltr"><Icon name="phone" /> {prettyPhone(c.phone)}</a>}
        <WhatsAppButton contact={c} iconOnly />
      </div>
    </div>
  )
}
