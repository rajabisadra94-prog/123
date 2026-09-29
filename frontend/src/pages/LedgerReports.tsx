import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { toShamsi } from '../lib/date'
import { downloadFile } from '../lib/download'
import DateField from '../components/shared/DateField'
import NumberInput from '../components/shared/NumberInput'
import { Loading, TableEmpty, Alert } from '../components/ui'
import Icon from '../components/ui/Icon'
import ModalPortal from '../components/ui/ModalPortal'
import { dialog, toast } from '../components/ui/dialog'
import { fmt, signColor, CUR_LABEL } from '../lib/ledgerFormat'
import TrendChart from '../components/shared/TrendChart'
import { MonthEndBanner } from './LedgerAssets'

/**
 * گزارش‌های فاز ۲ هستهٔ جدید: نمای کلی، سن‌بندی، و دفتر حساب (drill-in).
 *
 * پروندهٔ طرف‌حساب از اینجا به `LedgerPartyPage` منتقل شد — صفحهٔ واقعی با
 * آدرس، نه مودال (ممیزی سوم — ج۱).
 */

// ═══════════════════════════════════════════════════════════════
// نمای کلی
// ═══════════════════════════════════════════════════════════════
export function OverviewTab({ onGoPeriodEnd, onGoJournal }: {
  onGoPeriodEnd?: () => void
  onGoJournal?: () => void
} = {}) {
  const { data: o, isLoading } = useQuery({
    queryKey: ['ledger', 'overview'],
    queryFn: async () => (await api.get('/ledger/overview')).data,
  })
  const trend = useQuery({
    queryKey: ['ledger', 'trend'],
    queryFn: async () => (await api.get('/ledger/reports/trend')).data,
  })
  if (isLoading) return <Loading />
  if (!o) return null

  const Box = ({ title, bucket, tone }: { title: string; bucket: any; tone: string }) => {
    const ccys = Object.keys(bucket.byCurrency)
    return (
      <div className="kpi-card" style={{ padding: 18 }}>
        <div className="kpi-label" style={{ marginBottom: 8 }}>{title}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
          {ccys.length === 0 && <span className="hint-sm">—</span>}
          {ccys.map((c) => (
            <span key={c} className="num">{CUR_LABEL[c] ?? c}: <strong>{fmt(bucket.byCurrency[c].amount, c)}</strong></span>
          ))}
        </div>
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)', fontSize: 13 }}>
          معادل کل: <strong className="num" style={{ color: tone }}>{fmt(bucket.totalBase)}</strong> ریال
        </div>
      </div>
    )
  }

  const alerts: { icon: any; text: string; tint: 'warning' | 'danger' }[] = []
  if (o.alerts.ratesStale) alerts.push({ icon: 'alert', tint: 'warning', text: `نرخ ارز به‌روز نیست${o.alerts.rateAgeDays != null ? ` (${o.alerts.rateAgeDays} روز پیش)` : ''} — در تب «ارز و تسعیر» نرخ امروز را ثبت کنید.` })
  if (o.alerts.hasFutureRate) alerts.push({ icon: 'alert', tint: 'warning', text: 'یک نرخ ارز با تاریخِ آینده ثبت شده — تا آن تاریخ اثری ندارد؛ اگر اشتباه است اصلاحش کنید.' })
  for (const a of o.alerts.negativeCashAccounts) alerts.push({ icon: 'wallet', tint: 'danger', text: `حساب «${a.name}» منفی است: ${fmt(a.amount, a.currencyCode)} ${CUR_LABEL[a.currencyCode] ?? a.currencyCode}` })
  for (const p of o.alerts.partiesWeOwe) alerts.push({ icon: 'repeat', tint: 'warning', text: `«${p.name}» از ما طلبکار است: ${fmt(p.amount, p.currencyCode)} ${CUR_LABEL[p.currencyCode] ?? p.currencyCode} (پیش‌پرداخت بیش از فاکتور)` })
  for (const s of o.alerts.shipmentsAwaitingFreight) alerts.push({ icon: 'truck', tint: 'warning', text: `محموله ${s.code} (${s.carrier}) رسیده — فاکتور حمل ثبت نشده است.` })

  return (
    <div>
      {/* پیش از هر عدد: این ماه چه مانده — چیدمانِ تازه */}
      <div style={{ marginBottom: 16 }}><MonthEndBanner onOpen={onGoPeriodEnd} /></div>

      <div className="grid-4" style={{ marginBottom: 16 }}>
        <Box title="نقدینگی شرکت" bucket={o.cash} tone="var(--brand)" />
        <Box title="طلب از مشتریان" bucket={o.receivable} tone="var(--success)" />
        <Box title="بدهی به طرف‌حساب‌ها" bucket={o.payable} tone="var(--danger)" />
        <div className="kpi-card" style={{ padding: 18, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div className="kpi-label">خالص وضعیت مالی</div>
          <div className="kpi-value" style={{ fontSize: 24, color: signColor(o.netBase) }}>{fmt(o.netBase)}</div>
          <div className="hint-sm">ریال (نقد + طلب − بدهی)</div>
        </div>
      </div>

      {/* روند سال — ب۱۵.
          چهار کارت بالا «مانده در همین لحظه»اند و هیچ‌کدام نمی‌گویند این عدد
          از کجا آمده. مدیر مالی از یک عدد تصمیم نمی‌گیرد، از جهتش تصمیم
          می‌گیرد. */}
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="row-between" style={{ marginBottom: 6 }}>
          <div className="section-title" style={{ margin: 0 }}>
            روند سال {trend.data?.fiscalYear?.title ?? ''}
          </div>
          {trend.data && (
            <div style={{ display: 'flex', gap: 14, fontSize: 12 }}>
              <span className="num">درآمد <strong style={{ color: 'var(--success)' }}>{fmt(trend.data.totals.income)}</strong></span>
              <span className="num">هزینه <strong style={{ color: 'var(--danger)' }}>{fmt(trend.data.totals.expense)}</strong></span>
              <span className="num">سود <strong style={{ color: signColor(trend.data.totals.profit) }}>{fmt(trend.data.totals.profit)}</strong></span>
            </div>
          )}
        </div>
        {trend.isLoading
          ? <Loading />
          : trend.data
            ? <TrendChart months={trend.data.months} />
            : <div className="hint-sm">سال مالی تعریف نشده است.</div>}
      </section>

      {alerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {alerts.map((a, i) => (
            <Alert key={i} tint={a.tint}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                <Icon name={a.icon} size={15} /> {a.text}
              </span>
            </Alert>
          ))}
        </div>
      )}

      {/*
        سربرگ صریح می‌گوید «عملیاتی» چون فهرست، افتتاحیه/اختتامیه را عمداً
        نشان نمی‌دهد. اگر فقط «آخرین اسناد» می‌نوشتیم، کاربر سندی را که
        می‌دانست ثبت شده نمی‌دید و فکر می‌کرد گم شده — پنهان‌کاریِ بی‌اعلام
        بدتر از فیلترِ اعلام‌شده است. دکمهٔ کنار، راهِ دیدنِ همه است.
      */}
      <div className="toolbar" style={{ justifyContent: 'space-between' }}>
        <div className="section-title" style={{ margin: 0 }}>آخرین اسناد عملیاتی</div>
        {onGoJournal && (
          <button className="btn-secondary btn-sm" onClick={onGoJournal}>
            همهٔ اسناد (شامل افتتاحیه و اختتامیه) ←
          </button>
        )}
      </div>
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>سند</th><th>تاریخ</th><th>شرح</th>
              <th style={{ textAlign: 'left' }}>مبلغ (ریال)</th>
              <th>ردیف‌ها</th>
            </tr>
          </thead>
          <tbody>
            {o.recentEntries.map((e: any) => <RecentEntryRow key={e.id} entry={e} />)}
            {!o.recentEntries.length && <TableEmpty colSpan={5}>هنوز سند عملیاتی‌ای ثبت نشده</TableEmpty>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * یک سطر از «آخرین اسناد» — سربرگ سند، نه ریزِ ردیف‌ها (ممیزی ج۳).
 *
 * نسخهٔ قبلی `e.lines.map(...)` را مستقیم داخل خانهٔ جدول می‌ریخت. یک سند
 * افتتاحیهٔ ۲۶ ردیفی، ۲۶ خط در یک سلول می‌شد و نمای کلی به دیوار متن تبدیل
 * می‌شد — بیش از ۵۰ خط مبلغ ریز پشت‌سرهم. حالا جمع سند و تعداد ردیف را
 * می‌بینید و با یک کلیک بازش می‌کنید؛ همان الگویی که تب دفتر روزنامه دارد.
 */
function RecentEntryRow({ entry: e }: { entry: any }) {
  const [open, setOpen] = useState(false)
  const total = (e.lines ?? []).reduce(
    (sum: bigint, l: any) => sum + BigInt(l.debitBase ?? l.debit ?? 0), 0n,
  )
  const n = e.lines?.length ?? 0

  return (
    <>
      <tr style={e.status === 'REVERSED' ? { opacity: 0.55 } : undefined}>
        <td className="num">#{e.serial}</td>
        <td style={{ whiteSpace: 'nowrap' }}>{toShamsi(e.date)}</td>
        <td>{e.description}</td>
        <td className="num" style={{ textAlign: 'left' }}>{fmt(total)}</td>
        <td>
          <button className="btn-secondary btn-sm" onClick={() => setOpen(!open)}
            aria-expanded={open}>
            {open ? 'بستن' : `${n} ردیف`}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--surface-2)', padding: 0 }}>
            <table className="data-table" style={{ margin: 0 }}>
              <tbody>
                {(e.lines ?? []).map((l: any) => (
                  <tr key={l.id}>
                    <td style={{ paddingInlineStart: 28 }}>
                      <span className="num">{l.account?.code}</span> {l.account?.name}
                      {l.subsidiary && <span className="hint-sm"> · {l.subsidiary.name}</span>}
                    </td>
                    <td className="num" style={{ textAlign: 'left', width: 190 }}>
                      {l.debit !== '0'
                        ? <span style={{ color: 'var(--success)' }}>بدهکار {fmt(l.debit, l.currencyCode)}</span>
                        : <span style={{ color: 'var(--danger)' }}>بستانکار {fmt(l.credit, l.currencyCode)}</span>}
                    </td>
                    <td className="hint-sm" style={{ width: 60 }}>{CUR_LABEL[l.currencyCode] ?? l.currencyCode}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  )
}

// ═══════════════════════════════════════════════════════════════
// سن‌بندی
// ═══════════════════════════════════════════════════════════════

/**
 * یک ردیف = یک طرف‌حساب (نه یک طرف‌حساب × ارز).
 *
 * پیش از این، مشتری‌ای که هم ریالی و هم دلاری بدهکار بود سه‌جا در جدول
 * پخش می‌شد و «بزرگ‌ترین بدهکار» را نمی‌شد دید. حالا سطل‌ها به ارز پایه
 * جمع‌اند و تفکیک ارز پشت یک دکمه است — همان‌جایی که وقتی لازم شد لازم است.
 */
function AgingRow({ r, buckets, tone }: { r: any; buckets: string[]; tone: (i: number) => string }) {
  const [open, setOpen] = useState(false)
  const multi = !r.singleCurrency
  return (
    <>
      <tr>
        <td>
          {r.name}{' '}
          {multi ? (
            <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen((v) => !v)}
              aria-expanded={open}>
              {open ? 'بستن' : `${r.currencies.length} ارز`}
            </button>
          ) : (
            <span className="hint-sm">({CUR_LABEL[r.singleCurrency] ?? r.singleCurrency})</span>
          )}
        </td>
        <td className="num" style={{ textAlign: 'left' }}>
          {multi ? <span className="hint-sm">—</span> : fmt(r.currencies[0].balance, r.singleCurrency)}
        </td>
        {buckets.map((b, i) => (
          <td key={b} className="num" style={{ textAlign: 'left', color: r.buckets[b] !== '0' ? tone(i) : 'var(--text-muted)' }}>
            {r.buckets[b] !== '0' ? fmt(r.buckets[b]) : '—'}
          </td>
        ))}
        <td style={{ color: r.oldestDays > 90 ? 'var(--danger)' : r.oldestDays > 60 ? 'var(--warning)' : 'inherit', fontWeight: r.oldestDays > 60 ? 700 : 400 }}>
          {r.oldestDays} روز
        </td>
        <td className="num" style={{ textAlign: 'left', fontWeight: 700 }}>{fmt(r.totalBase)}</td>
      </tr>
      {open && r.currencies.map((c: any) => (
        <tr key={c.currencyCode} style={{ background: 'var(--surface-2)' }}>
          <td style={{ paddingInlineStart: 26 }} className="hint-sm">{CUR_LABEL[c.currencyCode] ?? c.currencyCode}</td>
          <td className="num hint-sm" style={{ textAlign: 'left' }}>{fmt(c.balance, c.currencyCode)}</td>
          {buckets.map((b) => (
            <td key={b} className="num hint-sm" style={{ textAlign: 'left' }}
              title={c.bucketsForeign?.[b] && c.bucketsForeign[b] !== '0'
                ? `${fmt(c.bucketsForeign[b], c.currencyCode)} ${CUR_LABEL[c.currencyCode] ?? c.currencyCode}` : undefined}>
              {c.buckets[b] !== '0' ? fmt(c.buckets[b]) : '—'}
            </td>
          ))}
          <td className="hint-sm">{c.oldestDays} روز</td>
          <td className="num hint-sm" style={{ textAlign: 'left' }}>{fmt(c.totalBase)}</td>
        </tr>
      ))}
    </>
  )
}

export function AgingView({ side }: { side: 'receivable' | 'payable' }) {
  const code = side === 'receivable' ? '1104' : '2101'
  const [asOf, setAsOf] = useState('')
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'aging', code, asOf],
    queryFn: async () => (await api.get(`/ledger/reports/aging/${code}`, { params: { asOf: asOf || undefined } })).data,
  })
  if (isLoading) return <Loading />
  if (!data) return null

  const BUCKETS = ['0-30', '31-60', '61-90', '90+']
  const BUCKET_LABEL: Record<string, string> = {
    '0-30': 'تا ۳۰ روز', '31-60': '۳۱–۶۰', '61-90': '۶۱–۹۰', '90+': 'بیش از ۹۰',
  }
  const bucketTone = (i: number) => ['var(--success)', 'var(--text)', 'var(--warning)', 'var(--danger)'][i]

  return (
    <div>
      <div className="toolbar">
        <div className="form-group" style={{ margin: 0 }}><label>در تاریخ</label><DateField value={asOf} onChange={setAsOf} /></div>
        <span style={{ marginInlineStart: 'auto' }}>
          <CsvButton path={`/ledger/export/aging/${code}`} filename={`aging-${code}.csv`}
            params={{ asOf: asOf || undefined }} />
        </span>
      </div>

      <div className="grid-4" style={{ marginBottom: 16 }}>
        {BUCKETS.map((b, i) => (
          <div key={b} className="kpi-card" style={{ padding: 14 }}>
            <div className="kpi-value num" style={{ fontSize: 17, color: bucketTone(i) }}>{fmt(data.bucketTotals[b])}</div>
            <div className="kpi-label">{BUCKET_LABEL[b]}</div>
          </div>
        ))}
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>{side === 'receivable' ? 'مشتری' : 'طرف‌حساب'}</th>
              <th style={{ textAlign: 'left' }}>ماندهٔ باز</th>
              {BUCKETS.map((b) => <th key={b} style={{ textAlign: 'left' }}>{BUCKET_LABEL[b]} <span className="hint-sm">(ریال)</span></th>)}
              <th>قدیمی‌ترین</th>
              <th style={{ textAlign: 'left' }}>معادل ریال</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r: any) => (
              <AgingRow key={r.subsidiaryId} r={r} buckets={BUCKETS} tone={bucketTone} />
            ))}
            {!data.rows.length && <TableEmpty colSpan={BUCKETS.length + 4}>{side === 'receivable' ? 'طلب بازی نیست' : 'بدهی بازی نیست'}</TableEmpty>}
          </tbody>
          {data.rows.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800 }}>
                <td colSpan={BUCKETS.length + 3}>
                  جمع کل ({data.rows.length} طرف‌حساب{data.positionCount > data.rows.length ? ` · ${data.positionCount} موضع ارزی` : ''})
                </td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(data.grandTotalBase)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* مرحلهٔ ۴ ج: خواننده باید بداند این گزارش چقدرش حدس است */}
      <p className="hint" style={{ marginTop: 10 }}>
        سن هر مبلغ از تاریخ ثبت همان تعهد حساب می‌شود.{' '}
        {data.explicitCoverage == null ? (
          <>تسویه‌ای در این بازه نیست.</>
        ) : data.explicitCoverage >= 1000 ? (
          <>همهٔ تسویه‌ها به فاکتور مشخصی <strong>تخصیص صریح</strong> خورده‌اند — هیچ حدسی در این گزارش نیست.</>
        ) : data.explicitCoverage === 0 ? (
          <>هیچ تسویه‌ای به فاکتور مشخصی تخصیص نخورده، پس هر پرداخت از{' '}
            <strong>قدیمی‌ترین</strong> بدهی باز کم شده (روش FIFO). برای دقیق‌شدن، در پروندهٔ
            هر طرف‌حساب پرداخت‌ها را به فاکتورشان تخصیص دهید.</>
        ) : (
          <><strong>{(data.explicitCoverage / 10).toFixed(1)}٪</strong> تسویه‌ها تخصیص صریح دارند؛
            بقیه با روش FIFO از قدیمی‌ترین بدهی باز کم شده‌اند.</>
        )}
      </p>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// دفتر حساب — drill-in
// ═══════════════════════════════════════════════════════════════
export function AccountLedgerModal({ code, name, onClose }: { code: string; name: string; onClose: () => void }) {
  const [currency, setCurrency] = useState('')
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'account-ledger', code, currency],
    queryFn: async () => (await api.get(`/ledger/reports/account-ledger/${code}`, {
      params: { currencyCode: currency || undefined },
    })).data,
  })

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 900 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2><span className="num">{code}</span> — {name}</h2>
            <button onClick={onClose} aria-label="بستن">✕</button>
          </div>
          <div className="modal-body">
            {isLoading ? <Loading /> : !data ? null : (
              <>
                <div className="toolbar">
                  <div className="form-group" style={{ margin: 0 }}>
                    <label>ارز</label>
                    <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                      <option value="">همه (به ریال)</option>
                      {['IRR', 'USD', 'CNY', 'AED'].map((c) => <option key={c} value={c}>{CUR_LABEL[c]}</option>)}
                    </select>
                  </div>
                  <span className="hint-sm">
                    مانده ابتدا: <span className="num">{fmt(data.openingBalance, currency || 'IRR')}</span> · پایان: <span className="num">{fmt(data.closingBalance, currency || 'IRR')}</span>
                  </span>
                  <span style={{ marginInlineStart: 'auto' }}>
                    <CsvButton path={`/ledger/export/account-ledger/${code}`} filename={`account-${code}.csv`}
                      params={{ currencyCode: currency || undefined }} />
                  </span>
                </div>
                <div className="table-container">
                  <table className="data-table">
                    <thead><tr>
                      <th>تاریخ</th><th>سند</th><th>شرح</th><th>تفصیلی</th><th>ارز</th>
                      <th style={{ textAlign: 'left' }}>بدهکار</th>
                      <th style={{ textAlign: 'left' }}>بستانکار</th>
                      {currency && <th style={{ textAlign: 'left' }}>مانده</th>}
                    </tr></thead>
                    <tbody>
                      {data.rows.map((r: any, i: number) => (
                        <tr key={i}>
                          <td style={{ whiteSpace: 'nowrap' }}>{toShamsi(r.date)}</td>
                          <td className="num">#{r.serial}</td>
                          <td>{r.description}{r.memo ? <span className="hint-sm"> — {r.memo}</span> : null}</td>
                          <td>{r.subsidiaryName ?? '—'}</td>
                          <td>{CUR_LABEL[r.currencyCode] ?? r.currencyCode}</td>
                          <td className="num" style={{ textAlign: 'left' }}>{r.debit !== '0' ? fmt(r.debit, currency || 'IRR') : ''}</td>
                          <td className="num" style={{ textAlign: 'left' }}>{r.credit !== '0' ? fmt(r.credit, currency || 'IRR') : ''}</td>
                          {currency && <td className="num" style={{ textAlign: 'left', color: signColor(r.running) }}>{fmt(r.running, currency)}</td>}
                        </tr>
                      ))}
                      {!data.rows.length && <TableEmpty colSpan={currency ? 8 : 7}>گردشی ندارد</TableEmpty>}
                    </tbody>
                  </table>
                </div>
                {!currency && <p className="hint-sm" style={{ marginTop: 8 }}>برای دیدن ماندهٔ در حال حرکت، یک ارز را انتخاب کنید.</p>}
              </>
            )}
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}

// ═══════════════════════════════════════════════════════════════
// ابزار مشترک
// ═══════════════════════════════════════════════════════════════
export function CsvButton({ path, filename, params, label = 'خروجی اکسل' }: {
  path: string; filename: string; params?: Record<string, unknown>; label?: string
}) {
  const [busy, setBusy] = useState(false)
  return (
    <button className="btn-secondary btn-sm" disabled={busy} onClick={async () => {
      setBusy(true)
      try { await downloadFile(path, filename, params) } catch { toast.error('دانلود ناموفق بود') }
      finally { setBusy(false) }
    }}>
      <Icon name="download" size={14} /> {busy ? '…' : label}
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════
// فرم ساخت / ویرایش حساب
// ═══════════════════════════════════════════════════════════════
const KINDS = ['CUSTOMER', 'PRODUCER', 'SUPPLIER', 'CARRIER', 'EXCHANGE', 'AGENT', 'EMPLOYEE', 'PETTY_CASH_HOLDER', 'BANK', 'OTHER']
const KIND_FA: Record<string, string> = {
  CUSTOMER: 'مشتری', PRODUCER: 'سازنده', SUPPLIER: 'تأمین‌کننده', CARRIER: 'شرکت حمل',
  EXCHANGE: 'صرافی', AGENT: 'کمیسیون‌بگیر', EMPLOYEE: 'کارمند', PETTY_CASH_HOLDER: 'تنخواه‌دار',
  BANK: 'بانک', OTHER: 'متفرقه',
}

export function AccountFormModal({ account, onClose }: { account: any | null; onClose: () => void }) {
  const qc = useQueryClient()
  const editing = !!account
  const [code, setCode] = useState(account?.code ?? '')
  const [name, setName] = useState(account?.name ?? '')
  const [currencyMode, setCurrencyMode] = useState<'SINGLE' | 'MULTI'>(account?.currencyMode ?? 'MULTI')
  const [currencyCode, setCurrencyCode] = useState(account?.currencyCode ?? 'IRR')
  const [requiresSubsidiary, setRequiresSubsidiary] = useState(!!account?.requiresSubsidiary)
  const [subsidiaryKinds, setSubsidiaryKinds] = useState<string[]>(account?.subsidiaryKinds ?? [])
  const [requiresCostCenter, setRequiresCostCenter] = useState(!!account?.requiresCostCenter)
  const [isActive, setIsActive] = useState(account?.isActive ?? true)
  const [sortIndex, setSortIndex] = useState(String(account?.sortIndex ?? 0))

  const save = useMutation({
    mutationFn: async () => {
      const body: any = {
        name, currencyMode, currencyCode: currencyMode === 'SINGLE' ? currencyCode : null,
        requiresSubsidiary, subsidiaryKinds: requiresSubsidiary ? subsidiaryKinds : [],
        requiresCostCenter, isActive, sortIndex: Number(sortIndex) || 0,
      }
      return editing
        ? (await api.patch(`/ledger/accounts/${account.id}`, body)).data
        : (await api.post('/ledger/accounts', { ...body, code })).data
    },
    onSuccess: () => { toast.success(editing ? 'حساب به‌روز شد' : 'حساب ساخته شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'ناموفق', message: e?.response?.data?.message, tone: 'danger' }),
  })

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>{editing ? `ویرایش حساب ${account.code}` : 'حساب جدید'}</h2>
            <button onClick={onClose} aria-label="بستن">✕</button>
          </div>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {!editing && (
              <div className="form-group" style={{ margin: 0 }}>
                <label>کد کامل (زیرمجموعهٔ کد والد)</label>
                <input className="num" value={code} onChange={(e) => setCode(e.target.value)} placeholder="مثلاً ۱۱۰۱۰۲" />
              </div>
            )}
            <div className="form-group" style={{ margin: 0 }}>
              <label>نام</label>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>حالت ارز</label>
                <select value={currencyMode} onChange={(e) => setCurrencyMode(e.target.value as any)}>
                  <option value="MULTI">چندارزی</option>
                  <option value="SINGLE">تک‌ارزی</option>
                </select>
              </div>
              {currencyMode === 'SINGLE' && (
                <div className="form-group" style={{ margin: 0 }}>
                  <label>ارز</label>
                  <select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)}>
                    {['IRR', 'USD', 'CNY', 'AED'].map((c) => <option key={c} value={c}>{CUR_LABEL[c]}</option>)}
                  </select>
                </div>
              )}
              <div className="form-group" style={{ margin: 0 }}>
                <label>ترتیب</label>
                <NumberInput value={sortIndex} onChange={setSortIndex} />
              </div>
            </div>
            <label className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={requiresSubsidiary} onChange={(e) => setRequiresSubsidiary(e.target.checked)} /> تفصیلی اجباری
            </label>
            {requiresSubsidiary && (
              <div className="panel panel-pad" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {KINDS.map((k) => (
                  <label key={k} className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <input type="checkbox" checked={subsidiaryKinds.includes(k)}
                      onChange={(e) => setSubsidiaryKinds(e.target.checked ? [...subsidiaryKinds, k] : subsidiaryKinds.filter((x) => x !== k))} />
                    {KIND_FA[k]}
                  </label>
                ))}
              </div>
            )}
            <label className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={requiresCostCenter} onChange={(e) => setRequiresCostCenter(e.target.checked)} /> مرکز هزینه اجباری
            </label>
            <label className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> فعال
            </label>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={onClose}>انصراف</button>
            <button className="btn-primary" disabled={!name || (!editing && !code) || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'در حال ذخیره…' : 'ذخیره'}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}

// ═══════════════════════════════════════════════════════════════
// مدیریت سال مالی و قفل دوره
// ═══════════════════════════════════════════════════════════════
export function PeriodPanel() {
  const qc = useQueryClient()
  const years = useQuery({ queryKey: ['ledger', 'fiscal-years'], queryFn: async () => (await api.get('/ledger/fiscal-years')).data })
  const locksQ = useQuery({ queryKey: ['ledger', 'period-locks'], queryFn: async () => (await api.get('/ledger/period-locks')).data })

  const [fyTitle, setFyTitle] = useState('')
  const [fyStart, setFyStart] = useState('')
  const [fyEnd, setFyEnd] = useState('')
  const [lockModule, setLockModule] = useState('ALL')
  const [lockDate, setLockDate] = useState('')
  const [lockReason, setLockReason] = useState('')
  const [closeTarget, setCloseTarget] = useState<any>(null)

  const reopen = useMutation({
    mutationFn: async (id: string) => (await api.post(`/ledger/fiscal-years/${id}/reopen`, { reason: 'بازکردن برای اصلاح' })).data,
    onSuccess: () => { toast.success('سال مالی باز شد؛ سند اختتامیه برگشت خورد'); qc.invalidateQueries({ queryKey: ['ledger'] }) },
    onError: (e: any) => dialog.alert({ title: 'بازکردن ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const addFy = useMutation({
    mutationFn: async () => (await api.post('/ledger/fiscal-years', { title: fyTitle, startDate: fyStart, endDate: fyEnd })).data,
    onSuccess: () => { toast.success('سال مالی ساخته شد'); setFyTitle(''); qc.invalidateQueries({ queryKey: ['ledger'] }) },
    onError: (e: any) => dialog.alert({ title: 'ناموفق', message: e?.response?.data?.message, tone: 'danger' }),
  })
  const addLock = useMutation({
    mutationFn: async () => (await api.post('/ledger/period-locks', { module: lockModule, lockToDate: lockDate, reason: lockReason })).data,
    onSuccess: () => { toast.success('دوره قفل شد'); setLockReason(''); qc.invalidateQueries({ queryKey: ['ledger', 'period-locks'] }) },
    onError: (e: any) => dialog.alert({ title: 'ناموفق', message: e?.response?.data?.message, tone: 'danger' }),
  })
  const delLock = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/ledger/period-locks/${id}`)).data,
    onSuccess: () => { toast.success('قفل برداشته شد'); qc.invalidateQueries({ queryKey: ['ledger', 'period-locks'] }) },
  })

  const MODULE_FA: Record<string, string> = {
    ALL: 'همه', Invoice: 'فاکتور', Settlement: 'تسویه', ProductionOrder: 'سفارش', ForwardingCargo: 'فورواردینگ', Manual: 'دستی',
  }

  return (
    <div className="grid-2" style={{ alignItems: 'start', marginBottom: 16 }}>
      <div className="panel">
        <div className="panel-hd"><h3>سال‌های مالی</h3></div>
        <div className="table-container" style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}>
          <table className="data-table">
            <thead><tr><th>عنوان</th><th>بازه</th><th>اسناد</th><th>وضعیت</th><th></th></tr></thead>
            <tbody>
              {(years.data ?? []).map((y: any) => (
                <tr key={y.id}>
                  <td>{y.title}</td>
                  <td className="hint-sm" style={{ whiteSpace: 'nowrap' }}>{toShamsi(y.startDate)} – {toShamsi(y.endDate)}</td>
                  <td className="num">{y.entryCount}</td>
                  <td className="hint-sm" style={{ color: y.closedAt ? 'var(--text-muted)' : 'var(--success)' }}>
                    {y.closedAt ? `بسته (${toShamsi(y.closedAt)})` : 'باز'}
                  </td>
                  <td style={{ textAlign: 'left' }}>
                    {y.closedAt
                      ? <button className="btn-secondary btn-sm" disabled={reopen.isPending}
                          onClick={async () => {
                            if (await dialog.confirm({
                              title: `بازکردن سال ${y.title}`,
                              message: 'سند اختتامیهٔ این سال با سند برگشتی خنثی می‌شود و می‌توان دوباره سند زد. (اگر این سال با نسخهٔ قدیمی بسته شده و سند افتتاحیه دارد، آن هم برگشت می‌خورد و سال بعد نباید سند دیگری داشته باشد.)',
                              confirmLabel: 'باز کن', tone: 'danger',
                            })) reopen.mutate(y.id)
                          }}>بازکردن</button>
                      : <button className="btn-secondary btn-sm" disabled={!y.entryCount}
                          onClick={() => setCloseTarget(y)}>بستن سال</button>}
                  </td>
                </tr>
              ))}
              {!years.data?.length && <TableEmpty colSpan={5}>سال مالی‌ای نیست</TableEmpty>}
            </tbody>
          </table>
        </div>
        <div className="panel-pad toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
          <div className="form-group" style={{ margin: 0 }}><label>عنوان</label>
            <input style={{ width: 90 }} value={fyTitle} onChange={(e) => setFyTitle(e.target.value)} placeholder="۱۴۰۶" />
          </div>
          <div className="form-group" style={{ margin: 0 }}><label>از</label><DateField value={fyStart} onChange={setFyStart} /></div>
          <div className="form-group" style={{ margin: 0 }}><label>تا</label><DateField value={fyEnd} onChange={setFyEnd} /></div>
          <button className="btn-secondary btn-sm" disabled={!fyTitle || !fyStart || !fyEnd || addFy.isPending} onClick={() => addFy.mutate()}>افزودن</button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-hd"><h3>قفل دوره</h3></div>
        <p className="hint-sm" style={{ padding: '10px 20px 0' }}>
          سندی با تاریخِ برابر یا پیش از تاریخ قفل، در ماژول قفل‌شده ثبت نمی‌شود (تریگر دیتابیس).
        </p>
        <div className="table-container" style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}>
          <table className="data-table">
            <thead><tr><th>ماژول</th><th>تا تاریخ</th><th>دلیل</th><th></th></tr></thead>
            <tbody>
              {(locksQ.data?.locks ?? []).map((l: any) => (
                <tr key={l.id}>
                  <td>{MODULE_FA[l.module] ?? l.module}</td>
                  <td className="hint-sm" style={{ whiteSpace: 'nowrap' }}>{toShamsi(l.lockToDate)}</td>
                  <td className="hint-sm">{l.reason}</td>
                  <td><button className="icon-btn danger" aria-label="برداشتن قفل" onClick={() => delLock.mutate(l.id)}><Icon name="trash" /></button></td>
                </tr>
              ))}
              {!locksQ.data?.locks?.length && <TableEmpty colSpan={4}>قفلی وجود ندارد</TableEmpty>}
            </tbody>
          </table>
        </div>
        <div className="panel-pad toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
          <div className="form-group" style={{ margin: 0 }}><label>ماژول</label>
            <select value={lockModule} onChange={(e) => setLockModule(e.target.value)}>
              {(locksQ.data?.modules ?? ['ALL']).map((m: string) => <option key={m} value={m}>{MODULE_FA[m] ?? m}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}><label>تا تاریخ</label><DateField value={lockDate} onChange={setLockDate} /></div>
          <div className="form-group grow" style={{ margin: 0 }}><label>دلیل</label>
            <input value={lockReason} onChange={(e) => setLockReason(e.target.value)} placeholder="بستن دورهٔ…" />
          </div>
          <button className="btn-secondary btn-sm" disabled={!lockDate || !lockReason || addLock.isPending} onClick={() => addLock.mutate()}>قفل کن</button>
        </div>
      </div>

      {closeTarget && (
        <YearCloseModal
          fy={closeTarget}
          onClose={() => setCloseTarget(null)}
          onDone={() => { setCloseTarget(null); qc.invalidateQueries({ queryKey: ['ledger'] }) }}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
function YearCloseModal({ fy, onClose, onDone }: {
  fy: any; onClose: () => void; onDone: () => void
}) {
  const preview = useQuery({
    queryKey: ['ledger', 'year-close-preview', fy.id],
    queryFn: async () => (await api.get(`/ledger/fiscal-years/${fy.id}/close/preview`)).data,
  })

  const close = useMutation({
    mutationFn: async () => (await api.post(`/ledger/fiscal-years/${fy.id}/close`, {})).data,
    onSuccess: (d: any) => {
      toast.success(`سال ${fy.title} بسته شد — ${Number(d.netProfit) >= 0 ? 'سود' : 'زیان'} ${fmt(d.netProfit)} ریال به سود انباشته`)
      onDone()
    },
    onError: (e: any) => dialog.alert({ title: 'بستن سال ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const p = preview.data
  const net = p ? BigInt(p.netProfit) : 0n

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>بستن سال مالی {fy.title}</h2>
            <button onClick={onClose} aria-label="بستن">✕</button>
          </div>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {preview.isLoading ? <Loading /> : !p ? null : p.alreadyClosed ? (
              <Alert tint="warning">این سال از قبل بسته شده است.</Alert>
            ) : (
              <>
                <div className="grid-3">
                  <div className="kpi-card" style={{ padding: 12 }}>
                    <div className="kpi-label">درآمد</div>
                    <div className="kpi-value num" style={{ fontSize: 16, color: 'var(--success)' }}>{fmt(p.totalIncome)}</div>
                  </div>
                  <div className="kpi-card" style={{ padding: 12 }}>
                    <div className="kpi-label">هزینه</div>
                    <div className="kpi-value num" style={{ fontSize: 16, color: 'var(--danger)' }}>{fmt(p.totalExpense)}</div>
                  </div>
                  <div className="kpi-card" style={{ padding: 12 }}>
                    <div className="kpi-label">{net >= 0n ? 'سود دوره' : 'زیان دوره'}</div>
                    <div className="kpi-value num" style={{ fontSize: 16, color: signColor(p.netProfit) }}>{fmt(p.netProfit)}</div>
                  </div>
                </div>

                <p className="hint-sm" style={{ margin: 0 }}>
                  {p.temporaryAccounts.length} حساب موقت به ماندهٔ ریالی‌شان صفر می‌شوند و خالص به
                  <span className="num"> ۳۱۰۲ سود و زیان انباشته</span> می‌رود. سال پس از بستن سند نمی‌پذیرد
                  (برگشت‌پذیر است). حساب‌های دائمی دست نمی‌خورند و ماندهٔ آن‌ها خودبه‌خود به سال بعد
                  منتقل می‌شود — سند افتتاحیهٔ جداگانه‌ای لازم نیست.
                </p>

                <div className="table-container" style={{ maxHeight: 200, overflow: 'auto' }}>
                  <table className="data-table">
                    <thead><tr><th>حساب</th><th style={{ textAlign: 'left' }}>ماندهٔ ریالی</th></tr></thead>
                    <tbody>
                      {p.temporaryAccounts.map((t: any) => (
                        <tr key={t.code}>
                          <td><span className="num">{t.code}</span> {t.name}</td>
                          <td className="num" style={{ textAlign: 'left', color: signColor(t.base) }}>{fmt(t.base)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

              </>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={onClose}>انصراف</button>
            <button className="btn-danger" disabled={!p || p.alreadyClosed || !p.temporaryAccounts?.length || close.isPending}
              onClick={() => close.mutate()}>
              {close.isPending ? 'در حال بستن…' : 'بستن سال'}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}
