import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { toShamsi } from '../lib/date'
import DateField from '../components/shared/DateField'
import NumberInput from '../components/shared/NumberInput'
import SearchableSelect from '../components/shared/SearchableSelect'
import { Loading, EmptyState, Alert } from '../components/ui'
import Icon from '../components/ui/Icon'
import ModalPortal from '../components/ui/ModalPortal'
import { dialog, toast } from '../components/ui/dialog'
import { fmt, signColor, CUR_LABEL, CUR_LIST } from '../lib/ledgerFormat'

/**
 * فاز ۵ — چک و تنخواه‌گردان روی هستهٔ جدید.
 *
 * چک: هر انتقال وضعیت یک سند می‌زند؛ گذارهای مجاز از خود سرور می‌آیند (`nextStates`).
 * تنخواه: مدل imprest — «شارژ» مبلغش را خودش حساب می‌کند (سقف − مانده)، از کاربر نمی‌پرسد.
 * همهٔ مبالغ از سرور رشته‌اند و در کوچک‌ترین واحد ارز — قالب‌بندی با BigInt.
 */


// ─── کمکی‌های مشترک فرم ───────────────────────────────────────
function Modal({ title, onClose, children, footer, width = 560 }: any) {
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
const curSelect = (v: string, set: (v: string) => void) => (
  <select style={{ width: 96 }} value={v} onChange={(e) => set(e.target.value)}>
    {CUR_LIST.map((c) => <option key={c} value={c}>{CUR_LABEL[c]}</option>)}
  </select>
)

/** حساب‌های نقد/بانکِ شرکت — بدون تفصیلی اجباری، سرفصل ۱۱۰۱ */
function useCashAccounts() {
  const { data } = useQuery({
    queryKey: ['ledger', 'accounts'],
    queryFn: async () => (await api.get('/ledger/accounts')).data as { accounts: any[] },
  })
  return (data?.accounts ?? []).filter(
    (a) => a.isPostable && a.isActive && !a.requiresSubsidiary && a.code.startsWith('1101'),
  )
}
function useSubsidiaries() {
  const { data } = useQuery({
    queryKey: ['ledger', 'subsidiaries'],
    queryFn: async () => (await api.get('/ledger/subsidiaries')).data as any[],
  })
  return data ?? []
}

// ═══════════════════════════════════════════════════════════════
// چک
// ═══════════════════════════════════════════════════════════════
const CHEQUE_STATUS: Record<string, string> = {
  IN_HAND: 'نزد صندوق', IN_COLLECTION: 'در جریان وصول', COLLECTED: 'وصول‌شده',
  ENDORSED: 'خرج‌شده', PLEDGED: 'وثیقه', ISSUED: 'صادرشده',
  CLEARED: 'پاس‌شده', VOIDED: 'باطل‌شده', BOUNCED: 'برگشتی',
}
const CHEQUE_STATUS_TONE: Record<string, string> = {
  COLLECTED: 'var(--success)', CLEARED: 'var(--success)',
  BOUNCED: 'var(--danger)', VOIDED: 'var(--text-muted)', ENDORSED: 'var(--text-muted)',
  IN_HAND: 'var(--brand)', ISSUED: 'var(--brand)',
  IN_COLLECTION: 'var(--warning)', PLEDGED: 'var(--warning)',
}
const RECEIVE_KINDS = new Set(['CUSTOMER', 'OTHER'])
const PAYABLE_KINDS = new Set(['PRODUCER', 'SUPPLIER', 'CARRIER', 'AGENT', 'EXCHANGE', 'OTHER'])

function ChequeBadge({ status }: { status: string }) {
  return (
    <span className="chip" style={{ background: 'var(--surface-2)', color: CHEQUE_STATUS_TONE[status] ?? 'var(--text)', fontWeight: 650 }}>
      {CHEQUE_STATUS[status] ?? status}
    </span>
  )
}

export function ChequeTab() {
  const [direction, setDirection] = useState<'' | 'RECEIVED' | 'ISSUED'>('')
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState<null | 'RECEIVED' | 'ISSUED'>(null)
  const [detailId, setDetailId] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'cheques', direction, status],
    queryFn: async () => (await api.get('/ledger/cheques', {
      params: { direction: direction || undefined, status: status || undefined },
    })).data as any[],
  })
  const overdue = useQuery({
    queryKey: ['ledger', 'cheques', 'overdue'],
    queryFn: async () => (await api.get('/ledger/cheques/overdue')).data as any[],
  })

  const rows = data ?? []

  return (
    <div>
      <div className="toolbar">
        <button className="btn-primary" onClick={() => setOpen('RECEIVED')}><Icon name="plus" size={15} /> دریافت چک</button>
        <button className="btn-secondary" onClick={() => setOpen('ISSUED')}><Icon name="plus" size={15} /> صدور چک</button>
        <div className="settings-tabs" style={{ margin: 0, marginInlineStart: 8 }}>
          {([['', 'همه'], ['RECEIVED', 'دریافتی'], ['ISSUED', 'پرداختی']] as const).map(([d, l]) => (
            <button key={d} className={`tab-btn ${direction === d ? 'active' : ''}`} onClick={() => setDirection(d)}>{l}</button>
          ))}
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 150 }}>
          <option value="">هر وضعیت</option>
          {Object.entries(CHEQUE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <span className="hint-sm">{rows.length} چک</span>
      </div>

      {(overdue.data?.length ?? 0) > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Alert tint="warning">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              <Icon name="clock" size={15} />
              {overdue.data!.length} چک سررسیدشده و تعیین‌تکلیف‌نشده — {overdue.data!.slice(0, 4).map((c: any) => c.number).join('، ')}
              {overdue.data!.length > 4 ? ' …' : ''}
            </span>
          </Alert>
        </div>
      )}

      {isLoading ? <Loading /> : !rows.length ? (
        <EmptyState icon={<Icon name="clipboard" />} title="چکی ثبت نشده">
          «دریافت چک» برای چکِ گرفته‌شده از مشتری (طلب تجاری بسته می‌شود، اسناد دریافتنی باز) ·
          «صدور چک» برای چکی که شرکت می‌نویسد.
        </EmptyState>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead><tr>
              <th>شماره</th><th>بانک</th><th>طرف‌حساب</th><th>نوع</th>
              <th style={{ textAlign: 'left' }}>مبلغ</th><th>سررسید</th><th>وضعیت</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map((c: any) => (
                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setDetailId(c.id)}>
                  <td className="num">{c.number}</td>
                  <td>{c.bankName}</td>
                  <td>{c.subsidiary?.name ?? '—'}</td>
                  <td className="hint-sm">{c.direction === 'RECEIVED' ? 'دریافتی' : 'پرداختی'}</td>
                  <td className="num" style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>
                    {fmt(c.amount, c.currencyCode)} <span className="hint-sm">{CUR_LABEL[c.currencyCode] ?? c.currencyCode}</span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{toShamsi(c.dueDate)}</td>
                  <td><ChequeBadge status={c.status} /></td>
                  <td style={{ textAlign: 'left' }}><Icon name="repeat" size={14} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <ChequeFormModal direction={open} onClose={() => setOpen(null)} />}
      {detailId && <ChequeDetailModal id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  )
}

function ChequeFormModal({ direction, onClose }: { direction: 'RECEIVED' | 'ISSUED'; onClose: () => void }) {
  const qc = useQueryClient()
  const subs = useSubsidiaries()
  const isReceive = direction === 'RECEIVED'
  const kinds = isReceive ? RECEIVE_KINDS : PAYABLE_KINDS

  const [number, setNumber] = useState('')
  const [bankName, setBankName] = useState('')
  const [sayadId, setSayadId] = useState('')
  const [currencyCode, setCurrencyCode] = useState('IRR')
  const [amount, setAmount] = useState('')
  const [issueDate, setIssueDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [subsidiaryId, setSubsidiaryId] = useState('')
  const [note, setNote] = useState('')

  const save = useMutation({
    mutationFn: async () => (await api.post(`/ledger/cheques/${isReceive ? 'receive' : 'issue'}`, {
      number, bankName, sayadId, currencyCode, amount, issueDate, dueDate, subsidiaryId, note,
    })).data,
    onSuccess: () => { toast.success(isReceive ? 'چک دریافت شد' : 'چک صادر شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'ثبت چک ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const opts = subs.filter((s: any) => kinds.has(s.kind)).map((s: any) => ({ value: s.id, label: `${s.code} — ${s.name}` }))
  const canSave = number && bankName && amount && issueDate && dueDate && subsidiaryId

  return (
    <Modal
      title={isReceive ? 'دریافت چک از مشتری' : 'صدور چک به طرف‌حساب'}
      onClose={onClose} width={640}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className="btn-primary" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ثبت…' : 'ثبت'}
        </button>
      </>}
    >
      <p className="hint-sm" style={{ margin: 0 }}>
        {isReceive
          ? 'طلب تجاری بسته می‌شود و «اسناد دریافتنی» باز — این تسویه نیست، فقط شکل طلب عوض می‌شود.'
          : 'بدهی تجاری به «اسناد پرداختنی» منتقل می‌شود.'}
      </p>
      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        <Field label="شماره چک"><input value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
        <Field label="بانک" grow><input value={bankName} onChange={(e) => setBankName(e.target.value)} /></Field>
        <Field label="شناسهٔ صیاد (اختیاری)"><input value={sayadId} onChange={(e) => setSayadId(e.target.value)} /></Field>
      </div>
      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        <Field label="ارز">{curSelect(currencyCode, setCurrencyCode)}</Field>
        <Field label={`مبلغ (${CUR_LABEL[currencyCode]})`} grow>
          <NumberInput value={amount} onChange={setAmount} decimals placeholder="0" />
        </Field>
      </div>
      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        <Field label="تاریخ صدور"><DateField value={issueDate} onChange={setIssueDate} /></Field>
        <Field label="سررسید"><DateField value={dueDate} onChange={setDueDate} /></Field>
      </div>
      <Field label={isReceive ? 'مشتریِ صادرکننده' : 'طرف‌حساب گیرنده'}>
        <SearchableSelect value={subsidiaryId} onChange={setSubsidiaryId} options={opts} placeholder="انتخاب طرف‌حساب" />
      </Field>
      <Field label="یادداشت (اختیاری)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="بابت…" /></Field>
    </Modal>
  )
}

function ChequeDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const cash = useCashAccounts()
  const subs = useSubsidiaries()
  const [target, setTarget] = useState('')
  const [cashAccountCode, setCashAccountCode] = useState('')
  const [endorseTo, setEndorseTo] = useState('')
  const [date, setDate] = useState('')

  const { data: c, isLoading } = useQuery({
    queryKey: ['ledger', 'cheque', id],
    queryFn: async () => (await api.get(`/ledger/cheques/${id}`)).data,
  })

  const move = useMutation({
    mutationFn: async () => (await api.post(`/ledger/cheques/${id}/transition`, {
      to: target, cashAccountCode, endorseToSubsidiaryId: endorseTo, date,
    })).data,
    onSuccess: () => { toast.success('وضعیت چک تغییر کرد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'انتقال ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const needsCash = target === 'COLLECTED' || target === 'CLEARED'
  const needsEndorse = target === 'ENDORSED'
  const canMove = target && (!needsCash || cashAccountCode) && (!needsEndorse || endorseTo)

  return (
    <Modal title={c ? `چک ${c.number} — ${c.bankName}` : 'چک'} onClose={onClose} width={760}>
      {isLoading || !c ? <Loading /> : (
        <>
          <div className="grid-3">
            <div><span className="hint-sm">مبلغ</span><div className="num">{fmt(c.amount, c.currencyCode)} {CUR_LABEL[c.currencyCode] ?? c.currencyCode}</div></div>
            <div><span className="hint-sm">طرف‌حساب</span><div>{c.subsidiary?.name ?? '—'}</div></div>
            <div><span className="hint-sm">وضعیت</span><div><ChequeBadge status={c.status} /></div></div>
            <div><span className="hint-sm">تاریخ صدور</span><div>{toShamsi(c.issueDate)}</div></div>
            <div><span className="hint-sm">سررسید</span><div>{toShamsi(c.dueDate)}</div></div>
            <div><span className="hint-sm">جهت</span><div>{c.direction === 'RECEIVED' ? 'دریافتی' : 'پرداختی'}</div></div>
          </div>
          {c.note && <p className="hint-sm" style={{ margin: 0 }}>یادداشت: {c.note}</p>}

          <div className="section-title" style={{ marginBottom: 6 }}>تاریخچهٔ گذارها</div>
          <div className="table-container">
            <table className="data-table">
              <thead><tr><th>از</th><th>به</th><th>تاریخ</th><th>سند</th></tr></thead>
              <tbody>
                {c.transitions.map((t: any) => (
                  <tr key={t.id}>
                    <td className="hint-sm">{t.fromState ? (CHEQUE_STATUS[t.fromState] ?? t.fromState) : '—'}</td>
                    <td>{CHEQUE_STATUS[t.toState] ?? t.toState}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{toShamsi(t.at)}</td>
                    <td className="num">#{t.entry?.serial ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {c.nextStates.length === 0 ? (
            <Alert tint="info">این وضعیت پایانی است — گذار بعدی ندارد.</Alert>
          ) : (
            <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="section-title" style={{ margin: 0 }}>انتقال وضعیت</div>
              <div className="settings-tabs" style={{ margin: 0, flexWrap: 'wrap' }}>
                {c.nextStates.map((s: string) => (
                  <button key={s} className={`tab-btn ${target === s ? 'active' : ''}`} onClick={() => setTarget(s)}>
                    {CHEQUE_STATUS[s] ?? s}
                  </button>
                ))}
              </div>
              {needsCash && (
                <Field label="حساب نقدی شرکت">
                  <SearchableSelect value={cashAccountCode} onChange={setCashAccountCode}
                    options={cash.map((a: any) => ({ value: a.code, label: `${a.code} — ${a.name}` }))} placeholder="انتخاب حساب" />
                </Field>
              )}
              {needsEndorse && (
                <Field label="طرف‌حسابی که چک به او داده می‌شود">
                  <SearchableSelect value={endorseTo} onChange={setEndorseTo}
                    options={subs.filter((s: any) => PAYABLE_KINDS.has(s.kind)).map((s: any) => ({ value: s.id, label: `${s.code} — ${s.name}` }))}
                    placeholder="انتخاب طرف‌حساب" />
                </Field>
              )}
              <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
                <Field label="تاریخ سند"><DateField value={date} onChange={setDate} /></Field>
                <button className="btn-primary" disabled={!canMove || move.isPending} onClick={() => move.mutate()}>
                  {move.isPending ? 'در حال ثبت…' : 'ثبت گذار'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}

// ═══════════════════════════════════════════════════════════════
// تنخواه‌گردان
// ═══════════════════════════════════════════════════════════════
export function PettyCashTab() {
  const [showNew, setShowNew] = useState(false)
  const [action, setAction] = useState<{ fund: any; kind: 'allocate' | 'expense' | 'replenish' | 'settle' } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['ledger', 'petty-cash'],
    queryFn: async () => (await api.get('/ledger/petty-cash')).data as any[],
  })

  const funds = data ?? []

  return (
    <div>
      <div className="toolbar">
        <button className="btn-primary" onClick={() => setShowNew(true)}><Icon name="plus" size={15} /> صندوق تنخواه جدید</button>
        <span className="hint-sm">مدل imprest: مانده + رسیدهای خرج‌نشده همیشه باید برابر سقف باشد.</span>
      </div>

      {isLoading ? <Loading /> : !funds.length ? (
        <EmptyState icon={<Icon name="wallet" />} title="صندوق تنخواهی نیست">
          یک صندوق با سقف ثابت بسازید، به تنخواه‌دار تخصیص دهید، هزینه‌ها را ثبت کنید و در پایان دوره «شارژ» یا «تسویه» کنید.
        </EmptyState>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead><tr>
              <th>نام</th><th>تنخواه‌دار</th><th>ارز</th>
              <th style={{ textAlign: 'left' }}>سقف</th>
              <th style={{ textAlign: 'left' }}>مانده</th>
              <th style={{ textAlign: 'left' }}>خرج‌شده</th>
              <th>وضعیت</th><th></th>
            </tr></thead>
            <tbody>
              {funds.map((f: any) => {
                const spent = (BigInt(f.floatAmount) - BigInt(f.balance)).toString()
                return (
                  <tr key={f.id} style={f.isActive ? undefined : { opacity: 0.55 }}>
                    <td>{f.name}</td>
                    <td>{f.subsidiary?.name ?? '—'}</td>
                    <td className="hint-sm">{CUR_LABEL[f.currencyCode] ?? f.currencyCode}</td>
                    <td className="num" style={{ textAlign: 'left' }}>{fmt(f.floatAmount, f.currencyCode)}</td>
                    <td className="num" style={{ textAlign: 'left', color: signColor(f.balance) }}>{f.isActive ? fmt(f.balance, f.currencyCode) : '—'}</td>
                    <td className="num" style={{ textAlign: 'left', color: 'var(--text-muted)' }}>{f.isActive ? fmt(spent, f.currencyCode) : '—'}</td>
                    <td className="hint-sm">{f.isActive ? 'فعال' : 'بسته'}</td>
                    <td>
                      {f.isActive && (
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          <button className="btn-secondary btn-sm" onClick={() => setAction({ fund: f, kind: 'allocate' })}>تخصیص</button>
                          <button className="btn-secondary btn-sm" onClick={() => setAction({ fund: f, kind: 'expense' })}>هزینه</button>
                          <button className="btn-secondary btn-sm" onClick={() => setAction({ fund: f, kind: 'replenish' })}>شارژ</button>
                          <button className="btn-danger btn-sm" onClick={() => setAction({ fund: f, kind: 'settle' })}>تسویه</button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showNew && <FundFormModal onClose={() => setShowNew(false)} />}
      {action && <FundActionModal {...action} onClose={() => setAction(null)} />}
    </div>
  )
}

function FundFormModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const subs = useSubsidiaries()
  const [name, setName] = useState('')
  const [currencyCode, setCurrencyCode] = useState('IRR')
  const [floatAmount, setFloatAmount] = useState('')
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [subsidiaryId, setSubsidiaryId] = useState('')
  const [holderName, setHolderName] = useState('')

  const eligible = subs.filter((s: any) => s.kind === 'PETTY_CASH_HOLDER' || s.kind === 'EMPLOYEE')

  const save = useMutation({
    mutationFn: async () => {
      let sid = subsidiaryId
      if (mode === 'new') {
        sid = (await api.post('/ledger/subsidiaries', { kind: 'PETTY_CASH_HOLDER', name: holderName })).data.id
      }
      return (await api.post('/ledger/petty-cash', { name, subsidiaryId: sid, currencyCode, floatAmount })).data
    },
    onSuccess: () => { toast.success('صندوق تنخواه ساخته شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'ساخت صندوق ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const canSave = name && floatAmount && (mode === 'existing' ? subsidiaryId : holderName)

  return (
    <Modal
      title="صندوق تنخواه جدید" onClose={onClose}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className="btn-primary" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ساخت…' : 'ساخت'}
        </button>
      </>}
    >
      <Field label="نام صندوق"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="تنخواه دفتر مرکزی" /></Field>
      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        <Field label="ارز">{curSelect(currencyCode, setCurrencyCode)}</Field>
        <Field label={`سقف ثابت صندوق (${CUR_LABEL[currencyCode]})`} grow>
          <NumberInput value={floatAmount} onChange={setFloatAmount} decimals placeholder="0" />
        </Field>
      </div>

      <div className="settings-tabs" style={{ margin: 0 }}>
        <button className={`tab-btn ${mode === 'existing' ? 'active' : ''}`} onClick={() => setMode('existing')}>تنخواه‌دار موجود</button>
        <button className={`tab-btn ${mode === 'new' ? 'active' : ''}`} onClick={() => setMode('new')}>تنخواه‌دار جدید</button>
      </div>
      {mode === 'existing' ? (
        <Field label="تنخواه‌دار">
          <SearchableSelect value={subsidiaryId} onChange={setSubsidiaryId}
            options={eligible.map((s: any) => ({ value: s.id, label: `${s.code} — ${s.name}` }))}
            placeholder={eligible.length ? 'انتخاب تفصیلی' : 'تفصیلی تنخواه‌دار موجود نیست — «جدید» را بزنید'} />
        </Field>
      ) : (
        <Field label="نام تنخواه‌دار جدید">
          <input value={holderName} onChange={(e) => setHolderName(e.target.value)} placeholder="نام و نام‌خانوادگی" />
        </Field>
      )}
      <p className="hint-sm" style={{ margin: 0 }}>هر تنخواه‌دار فقط یک صندوق فعال دارد.</p>
    </Modal>
  )
}

const FUND_ACTION_LABEL: Record<string, string> = {
  allocate: 'تخصیص نقد به تنخواه', expense: 'ثبت هزینهٔ تنخواه',
  replenish: 'شارژ مجدد تا سقف', settle: 'تسویهٔ نهایی و بستن صندوق',
}

function FundActionModal({ fund, kind, onClose }: { fund: any; kind: 'allocate' | 'expense' | 'replenish' | 'settle'; onClose: () => void }) {
  const qc = useQueryClient()
  const cash = useCashAccounts()
  const { data: chart } = useQuery({
    queryKey: ['ledger', 'accounts'],
    queryFn: async () => (await api.get('/ledger/accounts')).data as { accounts: any[] },
  })
  const { data: ccs } = useQuery({
    queryKey: ['ledger', 'cost-centers'],
    queryFn: async () => (await api.get('/ledger/cost-centers')).data as any[],
  })

  const [date, setDate] = useState('')
  const [cashAccountCode, setCashAccountCode] = useState('')
  const [amount, setAmount] = useState('')
  const [expenseAccountCode, setExpenseAccountCode] = useState('6201')
  const [costCenterId, setCostCenterId] = useState('')
  const [memo, setMemo] = useState('')

  const expenseAccts = (chart?.accounts ?? []).filter((a: any) => a.isPostable && a.isActive && /^(5|6|7|82)/.test(a.code))
  const balance = BigInt(fund.balance)
  const toReplenish = (BigInt(fund.floatAmount) - balance).toString()

  const save = useMutation({
    mutationFn: async () => {
      const body: any = { date }
      if (kind === 'allocate') Object.assign(body, { cashAccountCode, amount })
      if (kind === 'expense') Object.assign(body, { amount, expenseAccountCode, costCenterId, memo })
      if (kind === 'replenish' || kind === 'settle') Object.assign(body, { cashAccountCode })
      return (await api.post(`/ledger/petty-cash/${fund.id}/${kind}`, body)).data
    },
    onSuccess: (d: any) => {
      const msg = kind === 'replenish' ? `شارژ ${fmt(d.amount, fund.currencyCode)} ${CUR_LABEL[fund.currencyCode]} ثبت شد`
        : kind === 'settle' ? `تسویه شد؛ ${fmt(d.returned, fund.currencyCode)} ${CUR_LABEL[fund.currencyCode]} برگشت`
        : 'ثبت شد'
      toast.success(msg)
      qc.invalidateQueries({ queryKey: ['ledger'] }); onClose()
    },
    onError: (e: any) => dialog.alert({ title: 'ثبت ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const needsCash = kind === 'allocate' || kind === 'replenish' || kind === 'settle'
  const needsAmount = kind === 'allocate' || kind === 'expense'
  const canSave = (!needsCash || cashAccountCode) && (!needsAmount || amount)

  return (
    <Modal
      title={`${FUND_ACTION_LABEL[kind]} — ${fund.name}`} onClose={onClose}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className={kind === 'settle' ? 'btn-danger' : 'btn-primary'} disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ثبت…' : 'ثبت'}
        </button>
      </>}
    >
      <p className="hint-sm" style={{ margin: 0 }}>
        مانده: <b className="num">{fmt(fund.balance, fund.currencyCode)}</b> · سقف: <b className="num">{fmt(fund.floatAmount, fund.currencyCode)}</b> {CUR_LABEL[fund.currencyCode]}
      </p>

      {kind === 'replenish' && (
        <Alert tint="info">
          مبلغ شارژ خودکار حساب می‌شود: سقف − مانده = <b className="num">{fmt(toReplenish, fund.currencyCode)}</b> {CUR_LABEL[fund.currencyCode]}
          {' '}(برابر جمع هزینه‌های ثبت‌شده از آخرین شارژ).
        </Alert>
      )}
      {kind === 'settle' && (
        <Alert tint="warning">ماندهٔ <b className="num">{fmt(fund.balance, fund.currencyCode)}</b> به شرکت برمی‌گردد و صندوق بسته می‌شود.</Alert>
      )}

      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        <Field label="تاریخ سند"><DateField value={date} onChange={setDate} /></Field>
        {needsAmount && (
          <Field label={`مبلغ (${CUR_LABEL[fund.currencyCode]})`} grow>
            <NumberInput value={amount} onChange={setAmount} decimals placeholder="0" />
          </Field>
        )}
      </div>

      {needsCash && (
        <Field label="حساب نقدی شرکت">
          <SearchableSelect value={cashAccountCode} onChange={setCashAccountCode}
            options={cash.map((a: any) => ({ value: a.code, label: `${a.code} — ${a.name}` }))} placeholder="انتخاب حساب" />
        </Field>
      )}

      {kind === 'expense' && (
        <>
          <Field label="حساب هزینه">
            <SearchableSelect value={expenseAccountCode} onChange={setExpenseAccountCode}
              options={expenseAccts.map((a: any) => ({ value: a.code, label: `${a.code} — ${a.name}` }))} placeholder="انتخاب حساب هزینه" />
          </Field>
          <Field label="مرکز هزینه (اختیاری)">
            <select value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)}>
              <option value="">—</option>
              {(ccs ?? []).filter((c: any) => c.isPostable).map((c: any) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
            </select>
          </Field>
          <Field label="شرح"><input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="بابت…" /></Field>
        </>
      )}
    </Modal>
  )
}
