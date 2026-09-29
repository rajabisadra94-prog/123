import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { fileUrl } from '../lib/api'
import { toShamsi, formatDateTime, fromShamsi } from '../lib/date'
import { useSort, SortTH } from '../components/shared/sortable'
import NumberInput from '../components/shared/NumberInput'
import SearchableSelect from '../components/shared/SearchableSelect'
import DateField from '../components/shared/DateField'
import { PageHeader, TabChips, Loading, ModalLoading, TableEmpty } from '../components/ui'
import ModalPortal from '../components/ui/ModalPortal'
import { dialog, toast } from '../components/ui/dialog'

const CUR: Record<string, string> = { IRR: 'تومان', USD: 'دلار', CNY: 'یوآن' }
const OWNER_TABS: { key: string; label: string }[] = [
  { key: 'CUSTOMER', label: 'مشتریان' },
  { key: 'PRODUCER', label: 'سازندگان' },
  { key: 'SUPPLIER', label: 'تامین‌کنندگان' },
  { key: 'CARRIER', label: 'شرکت‌های حمل' },
  { key: 'EXCHANGE', label: 'صرافی‌ها' },
  { key: 'COMMISSION_AGENT', label: 'کمیسیون‌بگیرها' },
]
const EVENT_LABELS: Record<string, string> = {
  INVOICE_CONFIRMED: 'تأیید فاکتور',
  ADVANCE_RECEIVED: 'پیش‌پرداخت',
  TRANSFER: 'انتقال وجه',
  SETTLEMENT: 'دریافت / پرداخت (تسویه)',
  RECEIPT_FROM_CUSTOMER: 'دریافت از مشتری',
  PAYMENT_TO_PRODUCER: 'پرداخت به سازنده',
  PAYMENT_TO_CARRIER: 'پرداخت حمل',
  PAYMENT_TO_AGENT: 'پرداخت کمیسیون',
  PAYMENT_TO_EXCHANGE: 'پرداخت به صراف',
  INTERNAL: 'انتقال داخلی',
  CONVERSION: 'تبدیل ارز',
  CONVERSION_FEE: 'کارمزد صرافی',
  FREIGHT_INVOICE: 'فاکتور حمل',
  FORWARDING_INCOME: 'درآمد فورواردینگ',
  PURCHASE_ORDER_CREATED: 'بدهی سفارش خرید',
  PURCHASE_PAYMENT: 'پرداخت سفارش خرید',
  EXPENSE: 'هزینه / تنخواه',
  OPENING_BALANCE: 'سند افتتاحیه',
}
// طرف‌حساب‌هایی که می‌شود با آن‌ها تسویه کرد.
// `defaultDirection` فقط پیش‌فرضِ فرم است — پول با هر طرفی دوطرفه حرکت می‌کند
// (برگشت کالا از تامین‌کننده، استرداد به مشتری، …) پس جهت قفل نیست.
const SETTLE_TYPES: { key: string; label: string; defaultDirection: 'RECEIPT' | 'PAYMENT' }[] = [
  { key: 'CUSTOMER', label: 'مشتری', defaultDirection: 'RECEIPT' },
  { key: 'PRODUCER', label: 'سازنده', defaultDirection: 'PAYMENT' },
  { key: 'SUPPLIER', label: 'تامین‌کننده', defaultDirection: 'PAYMENT' },
  { key: 'CARRIER', label: 'شرکت حمل', defaultDirection: 'PAYMENT' },
  { key: 'EXCHANGE', label: 'صراف', defaultDirection: 'PAYMENT' },
  { key: 'COMMISSION_AGENT', label: 'کمیسیون‌بگیر', defaultDirection: 'PAYMENT' },
]

async function downloadCsv(path: string, filename: string) {
  const res = await api.get(`/accounting/${path}`, { responseType: 'blob' })
  const url = URL.createObjectURL(res.data)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url)
}
function n(v: any) { return Math.round(Number(v) || 0).toLocaleString() }
function n2(v: any) { const x = Number(v) || 0; return x.toLocaleString(undefined, { maximumFractionDigits: 2 }) }
/** مبلغ/نرخ بدون گرد کردن — در عملیات ارزی گرد کردن معنا ندارد و خطای مبلغ می‌سازد */
function nExact(v: any) { const x = Number(v) || 0; return x.toLocaleString(undefined, { maximumFractionDigits: 10 }) }
function signColor(v: number) { return v > 0 ? 'var(--success)' : v < 0 ? 'var(--danger)' : 'var(--text-muted)' }

// ─── جفت‌ارز به شکل متعارف بازار ──────────────────────
// نرخ همیشه «۱ واحد ارز قوی‌تر = چند واحد ارز ضعیف‌تر» خوانده می‌شود (۱ دلار = n تومان،
// ۱ دلار = n یوآن، ۱ یوآن = n تومان). بسته به جهت تبدیل باید ضرب شود یا تقسیم —
// همین جا حساب می‌شود تا کاربر همیشه نرخ را همان‌طور که در بازار می‌گوید وارد کند.
const CUR_RANK: Record<string, number> = { USD: 3, CNY: 2, IRR: 1 }
function pairOf(a: string, b: string) {
  const base = (CUR_RANK[a] ?? 0) >= (CUR_RANK[b] ?? 0) ? a : b
  return { base, quote: base === a ? b : a }
}
/** مبلغ مقصد از روی نرخ متعارف جفت‌ارز */
function convertByRate(fromCur: string, toCur: string, fromAmount: number, pairRate: number): number {
  if (!(fromAmount > 0) || !(pairRate > 0)) return 0
  const { base } = pairOf(fromCur, toCur)
  return fromCur === base ? fromAmount * pairRate : fromAmount / pairRate
}
/** نرخ متعارف جفت‌ارز از روی دو مبلغ */
function rateFromAmounts(fromCur: string, toCur: string, fromAmount: number, toAmount: number): number {
  if (!(fromAmount > 0) || !(toAmount > 0)) return 0
  const { base } = pairOf(fromCur, toCur)
  return fromCur === base ? toAmount / fromAmount : fromAmount / toAmount
}
/** نرخ بازار همان جفت‌ارز (برای راهنمایی کاربر) */
function marketPairRate(rates: any, a: string, b: string): number | null {
  if (!rates) return null
  const irrOf = (c: string) => (c === 'IRR' ? 1 : c === 'USD' ? Number(rates.USD_TO_IRR) : Number(rates.CNY_TO_IRR))
  const { base, quote } = pairOf(a, b)
  const r = irrOf(base) / irrOf(quote)
  return isFinite(r) && r > 0 ? r : null
}

// طرف‌هایی که می‌توانند دو کیف ارزی داشته باشند (مبدأ/مقصد عملیات ارزی)
const PARTY_TYPES: { key: string; label: string }[] = [
  { key: 'COMPANY', label: 'شرکت (حساب‌های خودمان)' },
  ...SETTLE_TYPES.map((t) => ({ key: t.key, label: t.label })),
]

/** پیوست سند — در همان ردیف تراکنش قابل باز کردن باشد */
function Attachments({ urls }: { urls?: string[] }) {
  if (!urls?.length) return null
  return (
    <span className="attach-links">
      {urls.map((u, i) => (
        <a key={u} href={fileUrl(u)} target="_blank" rel="noreferrer" title="مشاهدهٔ پیوست">
          📎{urls.length > 1 ? i + 1 : ''}
        </a>
      ))}
    </span>
  )
}

export default function AccountingPage() {
  const [tab, setTab] = useState('overview')
  const [internalMode, setInternalMode] = useState<InternalMode | null>(null)
  const [showSettlement, setShowSettlement] = useState(false)
  const [showConversion, setShowConversion] = useState(false)

  return (
    <div className="page" dir="rtl">
      <PageHeader
        title="حسابداری"
        subtitle="دفاتر، حساب‌ها و تسویه‌های چند‌ارزی شرکت"
        actions={<>
          <button className="band-chip" title="انتقال بین حساب‌های شرکت، شارژ تنخواه و ثبت خرج — همه در یک پنجره" onClick={() => setInternalMode('transfer')}>🏢 عملیات داخلی</button>
          <button className="band-chip" title="تبدیل ارز بین دو حساب یک طرف حساب" onClick={() => setShowConversion(true)}>🔄 عملیات ارزی</button>
          <button className="band-btn-primary" title="دریافت از مشتری / پرداخت به طرف حساب — هم‌ارز (برای تبدیل واحد از عملیات ارزی)" onClick={() => setShowSettlement(true)}>💰 دریافت / پرداخت</button>
        </>}
        chips={<TabChips value={tab} onChange={setTab} tabs={[
          { key: 'overview', label: 'نمای کلی' },
          { key: 'ledgers', label: 'دفاتر تفصیلی' },
          { key: 'chart', label: 'چارت حساب‌ها' },
          { key: 'accounts', label: 'حساب‌های شرکت' },
          { key: 'journal', label: 'دفتر روزنامه' },
          { key: 'fx', label: 'ریسک ارزی' },
          { key: 'reports', label: 'صورت‌های مالی' },
        ]} />}
      />

      <RatesBar />

      {tab === 'overview' && <OverviewTab />}
      {tab === 'ledgers' && <LedgersTab />}
      {tab === 'chart' && <ChartTab />}
      {tab === 'accounts' && <AccountsTab />}
      {tab === 'journal' && <JournalTab />}
      {tab === 'fx' && <FxRiskTab />}
      {tab === 'reports' && <ReportsTab />}

      {showSettlement && <SettlementModal onClose={() => setShowSettlement(false)} />}
      {internalMode && <InternalOpsModal initialMode={internalMode} onClose={() => setInternalMode(null)} />}
      {showConversion && <ConversionModal onClose={() => setShowConversion(false)} />}
    </div>
  )
}

// ─── نوار نرخ زنده ─────────────────────────────────────
function RatesBar() {
  const qc = useQueryClient()
  const { data: r } = useQuery({ queryKey: ['rates'], queryFn: () => api.get('/accounting/rates').then((x) => x.data), refetchInterval: 5 * 60 * 1000 })
  const refresh = useMutation({
    mutationFn: () => api.post('/accounting/rates/refresh').then((x) => x.data),
    // بازخورد صریح: قبلاً اگر بازار تکان نخورده بود هیچ چیزی روی صفحه عوض نمی‌شد
    // (زمان هم فقط «تاریخ» بود، نه ساعت) و کاربر فکر می‌کرد دکمه کار نمی‌کند.
    onSuccess: (fresh: any) => {
      qc.setQueryData(['rates'], fresh)
      qc.invalidateQueries({ queryKey: ['rates'] })
      const before = Math.round(Number(r?.USD_TO_IRR) || 0)
      const after = Math.round(Number(fresh?.USD_TO_IRR) || 0)
      const diff = after - before
      if (!before || diff === 0) toast.info(`نرخ به‌روز شد — بدون تغییر (دلار ${n(after)} تومان، منبع ${fresh.source})`)
      else toast.success(`نرخ به‌روز شد — دلار ${diff > 0 ? '▲' : '▼'} ${n(Math.abs(diff))} تومان → ${n(after)}`)
    },
    onError: (e: any) => toast.error(e.response?.data?.message || 'به‌روزرسانی نرخ ناموفق بود'),
  })
  if (!r) return null
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      padding: '10px 16px', marginBottom: 16, fontSize: 13,
    }}>
      <span style={{ fontWeight: 700 }}>💱 نرخ لحظه‌ای:</span>
      <span>هر دلار: <strong>{n(r.USD_TO_IRR)}</strong> تومان</span>
      <span>هر یوآن: <strong>{n(r.CNY_TO_IRR)}</strong> تومان</span>
      <span>هر دلار: <strong>{n2(r.USD_TO_CNY)}</strong> یوآن</span>
      {/* ساعت هم نشان داده می‌شود تا اثر «به‌روزرسانی» دیده شود */}
      <span className="hint-sm">منبع: {r.source} — {formatDateTime(r.fetchedAt)}</span>
      {r.isStale && <span style={{ color: 'var(--danger)', fontWeight: 700, fontSize: 12 }}>⚠ نرخ به‌روز نیست</span>}
      <button className="btn-secondary btn-sm" style={{ marginRight: 'auto' }} disabled={refresh.isPending} onClick={() => refresh.mutate()}>
        {refresh.isPending ? '⏳ در حال دریافت…' : '⟳ به‌روزرسانی'}
      </button>
    </div>
  )
}

// ─── نمای کلی (داشبورد مالی) ───────────────────────────
function OverviewTab() {
  const { data: o } = useQuery({ queryKey: ['acc-overview'], queryFn: () => api.get('/accounting/overview').then((r) => r.data) })
  if (!o) return <Loading />

  const Box = ({ title, obj, tone }: any) => (
    <div className="kpi-card" style={{ padding: 16 }}>
      <div className="kpi-label" style={{ marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
        <span>تومان: <strong>{n(obj.IRR)}</strong></span>
        <span>دلار: <strong>{n2(obj.USD)}</strong></span>
        <span>یوآن: <strong>{n2(obj.CNY)}</strong></span>
      </div>
      <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)', fontSize: 13 }}>
        معادل کل: <strong style={{ color: tone }}>{n(obj.totalIRR)}</strong> تومان
      </div>
    </div>
  )

  const alerts: { icon: string; text: string; tone: string }[] = []
  if (o.alerts.ratesStale) alerts.push({ icon: '⚠️', text: 'نرخ ارز زنده در دسترس نیست — از آخرین نرخ/نرخ دستی استفاده می‌شود.', tone: 'var(--danger)' })
  for (const s of o.alerts.shipmentsAwaitingFreight) alerts.push({ icon: '🚚', text: `محموله ${s.code} (${s.carrier}) رسیده — فاکتور حمل ثبت نشده است.`, tone: 'var(--warning, #d97706)' })
  for (const a of o.alerts.negativeCompanyAccounts) alerts.push({ icon: '🏦', text: `حساب «${a.name}» منفی است: ${n(a.balance)} ${CUR[a.currency]}`, tone: 'var(--danger)' })
  if (o.alerts.customersWeOwe.length) alerts.push({ icon: '↩️', text: `${o.alerts.customersWeOwe.length} مشتری از ما طلبکارند (پیش‌پرداخت بیش از فاکتور).`, tone: 'var(--warning, #d97706)' })

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
        <Box title="💰 نقدینگی شرکت" obj={o.cash} tone="var(--primary)" />
        <Box title="📥 طلب از مشتریان" obj={o.receivable} tone="var(--success)" />
        <Box title="📤 بدهی به طرف حساب‌ها" obj={o.payable} tone="var(--danger)" />
        <div className="kpi-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <div className="kpi-label">⚖️ خالص وضعیت مالی</div>
          <div className="kpi-value" style={{ fontSize: 24, color: signColor(o.netPositionIRR) }}>{n(o.netPositionIRR)}</div>
          <div className="hint">تومان (نقد + طلب − بدهی)</div>
        </div>
      </div>

      {alerts.length > 0 && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>🔔 موارد نیازمند توجه</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {alerts.map((a, i) => (
              <div key={i} style={{ fontSize: 13, color: a.tone }}>{a.icon} {a.text}</div>
            ))}
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 14, marginBottom: 8 }}>آخرین اسناد</h3>
      <table className="data-table">
        <thead><tr><th>سند</th><th>تاریخ</th><th>شرح</th><th>رویداد</th><th>پروژه</th><th>ردیف‌ها</th></tr></thead>
        <tbody>
          {o.recentEntries.map((e: any) => (
            <tr key={e.id}>
              <td className="code-text">#{e.entryNo}</td>
              <td style={{ fontSize: 12 }}>{toShamsi(e.date)}</td>
              <td style={{ fontSize: 12 }}>{e.description}</td>
              <td style={{ fontSize: 11 }}>{EVENT_LABELS[e.eventType] || e.eventType || '—'}</td>
              <td className="code-text">{e.project?.code || '—'}</td>
              <td style={{ fontSize: 12 }}>
                {e.lines.map((l: any) => (
                  <div key={l.id}>
                    {l.account.name}: {Number(l.debit) > 0
                      ? <span style={{ color: 'var(--success)' }}>بد {n2(l.debit)}</span>
                      : <span style={{ color: 'var(--danger)' }}>بس {n2(l.credit)}</span>} {CUR[l.currency]}
                  </div>
                ))}
              </td>
            </tr>
          ))}
          {o.recentEntries.length === 0 && <TableEmpty colSpan={6}>هنوز سندی ثبت نشده</TableEmpty>}
        </tbody>
      </table>
    </div>
  )
}

// ─── دفاتر تفصیلی ─────────────────────────────────────
function LedgersTab() {
  const [owner, setOwner] = useState('CUSTOMER')
  const [detail, setDetail] = useState<any>(null)
  const { data: rows = [] } = useQuery({ queryKey: ['ledger', owner], queryFn: () => api.get(`/accounting/ledger/${owner}`).then((r) => r.data) })
  const isCustomer = owner === 'CUSTOMER'

  return (
    <div>
      <div className="settings-tabs">
        {OWNER_TABS.map((t) => (
          <button key={t.key} className={`tab-btn ${owner === t.key ? 'active' : ''}`} onClick={() => setOwner(t.key)}>{t.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span className="hint">
          {isCustomer ? 'مانده مثبت = طلب ما از مشتری' : 'مانده مثبت = بدهی ما به طرف حساب'}
        </span>
        <button className="btn-secondary btn-sm" onClick={() => downloadCsv(`export/ledger/${owner}`, `ledger-${owner}.csv`)}>⬇ خروجی اکسل</button>
      </div>
      <table className="data-table">
        <thead><tr><th>نام</th><th>تومان</th><th>دلار</th><th>یوآن</th><th>معادل کل (تومان)</th><th>اقدام</th></tr></thead>
        <tbody>
          {rows.map((r: any) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td style={{ color: r.IRR < 0 ? 'var(--danger)' : 'inherit' }}>{n(r.IRR)}</td>
              <td style={{ color: r.USD < 0 ? 'var(--danger)' : 'inherit' }}>{n2(r.USD)}</td>
              <td style={{ color: r.CNY < 0 ? 'var(--danger)' : 'inherit' }}>{n2(r.CNY)}</td>
              <td style={{ fontWeight: 700, color: r.totalIRR < 0 ? 'var(--danger)' : 'inherit' }}>{n(r.totalIRR)}</td>
              <td><button className="btn-sm btn-primary" onClick={() => setDetail({ ...r, ownerType: owner })}>جزئیات</button></td>
            </tr>
          ))}
          {rows.length === 0 && <TableEmpty colSpan={6}>دفتری وجود ندارد</TableEmpty>}
        </tbody>
      </table>
      {detail && <LedgerDetailModal owner={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

// ─── پنجره J: جزئیات دفتر ─────────────────────────────
function LedgerDetailModal({ owner, onClose }: any) {
  const { data } = useQuery({ queryKey: ['ledger-detail', owner.ownerType, owner.id], queryFn: () => api.get(`/accounting/ledger/${owner.ownerType}/${owner.id}/detail`).then((r) => r.data) })
  if (!data) return <ModalLoading />

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 900 }}>
        <div className="modal-header"><h2>دفتر حساب: {owner.name}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 20 }}>
            {(['IRR', 'USD', 'CNY'] as const).map((c) => (
              <div key={c} className="kpi-card" style={{ padding: 16 }}>
                <div className="kpi-value" style={{ fontSize: 22, color: (data.balances[c] || 0) < 0 ? 'var(--danger)' : 'var(--primary)' }}>{c === 'IRR' ? n(data.balances[c]) : n2(data.balances[c])}</div>
                <div className="kpi-label">مانده {CUR[c]}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <h3 style={{ fontSize: 14 }}>تفکیک بر اساس پروژه</h3>
            <button className="btn-secondary btn-sm" onClick={() => downloadCsv(`export/ledger/${owner.ownerType}/${owner.id}`, `ledger-${owner.name}.csv`)}>⬇ خروجی اکسل</button>
          </div>
          <table className="data-table" style={{ marginBottom: 20 }}>
            <thead><tr><th>پروژه</th><th>تومان</th><th>دلار</th><th>یوآن</th></tr></thead>
            <tbody>
              {data.projects.map((p: any) => (
                <tr key={p.id}><td className="code-text">{p.code}</td><td>{n(p.IRR)}</td><td>{n2(p.USD)}</td><td>{n2(p.CNY)}</td></tr>
              ))}
              {data.projects.length === 0 && <TableEmpty colSpan={4}>—</TableEmpty>}
            </tbody>
          </table>

          <h3 style={{ fontSize: 14, marginBottom: 8 }}>تاریخچه تراکنش‌ها</h3>
          <p className="hint-sm" style={{ marginBottom: 8 }}>
            ستون «مانده» تجمعی است و برای هر ارز جداگانه محاسبه می‌شود — یعنی جلوی هر ردیف
            می‌بینی تا آن لحظه چقدر {owner.ownerType === 'CUSTOMER' ? 'طلب داشتی' : 'بدهکار بودی'}.
            مثبت = {owner.ownerType === 'CUSTOMER' ? 'طلب از طرف حساب' : 'بدهی شرکت به طرف حساب'}.
          </p>
          <div className="table-container">
            <table className="data-table">
              <thead><tr>
                <th>تاریخ</th><th>سند</th><th>شرح</th><th>پروژه</th>
                <th>بدهکار</th><th>بستانکار</th><th>ارز</th><th>مانده</th><th>پیوست</th>
              </tr></thead>
              <tbody>
                {data.history.map((l: any) => (
                  <tr key={l.id} style={l.entry.status === 'REVERSED' ? { opacity: 0.5, textDecoration: 'line-through' } : undefined}>
                    <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{toShamsi(l.entry.date)}</td>
                    <td className="code-text" style={{ fontSize: 12 }}>#{l.entry.entryNo}</td>
                    <td style={{ fontSize: 12 }}>{l.entry.description}</td>
                    <td className="code-text">{l.entry.project?.code || '-'}</td>
                    <td style={{ color: 'var(--success)', whiteSpace: 'nowrap' }}>{Number(l.debit) > 0 ? nExact(l.debit) : ''}</td>
                    <td style={{ color: 'var(--danger)', whiteSpace: 'nowrap' }}>{Number(l.credit) > 0 ? nExact(l.credit) : ''}</td>
                    <td>{CUR[l.currency]}</td>
                    <td style={{ fontWeight: 700, whiteSpace: 'nowrap', color: signColor(l.running) }}>
                      {l.currency === 'IRR' ? n(l.running) : nExact(l.running)}
                    </td>
                    <td style={{ textAlign: 'center' }}><Attachments urls={l.entry.attachmentUrls} /></td>
                  </tr>
                ))}
                {data.history.length === 0 && <TableEmpty colSpan={9}>تراکنشی ثبت نشده</TableEmpty>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── صورت‌های مالی ─────────────────────────────────────
// همه از دفتر ساخته می‌شوند با نرخِ خودِ هر ردیف (نه نرخ امروز) — spec ۵-۴
function ReportsTab() {
  const [view, setView] = useState<'balance' | 'income' | 'trial' | 'agingAr' | 'agingAp' | 'reval' | 'integrity'>('balance')
  const [asOf, setAsOf] = useState('')
  const [from, setFrom] = useState('')

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
        <div className="settings-tabs" style={{ margin: 0 }}>
          {([
            ['balance', 'ترازنامه'],
            ['income', 'سود و زیان'],
            ['trial', 'تراز آزمایشی'],
            ['agingAr', 'سن‌بندی مطالبات'],
            ['agingAp', 'سن‌بندی بدهی‌ها'],
            ['reval', 'تجدید ارزیابی'],
            ['integrity', 'سلامت دفاتر'],
          ] as const).map(([k, label]) => (
            <button key={k} className={`tab-btn ${view === k ? 'active' : ''}`} onClick={() => setView(k)}>{label}</button>
          ))}
        </div>
        {view !== 'integrity' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            {view === 'income' && (
              <div className="form-group" style={{ margin: 0 }}><label>از تاریخ</label><DateField value={from} onChange={setFrom} /></div>
            )}
            <div className="form-group" style={{ margin: 0 }}>
              <label>{view === 'income' ? 'تا تاریخ' : 'در تاریخ'}</label>
              <DateField value={asOf} onChange={setAsOf} />
            </div>
          </div>
        )}
      </div>

      {view === 'balance' && <BalanceSheetView asOf={asOf} />}
      {view === 'income' && <IncomeStatementView from={from} to={asOf} />}
      {view === 'trial' && <TrialBalanceView asOf={asOf} />}
      {view === 'agingAr' && <AgingView side="receivable" asOf={asOf} />}
      {view === 'agingAp' && <AgingView side="payable" asOf={asOf} />}
      {view === 'reval' && <RevaluationView asOf={asOf} />}
      {view === 'integrity' && <IntegrityView />}
    </div>
  )
}

function GroupBlock({ group, tone }: { group: any; tone?: string }) {
  if (!group) return null
  return (
    <>
      <tr style={{ background: 'var(--surface-2)' }}>
        <td colSpan={2} style={{ fontWeight: 800, color: tone }}>{group.label}</td>
        <td style={{ fontWeight: 800, textAlign: 'left', color: tone }}>{n(group.total)}</td>
      </tr>
      {group.accounts.map((a: any) => (
        <tr key={a.id}>
          <td className="code-text" style={{ paddingRight: 22 }}>{a.code || '—'}</td>
          <td style={{ fontSize: 12.5 }}>{a.name}</td>
          <td style={{ textAlign: 'left', whiteSpace: 'nowrap', color: signColor(a.balanceIRR) }}>{n(a.balanceIRR)}</td>
        </tr>
      ))}
      {group.accounts.length === 0 && (
        <tr><td colSpan={3} className="hint" style={{ paddingRight: 22 }}>گردشی ندارد</td></tr>
      )}
    </>
  )
}

function BalanceSheetView({ asOf }: { asOf: string }) {
  const { data } = useQuery({
    queryKey: ['balance-sheet', asOf],
    queryFn: () => api.get('/accounting/reports/balance-sheet', { params: asOf ? { asOf } : {} }).then((r) => r.data),
  })
  if (!data) return <Loading />

  return (
    <div>
      {!data.balanced && (
        <div className="error-msg" style={{ marginBottom: 12 }}>
          ⚠️ ترازنامه تراز نیست (اختلاف {n(data.difference)} تومان).
          {data.unclassified?.length > 0 && <> علت: {data.unclassified.length} حساب طبقه‌بندی‌نشده — {data.unclassified.map((u: any) => u.name).join('، ')}</>}
        </div>
      )}
      <div className="table-container">
        <table className="data-table">
          <thead><tr><th style={{ width: 80 }}>کد</th><th>حساب</th><th style={{ width: 180, textAlign: 'left' }}>مانده (تومان)</th></tr></thead>
          <tbody>
            <GroupBlock group={data.asset} tone="var(--brand)" />
            <tr><td colSpan={3} style={{ height: 8, padding: 0, border: 'none' }} /></tr>
            <GroupBlock group={data.liability} tone="var(--danger)" />
            <tr><td colSpan={3} style={{ height: 8, padding: 0, border: 'none' }} /></tr>
            <GroupBlock group={data.equity} tone="var(--accent)" />
            <tr>
              <td className="code-text" style={{ paddingRight: 22 }}>—</td>
              <td style={{ fontSize: 12.5 }}>سود انباشته (درآمد − هزینه تا این تاریخ)</td>
              <td style={{ textAlign: 'left', color: signColor(data.retainedEarnings) }}>{n(data.retainedEarnings)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800 }}>
              <td colSpan={2}>جمع دارایی‌ها</td>
              <td style={{ textAlign: 'left' }}>{n(data.totalAssets)}</td>
            </tr>
            <tr style={{ fontWeight: 800 }}>
              <td colSpan={2}>جمع بدهی‌ها + سرمایه</td>
              <td style={{ textAlign: 'left' }}>{n(data.totalLiabilitiesAndEquity)}</td>
            </tr>
            <tr style={{ color: data.balanced ? 'var(--success)' : 'var(--danger)', fontWeight: 800 }}>
              <td colSpan={2}>{data.balanced ? '✓ معادلهٔ حسابداری برقرار است' : '✗ اختلاف'}</td>
              <td style={{ textAlign: 'left' }}>{n(data.difference)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

function IncomeStatementView({ from, to }: { from: string; to: string }) {
  const params: any = {}
  if (from) params.from = from
  if (to) params.to = to
  const { data } = useQuery({
    queryKey: ['income-statement', from, to],
    queryFn: () => api.get('/accounting/reports/income-statement', { params }).then((r) => r.data),
  })
  if (!data) return <Loading />

  return (
    <div className="table-container">
      <table className="data-table">
        <thead><tr><th style={{ width: 80 }}>کد</th><th>حساب</th><th style={{ width: 180, textAlign: 'left' }}>مبلغ (تومان)</th></tr></thead>
        <tbody>
          <GroupBlock group={data.income} tone="var(--success)" />
          <tr><td colSpan={3} style={{ height: 8, padding: 0, border: 'none' }} /></tr>
          <GroupBlock group={data.expense} tone="var(--danger)" />
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800, fontSize: 14 }}>
            <td colSpan={2}>{data.netProfit >= 0 ? 'سود خالص دوره' : 'زیان خالص دوره'}</td>
            <td style={{ textAlign: 'left', color: signColor(data.netProfit) }}>{n(data.netProfit)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function TrialBalanceView({ asOf }: { asOf: string }) {
  const { data } = useQuery({
    queryKey: ['trial-balance', asOf],
    queryFn: () => api.get('/accounting/reports/trial-balance', { params: asOf ? { asOf } : {} }).then((r) => r.data),
  })
  if (!data) return <Loading />

  return (
    <div className="table-container">
      <table className="data-table">
        <thead><tr>
          <th style={{ width: 80 }}>کد</th><th>حساب</th>
          <th style={{ width: 160, textAlign: 'left' }}>بدهکار</th>
          <th style={{ width: 160, textAlign: 'left' }}>بستانکار</th>
        </tr></thead>
        <tbody>
          {data.rows.map((r: any) => (
            <tr key={r.id}>
              <td className="code-text">{r.code || '—'}</td>
              <td style={{ fontSize: 12.5 }}>{r.name}</td>
              <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{r.debitIRR ? n(r.debitIRR) : ''}</td>
              <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{r.creditIRR ? n(r.creditIRR) : ''}</td>
            </tr>
          ))}
          {data.rows.length === 0 && <TableEmpty colSpan={4}>گردشی ثبت نشده</TableEmpty>}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800 }}>
            <td colSpan={2}>جمع کل</td>
            <td style={{ textAlign: 'left' }}>{n(data.totalDebit)}</td>
            <td style={{ textAlign: 'left' }}>{n(data.totalCredit)}</td>
          </tr>
          <tr style={{ color: data.balanced ? 'var(--success)' : 'var(--danger)', fontWeight: 800 }}>
            <td colSpan={3}>{data.balanced ? '✓ بدهکار و بستانکار برابرند' : '✗ اختلاف'}</td>
            <td style={{ textAlign: 'left' }}>{n(data.difference)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function IntegrityView() {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['integrity'],
    queryFn: () => api.get('/accounting/reports/integrity').then((r) => r.data),
  })
  if (!data) return <Loading />

  const Card = ({ title, count, desc }: any) => (
    <div className="kpi-card" style={{ padding: 14 }}>
      <div className="kpi-value" style={{ fontSize: 20, color: count === 0 ? 'var(--success)' : 'var(--danger)' }}>
        {count === 0 ? '✓' : count}
      </div>
      <div className="kpi-label">{title}</div>
      <div className="hint-sm" style={{ marginTop: 4 }}>{desc}</div>
    </div>
  )

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 800, fontSize: 15, color: data.ok ? 'var(--success)' : 'var(--danger)' }}>
          {data.ok ? '✓ دفاتر سالم‌اند' : '✗ دفاتر مشکل دارند'}
          <span className="hint-sm" style={{ marginRight: 8, fontWeight: 400 }}>
            ({data.checked.accounts} حساب، {data.checked.entries} سند بررسی شد)
          </span>
        </div>
        <button className="btn-secondary btn-sm" disabled={isFetching} onClick={() => refetch()}>⟳ بررسی دوباره</button>
      </div>

      <div className="grid-3" style={{ gap: 10, marginBottom: 16 }}>
        <Card title="انحراف ماندهٔ ذخیره‌شده" count={data.drift.length} desc="ماندهٔ کش‌شده با جمع دفتر بخواند" />
        <Card title="حساب طبقه‌بندی‌نشده" count={data.unclassified.length} desc="حسابی که در ترازنامه جا می‌ماند" />
        <Card title="سند ناتراز" count={data.unbalanced.length} desc="بدهکار برابر بستانکار نیست" />
      </div>

      {data.drift.length > 0 && (
        <>
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>انحراف مانده</h3>
          <table className="data-table" style={{ marginBottom: 16 }}>
            <thead><tr><th>حساب</th><th>ارز</th><th>ذخیره‌شده</th><th>جمع دفتر</th><th>اختلاف</th></tr></thead>
            <tbody>
              {data.drift.map((d: any) => (
                <tr key={d.id}>
                  <td>{d.name}</td><td>{CUR[d.currency]}</td>
                  <td>{nExact(d.stored)}</td><td>{nExact(d.ledger)}</td>
                  <td style={{ color: 'var(--danger)', fontWeight: 700 }}>{nExact(d.diff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {data.unbalanced.length > 0 && (
        <>
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>اسناد ناتراز</h3>
          <table className="data-table">
            <thead><tr><th>سند</th><th>شرح</th><th>اختلاف</th></tr></thead>
            <tbody>
              {data.unbalanced.map((u: any) => (
                <tr key={u.entryNo}>
                  <td className="code-text">#{u.entryNo}</td><td>{u.description}</td>
                  <td style={{ color: 'var(--danger)', fontWeight: 700 }}>{n(u.diff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {data.ok && (
        <p className="hint">
          هر سه بررسی سبز است: ماندهٔ ذخیره‌شدهٔ همهٔ حساب‌ها با جمع ردیف‌های دفترشان می‌خواند،
          هیچ حسابی بدون طبقه‌بندی نمانده، و هیچ سند ناترازی در دفتر نیست.
        </p>
      )}
    </div>
  )
}


// ─── سن‌بندی مطالبات / بدهی‌ها ──────────────────────────
// تخصیص FIFO: هر تسویه از قدیمی‌ترین تعهدِ باز کم می‌شود، پس آنچه می‌ماند سنِ
// واقعی خودش را دارد. مرجع: docs/accounting-spec.md بخش ۵-۴
function AgingView({ side, asOf }: { side: 'receivable' | 'payable'; asOf: string }) {
  const { data } = useQuery({
    queryKey: ['aging', side, asOf],
    queryFn: () => api.get(`/accounting/reports/aging/${side}`, { params: asOf ? { asOf } : {} }).then((r) => r.data),
  })
  if (!data) return <Loading />

  const isAR = side === 'receivable'
  // هرچه سن بیشتر، نگران‌کننده‌تر
  const bucketTone = (i: number) => ['var(--success)', 'var(--text)', 'var(--accent)', 'var(--danger)'][i]

  return (
    <div>
      <div className="grid-4" style={{ gap: 10, marginBottom: 16 }}>
        {data.buckets.map((b: any, i: number) => (
          <div key={b.key} className="kpi-card" style={{ padding: 14 }}>
            <div className="kpi-value" style={{ fontSize: 17, color: bucketTone(i) }}>{n(b.total)}</div>
            <div className="kpi-label">{b.label}</div>
          </div>
        ))}
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead><tr>
            <th>{isAR ? 'مشتری' : 'طرف حساب'}</th>
            <th style={{ width: 130 }}>ماندهٔ باز</th>
            {data.buckets.map((b: any) => <th key={b.key} style={{ width: 120, textAlign: 'left' }}>{b.label}</th>)}
            <th style={{ width: 90 }}>قدیمی‌ترین</th>
            <th style={{ width: 140, textAlign: 'left' }}>معادل تومان</th>
          </tr></thead>
          <tbody>
            {data.rows.map((r: any) => (
              <tr key={r.accountId}>
                <td style={{ fontSize: 12.5 }}>{r.name}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{nExact(r.balance)} <span className="muted">{CUR[r.currency]}</span></td>
                {data.buckets.map((b: any, i: number) => (
                  <td key={b.key} style={{ textAlign: 'left', whiteSpace: 'nowrap', color: r.buckets[b.key] ? bucketTone(i) : 'var(--text-muted)' }}>
                    {r.buckets[b.key] ? nExact(r.buckets[b.key]) : '—'}
                  </td>
                ))}
                <td style={{ color: r.oldestDays > 90 ? 'var(--danger)' : r.oldestDays > 60 ? 'var(--accent)' : 'inherit', fontWeight: r.oldestDays > 60 ? 700 : 400 }}>
                  {r.oldestDays} روز
                </td>
                <td style={{ textAlign: 'left', fontWeight: 700, whiteSpace: 'nowrap' }}>{n(r.totalIRR)}</td>
              </tr>
            ))}
            {data.rows.length === 0 && <TableEmpty colSpan={data.buckets.length + 4}>{isAR ? 'طلب بازی نیست' : 'بدهی بازی نیست'}</TableEmpty>}
          </tbody>
          {data.rows.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800 }}>
                <td colSpan={data.buckets.length + 3}>جمع کل ({data.rows.length} طرف حساب)</td>
                <td style={{ textAlign: 'left' }}>{n(data.grandTotal)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <p className="hint" style={{ marginTop: 10 }}>
        سن هر مبلغ از تاریخ ثبت همان تعهد حساب می‌شود. چون پرداخت‌ها به فاکتور مشخصی تخصیص داده نمی‌شوند،
        هر تسویه از <strong>قدیمی‌ترین</strong> بدهی باز کم می‌شود (روش FIFO).
      </p>
    </div>
  )
}

// ─── تجدید ارزیابی ارزی پایان دوره ─────────────────────
// عملیات پایان دوره: ارزش ریالی اقلام ارزی باز به نرخ روز به‌روز می‌شود و سند
// برگشتش همان لحظه برای روز بعد ساخته می‌شود. مرجع: spec بخش ۴-۴
function RevaluationView({ asOf }: { asOf: string }) {
  const qc = useQueryClient()
  const [error, setError] = useState('')

  const { data, refetch, isFetching } = useQuery({
    queryKey: ['reval-preview', asOf],
    queryFn: () => api.get('/accounting/revaluation/preview', { params: asOf ? { asOf } : {} }).then((r) => r.data),
  })

  const post = useMutation({
    mutationFn: () => api.post('/accounting/revaluation', asOf ? { asOf } : {}).then((r) => r.data),
    onSuccess: (r: any) => {
      if (r.posted) toast.success(`ثبت شد — سند #${r.entryNo} و برگشتش #${r.reversalEntryNo}`)
      else toast.info(r.reason || 'چیزی برای ثبت نبود')
      qc.invalidateQueries()
    },
    onError: (e: any) => setError(e.response?.data?.message || 'خطا در ثبت'),
  })

  if (!data) return <Loading />

  const confirmPost = async () => {
    setError('')
    const ok = await dialog.confirm({
      title: 'ثبت تجدید ارزیابی؟',
      message: `دو سند ثبت می‌شود: تعدیل به تاریخ انتخابی، و برگشت آن در روز بعد. `
        + `اثر خالص: ${data.netIRR >= 0 ? 'سود' : 'زیان'} ${n(Math.abs(data.netIRR))} تومان تحقق‌نیافته.`,
      confirmLabel: 'ثبت کن',
    })
    if (ok) post.mutate()
  }

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ fontSize: 13 }}>
          دورهٔ <strong>{data.period.year}/{String(data.period.month).padStart(2, '0')}</strong>
          <span className="muted"> · نرخ‌ها: هر دلار {n(data.rates.USD)} · هر یوآن {n(data.rates.CNY)}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-secondary btn-sm" disabled={isFetching} onClick={() => refetch()}>⟳ محاسبهٔ دوباره</button>
          <button className="btn-primary btn-sm" disabled={data.alreadyPosted || !data.lines.length || post.isPending} onClick={confirmPost}>
            ثبت تجدید ارزیابی
          </button>
        </div>
      </div>

      {data.alreadyPosted && (
        <div className="hint" style={{ marginBottom: 12, color: 'var(--accent)' }}>
          ⚠️ برای این دوره قبلاً تجدید ارزیابی ثبت شده است. برای دورهٔ دیگری تاریخ را عوض کنید.
        </div>
      )}
      {error && <div className="error-msg" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="grid-3" style={{ gap: 10, marginBottom: 16 }}>
        <div className="kpi-card" style={{ padding: 14 }}>
          <div className="kpi-value" style={{ fontSize: 18, color: 'var(--success)' }}>{n(data.totalGain)}</div>
          <div className="kpi-label">سود تحقق‌نیافته</div>
        </div>
        <div className="kpi-card" style={{ padding: 14 }}>
          <div className="kpi-value" style={{ fontSize: 18, color: 'var(--danger)' }}>{n(data.totalLoss)}</div>
          <div className="kpi-label">زیان تحقق‌نیافته</div>
        </div>
        <div className="kpi-card" style={{ padding: 14 }}>
          <div className="kpi-value" style={{ fontSize: 18, color: signColor(data.netIRR) }}>{n(data.netIRR)}</div>
          <div className="kpi-label">اثر خالص</div>
        </div>
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead><tr>
            <th>حساب ارزی</th>
            <th style={{ width: 130 }}>ماندهٔ باز</th>
            <th style={{ width: 100 }}>نرخ روز</th>
            <th style={{ width: 150, textAlign: 'left' }}>ارزش دفتری</th>
            <th style={{ width: 150, textAlign: 'left' }}>ارزش به نرخ روز</th>
            <th style={{ width: 150, textAlign: 'left' }}>اختلاف</th>
          </tr></thead>
          <tbody>
            {data.lines.map((l: any) => (
              <tr key={l.accountId}>
                <td style={{ fontSize: 12.5 }}>{l.accountName}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{nExact(l.balance)} <span className="muted">{CUR[l.currency]}</span></td>
                <td style={{ whiteSpace: 'nowrap' }}>{n(l.rate)}</td>
                <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{n(l.carryingIRR)}</td>
                <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{n(l.currentIRR)}</td>
                <td style={{ textAlign: 'left', whiteSpace: 'nowrap', fontWeight: 700, color: signColor(l.deltaIRR) }}>{n(l.deltaIRR)}</td>
              </tr>
            ))}
            {data.lines.length === 0 && <TableEmpty colSpan={6}>هیچ قلم ارزی بازی با اختلاف ارزش وجود ندارد</TableEmpty>}
          </tbody>
        </table>
      </div>

      <p className="hint" style={{ marginTop: 10 }}>
        فقط اقلام <strong>پولی</strong> (دارایی و بدهی ارزی) تجدید ارزیابی می‌شوند؛ درآمد و هزینه به بهای تاریخی می‌مانند.
        تعدیل به تومان در حساب‌های «تعدیل تسعیر» می‌نشیند و <strong>ماندهٔ ارزی دست نمی‌خورد</strong>.
        سند برگشت همان لحظه برای روز بعد ساخته می‌شود تا وقتی این تعهد واقعاً تسویه شد، سود دوبار شمرده نشود.
      </p>
    </div>
  )
}

// ─── چارت حساب‌ها (درخت) ───────────────────────────────
// ساختار: ۱xxx دارایی · ۲xxx بدهی · ۳xxx سرمایه · ۴xxx درآمد · ۵xxx هزینه
// سرگروه‌ها سند نمی‌گیرند و فقط تجمیع می‌کنند؛ کیف پول طرف‌حساب‌ها دفتر معین‌اند
// و زیر گروه ارزی خودشان می‌نشینند. مرجع: docs/accounting-spec.md
const ACCOUNT_TYPE_FA: Record<string, string> = {
  ASSET: 'دارایی', LIABILITY: 'بدهی', EQUITY: 'سرمایه', INCOME: 'درآمد', EXPENSE: 'هزینه',
}
const ACCOUNT_TYPE_TONE: Record<string, string> = {
  ASSET: 'var(--brand)', LIABILITY: 'var(--danger)', EQUITY: 'var(--accent)',
  INCOME: 'var(--success)', EXPENSE: 'var(--text-muted)',
}

function ChartTab() {
  const qc = useQueryClient()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [showSubledger, setShowSubledger] = useState(false)
  const [search, setSearch] = useState('')

  const { data: roots = [], isLoading } = useQuery({
    queryKey: ['chart'],
    queryFn: () => api.get('/accounting/chart').then((r) => r.data),
  })

  const ensure = useMutation({
    mutationFn: () => api.post('/accounting/chart/ensure'),
    onSuccess: (r: any) => { toast.success(`چارت تکمیل شد (${r.data.nodes} گره)`); qc.invalidateQueries({ queryKey: ['chart'] }) },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  const toggle = (id: string) => {
    const n = new Set(collapsed)
    n.has(id) ? n.delete(id) : n.add(id)
    setCollapsed(n)
  }

  if (isLoading) return <Loading />

  // کیف پول‌های طرف‌حساب دفتر معین‌اند — پیش‌فرض پنهان تا چارت شلوغ نشود
  const isSubledger = (n: any) => !n.code && n.ownerType && n.ownerType !== 'COMPANY'

  const matches = (n: any): boolean => {
    if (!search) return true
    const s = search.trim().toLowerCase()
    if ((n.code || '').includes(s) || n.name.toLowerCase().includes(s)) return true
    return (n.children || []).some(matches)
  }

  const rows: any[] = []
  const walk = (node: any, depth: number) => {
    if (isSubledger(node) && !showSubledger) return
    if (!matches(node)) return
    rows.push({ node, depth })
    if (collapsed.has(node.id)) return
    for (const c of node.children || []) walk(c, depth + 1)
  }
  roots.forEach((r: any) => walk(r, 0))

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input placeholder="جستجوی کد یا نام حساب..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
          <label className="chip-soft" style={{ cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={showSubledger} onChange={(e) => setShowSubledger(e.target.checked)} />
            نمایش دفتر معین (کیف پول طرف‌حساب‌ها)
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-secondary btn-sm" onClick={() => setCollapsed(new Set())}>باز کردن همه</button>
          <button className="btn-secondary btn-sm" onClick={() => setCollapsed(new Set(rows.filter((r) => r.node.children?.length).map((r) => r.node.id)))}>بستن همه</button>
          <button className="btn-secondary btn-sm" disabled={ensure.isPending} onClick={() => ensure.mutate()} title="ساخت/تکمیل گره‌های استاندارد چارت — تکرارش بی‌خطر است">🧩 تکمیل چارت</button>
        </div>
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead><tr>
            <th style={{ width: 70 }}>کد</th>
            <th>نام حساب</th>
            <th style={{ width: 80 }}>نوع</th>
            <th style={{ width: 210 }}>مانده به تفکیک ارز</th>
            <th style={{ width: 150 }}>معادل تومان</th>
          </tr></thead>
          <tbody>
            {rows.map(({ node, depth }) => {
              const hasKids = (node.children || []).length > 0
              const isGroup = !node.isPostable
              const shut = collapsed.has(node.id)
              return (
                <tr key={node.id} style={isGroup ? { background: depth === 0 ? 'var(--surface-2)' : undefined } : undefined}>
                  <td className="code-text" style={{ fontWeight: depth === 0 ? 800 : 600, whiteSpace: 'nowrap' }}>{node.code || '—'}</td>
                  <td style={{ paddingRight: 8 + depth * 20 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {hasKids ? (
                        <button className="icon-btn" style={{ width: 20, height: 20, fontSize: 11 }} onClick={() => toggle(node.id)}
                          title={shut ? 'باز کردن' : 'بستن'}>{shut ? '▶' : '▼'}</button>
                      ) : <span style={{ width: 20, display: 'inline-block' }} />}
                      <span style={{ fontWeight: depth === 0 ? 800 : isGroup ? 650 : 400, fontSize: depth === 0 ? 13.5 : 13 }}>{node.name}</span>
                      {isGroup && <span className="chip-soft" title="سرگروه فقط تجمیع می‌کند و سند نمی‌گیرد">سرگروه</span>}
                      {isSubledger(node) && <span className="chip-soft" title="ردیف دفتر معین">معین</span>}
                    </span>
                  </td>
                  <td>
                    {node.accountType && (
                      <span className="chip-soft" style={{ color: ACCOUNT_TYPE_TONE[node.accountType], fontWeight: 700 }}>
                        {ACCOUNT_TYPE_FA[node.accountType]}
                      </span>
                    )}
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {Object.entries(node.byCur || {}).filter(([, v]) => Number(v) !== 0).map(([cur, v]) => (
                      <div key={cur} style={{ whiteSpace: 'nowrap', color: signColor(Number(v)) }}>
                        {nExact(v)} <span className="muted">{CUR[cur]}</span>
                      </div>
                    ))}
                  </td>
                  <td style={{ fontWeight: 700, whiteSpace: 'nowrap', color: signColor(node.totalIRR) }}>
                    {node.totalIRR ? n(node.totalIRR) : '—'}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && <TableEmpty colSpan={5}>حسابی یافت نشد</TableEmpty>}
          </tbody>
        </table>
      </div>

      <p className="hint" style={{ marginTop: 12 }}>
        مانده‌ها با <strong>علامت طبیعی</strong> نمایش داده می‌شوند: بدهی و درآمد وقتی مثبت‌اند یعنی واقعاً بدهکاریم / درآمد داشته‌ایم.
        ماندهٔ هر سرگروه دقیقاً جمع فرزندانش است، پس دفتر معین هرگز از دفتر کل منحرف نمی‌شود.
      </p>
    </div>
  )
}

// ─── حساب‌های شرکت ─────────────────────────────────────
function AccountsTab() {
  const qc = useQueryClient()
  const [name, setName] = useState(''); const [type, setType] = useState('BANK'); const [currency, setCurrency] = useState('IRR'); const [openingBalance, setOpening] = useState('')
  const [statement, setStatement] = useState<any>(null)
  const { data: accounts = [] } = useQuery({ queryKey: ['company-accounts'], queryFn: () => api.get('/accounting/accounts').then((r) => r.data) })
  const create = useMutation({
    mutationFn: () => api.post('/accounting/accounts', { name, type, currency, openingBalance: openingBalance || 0 }),
    onSuccess: () => { qc.invalidateQueries(); setName(''); setOpening('') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const rename = useMutation({
    mutationFn: ({ id, newName }: any) => api.patch(`/accounting/accounts/${id}`, { name: newName }),
    onSuccess: () => qc.invalidateQueries(),
  })
  const deactivate = useMutation({
    mutationFn: (id: string) => api.patch(`/accounting/accounts/${id}`, { isActive: false }),
    onSuccess: () => qc.invalidateQueries(),
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const TYPE_LABEL: Record<string, string> = { BANK: 'بانک', EXCHANGE: 'صرافی', WALLET: 'کیف پول', CASH: 'صندوق', PETTY_CASH: 'تنخواه', CASH_DEFAULT: 'صندوق پیش‌فرض' }
  const sort = useSort('name', 'asc')
  const rows = sort.apply(accounts as any[], {
    name: (a) => a.name,
    type: (a) => TYPE_LABEL[a.type] || a.type,
    currency: (a) => a.currency,
    balance: (a) => Number(a.balance),
  })

  return (
    <div>
      <div className="add-form">
        <input placeholder="نام حساب" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 200 }} />
        <select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 140 }}>
          <option value="BANK">بانک</option><option value="EXCHANGE">صرافی</option><option value="WALLET">کیف پول دیجیتال</option><option value="CASH">صندوق</option><option value="PETTY_CASH">تنخواه</option>
        </select>
        <select value={currency} onChange={(e) => setCurrency(e.target.value)} style={{ maxWidth: 110 }}>
          <option value="IRR">تومان</option><option value="USD">دلار</option><option value="CNY">یوآن</option>
        </select>
        <NumberInput placeholder="موجودی اولیه" value={openingBalance} onChange={setOpening} style={{ maxWidth: 150 }} decimals />
        <button className="btn-primary btn-sm" disabled={!name || create.isPending} onClick={() => create.mutate()}>افزودن حساب</button>
      </div>
      <p className="hint-sm" style={{ margin: '4px 0 12px'  }}>موجودی اولیه با «سند افتتاحیه» دوطرفه ثبت می‌شود و در دفتر روزنامه قابل ردیابی است.</p>
      <table className="data-table">
        <thead><tr>
          <SortTH label="نام حساب" k="name" sort={sort} />
          <SortTH label="نوع" k="type" sort={sort} />
          <SortTH label="ارز" k="currency" sort={sort} />
          <SortTH label="موجودی" k="balance" sort={sort} />
          <th>اقدام</th>
        </tr></thead>
        <tbody>
          {rows.map((a: any) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td>{TYPE_LABEL[a.type] || a.type}</td>
              <td>{CUR[a.currency]}</td>
              <td style={{ fontWeight: 700, color: Number(a.balance) < 0 ? 'var(--danger)' : 'inherit' }}>{a.currency === 'IRR' ? n(a.balance) : n2(a.balance)} {CUR[a.currency]}</td>
              <td style={{ display: 'flex', gap: 6 }}>
                <button className="btn-sm btn-primary" onClick={() => setStatement(a)}>📄 صورتحساب</button>
                <button className="btn-sm btn-secondary" onClick={async () => { const newName = await dialog.prompt({ title: 'تغییر نام حساب', message: `نام فعلی: ${a.name}`, defaultValue: a.name, placeholder: 'نام جدید', required: true }); if (newName && newName !== a.name) rename.mutate({ id: a.id, newName }) }}>✏️</button>
                <button className="btn-sm btn-secondary" title="غیرفعال‌سازی" onClick={async () => { if (await dialog.confirm({ title: `حساب «${a.name}» غیرفعال شود؟`, message: 'تاریخچه و تراکنش‌های این حساب حفظ می‌شود؛ فقط از فهرست حساب‌های فعال خارج می‌شود.', confirmLabel: 'غیرفعال کن', tone: 'danger' })) deactivate.mutate(a.id) }}>🗑</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && <TableEmpty colSpan={5}>حسابی تعریف نشده</TableEmpty>}
        </tbody>
      </table>
      {statement && <StatementModal account={statement} onClose={() => setStatement(null)} />}
    </div>
  )
}

// ─── صورتحساب حساب (مانده سطر به سطر) ─────────────────
function StatementModal({ account, onClose }: any) {
  const { data } = useQuery({ queryKey: ['statement', account.id], queryFn: () => api.get(`/accounting/accounts/${account.id}/statement`).then((r) => r.data) })
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 880 }}>
        <div className="modal-header">
          <h2>صورتحساب: {account.name} ({CUR[account.currency]})</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {!data ? <Loading /> : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 13 }}>
                  مانده فعلی: <strong style={{ color: Number(data.account.balance) < 0 ? 'var(--danger)' : 'var(--primary)' }}>
                    {account.currency === 'IRR' ? n(data.account.balance) : n2(data.account.balance)} {CUR[account.currency]}
                  </strong>
                </span>
                <button className="btn-secondary btn-sm" onClick={() => downloadCsv(`export/statement/${account.id}`, `statement-${account.name}.csv`)}>⬇ خروجی اکسل</button>
              </div>
              <table className="data-table">
                <thead><tr><th>سند</th><th>تاریخ</th><th>شرح</th><th>پروژه</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th><th>پیوست</th></tr></thead>
                <tbody>
                  {data.rows.map((r: any) => (
                    <tr key={r.id}>
                      <td className="code-text">#{r.entryNo}</td>
                      <td style={{ fontSize: 12 }}>{toShamsi(r.date)}</td>
                      <td style={{ fontSize: 12 }}>{r.description}{r.memo ? ` — ${r.memo}` : ''}</td>
                      <td className="code-text">{r.project || '-'}</td>
                      <td style={{ color: 'var(--success)' }}>{r.debit > 0 ? nExact(r.debit) : ''}</td>
                      <td style={{ color: 'var(--danger)' }}>{r.credit > 0 ? nExact(r.credit) : ''}</td>
                      <td style={{ fontWeight: 700, color: r.running < 0 ? 'var(--danger)' : 'inherit' }}>{nExact(r.running)}</td>
                      <td style={{ textAlign: 'center' }}><Attachments urls={r.attachmentUrls} /></td>
                    </tr>
                  ))}
                  {data.rows.length === 0 && <TableEmpty colSpan={8}>گردشی ثبت نشده</TableEmpty>}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── ویرایشگر سند دستی (ثبت جدید یا اصلاح سند موجود) ───
// دو ردیف اولیه، افزودن/حذف ردیف، جمع بدهکار/بستانکار زنده و هشدار عدم تراز.
function ManualEntryModal({ entryId, onClose }: { entryId?: string; onClose: () => void }) {
  const qc = useQueryClient()
  const isEdit = !!entryId
  const [description, setDescription] = useState('')
  const [date, setDate] = useState('')
  const [projectId, setProjectId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [reason, setReason] = useState('')
  const [lines, setLines] = useState<any[]>([{ accountId: '', debit: '', credit: '' }, { accountId: '', debit: '', credit: '' }])
  const [error, setError] = useState('')

  // includeControl: سند دستی به حساب‌های کنترلی (هزینه/فروش/تسعیر) هم نیاز دارد
  const { data: accounts = [] } = useQuery({ queryKey: ['all-accounts', 'control'], queryFn: () => api.get('/accounting/all-accounts?includeControl=1').then((r) => r.data) })
  const { data: projects = [] } = useQuery({ queryKey: ['projects-min'], queryFn: () => api.get('/projects').then((r) => r.data) })
  const { data: categories = [] } = useQuery({ queryKey: ['acc-categories'], queryFn: () => api.get('/accounting/categories').then((r) => r.data) })
  const { data: existing, isLoading: loadingEntry } = useQuery({
    queryKey: ['journal-entry', entryId],
    queryFn: () => api.get(`/accounting/journal/${entryId}`).then((r) => r.data),
    enabled: isEdit,
  })

  // پرکردن فرم از سند موجود (فقط یک‌بار وقتی داده رسید)
  const [hydrated, setHydrated] = useState(false)
  if (isEdit && existing && !hydrated) {
    setHydrated(true)
    setDescription(existing.description || '')
    setDate(existing.date ? toShamsi(existing.date) : '')
    setProjectId(existing.projectId || '')
    setCategoryId(existing.categoryId || '')
    setLines(existing.lines.map((l: any) => ({
      accountId: l.accountId,
      debit: Number(l.debit) > 0 ? String(Number(l.debit)) : '',
      credit: Number(l.credit) > 0 ? String(Number(l.credit)) : '',
    })))
  }

  const { data: liveRates } = useQuery({ queryKey: ['rates'], queryFn: () => api.get('/accounting/rates').then((r) => r.data) })
  const liveUsd = liveRates?.USD_TO_IRR
  const liveCny = liveRates?.CNY_TO_IRR

  const accById = (id: string) => accounts.find((a: any) => a.id === id)
  // جمع‌ها به تومان سنجیده می‌شوند تا سندهای چندارزی هم درست تراز شوند
  const rate = (id: string) => {
    const a = accById(id)
    if (!a || a.currency === 'IRR') return 1
    return a.currency === 'USD' ? Number(liveUsd) || 0 : Number(liveCny) || 0
  }

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0) * rate(l.accountId), 0)
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0) * rate(l.accountId), 0)
  const diff = totalDebit - totalCredit
  const balanced = Math.abs(diff) <= Math.max(5, totalDebit * 1e-6)
  const multiCurrency = new Set(lines.map((l) => accById(l.accountId)?.currency).filter(Boolean)).size > 1

  const setLine = (i: number, patch: any) => setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  const addLine = () => setLines((ls) => [...ls, { accountId: '', debit: '', credit: '' }])
  const removeLine = (i: number) => setLines((ls) => (ls.length <= 2 ? ls : ls.filter((_, idx) => idx !== i)))

  const mut = useMutation({
    mutationFn: () => {
      const payload: any = {
        description,
        projectId: projectId || null,
        categoryId: categoryId || null,
        lines: lines
          .filter((l) => l.accountId && (Number(l.debit) > 0 || Number(l.credit) > 0))
          .map((l) => ({ accountId: l.accountId, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0 })),
      }
      if (date) payload.date = fromShamsi(date).toISOString()
      if (isEdit) { payload.reason = reason; return api.patch(`/accounting/journal/${entryId}`, payload) }
      return api.post('/accounting/journal', payload)
    },
    onSuccess: () => {
      qc.invalidateQueries()
      toast.success(isEdit ? 'سند اصلاح شد' : 'سند ثبت شد')
      onClose()
    },
    onError: (e: any) => setError(e.response?.data?.message || 'خطا در ثبت سند'),
  })

  const validLines = lines.filter((l) => l.accountId && (Number(l.debit) > 0 || Number(l.credit) > 0))
  const canSubmit = description.trim() && validLines.length >= 2 && balanced && !mut.isPending && (!isEdit || reason.trim())

  if (isEdit && loadingEntry) return <ModalLoading />
  if (isEdit && existing && !existing.editable) {
    return (
      <div className="modal-overlay">
        <div className="modal" dir="rtl" style={{ maxWidth: 460 }}>
          <div className="modal-header"><h2>ویرایش ممکن نیست</h2><button onClick={onClose}>✕</button></div>
          <div className="modal-body">
            <p>{existing.notEditableReason}</p>
            <p className="hint-sm">برای اصلاح این سند از «ابطال (سند برگشتی)» استفاده کنید — سند اصلی حفظ می‌شود و یک سند معکوس ثبت می‌گردد.</p>
          </div>
          <div className="modal-footer"><button className="btn-secondary" onClick={onClose}>بستن</button></div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 860 }}>
        <div className="modal-header">
          <h2>{isEdit ? `✏️ ویرایش سند #${existing?.entryNo}` : '📝 ثبت سند دستی'}</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}

          <div className="form-row">
            <div className="form-group" style={{ flex: 2 }}>
              <label>شرح سند *</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="مثلاً: پرداخت اجاره دفتر تیر ۱۴۰۵" />
            </div>
            <div className="form-group">
              <label>تاریخ</label>
              <DateField value={date} onChange={setDate} placeholder="امروز" />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>پروژه (اختیاری)</label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">بدون پروژه — تراکنش عمومی</option>
                {projects.map((p: any) => <option key={p.id} value={p.id}>{p.code}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>سرفصل هزینه/درآمد (اختیاری)</label>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">—</option>
                {categories.filter((c: any) => c.isActive).map((c: any) => (
                  <option key={c.id} value={c.id}>{c.kind === 'INCOME' ? '📈' : '📉'} {c.name}</option>
                ))}
              </select>
            </div>
          </div>

          {isEdit && (
            <div className="form-group">
              <label>دلیل اصلاح * <span className="hint-sm">(در تاریخچهٔ سند ثبت می‌شود)</span></label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً: مبلغ اشتباه وارد شده بود" />
            </div>
          )}

          <h3 style={{ fontSize: 14, margin: '18px 0 8px' }}>ردیف‌های سند</h3>
          <div className="table-container">
            <table className="data-table">
              <thead><tr><th style={{ minWidth: 220 }}>حساب</th><th>بدهکار</th><th>بستانکار</th><th></th></tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const acc = accById(l.accountId)
                  return (
                    <tr key={i}>
                      <td>
                        <SearchableSelect value={l.accountId} onChange={(v: string) => setLine(i, { accountId: v })} placeholder="انتخاب حساب..."
                          options={accounts.map((a: any) => ({ value: a.id, label: `${a.name} (${CUR[a.currency]})${a.ownerName ? ` — ${a.ownerName}` : ''}` }))} />
                      </td>
                      <td>
                        <NumberInput value={l.debit} onChange={(v: any) => setLine(i, { debit: v, credit: '' })} placeholder="0" />
                      </td>
                      <td>
                        <NumberInput value={l.credit} onChange={(v: any) => setLine(i, { credit: v, debit: '' })} placeholder="0" />
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <span className="hint-sm">{acc ? CUR[acc.currency] : ''}</span>
                        {lines.length > 2 && (
                          <button className="icon-btn" title="حذف ردیف" onClick={() => removeLine(i)} style={{ marginRight: 6 }}>✕</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td>جمع {multiCurrency && <span className="hint-sm">(معادل تومان)</span>}</td>
                  <td style={{ color: 'var(--success)' }}>{n(totalDebit)}</td>
                  <td style={{ color: 'var(--danger)' }}>{n(totalCredit)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          <button className="btn-secondary btn-sm" onClick={addLine} style={{ marginTop: 8 }}>+ افزودن ردیف</button>

          <div style={{ marginTop: 14 }}>
            {validLines.length < 2 ? (
              <div className="alert">سند حداقل به دو ردیف با حساب و مبلغ نیاز دارد.</div>
            ) : balanced ? (
              <div className="alert alert-success">✓ سند تراز است{multiCurrency ? ' (بر مبنای نرخ روز)' : ''}.</div>
            ) : (
              <div className="alert alert-danger">
                سند تراز نیست — اختلاف <strong>{n(Math.abs(diff))}</strong> تومان
                {diff > 0 ? ' (بدهکار بیشتر است)' : ' (بستانکار بیشتر است)'}
              </div>
            )}
            {multiCurrency && (
              <p className="hint-sm">
                این سند چندارزی است؛ تراز بر مبنای معادل تومانی با نرخ روز سنجیده می‌شود
                (هر دلار {n(liveUsd)} / هر یوآن {n(liveCny)} تومان).
              </p>
            )}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>انصراف</button>
          <button className="btn-primary" disabled={!canSubmit} onClick={() => { setError(''); mut.mutate() }}>
            {mut.isPending ? '...' : isEdit ? 'ثبت اصلاح' : 'ثبت سند'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── دفتر روزنامه (با فیلتر) ──────────────────────────
function JournalTab() {
  const qc = useQueryClient()
  const [eventType, setEventType] = useState('')
  const [projectId, setProjectId] = useState('')
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [manualOpen, setManualOpen] = useState(false)

  const reverseMut = useMutation({
    mutationFn: ({ id, reason }: any) => api.post(`/accounting/journal/${id}/reverse`, { reason }),
    onSuccess: (r: any) => { qc.invalidateQueries(); toast.success(`سند برگشتی #${r.data.entryNo} ثبت شد`) },
    onError: (e: any) => toast.error(e.response?.data?.message || 'ابطال ناموفق بود'),
  })

  const askReverse = async (e: any) => {
    const reason = await dialog.prompt({
      title: `ابطال سند #${e.entryNo}`,
      message: 'سند اصلی حذف نمی‌شود؛ یک سند برگشتی با ارقام معکوس ثبت می‌گردد تا اثر آن خنثی شود. دلیل ابطال را بنویسید:',
      placeholder: 'مثلاً: تراکنش تکراری ثبت شده بود',
    })
    if (reason?.trim()) reverseMut.mutate({ id: e.id, reason: reason.trim() })
  }

  const params = new URLSearchParams()
  if (eventType) params.set('eventType', eventType)
  if (projectId) params.set('projectId', projectId)
  if (q) params.set('q', q)
  if (from) params.set('from', from)
  if (to) params.set('to', to)

  const { data: entries = [] } = useQuery({
    queryKey: ['journal', eventType, projectId, q, from, to],
    queryFn: () => api.get(`/accounting/journal?${params.toString()}`).then((r) => r.data),
  })
  const { data: projects = [] } = useQuery({ queryKey: ['projects-min'], queryFn: () => api.get('/projects').then((r) => r.data) })
  const sort = useSort('date', 'desc')
  const rows = sort.apply(entries as any[], {
    entryNo: (e) => e.entryNo,
    date: (e) => e.date,
    description: (e) => e.description,
    event: (e) => EVENT_LABELS[e.eventType] || e.eventType,
    project: (e) => e.project?.code,
  })

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input placeholder="جستجو در شرح..." value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 180 }} />
        <select value={eventType} onChange={(e) => setEventType(e.target.value)} style={{ maxWidth: 170 }}>
          <option value="">همه رویدادها</option>
          {Object.entries(EVENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ maxWidth: 190 }}>
          <option value="">همه پروژه‌ها</option>
          {projects.map((p: any) => <option key={p.id} value={p.id}>{p.code}</option>)}
        </select>
        <DateField value={from} onChange={setFrom} placeholder="از تاریخ" style={{ minWidth: 150 }} />
        <DateField value={to} onChange={setTo} placeholder="تا تاریخ" style={{ minWidth: 150 }} />
        <div style={{ marginRight: 'auto', display: 'flex', gap: 8 }}>
          <button className="btn-primary btn-sm" onClick={() => setManualOpen(true)}>📝 ثبت سند دستی</button>
          <button className="btn-secondary btn-sm" onClick={() => downloadCsv('export/journal', 'journal.csv')}>⬇ خروجی اکسل</button>
        </div>
      </div>
      <table className="data-table">
        <thead><tr>
          <SortTH label="سند" k="entryNo" sort={sort} />
          <SortTH label="تاریخ" k="date" sort={sort} />
          <SortTH label="شرح" k="description" sort={sort} />
          <SortTH label="رویداد" k="event" sort={sort} />
          <SortTH label="پروژه" k="project" sort={sort} />
          <th>حساب (بدهکار / بستانکار)</th>
          <th>پیوست</th>
          <th></th>
        </tr></thead>
        <tbody>
          {rows.map((e: any) => {
            const isReversed = e.status === 'REVERSED'
            const isReversal = e.status === 'REVERSAL'
            return (
              <tr key={e.id} style={isReversed ? { opacity: 0.55 } : undefined}>
                <td className="code-text" style={{ whiteSpace: 'nowrap' }}>
                  #{e.entryNo}
                  {isReversed && <span className="chip chip-danger" style={{ marginRight: 4, fontSize: 10 }}>باطل</span>}
                  {isReversal && <span className="chip" style={{ marginRight: 4, fontSize: 10 }}>برگشتی</span>}
                </td>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{toShamsi(e.date)}</td>
                <td style={{ fontSize: 12, textDecoration: isReversed ? 'line-through' : undefined }}>{e.description}</td>
                <td style={{ fontSize: 11 }}>{EVENT_LABELS[e.eventType] || e.eventType || '—'}</td>
                <td className="code-text">{e.project?.code || '-'}</td>
                <td style={{ fontSize: 12 }}>
                  {e.lines.map((l: any) => (
                    <div key={l.id}>
                      {l.account.name}: {Number(l.debit) > 0 ? <span style={{ color: 'var(--success)' }}>بدهکار {n2(l.debit)}</span> : <span style={{ color: 'var(--danger)' }}>بستانکار {n2(l.credit)}</span>} {CUR[l.currency]}
                    </div>
                  ))}
                </td>
                <td style={{ textAlign: 'center' }}><Attachments urls={e.attachmentUrls} /></td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {/*
                    دکمهٔ «ویرایش سند» حذف شد: مسیر `PATCH /accounting/journal/:id`
                    دیگر ۴۱۰ برمی‌گرداند (نقض تغییرناپذیری). تنها راه اصلاح، ابطال
                    با سند برگشتی است — همان کاری که دکمهٔ کنارش می‌کند.
                  */}
                  {!isReversed && !isReversal && (
                    <button className="icon-btn" title="ابطال با سند برگشتی" onClick={() => askReverse(e)}>↩️</button>
                  )}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && <TableEmpty colSpan={8}>سندی یافت نشد</TableEmpty>}
        </tbody>
      </table>

      {manualOpen && <ManualEntryModal onClose={() => setManualOpen(false)} />}
    </div>
  )
}

// ─── تجدید ارزیابی ارزی پایان دوره ─────────────────────
// اقلام پولیِ باز (دارایی/بدهی ارزی) به نرخ پایان دوره ارزش‌گذاری می‌شوند و
// اختلافشان با ارزش دفتری، سود/زیان «تحقق‌نیافته» است. سند برگشت همان لحظه
// برای اول دورهٔ بعد ساخته می‌شود تا موقع تسویهٔ واقعی سود دوبار شمرده نشود.
// مرجع: docs/accounting-spec.md بخش ۴-۴
function RevaluationModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [asOf, setAsOf] = useState('')
  const [usd, setUsd] = useState('')
  const [cny, setCny] = useState('')
  const [error, setError] = useState('')

  const params: Record<string, string> = {}
  if (asOf) params.asOf = asOf
  if (Number(usd) > 0) params.usd = usd
  if (Number(cny) > 0) params.cny = cny

  const { data: preview, isFetching } = useQuery({
    queryKey: ['reval-preview', asOf, usd, cny],
    queryFn: () => api.get('/accounting/revaluation/preview', { params }).then((r) => r.data),
  })

  const post = useMutation({
    mutationFn: () => api.post('/accounting/revaluation', {
      asOf: asOf || undefined,
      usd: Number(usd) > 0 ? Number(usd) : undefined,
      cny: Number(cny) > 0 ? Number(cny) : undefined,
    }),
    onSuccess: (r: any) => {
      const d = r.data
      if (d.posted) toast.success(`سند تعدیل #${d.entryNo} و سند برگشت #${d.reversalEntryNo} ثبت شدند`)
      else toast.info(d.reason || 'چیزی برای ثبت نبود')
      qc.invalidateQueries()
      onClose()
    },
    onError: (e: any) => setError(e.response?.data?.message || 'خطا در ثبت'),
  })

  const lines = preview?.lines || []

  return (
    <ModalPortal>
      <div className="modal-overlay">
        <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 900 }}>
          <div className="modal-header"><h2>⚖️ تجدید ارزیابی ارزی پایان دوره</h2><button onClick={onClose}>✕</button></div>
          <div className="modal-body">
            <p className="hint" style={{ marginBottom: 12 }}>
              فقط <strong>اقلام پولی باز</strong> (دارایی و بدهی ارزی) ارزیابی می‌شوند. درآمد، هزینه و سرمایه
              اقلام غیرپولی‌اند و به بهای تاریخی می‌مانند.
            </p>

            <div className="grid-3" style={{ gap: 10 }}>
              <div className="form-group"><label>تاریخ پایان دوره</label><DateField value={asOf} onChange={setAsOf} /></div>
              <div className="form-group">
                <label>نرخ دلار {preview ? <span className="muted">(پیش‌فرض {n(preview.rates?.USD)})</span> : ''}</label>
                <NumberInput value={usd} onChange={setUsd} decimals placeholder="نرخ روز" />
              </div>
              <div className="form-group">
                <label>نرخ یوآن {preview ? <span className="muted">(پیش‌فرض {n(preview.rates?.CNY)})</span> : ''}</label>
                <NumberInput value={cny} onChange={setCny} decimals placeholder="نرخ روز" />
              </div>
            </div>

            {preview?.alreadyPosted && (
              <div className="error-msg" style={{ marginBottom: 10 }}>
                برای دورهٔ {preview.period.year}/{String(preview.period.month).padStart(2, '0')} قبلاً تجدید ارزیابی ثبت شده است.
              </div>
            )}

            {isFetching ? <Loading /> : lines.length === 0 ? (
              <p className="hint">هیچ قلم ارزی بازی با اختلاف ارزش وجود ندارد — چیزی برای ثبت نیست.</p>
            ) : (
              <>
                <div className="grid-3" style={{ gap: 10, marginBottom: 12 }}>
                  <div className="kpi-card" style={{ padding: 12 }}>
                    <div className="kpi-value" style={{ fontSize: 18, color: 'var(--success)' }}>{n(preview.totalGain)}</div>
                    <div className="kpi-label">سود تحقق‌نیافته</div>
                  </div>
                  <div className="kpi-card" style={{ padding: 12 }}>
                    <div className="kpi-value" style={{ fontSize: 18, color: 'var(--danger)' }}>{n(preview.totalLoss)}</div>
                    <div className="kpi-label">زیان تحقق‌نیافته</div>
                  </div>
                  <div className="kpi-card" style={{ padding: 12 }}>
                    <div className="kpi-value" style={{ fontSize: 18, color: signColor(preview.netIRR) }}>{n(preview.netIRR)}</div>
                    <div className="kpi-label">خالص (تومان)</div>
                  </div>
                </div>

                <div className="table-container" style={{ maxHeight: 320, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead><tr>
                      <th>حساب</th><th>ارز</th><th>مانده</th>
                      <th>ارزش دفتری</th><th>نرخ دوره</th><th>ارزش روز</th><th>اختلاف</th>
                    </tr></thead>
                    <tbody>
                      {lines.map((l: any) => (
                        <tr key={l.accountId}>
                          <td style={{ fontSize: 12 }}>{l.accountName}</td>
                          <td>{CUR[l.currency]}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{nExact(l.balance)}</td>
                          <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{n(l.carryingIRR)}</td>
                          <td style={{ fontSize: 12 }}>{n(l.rate)}</td>
                          <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{n(l.currentIRR)}</td>
                          <td style={{ fontWeight: 700, whiteSpace: 'nowrap', color: signColor(l.deltaIRR) }}>{n(l.deltaIRR)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="hint" style={{ marginTop: 10 }}>
                  با ثبت، <strong>دو سند</strong> ساخته می‌شود: سند تعدیل با تاریخ پایان دوره، و سند برگشت آن با تاریخ روز بعد.
                  برگشت لازم است وگرنه موقع تسویهٔ واقعیِ همین اقلام، سود دوبار شمرده می‌شود.
                </p>
              </>
            )}
            {error && <div className="error-msg">{error}</div>}
          </div>
          <div className="modal-footer">
            <button onClick={onClose} className="btn-secondary">انصراف</button>
            <button className="btn-primary" disabled={!lines.length || preview?.alreadyPosted || post.isPending}
              onClick={() => post.mutate()}>ثبت سند تعدیل و برگشت</button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}

// ─── گزارش ریسک ارزی ──────────────────────────────────
function FxRiskTab() {
  const [showReval, setShowReval] = useState(false)
  const { data } = useQuery({ queryKey: ['fx-risk'], queryFn: () => api.get('/accounting/reports/fx-risk').then((r) => r.data) })
  if (!data) return <Loading />

  const totalRealized = data.rows.reduce((s: number, r: any) => s + r.realizedIRR, 0)
  const totalUnrealized = data.rows.reduce((s: number, r: any) => s + r.unrealizedIRR, 0)

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 14 }}>
        <p className="hint" style={{ margin: 0 }}>
          این گزارش تحلیلی است و سندی نمی‌زند. برای ثبت رسمی سود/زیان تحقق‌نیافته در پایان دوره از «تجدید ارزیابی» استفاده کنید.
        </p>
        <button className="btn-primary btn-sm" onClick={() => setShowReval(true)}>⚖️ تجدید ارزیابی پایان دوره</button>
      </div>
      {showReval && <RevaluationModal onClose={() => setShowReval(false)} />}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16, maxWidth: 560 }}>
        <div className="kpi-card" style={{ padding: 16 }}>
          <div className="kpi-value" style={{ fontSize: 22, color: signColor(totalRealized) }}>{n(totalRealized)}</div>
          <div className="kpi-label">سود/زیان ارزی محقق‌شده (تومان)</div>
        </div>
        <div className="kpi-card" style={{ padding: 16 }}>
          <div className="kpi-value" style={{ fontSize: 22, color: signColor(totalUnrealized) }}>{n(totalUnrealized)}</div>
          <div className="kpi-label">سود/زیان محقق‌نشده با نرخ روز (تومان)</div>
        </div>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>پروژه</th><th>مشتری</th><th>طرف</th><th>ارز</th>
            <th>تعهد</th><th>نرخ تعهد</th><th>تسویه</th><th>نرخ تسویه</th>
            <th>مانده باز</th><th>نرخ روز</th><th>محقق‌شده</th><th>محقق‌نشده</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r: any, i: number) => (
            <tr key={i}>
              <td className="code-text">{r.code}</td>
              <td style={{ fontSize: 12 }}>{r.customer}</td>
              <td style={{ fontSize: 12 }}>{r.side === 'CUSTOMER' ? '📥 مشتری' : '📤 سازنده'}</td>
              <td>{CUR[r.currency]}</td>
              <td>{n2(r.booked)}</td>
              <td style={{ fontSize: 12 }}>{n(r.bookedAvgRate)}</td>
              <td>{n2(r.settled)}</td>
              <td style={{ fontSize: 12 }}>{r.settled > 0 ? n(r.settledAvgRate) : '—'}</td>
              <td style={{ fontWeight: 700 }}>{n2(r.open)}</td>
              <td style={{ fontSize: 12 }}>{n(r.currentRate)}</td>
              <td style={{ color: signColor(r.realizedIRR), fontWeight: 700 }}>{n(r.realizedIRR)}</td>
              <td style={{ color: signColor(r.unrealizedIRR) }}>{n(r.unrealizedIRR)}</td>
            </tr>
          ))}
          {data.rows.length === 0 && <TableEmpty colSpan={12}>تعهد ارزی (دلار/یوآن) ثبت نشده است</TableEmpty>}
        </tbody>
      </table>
      <p className="hint" style={{ marginTop: 10, lineHeight: 1.9  }}>
        💡 «نرخ تعهد» = میانگین موزون نرخ تبدیل در لحظه ایجاد طلب/بدهی (تأیید فاکتور). «نرخ تسویه» = میانگین نرخ در لحظه دریافت/پرداخت واقعی.
        اعداد مثبت (سبز) یعنی نوسان ارز به نفع شما بوده است؛ منفی (قرمز) یعنی زیان ارزی.
      </p>
    </div>
  )
}

// ─── ثبت هزینه / تنخواه ───────────────────────────────
const EXPENSE_CATEGORIES = ['ملزومات اداری', 'پذیرایی', 'ایاب و ذهاب', 'پست و پیک', 'تعمیر و نگهداری', 'قبوض (آب/برق/تلفن)', 'اجاره', 'حقوق و دستمزد', 'بازاریابی', 'متفرقه']

// ─── عملیات داخلی: انتقال بین حساب‌ها / شارژ تنخواه / ثبت هزینه ───
// هر سه روی حساب‌های خودِ شرکت کار می‌کنند و مکانیزم مشترکی دارند، پس یک پنجره‌اند.
// (انتقال و شارژ تنخواه عملاً یک عملیات بودند؛ تفاوتشان فقط نوع حساب مقصد است.)
type InternalMode = 'transfer' | 'tankhah' | 'expense'
const INTERNAL_MODES: { key: InternalMode; label: string; hint: string }[] = [
  { key: 'transfer', label: '💸 انتقال بین حساب‌ها', hint: 'جابجایی وجه بین حساب‌های شرکت (بانک/صندوق/تنخواه) — موجودی کل تغییر نمی‌کند.' },
  { key: 'tankhah', label: '🧰 شارژ تنخواه', hint: 'واریز از بانک/صندوق شرکت به یک حساب تنخواه تا بعداً خرج‌ها از آن کم شود.' },
  { key: 'expense', label: '🧾 ثبت خرج', hint: 'ثبت هزینهٔ واقعی — از موجودی حساب پرداخت‌کننده کم و به حساب هزینه منتقل می‌شود.' },
]

function InternalOpsModal({ initialMode = 'transfer', onClose }: { initialMode?: InternalMode; onClose: () => void }) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<InternalMode>(initialMode)
  const [fromAccountId, setFrom] = useState('')
  const [toAccountId, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState('')
  const [description, setDescription] = useState('')
  const [projectId, setProjectId] = useState('')
  const [date, setDate] = useState('')
  const [receipt, setReceipt] = useState<File | null>(null)
  const [error, setError] = useState('')

  const { data: accounts = [] } = useQuery({ queryKey: ['company-accounts'], queryFn: () => api.get('/accounting/accounts').then((r) => r.data) })
  const { data: projects = [] } = useQuery({ queryKey: ['projects-min'], queryFn: () => api.get('/projects').then((r) => r.data) })

  const fromAcc = accounts.find((a: any) => a.id === fromAccountId)
  const toAcc = accounts.find((a: any) => a.id === toAccountId)
  // مقصدِ شارژ تنخواه فقط حساب تنخواه؛ مبدأش هر حساب دیگری
  const destAccounts = accounts.filter((a: any) => a.id !== fromAccountId && (mode === 'tankhah' ? a.type === 'PETTY_CASH' : true))
  const sourceAccounts = mode === 'tankhah' ? accounts.filter((a: any) => a.type !== 'PETTY_CASH') : accounts
  const currencyMismatch = mode !== 'expense' && fromAcc && toAcc && fromAcc.currency !== toAcc.currency
  const cfg = INTERNAL_MODES.find((m) => m.key === mode)!

  const switchMode = (m: InternalMode) => { setMode(m); setFrom(''); setTo(''); setError('') }

  const mut = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      if (mode === 'expense') {
        fd.append('fromAccountId', fromAccountId); fd.append('amount', amount)
        if (category) fd.append('category', category)
        if (description) fd.append('description', description)
        if (projectId) fd.append('projectId', projectId)
        if (date) fd.append('date', date)
        if (receipt) fd.append('receipt', receipt)
        return api.post('/accounting/expenses', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      }
      fd.append('fromAccountId', fromAccountId); fd.append('toAccountId', toAccountId); fd.append('amount', amount)
      fd.append('eventType', 'INTERNAL')
      fd.append('description', description || (mode === 'tankhah' ? 'شارژ تنخواه' : 'انتقال داخلی'))
      if (projectId) fd.append('projectId', projectId)
      if (receipt) fd.append('receipt', receipt)
      return api.post('/accounting/transfers', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    },
    onSuccess: () => { qc.invalidateQueries(); onClose() },
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  const canSubmit = mode === 'expense'
    ? !!fromAccountId && !!Number(amount)
    : !!fromAccountId && !!toAccountId && !!Number(amount) && !currencyMismatch

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 560 }}>
        <div className="modal-header"><h2>عملیات داخلی</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="settings-tabs" style={{ marginBottom: 12 }}>
            {INTERNAL_MODES.map((m) => (
              <button key={m.key} className={`tab-btn ${mode === m.key ? 'active' : ''}`} onClick={() => switchMode(m.key)}>{m.label}</button>
            ))}
          </div>
          <p className="hint" style={{ marginBottom: 12 }}>{cfg.hint}</p>

          {mode === 'tankhah' && accounts.filter((a: any) => a.type === 'PETTY_CASH').length === 0 && (
            <div className="error-msg" style={{ marginBottom: 12 }}>هیچ حساب «تنخواه» تعریف نشده. ابتدا در تب «حساب‌های شرکت» یک حساب از نوع «تنخواه» بسازید.</div>
          )}

          <div className="form-group">
            <label>{mode === 'expense' ? 'حساب پرداخت‌کننده (تنخواه / بانک / صندوق)' : 'از حساب (مبدأ)'}</label>
            <SearchableSelect value={fromAccountId} onChange={setFrom} placeholder="انتخاب حساب..."
              options={sourceAccounts.map((a: any) => ({ value: a.id, label: `${a.name} (${CUR[a.currency]}) — موجودی ${nExact(a.balance)}` }))} />
          </div>

          {mode !== 'expense' && (
            <div className="form-group">
              <label>{mode === 'tankhah' ? 'به تنخواه (مقصد)' : 'به حساب (مقصد)'}</label>
              <SearchableSelect value={toAccountId} onChange={setTo} placeholder="انتخاب حساب..."
                options={destAccounts.map((a: any) => ({ value: a.id, label: `${a.name} (${CUR[a.currency]}) — موجودی ${nExact(a.balance)}` }))} />
            </div>
          )}
          {currencyMismatch && <div className="error-msg">ارز مبدأ و مقصد باید یکسان باشد. برای تبدیل واحد از «🔄 عملیات ارزی» استفاده کنید.</div>}

          {mode === 'expense' && (
            <div className="form-group">
              <label>دستهٔ هزینه</label>
              <input list="expense-cats" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="مثلاً ملزومات اداری" />
              <datalist id="expense-cats">{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
            </div>
          )}

          <div className="form-group"><label>مبلغ {fromAcc ? `(${CUR[fromAcc.currency]})` : ''}</label><NumberInput value={amount} onChange={setAmount} decimals /></div>
          {mode === 'expense' && <div className="form-group"><label>تاریخ</label><DateField value={date} onChange={setDate} /></div>}
          <div className="form-group">
            <label>{mode === 'expense' ? 'شرح' : 'توضیحات'}</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={mode === 'expense' ? 'توضیح هزینه' : 'اختیاری'} />
          </div>
          <div className="form-group">
            <label>پروژهٔ مرتبط (اختیاری)</label>
            <SearchableSelect value={projectId} onChange={setProjectId} placeholder="بدون پروژه"
              options={projects.map((p: any) => ({ value: p.id, label: `${p.code} — ${p.customer?.name || ''}` }))} />
          </div>
          <div className="form-group"><label>رسید (اختیاری)</label><input type="file" onChange={(e) => setReceipt(e.target.files?.[0] || null)} /></div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={!canSubmit || mut.isPending} onClick={() => mut.mutate()}>
            {mode === 'expense' ? 'ثبت هزینه' : mode === 'tankhah' ? 'واریز به تنخواه' : 'ثبت انتقال'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── دریافت / پرداخت (تسویهٔ چند‌ارزی با طرف حساب) ─────
// اصل: تعهد به ارز خودش بسته می‌شود (نرخ ثبت)، نقد به ارز حساب شرکت، اختلاف = تسعیر محقق‌شده.
function SettlementModal({ onClose }: any) {
  const qc = useQueryClient()
  const [settleType, setSettleType] = useState('CUSTOMER')
  const [direction, setDirection] = useState<'RECEIPT' | 'PAYMENT'>('RECEIPT')
  const [ownerId, setOwnerId] = useState('')
  const [obligationCurrency, setObligationCurrency] = useState('USD')
  const [settledAmount, setSettledAmount] = useState('')
  const [companyAccountId, setCompanyAccountId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [description, setDescription] = useState('')
  const [receipt, setReceipt] = useState<File | null>(null)
  const [error, setError] = useState('')

  const cfg = SETTLE_TYPES.find((t) => t.key === settleType)!
  const { data: entities = [] } = useQuery({
    queryKey: ['ledger', settleType],
    queryFn: () => api.get(`/accounting/ledger/${settleType}`).then((r) => r.data),
  })
  const { data: accounts = [] } = useQuery({ queryKey: ['company-accounts'], queryFn: () => api.get('/accounting/accounts').then((r) => r.data) })
  // فقط پروژه‌های همین طرف حساب
  const { data: projects = [] } = useQuery({
    queryKey: ['party-projects', settleType, ownerId],
    queryFn: () => api.get('/accounting/party-projects', { params: { ownerType: settleType, ownerId } }).then((r) => r.data),
    enabled: !!ownerId,
  })
  const { data: preview } = useQuery({
    queryKey: ['settle-preview', settleType, ownerId, obligationCurrency],
    queryFn: () => api.get('/accounting/settlements/preview', { params: { ownerType: settleType, ownerId, currency: obligationCurrency } }).then((r) => r.data),
    enabled: !!ownerId,
  })

  const owner = entities.find((e: any) => e.id === ownerId)
  // دریافت/پرداخت فقط هم‌ارز است — پس فقط حساب‌های شرکت با همان ارز قابل انتخاب‌اند
  const eligibleAccounts = accounts.filter((a: any) => a.currency === obligationCurrency)

  const mut = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      fd.append('direction', direction)
      fd.append('ownerType', settleType)
      fd.append('ownerId', ownerId)
      fd.append('obligationCurrency', obligationCurrency)
      fd.append('settledAmount', String(settledAmount))
      fd.append('companyAccountId', companyAccountId)
      if (projectId) fd.append('projectId', projectId)
      if (description) fd.append('description', description)
      if (receipt) fd.append('receipt', receipt)
      return api.post('/accounting/settlements', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    },
    onSuccess: () => { qc.invalidateQueries(); onClose() },
    onError: (e: any) => setError(e.response?.data?.message || 'خطا در ثبت تسویه'),
  })

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 560 }}>
        <div className="modal-header"><h2>💰 دریافت / پرداخت (تسویه)</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-row">
            <div className="form-group">
              <label>نوع طرف حساب</label>
              <select value={settleType} onChange={(e) => {
                const next = e.target.value
                setSettleType(next); setOwnerId('')
                setDirection(SETTLE_TYPES.find((t) => t.key === next)!.defaultDirection)
              }}>
                {SETTLE_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>جهت</label>
              <select value={direction} onChange={(e) => setDirection(e.target.value as any)}>
                <option value="RECEIPT">📥 دریافت از {cfg.label}</option>
                <option value="PAYMENT">📤 پرداخت به {cfg.label}</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>طرف حساب</label>
            <SearchableSelect value={ownerId} onChange={(v) => { setOwnerId(v); setProjectId('') }} placeholder="انتخاب..."
              options={entities.map((e: any) => ({ value: e.id, label: `${e.name} — ${n(e.totalIRR)} تومان` }))} />
            {owner && (
              <span className="hint-sm">
                مانده: {n2(owner.IRR)} تومان · {n2(owner.USD)} دلار · {n2(owner.CNY)} یوآن
              </span>
            )}
          </div>
          <div className="grid-2" style={{ gap: 8 }}>
            <div className="form-group">
              <label>ارز {direction === 'RECEIPT' ? 'دریافتی' : 'پرداختی'}</label>
              <select value={obligationCurrency} onChange={(e) => { setObligationCurrency(e.target.value); setCompanyAccountId('') }}>
                <option value="IRR">تومان</option><option value="USD">دلار</option><option value="CNY">یوآن</option>
              </select>
              {preview && <span className="hint-sm">ماندهٔ باز این ارز: {nExact(preview.balance)}</span>}
            </div>
            <div className="form-group">
              <label>مبلغ ({CUR[obligationCurrency]})</label>
              <NumberInput value={settledAmount} onChange={setSettledAmount} decimals />
            </div>
          </div>
          <div className="form-group">
            <label>{direction === 'RECEIPT' ? `واریز به کدام حساب ${CUR[obligationCurrency]} شرکت؟` : `پرداخت از کدام حساب ${CUR[obligationCurrency]} شرکت؟`}</label>
            <SearchableSelect value={companyAccountId} onChange={setCompanyAccountId} placeholder="انتخاب حساب..."
              options={eligibleAccounts.map((a: any) => ({ value: a.id, label: `${a.name} — موجودی ${nExact(a.balance)}` }))} />
            {eligibleAccounts.length === 0 && (
              <div className="error-msg" style={{ marginTop: 6 }}>هیچ حساب شرکت با ارز {CUR[obligationCurrency]} تعریف نشده است.</div>
            )}
          </div>
          <p className="hint" style={{ marginTop: -4 }}>
            پول با هر ارزی که جابه‌جا می‌شود به حساب همان ارز می‌نشیند. برای تبدیل واحد از «🔄 عملیات ارزی» استفاده کنید.
          </p>
          <div className="form-group">
            <label>پروژه مرتبط (اختیاری — فقط پروژه‌های همین طرف حساب)</label>
            <SearchableSelect value={projectId} onChange={setProjectId} placeholder="بدون پروژه"
              options={projects.map((p: any) => ({ value: p.id, label: `${p.code} — ${p.customer?.name || ''}` }))} />
          </div>
          <div className="form-group"><label>توضیحات</label><input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="form-group"><label>پیوست رسید</label><input type="file" onChange={(e) => setReceipt(e.target.files?.[0] || null)} /></div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={!ownerId || !companyAccountId || !Number(settledAmount) || mut.isPending}
            onClick={() => mut.mutate()}>ثبت تسویه</button>
        </div>
      </div>
    </div>
  )
}

// ─── پنجره H: عملیات ارزی ─────────────────────────────
function ConversionModal({ onClose }: any) {
  const qc = useQueryClient()
  // ابتدا شخص، بعد حساب‌های خودِ او — نه کل حساب‌های سیستم
  const [partyType, setPartyType] = useState('COMPANY')
  const [partyId, setPartyId] = useState('')
  const [fromAccountId, setFrom] = useState(''); const [toAccountId, setTo] = useState('')
  const [method, setMethod] = useState<'by_rate' | 'by_amount'>('by_rate')
  const [fromAmount, setFromAmount] = useState(''); const [rate, setRate] = useState(''); const [toAmount, setToAmount] = useState('')
  const [feeAmount, setFee] = useState(''); const [feeCurrency, setFeeCurrency] = useState('IRR')
  const [feeAccountId, setFeeAcc] = useState(''); const [exchangeId, setExchangeId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [description, setDescription] = useState('')
  const [receipt, setReceipt] = useState<File | null>(null)
  const [error, setError] = useState('')

  const isCompany = partyType === 'COMPANY'
  const { data: accounts = [] } = useQuery({ queryKey: ['all-accounts'], queryFn: () => api.get('/accounting/all-accounts').then((r) => r.data) })
  const { data: exchanges = [] } = useQuery({ queryKey: ['exchanges'], queryFn: () => api.get('/settings/exchanges').then((r) => r.data) })
  const { data: liveRates } = useQuery({ queryKey: ['rates'], queryFn: () => api.get('/accounting/rates').then((r) => r.data) })
  const { data: entities = [] } = useQuery({
    queryKey: ['ledger', partyType],
    queryFn: () => api.get(`/accounting/ledger/${partyType}`).then((r) => r.data),
    enabled: !isCompany,
  })
  // فقط پروژه‌های همین طرف حساب
  const { data: projects = [] } = useQuery({
    queryKey: ['party-projects', partyType, partyId],
    queryFn: () => api.get('/accounting/party-projects', { params: { ownerType: partyType, ownerId: partyId } }).then((r) => r.data),
    enabled: !isCompany && !!partyId,
  })

  // حساب‌های قابل انتخاب = فقط حساب‌های همین طرف
  const partyAccounts = accounts.filter((a: any) =>
    isCompany ? a.ownerType === 'COMPANY' : a.ownerType === partyType && a.ownerId === partyId)

  const fromAcc = partyAccounts.find((a: any) => a.id === fromAccountId)
  const toAcc = partyAccounts.find((a: any) => a.id === toAccountId)
  const sameCurrency = fromAcc && toAcc && fromAcc.currency === toAcc.currency

  // نرخ متعارف جفت‌ارز: «۱ ارز قوی‌تر = چند ارز ضعیف‌تر»؛ جهت ضرب/تقسیم خودکار
  const pair = fromAcc && toAcc && !sameCurrency ? pairOf(fromAcc.currency, toAcc.currency) : null
  const market = pair ? marketPairRate(liveRates, fromAcc.currency, toAcc.currency) : null
  const computedTo = method === 'by_rate' && pair
    ? convertByRate(fromAcc.currency, toAcc.currency, Number(fromAmount), Number(rate))
    : Number(toAmount || 0)
  const computedRate = method === 'by_amount' && pair
    ? rateFromAmounts(fromAcc.currency, toAcc.currency, Number(fromAmount), Number(toAmount))
    : Number(rate || 0)

  const resetParty = (nextType: string, nextId: string) => {
    setPartyType(nextType); setPartyId(nextId); setFrom(''); setTo(''); setProjectId('')
  }

  const feeAccounts = accounts.filter((a: any) => a.ownerType === 'COMPANY' && a.currency === feeCurrency)

  const mut = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      fd.append('fromAccountId', fromAccountId); fd.append('toAccountId', toAccountId)
      fd.append('fromAmount', String(Number(fromAmount))); fd.append('toAmount', String(computedTo))
      if (feeAmount) { fd.append('feeAmount', feeAmount); fd.append('feeCurrency', feeCurrency) }
      if (feeAccountId) fd.append('feeAccountId', feeAccountId)
      if (exchangeId) fd.append('exchangeId', exchangeId)
      if (projectId) fd.append('projectId', projectId)
      if (description) fd.append('description', description)
      if (receipt) fd.append('receipt', receipt)
      return api.post('/accounting/conversions', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    },
    onSuccess: () => { qc.invalidateQueries(); onClose() },
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  const accLabel = (a: any) => `${a.name} (${CUR[a.currency]}) — موجودی ${nExact(a.balance)}`
  const partyReady = isCompany || !!partyId

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 580 }}>
        <div className="modal-header"><h2>🔄 عملیات ارزی</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="grid-2" style={{ gap: 8 }}>
            <div className="form-group">
              <label>۱) طرف حساب</label>
              <select value={partyType} onChange={(e) => resetParty(e.target.value, '')}>
                {PARTY_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            {!isCompany && (
              <div className="form-group">
                <label>شخص</label>
                <SearchableSelect value={partyId} onChange={(v) => resetParty(partyType, v)} placeholder="انتخاب..."
                  options={entities.map((e: any) => ({ value: e.id, label: e.name }))} />
              </div>
            )}
          </div>

          {!partyReady ? (
            <p className="hint">ابتدا شخص را انتخاب کنید تا حساب‌های خودش نمایش داده شود.</p>
          ) : (
            <>
              <div className="grid-2" style={{ gap: 8 }}>
                <div className="form-group">
                  <label>۲) حساب مبدأ</label>
                  <SearchableSelect value={fromAccountId} onChange={setFrom} placeholder="انتخاب..."
                    options={partyAccounts.map((a: any) => ({ value: a.id, label: accLabel(a) }))} />
                </div>
                <div className="form-group">
                  <label>۳) حساب مقصد</label>
                  <SearchableSelect value={toAccountId} onChange={setTo} placeholder="انتخاب..."
                    options={partyAccounts.filter((a: any) => a.id !== fromAccountId).map((a: any) => ({ value: a.id, label: accLabel(a) }))} />
                </div>
              </div>
              {sameCurrency && <div className="error-msg">ارز مبدأ و مقصد باید متفاوت باشد.</div>}
              {partyAccounts.length === 0 && <div className="error-msg">این طرف حساب هنوز کیف پولی ندارد.</div>}

              <div className="settings-tabs" style={{ marginBottom: 12 }}>
                <button className={`tab-btn ${method === 'by_rate' ? 'active' : ''}`} onClick={() => setMethod('by_rate')}>بر اساس نرخ</button>
                <button className={`tab-btn ${method === 'by_amount' ? 'active' : ''}`} onClick={() => setMethod('by_amount')}>بر اساس مبلغ</button>
              </div>

              <div className="form-group"><label>مبلغ مبدأ {fromAcc ? `(${CUR[fromAcc.currency]})` : ''}</label><NumberInput value={fromAmount} onChange={setFromAmount} decimals /></div>
              {method === 'by_rate' ? (
                <>
                  <div className="form-group">
                    <label>
                      {pair ? `نرخ — هر ۱ ${CUR[pair.base]} = ؟ ${CUR[pair.quote]}` : 'نرخ تبدیل'}
                      {market ? <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> (بازار: {nExact(market)})</span> : ''}
                    </label>
                    <NumberInput value={rate} onChange={setRate} decimals />
                  </div>
                  <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 13 }}>
                    مبلغ مقصد: <strong>{nExact(computedTo)}</strong> {toAcc ? CUR[toAcc.currency] : ''}
                  </div>
                </>
              ) : (
                <>
                  <div className="form-group"><label>مبلغ مقصد {toAcc ? `(${CUR[toAcc.currency]})` : ''}</label><NumberInput value={toAmount} onChange={setToAmount} decimals /></div>
                  <div style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 13 }}>
                    {pair ? `نرخ مؤثر — هر ۱ ${CUR[pair.base]} = ` : 'نرخ مؤثر: '}
                    <strong>{computedRate ? nExact(computedRate) : '-'}</strong> {pair ? CUR[pair.quote] : ''}
                    {market ? <span className="muted"> (بازار: {nExact(market)})</span> : ''}
                  </div>
                </>
              )}
              <p className="hint" style={{ marginTop: 6 }}>
                تعویض ارز به‌خودی‌خود سود و زیان نمی‌سازد؛ ارز دریافتی به بهای تمام‌شدهٔ همین معامله ثبت می‌شود.
                سود/زیان تسعیر فقط وقتی ثبت می‌شود که ارز به تومان تبدیل شود.
              </p>

              <hr style={{ margin: '16px 0', border: 'none', borderTop: '1px solid var(--border)' }} />
              <h3 style={{ fontSize: 13, marginBottom: 8 }}>کارمزد (اختیاری)</h3>
              <div className="grid-3" style={{ gap: 10 }}>
                <div className="form-group"><label>مبلغ کارمزد</label><NumberInput value={feeAmount} onChange={setFee} decimals /></div>
                <div className="form-group">
                  <label>واحد کارمزد</label>
                  <select value={feeCurrency} onChange={(e) => { setFeeCurrency(e.target.value); setFeeAcc('') }}>
                    <option value="IRR">تومان</option><option value="USD">دلار</option><option value="CNY">یوآن</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>پرداخت از حساب</label>
                  <select value={feeAccountId} onChange={(e) => setFeeAcc(e.target.value)}>
                    <option value="">—</option>
                    {feeAccounts.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              </div>
              {Number(feeAmount) > 0 && !feeAccountId && (
                <div className="error-msg">برای کارمزد {CUR[feeCurrency]} باید یک حساب شرکت با همین ارز انتخاب شود.</div>
              )}
              <div className="form-group">
                <label>صراف (دریافت‌کننده کارمزد)</label>
                <select value={exchangeId} onChange={(e) => setExchangeId(e.target.value)}>
                  <option value="">—</option>
                  {exchanges.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
              {!isCompany && (
                <div className="form-group">
                  <label>پروژهٔ مرتبط (اختیاری — فقط پروژه‌های همین طرف حساب)</label>
                  <SearchableSelect value={projectId} onChange={setProjectId} placeholder="بدون پروژه"
                    options={projects.map((p: any) => ({ value: p.id, label: `${p.code} — ${p.customer?.name || ''}` }))} />
                </div>
              )}
              <div className="form-group"><label>توضیحات</label><input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
              <div className="form-group"><label>پیوست صورتحساب صرافی</label><input type="file" onChange={(e) => setReceipt(e.target.files?.[0] || null)} /></div>
            </>
          )}
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary"
            disabled={!partyReady || !fromAccountId || !toAccountId || !Number(fromAmount) || !computedTo || sameCurrency
              || (Number(feeAmount) > 0 && !feeAccountId) || mut.isPending}
            onClick={() => mut.mutate()}>ثبت عملیات</button>
        </div>
      </div>
    </div>
  )
}
