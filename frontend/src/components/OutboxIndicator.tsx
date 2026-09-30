import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import * as outbox from '../lib/outbox'
import Icon from './ui/Icon'
import { toast } from './ui/dialog'

/**
 * نشانگر شناورِ «چه چیزی هنوز نرفته».
 *
 * وقتی همه‌چیز آنلاین و صف خالی است هیچ نشان نمی‌دهد — نوارِ همیشه‌روشن بعد
 * از یک ساعت دیده نمی‌شود. فقط دو حالت واقعاً مهم را نشان می‌دهد: اینترنت
 * قطع است، یا چیزی هست که هنوز نرفته. بدون این، «ذخیره شد»ِ آفلاین یک
 * دروغِ بی‌سروصدا می‌شد.
 *
 * جایش پایین-چپ نیست چون نان‌استاپ toastها آن‌جا می‌نشینند.
 */
export default function OutboxIndicator() {
  const qc = useQueryClient()
  const [s, setS] = useState(outbox.getState)
  const [open, setOpen] = useState(false)

  // «ذخیره شد»ی که کاربر می‌بیند نباید بی‌قید باشد: باید بداند هنوز نرفته.
  // یک toast برای هر موج (نه برای هر رکورد) — گرید محصولات شش‌تا‌شش‌تا ذخیره
  // می‌کند و شش توست پشت‌سرهم فقط اعصاب‌خردکن است.
  useEffect(() => {
    let prev = outbox.pendingCount()
    let last = 0
    return outbox.subscribe((next) => {
      setS(next)
      const now = next.items.filter((i) => !i.failed).length
      if (now > prev && Date.now() - last > 6000) {
        last = Date.now()
        toast.info('اینترنت وصل نیست — روی همین دستگاه ذخیره شد و خودکار فرستاده می‌شود')
      }
      prev = now
    })
  }, [])
  // بعد از ارسال موفقِ صف، لیست‌ها باید از سرور تازه شوند وگرنه کاربر
  // همچنان صفحهٔ قدیمی را می‌بیند و فکر می‌کند چیزی ثبت نشده.
  useEffect(() => {
    outbox.setOnFlushed(() => {
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? '').startsWith('market') })
    })
  }, [qc])

  const pending = s.items.filter((i) => !i.failed)
  const failed = s.items.filter((i) => i.failed)
  if (s.online && !s.items.length) return null

  const tone = failed.length ? 'var(--danger)' : !s.online ? '#b45309' : 'var(--brand)'
  const label = failed.length
    ? `${failed.length} مورد ارسال نشد`
    : pending.length
      ? `${pending.length} مورد ذخیره شده${s.flushing ? ' — در حال ارسال…' : ''}`
      : 'اینترنت قطع است'

  const sendNow = async () => {
    const r = await outbox.flush()
    if (r.sent) toast.success(`${r.sent} مورد ارسال شد`)
    else if (!r.failed) toast.info('هنوز به سرور نمی‌رسیم — خودکار دوباره تلاش می‌شود')
  }

  return (
    <div style={{ position: 'fixed', bottom: 18, insetInlineEnd: 18, zIndex: 1900, maxWidth: 'min(360px, calc(100vw - 36px))' }} dir="rtl">
      {open && (
        <div className="panel panel-pad" style={{ marginBottom: 8, boxShadow: 'var(--shadow-lg)', maxHeight: '52vh', overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <strong style={{ fontSize: 13 }}>صندوق خروجی</strong>
            <button className="icon-btn" style={{ marginInlineStart: 'auto' }} onClick={() => setOpen(false)} aria-label="بستن"><Icon name="x" /></button>
          </div>
          <p className="hint-sm" style={{ marginBottom: 9 }}>
            این‌ها روی همین دستگاه ذخیره شده‌اند و به‌محض وصل‌شدن اینترنت به‌ترتیب فرستاده می‌شوند.
            بستن مرورگر هم پاکشان نمی‌کند.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {s.items.map((i) => (
              <div key={i.id} className="panel" style={{ padding: '7px 9px', display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <Icon name={i.failed ? 'alert' : 'clock'} size={14} style={{ color: i.failed ? 'var(--danger)' : 'var(--text-muted)', flex: 'none' }} />
                <span style={{ fontSize: 12.5, flex: 1, minWidth: 90 }}>{i.label}</span>
                <span className="hint-sm" style={{ flex: 'none' }}>{new Date(i.at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}</span>
                {i.failed && (
                  <>
                    <div style={{ flexBasis: '100%', fontSize: 11.5, color: 'var(--danger)' }}>{i.error}</div>
                    <button className="btn-secondary btn-sm" onClick={() => outbox.retry(i.id)}>تلاش دوباره</button>
                    <button className="icon-btn danger" title="دور بریز" aria-label={`دور انداختن ${i.label}`} onClick={() => outbox.remove(i.id)}><Icon name="trash" /></button>
                  </>
                )}
              </div>
            ))}
            {!s.items.length && <div className="hint-sm">چیزی معلق نمانده.</div>}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button className="btn-primary btn-sm" disabled={s.flushing || !pending.length} onClick={sendNow}>
              <Icon name="cloud-up" /> ارسال همه الان
            </button>
            {failed.length > 0 && <button className="btn-ghost btn-sm" onClick={outbox.clearFailed}>پاک‌کردن ناموفق‌ها</button>}
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 7, width: '100%',
          background: 'var(--surface)', border: `1px solid ${tone}`, color: tone,
          borderRadius: 999, padding: '8px 14px', fontFamily: 'inherit', fontSize: 12.5,
          fontWeight: 700, cursor: 'pointer', boxShadow: 'var(--shadow-lg)',
        }}
      >
        <Icon name={s.online ? 'cloud-up' : 'cloud-off'} size={15} />
        {label}
        <Icon name={open ? 'chevron-left' : 'chevron-right'} size={13} style={{ marginInlineStart: 'auto', opacity: .7 }} />
      </button>
    </div>
  )
}
