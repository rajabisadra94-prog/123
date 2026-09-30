import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { API_ORIGIN } from '../lib/api'
import UsersTab from './settings/UsersTab'
import PermissionsTab from './settings/PermissionsTab'
import CurrencyTab from './settings/CurrencyTab'
import { PageHeader, Loading } from '../components/ui'
import { dialog, toast } from '../components/ui/dialog'

type Tab = string

const TAB_GROUPS: { group: string; tabs: [string, string][] }[] = [
  { group: 'کاربران و امنیت', tabs: [['users', 'کاربران'], ['permissions', 'نقش‌ها و سطوح دسترسی']] },
  // سازندگان/تامین‌کنندگان/دسته‌بندی به ماژول مستقل «بانک طرف‌های تأمین» منتقل شدند
  { group: 'طرف حساب‌ها و شرکا', tabs: [['customers', 'مشتریان'], ['shipping', 'شرکت‌های حمل'], ['exchanges', 'صرافی‌ها'], ['commission', 'کمیسیون‌بگیرها']] },
  { group: 'داده‌های پایه', tabs: [['materials', 'مواد اولیه'], ['coatings', 'پوشش‌ها'], ['docTypes', 'عناوین اسناد']] },
  { group: 'عمومی و سیستمی', tabs: [['currency', 'ارز و نرخ‌ها'], ['company', 'اطلاعات شرکت'], ['invoice', 'تنظیمات فاکتور'], ['rules', 'قوانین سیستم'], ['maintenance', 'نگهداری دفاتر']] },
]

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('users')

  return (
    <div className="page" dir="rtl">
      <PageHeader title="تنظیمات" subtitle="پیکربندی طرف‌حساب‌ها، داده‌های پایه و قوانین سیستم" />

      <div className="settings-layout">
        {/* موبایل: انتخابگر گروه‌بندی‌شده به‌جای منوی کناری */}
        <select className="settings-select" value={tab} onChange={(e) => setTab(e.target.value as Tab)}>
          {TAB_GROUPS.map((g) => (
            <optgroup key={g.group} label={g.group}>
              {g.tabs.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </optgroup>
          ))}
        </select>
        <aside className="settings-menu">
          {TAB_GROUPS.map((g) => (
            <div key={g.group} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.4, padding: '4px 10px' }}>{g.group}</div>
              {g.tabs.map(([key, label]) => (
                <button key={key} className={`settings-menu-item ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>{label}</button>
              ))}
            </div>
          ))}
        </aside>

        <section className="settings-pane">
          {tab === 'users' && <UsersTab />}
          {tab === 'permissions' && <PermissionsTab />}
          {tab === 'customers' && <CustomersTab />}
          {tab === 'materials' && <SimpleListTab endpoint="/settings/materials" label="ماده اولیه" />}
          {tab === 'coatings' && <SimpleListTab endpoint="/settings/coatings" label="پوشش" />}
          {tab === 'docTypes' && <DocTypesTab />}
          {tab === 'shipping' && <ShippingCompaniesTab />}
          {tab === 'exchanges' && <ExchangesTab />}
          {tab === 'commission' && <CommissionAgentsTab />}
          {tab === 'currency' && <CurrencyTab />}
          {tab === 'company' && <CompanyInfoTab />}
          {tab === 'invoice' && <InvoiceSettingsTab />}
          {tab === 'rules' && <RulesTab />}
          {tab === 'maintenance' && <MaintenanceTab />}
        </section>
      </div>
    </div>
  )
}

// ─── نگهداری دفاتر — ابزارهای تعمیر حسابداری (منتقل‌شده از صفحهٔ حسابداری) ───
function MaintenanceTab() {
  const qc = useQueryClient()

  const backfill = useMutation({
    mutationFn: () => api.post('/accounting/backfill-invoices'),
    onSuccess: (r: any) => { qc.invalidateQueries(); toast.success(`تکمیل اسناد انجام شد: ${r.data.created} سند از ${r.data.scanned} فاکتور ساخته شد.`) },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const rebuild = useMutation({
    mutationFn: () => api.post('/accounting/rebuild-ledger'),
    onSuccess: (r: any) => {
      qc.invalidateQueries()
      toast.success(`بازسازی انجام شد:\n• ${r.data.deletedEntries} سند مشتق حذف و بازپخش\n• ${r.data.openingsPosted} سند افتتاحیه\n• ${r.data.invoicesReposted} فاکتور بازسازی\n• ${r.data.freightsReposted} فاکتور حمل\n• جمع اسناد دفتر: ${r.data.newEntries}`)
    },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const confirmRebuild = async () => {
    const t = await dialog.prompt({
      title: '♻️ بازسازی دفتر کل',
      message: 'اسناد «مشتق» (فاکتور فروش، پیش‌پرداخت، فاکتور حمل، درآمد فورواردینگ) از روی مدارک منبع از نو ساخته می‌شوند. اسناد دستی و تسویه‌ها (دریافت/پرداخت، انتقال، تبدیل، هزینه، خرید) حفظ می‌شوند و ماندهٔ همهٔ حساب‌ها از دفتر بازمحاسبه می‌شود. برای تأیید بنویسید: بازسازی',
      placeholder: 'بازسازی', required: true, tone: 'danger', confirmLabel: 'شروع بازسازی',
    })
    if (t === 'بازسازی') rebuild.mutate()
  }

  const card = { border: '1px solid var(--border)', borderRadius: 12, padding: 16, marginBottom: 14, background: 'var(--card, #fff)' }

  return (
    <div>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>🛠 نگهداری دفاتر حسابداری</h2>
      <p className="hint" style={{ marginBottom: 16  }}>
        ابزارهای تعمیر — در کار روزمره نیازی به این‌ها نیست. فقط وقتی گزارشی مشکوک بود یا بعد از به‌روزرسانی منطق حسابداری استفاده کنید.
      </p>

      <div style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>🔧 تکمیل اسناد</h3>
        <p className="hint" style={{ marginBottom: 10  }}>
          فاکتورهای تأییدشده‌ای که سند حسابداری ندارند را پیدا و سندشان را می‌سازد (طلب مشتری، بدهی سازنده، کمیسیون، پیش‌پرداخت).
          به اسناد موجود دست نمی‌زند — کاملاً بی‌خطر، هر وقت خواستید بزنید.
        </p>
        <button className="btn-secondary" disabled={backfill.isPending} onClick={() => backfill.mutate()}>
          {backfill.isPending ? 'در حال بررسی...' : '🔧 اجرای تکمیل اسناد'}
        </button>
      </div>

      <div style={card}>
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>♻️ بازسازی کامل دفاتر <span style={{ fontSize: 11, color: 'var(--danger)', fontWeight: 400 }}>(فقط مدیر کل)</span></h3>
        <p className="hint" style={{ marginBottom: 10  }}>
          اسناد «مشتق» (تأیید فاکتور، پیش‌پرداخت، فاکتور حمل، درآمد فورواردینگ) را از روی مدارک منبع با منطق فعلی از نو می‌سازد
          و ماندهٔ همهٔ حساب‌ها را از جمع سطرهای دفتر بازمحاسبه می‌کند.
          اسناد دستی و تسویه‌ها (دریافت/پرداخت، انتقال، تبدیل ارز، هزینه، خرید) <strong>حفظ می‌شوند</strong>.
          کاربرد: بعد از رفع باگ در منطق حسابداری، تا تاریخچهٔ قدیمی هم اصلاح شود.
        </p>
        <button className="btn-danger" disabled={rebuild.isPending} onClick={confirmRebuild}>
          {rebuild.isPending ? 'در حال بازسازی...' : '♻️ اجرای بازسازی دفاتر'}
        </button>
      </div>
    </div>
  )
}

function CustomersTab() {
  const qc = useQueryClient()
  const empty = { name: '', shortCode: '', phone: '', address: '', email: '', projectCounter: '' }
  const [form, setForm] = useState<any>(empty)
  const [editing, setEditing] = useState<any>(null)
  const [error, setError] = useState('')

  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get('/settings/customers').then((r) => r.data),
  })

  const create = useMutation({
    mutationFn: (d: any) => api.post('/settings/customers', d),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['customers'] }); setForm(empty); setError('') },
    onError: (e: any) => {
      const status = e.response?.status ? `[${e.response.status}] ` : ''
      setError(status + (e.response?.data?.message || e.message || 'خطای ناشناخته'))
    },
  })
  const update = useMutation({
    mutationFn: ({ id, data }: any) => api.patch(`/settings/customers/${id}`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['customers'] }); setEditing(null) },
  })

  return (
    <div>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 16 }}>
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>افزودن مشتری جدید</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 8 }}><label>نام *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="form-group" style={{ marginBottom: 8 }}><label>کد ۳ حرفی *</label><input maxLength={3} value={form.shortCode} onChange={(e) => setForm({ ...form, shortCode: e.target.value.toUpperCase() })} /></div>
          <div className="form-group" style={{ marginBottom: 8 }}><label>شمارهٔ شروع پروژه</label><input type="number" placeholder="مثلاً ۱۰" value={form.projectCounter} onChange={(e) => setForm({ ...form, projectCounter: e.target.value })} /></div>
          <div className="form-group" style={{ marginBottom: 8 }}><label>تلفن</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
          <div className="form-group" style={{ marginBottom: 8 }}><label>ایمیل</label><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="form-group" style={{ marginBottom: 8 }}><label>آدرس</label><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
        </div>
        {error && <div className="error-msg">{error}</div>}
        <button className="btn-primary btn-sm" onClick={() => create.mutate(form)} disabled={!form.name || form.shortCode.length !== 3}>افزودن</button>
        <p className="hint-sm" style={{ marginTop: 6  }}>شمارهٔ شروع پروژه: اگر این مشتری از قبل چند پروژه داشته، آن عدد را وارد کنید تا کدِ پروژهٔ بعدی از آن ادامه یابد.</p>
      </div>
      <table className="data-table">
        <thead><tr><th>نام</th><th>کد</th><th>تلفن</th><th>شمارهٔ پروژه</th><th>اقدام</th></tr></thead>
        <tbody>
          {customers.map((c: any) => (
            <tr key={c.id}>
              <td>{c.name}</td><td>{c.shortCode}</td><td>{c.phone || '-'}</td><td>{c.projectCounter}</td>
              <td><button className="btn-secondary btn-sm" onClick={() => setEditing(c)}>ویرایش</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <EntityEditModal
          title={`ویرایش مشتری: ${editing.name}`}
          fields={[
            { key: 'name', label: 'نام' },
            { key: 'phone', label: 'تلفن' },
            { key: 'email', label: 'ایمیل' },
            { key: 'address', label: 'آدرس' },
            { key: 'projectCounter', label: 'شمارهٔ پروژه', type: 'number' },
          ]}
          initial={editing}
          onClose={() => setEditing(null)}
          onSave={(data) => update.mutate({ id: editing.id, data })}
          busy={update.isPending}
        />
      )}
    </div>
  )
}


function CompanyInfoTab() {
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  useQuery({
    queryKey: ['company-info'],
    queryFn: async () => {
      const d = await api.get('/settings/company-info').then((r) => r.data)
      setForm(d)
      return d
    },
  })

  const save = useMutation({
    mutationFn: () => api.put('/settings/company-info', form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['company-info'] }); setSaved(true); setTimeout(() => setSaved(false), 2500) },
  })

  const [uploading, setUploading] = useState('')
  const field = (key: string, label: string, textarea = false) => (
    <div className="form-group">
      <label>{label}</label>
      {textarea
        ? <textarea rows={2} value={form[key] || ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        : <input value={form[key] || ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />}
    </div>
  )

  // آپلود تصویر (لوگو / مهر) → مسیر ذخیره‌شده در فرم قرار می‌گیرد (پس از «ذخیره» دائمی می‌شود)
  const uploadImage = async (key: string, file: File) => {
    setUploading(key)
    try {
      const fd = new FormData(); fd.append('file', file)
      const { data } = await api.post('/settings/upload-image', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      setForm((f) => ({ ...f, [key]: data.url }))
    } finally { setUploading('') }
  }
  const imageField = (key: string, label: string, hint: string) => {
    const src = form[key] ? (form[key].startsWith('http') ? form[key] : `${API_ORIGIN}${form[key]}`) : ''
    return (
      <div className="form-group">
        <label>{label}</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {src && <img src={src} alt={label} style={{ maxHeight: 64, maxWidth: 140, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 4, background: 'var(--surface)' }} />}
          <input type="file" accept="image/png,image/jpeg" style={{ width: 'auto' }} disabled={!!uploading}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(key, f) }} />
          {uploading === key && <span className="hint">در حال آپلود…</span>}
          {form[key] && <button className="btn-danger btn-sm" type="button" onClick={() => setForm({ ...form, [key]: '' })}>حذف</button>}
        </div>
        <span className="hint-sm" style={{ display: 'block', marginTop: 4  }}>{hint}</span>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <p className="hint-lg" style={{ marginBottom: 16  }}>این اطلاعات در سربرگ فاکتورهای PDF نمایش داده می‌شود.</p>
      {field('COMPANY_NAME', 'نام شرکت')}
      {field('COMPANY_ADDRESS', 'آدرس', true)}
      {field('COMPANY_PHONE', 'تلفن')}
      {field('COMPANY_EMAIL', 'ایمیل')}
      {imageField('COMPANY_LOGO_URL', 'لوگوی شرکت', 'در سربرگ فاکتور نمایش داده می‌شود (PNG/JPG).')}
      {imageField('COMPANY_STAMP_URL', 'مهر شرکت', 'در صورت آپلود، همیشه روی محل «مهر و امضای فروشنده» در فاکتور می‌نشیند. ترجیحاً PNG با پس‌زمینه شفاف.')}
      {field('COMPANY_EXTRA', 'اطلاعات تکمیلی (کد اقتصادی، شناسه ملی و...)', true)}
      <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>ذخیره اطلاعات شرکت</button>
      {saved && <span style={{ color: 'var(--success)', marginRight: 12, fontSize: 13 }}>ذخیره شد ✓</span>}
    </div>
  )
}

// ۱.۶ — مدیریت عناوین سفارشی اسناد پروژه (افزودن/حذف از تنظیمات)
function DocTypesTab() {
  const qc = useQueryClient()
  const [items, setItems] = useState<{ value: string; label: string }[]>([])
  const [newLabel, setNewLabel] = useState('')
  const [saved, setSaved] = useState(false)
  const { data } = useQuery({ queryKey: ['doc-types'], queryFn: () => api.get('/settings/config/DOC_TYPES').then((r) => r.data) })
  useEffect(() => { if (Array.isArray(data)) setItems(data) }, [data])

  const save = useMutation({
    mutationFn: (next: any[]) => api.put('/settings/config/DOC_TYPES', next),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['doc-types'] }); setSaved(true); setTimeout(() => setSaved(false), 2000) },
  })
  const add = () => {
    const label = newLabel.trim()
    if (!label) return
    const value = 'DOC_' + Math.random().toString(36).slice(2, 7).toUpperCase()
    const next = [...items, { value, label }]
    setItems(next); setNewLabel(''); save.mutate(next)
  }
  const remove = (value: string) => { const next = items.filter((i) => i.value !== value); setItems(next); save.mutate(next) }

  return (
    <div style={{ maxWidth: 560 }}>
      <h3 style={{ fontSize: 15, marginBottom: 6 }}>عناوین اسناد پروژه</h3>
      <p className="hint" style={{ marginBottom: 14  }}>این عناوین علاوه بر عناوین پیش‌فرض، هنگام «افزودن سند به پروژه» در فهرست نوع سند نمایش داده می‌شوند.</p>
      <div className="add-form">
        <input placeholder="عنوان سند جدید (مثلاً: مجوز گمرکی)" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add() }} />
        <button className="btn-primary btn-sm" disabled={!newLabel.trim()} onClick={add}>+ افزودن</button>
        {saved && <span style={{ color: 'var(--success)', fontSize: 13 }}>ذخیره شد ✓</span>}
      </div>
      <ul className="simple-list" style={{ marginTop: 12 }}>
        {items.map((it) => (
          <li key={it.value}>
            <span style={{ fontSize: 13 }}>{it.label}</span>
            <button className="btn-danger btn-sm" onClick={() => remove(it.value)}>حذف</button>
          </li>
        ))}
        {items.length === 0 && <li className="hint">هنوز عنوان سفارشی‌ای اضافه نشده. عناوین پیش‌فرض همیشه موجودند.</li>}
      </ul>
    </div>
  )
}

function InvoiceSettingsTab() {
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)
  useQuery({
    queryKey: ['invoice-settings'],
    queryFn: async () => { const d = await api.get('/settings/config/INVOICE_SETTINGS').then((r) => r.data || {}); setForm(d || {}); return d || {} },
  })
  const save = useMutation({
    mutationFn: () => api.put('/settings/config/INVOICE_SETTINGS', form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['invoice-settings'] }); setSaved(true); setTimeout(() => setSaved(false), 2500) },
  })
  const field = (key: string, label: string, textarea = false) => (
    <div className="form-group">
      <label>{label}</label>
      {textarea
        ? <textarea rows={2} value={form[key] || ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
        : <input value={form[key] || ''} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />}
    </div>
  )
  return (
    <div style={{ maxWidth: 560 }}>
      <p className="hint-lg" style={{ marginBottom: 16  }}>این موارد در PDF فاکتور نمایش داده می‌شوند. (رنگ برند و لوگو از «اطلاعات شرکت»)</p>
      <div className="form-group">
        <label>درصد مالیات بر ارزش افزوده</label>
        <input type="number" value={form.vatPercent ?? ''} onChange={(e) => setForm({ ...form, vatPercent: e.target.value })} placeholder="پیش‌فرض ۱۰" style={{ width: 160 }} />
        <span className="hint-sm" style={{ display: 'block', marginTop: 4  }}>هنگام صدور فاکتور مشخص می‌کنید که فاکتور شامل ارزش افزوده باشد یا نه؛ اگر باشد، این درصد اعمال می‌شود.</span>
      </div>
      {field('paymentInfo', 'اطلاعات پرداخت / شماره حساب / شبا', true)}
      {field('defaultNotes', 'متن پیش‌فرض «توضیحات» فاکتور (اگر هنگام تأیید توضیحات توافقی ثبت نشود)', true)}
      {field('terms', 'شرایط و قوانین فاکتور (هر خط = یک بند)', true)}
      {field('footer', 'متن پاورقی فاکتور')}
      {field('defaultPrepDays', 'روز آماده‌سازی پیش‌فرض (پس از پیش‌پرداخت)')}
      <p className="hint-sm" style={{ margin: '4px 0 14px'  }}>در صورت خالی‌گذاشتن «توضیحات»، «شرایط» و «پاورقی»، متن‌های پیش‌فرض برند روی فاکتور نمایش داده می‌شوند.</p>
      <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>ذخیره تنظیمات فاکتور</button>
      {saved && <span style={{ color: 'var(--success)', marginRight: 12, fontSize: 13 }}>ذخیره شد ✓</span>}
    </div>
  )
}

const SHIP_TYPES: [string, string][] = [['AIR', 'هوایی'], ['SEA', 'دریایی'], ['LAND', 'زمینی'], ['RAIL', 'ریلی']]


function ShippingCompaniesTab() {
  const qc = useQueryClient()
  const [form, setForm] = useState<any>({ name: '', contactName: '', address: '', notes: '', types: [] as string[] })
  const [editing, setEditing] = useState<any>(null)
  const { data: items = [] } = useQuery({ queryKey: ['shipping-companies'], queryFn: () => api.get('/settings/shipping-companies').then((r) => r.data) })
  const create = useMutation({
    mutationFn: () => api.post('/settings/shipping-companies', form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shipping-companies'] }); setForm({ name: '', contactName: '', address: '', notes: '', types: [] }) },
  })
  const update = useMutation({
    mutationFn: ({ id, data }: any) => api.patch(`/settings/shipping-companies/${id}`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shipping-companies'] }); setEditing(null) },
  })
  const toggleType = (t: string) => setForm((f: any) => ({ ...f, types: f.types.includes(t) ? f.types.filter((x: string) => x !== t) : [...f.types, t] }))
  return (
    <div>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div className="form-group" style={{ marginBottom: 8 }}><label>نام شرکت *</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="form-group" style={{ marginBottom: 8 }}><label>نام رابط</label><input value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} /></div>
          <div className="form-group" style={{ marginBottom: 8 }}><label>آدرس</label><input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>
          <div className="form-group" style={{ marginBottom: 8 }}><label>توضیحات</label><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></div>
        </div>
        <div className="form-group" style={{ marginBottom: 8 }}>
          <label>نوع حمل تخصصی (چند انتخابی)</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {SHIP_TYPES.map(([v, l]) => (
              <label key={v} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13, padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 100, cursor: 'pointer' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={form.types.includes(v)} onChange={() => toggleType(v)} />{l}
              </label>
            ))}
          </div>
        </div>
        <button className="btn-primary btn-sm" disabled={!form.name} onClick={() => create.mutate()}>افزودن شرکت حمل</button>
      </div>
      <table className="data-table">
        <thead><tr><th>نام</th><th>رابط</th><th>نوع حمل</th><th>اقدام</th></tr></thead>
        <tbody>
          {items.map((s: any) => (
            <tr key={s.id}>
              <td>{s.name}</td><td>{s.contactName || '-'}</td><td>{(s.types || []).map((t: string) => SHIP_TYPES.find(([v]) => v === t)?.[1]).join('، ') || '-'}</td>
              <td><button className="btn-secondary btn-sm" onClick={() => setEditing(s)}>ویرایش</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <EntityEditModal title={`ویرایش شرکت حمل: ${editing.name}`}
          fields={[{ key: 'name', label: 'نام' }, { key: 'contactName', label: 'نام رابط' }, { key: 'phone', label: 'تلفن' }, { key: 'address', label: 'آدرس' }, { key: 'notes', label: 'توضیحات' }]}
          initial={editing} onClose={() => setEditing(null)} onSave={(data) => update.mutate({ id: editing.id, data })} busy={update.isPending} />
      )}
    </div>
  )
}

function ExchangesTab() {
  const qc = useQueryClient()
  const [form, setForm] = useState({ name: '', contactName: '', notes: '' })
  const [editing, setEditing] = useState<any>(null)
  const { data: items = [] } = useQuery({ queryKey: ['exchanges'], queryFn: () => api.get('/settings/exchanges').then((r) => r.data) })
  const create = useMutation({ mutationFn: () => api.post('/settings/exchanges', form), onSuccess: () => { qc.invalidateQueries({ queryKey: ['exchanges'] }); setForm({ name: '', contactName: '', notes: '' }) } })
  const update = useMutation({ mutationFn: ({ id, data }: any) => api.patch(`/settings/exchanges/${id}`, data), onSuccess: () => { qc.invalidateQueries({ queryKey: ['exchanges'] }); setEditing(null) } })
  return (
    <div>
      <div className="add-form">
        <input placeholder="نام صرافی" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ maxWidth: 180 }} />
        <input placeholder="نام رابط" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} style={{ maxWidth: 160 }} />
        <input placeholder="توضیحات" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ maxWidth: 200 }} />
        <button className="btn-primary btn-sm" disabled={!form.name} onClick={() => create.mutate()}>افزودن</button>
      </div>
      <ul className="simple-list">{items.map((x: any) => (
        <li key={x.id}><span>{x.name} {x.contactName ? `— ${x.contactName}` : ''}</span><button className="btn-secondary btn-sm" onClick={() => setEditing(x)}>ویرایش</button></li>
      ))}</ul>
      {editing && (
        <EntityEditModal title={`ویرایش صرافی: ${editing.name}`}
          fields={[{ key: 'name', label: 'نام' }, { key: 'contactName', label: 'نام رابط' }, { key: 'notes', label: 'توضیحات' }]}
          initial={editing} onClose={() => setEditing(null)} onSave={(data) => update.mutate({ id: editing.id, data })} busy={update.isPending} />
      )}
    </div>
  )
}

function CommissionAgentsTab() {
  const qc = useQueryClient()
  const [form, setForm] = useState({ name: '', phone: '', email: '', notes: '' })
  const [editing, setEditing] = useState<any>(null)
  const { data: items = [] } = useQuery({ queryKey: ['commission-agents'], queryFn: () => api.get('/settings/commission-agents').then((r) => r.data) })
  const create = useMutation({ mutationFn: () => api.post('/settings/commission-agents', form), onSuccess: () => { qc.invalidateQueries({ queryKey: ['commission-agents'] }); setForm({ name: '', phone: '', email: '', notes: '' }) } })
  const update = useMutation({ mutationFn: ({ id, data }: any) => api.patch(`/settings/commission-agents/${id}`, data), onSuccess: () => { qc.invalidateQueries({ queryKey: ['commission-agents'] }); setEditing(null) } })
  return (
    <div>
      <div className="add-form">
        <input placeholder="نام شخص/شرکت" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ maxWidth: 180 }} />
        <input placeholder="تلفن" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} style={{ maxWidth: 140 }} />
        <input placeholder="ایمیل" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} style={{ maxWidth: 160 }} />
        <button className="btn-primary btn-sm" disabled={!form.name} onClick={() => create.mutate()}>افزودن</button>
      </div>
      <ul className="simple-list">{items.map((x: any) => (
        <li key={x.id}><span>{x.name} {x.phone ? `— ${x.phone}` : ''}</span><button className="btn-secondary btn-sm" onClick={() => setEditing(x)}>ویرایش</button></li>
      ))}</ul>
      {editing && (
        <EntityEditModal title={`ویرایش کمیسیون‌بگیر: ${editing.name}`}
          fields={[{ key: 'name', label: 'نام' }, { key: 'phone', label: 'تلفن' }, { key: 'email', label: 'ایمیل' }, { key: 'notes', label: 'توضیحات' }]}
          initial={editing} onClose={() => setEditing(null)} onSave={(data) => update.mutate({ id: editing.id, data })} busy={update.isPending} />
      )}
    </div>
  )
}

function RulesTab() {
  const qc = useQueryClient()
  const { data: rules } = useQuery({ queryKey: ['system-rules'], queryFn: () => api.get('/settings/config/SYSTEM_RULES').then((r) => r.data || { preventDeleteActive: true, enableAuditLog: true }) })
  const { data: reasons } = useQuery({ queryKey: ['archive-reasons'], queryFn: () => api.get('/settings/config/ARCHIVE_REASONS').then((r) => r.data || []) })
  const [newReason, setNewReason] = useState('')

  const saveRules = useMutation({ mutationFn: (r: any) => api.put('/settings/config/SYSTEM_RULES', r), onSuccess: () => qc.invalidateQueries({ queryKey: ['system-rules'] }) })
  const saveReasons = useMutation({ mutationFn: (r: any) => api.put('/settings/config/ARCHIVE_REASONS', r), onSuccess: () => qc.invalidateQueries({ queryKey: ['archive-reasons'] }) })

  if (!rules) return <Loading />
  const list = reasons || []

  return (
    <div style={{ maxWidth: 560 }}>
      <h3 style={{ fontSize: 14, marginBottom: 12 }}>قوانین یکپارچگی داده</h3>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, fontSize: 13 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={rules.preventDeleteActive} onChange={(e) => saveRules.mutate({ ...rules, preventDeleteActive: e.target.checked })} />
        عدم امکان حذف طرف حسابی که تراکنش یا پروژه فعال دارد
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 20, fontSize: 13 }}>
        <input type="checkbox" style={{ width: 'auto' }} checked={rules.enableAuditLog} onChange={(e) => saveRules.mutate({ ...rules, enableAuditLog: e.target.checked })} />
        فعال‌سازی ثبت خودکار تاریخچه
      </label>

      <h3 style={{ fontSize: 14, marginBottom: 8 }}>دلایل بایگانی (قابل ویرایش)</h3>
      <div className="add-form">
        <input placeholder="دلیل جدید" value={newReason} onChange={(e) => setNewReason(e.target.value)} style={{ maxWidth: 240 }} />
        <button className="btn-primary btn-sm" disabled={!newReason} onClick={() => { saveReasons.mutate([...list, newReason]); setNewReason('') }}>افزودن</button>
      </div>
      <ul className="simple-list">
        {list.map((r: string, i: number) => (
          <li key={i}><span>{r}</span><button className="btn-danger btn-sm" onClick={() => saveReasons.mutate(list.filter((_: string, j: number) => j !== i))}>حذف</button></li>
        ))}
        {list.length === 0 && <li><span className="muted">دلیل سفارشی اضافه نشده (دلایل پیش‌فرض سیستم فعال‌اند)</span></li>}
      </ul>
    </div>
  )
}


function SimpleListTab({ endpoint, label }: { endpoint: string; label: string }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const key = [endpoint]

  const { data: items = [] } = useQuery({ queryKey: key, queryFn: () => api.get(endpoint).then((r) => r.data) })
  const create = useMutation({
    mutationFn: () => api.post(endpoint, { name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); setName('') },
  })
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`${endpoint}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  })

  return (
    <div>
      <div className="add-form">
        <input placeholder={`نام ${label}`} value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn-primary btn-sm" onClick={() => create.mutate()} disabled={!name}>افزودن</button>
      </div>
      <ul className="simple-list">
        {items.map((item: any) => (
          <li key={item.id}>
            <span>{item.name}</span>
            <button className="btn-danger btn-sm" onClick={() => del.mutate(item.id)}>حذف</button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// مودال ویرایش عمومی (فیلد-محور) — برای ویرایش طرف‌حساب‌ها در تنظیمات
function EntityEditModal({ title, fields, initial, onClose, onSave, busy }: {
  title: string
  fields: { key: string; label: string; type?: string }[]
  initial: Record<string, any>
  onClose: () => void
  onSave: (data: Record<string, any>) => void
  busy?: boolean
}) {
  const [form, setForm] = useState<Record<string, any>>(() => {
    const f: Record<string, any> = {}
    fields.forEach((fl) => { f[fl.key] = initial[fl.key] ?? '' })
    return f
  })
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 480 }}>
        <div className="modal-header"><h2>{title}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          {fields.map((f) => (
            <div className="form-group" key={f.key}>
              <label>{f.label}</label>
              <input type={f.type || 'text'} value={form[f.key] ?? ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>انصراف</button>
          <button className="btn-primary" disabled={busy} onClick={() => onSave(form)}>ذخیره</button>
        </div>
      </div>
    </div>
  )
}
