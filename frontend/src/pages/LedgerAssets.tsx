import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { toShamsi, nowJalali } from '../lib/date'
import DateField from '../components/shared/DateField'
import { Loading, EmptyState, Alert } from '../components/ui'
import Icon from '../components/ui/Icon'
import ModalPortal from '../components/ui/ModalPortal'
import { dialog, toast } from '../components/ui/dialog'
import { fmt } from '../lib/ledgerFormat'

/**
 * دارایی ثابت، استهلاک، و چک‌لیست پایان ماه — مرحلهٔ ۴ ه.
 */

const SHAMSI_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
]

// ═══════════════════════════════════════════════════════════════
// دارایی‌های ثابت
// ═══════════════════════════════════════════════════════════════
export function FixedAssetsTab() {
  const qc = useQueryClient()
  const [form, setForm] = useState(false)
  const [edit, setEdit] = useState<any>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [asOf, setAsOf] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'fixed-assets'],
    queryFn: async () => (await api.get('/ledger/fixed-assets')).data as any[],
  })

  const run = useMutation({
    mutationFn: async () => (await api.post('/ledger/fixed-assets/post-depreciation', {
      asOf: asOf || undefined,
    })).data,
    onSuccess: (r: any) => {
      if (r.posted) toast.success(`استهلاک ${r.periods} دوره ثبت شد (سند #${r.entry.serial})`)
      else toast.info(r.reason)
      qc.invalidateQueries({ queryKey: ['ledger'] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? 'ثبت ناموفق بود'),
  })

  const dispose = useMutation({
    mutationFn: async (code: string) =>
      (await api.post(`/ledger/fixed-assets/${code}/dispose`, {})).data,
    onSuccess: () => { toast.success('دارایی کنار گذاشته شد'); qc.invalidateQueries({ queryKey: ['ledger'] }) },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? 'خطا'),
  })

  if (isLoading) return <Loading />
  const rows = data ?? []

  return (
    <div>
      <div className="toolbar">
        <button className="btn-primary" onClick={() => { setEdit(null); setForm(true) }}>
          <Icon name="plus" size={15} /> دارایی جدید
        </button>
        <div className="form-group" style={{ margin: 0 }}>
          <label>استهلاک تا تاریخ</label><DateField value={asOf} onChange={setAsOf} />
        </div>
        <button className="btn-secondary btn-sm" style={{ alignSelf: 'flex-end' }}
          disabled={run.isPending || !rows.length} onClick={() => run.mutate()}>
          ثبت استهلاکِ سررسیدشده
        </button>
        <span className="hint-sm">{rows.length} دارایی</span>
      </div>

      {!rows.length ? (
        <EmptyState icon={<Icon name="package" />} title="دارایی ثابتی ثبت نشده">
          بهای تمام‌شده در حساب ۱۲۰۱ است، ولی عمر مفید و تاریخ بهره‌برداری در سند
          حسابداری جایی ندارند — بدون آن‌ها استهلاک قابل محاسبه نیست.
        </EmptyState>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>کد</th><th>نام</th><th>مرکز هزینه</th>
                <th style={{ textAlign: 'left' }}>بهای تمام‌شده</th>
                <th style={{ textAlign: 'left' }}>استهلاک انباشته</th>
                <th style={{ textAlign: 'left' }}>ماندهٔ دفتری</th>
                <th>دوره‌ها</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.code} style={a.disposedAt ? { opacity: 0.55 } : undefined}>
                  <td className="num">{a.code}</td>
                  <td>
                    {a.name}
                    {a.disposedAt && <span className="hint-sm"> · کنارگذاشته {toShamsi(a.disposedAt)}</span>}
                    {a.fullyDepreciated && !a.disposedAt && <span className="hint-sm"> · کاملاً مستهلک</span>}
                  </td>
                  <td className="hint-sm">{a.costCenterName ?? '—'}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(a.cost)}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(a.accumulated)}</td>
                  <td className="num" style={{ textAlign: 'left', fontWeight: 700 }}>{fmt(a.bookValue)}</td>
                  <td className="num">{a.postedPeriods} / {a.usefulLifeMonths}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn-secondary btn-sm" onClick={() => setDetail(a.code)}>جدول</button>
                      <button className="btn-secondary btn-sm" onClick={() => { setEdit(a); setForm(true) }}>ویرایش</button>
                      {!a.disposedAt && (
                        <button className="btn-danger btn-sm" onClick={async () => {
                          if (await dialog.confirm({
                            title: 'کنارگذاری دارایی',
                            message: 'پس از این تاریخ دیگر مستهلک نمی‌شود. دوره‌های ثبت‌شده دست‌نخورده می‌مانند.',
                            confirmLabel: 'کنار بگذار', tone: 'danger',
                          })) dispose.mutate(a.code)
                        }}>کنارگذاری</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="hint" style={{ marginTop: 10 }}>
        دوره‌های عقب‌افتاده در <strong>یک سند</strong> جمع می‌شوند، ولی هر ماه ردیف
        خودش را می‌گیرد تا دوباره ثبت نشود. ماهِ آخر باقی‌ماندهٔ گردکردن را می‌گیرد،
        پس ماندهٔ دفتری دقیقاً به صفر می‌رسد.
      </p>

      {form && <AssetFormModal asset={edit} onClose={() => setForm(false)} />}
      {detail && <ScheduleModal code={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

function AssetFormModal({ asset, onClose }: { asset: any | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({
    code: asset?.code ?? '', name: asset?.name ?? '',
    cost: asset?.cost ?? '', salvage: asset?.salvage ?? '0',
    usefulLifeMonths: asset ? String(asset.usefulLifeMonths) : '60',
    inServiceAt: '', costCenterCode: asset?.costCenterCode ?? '', note: '',
  })
  const { data: centres } = useQuery({
    queryKey: ['ledger', 'cost-centers'],
    queryFn: async () => (await api.get('/ledger/cost-centers')).data as any[],
  })
  const save = useMutation({
    mutationFn: async () => (await api.post('/ledger/fixed-assets', {
      ...f, costCenterCode: f.costCenterCode || undefined,
    })).data,
    onSuccess: () => { toast.success('ثبت شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? 'ثبت ناموفق بود'),
  })
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }))
  const locked = !!asset && asset.postedPeriods > 0

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>{asset ? 'ویرایش دارایی' : 'دارایی ثابت جدید'}</h2>
            <button onClick={onClose} aria-label="بستن">✕</button>
          </div>
          <div className="modal-body">
            {locked && (
              <Alert tint="info">
                این دارایی {asset.postedPeriods} دورهٔ استهلاکِ ثبت‌شده دارد؛ بهای تمام‌شده،
                ارزش اسقاط و عمر مفید دیگر تغییر نمی‌کنند — وگرنه دوره‌های گذشته نامعتبر می‌شوند.
              </Alert>
            )}
            <div className="grid-2">
              <div className="form-group">
                <label>کد</label>
                <input className="num" value={f.code} disabled={!!asset}
                  onChange={(e) => set('code', e.target.value)} />
              </div>
              <div className="form-group">
                <label>نام</label>
                <input value={f.name} onChange={(e) => set('name', e.target.value)} />
              </div>
              <div className="form-group">
                <label>بهای تمام‌شده (ریال)</label>
                <input className="num" inputMode="numeric" value={f.cost} disabled={locked}
                  onChange={(e) => set('cost', e.target.value)} />
              </div>
              <div className="form-group">
                <label>ارزش اسقاط</label>
                <input className="num" inputMode="numeric" value={f.salvage} disabled={locked}
                  onChange={(e) => set('salvage', e.target.value)} />
              </div>
              <div className="form-group">
                <label>عمر مفید (ماه)</label>
                <input className="num" inputMode="numeric" value={f.usefulLifeMonths} disabled={locked}
                  onChange={(e) => set('usefulLifeMonths', e.target.value)} />
              </div>
              <div className="form-group">
                <label>شروع بهره‌برداری</label>
                <DateField value={f.inServiceAt} onChange={(v) => set('inServiceAt', v)} />
              </div>
            </div>
            <div className="form-group">
              <label>مرکز هزینه (هزینهٔ استهلاک به آن می‌خورد)</label>
              <select value={f.costCenterCode} onChange={(e) => set('costCenterCode', e.target.value)}>
                <option value="">بدون مرکز</option>
                {(centres ?? []).filter((c) => c.isPostable).map((c) => (
                  <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
                ))}
              </select>
            </div>
            <p className="hint-sm">عمر مفید به ماه است: پنج سال یعنی ۶۰.</p>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={onClose}>انصراف</button>
            <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>ذخیره</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}

function ScheduleModal({ code, onClose }: { code: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'asset-schedule', code],
    queryFn: async () => (await api.get(`/ledger/fixed-assets/${code}/schedule`)).data,
  })
  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>جدول استهلاک {data?.asset?.name ?? code}</h2>
            <button onClick={onClose} aria-label="بستن">✕</button>
          </div>
          <div className="modal-body">
            {isLoading ? <Loading /> : data && (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>دوره</th><th>تاریخ</th>
                      <th style={{ textAlign: 'left' }}>استهلاک</th>
                      <th style={{ textAlign: 'left' }}>انباشته</th>
                      <th style={{ textAlign: 'left' }}>ماندهٔ دفتری</th>
                      <th>وضعیت</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r: any) => (
                      <tr key={r.periodNo} style={r.posted ? undefined : { opacity: 0.6 }}>
                        <td className="num">{r.periodNo}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>{toShamsi(r.periodDate)}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{fmt(r.amount)}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{fmt(r.accumulated)}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{fmt(r.bookValue)}</td>
                        <td className="hint-sm" style={{ color: r.posted ? 'var(--success)' : 'var(--text-muted)' }}>
                          {r.posted ? 'ثبت‌شده' : 'ثبت‌نشده'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}

// ═══════════════════════════════════════════════════════════════
// چک‌لیست پایان ماه
// ═══════════════════════════════════════════════════════════════

const STATUS_UI: Record<string, { label: string; color: string; mark: string }> = {
  DONE: { label: 'انجام شده', color: 'var(--success)', mark: '✓' },
  TODO: { label: 'باید انجام شود', color: 'var(--warning)', mark: '!' },
  NA: { label: 'موضوعیت ندارد', color: 'var(--text-muted)', mark: '—' },
}

/**
 * **چرا «بررسی» و نه «تیک زدن»:** چک‌لیستی که کاربر خودش تیک بزند، فهرستِ
 * آرزوهاست نه کنترل. هر بند از خودِ دفتر خوانده می‌شود، پس تیکِ دروغ ممکن نیست.
 */
export function MonthEndTab() {
  const [month, setMonth] = useState(Math.min(12, nowJalali().jm))
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'month-end', month],
    queryFn: async () => (await api.get('/ledger/month-end', { params: { month } })).data,
  })
  if (isLoading) return <Loading />
  if (!data) return null

  return (
    <div>
      <div className="toolbar">
        <div className="form-group" style={{ margin: 0, minWidth: 150 }}>
          <label>ماه</label>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {SHAMSI_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <span className="hint-sm">
          {data.label} {data.fiscalYear.title} · {toShamsi(data.from)} تا {toShamsi(data.to)}
        </span>
        <span style={{ marginInlineStart: 'auto' }}>
          <span className="hint-sm">
            {data.summary.done} انجام‌شده · {data.summary.todo} باقی · {data.summary.na} بی‌موضوع
          </span>
        </span>
      </div>

      {data.summary.ready ? (
        <Alert tint="success">
          هیچ کارِ باقی‌مانده‌ای نیست — این ماه آمادهٔ بستن است.
        </Alert>
      ) : (
        <Alert tint="warning">
          <strong>{data.summary.todo}</strong> کار باقی مانده. ماهی که با کارِ نکرده بسته
          شود، اصلاحش در دورهٔ قفل‌شده سند برگشتی می‌خواهد.
        </Alert>
      )}

      <div className="table-container" style={{ marginTop: 12 }}>
        <table className="data-table">
          <thead>
            <tr><th style={{ width: 40 }}></th><th>کار</th><th>وضعیت</th></tr>
          </thead>
          <tbody>
            {data.items.map((it: any) => {
              const ui = STATUS_UI[it.status]
              return (
                <tr key={it.key}>
                  <td style={{ textAlign: 'center', color: ui.color, fontWeight: 800, fontSize: 15 }}>
                    {ui.mark}
                  </td>
                  <td>
                    <div style={{ fontWeight: it.status === 'TODO' ? 700 : 400 }}>{it.title}</div>
                    <div className="hint-sm">{it.detail}</div>
                  </td>
                  <td style={{ color: ui.color, whiteSpace: 'nowrap' }}>{ui.label}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * نوارِ فشردهٔ چک‌لیست برای «نمای کلی» — مرحلهٔ چیدمان.
 *
 * چک‌لیستِ کامل جای خودش در تب «پایان دوره» است، ولی حسابدار باید **پیش از
 * هر چیز** بداند این ماه چه مانده. یک نوار یک‌خطی روی صفحهٔ اول این را
 * می‌گوید بی‌آنکه جای نمودار و کارت‌ها را بگیرد؛ برای دیدن ریز، یک کلیک.
 *
 * عمداً فقط وقتی دیده می‌شود که کاری مانده باشد — نوارِ همیشه‌سبز، بعد از
 * دو هفته دیگر دیده نمی‌شود و وقتی قرمز شود هم کسی نگاهش نمی‌کند.
 */
export function MonthEndBanner({ onOpen }: { onOpen?: () => void }) {
  const month = Math.min(12, nowJalali().jm)
  const { data } = useQuery({
    queryKey: ['ledger', 'month-end', month],
    queryFn: async () => (await api.get('/ledger/month-end', { params: { month } })).data,
  })
  if (!data || data.summary.todo === 0) return null

  const todos = data.items.filter((i: any) => i.status === 'TODO')
  return (
    <Alert tint="warning">
      <div className="row-between" style={{ gap: 12, flexWrap: 'wrap' }}>
        <span>
          <strong>{data.summary.todo}</strong> کار برای بستنِ {data.label} مانده:{' '}
          {todos.slice(0, 3).map((i: any) => i.title).join(' · ')}
          {todos.length > 3 && ` و ${todos.length - 3} مورد دیگر`}
        </span>
        {onOpen && (
          <button className="btn-secondary btn-sm" onClick={onOpen}>
            رفتن به پایان دوره
          </button>
        )}
      </div>
    </Alert>
  )
}
