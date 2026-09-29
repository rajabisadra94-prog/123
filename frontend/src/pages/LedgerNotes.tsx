import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { nowJalali } from '../lib/date'
import DateField from '../components/shared/DateField'
import { Loading, EmptyState, Alert } from '../components/ui'
import Icon from '../components/ui/Icon'
import ModalPortal from '../components/ui/ModalPortal'
import { dialog, toast } from '../components/ui/dialog'
import { CsvButton } from './LedgerReports'
import { StatementPrintHead, StatementSignatures, PrintButton } from '../components/shared/StatementPrint'
import { fmt, CUR_LABEL } from '../lib/ledgerFormat'

/**
 * یادداشت‌های همراه صورت‌های مالی و فهرست مالیات حقوق — مرحلهٔ ۵ ب.
 */

const SHAMSI_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
]

// ═══════════════════════════════════════════════════════════════
// یادداشت‌های همراه
// ═══════════════════════════════════════════════════════════════

/**
 * **یادداشت‌ها از دفتر ساخته می‌شوند، نه از متنِ دستی.** یادداشتی که کاربر
 * تایپ کند تا ماه بعد کهنه می‌شود و کسی هم نمی‌فهمد. متنِ انسانی جای خودش را
 * دارد — ولی **کنارِ** ریزِ محاسبه‌شده، نه به‌جایش.
 */
export function NotesView() {
  const [asOf, setAsOf] = useState('')
  const [from, setFrom] = useState('')
  const [editor, setEditor] = useState<any | null>(null)
  const [showEditor, setShowEditor] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'notes', asOf, from],
    queryFn: async () => (await api.get('/ledger/notes', {
      params: { asOf: asOf || undefined, from: from || undefined },
    })).data,
  })

  return (
    <div>
      <div className="toolbar no-print">
        <div className="form-group" style={{ margin: 0 }}><label>از</label><DateField value={from} onChange={setFrom} /></div>
        <div className="form-group" style={{ margin: 0 }}><label>تا</label><DateField value={asOf} onChange={setAsOf} /></div>
        <button className="btn-secondary btn-sm" style={{ alignSelf: 'flex-end' }}
          onClick={() => { setEditor(null); setShowEditor(true) }}>
          <Icon name="plus" size={14} /> یادداشت توضیحی
        </button>
        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
          <PrintButton />
          <CsvButton path="/ledger/export/notes" filename="notes.csv"
            params={{ asOf: asOf || undefined, from: from || undefined }} />
        </span>
      </div>

      {isLoading ? <Loading /> : !data ? null : (
        <>
          <StatementPrintHead title="یادداشت‌های همراه صورت‌های مالی" from={data.from} to={data.asOf} />

          {!data.notes.length && !data.standalone.length ? (
            <EmptyState icon={<Icon name="clipboard" />} title="در این بازه گردشی نیست">
              یادداشت‌ها از ریزِ همان حساب‌هایی ساخته می‌شوند که در صورت مالی نشسته‌اند.
            </EmptyState>
          ) : (
            <>
              {data.notes.map((n: any, idx: number) => (
                <section key={n.key} className="panel" style={{ marginBottom: 14 }}>
                  <div className="row-between" style={{ marginBottom: 6 }}>
                    <div className="section-title" style={{ margin: 0 }}>
                      یادداشت {idx + 1} — {n.title}
                    </div>
                    <span className="num" style={{ fontWeight: 800 }}>{fmt(n.total)}</span>
                  </div>
                  <div className="table-container">
                    <table className="data-table">
                      <thead>
                        <tr><th>کد</th><th>شرح</th><th style={{ textAlign: 'left' }}>مبلغ (ریال)</th></tr>
                      </thead>
                      <tbody>
                        {n.rows.map((r: any) => (
                          <tr key={r.code}>
                            <td className="num">{r.code}</td>
                            <td>
                              {r.name}
                              {r.byCurrency.length > 0 && (
                                <div className="hint-sm">
                                  {r.byCurrency.map((c: any) => (
                                    <span key={c.currencyCode} style={{ marginInlineEnd: 10 }}>
                                      {CUR_LABEL[c.currencyCode] ?? c.currencyCode}: {fmt(c.amount, c.currencyCode)}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td className="num" style={{ textAlign: 'left' }}>{fmt(r.amount)}</td>
                          </tr>
                        ))}
                        <tr style={{ fontWeight: 800, borderTop: '2px solid var(--border-strong)' }}>
                          <td colSpan={2}>جمع</td>
                          <td className="num" style={{ textAlign: 'left' }}>{fmt(n.total)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  {n.policy && <p className="hint" style={{ marginTop: 8 }}>{n.policy}</p>}
                  {(n.remarks ?? []).map((rm: any) => (
                    <WrittenNote key={rm.id} note={rm} noteKey={n.key}
                      onEdit={() => { setEditor({ ...rm, noteKey: n.key }); setShowEditor(true) }} />
                  ))}
                </section>
              ))}

              {data.standalone.map((st: any, i: number) => (
                <section key={st.id} className="panel" style={{ marginBottom: 14 }}>
                  <div className="section-title">
                    یادداشت {data.notes.length + i + 1} — {st.title}
                  </div>
                  <WrittenNote note={st} noteKey={null}
                    onEdit={() => { setEditor(st); setShowEditor(true) }} />
                </section>
              ))}
            </>
          )}
          <StatementSignatures />
        </>
      )}

      {showEditor && (
        <NoteEditorModal note={editor} noteKeys={(data?.notes ?? []).map((n: any) => [n.key, n.title])}
          onClose={() => setShowEditor(false)} />
      )}
    </div>
  )
}

function WrittenNote({ note, onEdit }: { note: any; noteKey: string | null; onEdit: () => void }) {
  const qc = useQueryClient()
  const del = useMutation({
    mutationFn: async () => (await api.delete(`/ledger/notes/written/${note.id}`)).data,
    onSuccess: () => { toast.success('حذف شد'); qc.invalidateQueries({ queryKey: ['ledger'] }) },
  })
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
      <div className="row-between">
        <strong style={{ fontSize: 13 }}>{note.title}</strong>
        <span className="no-print" style={{ display: 'flex', gap: 6 }}>
          <button className="btn-secondary btn-sm" onClick={onEdit}>ویرایش</button>
          <button className="btn-secondary btn-sm" onClick={async () => {
            if (await dialog.confirm({ title: 'حذف یادداشت', message: note.title, confirmLabel: 'حذف', tone: 'danger' })) del.mutate()
          }}>حذف</button>
        </span>
      </div>
      <p style={{ margin: '4px 0 0', fontSize: 13, whiteSpace: 'pre-wrap' }}>{note.body}</p>
    </div>
  )
}

function NoteEditorModal({ note, noteKeys, onClose }: {
  note: any | null; noteKeys: [string, string][]; onClose: () => void
}) {
  const qc = useQueryClient()
  const [f, setF] = useState({
    id: note?.id ?? '', noteKey: note?.noteKey ?? '',
    title: note?.title ?? '', body: note?.body ?? '',
    validFrom: '', validTo: '',
  })
  const save = useMutation({
    mutationFn: async () => (await api.post('/ledger/notes/written', {
      ...f, id: f.id || undefined, noteKey: f.noteKey || null,
      validFrom: f.validFrom || undefined, validTo: f.validTo || undefined,
    })).data,
    onSuccess: () => { toast.success('ذخیره شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => toast.error(e?.response?.data?.message ?? 'ذخیره ناموفق بود'),
  })
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }))

  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>{note ? 'ویرایش یادداشت' : 'یادداشت توضیحی جدید'}</h2>
            <button onClick={onClose} aria-label="بستن">✕</button>
          </div>
          <div className="modal-body">
            <Alert tint="info">
              ریزِ حساب‌ها را سیستم می‌سازد. اینجا برای چیزی است که هیچ کوئری‌ای
              نمی‌داند — بدهی احتمالی، معاملات با اشخاص وابسته، رویدادهای پس از
              تاریخ ترازنامه.
            </Alert>
            <div className="form-group">
              <label>ذیل کدام یادداشت؟</label>
              <select value={f.noteKey} onChange={(e) => set('noteKey', e.target.value)}>
                <option value="">یادداشت مستقل</option>
                {noteKeys.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>عنوان</label>
              <input value={f.title} onChange={(e) => set('title', e.target.value)} />
            </div>
            <div className="form-group">
              <label>متن</label>
              <textarea rows={5} value={f.body} onChange={(e) => set('body', e.target.value)} />
            </div>
            <div className="grid-2">
              <div className="form-group">
                <label>از تاریخ (اختیاری)</label>
                <DateField value={f.validFrom} onChange={(v) => set('validFrom', v)} />
              </div>
              <div className="form-group">
                <label>تا تاریخ (اختیاری)</label>
                <DateField value={f.validTo} onChange={(v) => set('validTo', v)} />
              </div>
            </div>
            <p className="hint-sm">
              بازهٔ خالی یعنی همیشه. یادداشتی که فقط به یک سال مربوط است را
              محدود کنید تا سال بعد خودبه‌خود کنار برود.
            </p>
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

// ═══════════════════════════════════════════════════════════════
// فهرست مالیات حقوق
// ═══════════════════════════════════════════════════════════════
export function PayrollTaxView() {
  const j = nowJalali()
  const [year, setYear] = useState(j.jy)
  const [month, setMonth] = useState(Math.max(1, j.jm - 1))

  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'payroll-tax', year, month],
    queryFn: async () => (await api.get('/ledger/payroll-tax-list', {
      params: { year, month },
    })).data,
  })

  return (
    <div>
      <div className="toolbar no-print">
        <div className="form-group" style={{ margin: 0, width: 100 }}>
          <label>سال</label>
          <input className="num" inputMode="numeric" value={year}
            onChange={(e) => setYear(Number(e.target.value) || j.jy)} />
        </div>
        <div className="form-group" style={{ margin: 0, minWidth: 130 }}>
          <label>ماه</label>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            {SHAMSI_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        {data?.found && <span className="hint-sm">{data.rows.length} نفر</span>}
        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
          <PrintButton />
          <CsvButton path="/ledger/export/payroll-tax-list" filename={`payroll-tax-${year}-${month}.csv`}
            params={{ year, month }} />
        </span>
      </div>

      {isLoading ? <Loading /> : !data?.found ? (
        <EmptyState icon={<Icon name="contacts" />} title="لیست حقوق این ماه ثبت نشده">
          فهرست مالیات از لیست حقوقِ همان ماه ساخته می‌شود؛ اول در تب «حقوق و دستمزد» لیست را بسازید.
        </EmptyState>
      ) : (
        <>
          <StatementPrintHead title={`فهرست مالیات حقوق — ${SHAMSI_MONTHS[month - 1]} ${year}`} />

          {data.notReady > 0 && (
            <Alert tint="warning">
              <strong>{data.notReady}</strong> ردیف اطلاعات هویتی کامل ندارد و فهرست با آن‌ها
              پذیرفته نمی‌شود. ستون «وضعیت» می‌گوید هرکدام چه کم دارد.
            </Alert>
          )}
          {data.exemption == null && (
            <Alert tint="danger">
              معافیت مالیاتیِ این دوره در نرخ‌ها تعریف نشده، پس ستون «مشمول» محاسبه نشده است.
              حدس زدنش بدتر از نگفتنش است — عددی که به سازمان اظهار می‌شود نباید تقریبی باشد.
            </Alert>
          )}

          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>کد</th><th>نام</th><th>کد ملی</th><th>بیمه</th><th>روز</th>
                  <th style={{ textAlign: 'left' }}>ناخالص</th>
                  <th style={{ textAlign: 'left' }}>بیمهٔ کارمند</th>
                  <th style={{ textAlign: 'left' }}>مشمول</th>
                  <th style={{ textAlign: 'left' }}>مالیات</th>
                  <th>وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r: any) => (
                  <tr key={r.employeeCode}>
                    <td className="num">{r.employeeCode}</td>
                    <td>{r.name}</td>
                    <td className="num hint-sm">{r.nationalId ?? '—'}</td>
                    <td className="num hint-sm">{r.insuranceNo ?? '—'}</td>
                    <td className="num">{r.workedDays}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt(r.grossPay)}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt(r.insuranceEmployee)}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{r.taxable ? fmt(r.taxable) : '—'}</td>
                    <td className="num" style={{ textAlign: 'left', fontWeight: 700 }}>{fmt(r.tax)}</td>
                    <td className="hint-sm" style={{ color: r.problems.length ? 'var(--warning)' : 'var(--success)' }}>
                      {r.problems.length ? r.problems.join(' · ') : 'آماده'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 800, borderTop: '2px solid var(--border-strong)' }}>
                  <td colSpan={5}>جمع ({data.rows.length} نفر)</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(data.totals.grossPay)}</td>
                  <td />
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(data.totals.taxable)}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(data.totals.tax)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <StatementSignatures />
        </>
      )}
    </div>
  )
}
