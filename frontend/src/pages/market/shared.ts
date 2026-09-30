/* ابزارها و واژگان مشترک ماژول «بازار صادرات» */

import type { IconName } from '../../components/ui/Icon'

/**
 * `icon` نام آیکون برداری است، نه ایموجی — ایموجی روی هر سیستم‌عامل شکل و وزن
 * متفاوتی داشت و رنگش با `color` همین شیء هماهنگ نمی‌شد.
 * توجه: داخل `<option>` نمی‌شود SVG گذاشت؛ آن‌جا فقط `label` استفاده می‌شود.
 */
export type Tone = { key: string; label: string; color: string; icon?: IconName }

/**
 * مرحله‌های پیگیری — ترتیب بر اساس «کار دستِ کیست؟»، نه گرمیِ سرنخ.
 * چون سؤال هر روزِ تیم این است: «الان سراغ کی بروم و چه کار کنم؟»
 * شش تای اول صف‌های کاری‌اند؛ بقیه برای مراحل بعدیِ معامله‌اند و در
 * چیپ‌های بالای لیست نمی‌آیند تا شلوغ نشود.
 */
export const STATUSES: Tone[] = [
  { key: 'AWAITING_QUOTE', label: 'توپ در زمین ما', color: '#dc2626', icon: 'banknote' },
  { key: 'MEETING_SET', label: 'قرار نمایشگاه/نمایندگی', color: '#7c3aed', icon: 'handshake' },
  { key: 'NEEDS_RECALL', label: 'قول بررسی داده', color: '#d97706', icon: 'repeat' },
  { key: 'ATTEMPTED', label: 'منتظر پاسخ', color: '#0891b2', icon: 'hourglass' },
  { key: 'PHONE_ONLY', label: 'فقط تماس تلفنی', color: '#2563eb', icon: 'phone' },
  { key: 'NEW', label: 'تماس نگرفته‌ایم', color: '#64748b', icon: 'circle' },
  { key: 'INTERESTED', label: 'علاقه‌مند', color: '#0891b2', icon: 'star' },
  { key: 'NEGOTIATING', label: 'در حال مذاکره', color: '#d97706', icon: 'exchange' },
  { key: 'SAMPLE_SENT', label: 'نمونه ارسال شد', color: '#7c3aed', icon: 'package' },
  { key: 'CONTACTED', label: 'صحبت شد', color: '#2563eb', icon: 'check' },
  { key: 'CUSTOMER', label: 'مشتری شد', color: '#16a34a', icon: 'trophy' },
  { key: 'NOT_INTERESTED', label: 'علاقه‌مند نیست', color: '#dc2626', icon: 'x' },
  { key: 'UNREACHABLE', label: 'در دسترس نیست', color: '#b91c1c', icon: 'phone-off' },
  { key: 'BLACKLIST', label: 'لیست سیاه', color: '#450a0a', icon: 'ban' },
]

/**
 * صف‌های کاریِ فاز پیگیری — همان‌هایی که چیپ می‌شوند.
 * از بالا به پایین: فوری‌ترین کارِ ما → کاری که هنوز شروع نشده.
 */
export const FOLLOWUP_STAGES = ['AWAITING_QUOTE', 'MEETING_SET', 'NEEDS_RECALL', 'ATTEMPTED', 'PHONE_ONLY', 'NEW'] as const

/**
 * وضعیت‌هایی که کاربر **دستی** انتخاب می‌کند.
 *
 * قیف ۱۱ حالته برای کسی که وسط تماس تلفنی است زیادی بود. بقیه حذف نشدند
 * (رکوردهای قدیمی و فیلترها همچنان می‌بینندشان)، فقط از دراپ‌داونِ ویرایش
 * برداشته شدند:
 *   NEGOTIATING → با «علاقه‌مند» هم‌پوشانی داشت
 *   BLACKLIST   → همان تیکِ «دیگر تماس نگیرید» است
 *   CUSTOMER    → فقط از دکمهٔ «تبدیل به مشتری»
 */
export const FUNNEL_STATUSES = ['NEW', 'PHONE_ONLY', 'ATTEMPTED', 'NEEDS_RECALL',
  'AWAITING_QUOTE', 'MEETING_SET', 'INTERESTED', 'SAMPLE_SENT', 'NOT_INTERESTED']

export const LEVELS: Tone[] = [
  { key: 'POSITIVE', label: 'مثبت', color: '#16a34a', icon: 'thumbs-up' },
  { key: 'NEUTRAL', label: 'خنثی', color: '#d97706', icon: 'minus' },
  { key: 'NEGATIVE', label: 'منفی', color: '#dc2626', icon: 'thumbs-down' },
  { key: 'NOT_DISCUSSED', label: 'مطرح نشده', color: '#94a3b8', icon: 'circle' },
]

export const PRICE_OPINIONS: Tone[] = [
  { key: 'GOOD', label: 'قیمت خوب', color: '#16a34a', icon: 'banknote' },
  { key: 'ACCEPTABLE', label: 'قابل قبول', color: '#d97706', icon: 'handshake' },
  { key: 'EXPENSIVE', label: 'گران است', color: '#dc2626', icon: 'alert' },
  { key: 'NOT_DISCUSSED', label: 'مطرح نشده', color: '#94a3b8', icon: 'circle' },
]

export const CHANNELS: Tone[] = [
  { key: 'CALL', label: 'تماس تلفنی', color: '#2563eb', icon: 'phone' },
  { key: 'WHATSAPP', label: 'واتساپ', color: '#16a34a', icon: 'chat' },
  { key: 'TELEGRAM', label: 'تلگرام', color: '#0ea5e9', icon: 'send' },
  { key: 'INSTAGRAM', label: 'اینستاگرام', color: '#db2777', icon: 'instagram' },
  { key: 'EMAIL', label: 'ایمیل', color: '#64748b', icon: 'mail' },
  { key: 'VISIT', label: 'ملاقات حضوری', color: '#d97706', icon: 'users' },
  { key: 'OTHER', label: 'سایر', color: '#94a3b8', icon: 'circle' },
]

export const CALL_RESULTS: Tone[] = [
  { key: 'ANSWERED', label: 'جواب داد', color: '#16a34a', icon: 'check' },
  { key: 'NO_ANSWER', label: 'جواب نداد', color: '#94a3b8', icon: 'phone-off' },
  { key: 'BUSY', label: 'مشغول بود', color: '#d97706', icon: 'hourglass' },
  { key: 'CALLBACK', label: 'گفت بعداً زنگ بزن', color: '#0891b2', icon: 'alarm' },
  { key: 'WRONG_NUMBER', label: 'شماره اشتباه', color: '#b91c1c', icon: 'ban' },
  { key: 'REJECTED', label: 'رد کرد', color: '#dc2626', icon: 'x' },
]

export const PROMISE_KINDS: Tone[] = [
  { key: 'SAMPLE', label: 'نمونهٔ محصول', color: '#7c3aed', icon: 'package' },
  { key: 'CATALOG', label: 'کاتالوگ', color: '#2563eb', icon: 'book' },
  { key: 'PRICE_LIST', label: 'لیست قیمت', color: '#0891b2', icon: 'list' },
  { key: 'QUOTE', label: 'پیش‌فاکتور', color: '#d97706', icon: 'file' },
  { key: 'VIDEO', label: 'ویدیو', color: '#db2777', icon: 'video' },
  { key: 'CERTIFICATE', label: 'گواهی/مجوز', color: '#16a34a', icon: 'award' },
  { key: 'OTHER', label: 'سایر', color: '#94a3b8', icon: 'circle' },
]

/**
 * نتایجی که در فرمِ ثبت گفت‌وگو پیشنهاد می‌شوند.
 *
 * «جواب نداد» و «مشغول بود» برداشته شدند: این کمپین فقط گفت‌وگوهای واقعی را
 * ثبت می‌کند و تماسِ بی‌جواب گزارشی ندارد که نوشته شود. از فهرست `CALL_RESULTS`
 * حذف نشدند تا رکوردهای قدیمی همچنان برچسب درست نشان بدهند.
 */
export const FORM_CALL_RESULTS = ['ANSWERED', 'CALLBACK', 'WRONG_NUMBER', 'REJECTED']

export const CONTACT_TYPES: Tone[] = [
  { key: 'SHOP', label: 'مغازه', color: '#2563eb', icon: 'store' },
  { key: 'DISTRIBUTOR', label: 'شرکت پخش', color: '#7c3aed', icon: 'truck' },
  { key: 'CLINIC', label: 'مطب / کلینیک', color: '#0891b2', icon: 'tooth' },
  { key: 'LAB', label: 'لابراتوار', color: '#d97706', icon: 'flask' },
  { key: 'IMPORTER', label: 'واردکننده', color: '#16a34a', icon: 'globe' },
  { key: 'OTHER', label: 'سایر', color: '#94a3b8', icon: 'circle' },
]

export const LANGUAGES: { key: string; label: string }[] = [
  { key: 'AR', label: 'عربی' },
  { key: 'KU', label: 'کردی' },
  { key: 'EN', label: 'انگلیسی' },
  { key: 'FA', label: 'فارسی' },
]

const index = (list: Tone[]) => Object.fromEntries(list.map((t) => [t.key, t])) as Record<string, Tone>
export const STATUS_MAP = index(STATUSES)
export const LEVEL_MAP = index(LEVELS)
export const PRICE_MAP = index(PRICE_OPINIONS)
export const CHANNEL_MAP = index(CHANNELS)
export const RESULT_MAP = index(CALL_RESULTS)
export const PROMISE_MAP = index(PROMISE_KINDS)
export const TYPE_MAP = index(CONTACT_TYPES)

/** بازگرداندن واژهٔ نمایشی امن — اگر مقدار ناشناخته بود، خودش را برگردان */
export const toneOf = (map: Record<string, Tone>, key?: string | null): Tone =>
  (key && map[key]) || { key: key || '', label: key || '—', color: 'var(--text-muted)' }

/** ۵ ستارهٔ رتبه به‌صورت آیکون — جای رشتهٔ «★★★☆☆» که با فونت سیستم رندر می‌شد */
export const ratingStars = (n?: number | null) => Array.from({ length: 5 }, (_, i) => i < (n || 0))

// ─── شمارهٔ تلفن عراق ────────────────────────────────

/**
 * همان منطق نرمال‌سازی بک‌اند، این‌جا برای ساختن لینک `tel:` و `wa.me`.
 * خروجی `964…` بدون `+` — دقیقاً چیزی که wa.me می‌خواهد.
 */
export function normalizeIraqPhone(raw?: string | null): string | null {
  if (!raw) return null
  const latin = String(raw)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
  let digits = latin.replace(/\D/g, '')
  if (!digits) return null
  // ترتیب مهم است — توضیح کامل در market.service.ts سمت بک‌اند
  if (digits.startsWith('00964')) digits = digits.slice(5)
  else if (digits.startsWith('0964')) digits = digits.slice(4)
  else if (digits.startsWith('964')) digits = digits.slice(3)
  digits = digits.replace(/^0+/, '')
  if (digits.length < 8 || digits.length > 10) return null
  return '964' + digits
}

/** نمایش خوانا: ‎+964 770 123 4567 */
export function prettyPhone(raw?: string | null): string {
  const n = normalizeIraqPhone(raw)
  if (!n) return raw || '—'
  const rest = n.slice(3)
  return `+964 ${rest.replace(/(\d{3})(\d{3})(\d+)/, '$1 $2 $3')}`
}

export const telLink = (raw?: string | null) => {
  const n = normalizeIraqPhone(raw)
  return n ? `tel:+${n}` : null
}

/** لینک واتساپ با متن آماده — روی موبایل اپ و روی دسکتاپ واتساپ‌وب باز می‌شود */
export function waLink(raw?: string | null, text?: string): string | null {
  const n = normalizeIraqPhone(raw)
  if (!n) return null
  return `https://wa.me/${n}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}

/** جای‌گیرهای قالب پیام را پر می‌کند؛ جای‌گیر بی‌مقدار خالی می‌ماند نه «undefined» */
export function fillTemplate(body: string, vars: Record<string, string | number | null | undefined>): string {
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    const v = vars[key]
    return v == null || v === '' ? '' : String(v)
  })
}

// ─── ساعت عراق ───────────────────────────────────────

/**
 * ساعت فعلی بغداد. عراق UTC+3 است و ایران UTC+3:30 — یعنی نیم‌ساعت اختلاف.
 * همین نیم‌ساعت کافی است که تماس ساعت ۸:۱۵ صبحِ ما بشود ۷:۴۵ صبحِ او.
 */
export function iraqNow(): { time: string; hour: number; ok: boolean; hint: string } {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Baghdad', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00'
  const time = `${String(hh).padStart(2, '0')}:${mm}`
  // مغازه‌های عراق معمولاً ۹ صبح تا ۹ شب بازند؛ جمعه تعطیل‌تر است
  const isFriday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Baghdad', weekday: 'short' }).format(now) === 'Fri'
  const ok = hh >= 9 && hh < 21 && !isFriday
  const hint = isFriday ? 'جمعه است — احتمالاً تعطیل' : hh < 9 ? 'هنوز زود است' : hh >= 21 ? 'دیروقت است' : 'ساعت مناسبی است'
  return { time, hour: hh, ok, hint }
}

/** روزِ محلیِ عراق برای یک لحظه، به شکل `YYYY-MM-DD` — برای مقایسهٔ «همان روز» بدون دخالت ساعت */
function iraqDayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'none'

/**
 * همان منطق `dueBucket` بک‌اند (`market.service.ts`) — این‌جا فقط برای رنگ‌کردن
 * کارت‌ها سمت کلاینت، بدون رفت‌وبرگشت به سرور. عمداً کپی است نه import مشترک،
 * چون فرانت و بک‌اند دو پکیج جدا هستند (همان الگوی `normalizeIraqPhone`).
 */
export function dueBucket(dueAt?: string | Date | null, now: Date = new Date()): DueBucket {
  if (!dueAt) return 'none'
  const due = typeof dueAt === 'string' ? new Date(dueAt) : dueAt
  const dueDay = iraqDayKey(due)
  const today = iraqDayKey(now)
  if (dueDay === today) return 'today'
  return dueDay < today ? 'overdue' : 'upcoming'
}

// ─── پول ─────────────────────────────────────────────

export const fmtUsd = (v?: number | null) =>
  v == null || v === 0 ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`

export const fmtIqd = (usd?: number | null, rate?: number) =>
  usd == null || !rate ? '' : `${Math.round(usd * rate).toLocaleString('en-US')} د.ع`

export const fmtNum = (v?: number | null) => (v == null ? '—' : Number(v).toLocaleString('en-US'))

/** ستاره‌های رتبه — ۱ تا ۵ */
export const stars = (n?: number | null) => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : '')

/**
 * گزینه‌های شهر برای انتخاب‌گر.
 * شهرهای فعال اول می‌آیند؛ غیرفعال‌ها (شهرهایی که هنوز هیچ مخاطبی ندارند)
 * حذف نمی‌شوند — فقط برچسب می‌خورند و ته لیست می‌روند، وگرنه ثبت اولین
 * لیدِ یک شهر تازه ناممکن می‌شد.
 */
export function cityOptions(cities: any[], keepId?: string | null) {
  const usable = cities.filter((c: any) => c.isActive || c.id === keepId)
  const rest = cities.filter((c: any) => !c.isActive && c.id !== keepId)
  return [
    ...usable.map((c: any) => ({ value: c.id, label: `${c.governorate} / ${c.name}` })),
    ...rest.map((c: any) => ({ value: c.id, label: `${c.governorate} / ${c.name} — بدون مخاطب` })),
  ]
}
