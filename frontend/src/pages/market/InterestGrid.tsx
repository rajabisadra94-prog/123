import { useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { toast } from '../../components/ui/dialog'
import Icon from '../../components/ui/Icon'
import { LEVELS, toneOf, LEVEL_MAP, fmtIqd } from './shared'

type Interest = {
  productId: string
  level: string
  product?: { id: string; name: string; listPriceUsd: number | null; unit: string | null }
}

const LEVEL_OPTS = LEVELS.filter((l) => l.key !== 'NOT_DISCUSSED')

/**
 * نظر مخاطب دربارهٔ هر محصول — یک فهرست، نه چند کارت.
 *
 * نسخهٔ قبلی هر محصول را یک کارتِ جدا با ۷ دکمهٔ قرصیِ شناور می‌ساخت؛ روی ۵
 * محصول می‌شد ۳۵ شیء بصریِ هم‌شکل و صفحه شلوغ و ترسناک می‌شد. حالا هر ردیف
 * دو «کنترل بخش‌بخش» دارد (نظر و قیمت) که هرکدام یک شیء واحدند، و نظرِ قیمت
 * تا وقتی نظر محصول معلوم نشده کم‌رنگ می‌ماند تا ترتیب پرسیدن روشن باشد.
 *
 * پنل بازشوِ هر ردیف و بعد «نظرِ قیمت» و «نمونه خواست» هم برداشته شدند. هر سه
 * در پروداکشن صفر رکورد داده داشتند (شمرده شد)، در حالی که هر ردیف را به شش
 * دکمه و دو آیکون می‌رساندند. ستون‌هایشان در دیتابیس دست‌نخورده مانده‌اند.
 * جزئیاتِ مکالمه در «گزارش گفت‌وگو» نوشته می‌شود.
 */
export default function InterestGrid({ contactId, contactName, interests, iqdRate }: {
  contactId: string
  contactName?: string
  interests: Interest[]
  iqdRate?: number
}) {
  return (
    <div className="mk-prods">
      {interests.map((it) => (
        <ProductRow key={it.productId} contactId={contactId} contactName={contactName} interest={it} iqdRate={iqdRate} />
      ))}
    </div>
  )
}

function ProductRow({ contactId, contactName, interest, iqdRate }: {
  contactId: string; contactName?: string; interest: Interest; iqdRate?: number
}) {
  const qc = useQueryClient()
  const p = interest.product

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['market-contact', contactId] })
    qc.invalidateQueries({ queryKey: ['market-contacts'] })
    qc.invalidateQueries({ queryKey: ['market-analytics'] })
  }
  const save = useMutation({
    mutationFn: (b: any) => api.put(`/market/contacts/${contactId}/interests/${interest.productId}`, b,
      { outboxLabel: `نظر دربارهٔ ${interest.product?.name || 'محصول'}${contactName ? ' — ' + contactName : ''}` } as any),
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e.response?.data?.message || 'ثبت نشد'),
  })

  const level = toneOf(LEVEL_MAP, interest.level)
  const touched = interest.level !== 'NOT_DISCUSSED'

  return (
    <div className={`mk-prod ${touched ? 'on' : ''}`} style={touched ? { borderInlineStartColor: level.color } : undefined}>
      <div className="mk-prod-row">
        <div className="mk-prod-name">
          <strong>{p?.name}</strong>
          {p?.listPriceUsd ? (
            <span className="hint-sm" title="قیمت پایهٔ ما">
              ${p.listPriceUsd}{p.unit ? ` / ${p.unit}` : ''}
              {iqdRate ? ` · ${fmtIqd(p.listPriceUsd, iqdRate)}` : ''}
            </span>
          ) : null}
        </div>

        <div className="seg" role="group" aria-label={`نظرش دربارهٔ ${p?.name}`}>
          {LEVEL_OPTS.map((l) => {
            const on = interest.level === l.key
            return (
              <button key={l.key} type="button" title={l.label} aria-pressed={on} disabled={save.isPending}
                onClick={() => save.mutate({ level: on ? 'NOT_DISCUSSED' : l.key })}
                style={on ? { background: l.color } : undefined}>
                {l.icon && <Icon name={l.icon} size={14} />}{l.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
