import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { fileUrl } from '../../lib/api'
import { Loading, Alert } from '../../components/ui'
import { dialog, toast } from '../../components/ui/dialog'
import NumberInput from '../../components/shared/NumberInput'
import DateField from '../../components/shared/DateField'
import { formatDateTime } from '../../lib/date'
import { fmtIqd } from './shared'
import { useWaStatus, getBridgeKey, rotateBridgeKey, listJobs, retryJob, dropJob, type WaJob } from './waBridge'
import Icon, { type IconName } from '../../components/ui/Icon'
import { WHATSAPP_SEND_ENABLED } from '../../lib/appMode'

type Tab = 'products' | 'cities' | 'templates' | 'rate' | 'export' | 'whatsapp' | 'activity'

/** تنظیمات ماژول: محصولات و قیمت پایه، شهرها، قالب‌های پیام و نرخ دینار */
export default function MarketSettings() {
  const [tab, setTab] = useState<Tab>('products')
  const TABS: { key: Tab; label: string; icon: IconName }[] = [
    { key: 'products', label: 'محصولات', icon: 'grid' },
    { key: 'cities', label: 'شهرها', icon: 'pin' },
    { key: 'templates', label: 'قالب پیام', icon: 'chat' },
    { key: 'rate', label: 'نرخ دینار', icon: 'banknote' },
    { key: 'export', label: 'خروجی گرفتن', icon: 'download' },
    // تب واتساپ فقط وقتی هست که خودِ قابلیت روشن باشد
    ...(WHATSAPP_SEND_ENABLED ? [{ key: 'whatsapp' as Tab, label: 'واتساپ', icon: 'chat' as IconName }] : []),
    { key: 'activity', label: 'دفترچهٔ تغییرات', icon: 'history' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="cmd-chips">
        {TABS.map((t) => (
          <button key={t.key} className={`band-chip ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}
            aria-current={tab === t.key ? 'true' : undefined}>
            <Icon name={t.icon} />{t.label}
          </button>
        ))}
      </div>
      {tab === 'products' && <ProductsTab />}
      {tab === 'cities' && <CitiesTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'rate' && <RateTab />}
      {tab === 'export' && <ExportTab />}
      {tab === 'whatsapp' && WHATSAPP_SEND_ENABLED && <WhatsAppTab />}
      {tab === 'activity' && <ActivityTab />}
    </div>
  )
}

// ─── واتساپ ──────────────────────────────────────────
/**
 * اتصال واتساپ و صفِ پیام‌ها.
 *
 * چرا معماری‌اش این‌طوری است: سرور در تهران است و از آن‌جا نه
 * `web.whatsapp.com` باز می‌شود نه `graph.facebook.com` — یعنی نه اتصال
 * مستقیم ممکن است نه API رسمی متا. و صفحه هم نمی‌تواند با برنامهٔ روی
 * `localhost` حرف بزند، چون کروم می‌بنددش (امتحان شد و بسته بود). پس پیام در
 * صفِ سرور می‌نشیند و برنامهٔ کوچکی روی لپ‌تاپ می‌آید و برش می‌دارد.
 */
function WhatsAppTab() {
  const { status: b } = useWaStatus(true, 3000)
  const [key, setKey] = useState<string | null>(null)
  const [jobs, setJobs] = useState<WaJob[]>([])

  const loadJobs = () => listJobs({ take: '20' }).then(setJobs).catch(() => {})
  useEffect(() => { loadJobs(); const t = setInterval(loadJobs, 5000); return () => clearInterval(t) }, [])
  useEffect(() => { getBridgeKey().then(setKey).catch(() => {}) }, [])

  const rotate = async () => {
    const ok = await dialog.confirm({
      title: 'ساخت کد اتصال تازه؟',
      message: 'کد فعلی باطل می‌شود و تا وقتی کد تازه را در فایل config.json پل نگذارید، هیچ پیامی فرستاده نمی‌شود.',
      confirmLabel: 'کد تازه بساز', tone: 'danger',
    })
    if (!ok) return
    try { setKey(await rotateBridgeKey()); toast.success('کد تازه ساخته شد') }
    catch { toast.error('ساخته نشد') }
  }

  const TONE: Record<string, { label: string; color: string; icon: IconName }> = {
    connected: { label: 'وصل است', color: 'var(--success)', icon: 'check' },
    qr: { label: 'منتظر اسکن کد', color: '#b45309', icon: 'clock' },
    starting: { label: 'در حال اتصال…', color: '#b45309', icon: 'clock' },
    'logged-out': { label: 'از گوشی قطع شده', color: 'var(--danger)', icon: 'alert' },
    error: { label: 'خطا', color: 'var(--danger)', icon: 'alert' },
    offline: { label: 'پل روی لپ‌تاپ روشن نیست', color: 'var(--text-muted)', icon: 'cloud-off' },
  }
  const t = TONE[b.status] || TONE.offline

  const JOB_FA: Record<string, string> = {
    PENDING: 'در صف', SENDING: 'در حال ارسال', SENT: 'فرستاده شد', FAILED: 'نرفت', CANCELLED: 'لغو شد',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="panel panel-pad">
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          <span className="chip-soft" style={{ color: t.color, borderColor: 'currentColor', fontWeight: 800 }}>
            <Icon name={t.icon} size={13} />{t.label}
          </span>
          {b.me?.number && <strong dir="ltr" style={{ fontSize: 13 }}>+{b.me.number}</strong>}
          {b.me?.name && <span className="hint-sm">{b.me.name}</span>}
          <span className="hint-sm" style={{ marginRight: 'auto' }}>
            {typeof b.sentToday === 'number' && <>امروز {b.sentToday} از {b.dailyCap} پیام · فاصله {Math.round((b.minGapMs || 0) / 1000)} ثانیه · </>}
            {b.pending} در صف{b.failed ? ` · ${b.failed} ناموفق` : ''}
          </span>
        </div>
        {b.error && <div className="hint-sm" style={{ color: 'var(--danger)', marginTop: 7 }}>{b.error}</div>}
      </div>

      {b.status === 'qr' && b.qr && (
        <div className="panel panel-pad" style={{ textAlign: 'center' }}>
          <h3 style={{ fontSize: 14, fontWeight: 800, marginBottom: 4 }}>کد را با گوشی اسکن کنید</h3>
          <p className="hint-sm" style={{ marginBottom: 12 }}>
            واتساپِ گوشی ← منو ← <strong>دستگاه‌های متصل</strong> ← «اتصال دستگاه» ← این کد را بگیرید.
            فقط یک‌بار لازم است؛ بعدش تا وقتی خودتان از گوشی قطع نکنید وصل می‌ماند.
          </p>
          <img src={b.qr} alt="کد QR اتصال واتساپ" width={280} height={280}
            style={{ borderRadius: 10, border: '1px solid var(--border)' }} />
          <p className="hint-sm" style={{ marginTop: 10 }}>کد هر چند ثانیه نو می‌شود — همین صفحه خودش تازه‌اش می‌کند.</p>
        </div>
      )}

      {b.status === 'offline' && (
        <div className="panel panel-pad">
          <h3 style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>راه‌اندازی — فقط یک‌بار</h3>
          <ol style={{ fontSize: 13, lineHeight: 2.2, paddingInlineStart: 20 }}>
            <li>در پوشهٔ <code>factory\whatsapp-bridge</code> از فایل <code>config.example.json</code> یک
              کپی به نام <code>config.json</code> بسازید.</li>
            <li>کد اتصال پایین را کپی کنید و به‌جای مقدار <code>bridgeKey</code> داخلش بگذارید.</li>
            <li>فایل <code>شروع-پل-واتساپ.cmd</code> را دوبار کلیک کنید.</li>
            <li>پنجرهٔ سیاهی باز می‌شود — <strong>بازش بگذارید</strong>. همین صفحه چند ثانیه بعد کد QR را نشان می‌دهد.</li>
          </ol>
          <p className="hint-sm">
            لپ‌تاپ که خاموش باشد، پیام‌ها در صف می‌مانند و دفعهٔ بعد که پل را باز کنید خودشان می‌روند.
          </p>
        </div>
      )}

      {b.status === 'logged-out' && (
        <div className="alert alert-warning">
          نشست واتساپ از گوشی قطع شده. پنجرهٔ پل را ببندید و دوباره <code>شروع-پل-واتساپ.cmd</code> را
          اجرا کنید تا کد تازه بدهد.
        </div>
      )}

      <div className="panel panel-pad">
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>کد اتصال پل</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input dir="ltr" readOnly value={key || '…'} onFocus={(e) => e.currentTarget.select()}
              style={{ flex: 1, minWidth: 220, fontFamily: 'monospace', fontSize: 12 }} />
            <button className="btn-secondary btn-sm" disabled={!key}
              onClick={() => { navigator.clipboard.writeText(key || ''); toast.success('کپی شد') }}>
              <Icon name="copy" /> کپی
            </button>
            <button className="btn-ghost btn-sm" onClick={rotate}>کد تازه</button>
          </div>
          <p className="hint-sm" style={{ marginTop: 5 }}>
            این کد فقط به صف واتساپ دسترسی می‌دهد، نه به بقیهٔ سامانه. اگر جایی لو رفت «کد تازه» بزنید.
          </p>
        </div>
      </div>

      {jobs.length > 0 && (
        <div className="panel panel-pad">
          <h3 style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 8 }}>آخرین پیام‌ها</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {jobs.map((j) => (
              <div key={j.id} className="panel" style={{ padding: '7px 9px', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="chip-soft" style={{
                  flex: 'none',
                  color: j.status === 'SENT' ? 'var(--success)' : j.status === 'FAILED' ? 'var(--danger)' : 'var(--text-muted)',
                }}>{JOB_FA[j.status] || j.status}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700 }}>{(j as any).contact?.name || j.phone}</span>
                <span className="hint-sm" style={{ flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {j.imageUrl ? '[عکس] ' : ''}{j.text.slice(0, 70)}
                </span>
                {j.error && <span className="hint-sm" style={{ color: 'var(--danger)', flexBasis: '100%' }}>{j.error}</span>}
                {j.status === 'FAILED' && (
                  <>
                    <button className="btn-secondary btn-sm" onClick={() => retryJob(j.id).then(loadJobs)}>تلاش دوباره</button>
                    <button className="icon-btn danger" aria-label="حذف از صف" onClick={() => dropJob(j.id).then(loadJobs)}><Icon name="trash" /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="alert alert-warning">
        <strong>این را حتماً بخوانید.</strong>
        <div style={{ marginTop: 5, fontSize: 12.5, lineHeight: 2 }}>
          این اتصال از راه رسمیِ متا نیست. API رسمی واتساپ (Cloud API) تأیید کسب‌وکار و پرداخت به متا
          می‌خواهد که برای یک شرکت ایرانی عملاً بسته است، و از سرور تهران اصلاً
          {' '}<code dir="ltr">graph.facebook.com</code> باز نمی‌شود. پس تنها راهِ «یک کلیک، رفت» همین است.
          <br />
          در عوض یک ریسک واقعی دارد: واتساپ می‌تواند شماره‌ای را که پیام انبوهِ تبلیغاتی به آدم‌های
          ناآشنا می‌فرستد <strong>مسدود کند</strong>. برای همین:
          <br />۱) بهتر است شمارهٔ کاری جداگانه‌ای برای این کار بگذارید، نه شمارهٔ اصلی شرکت.
          <br />۲) ارسال گروهی به کل لیست عمداً ساخته نشده — فقط یکی‌یکی از پروندهٔ هر مخاطب.
          <br />۳) بین دو ارسال فاصلهٔ اجباری هست و سقف روزانه اعمال می‌شود.
          <br />۴) به شماره‌ای که واتساپ ندارد پیام فرستاده نمی‌شود (اول بررسی می‌شود).
        </div>
      </div>
    </div>
  )
}

// ─── دفترچهٔ تغییرات ─────────────────────────────────────
const ENTITY_FA: Record<string, string> = {
  MarketContact: 'مخاطب', MarketCall: 'گفت‌وگو', MarketInterest: 'نظر محصول',
  MarketPromise: 'تعهد ارسال', MarketFile: 'پیوست', MarketProduct: 'محصول',
  MarketCity: 'شهر', MarketTemplate: 'قالب پیام', MarketSetting: 'تنظیمات',
}
const ACTION_FA: Record<string, { label: string; color: string }> = {
  CREATE: { label: 'افزودن', color: 'var(--success)' },
  UPDATE: { label: 'ویرایش', color: 'var(--brand)' },
  DELETE: { label: 'حذف', color: 'var(--danger)' },
}

/**
 * «چه کسی، کِی، چه چیزی را عوض کرد».
 *
 * سرور برای هر نوشتنِ موفق یک جملهٔ فارسی می‌سازد و همین‌جا نشان داده می‌شود.
 * دفترچهٔ عمومیِ سیستم (`/audit-log`) نقشِ دیگری دارد و دسترسی‌اش هم فقط
 * مدیر کل است؛ این یکی به مجوز همین ماژول گره خورده.
 */
function ActivityTab() {
  const [f, setF] = useState<Record<string, string>>({})
  const [skip, setSkip] = useState(0)
  const TAKE = 60
  const set = (patch: Record<string, string>) => { setSkip(0); setF({ ...f, ...patch }) }

  const { data, isLoading } = useQuery({
    queryKey: ['market-activity', f, skip],
    queryFn: () => api.get('/market/activity', { params: { ...f, take: TAKE, skip } }).then((r) => r.data),
  })
  const { data: facets } = useQuery({
    queryKey: ['market-activity-facets'],
    queryFn: () => api.get('/market/activity/facets').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  })

  const rows: any[] = data?.rows || []
  const total: number = data?.total || 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="panel panel-pad">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>نوع اتفاق</label>
            <select value={f.action || ''} onChange={(e) => set({ action: e.target.value })}>
              <option value="">همه</option>
              {Object.entries(ACTION_FA).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>روی چه چیزی</label>
            <select value={f.entity || ''} onChange={(e) => set({ entity: e.target.value })}>
              <option value="">همه</option>
              {(facets?.entities || []).map((e: string) => <option key={e} value={e}>{ENTITY_FA[e] || e}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>توسط چه کسی</label>
            <select value={f.userId || ''} onChange={(e) => set({ userId: e.target.value })}>
              <option value="">همه</option>
              {(facets?.users || []).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>از تاریخ</label>
            <DateField value={f.from || ''} onChange={(v) => set({ from: v })} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>تا تاریخ</label>
            <DateField value={f.to || ''} onChange={(v) => set({ to: v })} />
          </div>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label>جستجو در متن</label>
            <input value={f.search || ''} placeholder="نام مغازه، مقدار…" onChange={(e) => set({ search: e.target.value })} />
          </div>
        </div>
        <div className="hint-sm" style={{ marginTop: 9 }}>
          {total.toLocaleString('fa-IR')} رویداد ثبت شده
          {Object.values(f).some(Boolean) && (
            <button className="btn-ghost btn-sm" style={{ marginInlineStart: 8 }} onClick={() => { setF({}); setSkip(0) }}>
              <Icon name="x" /> پاک‌کردن فیلترها
            </button>
          )}
        </div>
      </div>

      {isLoading ? <Loading /> : rows.length === 0 ? (
        <div className="panel panel-pad" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          رویدادی با این فیلترها نیست.
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 150 }}>تاریخ و ساعت</th>
                <th style={{ width: 120 }}>توسط</th>
                <th style={{ width: 90 }}>نوع</th>
                <th style={{ width: 110 }}>روی</th>
                <th>چه اتفاقی</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const a = ACTION_FA[r.action] || { label: r.action, color: 'var(--text-muted)' }
                const ch = r.changes || {}
                return (
                  <tr key={r.id}>
                    <td className="hint-sm nowrap">{formatDateTime(r.createdAt)}</td>
                    <td className="hint-sm">{r.user?.name || '—'}</td>
                    <td><span className="chip-soft" style={{ color: a.color }}>{a.label}</span></td>
                    <td className="hint-sm">{ENTITY_FA[r.entity] || r.entity}</td>
                    <td style={{ fontSize: 12.5 }}>
                      <strong>{ch.what || '—'}</strong>
                      {ch.subject ? <span className="hint-sm"> · {ch.subject}</span> : null}
                      {ch.detail ? <div className="hint-sm" style={{ marginTop: 2 }}>{ch.detail}</div> : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > TAKE && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
          <button className="btn-secondary btn-sm" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - TAKE))}>
            <Icon name="chevron-right" /> جدیدتر
          </button>
          <span className="hint-sm">{Math.floor(skip / TAKE) + 1} از {Math.ceil(total / TAKE)}</span>
          <button className="btn-secondary btn-sm" disabled={skip + TAKE >= total} onClick={() => setSkip(skip + TAKE)}>
            قدیمی‌تر <Icon name="chevron-left" />
          </button>
        </div>
      )}
    </div>
  )
}

// ─── محصولات ─────────────────────────────────────────
function ProductsTab() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [nw, setNw] = useState({ name: '', nameAr: '', nameEn: '', unit: '', listPriceUsd: '' })

  const { data: products = [], isLoading } = useQuery({ queryKey: ['market-products'], queryFn: () => api.get('/market/products').then((r) => r.data) })
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['market-products'] }); qc.invalidateQueries({ queryKey: ['market-contact'] }) }

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api.patch(`/market/products/${id}`, body),
    onSuccess: invalidate, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const create = useMutation({
    mutationFn: () => api.post('/market/products', nw),
    onSuccess: () => { invalidate(); setNw({ name: '', nameAr: '', nameEn: '', unit: '', listPriceUsd: '' }); setAdding(false); toast.success('محصول اضافه شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/market/products/${id}`),
    onSuccess: () => { invalidate(); toast.success('حذف شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  if (isLoading) return <Loading />

  return (
    <div className="panel panel-pad">
      <Alert tint="info">
        نام عربی و انگلیسی در قالب پیام واتساپ استفاده می‌شوند. قیمت پایه در گرید نظرها و در پیام‌ها ({'{{price}}'}) نمایش داده می‌شود.
        <br />عکس هر محصول روی «برگهٔ محصولات» چاپ می‌شود — همان تصویری که در واتساپ می‌فرستید. محصول بی‌عکس با حرف اول نامش کشیده می‌شود.
      </Alert>
      <div className="table-container" style={{ marginTop: 12 }}>
        <table className="data-table">
          <thead><tr><th style={{ width: 62 }}>عکس</th><th>نام</th><th>عربی</th><th>انگلیسی</th><th>واحد</th><th>قیمت پایه ($)</th><th>حداقل سفارش</th><th>فعال</th><th style={{ width: 50 }}></th></tr></thead>
          <tbody>
            {products.map((p: any) => (
              <tr key={p.id}>
                <td><ProductImage p={p} onChanged={invalidate} /></td>
                <td><input defaultValue={p.name} style={{ fontSize: 12.5 }} onBlur={(e) => e.target.value !== p.name && patch.mutate({ id: p.id, body: { name: e.target.value } })} /></td>
                <td><input dir="rtl" defaultValue={p.nameAr || ''} style={{ fontSize: 12.5 }} onBlur={(e) => e.target.value !== (p.nameAr || '') && patch.mutate({ id: p.id, body: { nameAr: e.target.value } })} /></td>
                <td><input dir="ltr" defaultValue={p.nameEn || ''} style={{ fontSize: 12.5 }} onBlur={(e) => e.target.value !== (p.nameEn || '') && patch.mutate({ id: p.id, body: { nameEn: e.target.value } })} /></td>
                <td><input defaultValue={p.unit || ''} style={{ fontSize: 12.5, width: 70 }} onBlur={(e) => e.target.value !== (p.unit || '') && patch.mutate({ id: p.id, body: { unit: e.target.value } })} /></td>
                <td style={{ width: 110 }}><NumberInput decimals value={p.listPriceUsd ?? ''} onChange={(v) => patch.mutate({ id: p.id, body: { listPriceUsd: v } })} /></td>
                <td><input defaultValue={p.moq || ''} placeholder="مثلاً ۱۰ عدد" style={{ fontSize: 12.5, width: 100 }} onBlur={(e) => e.target.value !== (p.moq || '') && patch.mutate({ id: p.id, body: { moq: e.target.value } })} /></td>
                <td><input type="checkbox" checked={p.isActive} onChange={(e) => patch.mutate({ id: p.id, body: { isActive: e.target.checked } })} /></td>
                <td><button className="icon-btn" title="حذف" onClick={async () => {
                  if (await dialog.confirm({ title: 'حذف محصول؟', message: `«${p.name}» حذف می‌شود. اگر نظری برایش ثبت شده باشد، به‌جای حذف باید غیرفعالش کنید.`, confirmLabel: 'حذف', tone: 'danger' })) del.mutate(p.id)
                }}><Icon name="trash" /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding ? (
        <div className="panel panel-pad" style={{ marginTop: 12 }}>
          <div className="form-grid-2">
            <div className="form-group"><label>نام *</label><input autoFocus value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} /></div>
            <div className="form-group"><label>نام عربی</label><input dir="rtl" value={nw.nameAr} onChange={(e) => setNw({ ...nw, nameAr: e.target.value })} /></div>
            <div className="form-group"><label>نام انگلیسی</label><input dir="ltr" value={nw.nameEn} onChange={(e) => setNw({ ...nw, nameEn: e.target.value })} /></div>
            <div className="form-group"><label>واحد</label><input value={nw.unit} onChange={(e) => setNw({ ...nw, unit: e.target.value })} placeholder="عدد، دستگاه…" /></div>
            <div className="form-group"><label>قیمت پایه ($)</label><NumberInput decimals value={nw.listPriceUsd} onChange={(v) => setNw({ ...nw, listPriceUsd: v })} /></div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-primary btn-sm" disabled={!nw.name.trim() || create.isPending} onClick={() => create.mutate()}>افزودن</button>
            <button className="btn-secondary btn-sm" onClick={() => setAdding(false)}>انصراف</button>
          </div>
        </div>
      ) : (
        <button className="btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => setAdding(true)}>+ محصول جدید</button>
      )}
    </div>
  )
}

/**
 * عکس محصول — کوچک و درجا، چون تنها مصرفش «برگهٔ محصولات» واتساپ است و
 * فرستادن کاربر به یک صفحهٔ جدا برای یک فایل ارزشش را ندارد.
 */
function ProductImage({ p, onChanged }: { p: any; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const upload = async (file: File) => {
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api.post(`/market/products/${p.id}/image`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      onChanged()
    } catch (e: any) { toast.error(e.response?.data?.message || 'بارگذاری نشد') }
    finally { setBusy(false) }
  }
  const clear = async () => {
    try { await api.delete(`/market/products/${p.id}/image`); onChanged() } catch { toast.error('حذف نشد') }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <label title={p.imageUrl ? 'تعویض عکس' : 'افزودن عکس'}
        style={{ cursor: busy ? 'wait' : 'pointer', width: 40, height: 40, flex: 'none', borderRadius: 7, overflow: 'hidden',
          border: '1px dashed var(--border-strong)', display: 'grid', placeItems: 'center', background: 'var(--surface-2)' }}>
        {p.imageUrl
          ? <img src={fileUrl(p.imageUrl)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <Icon name={busy ? 'clock' : 'image'} size={15} style={{ color: 'var(--text-muted)' }} />}
        <input type="file" accept="image/*" hidden disabled={busy}
          onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </label>
      {p.imageUrl && <button className="icon-btn danger" title="حذف عکس" aria-label={`حذف عکس ${p.name}`} onClick={clear}><Icon name="x" /></button>}
    </div>
  )
}

// ─── شهرها ───────────────────────────────────────────
function CitiesTab() {
  const qc = useQueryClient()
  const [nw, setNw] = useState({ governorate: '', name: '', nameAr: '' })
  const [filter, setFilter] = useState('')

  const { data: cities = [], isLoading } = useQuery({ queryKey: ['market-cities'], queryFn: () => api.get('/market/cities').then((r) => r.data) })
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['market-cities'] }); qc.invalidateQueries({ queryKey: ['market-analytics'] }) }

  const create = useMutation({
    mutationFn: () => api.post('/market/cities', nw),
    onSuccess: () => { invalidate(); setNw({ governorate: nw.governorate, name: '', nameAr: '' }); toast.success('شهر اضافه شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api.patch(`/market/cities/${id}`, body),
    onSuccess: invalidate, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/market/cities/${id}`),
    onSuccess: () => { invalidate(); toast.success('حذف شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  if (isLoading) return <Loading />
  const govs = [...new Set(cities.map((c: any) => c.governorate))] as string[]
  const shown = filter ? cities.filter((c: any) => c.governorate === filter) : cities

  return (
    <div className="panel panel-pad">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 150 }}>
          <label>استان</label>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">همه ({cities.length} شهر)</option>
            {govs.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 140 }}>
          <label>استان شهر جدید</label>
          <input list="gov-list" value={nw.governorate} onChange={(e) => setNw({ ...nw, governorate: e.target.value })} />
          <datalist id="gov-list">{govs.map((g) => <option key={g} value={g} />)}</datalist>
        </div>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 130 }}>
          <label>نام شهر</label>
          <input value={nw.name} onChange={(e) => setNw({ ...nw, name: e.target.value })} />
        </div>
        <div className="form-group" style={{ marginBottom: 0, minWidth: 130 }}>
          <label>نام عربی</label>
          <input dir="rtl" value={nw.nameAr} onChange={(e) => setNw({ ...nw, nameAr: e.target.value })} />
        </div>
        <button className="btn-primary btn-sm" disabled={!nw.governorate.trim() || !nw.name.trim() || create.isPending} onClick={() => create.mutate()}>+ افزودن</button>
      </div>

      <div className="table-container" style={{ maxHeight: 460, overflowY: 'auto' }}>
        <table className="data-table">
          <thead><tr><th>استان</th><th>شهر</th><th>نام عربی</th><th>مخاطب</th><th>فعال</th><th style={{ width: 50 }}></th></tr></thead>
          <tbody>
            {shown.map((c: any) => (
              <tr key={c.id}>
                <td className="hint-sm">{c.governorate}</td>
                <td><input defaultValue={c.name} style={{ fontSize: 12.5 }} onBlur={(e) => e.target.value !== c.name && patch.mutate({ id: c.id, body: { name: e.target.value } })} /></td>
                <td><input dir="rtl" defaultValue={c.nameAr || ''} style={{ fontSize: 12.5 }} onBlur={(e) => e.target.value !== (c.nameAr || '') && patch.mutate({ id: c.id, body: { nameAr: e.target.value } })} /></td>
                <td><strong>{c._count?.contacts ?? 0}</strong></td>
                <td><input type="checkbox" checked={c.isActive} onChange={(e) => patch.mutate({ id: c.id, body: { isActive: e.target.checked } })} /></td>
                <td>
                  {(c._count?.contacts ?? 0) === 0 && (
                    <button className="icon-btn" title="حذف" onClick={() => del.mutate(c.id)} aria-label="حذف"><Icon name="trash" /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── قالب‌های پیام ───────────────────────────────────
function TemplatesTab() {
  const qc = useQueryClient()
  // «دامنه» = این قالب‌ها مالِ کدام محصول‌اند. '' یعنی عمومی (به محصول خاصی ربط ندارد).
  const [scope, setScope] = useState<string>('')
  const [adding, setAdding] = useState(false)
  const [nw, setNw] = useState({ title: '', body: '', language: 'AR' })

  const { data: templates = [], isLoading } = useQuery({ queryKey: ['market-templates'], queryFn: () => api.get('/market/templates').then((r) => r.data) })
  const { data: products = [] } = useQuery({ queryKey: ['market-products'], queryFn: () => api.get('/market/products').then((r) => r.data) })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['market-templates'] })

  const create = useMutation({
    mutationFn: () => api.post('/market/templates', { ...nw, productId: scope || undefined }),
    onSuccess: () => { invalidate(); setNw({ title: '', body: '', language: 'AR' }); setAdding(false); toast.success('قالب ساخته شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) => api.patch(`/market/templates/${id}`, body),
    onSuccess: invalidate, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/market/templates/${id}`), onSuccess: () => { invalidate(); toast.success('حذف شد') } })

  if (isLoading) return <Loading />

  const countFor = (pid: string) => templates.filter((t: any) => (t.productId || '') === pid).length
  const shown = templates.filter((t: any) => (t.productId || '') === scope)
  const activeProducts = products.filter((p: any) => p.isActive)
  const scopeName = scope ? (products.find((p: any) => p.id === scope)?.name || '—') : 'عمومی'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* هر محصول قالب‌های خودش را دارد؛ «عمومی» برای پیام‌هایی است که به محصول
          خاصی ربط ندارند (معرفی شرکت، پیگیری بی‌جواب و…). موقع ارسال هم دقیقاً
          همین تفکیک اعمال می‌شود تا متنِ یک محصول برای محصول دیگر پیشنهاد نشود. */}
      <div className="panel panel-pad">
        <div className="ws-card-title" style={{ marginBottom: 8 }}>قالب‌های کدام محصول؟</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button className={`band-chip ${scope === '' ? 'active' : ''}`} onClick={() => { setScope(''); setAdding(false) }}>
            عمومی (همهٔ محصولات)<span className="n">{countFor('')}</span>
          </button>
          {activeProducts.map((p: any) => (
            <button key={p.id} className={`band-chip ${scope === p.id ? 'active' : ''}`} onClick={() => { setScope(p.id); setAdding(false) }}>
              {p.name}<span className="n">{countFor(p.id)}</span>
            </button>
          ))}
        </div>
      </div>

      <Alert tint="info">
        جای‌گیرهای قابل استفاده: <code>{'{{name}}'}</code> نام مخاطب · <code>{'{{city}}'}</code> شهر ·
        <code>{'{{product}}'}</code> نام محصول · <code>{'{{price}}'}</code> قیمت پایه ·
        <code>{'{{myName}}'}</code> نام شما · <code>{'{{company}}'}</code> نام شرکت
        <br />
        <code>{'{{products}}'}</code> <strong>فهرست همهٔ محصولاتی که موقع ارسال انتخاب می‌کنید</strong> (هر کدام در یک خط، با قیمت).
        اگر قالبی برای چند محصول با هم می‌نویسید، به‌جای {'{{product}}'} از این استفاده کنید.
      </Alert>

      <Alert tint="warning">
        واتساپ اجازه نمی‌دهد فایل به‌صورت خودکار همراه پیام فرستاده شود — این محدودیت خودِ واتساپ است، نه سامانه.
        در پنجرهٔ ارسال، همهٔ محصولات انتخاب‌شده روی <strong>یک «برگهٔ محصولات»</strong> کشیده می‌شوند تا فقط یک تصویر
        بفرستید؛ آن تصویر با «ارسال مستقیم» (پنجرهٔ اشتراک‌گذاری ویندوز) یا با کپی و Ctrl+V در واتساپ‌وب می‌رود.
        پیوست‌هایی که این‌جا اضافه می‌کنید هم کنار همان می‌آیند.
      </Alert>

      {shown.length === 0 && !adding && (
        <div className="panel panel-pad" style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          {scope
            ? `برای «${scopeName}» هنوز قالبی ساخته نشده — مثلاً «معرفی ${scopeName}»، «ارسال قیمت»، «پیگیری بی‌جواب».`
            : 'قالب عمومی‌ای ساخته نشده.'}
        </div>
      )}

      {shown.map((t: any) => (
        <div key={t.id} className="panel panel-pad">
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <input defaultValue={t.title} style={{ fontWeight: 700, maxWidth: 240 }} aria-label="عنوان قالب"
              onBlur={(e) => e.target.value !== t.title && patch.mutate({ id: t.id, body: { title: e.target.value } })} />
            <select value={t.language} style={{ maxWidth: 110 }} aria-label="زبان قالب"
              onChange={(e) => patch.mutate({ id: t.id, body: { language: e.target.value } })}>
              <option value="AR">عربی</option><option value="KU">کردی</option><option value="EN">انگلیسی</option><option value="FA">فارسی</option>
            </select>
            <select value={t.productId || ''} style={{ maxWidth: 175 }} aria-label="این قالب مال کدام محصول است"
              onChange={(e) => patch.mutate({ id: t.id, body: { productId: e.target.value } })}>
              <option value="">عمومی — همهٔ محصولات</option>
              {activeProducts.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <button className="icon-btn danger" style={{ marginInlineStart: 'auto' }} title="حذف قالب" aria-label={`حذف قالب ${t.title}`}
              onClick={async () => {
                if (await dialog.confirm({ title: 'حذف قالب؟', message: `«${t.title}» حذف می‌شود.`, confirmLabel: 'حذف', tone: 'danger' })) del.mutate(t.id)
              }}><Icon name="trash" /></button>
          </div>
          <textarea rows={6} dir="rtl" defaultValue={t.body} aria-label="متن قالب"
            onBlur={(e) => e.target.value !== t.body && patch.mutate({ id: t.id, body: { body: e.target.value } })} />
          <TemplateFiles template={t} onChanged={invalidate} />
        </div>
      ))}

      {adding ? (
        <div className="panel panel-pad" style={{ borderColor: 'var(--brand-300)' }}>
          <div className="hint-sm" style={{ marginBottom: 9 }}>قالب تازه برای: <strong>{scopeName}</strong></div>
          <div className="form-grid-2">
            <div className="form-group"><label>عنوان *</label>
              <input autoFocus value={nw.title} onChange={(e) => setNw({ ...nw, title: e.target.value })}
                placeholder={scope ? `مثلاً معرفی ${scopeName}` : 'مثلاً معرفی شرکت'} />
            </div>
            <div className="form-group"><label>زبان</label>
              <select value={nw.language} onChange={(e) => setNw({ ...nw, language: e.target.value })}>
                <option value="AR">عربی</option><option value="KU">کردی</option><option value="EN">انگلیسی</option><option value="FA">فارسی</option>
              </select>
            </div>
          </div>
          <div className="form-group"><label>متن پیام *</label>
            <textarea rows={6} dir="rtl" value={nw.body} onChange={(e) => setNw({ ...nw, body: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-primary btn-sm" disabled={!nw.title.trim() || !nw.body.trim() || create.isPending} onClick={() => create.mutate()}>ساخت قالب</button>
            <button className="btn-secondary btn-sm" onClick={() => setAdding(false)}>انصراف</button>
          </div>
        </div>
      ) : (
        <button className="btn-secondary btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>
          <Icon name="plus" /> قالب جدید برای «{scopeName}»
        </button>
      )}
    </div>
  )
}

/** پیوست‌های یک قالب پیام — عکس محصول، کاتالوگ، لیست قیمت */
function TemplateFiles({ template, onChanged }: { template: any; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const files: any[] = template.files || []

  const upload = async (file: File) => {
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api.post(`/market/templates/${template.id}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      onChanged()
      toast.success('پیوست اضافه شد')
    } catch (e: any) { toast.error(e.response?.data?.message || 'بارگذاری نشد') }
    finally { setBusy(false) }
  }
  const remove = async (id: string) => {
    try { await api.delete(`/market/templates/files/${id}`); onChanged(); toast.success('حذف شد') }
    catch { toast.error('حذف نشد') }
  }
  const isImage = (f: any) => (f.mime || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(f.originalName)

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: files.length ? 8 : 0 }}>
        <span className="hint-sm" style={{ fontWeight: 700 }}>پیوست ({files.length})</span>
        <label className="btn-secondary btn-sm" style={{ cursor: busy ? 'wait' : 'pointer', margin: 0 }}>
          <Icon name="upload" /> {busy ? 'در حال بارگذاری…' : 'افزودن عکس یا فایل'}
          <input type="file" hidden disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} />
        </label>
      </div>
      {files.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {files.map((f) => (
            <div key={f.id} className="panel" style={{ padding: 7, display: 'flex', alignItems: 'center', gap: 7, maxWidth: 260 }}>
              {isImage(f)
                ? <img src={fileUrl(f.url)} alt="" style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 5, flex: 'none' }} />
                : <span style={{ flex: 'none', color: 'var(--text-muted)' }}><Icon name="paperclip" /></span>}
              <a href={fileUrl(f.url)} target="_blank" rel="noreferrer"
                style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.originalName}
              </a>
              <button className="icon-btn danger" title="حذف پیوست" aria-label={`حذف ${f.originalName}`} onClick={() => remove(f.id)}>
                <Icon name="trash" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── نرخ دینار ───────────────────────────────────────
function RateTab() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['market-settings'],
    queryFn: () => api.get('/market/settings').then((r) => r.data),
  })
  const current = data?.iqdPerUsd ? String(data.iqdPerUsd) : ''
  const [value, setValue] = useState('')
  const rate = Number(value || current) || 0
  // `undefined` یعنی «کاربر هنوز دست نزده» تا مقدارِ آمده از سرور بازنویسی نشود
  const [lineDraft, setLine] = useState<string | undefined>(undefined)
  const line = lineDraft ?? (data?.contactLine || '')
  const [arDraft, setAr] = useState<string | undefined>(undefined)
  const nameAr = arDraft ?? (data?.companyAr || '')

  const save = useMutation({
    mutationFn: () => api.put('/market/settings', { iqdPerUsd: value || current }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['market-settings'] }); toast.success('نرخ ذخیره شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'ذخیره نشد'),
  })
  const saveBrand = useMutation({
    mutationFn: () => api.put('/market/settings', { contactLine: line, companyAr: nameAr }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['market-settings'] }); toast.success('ذخیره شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'ذخیره نشد'),
  })

  if (isLoading) return <Loading />

  return (
    <div className="panel panel-pad" style={{ maxWidth: 460 }}>
      <Alert tint="info">
        قیمت‌ها به دلار ذخیره می‌شوند. این نرخ فقط برای نمایش معادل دینار عراق کنار قیمت‌هاست،
        چون مغازه‌دار عراقی معمولاً به دینار فکر می‌کند.
      </Alert>
      <div className="form-group" style={{ marginTop: 12 }}>
        <label>هر دلار چند دینار عراق؟</label>
        <NumberInput value={value || current} onChange={setValue} placeholder="1320" />
      </div>
      {rate > 0 && (
        <div className="hint-sm" style={{ marginBottom: 12 }}>
          نمونه: ‎$10 ≈ {fmtIqd(10, rate)} · ‎$100 ≈ {fmtIqd(100, rate)}
        </div>
      )}
      <button className="btn-primary btn-sm" disabled={save.isPending || !rate} onClick={() => save.mutate()}>ذخیرهٔ نرخ</button>

      <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <h3 style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 10 }}>سربرگ و پاورقی «برگهٔ محصولات»</h3>
        <div className="form-group">
          <label>نام عربی شرکت</label>
          <input dir="rtl" value={nameAr} onChange={(e) => setAr(e.target.value)} placeholder="مثلاً بويان طب تيكا" />
          <p className="hint-sm" style={{ marginTop: 5 }}>
            بزرگ، بالای تصویر. نام لاتین ({data?.companyName || '—'}) زیرش می‌آید.
            خالی بگذارید تا فقط نام لاتین بیاید. در متن پیام هم با {'{{companyAr}}'} در دسترس است.
          </p>
        </div>
        <div className="form-group">
          <label>خط تماس</label>
          <input dir="ltr" value={line} onChange={(e) => setLine(e.target.value)}
            placeholder="WhatsApp +98 912 000 0000  ·  www.example.com" />
          <p className="hint-sm" style={{ marginTop: 5 }}>
            پایین تصویری که در واتساپ می‌فرستید چاپ می‌شود. همان‌جایی که مشتری باید ببیند چطور با شما تماس بگیرد.
          </p>
        </div>
        <button className="btn-secondary btn-sm" disabled={saveBrand.isPending} onClick={() => saveBrand.mutate()}>ذخیره</button>
      </div>
    </div>
  )
}

// ─── خروجی گرفتن ──────────────────────────────────────
/**
 * از نوار ابزار لیست مخاطبین به این‌جا آمد.
 *
 * تفاوت مهم با قبل: آن‌جا خروجی **دقیقاً همان فیلترهای روی صفحه** را می‌گرفت،
 * ولی این‌جا فیلتری وجود ندارد — پس همهٔ مخاطبین می‌آیند. تنها انتخابی که
 * باقی می‌ماند بایگانی است، چون سرور پیش‌فرض آن‌ها را کنار می‌گذارد و بدون این
 * تیک هیچ راهی برای بیرون کشیدنشان نبود.
 */
function ExportTab() {
  const [withArchived, setWithArchived] = useState(false)
  const [busy, setBusy] = useState<'' | 'xlsx' | 'vcf'>('')

  const download = async (kind: 'xlsx' | 'vcf') => {
    setBusy(kind)
    const today = new Date().toISOString().slice(0, 10)
    try {
      const path = kind === 'xlsx' ? '/market/export.xlsx' : '/market/export.vcf'
      const res = await api.get(path, {
        params: withArchived ? { archived: 'all' } : {},
        responseType: 'blob',
      })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = kind === 'xlsx' ? `market-contacts-${today}.xlsx` : `iraq-contacts-${today}.vcf`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error(kind === 'xlsx' ? 'خروجی اکسل ساخته نشد' : 'فایل مخاطبین ساخته نشد')
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="panel panel-pad" style={{ maxWidth: 560 }}>
      <Alert tint="info">
        هر دو خروجی از همهٔ مخاطبین گرفته می‌شود. بایگانی‌شده‌ها پیش‌فرض نمی‌آیند.
      </Alert>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '14px 0', fontSize: 12.5, cursor: 'pointer' }}>
        <input type="checkbox" checked={withArchived} onChange={(e) => setWithArchived(e.target.checked)} />
        بایگانی‌شده‌ها هم باشند
      </label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div className="ex-row">
          <div>
            <strong>خروجی اکسل</strong>
            <div className="hint-sm">همهٔ ستون‌ها: مشخصات، وضعیت، نظر محصولات، تاریخ پیگیری.</div>
          </div>
          <button className="btn-secondary btn-sm" onClick={() => download('xlsx')} disabled={!!busy}>
            <Icon name="download" /> {busy === 'xlsx' ? 'در حال ساخت…' : 'دریافت'}
          </button>
        </div>

        <div className="ex-row">
          <div>
            <strong>مخاطبین برای گوشی</strong>
            <div className="hint-sm">فایل vCard برای وارد کردن شماره‌ها در گوشی (iOS و اندروید).</div>
          </div>
          <button className="btn-secondary btn-sm" onClick={() => download('vcf')} disabled={!!busy}>
            <Icon name="mobile" /> {busy === 'vcf' ? 'در حال ساخت…' : 'دریافت'}
          </button>
        </div>
      </div>
    </div>
  )
}
