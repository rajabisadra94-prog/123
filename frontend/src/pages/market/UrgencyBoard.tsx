import Icon, { type IconName } from '../../components/ui/Icon'

export type UrgencyGroup<T> = { title: string; color: string; icon?: IconName; items: T[] }

/**
 * چیدمان سه/چهارستونیِ «عقب‌افتاده / امروز / آینده [/ بدون موعد]» — الگوی
 * مشترک پیگیری‌ها و تعهدهای ارسال که قبلاً هرکدام جدا و عین‌به‌عین کد شده بود.
 *
 * کلید هر آیتم باید داخل خودِ `renderItem` گذاشته شود (نه اینجا) تا کارت
 * برگشتی مستقیم فرزند این گرید باشد، بدون یک `div` واسطهٔ اضافه.
 */
export default function UrgencyBoard<T>({ groups, renderItem, emptyLabel = '—' }: {
  groups: UrgencyGroup<T>[]
  renderItem: (item: T, group: UrgencyGroup<T>) => React.ReactNode
  emptyLabel?: string
}) {
  return (
    <div className="grid-3" style={{ alignItems: 'start' }}>
      {groups.map((g) => (
        <div key={g.title} className="panel panel-pad">
          <h4 style={{ fontSize: 13, color: g.color, marginBottom: 10, fontWeight: 800, display: 'flex', alignItems: 'center', gap: 6 }}>
            {g.icon && <Icon name={g.icon} size={15} />}{g.title} <span style={{ opacity: .65 }}>({g.items.length})</span>
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {g.items.map((item) => renderItem(item, g))}
            {g.items.length === 0 && <div className="hint-sm" style={{ opacity: .6 }}>{emptyLabel}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
