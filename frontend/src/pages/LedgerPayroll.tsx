import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { toShamsi, nowJalali, J_MONTHS } from '../lib/date'
import DateField from '../components/shared/DateField'
import NumberInput from '../components/shared/NumberInput'
import { Loading, TableEmpty, EmptyState, Alert } from '../components/ui'
import Icon from '../components/ui/Icon'
import ModalPortal from '../components/ui/ModalPortal'
import { dialog, toast } from '../components/ui/dialog'
import { fmt } from '../lib/ledgerFormat'

/**
 * فاز ۵ — حقوق و دستمزد روی هستهٔ جدید.
 *
 * قاعدهٔ حاکم (بند ۳-۶): هیچ نرخ قانونی هاردکد نیست. پیش از اولین لیست باید
 * نرخ‌های نسخه‌دار و پلکان مالیات وارد شوند — تب «نرخ‌های قانونی».
 * لیست نهایی‌شده مستقیم عوض نمی‌شود؛ «اصلاح لیست» سند قبلی را برگشت می‌زند و
 * اصلاحیهٔ پیش‌نویس می‌سازد.
 */


function Modal({ title, onClose, children, footer, width = 620 }: any) {
  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: width }} onClick={(e: any) => e.stopPropagation()}>
          <div className="modal-header"><h2>{title}</h2><button onClick={onClose} aria-label="بستن">✕</button></div>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
          {footer && <div className="modal-footer">{footer}</div>}
        </div>
      </div>
    </ModalPortal>
  )
}
function Field({ label, children, grow }: { label: string; children: any; grow?: boolean }) {
  return (
    <div className={`form-group${grow ? ' grow' : ''}`} style={{ margin: 0 }}>
      <label>{label}</label>
      {children}
    </div>
  )
}

const PAYROLL_STATUS: Record<string, string> = { DRAFT: 'پیش‌نویس', FINAL: 'نهایی', AMENDED: 'اصلاح‌شده' }
const PAYROLL_STATUS_TONE: Record<string, string> = { DRAFT: 'var(--warning)', FINAL: 'var(--success)', AMENDED: 'var(--text-muted)' }

// ═══════════════════════════════════════════════════════════════
export function PayrollTab() {
  const [view, setView] = useState<'runs' | 'employees' | 'provisions' | 'rates'>('runs')
  const rates = useQuery({
    queryKey: ['ledger', 'payroll', 'rates'],
    queryFn: async () => (await api.get('/ledger/payroll/rates')).data,
  })

  return (
    <div>
      <div className="toolbar">
        <div className="settings-tabs" style={{ margin: 0 }}>
          {([['runs', 'لیست‌های حقوق'], ['employees', 'کارکنان'], ['provisions', 'پرداخت ذخیره‌ها'], ['rates', 'نرخ‌های قانونی']] as const).map(([k, l]) => (
            <button key={k} className={`tab-btn ${view === k ? 'active' : ''}`} onClick={() => setView(k)}>{l}</button>
          ))}
        </div>
        {rates.data && !rates.data.ready && view !== 'rates' && (
          <button className="btn-secondary btn-sm" onClick={() => setView('rates')}>
            <Icon name="alert" size={14} /> نرخ‌های قانونی ناقص است
          </button>
        )}
      </div>

      {view === 'runs' && <RunsView ready={rates.data?.ready} />}
      {view === 'employees' && <EmployeesView />}
      {view === 'provisions' && <ProvisionsView />}
      {view === 'rates' && <RatesView snapshot={rates.data} isLoading={rates.isLoading} />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// پرداخت ذخیره‌ها — عیدی / سنوات / مرخصی / تسویه‌حساب  (ممیزی ج۱۰)
// ═══════════════════════════════════════════════════════════════
const PROVISION_LABEL: Record<string, string> = { BONUS: 'عیدی', SEVERANCE: 'سنوات', LEAVE: 'مرخصی استفاده‌نشده' }
const PROVISION_ACC: Record<string, string> = { BONUS: '۲۱۰۸', SEVERANCE: '۲۱۰۹', LEAVE: '۲۱۱۰' }

function ProvisionsView() {
  const [payKind, setPayKind] = useState<string | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'payroll', 'provisions'],
    queryFn: async () => (await api.get('/ledger/payroll/provisions')).data as Record<string, string>,
  })

  return (
    <div>
      <p className="hint-sm" style={{ marginTop: 0 }}>
        موتور حقوق هر ماه ذخیره می‌گیرد (بدهکار هزینه، بستانکار ذخیرهٔ ۲۱۰x). اینجا آن ذخیره
        پرداخت می‌شود؛ مابه‌التفاوتِ ذخیره و پرداختِ واقعی به حساب هزینهٔ همان قلم می‌رود.
      </p>
      {isLoading || !data ? <Loading /> : (
        <div className="grid-3">
          {(['BONUS', 'SEVERANCE', 'LEAVE'] as const).map((k) => (
            <div key={k} className="kpi-card" style={{ padding: 16 }}>
              <div className="kpi-value num" style={{ fontSize: 18 }}>{fmt(data[k])}</div>
              <div className="kpi-label">ذخیرهٔ {PROVISION_LABEL[k]} <span className="hint-sm">حساب {PROVISION_ACC[k]} · ریال</span></div>
              <button className="btn-secondary btn-sm" style={{ marginTop: 10 }} onClick={() => setPayKind(k)}>
                <Icon name="banknote" size={14} /> پرداخت
              </button>
            </div>
          ))}
        </div>
      )}
      {payKind && <PayProvisionModal kind={payKind} balance={data?.[payKind] ?? '0'} onClose={() => setPayKind(null)} />}
    </div>
  )
}

function PayProvisionModal({ kind, balance, onClose }: { kind: string; balance: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [amount, setAmount] = useState('')
  const [cashAccountCode, setCashAccountCode] = useState('')
  const [forWhom, setForWhom] = useState('')
  const [date, setDate] = useState('')
  const [trueUp, setTrueUp] = useState(false)
  const [description, setDescription] = useState('')

  const { data: accounts } = useQuery({
    queryKey: ['ledger', 'accounts'],
    queryFn: async () => (await api.get('/ledger/accounts')).data as { accounts: any[] },
  })
  const cash = (accounts?.accounts ?? []).filter(
    (a: any) => a.isPostable && a.isActive && !a.requiresSubsidiary && a.code.startsWith('1101')
      && (a.currencyMode !== 'SINGLE' || a.currencyCode === 'IRR'),
  )

  const save = useMutation({
    mutationFn: async () => (await api.post('/ledger/payroll/provisions/pay', {
      kind, amount, cashAccountCode, date: date || undefined,
      forWhom: forWhom || undefined, trueUp: trueUp ? 'true' : '',
      description: description || undefined,
    })).data,
    onSuccess: () => { toast.success('پرداخت ثبت شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'ثبت پرداخت ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  return (
    <Modal
      title={`پرداخت ذخیرهٔ ${PROVISION_LABEL[kind]}`} onClose={onClose} width={520}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className="btn-primary" disabled={!amount || !cashAccountCode || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ثبت…' : 'ثبت پرداخت'}
        </button>
      </>}
    >
      <p className="hint-sm" style={{ margin: 0 }}>ماندهٔ ذخیره: <b className="num">{fmt(balance)}</b> ریال</p>
      <Field label="مبلغِ پرداخت (ریال)"><NumberInput value={amount} onChange={setAmount} placeholder="0" /></Field>
      <Field label="پرداخت از حساب">
        <select value={cashAccountCode} onChange={(e) => setCashAccountCode(e.target.value)}>
          <option value="">— انتخاب حساب نقدی/بانکی</option>
          {cash.map((a: any) => <option key={a.code} value={a.code}>{a.code} — {a.name}</option>)}
        </select>
      </Field>
      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        <Field label="بابت (نام کارمند/دوره — اختیاری)" grow><input value={forWhom} onChange={(e) => setForWhom(e.target.value)} /></Field>
        <Field label="تاریخ"><DateField value={date} onChange={setDate} /></Field>
      </div>
      <label className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={trueUp} onChange={(e) => setTrueUp(e.target.checked)} />
        تسویهٔ کامل — کلِ ماندهٔ ذخیره بسته شود و مابه‌التفاوت به هزینه/برگشتِ هزینه برود (تسویه‌حساب فردی یا پایان سال)
      </label>
      <Field label="شرح (اختیاری)"><input value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
    </Modal>
  )
}

// ═══════════════════════════════════════════════════════════════
// لیست‌های حقوق
// ═══════════════════════════════════════════════════════════════
function RunsView({ ready }: { ready?: boolean }) {
  const [build, setBuild] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'payroll', 'runs'],
    queryFn: async () => (await api.get('/ledger/payroll/runs')).data as any[],
  })
  const runs = data ?? []

  return (
    <div>
      <div className="toolbar">
        <button className="btn-primary" disabled={!ready} onClick={() => setBuild(true)}>
          <Icon name="plus" size={15} /> لیست حقوق جدید
        </button>
        {!ready && <span className="hint-sm">ابتدا نرخ‌های قانونی را کامل کنید.</span>}
      </div>

      {isLoading ? <Loading /> : !runs.length ? (
        <EmptyState icon={<Icon name="users" />} title="لیست حقوقی ساخته نشده">
          یک دورهٔ شمسی و کارکنانش را انتخاب کنید. نرخ‌ها با تاریخِ همان دوره حل می‌شوند، نه امروز.
        </EmptyState>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead><tr>
              <th>دوره</th><th>وضعیت</th><th>کارکنان</th>
              <th style={{ textAlign: 'left' }}>ناخالص</th>
              <th style={{ textAlign: 'left' }}>خالص</th>
              <th>سند</th>
            </tr></thead>
            <tbody>
              {runs.map((r: any) => (
                <tr key={r.id} style={{ cursor: 'pointer', ...(r.status === 'AMENDED' ? { opacity: 0.6 } : {}) }} onClick={() => setOpenId(r.id)}>
                  <td>{r.year}/{String(r.month).padStart(2, '0')} <span className="hint-sm">{J_MONTHS[r.month - 1]}</span>{r.amendsId ? <span className="hint-sm"> · اصلاحیه</span> : null}</td>
                  <td><span className="chip" style={{ background: 'var(--surface-2)', color: PAYROLL_STATUS_TONE[r.status], fontWeight: 650 }}>{PAYROLL_STATUS[r.status] ?? r.status}</span></td>
                  <td className="num">{r._count.items}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(r.totals?.grossPay)}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(r.totals?.netPay)}</td>
                  <td className="num">{r.entry?.serial ? `#${r.entry.serial}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {build && <RunBuilderModal onClose={() => setBuild(false)} onBuilt={(id) => { setBuild(false); setOpenId(id) }} />}
      {openId && <RunDetailModal id={openId} onClose={() => setOpenId(null)} onNavigate={setOpenId} />}
    </div>
  )
}

/** ردیف‌های ورودی به فرمِ قابل‌ویرایش تبدیل می‌شوند؛ کسورات جمع‌شونده زیر یک بازشو */
function EmployeeRows({ rows, setRows, employees }: { rows: any[]; setRows: (r: any[]) => void; employees: any[] }) {
  const [showDeductions, setShowDeductions] = useState(false)
  const setRow = (i: number, patch: any) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const empName = (id: string) => employees.find((e) => e.id === id)?.name ?? id

  return (
    <>
      <div className="table-container">
        <table className="data-table">
          <thead><tr>
            <th>کارمند</th><th>روز کارکرد</th><th>اضافه‌کاری (س)</th><th>شب‌کاری (س)</th><th>جمعه‌کاری (س)</th>
            {showDeductions && <><th>وام</th><th>مساعده</th><th>سایر</th></>}
            <th></th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.employeeId}>
                <td>{empName(r.employeeId)}</td>
                <td><input className="num" style={{ width: 60 }} inputMode="numeric" value={r.workedDays} onChange={(e) => setRow(i, { workedDays: e.target.value })} /></td>
                <td><input className="num" style={{ width: 70 }} inputMode="decimal" value={r.overtimeHours} onChange={(e) => setRow(i, { overtimeHours: e.target.value })} /></td>
                <td><input className="num" style={{ width: 70 }} inputMode="decimal" value={r.nightHours} onChange={(e) => setRow(i, { nightHours: e.target.value })} /></td>
                <td><input className="num" style={{ width: 70 }} inputMode="decimal" value={r.holidayHours} onChange={(e) => setRow(i, { holidayHours: e.target.value })} /></td>
                {showDeductions && <>
                  <td><input className="num" style={{ width: 100 }} inputMode="numeric" value={r.loanDeduction} onChange={(e) => setRow(i, { loanDeduction: e.target.value })} /></td>
                  <td><input className="num" style={{ width: 100 }} inputMode="numeric" value={r.advanceDeduction} onChange={(e) => setRow(i, { advanceDeduction: e.target.value })} /></td>
                  <td><input className="num" style={{ width: 100 }} inputMode="numeric" value={r.otherDeduction} onChange={(e) => setRow(i, { otherDeduction: e.target.value })} /></td>
                </>}
                <td>
                  <button className="icon-btn danger" aria-label="حذف" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon name="trash" /></button>
                </td>
              </tr>
            ))}
            {!rows.length && <TableEmpty colSpan={showDeductions ? 9 : 6}>کارمندی انتخاب نشده</TableEmpty>}
          </tbody>
        </table>
      </div>
      <label className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={showDeductions} onChange={(e) => setShowDeductions(e.target.checked)} />
        کسورات دستی (وام، مساعده، سایر) — به ریال
      </label>
    </>
  )
}

const blankRow = (employeeId: string) => ({
  employeeId, workedDays: '30', overtimeHours: '0', nightHours: '0', holidayHours: '0',
  loanDeduction: '', advanceDeduction: '', otherDeduction: '',
})

function RunBuilderModal({ onClose, onBuilt }: { onClose: () => void; onBuilt: (id: string) => void }) {
  const qc = useQueryClient()
  const j = nowJalali()
  const [year, setYear] = useState(String(j.jy))
  const [month, setMonth] = useState(String(j.jm))
  const [note, setNote] = useState('')
  const [rows, setRows] = useState<any[]>([])

  const { data: employees } = useQuery({
    queryKey: ['ledger', 'payroll', 'employees'],
    queryFn: async () => (await api.get('/ledger/payroll/employees')).data as any[],
  })
  const active = (employees ?? []).filter((e: any) => e.isActive)

  const save = useMutation({
    mutationFn: async () => (await api.post('/ledger/payroll/runs', {
      year: Number(year), month: Number(month), note,
      rows: rows.map((r) => ({
        employeeId: r.employeeId,
        workedDays: r.workedDays, overtimeHours: r.overtimeHours, nightHours: r.nightHours, holidayHours: r.holidayHours,
        loanDeduction: r.loanDeduction || undefined, advanceDeduction: r.advanceDeduction || undefined, otherDeduction: r.otherDeduction || undefined,
      })),
    })).data,
    onSuccess: (d: any) => { toast.success('لیست پیش‌نویس ساخته شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onBuilt(d.run.id) },
    onError: (e: any) => dialog.alert({ title: 'ساخت لیست ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const selected = new Set(rows.map((r) => r.employeeId))
  const toggle = (id: string) => setRows(selected.has(id) ? rows.filter((r) => r.employeeId !== id) : [...rows, blankRow(id)])
  const addAll = () => setRows(active.filter((e: any) => !selected.has(e.id)).map((e: any) => blankRow(e.id)).concat(rows))

  return (
    <Modal
      title="لیست حقوق جدید" onClose={onClose} width={960}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className="btn-primary" disabled={!rows.length || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ساخت…' : 'ساخت پیش‌نویس'}
        </button>
      </>}
    >
      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        <Field label="سال شمسی">
          <select value={year} onChange={(e) => setYear(e.target.value)} style={{ width: 90 }}>
            {[j.jy - 1, j.jy, j.jy + 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Field>
        <Field label="ماه">
          <select value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 120 }}>
            {J_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </Field>
        <Field label="یادداشت (اختیاری)" grow><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>

      {!active.length ? (
        <Alert tint="warning">کارمند فعالی نیست — ابتدا در تب «کارکنان» کارمند اضافه کنید.</Alert>
      ) : (
        <>
          <div className="row-between">
            <div className="section-title" style={{ margin: 0 }}>کارکنان</div>
            <button className="btn-secondary btn-sm" onClick={addAll} disabled={selected.size === active.length}>افزودن همه</button>
          </div>
          <div className="panel panel-pad" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {active.map((e: any) => (
              <label key={e.id} className="chip" style={{ cursor: 'pointer', background: selected.has(e.id) ? 'var(--brand)' : 'var(--surface-2)', color: selected.has(e.id) ? '#fff' : 'var(--text)' }}>
                <input type="checkbox" style={{ display: 'none' }} checked={selected.has(e.id)} onChange={() => toggle(e.id)} />
                {e.name}
              </label>
            ))}
          </div>
          <EmployeeRows rows={rows} setRows={setRows} employees={active} />
        </>
      )}
    </Modal>
  )
}

function RunDetailModal({ id, onClose, onNavigate }: { id: string; onClose: () => void; onNavigate: (id: string) => void }) {
  const qc = useQueryClient()
  const [finalizeDate, setFinalizeDate] = useState('')
  const [revise, setRevise] = useState(false)

  const { data: run, isLoading } = useQuery({
    queryKey: ['ledger', 'payroll', 'run', id],
    queryFn: async () => (await api.get(`/ledger/payroll/runs/${id}`)).data,
  })

  const finalize = useMutation({
    mutationFn: async () => (await api.post(`/ledger/payroll/runs/${id}/finalize`, { date: finalizeDate })).data,
    onSuccess: () => { toast.success('لیست نهایی و سند ثبت شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'نهایی‌کردن ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })
  const remove = useMutation({
    mutationFn: async () => (await api.delete(`/ledger/payroll/runs/${id}`)).data,
    onSuccess: () => { toast.success('پیش‌نویس حذف شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'حذف ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const t = useMemo(() => {
    const items = run?.items ?? []
    const add = (k: string) => items.reduce((s: bigint, i: any) => s + BigInt(i[k]), 0n)
    return {
      grossPay: add('grossPay'), insuranceEmployee: add('insuranceEmployee'), incomeTax: add('incomeTax'),
      otherDed: add('loanDeduction') + add('advanceDeduction') + add('otherDeduction'),
      netPay: add('netPay'),
      accrualBonus: add('accrualBonus'), accrualSeverance: add('accrualSeverance'), accrualLeave: add('accrualLeave'),
      employerInsurance: add('insuranceEmployer') + add('unemploymentDue'),
    }
  }, [run])

  return (
    <Modal
      title={run ? `لیست حقوق ${run.year}/${String(run.month).padStart(2, '0')} — ${J_MONTHS[run.month - 1]}` : 'لیست حقوق'}
      onClose={onClose} width={1000}
    >
      {isLoading || !run ? <Loading /> : (
        <>
          <div className="row-between">
            <span className="chip" style={{ background: 'var(--surface-2)', color: PAYROLL_STATUS_TONE[run.status], fontWeight: 650 }}>{PAYROLL_STATUS[run.status] ?? run.status}</span>
            <span className="hint-sm">
              {run.entry?.serial ? `سند #${run.entry.serial} · ${toShamsi(run.entry.date)}` : 'هنوز سند ندارد'}
              {run.amends ? ` · اصلاحیهٔ لیست ${run.amends.year}/${String(run.amends.month).padStart(2, '0')}` : ''}
              {run.note ? ` · ${run.note}` : ''}
            </span>
          </div>

          <div className="table-container">
            <table className="data-table">
              <thead><tr>
                <th>کارمند</th>
                <th style={{ textAlign: 'left' }}>ناخالص</th>
                <th style={{ textAlign: 'left' }}>بیمهٔ کارگر</th>
                <th style={{ textAlign: 'left' }}>مالیات</th>
                <th style={{ textAlign: 'left' }}>وام/مساعده/سایر</th>
                <th style={{ textAlign: 'left' }}>خالص</th>
              </tr></thead>
              <tbody>
                {run.items.map((i: any) => (
                  <tr key={i.id}>
                    <td>{i.employee.name} <span className="hint-sm">{i.employee.code}</span></td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt(i.grossPay)}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt(i.insuranceEmployee)}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt(i.incomeTax)}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt((BigInt(i.loanDeduction) + BigInt(i.advanceDeduction) + BigInt(i.otherDeduction)).toString())}</td>
                    <td className="num" style={{ textAlign: 'left', fontWeight: 700 }}>{fmt(i.netPay)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border-strong)', fontWeight: 800 }}>
                  <td>جمع ({run.items.length})</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(t.grossPay)}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(t.insuranceEmployee)}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(t.incomeTax)}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(t.otherDed)}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(t.netPay)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="grid-4">
            {[
              ['بیمهٔ سهم کارفرما', t.employerInsurance], ['ذخیرهٔ عیدی', t.accrualBonus],
              ['ذخیرهٔ سنوات', t.accrualSeverance], ['ذخیرهٔ مرخصی', t.accrualLeave],
            ].map(([label, v]) => (
              <div key={label as string} className="kpi-card" style={{ padding: 12 }}>
                <div className="kpi-value num" style={{ fontSize: 15 }}>{fmt(v as bigint)}</div>
                <div className="kpi-label">{label as string} <span className="hint-sm">ریال</span></div>
              </div>
            ))}
          </div>

          {run.status === 'DRAFT' && (
            <div className="panel panel-pad" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <Field label="تاریخ سند"><DateField value={finalizeDate} onChange={setFinalizeDate} /></Field>
              <button className="btn-primary" disabled={finalize.isPending} onClick={() => finalize.mutate()}>
                {finalize.isPending ? 'در حال ثبت…' : 'نهایی‌کردن و ثبت سند'}
              </button>
              <button className="btn-danger btn-sm" style={{ marginInlineStart: 'auto' }} onClick={async () => {
                if (await dialog.confirm({ title: 'حذف پیش‌نویس', message: 'این لیست پیش‌نویس حذف می‌شود.', confirmLabel: 'حذف', tone: 'danger' })) remove.mutate()
              }}>حذف پیش‌نویس</button>
            </div>
          )}
          {run.status === 'FINAL' && !run.amendedBy && (
            <button className="btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => setRevise(true)}>
              <Icon name="repeat" size={14} /> اصلاح لیست
            </button>
          )}
          {run.status === 'FINAL' && run.amendedBy && (
            <Alert tint="info">این لیست اصلاحیه دارد.</Alert>
          )}
          {run.status === 'AMENDED' && (
            <Alert tint="info">این لیست با یک اصلاحیه جایگزین شده — سندش برگشت خورده است.</Alert>
          )}

          {revise && <ReviseModal run={run} onClose={() => setRevise(false)} onDone={(nid) => { setRevise(false); onNavigate(nid) }} />}
        </>
      )}
    </Modal>
  )
}

function ReviseModal({ run, onClose, onDone }: { run: any; onClose: () => void; onDone: (id: string) => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const [rows, setRows] = useState<any[]>(() => run.items.map((i: any) => ({
    employeeId: i.employeeId,
    workedDays: String(i.workedDays),
    overtimeHours: String(i.overtimeHours), nightHours: String(i.nightHours), holidayHours: String(i.holidayHours),
    loanDeduction: BigInt(i.loanDeduction) ? i.loanDeduction : '',
    advanceDeduction: BigInt(i.advanceDeduction) ? i.advanceDeduction : '',
    otherDeduction: BigInt(i.otherDeduction) ? i.otherDeduction : '',
  })))

  const employees = run.items.map((i: any) => ({ id: i.employeeId, name: i.employee.name }))

  const save = useMutation({
    mutationFn: async () => (await api.post(`/ledger/payroll/runs/${run.id}/revise`, {
      reason,
      rows: rows.map((r) => ({
        employeeId: r.employeeId,
        workedDays: r.workedDays, overtimeHours: r.overtimeHours, nightHours: r.nightHours, holidayHours: r.holidayHours,
        loanDeduction: r.loanDeduction || undefined, advanceDeduction: r.advanceDeduction || undefined, otherDeduction: r.otherDeduction || undefined,
      })),
    })).data,
    onSuccess: (d: any) => { toast.success('اصلاحیهٔ پیش‌نویس ساخته شد — آن را نهایی کنید'); qc.invalidateQueries({ queryKey: ['ledger'] }); onDone(d.run.id) },
    onError: (e: any) => dialog.alert({ title: 'اصلاح ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  return (
    <Modal
      title={`اصلاح لیست ${run.year}/${String(run.month).padStart(2, '0')}`} onClose={onClose} width={960}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className="btn-primary" disabled={!rows.length || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ثبت…' : 'ساخت اصلاحیه'}
        </button>
      </>}
    >
      <Alert tint="warning">
        سند لیست فعلی برگشت می‌خورد و یک لیست اصلاحیِ پیش‌نویس ساخته می‌شود. نرخ‌ها با تاریخِ همان دورهٔ اصلی حساب می‌شوند، نه امروز.
      </Alert>
      <Field label="دلیل اصلاح"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً کارکرد اشتباه ثبت شده بود" /></Field>
      <EmployeeRows rows={rows} setRows={setRows} employees={employees} />
    </Modal>
  )
}

// ═══════════════════════════════════════════════════════════════
// کارکنان
// ═══════════════════════════════════════════════════════════════
function EmployeesView() {
  const [form, setForm] = useState<any | null | undefined>(undefined)  // undefined=بسته، null=جدید، obj=ویرایش
  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'payroll', 'employees'],
    queryFn: async () => (await api.get('/ledger/payroll/employees')).data as any[],
  })
  const rows = data ?? []

  return (
    <div>
      <div className="toolbar">
        <button className="btn-primary" onClick={() => setForm(null)}><Icon name="plus" size={15} /> کارمند جدید</button>
        <span className="hint-sm">هر کارمند یک تفصیلی شناور از نوع «کارمند» است — خالص حقوق روی همین تفصیلی می‌نشیند.</span>
      </div>

      {(() => {
        const gaps = rows.filter((e: any) => e.isActive && (!e.nationalId || !e.insuranceNo))
        return gaps.length ? (
          <Alert tint="warning">
            {gaps.length} کارمند فعال کد ملی یا شمارهٔ بیمه ندارد؛ تا تکمیل نشود
            «فهرست مالیات حقوق» قابل ارسال نیست:{' '}
            {gaps.slice(0, 5).map((e: any) => e.name).join('، ')}
            {gaps.length > 5 ? ` و ${gaps.length - 5} نفر دیگر` : ''}
          </Alert>
        ) : null
      })()}

      {isLoading ? <Loading /> : !rows.length ? (
        <EmptyState icon={<Icon name="users" />} title="کارمندی ثبت نشده" />
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead><tr>
              <th>کد</th><th>نام</th><th>کد ملی</th>
              <th style={{ textAlign: 'left' }}>حقوق پایه</th>
              <th>اولاد</th><th>مرکز هزینه</th><th>وضعیت</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map((e: any) => (
                <tr key={e.id} style={{ opacity: e.isActive ? 1 : 0.5 }}>
                  <td className="num">{e.code}</td>
                  <td>{e.name}</td>
                  {/*
                    نبودنِ کد ملی «اختیاری» است تا وقتی که فهرست مالیات حقوق
                    را بخواهی؛ آن‌جا دیگر اختیاری نیست و ارسال برمی‌گردد. پس
                    خلأ همین‌جا دیده می‌شود، نه در مهلتِ آخرِ اظهارنامه.
                  */}
                  <td className="hint-sm num">
                    {e.nationalId ?? <span style={{ color: 'var(--warning)' }}>ثبت نشده</span>}
                  </td>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(e.baseSalary)}</td>
                  <td className="num">{e.childrenCount}</td>
                  <td className="hint-sm">{e.costCenter ? `${e.costCenter.code} ${e.costCenter.name}` : <span style={{ color: 'var(--warning)' }}>ندارد</span>}</td>
                  <td className="hint-sm">{e.isActive ? 'فعال' : 'غیرفعال'}</td>
                  <td><button className="icon-btn" aria-label="ویرایش" onClick={() => setForm(e)}><Icon name="pencil" /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form !== undefined && <EmployeeFormModal employee={form} onClose={() => setForm(undefined)} />}
    </div>
  )
}

function EmployeeFormModal({ employee, onClose }: { employee: any | null; onClose: () => void }) {
  const qc = useQueryClient()
  const editing = !!employee
  const { data: ccs } = useQuery({
    queryKey: ['ledger', 'cost-centers'],
    queryFn: async () => (await api.get('/ledger/cost-centers')).data as any[],
  })
  const [code, setCode] = useState(employee?.code ?? '')
  const [name, setName] = useState(employee?.name ?? '')
  const [nationalId, setNationalId] = useState(employee?.nationalId ?? '')
  const [insuranceNo, setInsuranceNo] = useState(employee?.insuranceNo ?? '')
  const [hireDate, setHireDate] = useState(employee?.hireDate ? String(employee.hireDate).slice(0, 10) : '')
  const [baseSalary, setBaseSalary] = useState(employee ? String(employee.baseSalary) : '')
  const [childrenCount, setChildrenCount] = useState(String(employee?.childrenCount ?? 0))
  const [isMarried, setIsMarried] = useState(!!employee?.isMarried)
  const [costCenterId, setCostCenterId] = useState(employee?.costCenterId ?? '')
  const [isActive, setIsActive] = useState(employee?.isActive ?? true)

  const save = useMutation({
    mutationFn: async () => {
      const body: any = { name, nationalId, insuranceNo, hireDate, baseSalary, childrenCount: Number(childrenCount) || 0, isMarried, costCenterId: costCenterId || null }
      return editing
        ? (await api.patch(`/ledger/payroll/employees/${employee.id}`, { ...body, isActive })).data
        : (await api.post('/ledger/payroll/employees', { ...body, code })).data
    },
    onSuccess: () => { toast.success(editing ? 'کارمند به‌روز شد' : 'کارمند ساخته شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'ناموفق', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const canSave = name && hireDate && baseSalary && (editing || code)

  return (
    <Modal
      title={editing ? `ویرایش ${employee.name}` : 'کارمند جدید'} onClose={onClose}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className="btn-primary" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ذخیره…' : 'ذخیره'}
        </button>
      </>}
    >
      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        {!editing && <Field label="کد کارمند"><input className="num" value={code} onChange={(e) => setCode(e.target.value)} placeholder="EMP-001" /></Field>}
        <Field label="نام و نام‌خانوادگی" grow><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        {/* «اختیاری» گمراه‌کننده بود: بدون این دو، فهرست مالیات حقوق ساخته نمی‌شود */}
        <Field label="کد ملی (برای فهرست مالیات لازم است)">
          <input className="num" value={nationalId} onChange={(e) => setNationalId(e.target.value)}
            inputMode="numeric" maxLength={10} placeholder="۱۰ رقم" />
        </Field>
        <Field label="شمارهٔ بیمه (برای فهرست مالیات لازم است)">
          <input className="num" value={insuranceNo} onChange={(e) => setInsuranceNo(e.target.value)} />
        </Field>
        <Field label="تاریخ استخدام"><DateField value={hireDate} onChange={setHireDate} /></Field>
      </div>
      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        <Field label="حقوق پایهٔ ماهانه (ریال)" grow><NumberInput value={baseSalary} onChange={setBaseSalary} placeholder="0" /></Field>
        <Field label="تعداد اولاد"><input className="num" style={{ width: 60 }} inputMode="numeric" value={childrenCount} onChange={(e) => setChildrenCount(e.target.value)} /></Field>
      </div>
      <Field label="مرکز هزینهٔ پیش‌فرض">
        <select value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)}>
          <option value="">— (بدون مرکز، لیست حقوق سند نمی‌گیرد)</option>
          {(ccs ?? []).filter((c: any) => c.isPostable).map((c: any) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
        </select>
      </Field>
      <div style={{ display: 'flex', gap: 18 }}>
        <label className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={isMarried} onChange={(e) => setIsMarried(e.target.checked)} /> متأهل
        </label>
        {editing && (
          <label className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} /> فعال
          </label>
        )}
      </div>
    </Modal>
  )
}

// ═══════════════════════════════════════════════════════════════
// نرخ‌های قانونی
// ═══════════════════════════════════════════════════════════════
const RATE_LABEL: Record<string, string> = {
  MIN_WAGE_DAILY: 'حداقل دستمزد روزانه', HOUSING_MONTHLY: 'حق مسکن ماهانه', FOOD_MONTHLY: 'بن کارگری ماهانه',
  CHILD_PER_CHILD: 'حق اولاد (هر فرزند)', SENIORITY_DAILY: 'پایهٔ سنوات روزانه',
  INSURANCE_EMPLOYEE: 'سهم بیمهٔ کارگر (نسبت)', INSURANCE_EMPLOYER: 'سهم بیمهٔ کارفرما (نسبت)',
  UNEMPLOYMENT: 'بیمهٔ بیکاری (نسبت)', INSURANCE_CEILING: 'سقف ماهانهٔ مشمول بیمه (۰ = بی‌سقف)',
  OVERTIME_FACTOR: 'ضریب اضافه‌کاری', NIGHT_FACTOR: 'ضریب شب‌کاری', HOLIDAY_FACTOR: 'ضریب جمعه/تعطیل‌کاری',
  TAX_EXEMPTION_MONTHLY: 'معافیت ماهانهٔ مالیات', BONUS_ACCRUAL_FACTOR: 'ذخیرهٔ عیدی (ضریب سالانه ÷ ۱۲، روی مزد ثابت)',
  SEVERANCE_DAYS_PER_MONTH: 'ذخیرهٔ سنوات (روز در ماه)', LEAVE_DAYS_PER_MONTH: 'ذخیرهٔ مرخصی (روز در ماه)',
  MONTH_DAYS: 'روزهای کاری ماه', MONTH_HOURS: 'ساعات کاری ماه',
  BONUS_INCLUDE_ALLOWANCES: 'پایهٔ عیدی شاملِ حق مسکن و بن (۰ یا ۱)',
  BONUS_CAP_DAYS: 'سقفِ عیدیِ سالانه به روزِ حداقل‌دستمزد (قانون: ۹۰)',
}

function RatesView({ snapshot, isLoading }: { snapshot: any; isLoading: boolean }) {
  const [rateFor, setRateFor] = useState<string | null>(null)
  const [brackets, setBrackets] = useState(false)

  if (isLoading || !snapshot) return <Loading />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!snapshot.ready && (
        <Alert tint="warning">
          نرخ‌های قانونی برای امروز کامل نیست — تا کامل نشود «لیست حقوق جدید» غیرفعال است.
          {snapshot.missing.length > 0 && <span className="hint-sm" style={{ display: 'block', marginTop: 3 }}>
            کمبود: {snapshot.missing.map((k: string) => RATE_LABEL[k] ?? k).join('، ')}
          </span>}
          {snapshot.brackets.length === 0 && <span className="hint-sm" style={{ display: 'block', marginTop: 3 }}>پلکان مالیات تعریف نشده است.</span>}
        </Alert>
      )}

      <div className="panel">
        <div className="panel-hd"><h3>نرخ‌های نسخه‌دار</h3></div>
        <p className="hint-sm" style={{ padding: '10px 20px 0' }}>
          مقدار هر نرخ در دیتابیس می‌نشیند، نه در کد. محاسبهٔ هر دوره با نرخِ معتبرِ همان دوره انجام می‌شود.
          نرخ جدید را با تاریخ شروع اعتبار ثبت کنید؛ نسخهٔ قبلی خودکار بسته می‌شود.
        </p>
        <div className="table-container" style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}>
          <table className="data-table">
            <thead><tr><th>نرخ</th><th style={{ textAlign: 'left' }}>مقدار فعلی</th><th>از تاریخ</th><th></th></tr></thead>
            <tbody>
              {snapshot.keys.map((k: string) => {
                const a = snapshot.active[k]
                return (
                  <tr key={k}>
                    <td>{RATE_LABEL[k] ?? k}</td>
                    <td className="num" style={{ textAlign: 'left', color: a ? 'var(--text)' : 'var(--danger)' }}>
                      {a ? Number(a.value).toLocaleString(undefined, { maximumFractionDigits: 6 }) : 'تعریف نشده'}
                    </td>
                    <td className="hint-sm">{a ? toShamsi(a.validFrom) : '—'}</td>
                    <td><button className="btn-secondary btn-sm" onClick={() => setRateFor(k)}>{a ? 'نسخهٔ جدید' : 'تعریف'}</button></td>
                  </tr>
                )
              })}
              {(snapshot.optionalKeys ?? []).map((o: any) => (
                <tr key={o.key} style={{ opacity: 0.85 }}>
                  <td>{RATE_LABEL[o.key] ?? o.key} <span className="hint-sm">اختیاری</span></td>
                  <td className="num" style={{ textAlign: 'left' }}>
                    {o.value != null
                      ? Number(o.value).toLocaleString(undefined, { maximumFractionDigits: 6 })
                      : <span className="hint-sm">پیش‌فرضِ قانونی: {o.default}</span>}
                  </td>
                  <td className="hint-sm">{o.value != null ? '' : '—'}</td>
                  <td><button className="btn-secondary btn-sm" onClick={() => setRateFor(o.key)}>{o.value != null ? 'نسخهٔ جدید' : 'بازنویسی پیش‌فرض'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-hd">
          <h3>پلکان مالیات حقوق</h3>
          <button className="btn-secondary btn-sm" onClick={() => setBrackets(true)}><Icon name="pencil" size={14} /> ثبت پلکان جدید</button>
        </div>
        <div className="table-container" style={{ border: 'none', boxShadow: 'none', borderRadius: 0 }}>
          <table className="data-table">
            <thead><tr><th style={{ textAlign: 'left' }}>از</th><th style={{ textAlign: 'left' }}>تا</th><th>نرخ</th><th>از تاریخ</th></tr></thead>
            <tbody>
              {snapshot.brackets.map((b: any) => (
                <tr key={b.id}>
                  <td className="num" style={{ textAlign: 'left' }}>{fmt(b.from)}</td>
                  <td className="num" style={{ textAlign: 'left' }}>{b.to ? fmt(b.to) : 'بی‌نهایت'}</td>
                  <td className="num">{(Number(b.rate) * 100).toLocaleString()}٪</td>
                  <td className="hint-sm">{toShamsi(b.validFrom)}</td>
                </tr>
              ))}
              {!snapshot.brackets.length && <TableEmpty colSpan={4}>پلکانی تعریف نشده</TableEmpty>}
            </tbody>
          </table>
        </div>
      </div>

      {rateFor && <RateFormModal rateKey={rateFor} onClose={() => setRateFor(null)} />}
      {brackets && <TaxBracketsModal existing={snapshot.brackets} onClose={() => setBrackets(false)} />}
    </div>
  )
}

function RateFormModal({ rateKey, onClose }: { rateKey: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [value, setValue] = useState('')
  const [validFrom, setValidFrom] = useState('')
  const [note, setNote] = useState('')

  const isRatio = /INSURANCE_EMPLOYEE|INSURANCE_EMPLOYER|UNEMPLOYMENT|FACTOR/.test(rateKey)

  const save = useMutation({
    mutationFn: async () => (await api.post('/ledger/payroll/rates', { key: rateKey, value, validFrom, note })).data,
    onSuccess: () => { toast.success('نرخ ثبت شد'); qc.invalidateQueries({ queryKey: ['ledger', 'payroll'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'ثبت نرخ ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  return (
    <Modal
      title={`نرخ: ${RATE_LABEL[rateKey] ?? rateKey}`} onClose={onClose} width={460}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className="btn-primary" disabled={!value || !validFrom || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ثبت…' : 'ثبت'}
        </button>
      </>}
    >
      <Field label={isRatio ? 'مقدار (نسبت — مثلاً ۰٫۰۷ برای ۷٪)' : 'مقدار'}>
        <NumberInput value={value} onChange={setValue} decimals placeholder={isRatio ? '0.07' : '0'} />
      </Field>
      <Field label="معتبر از تاریخ"><DateField value={validFrom} onChange={setValidFrom} /></Field>
      <Field label="یادداشت (اختیاری)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً بخشنامهٔ …" /></Field>
      <p className="hint-sm" style={{ margin: 0 }}>نسخهٔ قبلیِ همین نرخ خودش تا این تاریخ معتبر می‌ماند؛ لیست‌های قدیمی تغییری نمی‌کنند.</p>
    </Modal>
  )
}

function TaxBracketsModal({ existing, onClose }: { existing: any[]; onClose: () => void }) {
  const qc = useQueryClient()
  const [validFrom, setValidFrom] = useState('')
  const [rows, setRows] = useState<any[]>(
    existing.length
      ? existing.map((b) => ({ from: b.from, to: b.to ?? '', rate: String(Number(b.rate) * 100) }))
      : [{ from: '0', to: '', rate: '' }],
  )

  const setRow = (i: number, patch: any) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const save = useMutation({
    mutationFn: async () => (await api.post('/ledger/payroll/tax-brackets', {
      validFrom,
      brackets: rows.map((r) => ({ from: r.from || '0', to: r.to === '' ? null : r.to, rate: Number(r.rate) / 100 })),
    })).data,
    onSuccess: () => { toast.success('پلکان مالیات ثبت شد'); qc.invalidateQueries({ queryKey: ['ledger', 'payroll'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'ثبت ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  return (
    <Modal
      title="پلکان مالیات حقوق" onClose={onClose} width={620}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className="btn-primary" disabled={!validFrom || !rows.length || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ثبت…' : 'ثبت پلکان'}
        </button>
      </>}
    >
      <Field label="معتبر از تاریخ"><DateField value={validFrom} onChange={setValidFrom} /></Field>
      <p className="hint-sm" style={{ margin: 0 }}>
        هر پله فقط روی بخشی از درآمد که داخل همان پله است اعمال می‌شود. آخرین پله «تا» را خالی بگذارید (بی‌نهایت).
        مبالغ به ریال، نرخ به درصد.
      </p>
      <div className="table-container">
        <table className="data-table">
          <thead><tr><th>از (ریال)</th><th>تا (ریال)</th><th>نرخ (٪)</th><th></th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><input className="num" style={{ width: 130 }} inputMode="numeric" value={r.from} onChange={(e) => setRow(i, { from: e.target.value })} /></td>
                <td><input className="num" style={{ width: 130 }} inputMode="numeric" value={r.to} onChange={(e) => setRow(i, { to: e.target.value })} placeholder="بی‌نهایت" /></td>
                <td><input className="num" style={{ width: 70 }} inputMode="decimal" value={r.rate} onChange={(e) => setRow(i, { rate: e.target.value })} /></td>
                <td>{rows.length > 1 && <button className="icon-btn danger" aria-label="حذف" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Icon name="trash" /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setRows([...rows, { from: '', to: '', rate: '' }])}>
        <Icon name="plus" size={14} /> افزودن پله
      </button>
    </Modal>
  )
}
