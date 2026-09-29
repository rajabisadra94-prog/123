import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { toShamsi } from '../lib/date'
import { PageHeader, Loading, TableEmpty, EmptyState, Alert } from '../components/ui'
import { toast } from '../components/ui/dialog'
import { CsvButton } from './LedgerReports'
import AllocationPanel from '../components/shared/AllocationPanel'
import { fmt, signColor, CUR_LABEL } from '../lib/ledgerFormat'

/**
 * پروندهٔ یک طرف‌حساب — صفحهٔ تمام‌صفحهٔ دوستونه (ممیزی سوم — ج۱).
 *
 * پیش از این یک مودال بود. مودال برای «تأیید می‌کنی؟» ساخته شده، نه برای
 * کاری که چند دقیقه طول می‌کشد: تاریخچه‌ای که باید اسکرول شود، سن‌بندی‌ای که
 * باید کنارش خوانده شود، و مبلغی که باید یادداشت شود. مودال آدرس ندارد، پس
 * نمی‌شد لینکش را برای همکار فرستاد؛ عرض ثابت داشت، پس جدول هفت‌ستونی
 * فشرده می‌شد؛ و پشت‌سرش صفحه قفل بود.
 *
 * چیدمان: **ستون راست خلاصهٔ وضعیت** (مواضع ارزی، سن‌بندی، آمار) و
 * **ستون چپ تاریخچه**. تصمیم مالی از خلاصه گرفته می‌شود و تاریخچه فقط
 * سندِ آن است، پس خلاصه سمت شروعِ خواندن (راست) می‌نشیند.
 */

const OBLIGATION_CODE: Record<string, string> = { CUSTOMER: '1104' }
const controlCodeOf = (kind: string) => OBLIGATION_CODE[kind] ?? '2101'

const PERSON_TYPES = [
  { key: 'LEGAL', label: 'شخص حقوقی', digits: 11, idLabel: 'شناسهٔ ملی' },
  { key: 'NATURAL', label: 'شخص حقیقی', digits: 10, idLabel: 'کد ملی' },
  { key: 'PARTNERSHIP', label: 'مشارکت مدنی', digits: 0, idLabel: 'شناسه' },
  { key: 'FOREIGN', label: 'اتباع خارجی', digits: 0, idLabel: 'شناسه' },
  { key: 'CONSUMER', label: 'مصرف‌کنندهٔ نهایی', digits: 0, idLabel: 'شناسه (لازم نیست)' },
]

const KIND_FA: Record<string, string> = {
  CUSTOMER: 'مشتری', VENDOR: 'تأمین‌کننده', EMPLOYEE: 'کارمند', OTHER: 'سایر',
}

const BUCKETS = ['0-30', '31-60', '61-90', '90+'] as const
const BUCKET_LABEL: Record<string, string> = {
  '0-30': 'تا ۳۰ روز', '31-60': '۳۱–۶۰ روز', '61-90': '۶۱–۹۰ روز', '90+': 'بیش از ۹۰ روز',
}
const bucketTone = (i: number) => ['var(--success)', 'var(--text)', 'var(--warning)', 'var(--danger)'][i]

export default function LedgerPartyPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const [cur, setCur] = useState('')

  const party = useQuery({
    queryKey: ['ledger', 'subsidiary', id],
    queryFn: async () => (await api.get(`/ledger/subsidiaries/${id}`)).data,
  })
  const controlCode = party.data ? controlCodeOf(party.data.kind) : null

  const positions = useQuery({
    queryKey: ['ledger', 'sub-positions', id],
    queryFn: async () => (await api.get(`/ledger/subsidiaries/${id}/positions`)).data,
  })
  const history = useQuery({
    enabled: !!controlCode,
    queryKey: ['ledger', 'sub-history', controlCode, id],
    queryFn: async () => (await api.get(`/ledger/reports/account-ledger/${controlCode}`, {
      params: { subsidiaryId: id },
    })).data,
  })
  const ageing = useQuery({
    enabled: !!controlCode,
    queryKey: ['ledger', 'party-aging', controlCode, id],
    queryFn: async () => (await api.get(`/ledger/reports/aging/${controlCode}`, {
      params: { subsidiaryId: id },
    })).data,
  })

  // ماندهٔ در حال حرکت به تفکیک ارز — از مبلغ ارز اصلی، نه ستون scope‌شده
  const rows = useMemo(() => {
    const run: Record<string, bigint> = {}
    return (history.data?.rows ?? []).map((r: any) => {
      const c = r.currencyCode
      run[c] = (run[c] ?? 0n) + BigInt(r.debitForeign) - BigInt(r.creditForeign)
      return { ...r, running: run[c].toString() }
    })
  }, [history.data])

  const currencies = useMemo(
    () => [...new Set(rows.map((r: any) => r.currencyCode as string))] as string[],
    [rows],
  )
  const shown = cur ? rows.filter((r: any) => r.currencyCode === cur) : rows

  // آمارِ سربرگ: چیزی که مدیر مالی پیش از باز کردن تاریخچه می‌خواهد بداند
  const stats = useMemo(() => {
    if (!rows.length) return null
    return { count: rows.length, first: rows[0].date, last: rows[rows.length - 1].date }
  }, [rows])

  if (party.isLoading) return <div className="page" dir="rtl"><Loading /></div>
  if (!party.data) {
    return (
      <div className="page" dir="rtl">
        <EmptyState title="طرف‌حساب یافت نشد">
          شاید حذف شده باشد.{' '}
          <button className="btn-secondary btn-sm" onClick={() => nav('/ledger')}>بازگشت به دفترداری</button>
        </EmptyState>
      </div>
    )
  }

  const p = party.data
  const ageRow = ageing.data?.rows?.[0] ?? null

  return (
    <div className="page" dir="rtl">
      <PageHeader
        title={p.name}
        subtitle={<>
          <span className="num">{p.code}</span> · {KIND_FA[p.kind] ?? p.kind} · معین کنترلی{' '}
          <span className="num">{controlCode}</span>
        </>}
        actions={<>
          <CsvButton path={`/ledger/export/account-ledger/${controlCode}`}
            filename={`party-${p.code}.csv`} params={{ subsidiaryId: id }} />
          <button className="btn-secondary btn-sm" onClick={() => nav('/ledger')}>بازگشت به دفترداری</button>
        </>}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 320px) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}
        className="party-grid">
        {/* ───── ستون خلاصه ───── */}
        <div style={{ display: 'grid', gap: 16 }}>
          <section className="panel">
            <div className="section-title">مواضع باز</div>
            {positions.isLoading ? <Loading /> : (
              <div style={{ display: 'grid', gap: 10 }}>
                {(positions.data ?? []).map((q: any) => (
                  <div key={`${q.code}-${q.currencyCode}`} className="kpi-card" style={{ padding: 12 }}>
                    <div className="kpi-value num" style={{ fontSize: 18, color: signColor(q.balance) }}>
                      {fmt(q.balance, q.currencyCode)}
                    </div>
                    <div className="kpi-label">{q.accountName} · {CUR_LABEL[q.currencyCode] ?? q.currencyCode}</div>
                    {q.currencyCode !== 'IRR' && (
                      <div className="hint-sm num">معادل {fmt(q.balanceBase)} ریال</div>
                    )}
                  </div>
                ))}
                {!(positions.data ?? []).length && <div className="hint-sm">موضع بازی ندارد.</div>}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="section-title">سن‌بندی ماندهٔ باز</div>
            {ageing.isLoading ? <Loading /> : ageRow ? (
              <>
                <table className="data-table" style={{ margin: 0 }}>
                  <tbody>
                    {BUCKETS.map((b, i) => (
                      <tr key={b}>
                        <td>{BUCKET_LABEL[b]}</td>
                        <td className="num" style={{ textAlign: 'left', color: ageRow.buckets[b] !== '0' ? bucketTone(i) : 'var(--text-muted)' }}>
                          {ageRow.buckets[b] !== '0' ? fmt(ageRow.buckets[b]) : '—'}
                        </td>
                      </tr>
                    ))}
                    <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800 }}>
                      <td>جمع (ریال)</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(ageRow.totalBase)}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="hint" style={{ marginTop: 8 }}>
                  قدیمی‌ترین تعهد باز:{' '}
                  <strong style={{ color: ageRow.oldestDays > 90 ? 'var(--danger)' : ageRow.oldestDays > 60 ? 'var(--warning)' : 'inherit' }}>
                    {ageRow.oldestDays} روز
                  </strong>
                </p>
              </>
            ) : <div className="hint-sm">ماندهٔ بازی ندارد — همه‌چیز تسویه است.</div>}
          </section>

          <TaxIdentityPanel party={p} />

          {stats && (
            <section className="panel">
              <div className="section-title">در یک نگاه</div>
              <table className="data-table" style={{ margin: 0 }}>
                <tbody>
                  <tr><td>تعداد تراکنش</td><td className="num" style={{ textAlign: 'left' }}>{stats.count}</td></tr>
                  <tr><td>نخستین سند</td><td style={{ textAlign: 'left' }}>{toShamsi(stats.first)}</td></tr>
                  <tr><td>آخرین سند</td><td style={{ textAlign: 'left' }}>{toShamsi(stats.last)}</td></tr>
                  <tr><td>ارزهای درگیر</td><td style={{ textAlign: 'left' }}>{currencies.map((c) => CUR_LABEL[c] ?? c).join('، ')}</td></tr>
                </tbody>
              </table>
            </section>
          )}
        </div>

        {/* ───── ستون تاریخچه ───── */}
        <div style={{ display: 'grid', gap: 16 }}>
        {controlCode && <AllocationPanel subsidiaryId={id} accountCode={controlCode} />}
        <section className="panel">
          <div className="row-between" style={{ marginBottom: 8 }}>
            <div className="section-title" style={{ margin: 0 }}>تاریخچهٔ تراکنش</div>
            {currencies.length > 1 && (
              <select className="input input-sm" style={{ width: 'auto' }} value={cur} onChange={(e) => setCur(e.target.value)}>
                <option value="">همهٔ ارزها</option>
                {currencies.map((c) => <option key={c} value={c}>{CUR_LABEL[c] ?? c}</option>)}
              </select>
            )}
          </div>
          <div className="table-container">
            <table className="data-table">
              <thead><tr>
                <th>تاریخ</th><th>سند</th><th>شرح</th><th>ارز</th>
                <th style={{ textAlign: 'left' }}>بدهکار</th>
                <th style={{ textAlign: 'left' }}>بستانکار</th>
                <th style={{ textAlign: 'left' }}>مانده</th>
              </tr></thead>
              <tbody>
                {history.isLoading
                  ? <tr><td colSpan={7}><Loading /></td></tr>
                  : shown.map((r: any, i: number) => (
                    <tr key={i}>
                      <td style={{ whiteSpace: 'nowrap' }}>{toShamsi(r.date)}</td>
                      <td className="num">#{r.serial}</td>
                      <td>{r.description}{r.memo ? <span className="hint-sm"> — {r.memo}</span> : null}</td>
                      <td>{CUR_LABEL[r.currencyCode] ?? r.currencyCode}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{r.debitForeign !== '0' ? fmt(r.debitForeign, r.currencyCode) : ''}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{r.creditForeign !== '0' ? fmt(r.creditForeign, r.currencyCode) : ''}</td>
                      <td className="num" style={{ textAlign: 'left', color: signColor(r.running) }}>{fmt(r.running, r.currencyCode)}</td>
                    </tr>
                  ))}
                {!history.isLoading && !shown.length && <TableEmpty colSpan={7}>تراکنشی ثبت نشده</TableEmpty>}
              </tbody>
            </table>
          </div>
          {currencies.length > 1 && (
            <p className="hint" style={{ marginTop: 8 }}>
              ستون «مانده» برای هر ارز جداگانه انباشته می‌شود — جمع کردن ریال و دلار در یک ستون معنا ندارد.
            </p>
          )}
        </section>
        </div>
      </div>
    </div>
  )
}

/**
 * هویت مالیاتی طرف‌حساب (ماده ۱۶۹ — مرحلهٔ ۴).
 *
 * اینجا و نه در یک صفحهٔ تنظیماتِ جدا، چون کاربر وقتی می‌فهمد این را لازم
 * دارد که گزارش فصلی طرف‌حساب را «ناقص» علامت زده؛ و از همان‌جا روی نامش
 * می‌زند و به همین صفحه می‌آید. فاصلهٔ بین «فهمیدنِ کمبود» و «رفعِ کمبود»
 * باید یک کلیک باشد.
 */
function TaxIdentityPanel({ party }: { party: any }) {
  const qc = useQueryClient()
  const [edit, setEdit] = useState(false)
  const [form, setForm] = useState({
    taxPersonType: party.taxPersonType ?? '',
    nationalId: party.nationalId ?? '',
    economicCode: party.economicCode ?? '',
    taxAddress: party.taxAddress ?? '',
    postalCode: party.postalCode ?? '',
  })

  const save = useMutation({
    mutationFn: async () => (await api.patch(`/ledger/subsidiaries/${party.id}/tax`, form)).data,
    onSuccess: () => {
      toast.success('هویت مالیاتی ثبت شد')
      setEdit(false)
      qc.invalidateQueries({ queryKey: ['ledger'] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? 'ثبت ناموفق بود'),
  })

  const spec = PERSON_TYPES.find((t) => t.key === form.taxPersonType)
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }))

  // همان قاعده‌ای که بک‌اند دارد؛ اینجا فقط برای بازخوردِ فوری تکرار می‌شود
  const problem = !party.taxPersonType
    ? 'نوع شخص مشخص نشده'
    : party.taxPersonType !== 'CONSUMER' && !party.nationalId
      ? 'شناسه ثبت نشده'
      : null

  return (
    <section className="panel">
      <div className="row-between" style={{ marginBottom: 8 }}>
        <div className="section-title" style={{ margin: 0 }}>هویت مالیاتی</div>
        {!edit && (
          <button className="btn-secondary btn-sm" onClick={() => setEdit(true)}>
            {party.taxPersonType ? 'ویرایش' : 'ثبت'}
          </button>
        )}
      </div>

      {!edit ? (
        <>
          {problem && <Alert tint="warning">{problem} — گزارش فصلی ماده ۱۶۹ بدون آن پذیرفته نمی‌شود.</Alert>}
          <table className="data-table" style={{ margin: 0 }}>
            <tbody>
              <tr><td>نوع شخص</td><td style={{ textAlign: 'left' }}>
                {PERSON_TYPES.find((t) => t.key === party.taxPersonType)?.label ?? '—'}
              </td></tr>
              <tr><td>{PERSON_TYPES.find((t) => t.key === party.taxPersonType)?.idLabel ?? 'شناسه'}</td>
                <td className="num" style={{ textAlign: 'left' }}>{party.nationalId ?? '—'}</td></tr>
              <tr><td>کد اقتصادی</td><td className="num" style={{ textAlign: 'left' }}>{party.economicCode ?? '—'}</td></tr>
              <tr><td>کد پستی</td><td className="num" style={{ textAlign: 'left' }}>{party.postalCode ?? '—'}</td></tr>
            </tbody>
          </table>
          {party.taxAddress && <p className="hint" style={{ marginTop: 8 }}>{party.taxAddress}</p>}
        </>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>نوع شخص</label>
            <select value={form.taxPersonType} onChange={(e) => set('taxPersonType', e.target.value)}>
              <option value="">انتخاب کنید…</option>
              {PERSON_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </div>
          {form.taxPersonType !== 'CONSUMER' && (
            <div className="form-group" style={{ margin: 0 }}>
              <label>{spec?.idLabel ?? 'شناسه'}{spec?.digits ? ` (${spec.digits} رقم)` : ''}</label>
              <input className="num" value={form.nationalId} inputMode="numeric"
                onChange={(e) => set('nationalId', e.target.value)} />
            </div>
          )}
          <div className="form-group" style={{ margin: 0 }}>
            <label>کد اقتصادی (۱۲ رقم، اختیاری)</label>
            <input className="num" value={form.economicCode} inputMode="numeric"
              onChange={(e) => set('economicCode', e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>کد پستی</label>
            <input className="num" value={form.postalCode} inputMode="numeric"
              onChange={(e) => set('postalCode', e.target.value)} />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>نشانی مالیاتی</label>
            <textarea rows={2} value={form.taxAddress} onChange={(e) => set('taxAddress', e.target.value)} />
          </div>
          <p className="hint-sm">ارقام فارسی هم پذیرفته می‌شوند و خودکار تبدیل می‌شوند.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate()}>ذخیره</button>
            <button className="btn-secondary btn-sm" onClick={() => setEdit(false)}>انصراف</button>
          </div>
        </div>
      )}
    </section>
  )
}

