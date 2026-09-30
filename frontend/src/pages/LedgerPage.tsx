import { useState, useMemo, Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { toShamsi, shamsiMonthLabel, nowJalali } from '../lib/date'
import DateField from '../components/shared/DateField'
import SearchableSelect from '../components/shared/SearchableSelect'
import { PageHeader, TabChips, Loading, TableEmpty, EmptyState, Alert } from '../components/ui'
import Icon from '../components/ui/Icon'
import ModalPortal from '../components/ui/ModalPortal'
import { fmt, signColor, CUR_LABEL } from '../lib/ledgerFormat'
import { StatementPrintHead, StatementSignatures, PrintButton } from '../components/shared/StatementPrint'
import { dialog, toast } from '../components/ui/dialog'
import LedgerCommandBar, { Attachments } from './LedgerOps'
import { OverviewTab, AgingView, AccountLedgerModal, CsvButton, AccountFormModal, PeriodPanel } from './LedgerReports'
import { ChequeTab, PettyCashTab } from './LedgerInstruments'
import { FixedAssetsTab, MonthEndTab } from './LedgerAssets'
import { JournalBookView, GeneralBookView, PartyStatementView } from './LedgerBooks'
import { NotesView, PayrollTaxView } from './LedgerNotes'
import { PayrollTab } from './LedgerPayroll'

/**
 * رابط هستهٔ جدید دفترداری.
 *
 * ⚠️ **همهٔ مبالغ از سرور به‌صورت رشته می‌آیند** و در کوچک‌ترین واحد ارز هستند
 * (ریال، سنت، فِن). با `Number()` کار نمی‌کنیم چون مبالغ ریالی از محدودهٔ امن
 * عدد جاوااسکریپت بیرون می‌زنند — همان گم‌شدن ریالی که کل بازنویسی برای رفعش بود.
 * قالب‌بندی با `BigInt` انجام می‌شود.
 */

const groupRow = { background: 'var(--surface-2)', fontWeight: 700 } as const

/**
 * تب‌های سطح اول — بر اساس **کاری که کاربر می‌خواهد بکند**، نه جایی که کد
 * نوشته شده (ممیزی سوم، بخش د).
 *
 * پیش از این ۱۱ تب در دو ردیف بود و چهارتایش در جای غلط نشسته بودند:
 * «تراز آزمایشی» یک گزارش بود ولی تب مستقل داشت، در حالی که شش گزارش دیگر
 * زیرتبِ «صورت‌های مالی» بودند؛ «سلامت و دوره» سه چیز بی‌ربط را کنار هم گذاشته
 * بود (تنظیمات سال مالی، بررسی یکپارچگی، سیاههٔ حسابرسی)؛ و «چک» و
 * «تنخواه‌گردان» دو تب جدا برای دو ابزارِ هم‌خانواده بودند.
 */
/**
 * تب‌ها بر اساس **کاری که حسابدار می‌کند**، نه ترتیبی که ماژول‌ها ساخته شدند.
 *
 * چیدمانِ قبلی دو تبِ «X و Y» داشت که X و Y به هم ربطی نداشتند:
 * «دارایی و پایان دوره» (یک دفترِ دارایی + یک فرآیند) و «تنظیمات و سلامت»
 * (پیکربندی + عیب‌یابی). هر دو فقط چون هم‌زمان ساخته شده بودند کنار هم
 * افتاده بودند — یعنی ترتیبِ ساخت به رابط کاربر نشت کرده بود.
 *
 * و بدتر: کارهای پایان دوره در چهار تب پخش بودند. چک‌لیست می‌گفت «تسعیر
 * نکرده‌ای» ولی تسعیر در «تنظیمات» بود، ذخیره در «گزارش‌ها»، استهلاک در
 * «دارایی»، و بستن سال باز در «تنظیمات». حسابدار فهرست کارها را می‌دید و
 * برای هر بند باید در سامانه می‌گشت.
 *
 * حالا:
 *   نمای کلی    — وضعیت + چک‌لیستِ همین ماه، اولین چیزی که صبح می‌بینی
 *   دفتر روزنامه — دیدنِ اسناد و **هر چهار راهِ ثبت**، یک‌جا
 *   گزارش‌ها     — فقط خواندن
 *   عملیات      — زیرسامانه‌هایی که رکورد خودشان را دارند
 *   پایان دوره   — همهٔ کارهای بستنِ ماه و سال، کنار هم
 *   تنظیمات     — مبنا و عیب‌یابی
 */
const TABS = [
  { key: 'overview', label: 'نمای کلی' },
  { key: 'journal', label: 'دفتر روزنامه' },
  { key: 'reports', label: 'گزارش‌ها' },
  { key: 'operations', label: 'عملیات' },
  { key: 'closing', label: 'پایان دوره' },
  { key: 'settings', label: 'تنظیمات و سلامت' },
] as const
type TabKey = (typeof TABS)[number]['key']

/** نوار زیرتب — الگوی مشترک هر تبی که چند بخش دارد */
export function SubTabs<T extends string>(
  { tabs, value, onChange }: { tabs: readonly (readonly [T, string])[]; value: T; onChange: (v: T) => void },
) {
  return (
    <div className="settings-tabs" style={{ margin: 0 }}>
      {tabs.map(([k, label]) => (
        <button key={k} className={`tab-btn ${value === k ? 'active' : ''}`} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export default function LedgerPage() {
  const [tab, setTab] = useState<TabKey>('overview')
  const qc = useQueryClient()

  const { data: status, isLoading } = useQuery({
    queryKey: ['ledger', 'status'],
    queryFn: async () => (await api.get('/ledger/status')).data,
  })

  const setup = useMutation({
    mutationFn: async () => (await api.post('/ledger/setup')).data,
    onSuccess: () => { toast.success('چارت حساب‌ها ساخته شد'); qc.invalidateQueries({ queryKey: ['ledger'] }) },
  })

  if (isLoading) return <Loading />

  return (
    <div className="page" dir="rtl">
      {/*
        نوار فرمان از سربرگ برداشته شد و به تب «دفتر روزنامه» رفت.
        سه دکمهٔ کنش (دریافت/پرداخت، ارزی، داخلی) بالای تب‌ها می‌نشستند و
        این یعنی سه فعل از هفت اسم مهم‌ترند — که نبودند. ضمناً روی هر تبی
        دیده می‌شدند: «دریافت/پرداخت» وقتی دفتر کل قانونی را می‌خوانی.

        و مهم‌تر: چهار راهِ ثبت سند وجود داشت و یکی‌شان («سند دستی») داخل تب
        دفتر بود و سه‌تای دیگر در سربرگ. حالا هر چهار در یک جا.
      */}
      <PageHeader
        title="حسابداری"
        subtitle="حسابداری دوطرفه با تفصیلی شناور، مراکز هزینه و چندارزی · معادل‌ها به ریال"
        chips={status?.ready
          ? <TabChips tabs={TABS as any} value={tab} onChange={(k: any) => setTab(k)} />
          : undefined}
      />

      {!status?.ready
        ? <SetupPanel status={status} onSetup={() => setup.mutate()} busy={setup.isPending} />
        : (
          <>
            {tab === 'overview' && <OverviewTab onGoPeriodEnd={() => setTab('closing')} onGoJournal={() => setTab('journal')} />}
            {tab === 'journal' && <JournalTab />}
            {tab === 'reports' && <ReportsTab />}
            {tab === 'operations' && <OperationsTab />}
            {tab === 'closing' && <PeriodEndTab />}
            {tab === 'settings' && <SettingsTab />}
          </>
        )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
function SetupPanel({ status, onSetup, busy }: { status: any; onSetup: () => void; busy: boolean }) {
  const qc = useQueryClient()
  const [title, setTitle] = useState('۱۴۰۵')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const createFy = useMutation({
    mutationFn: async () => (await api.post('/ledger/fiscal-years', { title, startDate, endDate })).data,
    onSuccess: () => { toast.success('سال مالی ساخته شد'); qc.invalidateQueries({ queryKey: ['ledger'] }) },
  })

  const hasChart = (status?.accounts ?? 0) > 0
  const hasFy = (status?.fiscalYears?.length ?? 0) > 0
  const Step = ({ done, n, children }: { done: boolean; n: number; children: any }) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontWeight: 650, color: done ? 'var(--success)' : 'var(--text)' }}>
      {done ? <Icon name="check" size={16} /> : <span className="num">{n}.</span>}
      {children}
    </span>
  )

  return (
    <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 640 }}>
      <div className="hint">هستهٔ جدید هنوز راه‌اندازی نشده. دو قدم لازم است:</div>

      <div className="row-between">
        <Step done={hasChart} n={1}>چارت حساب‌ها و مراکز هزینهٔ پیش‌فرض</Step>
        {hasChart
          ? <span className="hint-sm">{status.accounts} حساب</span>
          : <button className="btn-primary" onClick={onSetup} disabled={busy}>{busy ? 'در حال ساخت…' : 'ساخت چارت'}</button>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Step done={hasFy} n={2}>سال مالی</Step>
        {hasFy
          ? <span className="hint-sm">{status.fiscalYears.map((f: any) => f.title).join('، ')}</span>
          : (
            <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label>عنوان</label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: 90 }} />
              </div>
              <div className="form-group" style={{ margin: 0 }}><label>از تاریخ</label><DateField value={startDate} onChange={setStartDate} /></div>
              <div className="form-group" style={{ margin: 0 }}><label>تا تاریخ</label><DateField value={endDate} onChange={setEndDate} /></div>
              <button className="btn-primary" disabled={!title || !startDate || !endDate || createFy.isPending} onClick={() => createFy.mutate()}>
                ساخت سال مالی
              </button>
            </div>
          )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
function JournalTab() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [serial, setSerial] = useState('')
  const [accountCode, setAccountCode] = useState('')
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<'date' | 'serial' | 'created'>('date')
  const [dir, setDir] = useState<'desc' | 'asc'>('desc')
  const [groupBy, setGroupBy] = useState<GroupKey>('none')
  const TAKE = 50
  const params = {
    take: TAKE, skip: page * TAKE, sort, dir,
    q: q || undefined, serial: serial || undefined, accountCode: accountCode || undefined,
  }

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['ledger', 'entries', params],
    queryFn: async () => (await api.get('/ledger/entries', { params })).data,
  })

  /**
   * ⚠️ ممیزی ر۳ — دلیل ابطال از کاربر پرسیده می‌شود.
   *
   * پیش‌تر رشتهٔ ثابت «ابطال از رابط کاربری» فرستاده می‌شد. فیلد
   * `reversalReason` در دیتابیس هست، در سند برگشتی ذخیره می‌شود و در ممیزی
   * دیده می‌شود — و همیشه همان یک جملهٔ بی‌معنی بود. دلیلِ ابطال تمامِ ارزشِ
   * ردِ ممیزی است.
   */
  const doReverse = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) =>
      (await api.post(`/ledger/entries/${id}/reverse`, { reason })).data,
    onSuccess: () => { toast.success('سند برگشتی ثبت شد'); qc.invalidateQueries({ queryKey: ['ledger'] }) },
    onError: (e: any) => dialog.alert({ title: 'ابطال ناموفق', message: e?.response?.data?.message, tone: 'danger' }),
  })
  const postDraft = useMutation({
    mutationFn: async (id: string) => (await api.post(`/ledger/entries/${id}/post`)).data,
    onSuccess: () => { toast.success('پیش‌نویس نهایی شد'); qc.invalidateQueries({ queryKey: ['ledger'] }) },
    onError: (e: any) => dialog.alert({ title: 'نهایی‌کردن ناموفق', message: e?.response?.data?.message, tone: 'danger' }),
  })
  const delDraft = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/ledger/entries/${id}`)).data,
    onSuccess: () => { toast.success('پیش‌نویس حذف شد'); qc.invalidateQueries({ queryKey: ['ledger'] }) },
  })

  if (isLoading) return <Loading />
  const rows: any[] = data?.rows ?? []
  const total: number = data?.total ?? 0
  const draftCount = rows.filter((e) => e.status === 'DRAFT').length
  const pages = Math.max(1, Math.ceil(total / TAKE))
  const reset = (fn: () => void) => { fn(); setPage(0) }
  const groups = groupEntries(rows, groupBy)

  return (
    <div>
      {/*
        هر چهار راهِ ثبتِ سند، یک‌جا. سه‌تای اول از سربرگ آمدند؛ «سند دستی»
        از قبل اینجا بود. جداکنندهٔ عمودی، کنش‌ها را از فیلترها جدا می‌کند
        تا نوار یک ردیفِ درهمِ ده‌تایی نباشد.
      */}
      <div className="toolbar">
        <LedgerCommandBar />
        <button className="btn-secondary" onClick={() => nav('/ledger/entry/new')}>
          <Icon name="plus" size={15} /> سند دستی
        </button>
        <span aria-hidden style={{
          alignSelf: 'stretch', width: 1, background: 'var(--border)',
          margin: '0 4px',
        }} />
        <div className="form-group" style={{ margin: 0 }}>
          <label>جستجوی شرح</label>
          <input value={q} onChange={(e) => reset(() => setQ(e.target.value))} placeholder="بابت…" style={{ width: 160 }} />
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>شماره سند</label>
          <input className="num" value={serial} onChange={(e) => reset(() => setSerial(e.target.value))} style={{ width: 90 }} inputMode="numeric" />
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>کد حساب</label>
          <input className="num" value={accountCode} onChange={(e) => reset(() => setAccountCode(e.target.value))} placeholder="مثلاً ۵۱" style={{ width: 90 }} />
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>مرتب‌سازی</label>
          <select value={`${sort}:${dir}`} onChange={(e) => reset(() => {
            const [sv, dv] = e.target.value.split(':')
            setSort(sv as any); setDir(dv as any)
          })} style={{ width: 160 }}>
            <option value="date:desc">تاریخ سند، جدید به قدیم</option>
            <option value="date:asc">تاریخ سند، قدیم به جدید</option>
            <option value="serial:desc">شمارهٔ سند، نزولی</option>
            <option value="serial:asc">شمارهٔ سند، صعودی</option>
            <option value="created:desc">زمان ثبت، تازه‌ترین</option>
          </select>
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>گروه‌بندی</label>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupKey)} style={{ width: 140 }}
            title={pages > 1 ? 'گروه‌بندی روی اسناد همین صفحه انجام می‌شود' : undefined}>
            {GROUP_OPTIONS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
        </div>
        <span className="hint-sm">{total} سند{draftCount > 0 ? ` · ${draftCount} پیش‌نویس` : ''}{isFetching ? ' …' : ''}</span>
        <span style={{ marginInlineStart: 'auto' }}><CsvButton path="/ledger/export/journal" filename="journal.csv" params={{ q: q || undefined, serial: serial || undefined, accountCode: accountCode || undefined }} /></span>
      </div>

      {!rows.length ? (
        <EmptyState icon={<Icon name="book" />} title={q || serial || accountCode ? 'سندی با این فیلتر نیست' : 'هنوز سندی ثبت نشده'}>
          با «سند دستی جدید» یا از نوار فرمان (دریافت/پرداخت، تبدیل ارز، عملیات داخلی) شروع کنید.
        </EmptyState>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>شماره</th><th>تاریخ</th><th>شرح</th><th>نوع</th>
                <th>وضعیت</th><th style={{ textAlign: 'left' }}>مبلغ (ریال)</th><th></th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.key}>
                  {groupBy !== 'none' && (
                    <tr style={{ background: 'var(--surface-2)' }}>
                      <td colSpan={5} style={{ fontWeight: 800 }}>
                        {g.label} <span className="hint-sm" style={{ fontWeight: 400 }}>· {g.rows.length} سند</span>
                      </td>
                      <td className="num" style={{ textAlign: 'left', fontWeight: 800 }}>{fmt(g.total)}</td>
                      <td />
                    </tr>
                  )}
              {g.rows.map((e) => {
                const total = e.lines.reduce((s: bigint, l: any) => s + BigInt(l.debitBase), 0n)
                const open = expanded === e.id
                return (
                  <Fragment key={e.id}>
                    <tr style={e.status === 'REVERSED' ? { opacity: 0.55 } : e.status === 'DRAFT' ? { background: 'var(--warning-soft, #fff7ed)' } : undefined}>
                      <td className="num">{e.serial ?? '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{toShamsi(e.date)}</td>
                      <td>{e.description} <Attachments urls={e.attachmentUrls} /></td>
                      <td className="hint-sm">{ENTRY_TYPE[e.entryType] ?? e.entryType}</td>
                      <td className="hint-sm" style={e.status === 'DRAFT' ? { color: 'var(--warning)', fontWeight: 700 } : undefined}>{STATUS[e.status] ?? e.status}</td>
                      <td className="num" style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{fmt(total.toString())}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button className="btn-secondary btn-sm" onClick={() => setExpanded(open ? null : e.id)}>
                            {open ? 'بستن' : 'ردیف‌ها'}
                          </button>
                          {e.status === 'DRAFT' && (
                            <>
                              <button className="btn-primary btn-sm" disabled={postDraft.isPending} onClick={() => postDraft.mutate(e.id)}>نهایی</button>
                              <button className="icon-btn danger" aria-label="حذف پیش‌نویس"
                                onClick={async () => { if (await dialog.confirm({ title: 'حذف پیش‌نویس', message: 'این پیش‌نویس برای همیشه حذف می‌شود.', confirmLabel: 'حذف', tone: 'danger' })) delDraft.mutate(e.id) }}>
                                <Icon name="trash" />
                              </button>
                            </>
                          )}
                          {e.status === 'POSTED' && (
                            <button
                              className="btn-danger btn-sm"
                              onClick={async () => {
                                const reason = await dialog.prompt({
                                  title: `ابطال سند ${e.serial}`,
                                  message: 'سند اصلی حذف نمی‌شود؛ یک سند برگشتی ثبت می‌شود و اثرش خنثی می‌گردد. '
                                    + 'دلیل ابطال در ردِ ممیزی ثبت می‌شود.',
                                  placeholder: 'دلیل ابطال — مثلاً: مبلغ اشتباه وارد شده بود',
                                  confirmLabel: 'ابطال کن', tone: 'danger', required: true,
                                })
                                if (reason) doReverse.mutate({ id: e.id, reason: reason.trim() })
                              }}
                            >ابطال</button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7} style={{ padding: 0, background: 'var(--surface-2)' }}>
                          <table className="data-table" style={{ background: 'transparent' }}>
                            <thead>
                              <tr>
                                <th>حساب</th><th>تفصیلی</th><th>مرکز هزینه</th><th>ارز</th>
                                <th style={{ textAlign: 'left' }}>بدهکار</th>
                                <th style={{ textAlign: 'left' }}>بستانکار</th>
                                <th style={{ textAlign: 'left' }}>نرخ</th><th>شرح</th>
                              </tr>
                            </thead>
                            <tbody>
                              {e.lines.map((l: any) => (
                                <tr key={l.id}>
                                  <td><span className="num">{l.account.code}</span> — {l.account.name}</td>
                                  <td>{l.subsidiary ? `${l.subsidiary.code} ${l.subsidiary.name}` : '—'}</td>
                                  <td>{l.costCenter ? l.costCenter.name : '—'}</td>
                                  <td>{CUR_LABEL[l.currencyCode] ?? l.currencyCode}</td>
                                  <td className="num" style={{ textAlign: 'left' }}>{l.debit !== '0' ? fmt(l.debit, l.currencyCode) : ''}</td>
                                  <td className="num" style={{ textAlign: 'left' }}>{l.credit !== '0' ? fmt(l.credit, l.currencyCode) : ''}</td>
                                  <td className="num" style={{ textAlign: 'left', color: 'var(--text-muted)' }}>{Number(l.rate).toLocaleString()}</td>
                                  <td className="hint-sm">{l.memo ?? ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {groupBy !== 'none' && pages > 1 && (
        <p className="hint" style={{ marginTop: 8 }}>
          گروه‌بندی و جمعِ هر گروه روی <strong>اسناد همین صفحه</strong> است، نه کل {total} سند.
          مرتب‌سازی اما سمت سرور انجام می‌شود، پس با «تاریخ سند» ماه‌ها پیوسته‌اند.
        </p>
      )}

      {pages > 1 && (
        <div className="row-between" style={{ marginTop: 12 }}>
          <button className="btn-secondary btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>قبلی</button>
          <span className="hint-sm">صفحهٔ {page + 1} از {pages}</span>
          <button className="btn-secondary btn-sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>بعدی</button>
        </div>
      )}

    </div>
  )
}

/**
 * گروه‌بندی فهرست دفتر روزنامه (ممیزی سوم — ج۲).
 *
 * **محدودهٔ صادقانه‌اش:** گروه‌بندی روی ردیف‌های *همین صفحه* انجام می‌شود، نه
 * روی کل نتیجه. مرتب‌سازی سمت سرور است، پس وقتی بر اساس تاریخ مرتب باشد
 * ماه‌ها پیوسته‌اند و فقط ماهِ سرِ صفحه ممکن است ناقص باشد. جمعِ هر گروه هم
 * همین را می‌گوید: جمعِ اسنادِ دیده‌شده، نه جمعِ ماه.
 */
type GroupKey = 'none' | 'month' | 'type' | 'status'

const GROUP_OPTIONS: { key: GroupKey; label: string }[] = [
  { key: 'none', label: 'بدون گروه‌بندی' },
  { key: 'month', label: 'ماه سند' },
  { key: 'type', label: 'نوع سند' },
  { key: 'status', label: 'وضعیت' },
]

function groupEntries(rows: any[], by: GroupKey) {
  const sumOf = (list: any[]) =>
    list.reduce((s: bigint, e: any) =>
      s + e.lines.reduce((x: bigint, l: any) => x + BigInt(l.debitBase), 0n), 0n).toString()

  if (by === 'none') return [{ key: 'all', label: '', rows, total: sumOf(rows) }]

  const labelOf = (e: any) =>
    by === 'month' ? shamsiMonthLabel(e.date)
      : by === 'type' ? (ENTRY_TYPE[e.entryType] ?? e.entryType)
        : (STATUS[e.status] ?? e.status)

  // ترتیبِ گروه‌ها از ترتیبِ خودِ ردیف‌ها می‌آید تا مرتب‌سازیِ سرور را نشکند
  const order: string[] = []
  const map = new Map<string, any[]>()
  for (const e of rows) {
    const k = labelOf(e)
    if (!map.has(k)) { map.set(k, []); order.push(k) }
    map.get(k)!.push(e)
  }
  return order.map((k) => ({ key: k, label: k, rows: map.get(k)!, total: sumOf(map.get(k)!) }))
}

const ENTRY_TYPE: Record<string, string> = {
  OPENING: 'افتتاحیه', NORMAL: 'عادی', ADJUSTING: 'تعدیلی',
  CLOSING: 'اختتامیه', REVERSING: 'برگشتی',
}
const STATUS: Record<string, string> = {
  DRAFT: 'پیش‌نویس', POSTED: 'ثبت‌شده', REVERSED: 'باطل‌شده',
}

/**
 * پاک‌سازی مبلغ برای نمایش و ارسال (ممیزی ب۱ و ر۵).
 *
 * کاربر هرچه راحت است تایپ می‌کند — ارقام فارسی، کاما، فاصله — و ما یک رشتهٔ
 * تمیزِ لاتین می‌فرستیم. بک‌اند هم همین را می‌پذیرد، ولی اتکا به یک لایه کافی
 * نیست: ورودیِ خام قبلاً باعث می‌شد «۱٬۲۳۴» بی‌صدا یک ریال ثبت شود.
 */
const cleanAmount = (s: string): string =>
  s.replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/٫/g, '.')
    .replace(/[^\d.]/g, '')

/** جداکنندهٔ هزارگان فقط برای **نمایش** زیر فیلد — مقدارِ ارسالی دست‌نخورده است */
const groupDigits = (s: string): string => {
  const v = cleanAmount(s)
  if (!v) return ''
  const [int, frac] = v.split('.')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '٬')
  return frac !== undefined ? `${grouped}٫${frac}` : grouped
}

// ═══════════════════════════════════════════════════════════════
/**
 * سند دستی — صفحهٔ تمام‌صفحهٔ دوستونه (ممیزی ر۶).
 *
 * پیش از این مودالی با عرض ثابت ۹۶۰ پیکسل بود. یک سند حسابداری چندردیفی
 * «کار روی یک رکورد» است، نه یک تأیید ساده: نه ستون‌های نه‌گانه‌اش در آن عرض
 * جا می‌شد، نه می‌شد کنارش گزارشی را باز کرد، نه آدرس داشت که نیمه‌کاره رهایش
 * کنی و برگردی.
 *
 * چیدمان: **ستون راست سربرگ و توازن** (تاریخ، شرح، جمع بدهکار/بستانکار،
 * وضعیت) و **ستون چپ ردیف‌ها**. توازن سمت شروعِ خواندن می‌نشیند چون همان
 * چیزی است که کاربر حین تایپ مدام نگاهش می‌کند.
 */
export function ManualEntryPage() {
  const nav = useNavigate()
  const onClose = () => nav('/ledger')
  const qc = useQueryClient()
  const [date, setDate] = useState('')
  const [description, setDescription] = useState('')
  const [lines, setLines] = useState<any[]>([
    { accountId: '', currencyCode: 'IRR', debit: '', credit: '', rate: '', memo: '' },
    { accountId: '', currencyCode: 'IRR', debit: '', credit: '', rate: '', memo: '' },
  ])

  const { data: chart } = useQuery({
    queryKey: ['ledger', 'accounts'],
    queryFn: async () => (await api.get('/ledger/accounts')).data,
  })
  const { data: subs } = useQuery({
    queryKey: ['ledger', 'subsidiaries'],
    queryFn: async () => (await api.get('/ledger/subsidiaries')).data,
  })
  const { data: ccs } = useQuery({
    queryKey: ['ledger', 'cost-centers'],
    queryFn: async () => (await api.get('/ledger/cost-centers')).data,
  })

  const postable = useMemo(
    () => (chart?.accounts ?? []).filter((a: any) => a.isPostable && a.isActive),
    [chart],
  )

  /**
   * توازن زنده به ارز پایه (ممیزی ر۱).
   *
   * تا پیش از این، کاربر سند ده‌ردیفی را وارد می‌کرد، «ثبت» می‌زد، و تازه از
   * سرور «سند تراز نیست: اختلاف ۱۰۰» می‌گرفت — بدون اینکه بداند کدام ردیف.
   * ردیفی که نرخش معلوم نیست در جمع نمی‌آید و جداگانه اعلام می‌شود.
   */
  const balance = useMemo(() => {
    let debit = 0, credit = 0, unknown = 0
    for (const l of lines) {
      if (!l.accountId) continue
      const isBase = l.currencyCode === 'IRR'
      const r = isBase ? 1 : Number(cleanAmount(l.rate || ''))
      const d = Number(cleanAmount(l.debit || '')) || 0
      const c = Number(cleanAmount(l.credit || '')) || 0
      if (!d && !c) continue
      if (!isBase && !(r > 0)) { unknown++; continue }
      debit += d * r
      credit += c * r
    }
    return { debit, credit, diff: debit - credit, unknown }
  }, [lines])

  const balanced = balance.diff === 0 && balance.unknown === 0 && balance.debit > 0

  const save = useMutation({
    mutationFn: async (draft: boolean) => (await api.post('/ledger/entries', {
      date, description, draft,
      lines: lines
        .filter((l) => l.accountId && (l.debit || l.credit))
        .map((l) => ({
          accountId: l.accountId,
          subsidiaryId: l.subsidiaryId || undefined,
          costCenterId: l.costCenterId || undefined,
          currencyCode: l.currencyCode,
          debit: l.debit ? cleanAmount(l.debit) : undefined,
          credit: l.credit ? cleanAmount(l.credit) : undefined,
          // ممیزی ر۲: نرخ ردیف تا حالا اصلاً فرستاده نمی‌شد، پس هر سند ارزیِ
          // دستی به نرخ روز بسته می‌شد و ثبت به نرخ قرارداد ممکن نبود.
          rate: l.currencyCode !== 'IRR' && l.rate ? cleanAmount(l.rate) : undefined,
          memo: l.memo || undefined,
        })),
    })).data,
    onSuccess: (_d, draft) => {
      toast.success(draft ? 'پیش‌نویس ذخیره شد' : 'سند ثبت شد')
      qc.invalidateQueries({ queryKey: ['ledger'] })
      onClose()
    },
    onError: (e: any) => dialog.alert({ title: 'ثبت سند ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const setLine = (i: number, patch: any) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  return (
    <div className="page">
      <PageHeader title="سند دستی جدید" actions={
        <button className="btn-secondary btn-sm" onClick={onClose}>بازگشت به دفترداری</button>
      } />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 320px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}
        className="party-grid">
        {/* ───── ستون سربرگ و توازن ───── */}
        <div style={{ display: 'grid', gap: 16 }}>
          <section className="panel">
            <div className="section-title">سربرگ سند</div>
            <div className="form-group">
              <label>تاریخ سند</label>
              <DateField value={date} onChange={setDate} />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label>شرح</label>
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="بابت…" />
            </div>
          </section>

          <section className="panel">
            <div className="section-title">توازن</div>
            <div style={{ display: 'grid', gap: 8 }}>
              <BalanceRow label="جمع بدهکار" value={groupDigits(String(balance.debit))} />
              <BalanceRow label="جمع بستانکار" value={groupDigits(String(balance.credit))} />
              <BalanceRow label="اختلاف" value={groupDigits(String(Math.abs(balance.diff)))} bold divider />
              <div style={{ fontWeight: 700, fontSize: 13 }}>
                {balance.unknown > 0 ? (
                  <span style={{ color: 'var(--warning)' }}>
                    نرخ {balance.unknown} ردیف ارزی معلوم نیست — نرخ روز اعمال می‌شود
                  </span>
                ) : balanced ? (
                  <span style={{ color: 'var(--success)' }}>
                    <Icon name="check" size={13} /> سند تراز است
                  </span>
                ) : balance.debit || balance.credit ? (
                  <span style={{ color: 'var(--danger)' }}>
                    {balance.diff > 0 ? 'بدهکار بیشتر است' : 'بستانکار بیشتر است'}
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>هنوز مبلغی وارد نشده</span>
                )}
              </div>
            </div>
          </section>

          <section className="panel">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-secondary" disabled={!date || !description || save.isPending}
                onClick={() => save.mutate(true)}>
                ذخیرهٔ پیش‌نویس
              </button>
              {/* ثبت نهایی فقط وقتی سند تراز است — پیش‌نویس همیشه ذخیره می‌شود */}
              <button className="btn-primary" disabled={!date || !description || !balanced || save.isPending}
                title={balanced ? '' : 'سند تراز نیست'} onClick={() => save.mutate(false)}>
                {save.isPending ? 'در حال ثبت…' : 'ثبت نهایی'}
              </button>
            </div>
            <p className="hint-sm" style={{ marginBottom: 0 }}>
              مبالغ ریالی به <strong>ریال</strong> وارد می‌شوند، نه تومان. جداکنندهٔ هزارگان و
              ارقام فارسی هر دو پذیرفته می‌شوند.
            </p>
          </section>
        </div>

        {/* ───── ستون ردیف‌ها ───── */}
        <div>
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>حساب</th><th>تفصیلی</th><th>مرکز هزینه</th>
                    <th>ارز</th><th>نرخ</th><th>بدهکار</th><th>بستانکار</th>
                    <th>شرح ردیف</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td style={{ minWidth: 220 }}>
                        <SearchableSelect
                          value={l.accountId}
                          onChange={(v: string) => setLine(i, { accountId: v })}
                          options={postable.map((a: any) => ({ value: a.id, label: `${a.code} — ${a.name}` }))}
                          placeholder="انتخاب حساب"
                        />
                      </td>
                      <td style={{ minWidth: 170 }}>
                        <SearchableSelect
                          value={l.subsidiaryId || ''}
                          onChange={(v: string) => setLine(i, { subsidiaryId: v })}
                          options={[{ value: '', label: '—' }, ...(subs ?? []).map((s: any) => ({ value: s.id, label: `${s.code} ${s.name}` }))]}
                          placeholder="—"
                        />
                      </td>
                      <td style={{ minWidth: 140 }}>
                        <select value={l.costCenterId || ''} onChange={(e) => setLine(i, { costCenterId: e.target.value })}>
                          <option value="">—</option>
                          {(ccs ?? []).filter((c: any) => c.isPostable).map((c: any) => (
                            <option key={c.id} value={c.id}>{c.code} {c.name}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select style={{ width: 80 }} value={l.currencyCode} onChange={(e) => setLine(i, { currencyCode: e.target.value })}>
                          {Object.keys(CUR_LABEL).map((c) => <option key={c} value={c}>{CUR_LABEL[c]}</option>)}
                        </select>
                      </td>
                      <td>
                        {/* ممیزی ر۲ — نرخ فقط برای ارز غیرپایه معنی دارد */}
                        <input className="num" style={{ width: 110 }} inputMode="decimal"
                          disabled={l.currencyCode === 'IRR'}
                          placeholder={l.currencyCode === 'IRR' ? '—' : 'نرخ روز'}
                          value={l.currencyCode === 'IRR' ? '' : l.rate}
                          onChange={(e) => setLine(i, { rate: e.target.value })} />
                      </td>
                      <td>
                        <input className="num" style={{ width: 140 }} inputMode="decimal" value={l.debit}
                          onChange={(e) => setLine(i, { debit: e.target.value, credit: '' })} />
                        {l.debit && <div className="hint-sm num" style={{ textAlign: 'left' }}>{groupDigits(l.debit)}</div>}
                      </td>
                      <td>
                        <input className="num" style={{ width: 140 }} inputMode="decimal" value={l.credit}
                          onChange={(e) => setLine(i, { credit: e.target.value, debit: '' })} />
                        {l.credit && <div className="hint-sm num" style={{ textAlign: 'left' }}>{groupDigits(l.credit)}</div>}
                      </td>
                      <td>
                        {/* ممیزی ر۴ — شرح ردیف در حالت بود ولی هیچ‌وقت رندر نمی‌شد */}
                        <input style={{ minWidth: 150 }} value={l.memo}
                          placeholder="اختیاری"
                          onChange={(e) => setLine(i, { memo: e.target.value })} />
                      </td>
                      <td>
                        {lines.length > 2 && (
                          <button className="icon-btn danger" aria-label="حذف ردیف" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                            <Icon name="trash" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                {/* ممیزی ر۱ — نشانگر توازن، همان‌جایی که بیشترین نیاز را دارد */}
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--border)' }}>
                    <td colSpan={5} style={{ fontWeight: 700 }}>جمع به ارز پایه</td>
                    <td className="num" style={{ textAlign: 'left', fontWeight: 700 }}>
                      {groupDigits(String(balance.debit))}
                    </td>
                    <td className="num" style={{ textAlign: 'left', fontWeight: 700 }}>
                      {groupDigits(String(balance.credit))}
                    </td>
                    <td colSpan={2}>
                      {balance.unknown > 0 ? (
                        <span style={{ color: 'var(--warning, #a9722a)', fontWeight: 700 }}>
                          نرخ {balance.unknown} ردیف ارزی معلوم نیست — نرخ روز اعمال می‌شود
                        </span>
                      ) : balanced ? (
                        <span style={{ color: 'var(--success, #2c6a51)', fontWeight: 700 }}>
                          <Icon name="check" size={13} /> سند تراز است
                        </span>
                      ) : balance.debit || balance.credit ? (
                        <span style={{ color: 'var(--danger, #9e2b2b)', fontWeight: 700 }}>
                          اختلاف {groupDigits(String(Math.abs(balance.diff)))} ریال
                          {' — '}{balance.diff > 0 ? 'بدهکار بیشتر است' : 'بستانکار بیشتر است'}
                        </span>
                      ) : null}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <button className="btn-secondary btn-sm" style={{ marginTop: 10 }}
              onClick={() => setLines([...lines, { accountId: '', currencyCode: 'IRR', debit: '', credit: '', rate: '', memo: '' }])}>
              <Icon name="plus" size={14} /> افزودن ردیف
            </button>

            <p className="hint-sm">
              تراز سند به ارز پایه سنجیده می‌شود — سندی که دو ارز مختلف دارد لازم نیست
              به تفکیک ارز تراز باشد. نرخِ خالی یعنی «نرخ روزِ همان تاریخ».
            </p>
        </div>
      </div>
    </div>
  )
}

/** یک سطر برچسب/مقدار در پنل توازنِ سند */
function BalanceRow({ label, value, bold, divider }: {
  label: string; value: string; bold?: boolean; divider?: boolean
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 12,
      paddingTop: divider ? 8 : 0,
      borderTop: divider ? '1px solid var(--border)' : 'none',
    }}>
      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{label}</span>
      <span className="num" style={{ fontWeight: bold ? 800 : 600, fontSize: 13 }}>{value || '۰'}</span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
function ChartTab() {
  const qc = useQueryClient()
  const [drill, setDrill] = useState<{ code: string; name: string } | null>(null)
  const [form, setForm] = useState<any | null | undefined>(undefined)   // undefined=بسته، null=جدید، obj=ویرایش
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'accounts'],
    queryFn: async () => (await api.get('/ledger/accounts')).data,
  })
  const cleanup = useMutation({
    mutationFn: async () => (await api.post('/ledger/accounts/cleanup-names')).data,
    onSuccess: (d: any) => {
      toast.success(d.cleaned.length ? `${d.cleaned.length} نام تمیز شد` : 'نامی برای تمیزکاری نبود')
      qc.invalidateQueries({ queryKey: ['ledger'] })
    },
  })
  if (isLoading) return <Loading />

  const accounts: any[] = data?.accounts ?? []
  const levels: any[] = data?.levels ?? []
  const hasDirty = accounts.some((a) => a.code.startsWith('1101') && / - (IRR|USD|CNY|AED|تومان|ریال|دلار|یوآن|درهم)$/i.test(a.name))

  return (
    <div>
      <div className="toolbar">
        <button className="btn-primary" onClick={() => setForm(null)}><Icon name="plus" size={15} /> حساب جدید</button>
        {hasDirty && (
          <button className="btn-secondary btn-sm" disabled={cleanup.isPending} onClick={() => cleanup.mutate()}>
            <Icon name="repeat" size={14} /> تمیزکاری نام‌های مهاجرت
          </button>
        )}
        <span className="hint-sm">
          سطوح: {levels.map((l) => `${l.name} (${l.digits} رقم)`).join(' ← ')} · کلیک روی برگ = گردش · مداد = ویرایش
        </span>
      </div>
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr><th>کد</th><th>نام</th><th>طبقه</th><th>ماهیت</th><th>صورت</th><th>الزامات</th><th></th></tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}
                style={{ ...(a.isPostable ? {} : groupRow), cursor: a.isPostable ? 'pointer' : undefined, opacity: a.isActive ? 1 : 0.5 }}
                onClick={a.isPostable ? () => setDrill({ code: a.code, name: a.name }) : undefined}>
                <td className="num" style={{ paddingRight: `${16 + (a.level - 1) * 16}px` }}>{a.code}</td>
                <td>{a.name}{!a.isActive && <span className="hint-sm"> (غیرفعال)</span>}</td>
                <td className="hint-sm">{ROOT_LABEL[a.rootType] ?? a.rootType}</td>
                <td className="hint-sm">{a.normalSide === 'DEBIT' ? 'بدهکار' : 'بستانکار'}</td>
                <td className="hint-sm">{a.statement === 'BALANCE_SHEET' ? 'ترازنامه' : 'سود و زیان'}</td>
                <td className="hint-sm">
                  {[
                    !a.isPostable && 'سرگروه',
                    a.requiresSubsidiary && 'تفصیلی اجباری',
                    a.requiresCostCenter && 'مرکز هزینه اجباری',
                    a.currencyMode === 'SINGLE' && `فقط ${CUR_LABEL[a.currencyCode] ?? a.currencyCode}`,
                  ].filter(Boolean).join(' · ') || '—'}
                </td>
                <td>
                  <button className="icon-btn" aria-label="ویرایش" onClick={(e) => { e.stopPropagation(); setForm(a) }}>
                    <Icon name="pencil" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {drill && <AccountLedgerModal code={drill.code} name={drill.name} onClose={() => setDrill(null)} />}
      {form !== undefined && <AccountFormModal account={form} onClose={() => setForm(undefined)} />}
    </div>
  )
}

const ROOT_LABEL: Record<string, string> = {
  ASSET: 'دارایی', LIABILITY: 'بدهی', EQUITY: 'سرمایه',
  INCOME: 'درآمد', EXPENSE: 'هزینه',
}

// ═══════════════════════════════════════════════════════════════
function TrialBalanceTab() {
  const [columns, setColumns] = useState<2 | 4 | 6 | 8>(4)
  const [level, setLevel] = useState<number | ''>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [drill, setDrill] = useState<{ code: string; name: string } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'trial', columns, level, from, to],
    queryFn: async () => (await api.get('/ledger/reports/trial-balance', {
      params: { columns, level: level || undefined, from: from || undefined, to: to || undefined },
    })).data,
  })

  const COL_LABEL: Record<string, string> = {
    openingDebit: 'مانده ابتدا (بد)', openingCredit: 'مانده ابتدا (بس)',
    periodDebit: 'گردش دوره (بد)', periodCredit: 'گردش دوره (بس)',
    cumulativeDebit: 'گردش تجمعی (بد)', cumulativeCredit: 'گردش تجمعی (بس)',
    closingDebit: 'مانده پایان (بد)', closingCredit: 'مانده پایان (بس)',
  }

  return (
    <div>
      <div className="toolbar">
        <div className="settings-tabs" style={{ margin: 0 }}>
          {([2, 4, 6, 8] as const).map((c) => (
            <button key={c} className={`tab-btn ${columns === c ? 'active' : ''}`} onClick={() => setColumns(c)}>{c} ستونی</button>
          ))}
        </div>
        <select style={{ width: 130 }} value={level} onChange={(e) => setLevel(e.target.value ? Number(e.target.value) : '')}>
          <option value="">همهٔ سطوح</option>
          <option value="1">گروه</option>
          <option value="2">کل</option>
          <option value="3">معین</option>
          <option value="4">تفصیلی</option>
        </select>
        <div className="form-group" style={{ margin: 0 }}><label>از</label><DateField value={from} onChange={setFrom} /></div>
        <div className="form-group" style={{ margin: 0 }}><label>تا</label><DateField value={to} onChange={setTo} /></div>
        <span style={{ marginInlineStart: 'auto' }}>
          <CsvButton path="/ledger/export/trial-balance" filename="trial-balance.csv"
            params={{ columns, level: level || undefined, from: from || undefined, to: to || undefined }} />
        </span>
      </div>

      {isLoading ? <Loading /> : !data?.rows?.length ? (
        <EmptyState icon={<Icon name="chart" />} title="گردشی در این بازه نیست" />
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>کد</th><th>نام</th>
                {data.valueColumns.map((c: string) => <th key={c} style={{ textAlign: 'left' }}>{COL_LABEL[c]}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r: any) => (
                <tr key={r.accountId}
                  style={{ ...(r.isPostable ? {} : groupRow), cursor: r.isPostable ? 'pointer' : undefined }}
                  onClick={r.isPostable ? () => setDrill({ code: r.code, name: r.name }) : undefined}>
                  <td className="num" style={{ paddingRight: `${16 + (r.level - 1) * 12}px` }}>{r.code}</td>
                  <td>{r.name}</td>
                  {data.valueColumns.map((c: string) => <td key={c} className="num" style={{ textAlign: 'left' }}>{fmt(r[c])}</td>)}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800 }}>
                <td colSpan={2}>جمع (فقط حساب‌های برگ)</td>
                {data.valueColumns.map((c: string) => <td key={c} className="num" style={{ textAlign: 'left' }}>{fmt(data.totals[c])}</td>)}
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {drill && <AccountLedgerModal code={drill.code} name={drill.name} onClose={() => setDrill(null)} />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
/** بازهٔ قبلی هم‌طول: [from−len, from−۱روز] */
function priorPeriod(from: string, to: string): { compareFrom?: string; compareTo?: string } {
  if (!from || !to) return {}
  const f = new Date(from), t = new Date(to)
  const len = t.getTime() - f.getTime()
  const cTo = new Date(f.getTime() - 86_400_000)
  const cFrom = new Date(cTo.getTime() - len)
  return { compareFrom: cFrom.toISOString().slice(0, 10), compareTo: cTo.toISOString().slice(0, 10) }
}

/**
 * همهٔ گزارش‌ها زیر یک سقف — تراز آزمایشی هم که پیش‌تر تب مستقل داشت، اینجاست.
 */
function ReportsTab() {
  const [view, setView] = useState<'trial' | 'balance' | 'income' | 'cash' | 'equity' | 'ratios' | 'budget' | 'agingAr' | 'agingAp' | 'bankRecon' | 'tax' | 'provision'
    | 'bookJournal' | 'bookGeneral' | 'statement' | 'notes' | 'payrollTax'>('trial')
  const [asOf, setAsOf] = useState('')
  const [from, setFrom] = useState('')
  const [byAccount, setByAccount] = useState(false)
  // ممیزی ج۱۰: صورت سود و زیانِ بدون ستون دورهٔ قبل، برای تصمیم‌گیری بی‌فایده است
  const [compare, setCompare] = useState(true)
  // ممیزی ب۳: فیلتر مرکز هزینه که تا امروز اصلاً در رابط کاربری نبود
  const [costCenterId, setCostCenterId] = useState('')

  const { data: centres } = useQuery({
    queryKey: ['ledger', 'cost-centers'],
    queryFn: async () => (await api.get('/ledger/cost-centers')).data as any[],
  })

  const bs = useQuery({
    queryKey: ['ledger', 'bs', asOf],
    queryFn: async () => (await api.get('/ledger/reports/balance-sheet', { params: { asOf: asOf || undefined } })).data,
    enabled: view === 'balance',
  })
  const isParams = {
    from: from || undefined, to: asOf || undefined,
    byAccount: byAccount ? 'true' : undefined,
    costCenterIds: costCenterId || undefined,
    ...(compare ? priorPeriod(from, asOf) : {}),
  }
  const is = useQuery({
    queryKey: ['ledger', 'is', from, asOf, byAccount, compare, costCenterId],
    queryFn: async () => (await api.get('/ledger/reports/income-statement', { params: isParams })).data,
    enabled: view === 'income',
  })
  const cf = useQuery({
    queryKey: ['ledger', 'cf', from, asOf],
    queryFn: async () => (await api.get('/ledger/reports/cash-flow', {
      params: { from: from || undefined, to: asOf || undefined },
    })).data,
    enabled: view === 'cash' && !!from,
  })

  return (
    <div>
      <div className="toolbar">
        <div className="form-group" style={{ margin: 0, minWidth: 220 }}>
          <label>گزارش</label>
          <select value={view} onChange={(e) => setView(e.target.value as any)}>
            {REPORT_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.items.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        {(view === 'income' || view === 'cash' || view === 'ratios' || view === 'equity') && (
          <div className="form-group" style={{ margin: 0 }}><label>از</label><DateField value={from} onChange={setFrom} /></div>
        )}
        {view !== 'agingAr' && view !== 'agingAp' && view !== 'bankRecon' && view !== 'trial' && view !== 'budget' && view !== 'tax' && view !== 'provision'
          && view !== 'bookJournal' && view !== 'bookGeneral' && view !== 'statement'
          && view !== 'notes' && view !== 'payrollTax' && (
          <div className="form-group" style={{ margin: 0 }}>
            <label>{view === 'balance' ? 'در تاریخ' : 'تا'}</label>
            <DateField value={asOf} onChange={setAsOf} />
          </div>
        )}
        {view === 'income' && (
          <>
            <div className="form-group" style={{ margin: 0, minWidth: 160 }}>
              <label>مرکز هزینه</label>
              <select value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)}>
                <option value="">همهٔ شرکت</option>
                {(centres ?? []).filter((c: any) => c.isPostable).map((c: any) => (
                  <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                ))}
              </select>
            </div>
            <label className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={byAccount} onChange={(e) => setByAccount(e.target.checked)} /> تفکیک معین
            </label>
            <label className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> مقایسه با دورهٔ قبل
            </label>
          </>
        )}

        {/* ممیزی ب۱: تا امروز صورت‌های مالی تنها گزارش‌هایی بودند که هیچ راه خروجی نداشتند */}
        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
          {(view === 'balance' || view === 'income' || view === 'cash' || view === 'equity') && <PrintButton />}
          {view === 'balance' && (
            <CsvButton path="/ledger/export/balance-sheet" filename="balance-sheet.csv"
              params={{ asOf: asOf || undefined }} />
          )}
          {view === 'income' && (
            <CsvButton path="/ledger/export/income-statement" filename="income-statement.csv"
              params={isParams} />
          )}
          {view === 'cash' && from && (
            <CsvButton path="/ledger/export/cash-flow" filename="cash-flow.csv"
              params={{ from, to: asOf || undefined }} />
          )}
          {view === 'equity' && (
            <CsvButton path="/ledger/export/equity" filename="equity.csv"
              params={{ from: from || undefined, to: asOf || undefined }} />
          )}
        </span>
      </div>

      {view === 'trial' && <TrialBalanceTab />}
      {view === 'ratios' && <RatiosView from={from} to={asOf} />}
      {view === 'budget' && <BudgetView />}
      {view === 'agingAr' && <AgingView side="receivable" />}
      {view === 'agingAp' && <AgingView side="payable" />}
      {view === 'bankRecon' && <BankReconView />}
      {view === 'tax' && <TaxReportsView />}
      {view === 'provision' && <ProvisionView />}
      {view === 'bookJournal' && <JournalBookView />}
      {view === 'bookGeneral' && <GeneralBookView />}
      {view === 'statement' && <PartyStatementView />}
      {view === 'notes' && <NotesView />}
      {view === 'payrollTax' && <PayrollTaxView />}
      {view === 'equity' && <EquityView from={from} to={asOf} />}

      {view === 'balance' && (bs.isLoading ? <Loading /> : bs.data && (
        <div className="panel panel-pad" style={{ maxWidth: 700 }}>
          <StatementPrintHead title="ترازنامه" asOf={bs.data.asOf ?? new Date()} />
          {/* ممیزی ب۱۲: ستون دورهٔ قبل — صورت مالیِ بدون مقایسه، صورت مالی نیست */}
          <StatementHead
            current={bs.data.asOf ? toShamsi(bs.data.asOf) : 'امروز'}
            prior={bs.data.compareAsOf ? toShamsi(bs.data.compareAsOf) : undefined}
          />
          {(() => {
            const c = bs.data.comparison
            const pri = (n: any) => (c ? String(n.prior ?? '0') : undefined)
            const pt = (k: string) => (c ? String(c.totals[k]) : undefined)
            return (
              <>
                <div className="section-title" style={{ marginTop: 0 }}>دارایی‌ها</div>
                {bs.data.assets.map((n: any) => (
                  <Row key={n.code} label={`${n.code} ${n.name}`} value={n.amount} prior={pri(n)} sub />
                ))}
                <Row label="دارایی‌های جاری" value={bs.data.totals.currentAssets} prior={pt('currentAssets')} divider />
                <Row label="دارایی‌های غیرجاری" value={bs.data.totals.nonCurrentAssets} prior={pt('nonCurrentAssets')} />
                <Row label="جمع دارایی‌ها" value={bs.data.totals.assets} prior={pt('assets')} bold divider />

                <div className="section-title">بدهی‌ها</div>
                {bs.data.liabilities.map((n: any) => (
                  <Row key={n.code} label={`${n.code} ${n.name}`} value={n.amount} prior={pri(n)} sub />
                ))}
                <Row label="بدهی‌های جاری" value={bs.data.totals.currentLiabilities} prior={pt('currentLiabilities')} divider />
                <Row label="بدهی‌های بلندمدت" value={bs.data.totals.longTermLiabilities} prior={pt('longTermLiabilities')} />
                <Row label="جمع بدهی‌ها" value={bs.data.totals.liabilities} prior={pt('liabilities')} bold divider />

                <div className="section-title">حقوق صاحبان سهام</div>
                {bs.data.equity.map((n: any, i: number) => (
                  <Row key={n.code + i} label={`${n.code} ${n.name}`} value={n.amount} prior={pri(n)} sub />
                ))}
                <Row label="جمع حقوق صاحبان سهام" value={bs.data.totals.totalEquity} prior={pt('totalEquity')} bold divider />

                <Row label="جمع بدهی و سرمایه" value={bs.data.totals.totalLiabilitiesAndEquity} prior={pt('totalLiabilitiesAndEquity')} bold divider />
                <Row label="سرمایه در گردش (جاری − جاری)" value={bs.data.totals.workingCapital} prior={pt('workingCapital')} sub />
              </>
            )
          })()}
          <div style={{ marginTop: 12 }}>
            <Alert tint={bs.data.balanced ? 'success' : 'danger'}>
              {bs.data.balanced ? 'معادلهٔ حسابداری برقرار است' : `اختلاف: ${fmt(bs.data.difference)} ریال`}
            </Alert>
          </div>
          <StatementSignatures />
        </div>
      ))}

      {view === 'income' && (is.isLoading ? <Loading /> : is.data && (
        <div className="panel panel-pad" style={{ maxWidth: 620 }}>
          <StatementPrintHead title="صورت سود و زیان" from={from || null} to={asOf || null} />
          <StatementHead
            current={asOf ? `تا ${asOf}` : 'دورهٔ جاری'}
            prior={is.data.comparison ? 'دورهٔ قبل' : undefined}
          />
          {is.data.unallocated && (
            <Alert tint="warning">
              این گزارش فقط ردیف‌های همین مرکز هزینه است. مبالغی که به هیچ مرکزی
              تخصیص نیافته‌اند — عمدتاً درآمد و بهای تمام‌شده — بیرون از این اعداد
              می‌مانند: فروش {fmt(is.data.unallocated.revenue)} · بهای تمام‌شده{' '}
              {fmt(is.data.unallocated.cogs)} · اداری {fmt(is.data.unallocated.admin)} ریال.
            </Alert>
          )}
          <IncomeRows totals={is.data.totals} prior={is.data.comparison?.totals} />
          {byAccount && is.data.accounts?.length > 0 && (
            <>
              <div className="section-title">تفکیک معین</div>
              {is.data.accounts.map((a: any) => (
                <Row key={a.code} label={`${a.code} ${a.name}`} value={a.amount}
                  prior={is.data.comparison?.accounts?.find((c: any) => c.code === a.code)?.amount} sub />
              ))}
            </>
          )}
          <StatementSignatures />
        </div>
      ))}

      {view === 'cash' && (!from ? (
        <Alert tint="info">برای جریان وجوه نقد، تاریخ شروع را انتخاب کنید.</Alert>
      ) : cf.isLoading ? <Loading /> : cf.data && (
        <div className="panel panel-pad" style={{ maxWidth: 560 }}>
          <StatementPrintHead title="صورت جریان وجوه نقد" from={from} to={asOf || null} />
          <Row label="ماندهٔ وجه نقد در ابتدای دوره" value={cf.data.openingCash} sub />
          <Row label="فعالیت‌های عملیاتی" value={cf.data.operating} />
          <Row label="فعالیت‌های سرمایه‌گذاری" value={cf.data.investing} />
          <Row label="فعالیت‌های تأمین مالی" value={cf.data.financing} />
          <Row label="خالص تغییر وجه نقد" value={cf.data.netChange} bold divider />
          <Row label="ماندهٔ وجه نقد در پایان دوره" value={cf.data.closingCash} bold />
          {cf.data.reconciliation !== '0' && (
            <div style={{ marginTop: 12 }}>
              <Alert tint="danger">مغایرتِ تطبیق ابتدا-انتها: {fmt(cf.data.reconciliation)} ریال</Alert>
            </div>
          )}
          <StatementSignatures />
          {cf.data.unclassified !== '0' && (
            <div style={{ marginTop: 12 }}>
              <Alert tint="danger">طبقه‌بندی‌نشده: {fmt(cf.data.unclassified)} ریال</Alert>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function IncomeRows({ totals: t, prior: p }: { totals: any; prior?: any }) {
  const R = (label: string, key: string, opts: { bold?: boolean; divider?: boolean } = {}) => (
    <Row label={label} value={t[key]} prior={p ? p[key] : undefined} {...opts} />
  )
  return (
    <>
      {R('فروش خالص', 'revenue')}
      {R('بهای تمام‌شده', 'cogs')}
      {R('سود ناخالص', 'grossProfit', { bold: true, divider: true })}
      {R('هزینه‌های اداری و عمومی', 'admin')}
      {R('هزینه‌های مالی', 'financial')}
      {R('سود عملیاتی', 'operatingProfit', { bold: true, divider: true })}
      {R('درآمد (هزینهٔ) غیرعملیاتی', 'nonOperating')}
      {R('سود قبل از مالیات', 'profitBeforeTax', { bold: true, divider: true })}
      {R('مالیات بر درآمد', 'taxExpense')}
      {R('سود خالص', 'netProfit', { bold: true, divider: true })}
    </>
  )
}

/**
 * سربرگ ستون‌های یک صورت مالی — واحد **یک بار** اینجا نوشته می‌شود، نه پشت هر
 * عدد (ممیزی ج۶: در ترازنامه کلمهٔ «ریال» ۳۰ بار تکرار می‌شد).
 */
const SHAMSI_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
]

/**
 * بودجه و انحراف (ممیزی ب۲).
 *
 * تا پیش از این، در کل ماژول صفر ارجاع به بودجه بود — یعنی گزارش هزینه فقط
 * تاریخ بود، نه کنترل.
 *
 * **علامت انحراف به ماهیت حساب بند است** و سرور همین را در `favorable`
 * می‌گوید: برای هزینه کمتر خرج کردن مطلوب است، برای درآمد بیشتر فروختن. یک
 * ستون خامِ «عملکرد − بودجه» هر دو را یک‌جور رنگ می‌کرد و خواننده را گمراه.
 */
function BudgetView() {
  const qc = useQueryClient()
  const [fromMonth, setFromMonth] = useState(1)
  /**
   * ⚠️ ممیزی ن۳ — پیش‌فرض «تا ماه» ماهِ جاری است، نه اسفند.
   *
   * با بازهٔ فروردین تا اسفند، بودجهٔ ۱۲ ماه با عملکردِ چند ماه مقایسه می‌شد و
   * انحراف همیشه «مطلوب» درمی‌آمد — تا اسفند که یک‌باره واقعیت آشکار می‌شد.
   */
  const [toMonth, setToMonth] = useState(() => nowJalali().jm)
  const [editing, setEditing] = useState<any | null>(null)
  const [adding, setAdding] = useState(false)

  const variance = useQuery({
    queryKey: ['ledger', 'budgetVariance', fromMonth, toMonth],
    queryFn: async () => (await api.get('/ledger/reports/budget-variance', {
      params: { fromMonth, toMonth },
    })).data,
  })
  const budgets = useQuery({
    queryKey: ['ledger', 'budgets'],
    queryFn: async () => (await api.get('/ledger/budgets')).data,
  })

  const del = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/ledger/budgets/${id}`)).data,
    onSuccess: () => { toast.success('ردیف بودجه حذف شد'); qc.invalidateQueries({ queryKey: ['ledger'] }) },
    onError: (e: any) => dialog.alert({ title: 'ناموفق', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const rows: any[] = variance.data?.rows ?? []
  const t = variance.data?.totals

  return (
    <div>
      <div className="toolbar">
        <div className="form-group" style={{ margin: 0 }}>
          <label>از ماه</label>
          <select value={fromMonth} onChange={(e) => setFromMonth(Number(e.target.value))}>
            {SHAMSI_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>تا ماه</label>
          <select value={toMonth} onChange={(e) => setToMonth(Number(e.target.value))}>
            {SHAMSI_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <button className="btn-secondary btn-sm" onClick={() => { setEditing(null); setAdding(true) }}>
          <Icon name="plus" size={14} /> بودجهٔ حساب
        </button>
        <span style={{ marginInlineStart: 'auto' }}>
          <CsvButton path="/ledger/export/budget-variance" filename="budget-variance.csv"
            params={{ fromMonth, toMonth }} />
        </span>
      </div>

      {variance.isLoading ? <Loading /> : !rows.length ? (
        <EmptyState title="هنوز بودجه‌ای تعریف نشده">
          بدون بودجه، گزارش هزینه فقط می‌گوید چقدر خرج شده — نه اینکه زیاد بوده
          یا کم. برای هر حساب سود و زیانی، بودجهٔ ۱۲ ماه را وارد کنید.
        </EmptyState>
      ) : (
        <>
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>حساب</th><th>مرکز هزینه</th>
                  <th style={{ textAlign: 'left' }}>بودجه</th>
                  <th style={{ textAlign: 'left' }}>عملکرد</th>
                  <th style={{ textAlign: 'left' }}>انحراف</th>
                  <th style={{ textAlign: 'left' }}>انحراف٪</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const tone = r.favorable ? 'var(--success)' : 'var(--danger)'
                  const budgetRow = (budgets.data?.rows ?? []).find(
                    (b: any) => b.accountCode === r.accountCode && b.costCenterCode === r.costCenterCode,
                  )
                  return (
                    <tr key={`${r.accountCode}-${r.costCenterCode ?? ''}`}>
                      <td><span className="num">{r.accountCode}</span> {r.accountName}</td>
                      <td className="hint-sm">{r.costCenterName ?? '—'}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(r.budget)}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(r.actual)}</td>
                      <td className="num" style={{ textAlign: 'left', color: tone, fontWeight: 700 }}>
                        {fmt(r.variance)}
                      </td>
                      <td className="num" style={{ textAlign: 'left', color: tone }}>
                        {r.variancePct === null ? '—'
                          : `${(Number(r.variancePct) * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}٪`}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {budgetRow && (
                          <>
                            <button className="btn-secondary btn-sm"
                              onClick={() => { setAdding(false); setEditing(budgetRow) }}>ویرایش</button>
                            <button className="icon-btn" title="حذف بودجه"
                              onClick={async () => {
                                if (await dialog.confirm({
                                  title: 'حذف بودجه',
                                  message: `بودجهٔ «${r.accountCode} ${r.accountName}» حذف شود؟`,
                                  tone: 'danger', confirmLabel: 'حذف',
                                })) del.mutate(budgetRow.id)
                              }}>
                              <Icon name="trash" size={14} />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              {t && (
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800 }}>
                    <td colSpan={2}>جمع</td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt(t.budget)}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt(t.actual)}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt(t.variance)}</td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            رنگ انحراف به <strong>ماهیت حساب</strong> بند است: برای هزینه، کمتر از
            بودجه سبز است؛ برای درآمد، بیشتر از بودجه. سند اختتامیه در عملکرد
            شمرده نمی‌شود.
          </p>
        </>
      )}

      {(adding || editing) && (
        <BudgetFormModal budget={editing} onClose={() => { setAdding(false); setEditing(null) }} />
      )}
    </div>
  )
}

/** فرم بودجهٔ یک حساب — دوازده ستون ماهانه با ابزار «پخش یکنواخت» */
function BudgetFormModal({ budget, onClose }: { budget: any | null; onClose: () => void }) {
  const qc = useQueryClient()
  const editing = !!budget
  const [accountCode, setAccountCode] = useState(budget?.accountCode ?? '')
  const [costCenterCode, setCostCenterCode] = useState(budget?.costCenterCode ?? '')
  const [months, setMonths] = useState<string[]>(budget?.months ?? Array(12).fill('0'))
  const [annual, setAnnual] = useState('')

  const { data: accounts } = useQuery({
    queryKey: ['ledger', 'accounts'],
    queryFn: async () => (await api.get('/ledger/accounts')).data,
  })
  const { data: centres } = useQuery({
    queryKey: ['ledger', 'cost-centers'],
    queryFn: async () => (await api.get('/ledger/cost-centers')).data as any[],
  })

  // فقط حساب‌های برگِ سود و زیانی (گروه ۴ تا ۸) بودجه می‌گیرند
  const pnlAccounts = (accounts?.accounts ?? []).filter(
    (a: any) => a.isPostable && ['4', '5', '6', '7', '8'].includes(a.code[0]),
  )

  const total = months.reduce((s, m) => s + BigInt(m || '0'), 0n)

  const spread = () => {
    if (!annual) return
    const per = BigInt(annual) / 12n
    const rest = BigInt(annual) - per * 12n
    // باقی‌مانده به ماه آخر می‌رود تا جمع دقیقاً همان عدد سالانه بماند
    setMonths(Array.from({ length: 12 }, (_, i) => (i === 11 ? per + rest : per).toString()))
  }

  const save = useMutation({
    mutationFn: async () => (await api.post('/ledger/budgets', {
      accountCode, costCenterCode: costCenterCode || null, months,
    })).data,
    onSuccess: () => {
      toast.success('بودجه ثبت شد')
      qc.invalidateQueries({ queryKey: ['ledger'] })
      onClose()
    },
    onError: (e: any) => dialog.alert({ title: 'ناموفق', message: e?.response?.data?.message, tone: 'danger' }),
  })

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>{editing ? `بودجهٔ ${budget.accountCode} ${budget.accountName}` : 'بودجهٔ حساب'}</h2>
            <button onClick={onClose} aria-label="بستن">✕</button>
          </div>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {!editing && (
              <div className="grid-2">
                <div className="form-group" style={{ margin: 0 }}>
                  <label>حساب (سود و زیانی)</label>
                  <select value={accountCode} onChange={(e) => setAccountCode(e.target.value)}>
                    <option value="">— انتخاب کنید —</option>
                    {pnlAccounts.map((a: any) => (
                      <option key={a.id} value={a.code}>{a.code} · {a.name}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label>مرکز هزینه (اختیاری)</label>
                  <select value={costCenterCode} onChange={(e) => setCostCenterCode(e.target.value)}>
                    <option value="">کلِ حساب</option>
                    {(centres ?? []).filter((c) => c.isPostable).map((c) => (
                      <option key={c.id} value={c.code}>{c.code} · {c.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            <div className="toolbar" style={{ margin: 0 }}>
              <div className="form-group" style={{ margin: 0, flex: 1 }}>
                <label>بودجهٔ سالانه (ریال) — برای پخش یکنواخت</label>
                <input value={annual} onChange={(e) => setAnnual(e.target.value.replace(/\D/g, ''))}
                  placeholder="مثلاً ۱۲۰۰۰۰۰۰۰۰" />
              </div>
              <button className="btn-secondary btn-sm" onClick={spread} disabled={!annual}>
                پخش روی ۱۲ ماه
              </button>
            </div>

            <div className="table-container" style={{ maxHeight: 300, overflow: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>ماه</th><th style={{ textAlign: 'left' }}>بودجه (ریال)</th></tr></thead>
                <tbody>
                  {SHAMSI_MONTHS.map((m, i) => (
                    <tr key={m}>
                      <td>{m}</td>
                      <td style={{ textAlign: 'left' }}>
                        <input className="num" style={{ width: 160, textAlign: 'left' }}
                          value={months[i]}
                          onChange={(e) => {
                            const v = e.target.value.replace(/\D/g, '') || '0'
                            setMonths((ms) => ms.map((x, idx) => (idx === i ? v : x)))
                          }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 800, borderTop: '2px solid var(--border-strong)' }}>
                    <td>جمع سال</td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt(total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="hint-sm" style={{ margin: 0 }}>
              بودجه ماهانه نگه داشته می‌شود چون اجاره یکنواخت است ولی بازاریابی و
              عیدی نیستند — با یک عدد سالانه، انحرافِ فروردین همیشه مثبت درمی‌آمد.
            </p>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={onClose}>انصراف</button>
            <button className="btn-primary" disabled={!accountCode || save.isPending}
              onClick={() => save.mutate()}>
              {save.isPending ? 'در حال ذخیره…' : 'ذخیره'}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}

/**
 * نسبت‌های مالی (ممیزی ب۱۱).
 *
 * سرور نسبت‌ها را با چهار رقم اعشار به‌صورت **رشته** می‌دهد (محاسبه روی عدد
 * صحیح انجام شده، نه شناور) و اینجا فقط برای خواندن گِرد می‌شوند.
 *
 * `null` یعنی «قابل محاسبه نیست» چون مخرج صفر است — نه صفر. تفاوتش را صریح
 * نشان می‌دهیم: نسبت جاریِ صفر یعنی فاجعه، نسبت جاریِ محاسبه‌نشده یعنی هنوز
 * بدهی جاری‌ای وجود ندارد.
 */
function RatiosView({ from, to }: { from: string; to: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'ratios', from, to],
    queryFn: async () => (await api.get('/ledger/reports/ratios', {
      params: { from: from || undefined, to: to || undefined },
    })).data,
  })

  if (isLoading) return <Loading />
  if (!data) return null

  /** «۲.۸۳» یا «—» · نسبت را با دو رقم نشان می‌دهد */
  const num = (v: string | null, digits = 2) =>
    v === null ? '—' : Number(v).toLocaleString('en-US', {
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    })
  const pct = (v: string | null) =>
    v === null ? '—' : `${(Number(v) * 100).toLocaleString('en-US', { maximumFractionDigits: 1 })}٪`

  const GROUPS: { title: string; rows: { label: string; value: string; hint: string; tone?: string }[] }[] = [
    {
      title: 'نقدینگی',
      rows: [
        { label: 'نسبت جاری', value: num(data.liquidity.currentRatio),
          hint: 'دارایی جاری ÷ بدهی جاری — زیر ۱ یعنی بدهی کوتاه‌مدت از دارایی نقدشونده بیشتر است',
          tone: data.liquidity.currentRatio === null ? undefined
            : Number(data.liquidity.currentRatio) < 1 ? 'var(--danger)' : 'var(--success)' },
        { label: 'نسبت آنی', value: num(data.liquidity.quickRatio),
          /*
            سه حالت، چون «برابر بودنِ نسبت آنی با نسبت جاری» سه معنیِ متفاوت دارد:
              • حساب ۱۱۰۶ غیرفعال است  ⇒ شرکت خدماتی است؛ تساوی درست است، هشدار غلط
              • فعال است و سند دارد     ⇒ نسبت واقعی است
              • فعال است و سند ندارد    ⇒ کالا داریم ولی ثبتش نمی‌کنیم؛ عدد گمراه‌کننده
            عدد در هیچ حالتی دستکاری نمی‌شود؛ فقط گفته می‌شود از کجا آمده.
          */
          hint: !data.inventory.applicable
            ? 'برای شرکت خدماتی برابرِ نسبت جاری است — موجودی کالا (۱۱۰۶) در چارت غیرفعال است'
            : data.inventory.posted
              ? '(دارایی جاری − موجودی کالا) ÷ بدهی جاری'
              : '(دارایی جاری − موجودی کالا) ÷ بدهی جاری — ⚠️ حساب موجودی کالا (۱۱۰۶) فعال است ولی هیچ سندی نمی‌گیرد، پس این نسبت نقدشوندگی را بیش از واقع نشان می‌دهد',
          tone: data.inventory.applicable && !data.inventory.posted ? 'var(--warning)' : undefined },
        { label: 'سرمایه در گردش', value: fmt(data.liquidity.workingCapital),
          hint: 'دارایی جاری − بدهی جاری (ریال)',
          tone: signColor(data.liquidity.workingCapital) },
      ],
    },
    {
      title: 'فعالیت',
      rows: [
        { label: 'گردش مطالبات', value: num(data.activity.receivableTurnover),
          hint: 'فروش ÷ ماندهٔ حساب‌های دریافتنی — چند بار در دوره وصول شده' },
        { label: 'دورهٔ وصول مطالبات', value: `${num(data.activity.daysSalesOutstanding, 0)} روز`,
          hint: '۳۶۵ ÷ گردش مطالبات — طلب به‌طور متوسط چند روز باز می‌ماند' },
        { label: 'گردش بدهی‌ها', value: num(data.activity.payableTurnover),
          hint: 'بهای تمام‌شده ÷ ماندهٔ حساب‌های پرداختنی' },
        { label: 'دورهٔ پرداخت بدهی', value: `${num(data.activity.daysPayableOutstanding, 0)} روز`,
          hint: '۳۶۵ ÷ گردش بدهی‌ها' },
      ],
    },
    {
      title: 'سودآوری',
      rows: [
        { label: 'حاشیهٔ سود ناخالص', value: pct(data.profitability.grossMargin),
          hint: 'سود ناخالص ÷ فروش' },
        { label: 'حاشیهٔ سود عملیاتی', value: pct(data.profitability.operatingMargin),
          hint: 'سود عملیاتی ÷ فروش' },
        { label: 'حاشیهٔ سود خالص', value: pct(data.profitability.netMargin),
          hint: 'سود خالص ÷ فروش' },
        { label: 'بازده حقوق صاحبان سهام', value: pct(data.profitability.returnOnEquity),
          hint: 'سود خالص ÷ حقوق صاحبان سهام' },
      ],
    },
    {
      title: 'اهرم',
      rows: [
        { label: 'بدهی به حقوق صاحبان سهام', value: num(data.leverage.debtToEquity),
          hint: 'جمع بدهی ÷ جمع حقوق صاحبان سهام' },
        { label: 'بدهی به دارایی', value: pct(data.leverage.debtToAssets),
          hint: 'جمع بدهی ÷ جمع دارایی — چند درصد دارایی از محل بدهی تأمین شده' },
      ],
    },
  ]

  return (
    <div>
      {!from && (
        <Alert tint="info">
          نسبت‌های فعالیت و سودآوری به بازهٔ زمانی وابسته‌اند. برای عدد درست،
          تاریخ شروع دوره را انتخاب کنید.
        </Alert>
      )}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        {GROUPS.map((g) => (
          <div key={g.title} className="panel">
            <div className="panel-hd"><h3>{g.title}</h3></div>
            <div className="table-container" style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}>
              <table className="data-table">
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.label}>
                      <td>
                        {r.label}
                        <div className="hint-sm" style={{ marginTop: 2 }}>{r.hint}</div>
                      </td>
                      <td className="num" style={{
                        textAlign: 'left', fontWeight: 700, fontSize: 16,
                        whiteSpace: 'nowrap', color: r.tone,
                      }}>{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 12 }}>
        «—» یعنی نسبت قابل محاسبه نیست چون مخرجش صفر است — نه اینکه نسبت صفر
        باشد. گردش‌ها بر پایهٔ ماندهٔ <strong>پایان دوره</strong> حساب می‌شوند،
        نه ماندهٔ متوسط.
      </p>
    </div>
  )
}

function StatementHead({ current, prior }: { current: string; prior?: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 16,
      padding: '0 0 8px', borderBottom: '2px solid var(--border-strong)',
      marginBottom: 6, fontSize: 12, color: 'var(--text-muted)', fontWeight: 700,
    }}>
      <span>مبالغ به ریال</span>
      <span style={{ display: 'flex', gap: 18, alignItems: 'baseline' }}>
        {prior && <span style={{ minWidth: 110, textAlign: 'left' }}>{prior}</span>}
        <span style={{ minWidth: 110, textAlign: 'left' }}>{current}</span>
      </span>
    </div>
  )
}

function Row({ label, value, prior, bold, divider, sub }: { label: string; value: string; prior?: string; bold?: boolean; divider?: boolean; sub?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 16, padding: sub ? '3px 0' : '7px 0',
      fontWeight: bold ? 800 : 400,
      fontSize: sub ? 13 : undefined,
      color: sub ? 'var(--text-muted)' : undefined,
      paddingInlineStart: sub ? 14 : undefined,
      borderTop: divider ? '1px solid var(--border)' : undefined,
      marginTop: divider ? 4 : undefined,
    }}>
      <span>{label}</span>
      <span style={{ display: 'flex', gap: 18, alignItems: 'baseline' }}>
        {prior !== undefined && (
          <span className="num hint-sm" style={{ minWidth: 110, textAlign: 'left' }}>{fmt(prior)}</span>
        )}
        <span className="num" style={{ color: sub ? 'inherit' : signColor(value), minWidth: 110, textAlign: 'left' }}>
          {fmt(value)}
        </span>
      </span>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
function BankReconView() {
  const [code, setCode] = useState('')
  const [asOf, setAsOf] = useState('')
  const [stmt, setStmt] = useState('')
  const [adjustments, setAdjustments] = useState<{ amount: string; note: string }[]>([])

  const { data: accounts } = useQuery({
    queryKey: ['ledger', 'accounts'],
    queryFn: async () => (await api.get('/ledger/accounts')).data as { accounts: any[] },
  })
  const banks = (accounts?.accounts ?? []).filter((a: any) => a.isPostable && a.code.startsWith('1101'))

  const adjParam = JSON.stringify(
    adjustments.filter((a) => a.amount).map((a) => ({ amount: a.amount, note: a.note })),
  )
  const { data, isFetching } = useQuery({
    queryKey: ['ledger', 'bankRecon', code, asOf, stmt, adjParam],
    queryFn: async () => (await api.get(`/ledger/reports/bank-reconciliation/${code}`, {
      params: {
        asOf: asOf || undefined,
        statementBalance: stmt || undefined,
        adjustments: adjustments.some((a) => a.amount) ? adjParam : undefined,
      },
    })).data,
    enabled: !!code,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="toolbar" style={{ margin: 0, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ margin: 0 }}>
          <label>حساب بانکی</label>
          <select value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">— انتخاب</option>
            {banks.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ margin: 0 }}><label>تا تاریخ</label><DateField value={asOf} onChange={setAsOf} /></div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>ماندهٔ صورتحساب بانک (ریال)</label>
          <input className="num" style={{ width: 160 }} inputMode="numeric" value={stmt}
            onChange={(e) => setStmt(e.target.value)} placeholder="از برگهٔ بانک" />
        </div>
      </div>

      {!code ? (
        <Alert tint="info">یک حساب بانکی انتخاب کنید. صورت مغایرت، ماندهٔ دفتر را با ماندهٔ برگهٔ بانک تطبیق می‌دهد.</Alert>
      ) : !data ? <Loading /> : (
        <>
          <div className="panel panel-pad" style={{ maxWidth: 520 }}>
            <Row label="ماندهٔ دفتر شرکت" value={data.bookBalance} />
            {data.adjustments.map((a: any, i: number) => (
              <Row key={i} label={a.note || 'قلم مغایرت'} value={a.amount} sub />
            ))}
            {data.adjustments.length > 0 && <Row label="ماندهٔ دفترِ تعدیل‌شده" value={data.adjustedBook} bold divider />}
            <Row label="ماندهٔ صورتحساب بانک" value={data.statementBalance ?? '—'} />
            <Row label="مغایرت" value={data.difference ?? '—'} bold divider />
            {data.difference != null && (
              <div style={{ marginTop: 10 }}>
                <Alert tint={data.reconciled ? 'success' : 'warning'}>
                  {data.reconciled ? 'تطبیق شد — مغایرتی نیست' : `هنوز ${fmt(data.difference)} ریال مغایرت هست — اقلام زیر را بررسی کنید`}
                </Alert>
              </div>
            )}
          </div>

          <div className="panel panel-pad">
            <div className="row-between">
              <div className="section-title" style={{ margin: 0 }}>اقلام مغایرت</div>
              <button className="btn-secondary btn-sm" onClick={() => setAdjustments([...adjustments, { amount: '', note: '' }])}>
                <Icon name="plus" size={14} /> افزودن قلم
              </button>
            </div>
            <p className="hint-sm" style={{ marginTop: 4 }}>
              مثبت = بانک نشان می‌دهد ولی دفتر نه (واریزیِ در راه). منفی = دفتر دارد ولی بانک هنوز نه (چکِ نقدنشده، کارمزد).
              اگر قلمی واقعی است (کارمزد)، سندش را جدا با «ثبت هزینه» بزنید.
            </p>
            {adjustments.map((a, i) => (
              <div key={i} className="toolbar" style={{ margin: '6px 0 0', alignItems: 'flex-end' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label>مبلغ (± ریال)</label>
                  <input className="num" style={{ width: 140 }} value={a.amount}
                    onChange={(e) => setAdjustments(adjustments.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
                </div>
                <div className="form-group grow" style={{ margin: 0 }}>
                  <label>شرح</label>
                  <input value={a.note}
                    onChange={(e) => setAdjustments(adjustments.map((x, j) => j === i ? { ...x, note: e.target.value } : x))} />
                </div>
                <button className="icon-btn danger" aria-label="حذف" onClick={() => setAdjustments(adjustments.filter((_, j) => j !== i))}><Icon name="trash" /></button>
              </div>
            ))}
          </div>

          {data.unpresentedChequesGuess?.length > 0 && (
            <div className="panel panel-pad">
              <div className="section-title" style={{ marginTop: 0 }}>چک‌های صادرشدهٔ نقدنشده <span className="hint-sm">(حدس — بر پایهٔ وضعیت چک)</span></div>
              <div className="table-container">
                <table className="data-table">
                  <thead><tr><th>شماره</th><th>بانک</th><th>در وجه</th><th>سررسید</th><th style={{ textAlign: 'left' }}>مبلغ</th></tr></thead>
                  <tbody>
                    {data.unpresentedChequesGuess.map((c: any, i: number) => (
                      <tr key={i}>
                        <td className="num">{c.number}</td><td>{c.bankName}</td><td>{c.party ?? '—'}</td>
                        <td className="hint-sm">{c.dueDate ? new Date(c.dueDate).toLocaleDateString('fa-IR') : '—'}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{fmt(c.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="panel panel-pad">
            <div className="section-title" style={{ marginTop: 0 }}>گردش حساب (۴۵ روز اخیر){isFetching ? ' …' : ''}</div>
            <div className="table-container">
              <table className="data-table">
                <thead><tr><th>تاریخ</th><th>سند</th><th>شرح</th><th style={{ textAlign: 'left' }}>بدهکار</th><th style={{ textAlign: 'left' }}>بستانکار</th></tr></thead>
                <tbody>
                  {data.movements.map((m: any, i: number) => (
                    <tr key={i}>
                      <td className="hint-sm">{new Date(m.date).toLocaleDateString('fa-IR')}</td>
                      <td className="num">{m.serial ? `#${m.serial}` : '—'}</td>
                      <td className="hint-sm">{m.description}{m.memo ? ` — ${m.memo}` : ''}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{m.debit > 0 ? fmt(m.debit) : ''}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{m.credit > 0 ? fmt(m.credit) : ''}</td>
                    </tr>
                  ))}
                  {!data.movements.length && <TableEmpty colSpan={5}>گردشی در این بازه نیست</TableEmpty>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * گزارش‌ها در پنج خانواده — مرحلهٔ ۵ الف.
 *
 * تا ۹ گزارش، نوار زیرتب کار می‌کرد. با ۱۵ گزارش دیگر نه: در یک ردیف جا
 * نمی‌شود، و مهم‌تر اینکه «ترازنامه» و «دفتر روزنامهٔ قانونی» را کنار هم
 * می‌گذارد انگار هم‌جنس‌اند. یکی صورت مالی است و دیگری سندِ ممیزی.
 *
 * دراپ‌داونِ گروه‌بندی‌شده هر دو مشکل را حل می‌کند و همان الگویی است که
 * فهرست‌های دیگر سامانه دارند.
 */
const REPORT_GROUPS = [
  {
    label: 'صورت‌های مالی',
    items: [
      ['balance', 'ترازنامه'], ['income', 'صورت سود و زیان'],
      ['cash', 'صورت جریان وجوه نقد'], ['equity', 'صورت تغییرات حقوق صاحبان سهام'],
      ['notes', 'یادداشت‌های همراه'],
    ],
  },
  {
    label: 'تحلیل و کنترل',
    items: [
      ['trial', 'تراز آزمایشی'], ['ratios', 'نسبت‌های مالی'],
      ['budget', 'بودجه و انحراف'],
    ],
  },
  {
    label: 'طرف‌حساب‌ها',
    items: [
      ['agingAr', 'سن‌بندی مطالبات'], ['agingAp', 'سن‌بندی بدهی‌ها'],
      // «ذخیرهٔ مطالبات» به تب «پایان دوره» رفت — سند می‌زند، پس کنش است نه گزارش
      ['statement', 'صورتحساب طرف‌حساب'],
    ],
  },
  {
    label: 'مالیاتی و بانکی',
    items: [
      ['tax', 'ماده ۱۶۹ و ارزش افزوده'], ['payrollTax', 'فهرست مالیات حقوق'],
      ['bankRecon', 'مغایرت بانکی'],
    ],
  },
  {
    label: 'دفاتر قانونی',
    items: [
      ['bookJournal', 'دفتر روزنامه'], ['bookGeneral', 'دفتر کل'],
    ],
  },
] as const

// ═══════════════════════════════════════════════════════════════
// ذخیرهٔ مطالبات مشکوک‌الوصول — مرحلهٔ ۴ د
// ═══════════════════════════════════════════════════════════════

/**
 * سن‌بندی می‌گفت «۹۰ میلیارد بیش از ۹۰ روز معوق است» و همان‌جا تمام می‌شد.
 * اینجا آن عدد به یک رقمِ حسابداری تبدیل می‌شود.
 *
 * **چرا دکمه «ثبت تفاوت» است و نه «ثبت ذخیره»:** روشِ مانده است — سند فقط
 * تفاوتِ برآورد با ذخیرهٔ موجود را می‌زند. اگر دکمه «ثبت ذخیره» بود، کاربر
 * انتظار داشت هر بار زدنش کلِ مبلغ را هزینه کند، و نزدنش را ریسک بداند.
 */
function ProvisionView() {
  const qc = useQueryClient()
  const [asOf, setAsOf] = useState('')
  const [editRates, setEditRates] = useState(false)
  const [draft, setDraft] = useState<Record<string, string>>({})

  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'provision', asOf],
    queryFn: async () => (await api.get('/ledger/provision', {
      params: { asOf: asOf || undefined },
    })).data,
  })

  const doPost = useMutation({
    mutationFn: async () => (await api.post('/ledger/provision/post', { asOf: asOf || undefined })).data,
    onSuccess: (r: any) => {
      if (r.posted) toast.success(`سند تعدیل ذخیره ثبت شد (#${r.entry.serial})`)
      else toast.info(r.reason)
      qc.invalidateQueries({ queryKey: ['ledger'] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? 'ثبت ناموفق بود'),
  })

  const saveRates = useMutation({
    mutationFn: async () => (await api.put('/ledger/provision/rates',
      Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)])))).data,
    onSuccess: () => {
      toast.success('درصدها ذخیره شد'); setEditRates(false)
      qc.invalidateQueries({ queryKey: ['ledger'] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? 'ذخیره ناموفق بود'),
  })

  if (isLoading) return <Loading />
  if (!data) return null

  const delta = BigInt(data.delta)
  const startEdit = () => {
    setDraft(Object.fromEntries(data.lines.map((l: any) => [l.bucket, String(l.rate)])))
    setEditRates(true)
  }

  return (
    <div>
      <div className="toolbar">
        <div className="form-group" style={{ margin: 0 }}>
          <label>در تاریخ</label><DateField value={asOf} onChange={setAsOf} />
        </div>
        {!editRates && (
          <button className="btn-secondary btn-sm" style={{ alignSelf: 'flex-end' }}
            onClick={startEdit}>ویرایش درصدها</button>
        )}
        <span style={{ marginInlineStart: 'auto' }}>
          <button className="btn-primary btn-sm" disabled={doPost.isPending || delta === 0n}
            onClick={() => doPost.mutate()}>
            {delta === 0n ? 'تفاوتی نیست' : delta > 0n ? 'ثبت تفاوت (افزایش ذخیره)' : 'ثبت تفاوت (برگشت ذخیره)'}
          </button>
        </span>
      </div>

      <div className="grid-4" style={{ marginBottom: 16 }}>
        <div className="kpi-card" style={{ padding: 14 }}>
          <div className="kpi-value num" style={{ fontSize: 18 }}>{fmt(data.receivableTotal)}</div>
          <div className="kpi-label">کل مطالبات باز</div>
        </div>
        <div className="kpi-card" style={{ padding: 14 }}>
          <div className="kpi-value num" style={{ fontSize: 18, color: 'var(--warning)' }}>{fmt(data.required)}</div>
          <div className="kpi-label">ذخیرهٔ مطلوب</div>
        </div>
        <div className="kpi-card" style={{ padding: 14 }}>
          <div className="kpi-value num" style={{ fontSize: 18 }}>{fmt(data.existing)}</div>
          <div className="kpi-label">ذخیرهٔ ثبت‌شدهٔ فعلی</div>
        </div>
        <div className="kpi-card" style={{ padding: 14 }}>
          <div className="kpi-value num" style={{ fontSize: 18, color: signColor(data.delta) }}>{fmt(data.delta)}</div>
          <div className="kpi-label">
            {delta > 0n ? 'کسریِ ذخیره — باید هزینه شود' : delta < 0n ? 'مازادِ ذخیره — برمی‌گردد' : 'ذخیره به‌روز است'}
          </div>
        </div>
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>سطل سنی</th>
              <th style={{ textAlign: 'left' }}>ماندهٔ باز</th>
              <th style={{ textAlign: 'left' }}>درصد</th>
              <th style={{ textAlign: 'left' }}>ذخیرهٔ مطلوب</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l: any) => (
              <tr key={l.bucket}>
                <td>{l.label}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(l.balance)}</td>
                <td className="num" style={{ textAlign: 'left' }}>
                  {editRates ? (
                    <input className="num" inputMode="numeric" style={{ width: 80 }}
                      value={draft[l.bucket] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [l.bucket]: e.target.value }))} />
                  ) : `${(l.rate / 10).toFixed(1)}٪`}
                </td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(l.required)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800 }}>
              <td>جمع</td>
              <td className="num" style={{ textAlign: 'left' }}>{fmt(data.receivableTotal)}</td>
              <td className="num" style={{ textAlign: 'left' }}>
                {data.coverageRate == null ? '—' : `${(data.coverageRate / 10).toFixed(1)}٪`}
              </td>
              <td className="num" style={{ textAlign: 'left' }}>{fmt(data.required)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {editRates && (
        <div className="toolbar" style={{ marginTop: 10 }}>
          <span className="hint-sm">درصدها به هزارم‌اند: ۵۰ یعنی ۵٪، ۱۰۰۰ یعنی ۱۰۰٪.</span>
          <button className="btn-primary btn-sm" disabled={saveRates.isPending}
            onClick={() => saveRates.mutate()}>ذخیره</button>
          <button className="btn-secondary btn-sm" onClick={() => setEditRates(false)}>انصراف</button>
        </div>
      )}

      <p className="hint" style={{ marginTop: 12 }}>
        ذخیره روی حساب <span className="num">۱۱۱۰</span> می‌نشیند، نه روی خودِ دریافتنی —
        طلبِ حقوقی شما از مشتری عوض نمی‌شود و پیگیریِ وصولش سرِ جایش می‌ماند.
        سند فقط <strong>تفاوت</strong> برآورد با ذخیرهٔ موجود را می‌زند، پس اجرای دوباره
        در یک ماه چیزی را دو برابر نمی‌کند.
      </p>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// صورت تغییرات حقوق صاحبان سهام — مرحلهٔ ۴ ب
// ═══════════════════════════════════════════════════════════════

/**
 * ماتریس است نه فهرست: ستون‌ها حساب‌های حقوق صاحبان سهام و سطرها حرکت‌ها.
 *
 * سطر «سود (زیان) خالص دوره» فقط وقتی جدا می‌آید که هنوز با سند اختتامیه
 * منتقل نشده باشد — وگرنه در گردشِ سود انباشته شمرده شده و دو بار می‌آمد.
 * همان تله‌ای که بک‌اند هم برایش تست دارد.
 */
function EquityView({ from, to }: { from: string; to: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'equity', from, to],
    queryFn: async () => (await api.get('/ledger/reports/equity', {
      params: { from: from || undefined, to: to || undefined },
    })).data,
  })
  if (isLoading) return <Loading />
  if (!data) return null

  const cols = data.columns as any[]
  const cell = (v: string) => (
    <td className="num" style={{ textAlign: 'left', color: signColor(v) }}>
      {v === '0' ? '—' : fmt(v)}
    </td>
  )
  const rowTotal = (get: (code: string) => string) =>
    cols.reduce((s: bigint, c: any) => s + BigInt(get(c.code) || '0'), 0n).toString()

  const Row = ({ label, get, strong }: { label: any; get: (code: string) => string; strong?: boolean }) => (
    <tr style={strong ? { fontWeight: 800, borderTop: '2px solid var(--border-strong)' } : undefined}>
      <td>{label}</td>
      {cols.map((c: any) => <Fragment key={c.code}>{cell(get(c.code))}</Fragment>)}
      {cell(rowTotal(get))}
    </tr>
  )

  return (
    <div className="panel panel-pad">
      <StatementPrintHead
        title="صورت تغییرات حقوق صاحبان سهام"
        from={data.from} to={data.to}
        note={data.profitPosted
          ? 'سود دوره با سند اختتامیه به سود و زیان انباشته منتقل شده است.'
          : undefined}
      />

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>شرح</th>
              {cols.map((c: any) => (
                <th key={c.code} style={{ textAlign: 'left' }}>
                  {c.name} <span className="hint-sm num">({c.code})</span>
                </th>
              ))}
              <th style={{ textAlign: 'left' }}>جمع</th>
            </tr>
          </thead>
          <tbody>
            <Row label="ماندهٔ ابتدای دوره"
              get={(code) => cols.find((c: any) => c.code === code)!.opening} />

            {data.movements.map((m: any, i: number) => (
              <Row key={i}
                label={<>
                  {m.serial ? <span className="num hint-sm">#{m.serial} </span> : null}
                  {m.description}
                  <span className="hint-sm"> · {toShamsi(m.date)}</span>
                </>}
                get={(code) => m.byAccount[code] ?? '0'} />
            ))}

            {/* ⚠️ فقط وقتی هنوز منتقل نشده — وگرنه دو بار شمرده می‌شود */}
            {!data.profitPosted && (
              <Row label={<strong>سود (زیان) خالص دوره</strong>}
                get={(code) => (code === '3102' ? data.profit : '0')} />
            )}

            <Row strong label="ماندهٔ پایان دوره"
              get={(code) => cols.find((c: any) => c.code === code)!.closingEconomic} />
          </tbody>
        </table>
      </div>

      {data.profitPosted ? (
        <p className="hint" style={{ marginTop: 10 }}>
          سال مالی بسته شده و سود دوره با سند اختتامیه به «سود و زیان انباشته» منتقل
          شده است، پس سطر جداگانه‌ای برایش نمی‌آید.
        </p>
      ) : data.profit !== '0' && (
        <p className="hint" style={{ marginTop: 10 }}>
          سود دوره هنوز با سند اختتامیه به «سود و زیان انباشته» منتقل نشده است.
          ماندهٔ دفتریِ آن حساب <span className="num">{fmt(cols.find((c: any) => c.code === '3102')?.closingPosted ?? '0')}</span> است،
          ولی صورت مالی سودِ دوره را هم در حقوق صاحبان سهام می‌آورد.
        </p>
      )}

      <StatementSignatures />
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// گزارش‌های قانونی — مرحلهٔ ۴
// ═══════════════════════════════════════════════════════════════

const PERSON_TYPE_FA: Record<string, string> = {
  LEGAL: 'شخص حقوقی', NATURAL: 'شخص حقیقی',
  PARTNERSHIP: 'مشارکت مدنی', FOREIGN: 'اتباع خارجی',
  CONSUMER: 'مصرف‌کنندهٔ نهایی',
}

const QUARTERS = [
  { key: 1, label: 'بهار (فروردین–خرداد)' },
  { key: 2, label: 'تابستان (تیر–شهریور)' },
  { key: 3, label: 'پاییز (مهر–آذر)' },
  { key: 4, label: 'زمستان (دی–اسفند)' },
]

/** فصلی که امروز داخلش است — پیش‌فرضِ منطقی برای گزارش فصلی */
const currentQuarter = () => {
  const m = nowJalali().jm
  return Math.min(4, Math.ceil(m / 3))
}

/**
 * ماده ۱۶۹ و اظهارنامهٔ ارزش افزوده در یک صفحه.
 *
 * چرا کنار هم و نه دو زیرتب: هر دو یک بازه دارند و حسابدار هر دو را در یک
 * نشست پر می‌کند. جدا کردنشان یعنی دو بار انتخاب فصل.
 *
 * و چرا «آمادگی ارسال» بالاتر از خودِ جدول است: گزارشی که شناسهٔ ملیِ نصف
 * طرف‌حساب‌ها را ندارد قابل ارسال نیست، و این را باید پیش از خواندن اعداد
 * فهمید نه بعدش.
 */
function TaxReportsView() {
  const [quarter, setQuarter] = useState(currentQuarter())
  const params = { quarter }

  const a169 = useQuery({
    queryKey: ['ledger', 'a169', quarter],
    queryFn: async () => (await api.get('/ledger/reports/article-169', { params })).data,
  })
  const vat = useQuery({
    queryKey: ['ledger', 'vat', quarter],
    queryFn: async () => (await api.get('/ledger/reports/vat-return', { params })).data,
  })

  const d = a169.data
  const v = vat.data

  return (
    <div>
      <div className="toolbar">
        <div className="form-group" style={{ margin: 0, minWidth: 210 }}>
          <label>فصل</label>
          <select value={quarter} onChange={(e) => setQuarter(Number(e.target.value))}>
            {QUARTERS.map((q) => <option key={q.key} value={q.key}>{q.label}</option>)}
          </select>
        </div>
        {d?.label && <span className="hint-sm">{d.label}</span>}
        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
          <CsvButton path="/ledger/export/article-169" filename={`article-169-q${quarter}.csv`}
            params={params} label="خروجی ماده ۱۶۹" />
          <CsvButton path="/ledger/export/vat-return" filename={`vat-q${quarter}.csv`}
            params={params} label="خروجی ارزش افزوده" />
        </span>
      </div>

      {/* ── اظهارنامهٔ ارزش افزوده ── */}
      <section className="panel" style={{ marginBottom: 16 }}>
        <div className="section-title">اظهارنامهٔ ارزش افزوده</div>
        {vat.isLoading ? <Loading /> : v && (
          <div className="grid-4">
            <VatCard label="فروشِ مشمول" value={v.taxableSales} />
            <VatCard label="مالیات و عوارض فروش" value={v.outputVat} tone="var(--danger)" />
            <VatCard label="اعتبار مالیاتی خرید" value={v.inputVat} tone="var(--success)" />
            <div className="kpi-card" style={{ padding: 14 }}>
              <div className="kpi-value num" style={{
                fontSize: 18,
                color: v.position === 'PAYABLE' ? 'var(--danger)' : v.position === 'CREDIT' ? 'var(--success)' : 'var(--text-muted)',
              }}>{fmt(v.amount)}</div>
              <div className="kpi-label">
                {v.position === 'PAYABLE' ? 'بدهی به سازمان امور مالیاتی'
                  : v.position === 'CREDIT' ? 'اعتبارِ قابل انتقال به دورهٔ بعد'
                    : 'بدون بدهی و اعتبار'}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── آمادگی ارسال، پیش از اعداد ── */}
      {d && (d.notReady > 0 || d.unattributed.length > 0) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {d.notReady > 0 && (
            <Alert tint="warning">
              <strong>{d.notReady}</strong> طرف‌حساب هویت مالیاتیِ کامل ندارد و گزارش با آن‌ها
              پذیرفته نمی‌شود. ستون «وضعیت» می‌گوید هرکدام چه کم دارد؛ از تب
              «ابعاد» روی نام طرف‌حساب بزنید تا در پروندهٔ او ثبتش کنید.
            </Alert>
          )}
          {d.unattributed.length > 0 && (
            <Alert tint="danger">
              <strong>{d.unattributed.length}</strong> سند به هیچ طرف‌حسابی منتسب نشد و در
              جمع‌ها نیامده است. سندی که دو طرف‌حساب دارد، سهم هرکدام معلوم نیست و
              سامانه حدس نمی‌زند — این‌ها باید دستی تفکیک شوند.
            </Alert>
          )}
        </div>
      )}

      {/* ── ماده ۱۶۹ ── */}
      <div className="section-title">گزارش فصلی ماده ۱۶۹ — معاملات</div>
      {a169.isLoading ? <Loading /> : !d?.rows.length ? (
        <EmptyState icon={<Icon name="book" />} title="در این فصل معامله‌ای با طرف‌حساب ثبت نشده">
          گزارش فصلی از اسنادی ساخته می‌شود که طرف‌حسابشان روی معین کنترلی
          (۱۱۰۴ دریافتنی یا ۲۱۰۱ پرداختنی) ثبت شده باشد.
        </EmptyState>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>طرف‌حساب</th><th>نوع شخص</th><th>شناسه</th>
                <th style={{ textAlign: 'left' }}>فروش</th>
                <th style={{ textAlign: 'left' }}>ارزش افزودهٔ فروش</th>
                <th style={{ textAlign: 'left' }}>خرید</th>
                <th style={{ textAlign: 'left' }}>ارزش افزودهٔ خرید</th>
                <th>وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r: any) => (
                <tr key={r.subsidiaryId}>
                  <td>
                    <a href={`/ledger/party/${r.subsidiaryId}`}>{r.name}</a>
                    <span className="hint-sm"> ({r.code})</span>
                  </td>
                  <td className="hint-sm">{r.taxPersonType ? PERSON_TYPE_FA[r.taxPersonType] : '—'}</td>
                  <td className="num hint-sm">{r.nationalId ?? '—'}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{r.sales !== '0' ? fmt(r.sales) : '—'}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{r.salesVat !== '0' ? fmt(r.salesVat) : '—'}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{r.purchases !== '0' ? fmt(r.purchases) : '—'}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{r.purchasesVat !== '0' ? fmt(r.purchasesVat) : '—'}</td>
                  <td className="hint-sm" style={{ color: r.problems.length ? 'var(--warning)' : 'var(--success)' }}>
                    {r.problems.length ? r.problems.join(' · ') : 'آمادهٔ ارسال'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800 }}>
                <td colSpan={3}>جمع ({d.rows.length} طرف‌حساب)</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(d.totals.sales)}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(d.totals.salesVat)}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(d.totals.purchases)}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(d.totals.purchasesVat)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {d && d.unattributed.length > 0 && (
        <>
          <div className="section-title" style={{ marginTop: 20 }}>
            اسنادی که به یک طرف‌حساب منتسب نشدند
          </div>
          <div className="table-container">
            <table className="data-table">
              <thead><tr>
                <th>سند</th><th>تاریخ</th><th>شرح</th>
                <th style={{ textAlign: 'left' }}>مبلغ</th><th>دلیل</th>
              </tr></thead>
              <tbody>
                {d.unattributed.map((u: any, i: number) => (
                  <tr key={i}>
                    <td className="num">{u.serial ?? '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{toShamsi(u.date)}</td>
                    <td>{u.description}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt(u.amount)}</td>
                    <td className="hint-sm">{u.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

function VatCard({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="kpi-card" style={{ padding: 14 }}>
      <div className="kpi-value num" style={{ fontSize: 18, color: tone }}>{fmt(value)}</div>
      <div className="kpi-label">{label}</div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
function DimensionsTab() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [newCc, setNewCc] = useState(false)
  const { data: subs, isLoading } = useQuery({
    queryKey: ['ledger', 'subsidiaries'],
    queryFn: async () => (await api.get('/ledger/subsidiaries')).data,
  })
  const { data: ccs } = useQuery({
    queryKey: ['ledger', 'cost-centers'],
    queryFn: async () => (await api.get('/ledger/cost-centers')).data,
  })

  const backfill = useMutation({
    mutationFn: async () => (await api.post('/ledger/subsidiaries/backfill')).data,
    onSuccess: (d: any) => {
      toast.success(`${d.created} تفصیلی جدید ساخته شد، ${d.renamed} نام به‌روز شد`)
      qc.invalidateQueries({ queryKey: ['ledger'] })
    },
  })

  if (isLoading) return <Loading />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="panel">
        <div className="panel-hd">
          <h3>تفصیلی شناور</h3>
          <button className="btn-secondary btn-sm" onClick={() => backfill.mutate()} disabled={backfill.isPending}>
            <Icon name="repeat" size={14} /> {backfill.isPending ? 'در حال ساخت…' : 'ساخت از طرف‌حساب‌ها'}
          </button>
        </div>
        <p className="hint-sm" style={{ padding: '10px 20px 0' }}>
          هر طرف‌حساب <strong>یک</strong> تفصیلی است، حتی اگر با چند ارز کار کند · برای دیدن پرونده کلیک کنید.
        </p>
        <div className="table-container" style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}>
          <table className="data-table">
            <thead><tr><th>کد</th><th>نام</th><th>نوع</th></tr></thead>
            <tbody>
              {(subs ?? []).map((s: any) => (
                <tr key={s.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/ledger/party/${s.id}`)}>
                  <td className="num">{s.code}</td>
                  <td>{s.name}</td>
                  <td className="hint-sm">{KIND_LABEL[s.kind] ?? s.kind}</td>
                </tr>
              ))}
              {!subs?.length && <TableEmpty colSpan={3}>هنوز تفصیلی‌ای ساخته نشده</TableEmpty>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-hd">
          <h3>مراکز هزینه</h3>
          <button className="btn-secondary btn-sm" onClick={() => setNewCc(true)}>
            <Icon name="plus" size={14} /> مرکز جدید
          </button>
        </div>
        <p className="hint-sm" style={{ padding: '10px 20px 0' }}>بُعدی مستقل و عمود بر درخت کدینگ.</p>
        <div className="table-container" style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}>
          <table className="data-table">
            <thead><tr><th>کد</th><th>نام</th><th>وضعیت</th></tr></thead>
            <tbody>
              {(ccs ?? []).map((c: any) => (
                <tr key={c.id} style={c.isPostable ? undefined : groupRow}>
                  <td className="num">{c.code}</td>
                  <td>{c.name}</td>
                  <td className="hint-sm">{c.isPostable ? 'قابل ثبت' : 'سرگروه'}</td>
                </tr>
              ))}
              {!ccs?.length && <TableEmpty colSpan={3}>مرکز هزینه‌ای نیست</TableEmpty>}
            </tbody>
          </table>
        </div>
      </div>

      {newCc && <CostCenterFormModal centres={ccs ?? []} onClose={() => setNewCc(false)} />}
    </div>

    <CostCenterReportPanel />
    <ProjectProfitabilityPanel />
    </div>
  )
}

/**
 * فرم ساخت مرکز هزینه (ممیزی ب۳).
 *
 * مسیر `POST /ledger/cost-centers` از روز اول وجود داشت ولی **هیچ‌جای رابط
 * کاربری صدایش نمی‌زد** — یعنی فقط چهار مرکز اولیه قابل استفاده بود و بُعدی که
 * کل سند مرجع رویش تأکید دارد، عملاً بسته بود.
 *
 * مودال است نه صفحه، و این با ترجیح ثبت‌شده نمی‌جنگد: آن ترجیح برای «کار روی یک
 * رکورد» است؛ این یک فرم تک‌منظورهٔ سه‌فیلدی است.
 */
function CostCenterFormModal({ centres, onClose }: { centres: any[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [parentCode, setParentCode] = useState('')

  const save = useMutation({
    mutationFn: async () =>
      (await api.post('/ledger/cost-centers', { code, name, parentCode: parentCode || null })).data,
    onSuccess: () => {
      toast.success('مرکز هزینه ساخته شد')
      qc.invalidateQueries({ queryKey: ['ledger'] })
      onClose()
    },
    onError: (e: any) => dialog.alert({ title: 'ناموفق', message: e?.response?.data?.message, tone: 'danger' }),
  })

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>مرکز هزینهٔ جدید</h2>
            <button onClick={onClose} aria-label="بستن">✕</button>
          </div>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label>کد</label>
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="مثلاً ۴" />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>نام</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً انبار" />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>زیرمجموعهٔ (اختیاری)</label>
              <select value={parentCode} onChange={(e) => setParentCode(e.target.value)}>
                <option value="">— مرکز سطح اول —</option>
                {centres.map((c: any) => <option key={c.id} value={c.code}>{c.code} · {c.name}</option>)}
              </select>
              <p className="hint-sm" style={{ margin: '4px 0 0' }}>
                اگر والدی انتخاب شود که خودش گردش دارد، ساخت رد می‌شود.
              </p>
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={onClose}>انصراف</button>
            <button className="btn-primary" disabled={!code.trim() || !name.trim() || save.isPending}
              onClick={() => save.mutate()}>
              {save.isPending ? 'در حال ذخیره…' : 'ذخیره'}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  )
}

/**
 * گزارش مراکز هزینه (ممیزی ب۳).
 *
 * `GET /ledger/reports/cost-centers` ساخته شده بود و **هرگز صدا زده نمی‌شد**؛
 * فهرست مراکز فقط کد و نام نشان می‌داد، بدون حتی یک عدد. حالا درآمد و هزینهٔ
 * هر مرکز و سهم تخصیص‌نیافته دیده می‌شود.
 */
function CostCenterReportPanel() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const { data, isFetching } = useQuery({
    queryKey: ['ledger', 'ccReport', from, to],
    queryFn: async () => (await api.get('/ledger/reports/cost-centers', {
      params: { from: from || undefined, to: to || undefined },
    })).data as any[],
  })

  // سرور یک سطر به‌ازای (مرکز × نوع) می‌دهد؛ برای خواندن، به‌ازای مرکز جمع می‌شود
  const rows = useMemo(() => {
    const m = new Map<string, { code: string; name: string; income: bigint; expense: bigint }>()
    for (const r of data ?? []) {
      const key = r.costCenterId ?? '—'
      const cur = m.get(key) ?? {
        code: r.code ?? '—', name: r.name ?? 'تخصیص‌نیافته', income: 0n, expense: 0n,
      }
      if (r.rootType === 'INCOME') cur.income += -BigInt(r.totalBase)
      else cur.expense += BigInt(r.totalBase)
      m.set(key, cur)
    }
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code))
  }, [data])

  return (
    <div className="panel">
      <div className="panel-hd">
        <h3>گزارش مراکز هزینه</h3>
        <CsvButton path="/ledger/export/cost-centers" filename="cost-centers.csv"
          params={{ from: from || undefined, to: to || undefined }} />
      </div>
      <div className="toolbar">
        <div className="form-group" style={{ margin: 0 }}><label>از</label><DateField value={from} onChange={setFrom} /></div>
        <div className="form-group" style={{ margin: 0 }}><label>تا</label><DateField value={to} onChange={setTo} /></div>
        {isFetching && <span className="hint-sm">در حال محاسبه…</span>}
      </div>
      <div className="table-container" style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>کد</th><th>مرکز هزینه</th>
              <th style={{ textAlign: 'left' }}>درآمد (ریال)</th>
              <th style={{ textAlign: 'left' }}>هزینه (ریال)</th>
              <th style={{ textAlign: 'left' }}>خالص (ریال)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const net = r.income - r.expense
              const unalloc = r.code === '—'
              return (
                <tr key={r.code} style={unalloc ? { color: 'var(--text-muted)', fontStyle: 'italic' } : undefined}>
                  <td className="num">{r.code}</td>
                  <td>{r.name}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(r.income)}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(r.expense)}</td>
                  <td className="num" style={{ textAlign: 'left', fontWeight: 700, color: signColor(net) }}>{fmt(net)}</td>
                </tr>
              )
            })}
            {!rows.length && <TableEmpty colSpan={5}>گردشی در این بازه نیست</TableEmpty>}
          </tbody>
        </table>
      </div>
      <p className="hint" style={{ padding: '0 20px 14px' }}>
        سطر «تخصیص‌نیافته» ردیف‌هایی است که مرکز هزینه ندارند — عمدتاً درآمد و بهای
        تمام‌شده. تا وقتی آن‌ها هم برچسب بخورند، سود هر مرکز کامل نیست.
      </p>
    </div>
  )
}

function ProjectProfitabilityPanel() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const { data, isFetching } = useQuery({
    queryKey: ['ledger', 'projectPnl', from, to],
    queryFn: async () => (await api.get('/ledger/reports/project-profitability', {
      params: { from: from || undefined, to: to || undefined },
    })).data,
  })

  return (
    <div className="panel">
      <div className="panel-hd">
        <h3>سودآوری پروژه</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <div className="form-group" style={{ margin: 0 }}><label>از</label><DateField value={from} onChange={setFrom} /></div>
          <div className="form-group" style={{ margin: 0 }}><label>تا</label><DateField value={to} onChange={setTo} /></div>
        </div>
      </div>
      <p className="hint-sm" style={{ padding: '10px 20px 0' }}>
        درآمد و بهای تمام‌شدهٔ فاکتور/خرید/فورواردینگ به مرکز هزینهٔ «۹.کد پروژه» برچسب می‌خورد.{isFetching ? ' …' : ''}
      </p>
      <div className="table-container" style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}>
        <table className="data-table">
          <thead><tr>
            <th>پروژه</th>
            <th style={{ textAlign: 'left' }}>درآمد</th>
            <th style={{ textAlign: 'left' }}>بهای تمام‌شده</th>
            <th style={{ textAlign: 'left' }}>سود ناخالص</th>
            <th style={{ textAlign: 'left' }}>سایر هزینه</th>
            <th style={{ textAlign: 'left' }}>سود خالص</th>
            <th style={{ textAlign: 'left' }}>حاشیه</th>
          </tr></thead>
          <tbody>
            {(data?.projects ?? []).map((p: any) => (
              <tr key={p.code}>
                <td className="num">{p.code}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(p.revenue)}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(p.cogs)}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(p.grossProfit)}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(p.otherExpense)}</td>
                <td className="num" style={{ textAlign: 'left', fontWeight: 700, color: signColor(p.netProfit) }}>{fmt(p.netProfit)}</td>
                <td className="num" style={{ textAlign: 'left' }}>{p.margin == null ? '—' : `${p.margin}٪`}</td>
              </tr>
            ))}
            {!data?.projects?.length && <TableEmpty colSpan={7}>هنوز فاکتور/خریدی با برچسب پروژه ثبت نشده</TableEmpty>}
          </tbody>
          {data?.projects?.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800 }}>
                <td>جمع کل</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(data.totals.revenue)}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(data.totals.cogs)}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(data.totals.grossProfit)}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(data.totals.otherExpense)}</td>
                <td className="num" style={{ textAlign: 'left' }}>{fmt(data.totals.netProfit)}</td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}

const KIND_LABEL: Record<string, string> = {
  CUSTOMER: 'مشتری', PRODUCER: 'سازنده', SUPPLIER: 'تأمین‌کننده',
  CARRIER: 'شرکت حمل', EXCHANGE: 'صرافی', AGENT: 'کمیسیون‌بگیر',
  EMPLOYEE: 'کارمند', PETTY_CASH_HOLDER: 'تنخواه‌دار', BANK: 'بانک', OTHER: 'متفرقه',
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
/**
 * ارز — دو کارِ متفاوت که تا امروز یک تب بودند (چیدمانِ تازه).
 *
 * **نرخ ارز** پیکربندی است: جدولی که سالی چند بار به آن سر می‌زنی یا cron
 * پرش می‌کند. **تجدید ارزیابی** یک کارِ پایان دوره است: ماهی یک بار، کنار
 * ذخیرهٔ مطالبات و استهلاک و بستن دوره.
 *
 * کنار هم بودنشان یعنی حسابدارِ پایان ماه باید در «تنظیمات» دنبال کاری بگردد
 * که کارِ روزمرهٔ بستنِ دوره است. حالا هرکدام جای خودش نشسته و state مشترک
 * (نرخ‌ها، پیش‌نمایش) در همان هوک‌های خودشان تکرار می‌شود، نه در یک کامپوننتِ
 * دوکاره.
 */

function FxRatesPanel() {
  const qc = useQueryClient()
  const [from, setFrom] = useState('USD')
  const [rate, setRate] = useState('')
  const [date, setDate] = useState('')

  const { data: rates } = useQuery({
    queryKey: ['ledger', 'fx-rates'],
    queryFn: async () => (await api.get('/ledger/fx/rates')).data,
  })

  const addRate = useMutation<any, any, boolean | undefined>({
    mutationFn: async (confirmOutlier) =>
      (await api.post('/ledger/fx/rates', { from, to: 'IRR', rate, date, confirmOutlier: !!confirmOutlier })).data,
    onSuccess: () => { toast.success('نرخ ثبت شد'); setRate(''); qc.invalidateQueries({ queryKey: ['ledger', 'fx-rates'] }) },
    onError: async (e: any) => {
      const body = e?.response?.data ?? {}
      const msg = body.message ?? ''
      // ممیزی ج۱۵: انحراف بزرگ ⇒ تأیید صریح. ممیزی ن۹: نخستین نرخِ یک ارز هم
      // تأیید می‌خواهد. تصمیم روی پرچمِ ساختاریافتهٔ سرور است، نه تطبیقِ متن —
      // با تطبیقِ متن، هر بازنویسیِ پیام، دیالوگ تأیید را بی‌صدا از کار می‌انداخت.
      const needsConfirm = body.needsConfirm === true
      if (needsConfirm) {
        const title = body.reason === 'FIRST_RATE' ? 'نخستین نرخ این ارز' : 'نرخ غیرعادی'
        if (await dialog.confirm({ title, message: msg, confirmLabel: 'بله، ثبت کن', tone: 'danger' })) {
          addRate.mutate(true)
        }
      } else {
        dialog.alert({ title: 'ثبت نرخ ناموفق', message: msg, tone: 'danger' })
      }
    },
  })
  const refresh = useMutation({
    mutationFn: async () => (await api.post('/ledger/fx/rates/refresh')).data,
    onSuccess: (d: any) => {
      toast.success(d.ok
        ? `نرخ زنده ثبت شد: ${d.written.map((w: any) => CUR_LABEL[w.from] ?? w.from).join('، ')} (${d.source})`
        : `منبع زنده در دسترس نیست — ${d.skipped}`)
      qc.invalidateQueries({ queryKey: ['ledger', 'fx-rates'] })
    },
    onError: (e: any) => dialog.alert({ title: 'دریافت نرخ ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const rows: any[] = rates?.rows ?? []
  const freshness: Record<string, any> = rates?.freshness ?? {}
  const stale = Object.entries(freshness).filter(([, f]) => !f || f.ageDays > 2)


  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="panel">
        <div className="panel-hd">
          <h3>نرخ ارز</h3>
          <button className="btn-secondary btn-sm" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
            <Icon name="repeat" size={14} /> {refresh.isPending ? 'در حال دریافت…' : 'دریافت نرخ زنده'}
          </button>
        </div>
        <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p className="hint-sm" style={{ margin: 0 }}>
            نرخ به <strong>ریال</strong> به‌ازای یک واحد ارز. «دریافت نرخ زنده» بازار آزاد را در
            منبع <span className="num">AUTO</span> می‌نویسد (هر ۶ ساعت خودکار هم اجرا می‌شود)؛
            نرخِ <span className="num">MANUAL</span> که خودت ثبت کنی همیشه اولویت دارد. نرخِ لحظهٔ سند روی ردیف قفل می‌شود.
          </p>

          {stale.length > 0 && (
            <Alert tint="warning">
              نرخ روزِ این ارزها نیست:{' '}
              <strong>{stale.map(([c]) => CUR_LABEL[c] ?? c).join('، ')}</strong>
              {' '}— تا نرخ نداشته باشند، سند ارزی‌شان در حالت «هستهٔ جدید مرجع» رد می‌شود.
            </Alert>
          )}

          <div className="grid-3">
            {Object.entries(freshness).map(([c, f]: any) => (
              <div key={c} className="kpi-card" style={{ padding: 12 }}>
                <div className="kpi-label">{CUR_LABEL[c] ?? c}</div>
                {f ? (
                  <>
                    <div className="kpi-value num" style={{ fontSize: 16 }}>{Number(f.rate).toLocaleString()}</div>
                    <div className="hint-sm">
                      {toShamsi(f.date)} · {f.source} ·{' '}
                      <span style={{ color: f.ageDays > 2 ? 'var(--danger)' : 'var(--text-muted)' }}>{f.ageDays} روز پیش</span>
                    </div>
                  </>
                ) : <div className="hint-sm" style={{ color: 'var(--danger)' }}>نرخی ثبت نشده</div>}
              </div>
            ))}
          </div>

          <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label>ارز</label>
              <select style={{ width: 110 }} value={from} onChange={(e) => setFrom(e.target.value)}>
                {['USD', 'CNY', 'AED'].map((c) => <option key={c} value={c}>{CUR_LABEL[c]}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>نرخ دستی (ریال)</label>
              <input className="num" style={{ width: 150 }} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            <div className="form-group" style={{ margin: 0 }}><label>تاریخ</label><DateField value={date} onChange={setDate} /></div>
            <button className="btn-primary" disabled={!rate || !date || addRate.isPending} onClick={() => addRate.mutate(false)}>ثبت نرخ دستی</button>
          </div>
          <div className="table-container">
            <table className="data-table">
              <thead><tr><th>ارز</th><th>تاریخ</th><th style={{ textAlign: 'left' }}>نرخ (ریال)</th><th>منبع</th></tr></thead>
              <tbody>
                {rows.slice(0, 15).map((r: any) => (
                  <tr key={r.id}>
                    <td>{CUR_LABEL[r.from] ?? r.from}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{toShamsi(r.date)}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{Number(r.rate).toLocaleString()}</td>
                    <td className="hint-sm">{r.source}</td>
                  </tr>
                ))}
                {!rows.length && <TableEmpty colSpan={4}>نرخی ثبت نشده</TableEmpty>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function RevaluationPanel() {
  const qc = useQueryClient()
  const [asOf, setAsOf] = useState('')

  const preview = useQuery({
    queryKey: ['ledger', 'reval', asOf],
    queryFn: async () => (await api.get('/ledger/fx/revaluation/preview', { params: { asOf: asOf || undefined } })).data,
    enabled: !!asOf,
  })
  const doReval = useMutation<any, any, 'temporary' | 'permanent'>({
    mutationFn: async (mode) => (await api.post('/ledger/fx/revaluation', { asOf, mode })).data,
    onSuccess: () => { toast.success('تجدید ارزیابی ثبت شد'); qc.invalidateQueries({ queryKey: ['ledger'] }) },
    onError: (e: any) => dialog.alert({ title: 'ثبت ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="panel">
        <div className="panel-hd"><h3>ریسک ارزی و تجدید ارزیابی</h3></div>
        <div className="panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p className="hint-sm" style={{ margin: 0 }}>
            جدول زیر همهٔ موضع‌های ارزیِ باز را با ارزش دفتری در برابر نرخ روز نشان می‌دهد —
            یعنی سود/زیان تسعیرِ <strong>تحقق‌نیافته</strong>.
          </p>
          <ul className="hint-sm" style={{ margin: 0, paddingInlineStart: 18 }}>
            <li><strong>موقت (میان‌دوره):</strong> سند تعدیل + سند برگشتِ دورهٔ بعد با هم — تا با تسویهٔ واقعی دوباره شمرده نشود.</li>
            <li><strong>دائمی (پایان سال):</strong> نرخِ پایان سال مبنای جدید می‌شود؛ بدون برگشت (استاندارد ۱۶ / IAS 21).</li>
          </ul>
          <div className="form-group" style={{ margin: 0 }}><label>در تاریخ</label><DateField value={asOf} onChange={setAsOf} /></div>

          {preview.data && (
            <>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <span>سود: <b className="num" style={{ color: 'var(--success)' }}>{fmt(preview.data.totalGain)}</b></span>
                <span>زیان: <b className="num" style={{ color: 'var(--danger)' }}>{fmt(preview.data.totalLoss)}</b></span>
                <span>خالص: <b className="num">{fmt(preview.data.netBase)}</b> ریال</span>
              </div>
              <div className="table-container">
                <table className="data-table">
                  <thead><tr>
                    <th>حساب</th><th>تفصیلی</th><th>ارز</th>
                    <th style={{ textAlign: 'left' }}>مانده</th>
                    <th style={{ textAlign: 'left' }}>دفتری</th>
                    <th style={{ textAlign: 'left' }}>به نرخ روز</th>
                    <th style={{ textAlign: 'left' }}>اختلاف</th>
                  </tr></thead>
                  <tbody>
                    {preview.data.lines.map((l: any, i: number) => (
                      <tr key={i}>
                        <td><span className="num">{l.code}</span> {l.accountName}</td>
                        <td>{l.subsidiaryName ?? '—'}</td>
                        <td>{CUR_LABEL[l.currencyCode] ?? l.currencyCode}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{fmt(l.amount, l.currencyCode)}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{fmt(l.carryingBase)}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{fmt(l.currentBase)}</td>
                        <td className="num" style={{ textAlign: 'left', color: signColor(l.deltaBase) }}>{fmt(l.deltaBase)}</td>
                      </tr>
                    ))}
                    {!preview.data.lines.length && <TableEmpty colSpan={7}>قلم ارزی بازی با اختلاف ارزش نیست</TableEmpty>}
                  </tbody>
                </table>
              </div>
              {preview.data.alreadyPosted ? (
                <p className="hint-sm" style={{ margin: 0, color: 'var(--text-muted)' }}>برای این تاریخ قبلاً ثبت شده است.</p>
              ) : (
                <div style={{ display: 'flex', gap: 10, alignSelf: 'flex-start' }}>
                  <button className="btn-secondary"
                    disabled={!preview.data.lines.length || doReval.isPending}
                    onClick={() => doReval.mutate('temporary')}>
                    ثبت موقت (با برگشت)
                  </button>
                  <button className="btn-primary"
                    disabled={!preview.data.lines.length || doReval.isPending}
                    onClick={async () => {
                      if (await dialog.confirm({
                        title: 'تجدید ارزیابی دائمی', tone: 'danger', confirmLabel: 'بله، دائمی ثبت کن',
                        message: 'نرخِ این تاریخ مبنای دائمیِ همهٔ موضع‌های ارزی می‌شود و برگشت نمی‌خورد. فقط برای پایان سال مالی.',
                      })) doReval.mutate('permanent')
                    }}>
                    ثبت دائمی پایان سال
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
/**
 * فقط بررسی یکپارچگی. پیش از این این تابع سه چیز بی‌ربط را کنار هم می‌گذاشت —
 * تنظیمات سال مالی، سلامت دفاتر، و سیاههٔ حسابرسی — یعنی تبِ «متفرقه» بود.
 * حالا هر سه زیرتبِ خودشان را در «تنظیمات و سلامت» دارند.
 */
function IntegrityPanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'integrity'],
    queryFn: async () => (await api.get('/ledger/reports/integrity')).data,
  })

  const checks: { key: string; label: string }[] = [
    { key: 'unbalancedEntries', label: 'سند ناتراز' },
    { key: 'missingSubsidiary', label: 'تفصیلی اجباریِ خالی' },
    { key: 'disallowedSubsidiaryKind', label: 'تفصیلی از نوع نامجاز' },
    { key: 'missingCostCenter', label: 'مرکز هزینهٔ اجباریِ خالی' },
    { key: 'postingsOnGroups', label: 'ثبت روی سرگروه' },
    { key: 'controlMismatch', label: 'انحراف کنترلی از معین تفصیلی' },
    { key: 'orphanSubsidiaries', label: 'تفصیلی یتیم' },
    { key: 'serialGaps', label: 'شکاف در شمارهٔ سند' },
    // ⚠️ افزودن این ردیف جا مانده بود: کنترل ب۵ در بک‌اند اجرا می‌شد و در
    // `ok` هم اثر داشت، ولی چون در این فهرست نبود، پنل «اشکال پیدا شد»
    // می‌گفت و همهٔ ردیف‌هایش سبز بودند — بدترین حالت برای یک پنل سلامت.
    { key: 'assetRegisterMismatch', label: 'مغایرت دفتر دارایی ثابت با دفتر کل' },
  ]

  return (
    <div>
      {isLoading || !data ? <Loading /> : (
      <>
      <div style={{ marginBottom: 14 }}>
        <Alert tint={data.ok ? 'success' : 'danger'}>
          {data.ok ? 'همهٔ بررسی‌ها سبز است' : 'اشکال پیدا شد — جزئیات پایین'}
          <span className="hint-sm" style={{ display: 'block', marginTop: 2 }}>
            {data.checked.entries} سند · {data.checked.lines} ردیف · {data.checked.subsidiaries} تفصیلی
          </span>
        </Alert>
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead><tr><th>بررسی</th><th style={{ textAlign: 'left' }}>نتیجه</th></tr></thead>
          <tbody>
            {checks.map((c) => {
              const n = (data[c.key] ?? []).length
              return (
                <tr key={c.key}>
                  <td>{c.label}</td>
                  <td style={{ textAlign: 'left', color: n ? 'var(--danger)' : 'var(--success)', fontWeight: 650 }}>
                    {n ? `${n} مورد` : 'سالم'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  )
}

/**
 * «تنظیمات و سلامت» — هر چیزی که *پیکربندیِ* دفتر است یا *وضعیتِ* آن را
 * می‌گوید، در برابر تب‌های دیگر که *کارِ* روزمره‌اند.
 */
function SettingsTab() {
  const [view, setView] = useState<'chart' | 'dimensions' | 'rates' | 'health' | 'audit'>('chart')
  return (
    <div>
      <div className="toolbar">
        <SubTabs
          tabs={[
            ['chart', 'چارت حساب‌ها'], ['dimensions', 'تفصیلی و مراکز هزینه'],
            ['rates', 'نرخ ارز'],
            ['health', 'سلامت دفاتر'], ['audit', 'ردِ پای عملیات'],
          ] as const}
          value={view} onChange={setView}
        />
      </div>
      {view === 'chart' && <ChartTab />}
      {view === 'dimensions' && <DimensionsTab />}
      {/* تسعیر و سال مالی به تب «پایان دوره» رفتند — کارِ بستنِ دوره‌اند نه پیکربندی */}
      {view === 'rates' && <FxRatesPanel />}
      {view === 'health' && <IntegrityPanel />}
      {view === 'audit' && <AuditLogPanel />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
/**
 * زیرسامانه‌هایی که **رکورد خودشان** را دارند — چک، تنخواه، حقوق، دارایی
 * ثابت. وجه مشترکشان این است که هرکدام یک دفترِ کوچکِ مستقل‌اند که سند
 * می‌سازد، نه یک گزارش و نه یک تنظیم.
 */
function OperationsTab() {
  const [view, setView] = useState<'cheques' | 'petty' | 'payroll' | 'assets'>('cheques')
  return (
    <div>
      <div className="toolbar">
        <SubTabs
          tabs={[
            ['cheques', 'چک'], ['petty', 'تنخواه‌گردان'],
            ['payroll', 'حقوق و دستمزد'], ['assets', 'دارایی‌های ثابت'],
          ] as const}
          value={view} onChange={setView}
        />
      </div>
      {view === 'cheques' && <ChequeTab />}
      {view === 'petty' && <PettyCashTab />}
      {view === 'payroll' && <PayrollTab />}
      {view === 'assets' && <FixedAssetsTab />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
/**
 * همهٔ کارهای بستنِ دوره، کنار هم — و به **ترتیبی که انجام می‌شوند**.
 *
 * پیش از این چک‌لیست می‌گفت چه مانده ولی هر بند در تبی دیگر بود. حالا
 * چک‌لیست اول است و بقیهٔ زیرتب‌ها همان بندهایش‌اند، به همان ترتیب:
 * تسعیر → ذخیرهٔ مطالبات → استهلاک → بستن دوره.
 */
function PeriodEndTab() {
  const [view, setView] = useState<'checklist' | 'reval' | 'provision' | 'depreciation' | 'period'>('checklist')
  return (
    <div>
      <div className="toolbar">
        <SubTabs
          tabs={[
            ['checklist', 'چک‌لیست پایان ماه'],
            ['reval', 'تسعیر ارزی'],
            ['provision', 'ذخیرهٔ مطالبات'],
            ['depreciation', 'استهلاک'],
            ['period', 'سال مالی و قفل دوره'],
          ] as const}
          value={view} onChange={setView}
        />
      </div>
      {view === 'checklist' && <MonthEndTab />}
      {view === 'reval' && <RevaluationPanel />}
      {view === 'provision' && <ProvisionView />}
      {view === 'depreciation' && <FixedAssetsTab />}
      {view === 'period' && <PeriodPanel />}
    </div>
  )
}

const AUDIT_ACTION_LABEL: Record<string, string> = {
  POST: 'ثبت سند', REVERSE: 'ابطال سند',
  DRAFT_CREATE: 'ساخت پیش‌نویس', DRAFT_UPDATE: 'ویرایش پیش‌نویس',
  DRAFT_DISCARD: 'حذف پیش‌نویس', DRAFT_POST: 'نهایی‌کردن پیش‌نویس',
  YEAR_CLOSE: 'بستن سال مالی', YEAR_REOPEN: 'بازگشایی سال مالی',
  PROVISION_PAY: 'پرداخت ذخیرهٔ حقوق', RATE_SET: 'ثبت نرخ حقوق',
  PERIOD_LOCK: 'قفل دوره', PERIOD_UNLOCK: 'حذف قفل دوره',
  BUDGET_SET: 'ثبت بودجه', BUDGET_DELETE: 'حذف بودجه',
}

function AuditLogPanel() {
  const [action, setAction] = useState('')
  const [page, setPage] = useState(0)
  const TAKE = 30
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['ledger', 'audit', action, page],
    queryFn: async () => (await api.get('/ledger/audit', {
      params: { action: action || undefined, take: TAKE, skip: page * TAKE },
    })).data,
  })
  const rows: any[] = data?.rows ?? []
  const total: number = data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / TAKE))

  return (
    <div>
      <div className="toolbar">
        <div className="form-group" style={{ margin: 0 }}>
          <label>نوع عملیات</label>
          <select value={action} onChange={(e) => { setAction(e.target.value); setPage(0) }}>
            <option value="">همه</option>
            {Object.entries(AUDIT_ACTION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <span className="hint-sm">{total} رویداد{isFetching ? ' …' : ''}</span>
      </div>
      {isLoading ? <Loading /> : !rows.length ? (
        <EmptyState icon={<Icon name="book" />} title="رویدادی ثبت نشده" />
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead><tr><th>زمان</th><th>کاربر</th><th>عملیات</th><th>شرح</th><th>سند</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="hint-sm num" style={{ whiteSpace: 'nowrap' }}>{new Date(r.at).toLocaleString('fa-IR')}</td>
                  <td>{r.actorName ?? <span className="hint-sm">—</span>}</td>
                  <td><span className="chip" style={{ background: 'var(--surface-2)' }}>{AUDIT_ACTION_LABEL[r.action] ?? r.action}</span></td>
                  <td className="hint-sm">{r.summary}</td>
                  <td className="num">{r.entrySerial ? `#${r.entrySerial}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="row-between" style={{ marginTop: 12 }}>
          <button className="btn-secondary btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>قبلی</button>
          <span className="hint-sm">صفحهٔ {page + 1} از {pages}</span>
          <button className="btn-secondary btn-sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>بعدی</button>
        </div>
      )}
    </div>
  )
}
