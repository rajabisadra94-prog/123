/**
 * صندوق خروجی — چیزی که آفلاین ثبت شده و باید فرستاده شود.
 *
 * چرا لازم است: تماس‌گیرندهٔ کمپین عراق وسط مکالمه تایپ می‌کند. اگر همان لحظه
 * اینترنت قطع باشد، رفتار قبلیِ برنامه یک «خطا» بود و متنِ گفت‌وگو از بین
 * می‌رفت — یعنی دقیقاً همان چیزی که کل این ماژول برای از‌دست‌نرفتنش ساخته شده.
 * حالا درخواستِ ناموفق این‌جا می‌نشیند و به‌محض برگشتن اینترنت به‌ترتیب
 * فرستاده می‌شود.
 *
 * محدودهٔ کار عمداً فقط `/market` است: صف‌کردنِ بی‌صدای سندِ حسابداری یا
 * فاکتور خطرناک است، ولی «نظر مغازه‌دار دربارهٔ وارمر» نه.
 *
 * ذخیره‌سازی `localStorage` است نه IndexedDB، چون محتوا فقط JSONِ متنی است
 * (چند کیلوبایت) و همگام‌بودنش کد را به‌مراتب ساده‌تر نگه می‌دارد.
 */

const KEY = 'market.outbox.v1'
/** سقف محافظتی — اگر کاربر روزها آفلاین کار کند نباید سهمیهٔ مرورگر پر شود */
const MAX_ITEMS = 300

export type OutboxItem = {
  id: string
  at: number
  method: 'post' | 'patch' | 'put' | 'delete'
  url: string
  body: any
  label: string
  tries: number
  /** سرور جواب داد ولی رد کرد (۴xx) — تکرارِ خودکار فایده ندارد، کاربر باید تصمیم بگیرد */
  failed?: boolean
  error?: string
}

type State = { items: OutboxItem[]; online: boolean; flushing: boolean }

let items: OutboxItem[] = load()
let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false
let flushing = false

const listeners = new Set<(s: State) => void>()
const snapshot = (): State => ({ items, online, flushing })
const emit = () => listeners.forEach((l) => l(snapshot()))

export function subscribe(fn: (s: State) => void) {
  listeners.add(fn)
  fn(snapshot())
  return () => { listeners.delete(fn) }
}

export const getState = snapshot
export const pendingCount = () => items.filter((i) => !i.failed).length

function load(): OutboxItem[] {
  try {
    const raw = localStorage.getItem(KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(items)) }
  catch {
    // سهمیه پر شده: قدیمی‌ترین‌ها را بینداز تا تازه‌ترین‌ها (که کاربر همین حالا
    // نوشته) جا بمانند. سکوت نمی‌کنیم — بنر تعداد را نشان می‌دهد.
    items = items.slice(-50)
    try { localStorage.setItem(KEY, JSON.stringify(items)) } catch { /* بی‌خیال */ }
  }
}

/** آنلاین‌بودن را از ترافیک واقعی می‌فهمیم، نه از `navigator.onLine` که به وای‌فای نگاه می‌کند نه به اینترنت */
export function markOnline(v: boolean) {
  if (online === v) return
  online = v
  emit()
}

// ─── برچسب فارسی برای هر درخواست ──────────────────────────────────
// بدون این، بنر می‌شد «۳ مورد» و کاربر نمی‌دانست چه چیزی معلق مانده و
// دوباره همان را وارد می‌کرد.
const RULES: { m: string; re: RegExp; label: string }[] = [
  { m: 'post', re: /^\/market\/calls$/, label: 'گزارش گفت‌وگو' },
  { m: 'patch', re: /^\/market\/calls\//, label: 'ویرایش گفت‌وگو' },
  { m: 'delete', re: /^\/market\/calls\//, label: 'حذف گفت‌وگو' },
  { m: 'put', re: /^\/market\/contacts\/[^/]+\/interests\//, label: 'نظر دربارهٔ محصول' },
  { m: 'post', re: /^\/market\/promises$/, label: 'تعهد ارسال' },
  { m: 'patch', re: /^\/market\/promises\//, label: 'ویرایش تعهد ارسال' },
  { m: 'delete', re: /^\/market\/promises\//, label: 'حذف تعهد ارسال' },
  { m: 'post', re: /^\/market\/contacts$/, label: 'مخاطب جدید' },
  { m: 'post', re: /^\/market\/contacts\/bulk$/, label: 'اقدام گروهی' },
  { m: 'patch', re: /^\/market\/contacts\//, label: 'ویرایش مخاطب' },
  { m: 'delete', re: /^\/market\/contacts\//, label: 'حذف مخاطب' },
]

function describe(method: string, url: string): string {
  const hit = RULES.find((r) => r.m === method && r.re.test(url))
  return hit?.label || 'تغییر ثبت‌نشده'
}

/** مسیرهایی که هرگز نباید بی‌صدا صف شوند — نتیجه‌شان را کاربر همان لحظه لازم دارد */
const NEVER = [/\/convert$/, /\/import\//, /\/auth\//, /\/login/]

export function isQueueable(cfg: any): boolean {
  const method = String(cfg?.method || '').toLowerCase()
  if (!['post', 'patch', 'put', 'delete'].includes(method)) return false
  const url = String(cfg?.url || '')
  if (!url.startsWith('/market/')) return false
  if (NEVER.some((re) => re.test(url))) return false
  // فایل را در localStorage نمی‌شود گذاشت؛ آپلود آفلاین پشتیبانی نمی‌شود و
  // کاربر همان خطای معمول را می‌بیند به‌جای یک «ذخیره شد» دروغین.
  if (typeof FormData !== 'undefined' && cfg?.data instanceof FormData) return false
  return true
}

export function enqueue(cfg: any): OutboxItem {
  const method = String(cfg.method).toLowerCase() as OutboxItem['method']
  const url = String(cfg.url)
  let body = cfg.data
  if (typeof body === 'string') { try { body = JSON.parse(body) } catch { /* همان رشته بماند */ } }

  const item: OutboxItem = {
    id: `ob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    method, url, body,
    label: cfg.outboxLabel || describe(method, url),
    tries: 0,
  }
  items = [...items, item].slice(-MAX_ITEMS)
  save()
  markOnline(false)
  emit()
  return item
}

export function remove(id: string) {
  items = items.filter((i) => i.id !== id)
  save(); emit()
}

export function retry(id: string) {
  items = items.map((i) => (i.id === id ? { ...i, failed: false, error: undefined } : i))
  save(); emit()
  void flush()
}

export function clearFailed() {
  items = items.filter((i) => !i.failed)
  save(); emit()
}

// ─── ارسال دوباره ────────────────────────────────────────────────
type Sender = (item: OutboxItem) => Promise<any>
let sender: Sender | null = null
/** `lib/api` خودش را این‌جا وصل می‌کند تا این فایل به axios وابسته نشود (و حلقهٔ import نسازد) */
export function setSender(fn: Sender) { sender = fn }

let onFlushed: (() => void) | null = null
/** بعد از ارسال موفق باید کش React Query تازه شود؛ صاحبِ QueryClient این را ست می‌کند */
export function setOnFlushed(fn: () => void) { onFlushed = fn }

export async function flush(): Promise<{ sent: number; failed: number }> {
  if (flushing || !sender) return { sent: 0, failed: 0 }
  const queue = items.filter((i) => !i.failed)
  if (!queue.length) return { sent: 0, failed: 0 }

  flushing = true; emit()
  let sent = 0, failed = 0
  try {
    for (const item of queue) {
      try {
        await sender(item)
        markOnline(true)
        remove(item.id)
        sent++
      } catch (e: any) {
        if (!e?.response) {
          // هنوز قطع است. می‌ایستیم تا ترتیب به‌هم نخورد — «ویرایش مخاطب»
          // نباید قبل از «ساخت مخاطب» برود.
          markOnline(false)
          break
        }
        markOnline(true)
        const msg = e.response?.data?.message || `خطای ${e.response?.status}`
        items = items.map((i) => (i.id === item.id ? { ...i, failed: true, tries: i.tries + 1, error: msg } : i))
        save()
        failed++
      }
    }
  } finally {
    flushing = false; emit()
  }
  if (sent && onFlushed) onFlushed()
  return { sent, failed }
}

// ─── محرک‌ها ─────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { markOnline(true); void flush() })
  window.addEventListener('offline', () => markOnline(false))
  // وقتی کاربر به تب برمی‌گردد معمولاً یعنی از جای دیگری آمده — لحظهٔ خوبی برای تلاش دوباره
  window.addEventListener('focus', () => { void flush() })
  // تور امنیتی: بعضی قطعی‌ها هیچ رویدادی صادر نمی‌کنند (وای‌فای وصل، اینترنت نه)
  setInterval(() => { if (pendingCount()) void flush() }, 20_000)
}
