import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { fileUrl } from '../lib/api'
import DateField from '../components/shared/DateField'
import NumberInput from '../components/shared/NumberInput'
import SearchableSelect from '../components/shared/SearchableSelect'
import Icon from '../components/ui/Icon'
import ModalPortal from '../components/ui/ModalPortal'
import { dialog, toast } from '../components/ui/dialog'

/**
 * نوار فرمانِ عملیات روزمرهٔ هستهٔ جدید — معادلِ سه پنجرهٔ عملیاتیِ صفحهٔ
 * `/accounting`، ولی روی مدل جدید (تفصیلی شناور، ارز روی فرم، **ریال**).
 *
 * مسیرهای بک‌اند: `POST /ledger/ops/{settlement,conversion,transfer,expense}` و
 * کمکِ نرخ `GET /ledger/fx/today`.
 */

const CUR_LABEL: Record<string, string> = { IRR: 'ریال', USD: 'دلار', CNY: 'یوآن', AED: 'درهم' }
const CUR_LIST = ['IRR', 'USD', 'CNY', 'AED']

type Account = {
  id: string; code: string; name: string; isPostable: boolean; isActive: boolean
  rootType: string; currencyMode: 'SINGLE' | 'MULTI'; currencyCode: string | null
  requiresSubsidiary: boolean; requiresCostCenter: boolean
}
type Subsidiary = { id: string; code: string; name: string; kind: string }
type CostCenter = { id: string; code: string; name: string; isPostable: boolean }

function useLedgerRefs() {
  const accounts = useQuery({
    queryKey: ['ledger', 'accounts'],
    queryFn: async () => (await api.get('/ledger/accounts')).data as { accounts: Account[] },
  })
  const subs = useQuery({
    queryKey: ['ledger', 'subsidiaries'],
    queryFn: async () => (await api.get('/ledger/subsidiaries')).data as Subsidiary[],
  })
  const ccs = useQuery({
    queryKey: ['ledger', 'cost-centers'],
    queryFn: async () => (await api.get('/ledger/cost-centers')).data as CostCenter[],
  })
  const all = accounts.data?.accounts ?? []
  return {
    subs: subs.data ?? [],
    costCenters: (ccs.data ?? []).filter((c) => c.isPostable),
    /** حساب‌های نقد/بانکِ شرکت — بدون تفصیلی اجباری */
    cash: all.filter((a) => a.isPostable && a.isActive && !a.requiresSubsidiary && a.code.startsWith('1101')),
    /** حساب‌های هزینه (سرفصل ۵ تا ۸۲) */
    expense: all.filter((a) => a.isPostable && a.isActive && /^(5|6|7|82)/.test(a.code)),
  }
}

/** تبدیل شیء ساده به FormData (فایل رسید اختیاری) */
function toFormData(obj: Record<string, unknown>, file?: File | null): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') fd.append(k, String(v))
  }
  if (file) fd.append('receipt', file)
  return fd
}

// ─── اجزای فرم مشترک ──────────────────────────────────────────
function Field({ label, children, grow }: { label: string; children: any; grow?: boolean }) {
  return (
    <div className={`form-group${grow ? ' grow' : ''}`} style={{ margin: 0 }}>
      <label>{label}</label>
      {children}
    </div>
  )
}

/** دکمهٔ «نرخ امروز» — نرخ روز را در فیلد می‌گذارد؛ کاربر می‌تواند تغییر دهد */
function TodayRateButton({ currency, onPick }: { currency: string; onPick: (rial: string) => void }) {
  const m = useMutation({
    mutationFn: async () => (await api.get('/ledger/fx/today', { params: { currency } })).data,
    onSuccess: (d: any) => { onPick(String(d.rate)); toast.info(`نرخ ${CUR_LABEL[currency]}: ${Number(d.rate).toLocaleString()} ریال (${d.source})`) },
    onError: (e: any) => toast.error(e.response?.data?.message || 'نرخ زنده در دسترس نیست'),
  })
  if (currency === 'IRR') return null
  return (
    <button type="button" className="btn-secondary btn-sm" disabled={m.isPending} onClick={() => m.mutate()}>
      {m.isPending ? '…' : 'نرخ امروز'}
    </button>
  )
}

function ReceiptField({ onChange }: { onChange: (f: File | null) => void }) {
  return (
    <Field label="رسید (اختیاری)">
      <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
    </Field>
  )
}

function Modal({ title, onClose, children, footer, width = 560 }: any) {
  return (
    <ModalPortal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ maxWidth: width }} onClick={(e: any) => e.stopPropagation()}>
          <div className="modal-header"><h2>{title}</h2><button onClick={onClose} aria-label="بستن">✕</button></div>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
          <div className="modal-footer">{footer}</div>
        </div>
      </div>
    </ModalPortal>
  )
}

const cur = (v: string, set: (v: string) => void) => (
  <select style={{ width: 96 }} value={v} onChange={(e) => set(e.target.value)}>
    {CUR_LIST.map((c) => <option key={c} value={c}>{CUR_LABEL[c]}</option>)}
  </select>
)

// ═══════════════════════════════════════════════════════════════
function SettlementModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { subs, cash } = useLedgerRefs()
  const [direction, setDirection] = useState<'RECEIPT' | 'PAYMENT'>('RECEIPT')
  const [subsidiaryId, setSubsidiaryId] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [amount, setAmount] = useState('')
  const [cashAccountCode, setCashAccountCode] = useState('')
  const [dayRate, setDayRate] = useState('')
  const [date, setDate] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [allowPrepayment, setAllowPrepayment] = useState(false)
  const [cashAmount, setCashAmount] = useState('')

  const preview = useQuery({
    queryKey: ['ledger', 'settle-preview', subsidiaryId, currency],
    queryFn: async () => (await api.get('/ledger/ops/settlement/preview', { params: { subsidiaryId, currency } })).data,
    enabled: !!subsidiaryId && !!currency,
  })

  const cashCur = cash.find((c) => c.code === cashAccountCode)?.currencyCode
  const crossCurrency = !!cashCur && cashCur !== currency

  const save = useMutation({
    mutationFn: async () => (await api.post('/ledger/ops/settlement', toFormData({
      direction, subsidiaryId, currency, amount, cashAccountCode, dayRate, date, description,
      allowPrepayment: allowPrepayment ? 'true' : '',
      ...(crossCurrency ? { cashCurrency: cashCur, cashAmount } : {}),
    }, file))).data,
    onSuccess: () => { toast.success('تسویه ثبت شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'ثبت تسویه ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  return (
    <Modal
      title="دریافت / پرداخت"
      onClose={onClose}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className="btn-primary"
          disabled={!subsidiaryId || !amount || !cashAccountCode || (crossCurrency && !cashAmount) || save.isPending}
          onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ثبت…' : 'ثبت'}
        </button>
      </>}
    >
      <div className="settings-tabs" style={{ margin: 0 }}>
        {([['RECEIPT', 'دریافت از طرف‌حساب'], ['PAYMENT', 'پرداخت به طرف‌حساب']] as const).map(([d, label]) => (
          <button key={d} className={`tab-btn ${direction === d ? 'active' : ''}`} onClick={() => setDirection(d)}>{label}</button>
        ))}
      </div>

      <Field label="طرف‌حساب">
        <SearchableSelect value={subsidiaryId} onChange={setSubsidiaryId}
          options={subs.map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` }))} placeholder="انتخاب طرف‌حساب" />
      </Field>

      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        <Field label="ارز">{cur(currency, setCurrency)}</Field>
        <Field label={`مبلغ (${CUR_LABEL[currency]})`} grow>
          <NumberInput value={amount} onChange={setAmount} decimals placeholder="0" />
        </Field>
      </div>

      {preview.data && (
        <p className="hint-sm" style={{ background: 'var(--surface-2)', padding: '8px 12px', borderRadius: 8, margin: 0 }}>
          ماندهٔ باز: <b className="num">{Number(preview.data.balance).toLocaleString()}</b> {CUR_LABEL[currency]}
          {preview.data.carryingRate && <> · نرخ دفتری: <b className="num">{Number(preview.data.carryingRate).toLocaleString()}</b> ریال</>}
          {' · '}معین: {preview.data.obligationAccountCode}
        </p>
      )}

      {preview.data && Number(amount) > Math.max(Number(preview.data.balance), 0) && (
        <label className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--warning)' }}>
          <input type="checkbox" checked={allowPrepayment} onChange={(e) => setAllowPrepayment(e.target.checked)} />
          مبلغ از ماندهٔ باز بیشتر است — مازاد را به‌عنوان
          {direction === 'RECEIPT' ? ' پیش‌دریافت (۲۱۰۳)' : ' پیش‌پرداخت (۱۱۰۵)'} ثبت کن
        </label>
      )}

      <Field label="حساب نقدی شرکت">
        <SearchableSelect value={cashAccountCode} onChange={setCashAccountCode}
          options={cash.map((a) => ({ value: a.code, label: `${a.code} — ${a.name}${a.currencyCode ? ` (${CUR_LABEL[a.currencyCode]})` : ''}` }))}
          placeholder="انتخاب حساب" />
      </Field>
      {crossCurrency && (
        <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 8, borderColor: 'var(--warning)' }}>
          <p className="hint-sm" style={{ margin: 0 }}>
            حساب نقدی به {CUR_LABEL[cashCur!]} است ولی تعهد به {CUR_LABEL[currency]}. مبلغِ واقعیِ
            {direction === 'RECEIPT' ? ' دریافت‌شده' : ' پرداخت‌شده'} به {CUR_LABEL[cashCur!]} را وارد کنید؛
            تعهد به نرخ دفتری بسته و مابه‌التفاوت به‌عنوان تسعیر ثبت می‌شود.
          </p>
          <Field label={`مبلغ نقدِ ${direction === 'RECEIPT' ? 'دریافتی' : 'پرداختی'} (${CUR_LABEL[cashCur!]})`}>
            <NumberInput value={cashAmount} onChange={setCashAmount} decimals placeholder="0" />
          </Field>
        </div>
      )}

      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        <Field label={`نرخ روزِ ${CUR_LABEL[currency]} (ریال، اختیاری)`}>
          <NumberInput value={dayRate} onChange={setDayRate} placeholder="از جدول نرخ" />
        </Field>
        <TodayRateButton currency={currency} onPick={setDayRate} />
        <Field label="تاریخ"><DateField value={date} onChange={setDate} /></Field>
      </div>

      <Field label="شرح">
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="بابت…" />
      </Field>
      <ReceiptField onChange={setFile} />
    </Modal>
  )
}

// ═══════════════════════════════════════════════════════════════
function ConversionModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { cash, subs } = useLedgerRefs()
  const [date, setDate] = useState('')
  const [fromAccountCode, setFromAccountCode] = useState('')
  const [fromCurrency, setFromCurrency] = useState('IRR')
  const [fromAmount, setFromAmount] = useState('')
  const [toAccountCode, setToAccountCode] = useState('')
  const [toCurrency, setToCurrency] = useState('USD')
  const [toAmount, setToAmount] = useState('')
  const [showFee, setShowFee] = useState(false)
  const [feeAmount, setFeeAmount] = useState('')
  const [feeCurrency, setFeeCurrency] = useState('IRR')
  const [feeAccountCode, setFeeAccountCode] = useState('')
  const [feeExchangeSubsidiaryId, setFeeExchangeSubsidiaryId] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState<File | null>(null)

  const effRate = Number(fromAmount) > 0 && Number(toAmount) > 0
    ? (Number(fromAmount) / Number(toAmount)).toLocaleString(undefined, { maximumFractionDigits: 6 })
    : null

  const save = useMutation({
    mutationFn: async () => (await api.post('/ledger/ops/conversion', toFormData({
      date, fromAccountCode, fromCurrency, fromAmount, toAccountCode, toCurrency, toAmount, description,
      ...(showFee && feeAmount ? { feeAmount, feeCurrency, feeAccountCode, feeExchangeSubsidiaryId } : {}),
    }, file))).data,
    onSuccess: () => { toast.success('تبدیل ارز ثبت شد'); qc.invalidateQueries({ queryKey: ['ledger'] }); onClose() },
    onError: (e: any) => dialog.alert({ title: 'ثبت تبدیل ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const acctOpts = cash.map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` }))
  const exchangeSubs = subs.filter((s) => s.kind === 'EXCHANGE')

  return (
    <Modal
      title="عملیات ارزی — تبدیل"
      onClose={onClose}
      width={840}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className="btn-primary"
          disabled={!fromAccountCode || !toAccountCode || !fromAmount || !toAmount || fromCurrency === toCurrency || save.isPending}
          onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ثبت…' : 'ثبت'}
        </button>
      </>}
    >
      <Field label="تاریخ"><DateField value={date} onChange={setDate} /></Field>

      <div className="grid-2">
        <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="section-title" style={{ margin: 0, fontSize: 13 }}>می‌دهیم</div>
          <SearchableSelect value={fromAccountCode} onChange={setFromAccountCode} options={acctOpts} placeholder="حساب مبدأ" />
          <div style={{ display: 'flex', gap: 8 }}>
            {cur(fromCurrency, setFromCurrency)}
            <NumberInput value={fromAmount} onChange={setFromAmount} decimals placeholder="مبلغ" />
          </div>
        </div>
        <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="section-title" style={{ margin: 0, fontSize: 13 }}>می‌گیریم</div>
          <SearchableSelect value={toAccountCode} onChange={setToAccountCode} options={acctOpts} placeholder="حساب مقصد" />
          <div style={{ display: 'flex', gap: 8 }}>
            {cur(toCurrency, setToCurrency)}
            <NumberInput value={toAmount} onChange={setToAmount} decimals placeholder="مبلغ" />
          </div>
        </div>
      </div>

      {fromCurrency === toCurrency && <p className="error-msg" style={{ margin: 0 }}>ارز مبدأ و مقصد باید متفاوت باشد — برای هم‌ارز از «عملیات داخلی ← انتقال».</p>}
      {effRate && <p className="hint-sm" style={{ margin: 0 }}>نرخ مؤثر: {effRate} {CUR_LABEL[fromCurrency]} به‌ازای هر {CUR_LABEL[toCurrency]}</p>}
      <p className="hint-sm" style={{ margin: 0 }}>
        تبدیل به‌خودی‌خود سود/زیان نمی‌سازد — سمت خروجی به بهای تمام‌شدهٔ خودش می‌رود و
        سمت ورودی به بهای واقعیِ پرداخت‌شده. فقط اگر یک سمت ریال باشد مابه‌التفاوت تسعیر محقق است.
      </p>

      <label className="hint-sm" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input type="checkbox" checked={showFee} onChange={(e) => setShowFee(e.target.checked)} /> کارمزد صرافی
      </label>
      {showFee && (
        <div className="panel panel-pad" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
            <Field label="مبلغ کارمزد"><NumberInput value={feeAmount} onChange={setFeeAmount} decimals placeholder="0" /></Field>
            <Field label="ارز">{cur(feeCurrency, setFeeCurrency)}</Field>
          </div>
          <Field label="حساب پرداخت کارمزد">
            <SearchableSelect value={feeAccountCode} onChange={setFeeAccountCode} options={acctOpts} placeholder="حساب شرکت" />
          </Field>
          <Field label="صراف (اختیاری — گردش کارمزد در دفترش ثبت می‌شود)">
            <SearchableSelect value={feeExchangeSubsidiaryId} onChange={setFeeExchangeSubsidiaryId}
              options={[{ value: '', label: '—' }, ...exchangeSubs.map((s) => ({ value: s.id, label: `${s.code} ${s.name}` }))]} placeholder="—" />
          </Field>
        </div>
      )}

      <Field label="شرح">
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="بابت…" />
      </Field>
      <ReceiptField onChange={setFile} />
    </Modal>
  )
}

// ═══════════════════════════════════════════════════════════════
function InternalOpsModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { cash, expense, costCenters } = useLedgerRefs()
  const [tab, setTab] = useState<'transfer' | 'expense'>('transfer')
  const [date, setDate] = useState('')
  const [currency, setCurrency] = useState('IRR')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [fromAccountCode, setFromAccountCode] = useState('')
  const [toAccountCode, setToAccountCode] = useState('')
  const [dayRate, setDayRate] = useState('')
  const [expenseAccountCode, setExpenseAccountCode] = useState('6201')
  const [costCenterId, setCostCenterId] = useState('')

  const cashOpts = cash.map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` }))

  const save = useMutation({
    mutationFn: async () => {
      const path = tab === 'transfer' ? '/ledger/ops/transfer' : '/ledger/ops/expense'
      const body = tab === 'transfer'
        ? { date, fromAccountCode, toAccountCode, currency, amount, dayRate, description }
        : { date, fromAccountCode, expenseAccountCode, costCenterId, currency, amount, dayRate, description }
      return (await api.post(path, toFormData(body, file))).data
    },
    onSuccess: () => {
      toast.success(tab === 'transfer' ? 'انتقال ثبت شد' : 'هزینه ثبت شد')
      qc.invalidateQueries({ queryKey: ['ledger'] }); onClose()
    },
    onError: (e: any) => dialog.alert({ title: 'ثبت ناموفق بود', message: e?.response?.data?.message, tone: 'danger' }),
  })

  const canSave = !!amount && !!fromAccountCode &&
    (tab === 'transfer' ? !!toAccountCode && fromAccountCode !== toAccountCode : !!expenseAccountCode)

  return (
    <Modal
      title="عملیات داخلی"
      onClose={onClose}
      footer={<>
        <button className="btn-secondary" onClick={onClose}>انصراف</button>
        <button className="btn-primary" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'در حال ثبت…' : 'ثبت'}
        </button>
      </>}
    >
      <div className="settings-tabs" style={{ margin: 0 }}>
        <button className={`tab-btn ${tab === 'transfer' ? 'active' : ''}`} onClick={() => setTab('transfer')}>انتقال بین حساب‌ها</button>
        <button className={`tab-btn ${tab === 'expense' ? 'active' : ''}`} onClick={() => setTab('expense')}>ثبت هزینه</button>
      </div>

      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
        <Field label="ارز">{cur(currency, setCurrency)}</Field>
        <Field label={`مبلغ (${CUR_LABEL[currency]})`} grow>
          <NumberInput value={amount} onChange={setAmount} decimals placeholder="0" />
        </Field>
        <Field label="تاریخ"><DateField value={date} onChange={setDate} /></Field>
      </div>

      <Field label={tab === 'transfer' ? 'از حساب' : 'پرداخت از حساب'}>
        <SearchableSelect value={fromAccountCode} onChange={setFromAccountCode} options={cashOpts} placeholder="حساب شرکت" />
      </Field>

      {tab === 'transfer' ? (
        <Field label="به حساب">
          <SearchableSelect value={toAccountCode} onChange={setToAccountCode} options={cashOpts} placeholder="حساب شرکت" />
        </Field>
      ) : (
        <>
          <Field label="حساب هزینه">
            <SearchableSelect value={expenseAccountCode} onChange={setExpenseAccountCode}
              options={expense.map((a) => ({ value: a.code, label: `${a.code} — ${a.name}` }))} placeholder="انتخاب حساب هزینه" />
          </Field>
          <Field label="مرکز هزینه (اختیاری)">
            <select value={costCenterId} onChange={(e) => setCostCenterId(e.target.value)}>
              <option value="">—</option>
              {costCenters.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
            </select>
          </Field>
        </>
      )}

      {currency !== 'IRR' && (
        <div className="toolbar" style={{ marginBottom: 0, alignItems: 'flex-end' }}>
          <Field label="نرخ (ریال، اختیاری)">
            <NumberInput value={dayRate} onChange={setDayRate} placeholder="نرخِ حملِ مبدأ" />
          </Field>
          <TodayRateButton currency={currency} onPick={setDayRate} />
        </div>
      )}

      <Field label="شرح">
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="بابت…" />
      </Field>
      <ReceiptField onChange={setFile} />
    </Modal>
  )
}

// ═══════════════════════════════════════════════════════════════
/**
 * سه راهِ ثبتِ سند، کنارِ راهِ چهارم («سند دستی») در تب دفتر روزنامه.
 *
 * پیش از این در سربرگِ تیره و **بالای** تب‌ها بودند، یعنی سه فعل بالای شش
 * اسم — و روی هر تبی دیده می‌شدند، حتی وقتی داشتی دفتر کل قانونی را
 * می‌خواندی. حالا در همان جایی‌اند که سند ساخته می‌شود، پس استایلشان هم از
 * `band-*` (مخصوص نوار تیره) به دکمه‌های عادی عوض شد.
 */
export default function LedgerCommandBar() {
  const [open, setOpen] = useState<null | 'settle' | 'convert' | 'internal'>(null)
  return (
    <>
      <button className="btn-primary" onClick={() => setOpen('settle')}><Icon name="banknote" size={15} /> دریافت / پرداخت</button>
      <button className="btn-secondary" onClick={() => setOpen('convert')}><Icon name="exchange" size={14} /> عملیات ارزی</button>
      <button className="btn-secondary" onClick={() => setOpen('internal')}><Icon name="repeat" size={14} /> عملیات داخلی</button>

      {open === 'settle' && <SettlementModal onClose={() => setOpen(null)} />}
      {open === 'convert' && <ConversionModal onClose={() => setOpen(null)} />}
      {open === 'internal' && <InternalOpsModal onClose={() => setOpen(null)} />}
    </>
  )
}

/** پیوست سند — لینک قابل باز کردن در دفتر روزنامه و جزئیات سند */
export function Attachments({ urls }: { urls?: string[] | null }) {
  if (!urls?.length) return null
  return (
    <span style={{ display: 'inline-flex', gap: 4, verticalAlign: 'middle' }}>
      {urls.map((u, i) => (
        <a key={u} href={fileUrl(u)} target="_blank" rel="noreferrer" title="مشاهدهٔ پیوست"
          style={{ color: 'var(--brand)', display: 'inline-flex' }}>
          <Icon name="paperclip" size={13} />{urls.length > 1 ? <span className="hint-sm">{i + 1}</span> : null}
        </a>
      ))}
    </span>
  )
}
