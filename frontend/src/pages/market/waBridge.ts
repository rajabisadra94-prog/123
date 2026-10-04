import { useEffect, useState, useCallback } from 'react'
import api from '../../lib/api'

/**
 * سمتِ صفحه از «صف واتساپ».
 *
 * صفحه هیچ‌وقت مستقیم با برنامهٔ روی لپ‌تاپ حرف نمی‌زند — کروم دسترسی صفحهٔ
 * اینترنتی به `localhost` را می‌بندد و امتحان هم شد و بسته بود. پس همه‌چیز از
 * همان API معمولیِ سامانه رد می‌شود: صفحه پیام را در صف می‌گذارد، و «پلِ»
 * روی لپ‌تاپ خودش سر می‌زند و برمی‌دارد.
 */

export type WaState =
  | 'offline'      // پل چند ثانیه است خبری نداده — یعنی خاموش است
  | 'starting'
  | 'qr'
  | 'connected'
  | 'logged-out'
  | 'error'

export type WaStatus = {
  status: WaState
  me?: { number: string; name?: string } | null
  qr?: string | null
  error?: string | null
  sentToday?: number
  dailyCap?: number
  minGapMs?: number
  pending: number
  failed: number
}

export type WaJobStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED'

export type WaJob = {
  id: string
  contactId: string
  phone: string
  text: string
  imageUrl?: string | null
  status: WaJobStatus
  error?: string | null
  attempts: number
  createdAt: string
  sentAt?: string | null
  bridgeOnline?: boolean
}

const EMPTY: WaStatus = { status: 'offline', pending: 0, failed: 0 }

export async function getWaStatus(): Promise<WaStatus> {
  try {
    const r = await api.get('/market/whatsapp/state')
    return { ...EMPTY, ...r.data }
  } catch {
    return EMPTY
  }
}

/** پیام را در صف می‌گذارد. عکس به‌صورت فایل می‌رود، نه base64 — تا در دیتابیس تلنبار نشود. */
export async function queueMessage(p: {
  contactId: string
  text: string
  image?: Blob | null
  filename?: string
}): Promise<WaJob> {
  const fd = new FormData()
  fd.append('contactId', p.contactId)
  fd.append('text', p.text)
  if (p.image) fd.append('image', new File([p.image], p.filename || 'products.png', { type: p.image.type || 'image/png' }))
  const r = await api.post('/market/whatsapp/jobs', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
  return r.data
}

export const getJob = (id: string): Promise<WaJob> =>
  api.get(`/market/whatsapp/jobs/${id}`).then((r) => r.data)

export const listJobs = (params: Record<string, string> = {}): Promise<WaJob[]> =>
  api.get('/market/whatsapp/jobs', { params }).then((r) => r.data)

export const retryJob = (id: string) => api.post(`/market/whatsapp/jobs/${id}/retry`)
export const dropJob = (id: string) => api.delete(`/market/whatsapp/jobs/${id}`)

export const getBridgeKey = (): Promise<string> =>
  api.get('/market/whatsapp/key').then((r) => r.data.key)
export const rotateBridgeKey = (): Promise<string> =>
  api.post('/market/whatsapp/key/rotate').then((r) => r.data.key)

/**
 * وضعیت پل را زنده نگه می‌دارد.
 * `active=false` یعنی اصلاً نپرس — وقتی کاربر نه پنجرهٔ ارسال باز کرده نه تب
 * تنظیمات، هر چند ثانیه یک درخواست فقط سر و صداست.
 */
export function useWaStatus(active: boolean, intervalMs = 4000) {
  const [status, setStatus] = useState<WaStatus>(EMPTY)

  const refresh = useCallback(async () => {
    const s = await getWaStatus()
    setStatus(s)
    return s
  }, [])

  useEffect(() => {
    if (!active) return
    let alive = true
    const tick = async () => { const s = await getWaStatus(); if (alive) setStatus(s) }
    tick()
    const t = setInterval(tick, intervalMs)
    return () => { alive = false; clearInterval(t) }
  }, [active, intervalMs])

  return { status, refresh }
}

/**
 * یک کار را دنبال می‌کند تا فرستاده شود یا شکست بخورد.
 * سقف زمانی دارد چون اگر پل خاموش باشد کار برای همیشه PENDING می‌ماند و
 * حلقهٔ بی‌پایان فقط سرور را بی‌خود می‌زند.
 */
export async function waitForJob(id: string, timeoutMs = 90_000): Promise<WaJob> {
  const until = Date.now() + timeoutMs
  let last: WaJob | null = null
  while (Date.now() < until) {
    const job = await getJob(id)
    last = job
    if (job.status === 'SENT' || job.status === 'FAILED') return job
    await new Promise((r) => setTimeout(r, 2000))
  }
  return last as WaJob
}
