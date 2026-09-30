import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { toShamsi } from '../../lib/date'
import { Loading, Alert, TableEmpty } from '../ui'
import { toast } from '../ui/dialog'
import { fmt, CUR_LABEL } from '../../lib/ledgerFormat'

/**
 * تخصیص پرداخت به فاکتور — مرحلهٔ ۴ ج.
 *
 * دو ستون: فاکتورهای باز و پرداخت‌های تخصیص‌نیافته. کاربر از هر ستون یکی
 * برمی‌دارد و «تخصیص» می‌زند.
 *
 * **چرا دو ستون و نه یک فهرست با دکمهٔ «تخصیص بده»:** تخصیص یک رابطه است نه
 * یک عمل روی یک ردیف. با یک فهرست، کاربر اول باید فاکتور را باز کند، بعد در
 * یک مودال دنبال پرداخت بگردد — و در آن مودال دیگر نمی‌بیند بقیهٔ فاکتورها
 * چه وضعی دارند. دو ستونِ هم‌زمان، خودِ تصمیم را نشان می‌دهد.
 *
 * مبلغ پیش‌فرض خالی است و یعنی «کمترینِ دو ماندهٔ باز» — حالتِ رایج. کاربر
 * فقط وقتی عدد می‌نویسد که بخواهد جزئی تخصیص دهد.
 */
export default function AllocationPanel({ subsidiaryId, accountCode }: {
  subsidiaryId: string
  accountCode: string
}) {
  const qc = useQueryClient()
  const [ob, setOb] = useState<string | null>(null)
  const [st, setSt] = useState<string | null>(null)
  const [amount, setAmount] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'open-items', subsidiaryId, accountCode],
    queryFn: async () => (await api.get(`/ledger/allocations/open/${subsidiaryId}`, {
      params: { accountCode },
    })).data,
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['ledger'] })

  const save = useMutation({
    mutationFn: async () => (await api.post('/ledger/allocations', {
      obligationLineId: ob, settlementLineId: st, amount: amount || undefined,
    })).data,
    onSuccess: () => {
      toast.success('تخصیص ثبت شد')
      setOb(null); setSt(null); setAmount('')
      refresh()
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? 'تخصیص ناموفق بود'),
  })

  if (isLoading) return <Loading />
  const obligations: any[] = data?.obligations ?? []
  const settlements: any[] = data?.settlements ?? []

  const isPayable = accountCode === '2101'
  const obTitle = isPayable ? 'فاکتورهای خرید باز' : 'فاکتورهای فروش باز'
  const stTitle = isPayable ? 'پرداخت‌های تخصیص‌نیافته' : 'دریافت‌های تخصیص‌نیافته'

  const picked = (list: any[], id: string | null) => list.find((x) => x.id === id) ?? null
  const o = picked(obligations, ob)
  const s = picked(settlements, st)
  // همان سقفی که بک‌اند اعمال می‌کند؛ اینجا فقط برای نمایش
  const cap = o && s
    ? (BigInt(o.open) < BigInt(s.open) ? o.open : s.open)
    : null
  const currencyMismatch = o && s && o.currencyCode !== s.currencyCode

  return (
    <section className="panel">
      <div className="section-title">تخصیص پرداخت به فاکتور</div>

      {!obligations.length && !settlements.length ? (
        <div className="hint-sm">هیچ قلمِ بازی نیست — همه‌چیز تسویه است.</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }} className="alloc-cols">
            <Column title={obTitle} rows={obligations} selected={ob} onPick={setOb} />
            <Column title={stTitle} rows={settlements} selected={st} onPick={setSt} />
          </div>

          <div className="toolbar" style={{ marginTop: 12 }}>
            <div className="form-group" style={{ margin: 0, minWidth: 150 }}>
              <label>مبلغ (خالی = کمترینِ دو مانده)</label>
              <input className="num" inputMode="numeric" value={amount}
                placeholder={cap ? fmt(cap, o?.currencyCode) : ''}
                onChange={(e) => setAmount(e.target.value)} />
            </div>
            <button className="btn-primary btn-sm" style={{ alignSelf: 'flex-end' }}
              disabled={!ob || !st || save.isPending || !!currencyMismatch}
              onClick={() => save.mutate()}>
              تخصیص بده
            </button>
            {o && s && !currencyMismatch && (
              <span className="hint-sm">
                فاکتور #{o.serial} ← دریافت #{s.serial} · حداکثر {fmt(cap!, o.currencyCode)}
              </span>
            )}
          </div>

          {currencyMismatch && (
            <Alert tint="warning">
              ارز فاکتور ({CUR_LABEL[o!.currencyCode] ?? o!.currencyCode}) با ارز پرداخت
              ({CUR_LABEL[s!.currencyCode] ?? s!.currencyCode}) یکی نیست. بستنِ فاکتور با
              ارز دیگر یعنی تبدیل ارز، که سند خودش را می‌خواهد نه یک تخصیص.
            </Alert>
          )}
        </>
      )}
    </section>
  )
}

function Column({ title, rows, selected, onPick }: {
  title: string; rows: any[]; selected: string | null; onPick: (id: string | null) => void
}) {
  return (
    <div>
      <div className="hint-sm" style={{ marginBottom: 6, fontWeight: 700 }}>
        {title} ({rows.length})
      </div>
      <div className="table-container" style={{ maxHeight: 280, overflowY: 'auto' }}>
        <table className="data-table">
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}
                onClick={() => onPick(selected === r.id ? null : r.id)}
                style={{
                  cursor: 'pointer',
                  background: selected === r.id ? 'var(--brand-soft, var(--surface-2))' : undefined,
                  fontWeight: selected === r.id ? 700 : undefined,
                }}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span className="num">#{r.serial ?? '—'}</span>
                  <span className="hint-sm"> {toShamsi(r.date)}</span>
                </td>
                <td>{r.description}</td>
                <td className="num" style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>
                  {fmt(r.open, r.currencyCode)}
                  {r.open !== r.amount && (
                    <span className="hint-sm"> از {fmt(r.amount, r.currencyCode)}</span>
                  )}
                </td>
              </tr>
            ))}
            {!rows.length && <TableEmpty colSpan={3}>موردی نیست</TableEmpty>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** تخصیص‌های ثبت‌شدهٔ یک ردیف — «این فاکتور با چه چیزهایی بسته شد» */
export function AllocationsOfLine({ lineId }: { lineId: string }) {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['ledger', 'line-allocations', lineId],
    queryFn: async () => (await api.get(`/ledger/allocations/line/${lineId}`)).data as any[],
  })
  const del = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/ledger/allocations/${id}`)).data,
    onSuccess: () => { toast.success('تخصیص حذف شد'); qc.invalidateQueries({ queryKey: ['ledger'] }) },
  })
  if (!data?.length) return null
  return (
    <ul style={{ margin: '6px 0 0', paddingInlineStart: 18, fontSize: 12 }}>
      {data.map((a) => (
        <li key={a.id}>
          <span className="num">{fmt(a.amount, a.currencyCode)}</span>
          {a.counterpart && <> ← #{a.counterpart.serial} {a.counterpart.description}</>}
          <button type="button" className="btn-secondary btn-sm" style={{ marginInlineStart: 8 }}
            onClick={() => del.mutate(a.id)}>حذف</button>
        </li>
      ))}
    </ul>
  )
}
