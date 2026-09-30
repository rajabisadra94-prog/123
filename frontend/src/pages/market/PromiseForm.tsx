import { useEffect, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import api from '../../lib/api'
import { toast } from '../../components/ui/dialog'
import DateField from '../../components/shared/DateField'
import { PROMISE_KINDS } from './shared'
import { inDays } from './CallForm'
import Icon from '../../components/ui/Icon'

const EMPTY = { kind: 'SAMPLE', productId: '', description: '', qty: '', dueAt: '' }

/**
 * «قرار شد برایش بفرستیم» — همان چیزی که نباید یادمان برود.
 * موعد پیش‌فرض یک هفته است تا اگر کاربر تاریخ نگذارد، باز هم یادآوری بگیرد؛
 * تعهدِ بدون موعد هرگز اعلان نمی‌گیرد و عملاً گم می‌شود.
 */
export default function PromiseForm({ contactId, contactName, products, onSaved, registerFlush }: {
  contactId: string
  contactName?: string
  products: { id: string; name: string }[]
  onSaved?: () => void
  /** مثل فرم گفت‌وگو: قولی که نوشته شده ولی ثبت نشده، با بستن صفحه از دست نرود */
  registerFlush?: (fn: () => Promise<void>) => () => void
}) {
  const [f, setF] = useState({ ...EMPTY, dueAt: inDays(7) })
  const set = (k: string, v: any) => setF((s) => ({ ...s, [k]: v }))

  const save = useMutation({
    mutationFn: () => api.post('/market/promises', { ...f, contactId },
      { outboxLabel: `تعهد ارسال${contactName ? ' — ' + contactName : ''}` } as any),
    onSuccess: () => { setF({ ...EMPTY, dueAt: inDays(7) }); onSaved?.(); toast.success('تعهد ارسال ثبت شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'ثبت نشد'),
  })

  const latest = useRef(f)
  latest.current = f
  useEffect(() => {
    if (!registerFlush) return
    return registerFlush(async () => {
      // «نوع» و «موعد» پیش‌فرض دارند، پس تنها نشانهٔ اینکه کاربر واقعاً چیزی
      // نوشته، شرحِ آن است. بدون این شرط، هر بار که فرم باز می‌ماند یک تعهدِ
      // خالیِ «نمونه» ثبت می‌شد.
      if (!latest.current.description.trim()) return
      await save.mutateAsync()
      toast.info('تعهد ثبت‌نشده ذخیره شد')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerFlush, contactId])

  return (
    <>
      <div className="form-grid-2">
        {/* ۷ نوع تعهد به‌صورت ۷ قرص، صفحه را شلوغ می‌کرد و انتخابِ اصلی نیست */}
        <div className="form-group"><label>چه چیزی</label>
          <select value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            {PROMISE_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
          </select>
        </div>
        <div className="form-group"><label>محصول (اختیاری)</label>
          <select value={f.productId} onChange={(e) => set('productId', e.target.value)}>
            <option value="">— مربوط به محصول خاصی نیست</option>
            {products.filter(Boolean).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="form-group"><label>تعداد</label>
          <input type="number" min={0} value={f.qty} onChange={(e) => set('qty', e.target.value)} />
        </div>
      </div>
      <div className="form-group"><label>توضیح</label>
        <input value={f.description} onChange={(e) => set('description', e.target.value)}
          placeholder="مثلاً: ۵ عدد نمونهٔ فرز سرامیکی سایز متوسط" />
      </div>
      <div className="form-group"><label>تا چه تاریخی قول دادیم</label>
        <DateField value={f.dueAt} onChange={(v) => set('dueAt', v)} />
      </div>
      <button className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}><Icon name="package" /> ثبت تعهد</button>
    </>
  )
}
