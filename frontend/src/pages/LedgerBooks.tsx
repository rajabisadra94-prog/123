import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import { toShamsi, shamsiMonthLabel } from '../lib/date'
import DateField from '../components/shared/DateField'
import SearchableSelect from '../components/shared/SearchableSelect'
import { Loading, EmptyState, Alert } from '../components/ui'
import Icon from '../components/ui/Icon'
import { CsvButton } from './LedgerReports'
import { StatementPrintHead, StatementSignatures, PrintButton } from '../components/shared/StatementPrint'
import { fmt, CUR_LABEL } from '../lib/ledgerFormat'

/**
 * دفاتر قانونی و صورتحساب طرف‌حساب — مرحلهٔ ۵ الف.
 *
 * سامانه «دفتر روزنامه» را به‌عنوان گزارش داشت، ولی دفترِ قانونی یک گزارش
 * نیست؛ سندی صفحه‌بندی‌شده است که به ممیز تحویل می‌شود.
 */

// ═══════════════════════════════════════════════════════════════
// دفتر روزنامهٔ قانونی
// ═══════════════════════════════════════════════════════════════
export function JournalBookView() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [rows, setRows] = useState('25')

  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'book-journal', from, to, rows],
    queryFn: async () => (await api.get('/ledger/books/journal', {
      params: { from: from || undefined, to: to || undefined, rowsPerPage: rows },
    })).data,
  })

  return (
    <div>
      <div className="toolbar no-print">
        <div className="form-group" style={{ margin: 0 }}><label>از</label><DateField value={from} onChange={setFrom} /></div>
        <div className="form-group" style={{ margin: 0 }}><label>تا</label><DateField value={to} onChange={setTo} /></div>
        <div className="form-group" style={{ margin: 0 }}>
          <label>ردیف در صفحه</label>
          <select value={rows} onChange={(e) => setRows(e.target.value)} style={{ width: 90 }}>
            {['20', '25', '30', '40'].map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        {data && <span className="hint-sm">{data.pages.length} صفحه · {data.lineCount} ردیف</span>}
        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
          <PrintButton />
          <CsvButton path="/ledger/export/books/journal" filename="journal-book.csv"
            params={{ from: from || undefined, to: to || undefined }} />
        </span>
      </div>

      {isLoading ? <Loading /> : data && (
        <>
          <StatementPrintHead title="دفتر روزنامه" from={data.from} to={data.to} />
          {!data.balanced && (
            <Alert tint="danger">
              جمعِ بدهکار و بستانکار دفتر برابر نیست. دفتری با این وضع قابل ارائه نیست.
            </Alert>
          )}
          {data.pages.map((pg: any) => (
            <div key={pg.pageNo} className="panel" style={{ marginBottom: 14, pageBreakAfter: 'always' }}>
              <div className="row-between" style={{ marginBottom: 6 }}>
                <div className="section-title" style={{ margin: 0 }}>صفحهٔ {pg.pageNo}</div>
                <span className="hint-sm">از {data.pages.length} صفحه</span>
              </div>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>تاریخ</th><th>سند</th><th>شرح</th><th>حساب</th>
                      <th style={{ textAlign: 'left' }}>بدهکار</th>
                      <th style={{ textAlign: 'left' }}>بستانکار</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ background: 'var(--surface-2)', fontWeight: 700 }}>
                      <td colSpan={4}>نقل از صفحهٔ قبل</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(pg.broughtForward.debit)}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(pg.broughtForward.credit)}</td>
                    </tr>
                    {pg.lines.map((l: any, i: number) => (
                      <tr key={i} style={l.status === 'REVERSED' ? { opacity: 0.6 } : undefined}>
                        <td style={{ whiteSpace: 'nowrap' }}>{toShamsi(l.date)}</td>
                        <td className="num">{l.serial ?? '—'}</td>
                        <td>
                          {l.description}
                          {l.status === 'REVERSED' && <span className="hint-sm"> (باطل‌شده)</span>}
                          {l.subsidiaryName && <span className="hint-sm"> · {l.subsidiaryName}</span>}
                        </td>
                        <td><span className="num">{l.accountCode}</span> {l.accountName}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{l.debit !== '0' ? fmt(l.debit) : ''}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{l.credit !== '0' ? fmt(l.credit) : ''}</td>
                      </tr>
                    ))}
                    {!pg.lines.length && (
                      <tr><td colSpan={6} className="hint-sm" style={{ textAlign: 'center' }}>ردیفی در این بازه نیست</td></tr>
                    )}
                    <tr style={{ fontWeight: 700 }}>
                      <td colSpan={4}>جمع صفحه</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(pg.pageTotal.debit)}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(pg.pageTotal.credit)}</td>
                    </tr>
                    <tr style={{ background: 'var(--surface-2)', fontWeight: 800, borderTop: '2px solid var(--border-strong)' }}>
                      <td colSpan={4}>نقل به صفحهٔ بعد</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(pg.carriedForward.debit)}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(pg.carriedForward.credit)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <StatementSignatures />
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// دفتر کل قانونی
// ═══════════════════════════════════════════════════════════════
export function GeneralBookView() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'book-general', from, to],
    queryFn: async () => (await api.get('/ledger/books/general', {
      params: { from: from || undefined, to: to || undefined },
    })).data,
  })

  return (
    <div>
      <div className="toolbar no-print">
        <div className="form-group" style={{ margin: 0 }}><label>از</label><DateField value={from} onChange={setFrom} /></div>
        <div className="form-group" style={{ margin: 0 }}><label>تا</label><DateField value={to} onChange={setTo} /></div>
        {data && <span className="hint-sm">{data.sections.length} حساب کل</span>}
        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
          <PrintButton />
          <CsvButton path="/ledger/export/books/general" filename="general-ledger.csv"
            params={{ from: from || undefined, to: to || undefined }} />
        </span>
      </div>

      {isLoading ? <Loading /> : data && (
        <>
          <StatementPrintHead title="دفتر کل" from={data.from} to={data.to} />
          {data.sections.map((sec: any) => (
            <div key={sec.code} className="panel" style={{ marginBottom: 14 }}>
              <div className="section-title">
                <span className="num">{sec.code}</span> {sec.name}
              </div>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>ماه</th>
                      <th style={{ textAlign: 'left' }}>بدهکار</th>
                      <th style={{ textAlign: 'left' }}>بستانکار</th>
                      <th style={{ textAlign: 'left' }}>مانده</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ background: 'var(--surface-2)' }}>
                      <td>مانده ابتدای دوره</td><td /><td />
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(sec.opening)}</td>
                    </tr>
                    {sec.rows.map((r: any, i: number) => (
                      <tr key={i}>
                        <td>{shamsiMonthLabel(r.month)}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{r.debit !== '0' ? fmt(r.debit) : '—'}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{r.credit !== '0' ? fmt(r.credit) : '—'}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{fmt(r.running)}</td>
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 800, borderTop: '2px solid var(--border-strong)' }}>
                      <td>جمع</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(sec.totalDebit)}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(sec.totalCredit)}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(sec.closing)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <StatementSignatures />
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// صورتحساب طرف‌حساب
// ═══════════════════════════════════════════════════════════════

/**
 * فرقش با «پروندهٔ طرف‌حساب» این است که پرونده برای **ما**ست و صورتحساب برای
 * **او**: کد حساب و شمارهٔ سند داخلی نمی‌آید، و یک جملهٔ روشن می‌گوید چه کسی
 * به چه کسی بدهکار است.
 */
export function PartyStatementView() {
  const [subsidiaryId, setSubsidiaryId] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const { data: subs } = useQuery({
    queryKey: ['ledger', 'subsidiaries'],
    queryFn: async () => (await api.get('/ledger/subsidiaries')).data as any[],
  })
  const { data, isLoading } = useQuery({
    enabled: !!subsidiaryId,
    queryKey: ['ledger', 'party-statement', subsidiaryId, from, to],
    queryFn: async () => (await api.get(`/ledger/party-statement/${subsidiaryId}`, {
      params: { from: from || undefined, to: to || undefined },
    })).data,
  })

  return (
    <div>
      <div className="toolbar no-print">
        <div className="form-group" style={{ margin: 0, minWidth: 220 }}>
          <label>طرف‌حساب</label>
          <SearchableSelect value={subsidiaryId} onChange={setSubsidiaryId} placeholder="انتخاب…"
            options={(subs ?? []).map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }))} />
        </div>
        <div className="form-group" style={{ margin: 0 }}><label>از</label><DateField value={from} onChange={setFrom} /></div>
        <div className="form-group" style={{ margin: 0 }}><label>تا</label><DateField value={to} onChange={setTo} /></div>
        {subsidiaryId && (
          <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
            <PrintButton label="چاپ صورتحساب" />
            <CsvButton path={`/ledger/export/party-statement/${subsidiaryId}`}
              filename="statement.csv" params={{ from: from || undefined, to: to || undefined }} />
          </span>
        )}
      </div>

      {!subsidiaryId ? (
        <EmptyState icon={<Icon name="contacts" />} title="طرف‌حساب را انتخاب کنید">
          صورتحساب برای فرستادن به خودِ طرف‌حساب است — بدون کد حساب و شمارهٔ سند داخلی.
        </EmptyState>
      ) : isLoading ? <Loading /> : data && (
        <>
          <StatementPrintHead
            title={`صورتحساب — ${data.party.name}`}
            from={data.from} to={data.to}
          />
          {data.empty ? (
            <EmptyState title="تراکنشی در این بازه نیست" />
          ) : data.currencies.map((c: any) => (
            <div key={c.currencyCode} className="panel" style={{ marginBottom: 14 }}>
              <div className="section-title">
                {CUR_LABEL[c.currencyCode] ?? c.currencyCode}
              </div>
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>تاریخ</th><th>شرح</th>
                      <th style={{ textAlign: 'left' }}>بدهکار</th>
                      <th style={{ textAlign: 'left' }}>بستانکار</th>
                      <th style={{ textAlign: 'left' }}>مانده</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ background: 'var(--surface-2)' }}>
                      <td colSpan={4}>مانده ابتدای دوره</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(c.opening, c.currencyCode)}</td>
                    </tr>
                    {c.lines.map((l: any, i: number) => (
                      <tr key={i}>
                        <td style={{ whiteSpace: 'nowrap' }}>{toShamsi(l.date)}</td>
                        <td>{l.description}{l.memo ? <span className="hint-sm"> — {l.memo}</span> : null}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{l.debit !== '0' ? fmt(l.debit, c.currencyCode) : ''}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{l.credit !== '0' ? fmt(l.credit, c.currencyCode) : ''}</td>
                        <td className="num" style={{ textAlign: 'left' }}>{fmt(l.running, c.currencyCode)}</td>
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 700 }}>
                      <td colSpan={2}>جمع دوره</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(c.totalDebit, c.currencyCode)}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(c.totalCredit, c.currencyCode)}</td>
                      <td />
                    </tr>
                    <tr style={{ fontWeight: 800, borderTop: '2px solid var(--border-strong)' }}>
                      <td colSpan={4}>مانده پایان دوره — {c.verdict}</td>
                      <td className="num" style={{ textAlign: 'left' }}>{fmt(c.closing, c.currencyCode)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <StatementSignatures />
        </>
      )}
    </div>
  )
}
