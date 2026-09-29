import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import api from '../../lib/api'
import { toast } from '../../components/ui/dialog'
import Icon from '../../components/ui/Icon'
import DateField from '../../components/shared/DateField'
import { CALL_RESULTS, FORM_CALL_RESULTS } from './shared'

const EMPTY = { channel: 'CALL', result: '', summary: '', spokeWith: '', durationMin: '', nextFollowUpAt: '', followUpReason: '' }

/** فردا به فرمت YYYY-MM-DD — «فردا زنگ بزن» رایج‌ترین حالت است، پس یک کلیک باشد */
function inDays(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const PRESETS: [string, number][] = [['فردا', 1], ['۳ روز دیگر', 3], ['یک هفته', 7], ['دو هفته', 14], ['یک ماه', 30]]

/**
 * ثبت یک گفت‌وگو.
 *
 * چیدمانش عمداً هم‌وزن نیست. نسخهٔ قبلی شش بلوکِ هم‌اندازه پشت‌سرهم داشت و
 * «چه صحبتی شد» (مهم‌ترین فیلد) با «مدت (دقیقه)» (به‌ندرت پر می‌شود) یک‌جور
 * دیده می‌شدند، پس چشمِ کسی که وسط مکالمه است لنگر پیدا نمی‌کرد.
 * حالا فقط سه چیز پرسیده می‌شود: چه شد، چه صحبتی شد، کِی پیگیری کنیم.
 * کانال/طرفِ صحبت/مدت هم حذف شدند — پشت «جزئیات بیشتر» بودند و در عمل هیچ‌وقت
 * پر نمی‌شدند؛ کانال روی «تماس تلفنی» می‌ماند که پیش‌فرض درست همین کمپین است.
 */
export default function CallForm({ contactId, contactName, onSaved, registerFlush, compact = false, autoFocus = false }: {
  contactId: string
  contactName?: string
  onSaved?: () => void
  /** والد این را می‌دهد تا موقع بستن پرونده، پیش‌نویسِ ثبت‌نشده از بین نرود */
  registerFlush?: (fn: () => Promise<void>) => () => void
  compact?: boolean
  autoFocus?: boolean
}) {
  const [f, setF] = useState({ ...EMPTY })
  const set = (k: string, v: any) => setF((s) => ({ ...s, [k]: v }))

  // این کامپوننت با رفتن به مخاطب بعدی unmount نمی‌شود (همان جایگاه در درخت
  // است، فقط contactId عوض می‌شود). بدون این، متنِ مغازهٔ قبلی در کادرِ مغازهٔ
  // بعدی می‌ماند و به اسم او ثبت می‌شود.
  useEffect(() => { setF({ ...EMPTY }) }, [contactId])

  const save = useMutation({
    // outboxLabel فقط وقتی به کار می‌آید که اینترنت قطع باشد؛ آن‌وقت کاربر در
    // صندوق خروجی می‌بیند «گزارش گفت‌وگو — الرشید» نه یک «۱ مورد» بی‌نام.
    mutationFn: () => api.post('/market/calls', { ...f, contactId, result: f.result || undefined },
      { outboxLabel: `گزارش گفت‌وگو${contactName ? ' — ' + contactName : ''}` } as any),
    onSuccess: () => { setF({ ...EMPTY }); onSaved?.(); toast.success('گفت‌وگو ثبت شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'ثبت نشد'),
  })

  /**
   * «هرچه نوشته شده، با بستن صفحه ذخیره شود».
   *
   * `latest` لازم است چون تابعِ ثبت‌شده یک‌بار ساخته می‌شود و اگر مستقیم به `f`
   * نگاه کند، برای همیشه مقدارِ لحظهٔ ثبت را می‌بیند نه چیزی که کاربر تازه
   * تایپ کرده. متنِ گفت‌وگو اجباری است (سرور هم رد می‌کند)، پس پیش‌نویسِ بدون
   * متن — مثلاً فقط یک تاریخ پیگیری — قابل ذخیره نیست و بی‌صدا رد می‌شود.
   */
  const latest = useRef(f)
  latest.current = f
  useEffect(() => {
    if (!registerFlush) return
    return registerFlush(async () => {
      const cur = latest.current
      if (!cur.summary.trim()) return
      await save.mutateAsync()
      toast.info('گفت‌وگوی ثبت‌نشده ذخیره شد')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerFlush, contactId])


  return (
    <>
      {/* ① نتیجه — اولین چیزی که بعد از قطع‌کردن گوشی معلوم است */}
      <div className="form-group" style={{ marginBottom: 14 }}>
        <label>چه شد؟</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {CALL_RESULTS.filter((r) => FORM_CALL_RESULTS.includes(r.key)).map((r) => {
            const on = f.result === r.key
            return (
              <button key={r.key} type="button" className="pill" aria-pressed={on}
                onClick={() => set('result', on ? '' : r.key)}
                style={on ? { background: r.color } : undefined}>
                {r.icon && <Icon name={r.icon} size={14} />}{r.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* ② متن صحبت — مهم‌ترین فیلد این صفحه، پس بزرگ‌ترین و برجسته‌ترین */}
      <div className="form-group mk-hero">
        <label>چه صحبتی شد؟ *</label>
        <textarea rows={compact ? 3 : 5} autoFocus={autoFocus} value={f.summary} onChange={(e) => set('summary', e.target.value)}
          placeholder="خلاصهٔ حرف‌هایش: چه پرسید، چه گفت، چه چیزی برایش مهم بود…" />
      </div>

      {/* ③ پیگیری بعدی — در بیشتر تماس‌ها لازم است، پس باز می‌ماند */}
      <div className="form-group">
        <label className="mk-label-sub"><Icon name="alarm" size={13} /> پیگیری بعدی</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 6 }}>
          {PRESETS.map(([label, days]) => (
            <button key={days} type="button" className="pill pill-ghost"
              aria-pressed={f.nextFollowUpAt === inDays(days)}
              onClick={() => set('nextFollowUpAt', f.nextFollowUpAt === inDays(days) ? '' : inDays(days))}>{label}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <DateField style={{ minWidth: 160 }} value={f.nextFollowUpAt} onChange={(v) => set('nextFollowUpAt', v)} />
          <input style={{ flex: 1, minWidth: 160 }} value={f.followUpReason} onChange={(e) => set('followUpReason', e.target.value)} placeholder="برای چه کاری پیگیری شود" />
        </div>
      </div>

      <button className="btn-primary" style={{ marginTop: 15 }} disabled={!f.summary.trim() || save.isPending} onClick={() => save.mutate()}>
        <Icon name="check" /> {save.isPending ? 'در حال ثبت…' : 'ثبت گفت‌وگو'}
      </button>
    </>
  )
}

export { inDays }
