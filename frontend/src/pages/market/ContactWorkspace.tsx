import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { fileUrl } from '../../lib/api'
import { Loading } from '../../components/ui'
import Icon from '../../components/ui/Icon'
import ModalPortal from '../../components/ui/ModalPortal'
import { dialog, toast } from '../../components/ui/dialog'
import SearchableSelect from '../../components/shared/SearchableSelect'
import { faDate, formatDateTime } from '../../lib/date'
import InterestGrid from './InterestGrid'
import CallForm from './CallForm'
import PromiseForm from './PromiseForm'
import PromiseCard from './PromiseCard'
import PhoneField from './PhoneField'
import {
  STATUSES, FUNNEL_STATUSES, STATUS_MAP, CONTACT_TYPES, TYPE_MAP, LANGUAGES, CHANNEL_MAP, RESULT_MAP,
  toneOf, prettyPhone, telLink, iraqNow, ratingStars, cityOptions,
} from './shared'

/** آدرس پروفایل اینستاگرام از هر شکلی که کاربر وارد کرده باشد */
const INSTA_URL = (v: string) =>
  `https://instagram.com/${String(v).replace(/^@|^https?:\/\/(www\.)?instagram\.com\//, '')}`

/** وضعیت‌هایی که یعنی کار این مخاطب تمام است — پیگیری بعدی از آن‌ها خواسته نمی‌شود */
const CLOSED = ['CUSTOMER', 'NOT_INTERESTED', 'UNREACHABLE', 'BLACKLIST']

/**
 * پروندهٔ کامل یک مخاطب — یک صفحه، بدون تب.
 *
 * چرا تب ندارد: کسی که وسط مکالمهٔ تلفنی است حافظهٔ آزاد ندارد. نسخهٔ قبلی
 * سه چیزی را که از یک تماس باید ثبت شود (متن گفت‌وگو، نظر دربارهٔ ۵ محصول،
 * تعهد ارسال) پشت سه تبِ مختلف پنهان می‌کرد و یک ستون کناری هم موازیِ
 * همان‌ها فیلد ورودی داشت؛ نتیجه این بود که کاربر گیج می‌شد و نصف چیزها
 * اصلاً ثبت نمی‌شد. حالا همه پشت‌سرهم در یک ستون‌اند، به همان ترتیبی که
 * تماس پیش می‌رود، و نوار چسبانِ بالا می‌گوید چه چیزی هنوز پر نشده.
 *
 * `navIds` لیستِ مرتبِ همان چیزی است که کاربر در صفحهٔ قبل می‌دید؛ با آن
 * می‌شود «بعدی/قبلی» زد و پشت‌سرهم زنگ زد.
 */
export default function ContactWorkspace({ id, navIds = [], onNavigate, onClose }: {
  id: string
  navIds?: string[]
  onNavigate?: (id: string) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  // فرم تعهد پیش‌فرض بسته است — بیشتر تماس‌ها قولی ندارند
  const [addingPromise, setAddingPromise] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)
  const stepRefs = useRef<Record<string, HTMLElement | null>>({})

  /**
   * پیش‌نویس‌های ثبت‌نشده.
   *
   * بیشتر فیلدهای این صفحه با هر کلیک ذخیره می‌شوند، ولی دو فرم دکمهٔ «ثبت»
   * دارند (گفت‌وگو و تعهد ارسال) و یک کادر متنی هم روی blur ذخیره می‌شود.
   * کاربر که ✕ را می‌زند، انتظار ندارد نوشته‌اش دور ریخته شود — پس هر فرم
   * تابعِ ذخیرهٔ خودش را این‌جا ثبت می‌کند و پیش از بستن یا رفتن به مخاطب
   * بعدی همه‌شان اجرا می‌شوند.
   */
  const flushers = useRef(new Set<() => Promise<void>>())
  const registerFlush = useCallback((fn: () => Promise<void>) => {
    flushers.current.add(fn)
    return () => { flushers.current.delete(fn) }
  }, [])
  const flushAll = async () => {
    for (const fn of [...flushers.current]) {
      // یک فرمِ ناموفق نباید جلوی ذخیرهٔ بقیه یا بسته‌شدن صفحه را بگیرد؛
      // خطایش را خود فرم به کاربر نشان داده است.
      try { await fn() } catch { /* ادامه */ }
    }
  }
  const closeSaving = async () => { await flushAll(); onClose() }
  const navSaving = async (to: string) => { await flushAll(); onNavigate?.(to) }

  const { data: c, isLoading } = useQuery({
    queryKey: ['market-contact', id],
    queryFn: () => api.get(`/market/contacts/${id}`).then((r) => r.data),
  })
  const { data: settings } = useQuery({
    queryKey: ['market-settings'],
    queryFn: () => api.get('/market/settings').then((r) => r.data),
    staleTime: 10 * 60 * 1000,
  })
  const iqdRate = settings?.iqdPerUsd || undefined

  const pos = navIds.indexOf(id)
  const goPrev = pos > 0 ? () => navSaving(navIds[pos - 1]) : undefined
  const goNext = pos >= 0 && pos < navIds.length - 1 ? () => navSaving(navIds[pos + 1]) : undefined

  // با عوض‌شدن مخاطب اسکرول به بالا برگردد — وگرنه نفر بعدی از وسط صفحه شروع می‌شود
  useEffect(() => { sheetRef.current?.scrollTo({ top: 0 }) }, [id])

  // Esc می‌بندد، Alt+←/→ بین مخاطب‌های همین لیست جابه‌جا می‌کند. Alt لازم است
  // چون کاربر مدام داخل کادر متن تایپ می‌کند و کلید تنها باید متن بنویسد.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { void closeSaving(); return }
      if (!e.altKey) return
      if (e.key === 'ArrowLeft' && goNext) { e.preventDefault(); goNext() }
      if (e.key === 'ArrowRight' && goPrev) { e.preventDefault(); goPrev() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['market-contact', id] })
    qc.invalidateQueries({ queryKey: ['market-contacts'] })
    qc.invalidateQueries({ queryKey: ['market-stage-counts'] })
    qc.invalidateQueries({ queryKey: ['market-analytics'] })
    qc.invalidateQueries({ queryKey: ['market-followups'] })
    qc.invalidateQueries({ queryKey: ['market-promises'] })
  }
  /**
   * یادداشتِ «محصول دیگری خواست؟».
   *
   * `null` یعنی کاربر دست نزده و مقدارِ سرور معتبر است. با رفتن به مخاطب بعدی
   * این کامپوننت unmount نمی‌شود، پس بدون ریست‌کردنِ صریح، نوشتهٔ مغازهٔ قبلی
   * در کادرِ مغازهٔ بعدی می‌ماند.
   */
  const [otherDraft, setOtherDraft] = useState<string | null>(null)
  useEffect(() => { setOtherDraft(null) }, [id])

  // این ثبت باید **بالای** returnِ زودهنگامِ حالت بارگذاری بماند، وگرنه در
  // رندر اول یک هوک کمتر اجرا می‌شود و ری‌اکت با «Rendered more hooks than
  // during the previous render» می‌شکند. خودِ تابعِ ذخیره بعداً — وقتی `c`
  // آماده شد — داخل همین ref می‌نشیند.
  const saveOtherRef = useRef<() => void>(() => {})
  useEffect(() => registerFlush(async () => { saveOtherRef.current() }), [registerFlush])

  const patch = useMutation({
    mutationFn: (b: any) => api.patch(`/market/contacts/${id}`, b),
    onSuccess: invalidate,
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  // «حذف مخاطب» و «تبدیل به مشتری» از این صفحه برداشته شدند: کارهای نادر و
  // برگشت‌ناپذیری بودند که کنار فیلدهای روزمرهٔ تماس می‌نشستند. مسیرهای API
  // (`DELETE /contacts/:id` و `POST /contacts/:id/convert`) سرِ جایشان‌اند و
  // حذف گروهی همچنان از انتخاب ردیف‌ها در لیست مخاطبین انجام می‌شود.

  if (isLoading || !c) {
    return (
      <ModalPortal>
        <div className="ws-overlay"><div style={{ margin: 'auto' }}><Loading /></div></div>
      </ModalPortal>
    )
  }

  const otherNote = otherDraft ?? (c.otherProductsNote || '')
  const saveOtherNote = () => {
    if (otherDraft == null || otherDraft === (c.otherProductsNote || '')) return
    patch.mutate({ otherProductsNote: otherDraft })
  }
  saveOtherRef.current = saveOtherNote

  const status = toneOf(STATUS_MAP, c.status)
  const iraq = iraqNow()
  const asked = c.interests.filter((i: any) => i.level !== 'NOT_DISCUSSED').length
  const total = c.interests.length
  const isClosed = CLOSED.includes(c.status)

  // یادداشتِ هر بخش وقتی ناقص است باید بگوید **چه چیزی کم است**، نه چه چیزی هست؛
  // کل کارِ این نوار جلوگیری از فراموشی است و «پیگیری ۱۴۰۵/۰۵/۳۰» کنار علامت
  // هشدار، کاربر را گمراه می‌کند که یعنی چه چیزی مانده.
  const askUnanswered = c.attendsExhibition == null || c.wantsAgency == null
  const missingWrap = [
    !isClosed && !c.nextFollowUpAt ? 'پیگیری بعدی' : '',
    c.rating == null ? 'رتبه' : '',
    // این دو تازه‌اند و کاربر عادت ندارد بپرسدشان — پس تا پر نشوند، سرِ بخش
    // می‌گوید چه چیزی مانده. همان چیزی که جلوی فراموشی را می‌گیرد.
    c.attendsExhibition == null ? 'نمایشگاه' : '',
    c.wantsAgency == null ? 'نمایندگی' : '',
  ].filter(Boolean)

  const steps: Record<string, { n: number; done: boolean; note: string }> = {
    call: {
      n: 1, done: c.calls.length > 0,
      note: c.calls.length ? `${c.calls.length} گفت‌وگو ثبت شده` : 'هنوز هیچ گفت‌وگویی ثبت نشده',
    },
    products: {
      n: 2, done: total > 0 && asked === total,
      note: asked === total ? `هر ${total} محصول پرسیده شد` : `${total - asked} محصول هنوز پرسیده نشده`,
    },
    wrap: {
      n: 3, done: (isClosed || !!c.nextFollowUpAt) && c.rating != null && !askUnanswered,
      note: missingWrap.length
        ? `${missingWrap.join(' · ')} تعیین نشده`
        : isClosed ? 'پروندهٔ بسته' : `پیگیری ${faDate(c.nextFollowUpAt)}`,
    },
  }
  const jump = (k: string) => stepRefs.current[k]?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <ModalPortal>
      <div className="ws-overlay" dir="rtl">
        {/* نوار بالا فقط چیزی را دارد که واقعاً باید همیشه ثابت بماند */}
        <header className="ws-topbar">
          <button className="ws-close" onClick={() => void closeSaving()} title="بستن (Esc) — نوشته‌های ثبت‌نشده ذخیره می‌شوند"
            aria-label="بستن پروندهٔ مخاطب"><Icon name="x" size={16} /></button>
          <h2>{c.name}</h2>
          <span className="ws-code">{c.code}</span>
          {navIds.length > 1 && pos >= 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginInlineStart: 'auto' }}>
              <span className="ws-code">{pos + 1} از {navIds.length}</span>
              <button className="band-chip" onClick={goPrev} disabled={!goPrev} title="مخاطب قبلی (Alt+→)">
                <Icon name="chevron-right" /><span className="lbl">قبلی</span>
              </button>
              <button className="band-chip" onClick={goNext} disabled={!goNext} title="مخاطب بعدی (Alt+←)">
                <span className="lbl">بعدی</span><Icon name="chevron-left" />
              </button>
            </div>
          )}
        </header>

        <div className="ws-scroll" ref={sheetRef}>
          {/* سه ستون: راست «کیست و چطور بگیریمش»، وسط «کاری که همین حالا
              انجام می‌شود»، چپ «سابقه و چیزهایی که قول داده‌ایم». ستون‌های
              کنار می‌چسبند تا وسط مکالمه با اسکرول گم نشوند. */}
          <div className="ws-grid">

            {/* ─── راست: این مخاطب کیست و چطور بگیریمش ─── */}
            <aside className="ws-side ws-side-start">
              {/* بایگانی‌شده‌ها از لیست کاری بیرون‌اند، ولی اگر مستقیم بازشان کنی
                  باید فوراً بفهمی چرا کنار گذاشته شده‌اند */}
              {c.archived && (
                <div className="ws-card" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-2)' }}>
                  <div className="ws-card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Icon name="ban" size={14} /> بایگانی شده
                  </div>
                  <div className="hint-sm" style={{ marginBottom: 8 }}>
                    {c.archivedReason || 'بدون دلیل ثبت‌شده'}
                    {c.archivedAt ? ` · ${faDate(c.archivedAt)}` : ''}
                  </div>
                  <button className="btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'center' }}
                    onClick={() => patch.mutate({ archived: false })}>
                    <Icon name="repeat" /> برگرداندن به لیست کاری
                  </button>
                </div>
              )}

              <div className="ws-card">
                <div className="ws-card-title">این مخاطب</div>
                <div className="ws-who">
                  {c.nameAr && <div>{c.nameAr}</div>}
                  <div><span className="m">شهر: </span>{c.city ? `${c.city.governorate} / ${c.city.name}` : 'مشخص نشده'}</div>
                  {c.ownerName && <div><span className="m">مسئول خرید: </span>{c.ownerName}</div>}
                  <div><span className="m">نوع: </span>{toneOf(TYPE_MAP, c.type).label}</div>
                  {c.lastContactAt && <div><span className="m">آخرین تماس: </span>{faDate(c.lastContactAt)} · {c.contactAttempts} بار</div>}
                </div>
              </div>

              <div className="ws-card">
                <div className="ws-card-title">تماس گرفتن</div>
                <div className="ws-dial">
                  {/* شماره باید در جزیرهٔ چپ‌به‌راست بنشیند. بدون آن، الگوریتم
                      دوجهته‌ی مرورگر «‎+964 776 002 2288» را داخل صفحهٔ راست‌به‌چپ
                      وارونه می‌چیند و «2288 002 776 964+» نشان می‌دهد. */}
                  {telLink(c.phone) && (
                    <a className="btn-primary" href={telLink(c.phone)!}>
                      <Icon name="phone" /> <bdi dir="ltr">{prettyPhone(c.phone)}</bdi>
                    </a>
                  )}
                  {c.phone2 && telLink(c.phone2) && (
                    <a className="btn-secondary btn-sm" href={telLink(c.phone2)!}>
                      <Icon name="phone" /> <bdi dir="ltr">{prettyPhone(c.phone2)}</bdi>
                    </a>
                  )}
                  {c.instagram && (
                    <a className="btn-secondary btn-sm" target="_blank" rel="noreferrer"
                      href={INSTA_URL(c.instagram)}>
                      <Icon name="instagram" /> اینستاگرام
                    </a>
                  )}
                  <span className={`ws-clock ${iraq.ok ? '' : 'warn'}`}>
                    <Icon name="clock" size={13} /> عراق {iraq.time} — {iraq.hint}
                  </span>
                </div>
              </div>
            </aside>

            {/* ─── وسط: مرحله‌به‌مرحله، به ترتیب یک تماس واقعی ─── */}
            <main className="ws-main-col">

            <Step id="call" refs={stepRefs} step={steps.call} title="گزارش گفت‌وگو">
              <CallForm contactId={id} contactName={c.name} autoFocus onSaved={invalidate} registerFlush={registerFlush} />
            </Step>

            <Step id="products" refs={stepRefs} step={steps.products} title="نظرش دربارهٔ محصولات">
              <p className="hint-sm" style={{ marginBottom: 10 }}>
                برای هر محصول بزنید نظرش چه بود و قیمت را چطور دید. آیکون جعبه یعنی نمونه خواسته.
              </p>
              <InterestGrid contactId={id} contactName={c.name} interests={c.interests} iqdRate={iqdRate} />

              {/* هرچه بیرون از فهرست شش‌تایی ما خواست. متن آزاد است چون از قبل
                  نمی‌دانیم چه می‌خواهند — و همین یادداشت‌ها هستند که می‌گویند
                  محصول بعدی چه باید باشد. */}
              <div className="mk-other">
                <label htmlFor="mk-other-note">درخواست محصول دیگری داشت؟</label>
                <input id="mk-other-note" value={otherNote}
                  placeholder="اگر داشت این‌جا بنویسید — مثلاً: دستکش لاتکس، ماسک، مواد قالب‌گیری"
                  onChange={(e) => setOtherDraft(e.target.value)}
                  onBlur={saveOtherNote} />
              </div>
            </Step>

            <Step id="wrap" refs={stepRefs} step={steps.wrap} title="وضعیت و ارزیابی">
              {/* دو سؤالی که تازه اضافه شده‌اند و کاربر عادت ندارد بپرسدشان.
                  تا جواب نگیرند قاب زرد می‌ماند — همین که در پس‌زمینه محو
                  نشوند، تفاوت «پرسیدم» و «یادم رفت» را می‌سازد. */}
              <div className={`ws-ask ${askUnanswered ? 'todo' : 'done'}`}>
                <div className="ws-ask-head">
                  <Icon name={askUnanswered ? 'alert' : 'check'} size={15} />
                  {askUnanswered ? 'این دو را حتماً بپرسید' : 'هر دو پرسیده شد'}
                </div>
                <div className="ws-ask-grid">
                  <TriChoice label="در نمایشگاه شرکت می‌کند؟" value={c.attendsExhibition}
                    onChange={(v) => patch.mutate({ attendsExhibition: v })} />
                  <TriChoice label="تمایل به نمایندگی دارد؟" value={c.wantsAgency}
                    onChange={(v) => patch.mutate({ wantsAgency: v })} />
                </div>
              </div>

              <div className="form-grid-2" style={{ marginTop: 13 }}>
                <div className="form-group">
                  <label>وضعیت در قیف فروش</label>
                  <select value={c.status} onChange={(e) => patch.mutate({ status: e.target.value })}
                    style={{ fontWeight: 700, color: status.color }}>
                    {/* فهرست کوتاه‌شده: «جواب نداد» خودکار از نتیجهٔ تماس می‌آید،
                        «در حال مذاکره» با «علاقه‌مند» هم‌پوشانی داشت، «لیست سیاه»
                        همان «دیگر تماس نگیرید» است و «مشتری» فقط از دکمهٔ پایین.
                        وضعیت فعلی اگر بیرون از این فهرست باشد باز هم می‌آید تا
                        رکوردهای قدیمی گیر نکنند. */}
                    {STATUSES.filter((s) => FUNNEL_STATUSES.includes(s.key) || s.key === c.status).map((s) => (
                      <option key={s.key} value={s.key}>{s.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>رتبهٔ این مخاطب</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2, minHeight: 36 }}>
                    {ratingStars(c.rating).map((on, i) => (
                      <button key={i} type="button" onClick={() => patch.mutate({ rating: c.rating === i + 1 ? null : i + 1 })}
                        title={`${i + 1} از ۵`} aria-label={`رتبه ${i + 1} از ۵`}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 3, lineHeight: 0, color: on ? '#d97706' : 'var(--border-strong)' }}>
                        <Icon name="star" size={19} style={{ fill: on ? '#d97706' : 'none' }} />
                      </button>
                    ))}
                    <span className="chip-soft" style={{ marginRight: 8 }} title="از نظرها، قیمت و پاسخ‌گویی خودکار حساب می‌شود">
                      امتیاز خودکار {c.score}
                    </span>
                  </div>
                </div>
              </div>

              <div className="hint-sm" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 2 }}>
                {c.nextFollowUpAt ? (
                  <span><Icon name="alarm" size={13} /> پیگیری بعدی: <strong>{faDate(c.nextFollowUpAt)}</strong>{c.followUpReason ? ` — ${c.followUpReason}` : ''}</span>
                ) : !isClosed ? (
                  <button onClick={() => jump('call')} className="hint-sm"
                    style={{ color: 'var(--warning)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit' }}>
                    <Icon name="alert" size={13} /> پیگیری بعدی تعیین نشده — بالا در «گزارش گفت‌وگو» مشخصش کنید
                  </button>
                ) : null}
                {c.lastContactAt && <span>آخرین تماس: {faDate(c.lastContactAt)} · {c.contactAttempts} بار</span>}
              </div>

              {/* «تبدیل به مشتری» و «حذف مخاطب» از این‌جا برداشته شدند — کارهای
                  نادر و برگشت‌ناپذیری بودند که کنار فیلدهای روزمره می‌نشستند.
                  حذف گروهی همچنان از انتخاب ردیف‌ها در لیست مخاطبین ممکن است. */}
              {c.customerId && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                  <span className="chip-soft" style={{ color: 'var(--success)' }}><Icon name="trophy" size={13} /> مشتری سیستم شده</span>
                </div>
              )}
            </Step>

            </main>

            {/* ─── چپ: چه چیزی قول داده‌ایم و چه سابقه‌ای هست ─── */}
            <aside className="ws-side ws-side-end">
              <details className="ws-fold" open={c.calls.length > 0}>
                <summary><Icon name="chat" size={15} /> تاریخچهٔ گفت‌وگوها ({c.calls.length})</summary>
                <div className="ws-fold-body">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {c.calls.map((call: any) => <CallItem key={call.id} call={call} onChanged={invalidate} />)}
                    {c.calls.length === 0 && <div className="hint-sm" style={{ opacity: .6 }}>هنوز گفت‌وگویی ثبت نشده.</div>}
                  </div>
                </div>
              </details>

              <div className="ws-card">
                <div className="ws-card-title">قرار شد چه چیزی بفرستیم</div>
                {/* تعهدهای ثبت‌شده همیشه دیده می‌شوند؛ فرمِ افزودن فقط وقتی باز
                    می‌شود که واقعاً قولی داده شده باشد — بیشتر تماس‌ها هیچ تعهدی ندارند. */}
                {c.promises.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 9 }}>
                    {c.promises.map((p: any) => <PromiseCard key={p.id} p={p} onChanged={invalidate} />)}
                  </div>
                )}
                {addingPromise ? (
                  <div className="mk-more" style={{ marginTop: 0 }}>
                    <PromiseForm contactId={id} contactName={c.name} products={c.interests.map((i: any) => i.product)}
                      registerFlush={registerFlush}
                      onSaved={() => { setAddingPromise(false); invalidate() }} />
                    <button type="button" className="btn-secondary btn-sm" style={{ marginTop: 9 }} onClick={() => setAddingPromise(false)}>
                      انصراف
                    </button>
                  </div>
                ) : (
                  <button type="button" className="mk-add-toggle" onClick={() => setAddingPromise(true)}>
                    <Icon name="plus" size={14} />
                    {c.promises.length ? 'تعهد دیگری اضافه کن' : 'قولی داده شد؟ ثبتش کن'}
                  </button>
                )}
              </div>

              <details className="ws-fold">
                <summary><Icon name="clipboard" size={15} /> مشخصات کامل و راه‌های ارتباط</summary>
                <div className="ws-fold-body"><InfoSection c={c} patch={patch} /></div>
              </details>

              <details className="ws-fold">
                <summary><Icon name="paperclip" size={15} /> پیوست‌ها ({c.files.length})</summary>
                <div className="ws-fold-body"><FilesSection c={c} onChanged={invalidate} /></div>
              </details>
            </aside>

          </div>
        </div>
      </div>
    </ModalPortal>
  )
}

/** یک بخش شماره‌دار — سرش می‌گوید کامل است یا نه */
function Step({ id, refs, step, title, children }: {
  id: string
  refs: React.MutableRefObject<Record<string, HTMLElement | null>>
  step: { n: number; done: boolean; note: string }
  title: string
  children: React.ReactNode
}) {
  return (
    <section className={`ws-step ${step.done ? 'done' : 'todo'}`} ref={(el) => { refs.current[id] = el }}>
      <div className="ws-step-head">
        <span className="ws-num">{step.done ? <Icon name="check" size={14} /> : step.n}</span>
        <h3 className="ws-step-title">{title}</h3>
        <span className="ws-step-note">{step.note}</span>
      </div>
      <div className="ws-step-body">{children}</div>
    </section>
  )
}

// ─── مشخصات ──────────────────────────────────────────
function InfoSection({ c, patch }: { c: any; patch: any }) {
  const { data: cities = [] } = useQuery({ queryKey: ['market-cities'], queryFn: () => api.get('/market/cities').then((r) => r.data) })
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users').then((r) => r.data) })
  const blur = (field: string, current: any) => (e: any) => e.target.value !== (current || '') && patch.mutate({ [field]: e.target.value })

  return (
    <>
      <div className="form-grid-2">
        <F label="نام مغازه / شرکت"><input defaultValue={c.name} onBlur={blur('name', c.name)} /></F>
        <F label="نام عربی"><input dir="rtl" defaultValue={c.nameAr || ''} onBlur={blur('nameAr', c.nameAr)} /></F>
        <F label="نام صاحب / مسئول خرید"><input defaultValue={c.ownerName || ''} onBlur={blur('ownerName', c.ownerName)} /></F>
        <F label="نوع">
          {/* داخل <option> نمی‌شود SVG گذاشت — فقط برچسب متنی */}
          <select value={c.type} onChange={(e) => patch.mutate({ type: e.target.value })}>
            {CONTACT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </F>
        <F label="شهر">
          <SearchableSelect placeholder="انتخاب شهر…" value={c.cityId || ''} onChange={(v) => patch.mutate({ cityId: v })}
            options={cityOptions(cities, c.cityId)} />
        </F>
        <F label="زبان مکالمه">
          <select value={c.language || ''} onChange={(e) => patch.mutate({ language: e.target.value })}>
            <option value="">—</option>
            {LANGUAGES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
          </select>
        </F>
        <F label="تلفن"><PhoneField value={c.phone || ''} onChange={(v) => v !== (c.phone || '') && patch.mutate({ phone: v })} /></F>
        <F label="تلفن دوم"><PhoneField value={c.phone2 || ''} onChange={(v) => v !== (c.phone2 || '') && patch.mutate({ phone2: v })} /></F>
        <F label="واتساپ"><PhoneField value={c.whatsapp || ''} onChange={(v) => v !== (c.whatsapp || '') && patch.mutate({ whatsapp: v })} /></F>
        <F label="تلگرام"><input dir="ltr" defaultValue={c.telegram || ''} onBlur={blur('telegram', c.telegram)} /></F>
        <F label="اینستاگرام"><input dir="ltr" defaultValue={c.instagram || ''} onBlur={blur('instagram', c.instagram)} /></F>
        <F label="ایمیل"><input dir="ltr" defaultValue={c.email || ''} onBlur={blur('email', c.email)} /></F>
        <F label="وب‌سایت"><input dir="ltr" defaultValue={c.website || ''} onBlur={blur('website', c.website)} /></F>
        <F label="منبع این شماره"><input defaultValue={c.source || ''} placeholder="اینستاگرام، معرفی، نمایشگاه…" onBlur={blur('source', c.source)} /></F>
        <F label="مسئول">
          <SearchableSelect placeholder="—" value={c.assignedToId || ''} onChange={(v) => patch.mutate({ assignedToId: v })}
            options={users.map((u: any) => ({ value: u.id, label: u.name }))} />
        </F>
        <F label="لینک موقعیت (نقشه)"><input dir="ltr" defaultValue={c.mapUrl || ''} onBlur={blur('mapUrl', c.mapUrl)} /></F>
      </div>
      <F label="آدرس"><textarea rows={2} defaultValue={c.address || ''} onBlur={blur('address', c.address)} /></F>
      <F label="برچسب‌ها (با ویرگول جدا کنید)">
        <input defaultValue={(c.tags || []).join('، ')}
          onBlur={(e) => patch.mutate({ tags: e.target.value.split(/[,،]/).map((s: string) => s.trim()).filter(Boolean) })} />
      </F>
      <F label="یادداشت کلی"><textarea rows={3} defaultValue={c.notes || ''} onBlur={blur('notes', c.notes)} /></F>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, marginTop: 6 }}>
        <input type="checkbox" checked={c.doNotCall} onChange={(e) => patch.mutate({ doNotCall: e.target.checked })} />
        دیگر تماس نگیرید (از صف تماس بیرون می‌رود)
      </label>
      {c.createdByName && <div className="hint-sm" style={{ marginTop: 10 }}>ثبت‌کننده: {c.createdByName} · {faDate(c.createdAt)}</div>}
    </>
  )
}

// ─── یک گفت‌وگو در تایم‌لاین ─────────────────────────
function CallItem({ call, onChanged }: { call: any; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(call.summary)
  const ch = toneOf(CHANNEL_MAP, call.channel)
  const rs = call.result ? toneOf(RESULT_MAP, call.result) : null

  const save = useMutation({
    mutationFn: () => api.patch(`/market/calls/${call.id}`, { summary: text }),
    onSuccess: () => { onChanged(); setEditing(false); toast.success('ویرایش شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const del = useMutation({
    mutationFn: () => api.delete(`/market/calls/${call.id}`),
    onSuccess: () => { onChanged(); toast.success('حذف شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const handleDelete = async () => {
    if (await dialog.confirm({ title: 'حذف این گفت‌وگو؟', message: 'برای همیشه حذف می‌شود.', confirmLabel: 'حذف', tone: 'danger' })) del.mutate()
  }

  return (
    <div className="panel panel-pad" style={{ padding: 11, borderRightWidth: 3, borderRightStyle: 'solid', borderRightColor: ch.color }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, flexWrap: 'wrap' }}>
        <strong style={{ color: ch.color, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {ch.icon && <Icon name={ch.icon} size={14} />}{ch.label}
        </strong>
        {rs && <span className="chip-soft" style={{ color: rs.color }}>{rs.icon && <Icon name={rs.icon} size={13} />}{rs.label}</span>}
        {call.spokeWith && <span className="hint-sm">با: {call.spokeWith}</span>}
        {call.durationMin ? <span className="hint-sm">{call.durationMin} دقیقه</span> : null}
        <span className="hint-sm" style={{ marginRight: 'auto' }}>{formatDateTime(call.occurredAt)}</span>
        <button className="icon-btn" onClick={() => setEditing((v) => !v)} title="ویرایش" aria-label="ویرایش این گفت‌وگو"><Icon name="pencil" /></button>
        <button className="icon-btn danger" onClick={handleDelete} title="حذف" aria-label="حذف این گفت‌وگو"><Icon name="trash" /></button>
      </div>
      {editing ? (
        <div style={{ marginTop: 7 }}>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
            <button className="btn-primary btn-sm" disabled={!text.trim() || save.isPending} onClick={() => save.mutate()}>ذخیره</button>
            <button className="btn-secondary btn-sm" onClick={() => { setEditing(false); setText(call.summary) }}>انصراف</button>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 13, marginTop: 5, whiteSpace: 'pre-wrap' }}>{call.summary}</div>
      )}
      {call.createdByName && <div className="hint-sm" style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}><Icon name="users" size={12} />{call.createdByName}</div>}
    </div>
  )
}

// ─── پیوست‌ها ────────────────────────────────────────
function FilesSection({ c, onChanged }: { c: any; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const upload = async (file: File) => {
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api.post(`/market/contacts/${c.id}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      onChanged()
      toast.success('فایل بارگذاری شد')
    } catch (e: any) { toast.error(e.response?.data?.message || 'بارگذاری نشد') }
    finally { setBusy(false) }
  }
  const del = async (id: string) => {
    try { await api.delete(`/market/files/${id}`); onChanged() } catch { toast.error('حذف نشد') }
  }

  return (
    <>
      <div className="form-group">
        <label>افزودن فایل (عکس مغازه، کارت ویزیت، لیست قیمت رقیب…)</label>
        <input type="file" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {c.files.map((f: any) => (
          <div key={f.id} className="panel panel-pad" style={{ padding: 9, display: 'flex', alignItems: 'center', gap: 8 }}>
            <a href={fileUrl(f.url)} target="_blank" rel="noreferrer" style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon name="paperclip" size={14} />{f.originalName}
            </a>
            <span className="hint-sm">{f.size ? Math.round(f.size / 1024) + ' KB' : ''}</span>
            <button className="icon-btn danger" onClick={() => del(f.id)} title="حذف" aria-label={`حذف ${f.originalName}`}><Icon name="trash" /></button>
          </div>
        ))}
        {c.files.length === 0 && <div className="hint-sm" style={{ opacity: .6 }}>فایلی پیوست نشده.</div>}
      </div>
    </>
  )
}

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="form-group"><label>{label}</label>{children}</div>
}

/**
 * پرسش بله/خیر که حالت سومی هم دارد: «هنوز نپرسیده‌ایم».
 *
 * چک‌باکس ساده این‌جا غلط بود: تیک‌نخورده یعنی «نه» و آن‌وقت هر ۱۹۰۰ مخاطبی
 * که هرگز ازشان نپرسیده‌ایم در گزارش «علاقه‌مند به نمایندگی: خیر» می‌افتادند.
 */
export function TriChoice({ label, value, onChange }: {
  label: string
  value: boolean | null | undefined
  onChange: (v: boolean | null) => void
}) {
  const opts: { v: boolean | null; label: string; icon: 'thumbs-up' | 'thumbs-down' | 'minus' }[] = [
    { v: true, label: 'بله', icon: 'thumbs-up' },
    { v: false, label: 'خیر', icon: 'thumbs-down' },
    { v: null, label: 'نپرسیدم', icon: 'minus' },
  ]
  const cur = value === undefined ? null : value
  return (
    <div className="form-group">
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 5, minHeight: 36, alignItems: 'center' }}>
        {opts.map((o) => (
          <button key={String(o.v)} type="button" className={`band-chip ${cur === o.v ? 'active' : ''}`}
            style={cur === o.v && o.v === true ? { background: 'var(--success)', borderColor: 'var(--success)' } : undefined}
            onClick={() => onChange(o.v)}>
            <Icon name={o.icon} size={13} />{o.label}
          </button>
        ))}
      </div>
    </div>
  )
}
