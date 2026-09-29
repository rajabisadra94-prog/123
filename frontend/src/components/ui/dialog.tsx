import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/* ============================================================
   FABRIK — دیالوگ و توست برنددار
   جایگزین alert / confirm / prompt بومیِ مرورگر، که فونت فارسی ندارند،
   راست‌به‌چپ نمی‌شوند، برند ندارند و روی موبایل بد می‌نشینند.

   دو شکل مصرف:
   ۱) ماژولی (بدون hook — برای onError و هر جای غیرکامپوننتی):
        import { dialog, toast } from '../components/ui/dialog'
        toast.error('خطا')
        if (!(await dialog.confirm({ title: '…' }))) return
   ۲) هوکی داخل کامپوننت: const d = useDialog()

   «تأیید» با Promise برمی‌گردد؛ prompt در صورت انصراف null می‌دهد،
   پس جایگزینی یک‌به‌یکِ کد قبلی ممکن است.
   ============================================================ */

type Tone = 'default' | 'danger'

type ConfirmOpts = { title: string; message?: ReactNode; confirmLabel?: string; cancelLabel?: string; tone?: Tone }
type AlertOpts = { title: string; message?: ReactNode; confirmLabel?: string; tone?: Tone }
type PromptOpts = {
  title: string; message?: ReactNode; placeholder?: string; defaultValue?: string
  confirmLabel?: string; cancelLabel?: string; tone?: Tone; multiline?: boolean; required?: boolean
}

type Req =
  | ({ kind: 'confirm' } & ConfirmOpts)
  | ({ kind: 'alert' } & AlertOpts)
  | ({ kind: 'prompt' } & PromptOpts)

type ToastKind = 'error' | 'success' | 'info'
type Toast = { id: number; kind: ToastKind; text: string }

type Ctx = {
  confirm: (o: ConfirmOpts) => Promise<boolean>
  alert: (o: AlertOpts) => Promise<void>
  prompt: (o: PromptOpts) => Promise<string | null>
}

const DialogCtx = createContext<Ctx | null>(null)

export function useDialog(): Ctx {
  const ctx = useContext(DialogCtx)
  if (!ctx) throw new Error('useDialog باید داخل <DialogProvider> استفاده شود')
  return ctx
}

/* ── پل ماژولی: provider هنگام mount خودش را اینجا ثبت می‌کند ── */
let impl: (Ctx & { toast: (kind: ToastKind, text: string) => void }) | null = null
const notMounted = () => { throw new Error('<DialogProvider> در ریشهٔ برنامه mount نشده است') }

export const dialog: Ctx = {
  confirm: (o) => (impl ? impl.confirm(o) : notMounted()),
  alert: (o) => (impl ? impl.alert(o) : notMounted()),
  prompt: (o) => (impl ? impl.prompt(o) : notMounted()),
}

export const toast = {
  error: (text: string) => impl?.toast('error', text),
  success: (text: string) => impl?.toast('success', text),
  info: (text: string) => impl?.toast('info', text),
}

const TOAST_ICON: Record<ToastKind, string> = { error: '⚠', success: '✓', info: 'i' }

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<Req | null>(null)
  const [value, setValue] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const resolver = useRef<((v: any) => void) | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)
  const seq = useRef(0)

  const open = useCallback((r: Req, initial = '') => {
    setValue(initial)
    setReq(r)
    return new Promise<any>((resolve) => { resolver.current = resolve })
  }, [])

  const close = useCallback((result: any) => {
    resolver.current?.(result)
    resolver.current = null
    setReq(null)
    setValue('')
  }, [])

  const pushToast = useCallback((kind: ToastKind, text: string) => {
    const id = ++seq.current
    setToasts((t) => [...t, { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3500)
  }, [])

  const api = useRef<Ctx>({
    confirm: (o) => open({ kind: 'confirm', ...o }),
    alert: (o) => open({ kind: 'alert', ...o }).then(() => undefined),
    prompt: (o) => open({ kind: 'prompt', ...o }, o.defaultValue || ''),
  }).current

  // ثبت پیاده‌سازی برای مصرف‌کننده‌های ماژولی
  useEffect(() => {
    impl = { ...api, toast: pushToast }
    return () => { impl = null }
  }, [api, pushToast])

  // فوکوس خودکار روی ورودی، و بستن با Escape
  useEffect(() => {
    if (!req) return
    if (req.kind === 'prompt') setTimeout(() => inputRef.current?.focus(), 30)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req, close])

  const danger = req?.tone === 'danger'
  const canSubmit = req?.kind !== 'prompt' || !req.required || value.trim().length > 0

  const submit = () => {
    if (!req) return
    if (req.kind === 'prompt') { if (!canSubmit) return; close(value) }
    else close(req.kind === 'confirm' ? true : undefined)
  }

  return (
    <DialogCtx.Provider value={api}>
      {children}

      {req && (
        <div className="modal-overlay" onMouseDown={(e) => {
          if (e.target === e.currentTarget) close(req.kind === 'confirm' ? false : req.kind === 'prompt' ? null : undefined)
        }}>
          <div className="modal dialog-modal" dir="rtl" role="alertdialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
            <div className="dialog-body">
              <div className={`dialog-icon ${danger ? 'is-danger' : ''}`} aria-hidden="true">{danger ? '!' : '؟'}</div>
              <div className="dialog-text">
                <h3 className="dialog-title">{req.title}</h3>
                {req.message && <div className="dialog-message">{req.message}</div>}
                {req.kind === 'prompt' && (
                  req.multiline ? (
                    <textarea ref={inputRef as any} rows={3} className="dialog-input" placeholder={req.placeholder}
                      value={value} onChange={(e) => setValue(e.target.value)} />
                  ) : (
                    <input ref={inputRef as any} className="dialog-input" placeholder={req.placeholder}
                      value={value} onChange={(e) => setValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
                  )
                )}
              </div>
            </div>
            <div className="modal-footer">
              {req.kind !== 'alert' && (
                <button className="btn-secondary" onClick={() => close(req.kind === 'confirm' ? false : null)}>
                  {(req as any).cancelLabel || 'انصراف'}
                </button>
              )}
              <button className={danger ? 'btn-primary is-danger' : 'btn-primary'} disabled={!canSubmit} onClick={submit}>
                {req.confirmLabel || (req.kind === 'alert' ? 'باشه' : 'تأیید')}
              </button>
            </div>
          </div>
        </div>
      )}

      {toasts.length > 0 && (
        <div className="toast-stack" dir="rtl" role="status" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              <span className="toast-icon" aria-hidden="true">{TOAST_ICON[t.kind]}</span>
              <span className="toast-text">{t.text}</span>
              <button className="toast-close" aria-label="بستن" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>✕</button>
            </div>
          ))}
        </div>
      )}
    </DialogCtx.Provider>
  )
}
