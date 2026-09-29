import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { PageHeader } from '../components/ui'
import { dialog, toast } from '../components/ui/dialog'
import DateField from '../components/shared/DateField'
import NumberInput from '../components/shared/NumberInput'
import SearchableSelect from '../components/shared/SearchableSelect'
import { toShamsi, formatDateTime } from '../lib/date'

const STAGES: { key: string; label: string; color: string }[] = [
  { key: 'NEW', label: 'سرنخ جدید', color: '#64748b' },
  { key: 'CONTACTED', label: 'تماس گرفته شد', color: '#2563eb' },
  { key: 'PROPOSAL', label: 'پیشنهاد داده شد', color: '#7c3aed' },
  { key: 'NEGOTIATION', label: 'مذاکره', color: '#d97706' },
  { key: 'WON', label: 'برد ✓ (تبدیل شد)', color: '#16a34a' },
  { key: 'LOST', label: 'از دست رفت', color: '#dc2626' },
]
const stageOf = (k: string) => STAGES.find((s) => s.key === k) || STAGES[0]
const ITYPES: Record<string, string> = { CALL: '📞 تماس', MEETING: '🤝 جلسه', MESSAGE: '💬 پیام', EMAIL: '✉️ ایمیل', OTHER: '• سایر' }
const fmtValue = (v: number | null | undefined) => (v ? Number(v).toLocaleString('en-US') + ' ت' : '—')

export default function CrmPage() {
  const [view, setView] = useState<'pipeline' | 'followups' | 'analytics'>('pipeline')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  return (
    <div className="page" dir="rtl">
      <PageHeader
        title="CRM — مدیریت ارتباط با مشتری"
        subtitle="سرنخ‌های فروش، قیف، تعاملات و پیگیری تا شروع اولین پروژه"
        actions={<button className="btn-primary" onClick={() => setShowCreate(true)}>+ سرنخ جدید</button>}
        chips={
          <>
            <button className={`band-chip ${view === 'pipeline' ? 'active' : ''}`} onClick={() => setView('pipeline')}>🔻 قیف فروش</button>
            <button className={`band-chip ${view === 'followups' ? 'active' : ''}`} onClick={() => setView('followups')}>⏰ پیگیری‌ها</button>
            <button className={`band-chip ${view === 'analytics' ? 'active' : ''}`} onClick={() => setView('analytics')}>📊 گزارش</button>
          </>
        }
      />

      {view === 'pipeline' ? <Pipeline onOpen={setDetailId} /> : view === 'followups' ? <FollowUps onOpen={setDetailId} /> : <Analytics />}

      {showCreate && <CreateLeadModal onClose={() => setShowCreate(false)} />}
      {detailId && <LeadDrawer id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  )
}

// ─── قیف فروش (کانبان) ───────────────────────────────
function Pipeline({ onOpen }: { onOpen: (id: string) => void }) {
  const { data: leads = [], isLoading } = useQuery({ queryKey: ['crm-leads'], queryFn: () => api.get('/crm/leads').then((r) => r.data) })
  if (isLoading) return <div className="hint" style={{ padding: 20 }}>در حال بارگذاری…</div>

  return (
    <div className="crm-kanban">
      {STAGES.map((s) => {
        const items = leads.filter((l: any) => l.stage === s.key)
        return (
          <div key={s.key} className="crm-col" style={{ ['--stage' as any]: s.color }}>
            <div className="crm-col-head">
              <span className="crm-col-dot" />
              <span className="crm-col-title">{s.label}</span>
              <span className="crm-col-count">{items.length}</span>
            </div>
            <div className="crm-col-body">
              {items.map((l: any) => {
                const overdue = l.nextFollowUpAt && new Date(l.nextFollowUpAt) < new Date()
                return (
                  <button key={l.id} onClick={() => onOpen(l.id)} className="crm-card">
                    <div className="crm-card-name">{l.name}</div>
                    {l.company && <div className="crm-card-sub">{l.company}</div>}
                    {l.estimatedValue ? <div className="crm-card-value">{fmtValue(l.estimatedValue)}</div> : null}
                    <div className="crm-card-meta">
                      {l._count?.interactions ? <span className="chip-soft">💬 {l._count.interactions}</span> : null}
                      {l.nextFollowUpAt ? <span className="chip-soft" style={{ color: overdue ? 'var(--danger)' : 'var(--brand)', borderColor: overdue ? 'var(--danger)' : undefined }}>⏰ {toShamsi(l.nextFollowUpAt)}</span> : null}
                      {l.assignedTo ? <span className="chip-soft">👤 {l.assignedTo.name}</span> : null}
                    </div>
                  </button>
                )
              })}
              {items.length === 0 && <div className="crm-col-empty">موردی نیست</div>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── پیگیری‌ها ───────────────────────────────────────
function FollowUps({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['crm-followups'], queryFn: () => api.get('/crm/follow-ups').then((r) => r.data) })
  if (isLoading) return <div className="hint" style={{ padding: 20 }}>در حال بارگذاری…</div>
  const groups: { title: string; color: string; items: any[] }[] = [
    { title: '🔴 عقب‌افتاده', color: 'var(--danger)', items: data?.overdue || [] },
    { title: '🟡 امروز', color: '#d97706', items: data?.today || [] },
    { title: '🔵 آینده', color: 'var(--brand)', items: data?.upcoming || [] },
  ]
  const total = groups.reduce((s, g) => s + g.items.length, 0)
  if (total === 0) return <div className="panel panel-pad" style={{ textAlign: 'center', color: 'var(--text-muted)' }}>پیگیری معلقی ندارید ✓</div>
  return (
    <div className="grid-3">
      {groups.map((g) => (
        <div key={g.title} className="panel panel-pad">
          <h4 style={{ fontSize: 13, color: g.color, marginBottom: 10 }}>{g.title} ({g.items.length})</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {g.items.map((l: any) => (
              <button key={l.id} onClick={() => onOpen(l.id)} className="crm-card">
                <div style={{ fontWeight: 700, fontSize: 13 }}>{l.name}</div>
                {l.company && <div className="hint-sm">{l.company}</div>}
                <div className="hint-sm" style={{ marginTop: 4, color: g.color }}>⏰ {toShamsi(l.nextFollowUpAt)} · {stageOf(l.stage).label}</div>
              </button>
            ))}
            {g.items.length === 0 && <div className="hint-sm" style={{ opacity: .6 }}>—</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── گزارش و تحلیل فروش ──────────────────────────────
function Analytics() {
  const { data, isLoading } = useQuery({ queryKey: ['crm-analytics'], queryFn: () => api.get('/crm/analytics').then((r) => r.data) })
  if (isLoading) return <div className="hint" style={{ padding: 20 }}>در حال بارگذاری…</div>
  if (!data) return null
  const maxCount = Math.max(1, ...STAGES.map((s) => data.byStage[s.key]?.count || 0))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="grid-3">
        <div className="panel panel-pad" style={{ textAlign: 'center' }}><div style={{ fontSize: 24, fontWeight: 800, color: 'var(--brand)' }}>{data.total}</div><div className="hint-sm">کل سرنخ‌ها</div></div>
        <div className="panel panel-pad" style={{ textAlign: 'center' }}><div style={{ fontSize: 24, fontWeight: 800, color: 'var(--success)' }}>{data.conversionRate}%</div><div className="hint-sm">نرخ تبدیل</div></div>
        <div className="panel panel-pad" style={{ textAlign: 'center' }}><div style={{ fontSize: 17, fontWeight: 800 }}>{fmtValue(data.openValue)}</div><div className="hint-sm">ارزش قیف باز</div></div>
      </div>

      <div className="panel panel-pad">
        <h4 className="section-title">قیف فروش به تفکیک مرحله</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {STAGES.map((s) => {
            const st = data.byStage[s.key] || { count: 0, value: 0 }
            return (
              <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 120, fontSize: 12, flexShrink: 0 }}>{s.label}</span>
                <div style={{ flex: 1, background: 'var(--bg)', borderRadius: 6, height: 20, overflow: 'hidden' }}>
                  <div style={{ width: `${(st.count / maxCount) * 100}%`, background: s.color, height: '100%', borderRadius: 6, minWidth: st.count ? 4 : 0 }} />
                </div>
                <span style={{ width: 34, textAlign: 'left', fontWeight: 700, fontSize: 13 }}>{st.count}</span>
                <span className="hint-sm" style={{ width: 110, textAlign: 'left' }}>{fmtValue(st.value)}</span>
              </div>
            )
          })}
        </div>
      </div>

      <div className="grid-2">
        <div className="panel panel-pad">
          <h4 className="section-title">نتیجه</h4>
          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1, textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: 'var(--success)' }}>{data.won}</div><div className="hint-sm">برد ({fmtValue(data.wonValue)})</div></div>
            <div style={{ flex: 1, textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: 'var(--danger)' }}>{data.lost}</div><div className="hint-sm">باخت</div></div>
          </div>
        </div>
        <div className="panel panel-pad">
          <h4 className="section-title">سرنخ به تفکیک منبع</h4>
          {data.bySource.length === 0 ? <div className="hint-sm">—</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {data.bySource.map((s: any) => (
                <div key={s.source} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>{s.source}</span><strong>{s.count}</strong></div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── مودال ساخت سرنخ ─────────────────────────────────
function CreateLeadModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users').then((r) => r.data) })
  const [f, setF] = useState<any>({ name: '', company: '', phone: '', email: '', source: '', estimatedValue: '', assignedToId: '', nextFollowUpAt: '', notes: '' })
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }))
  const create = useMutation({
    mutationFn: () => api.post('/crm/leads', f),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm-leads'] }); qc.invalidateQueries({ queryKey: ['crm-followups'] }); toast.success('سرنخ ساخته شد'); onClose() },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 560 }}>
        <div className="modal-header"><h2>سرنخ جدید</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-group"><label>نام شخص / شرکت *</label><input value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
          <div className="form-grid-2">
            <div className="form-group"><label>شرکت</label><input value={f.company} onChange={(e) => set('company', e.target.value)} /></div>
            <div className="form-group"><label>تلفن</label><input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
            <div className="form-group"><label>ایمیل</label><input value={f.email} onChange={(e) => set('email', e.target.value)} /></div>
            <div className="form-group"><label>منبع آشنایی</label><input value={f.source} onChange={(e) => set('source', e.target.value)} placeholder="نمایشگاه، معرفی، وب‌سایت…" /></div>
            <div className="form-group"><label>ارزش تخمینی (تومان)</label><NumberInput value={f.estimatedValue} onChange={(v) => set('estimatedValue', v)} /></div>
            <div className="form-group"><label>پیگیری بعدی</label><DateField value={f.nextFollowUpAt} onChange={(v) => set('nextFollowUpAt', v)} /></div>
          </div>
          <div className="form-group"><label>مسئول</label>
            <SearchableSelect options={users.map((u: any) => ({ value: u.id, label: u.name }))} value={f.assignedToId} onChange={(v) => set('assignedToId', v)} placeholder="انتخاب مسئول…" />
          </div>
          <div className="form-group"><label>یادداشت</label><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>انصراف</button>
          <button className="btn-primary" disabled={!f.name.trim() || create.isPending} onClick={() => create.mutate()}>ثبت سرنخ</button>
        </div>
      </div>
    </div>
  )
}

// ─── Drawer جزئیات سرنخ ──────────────────────────────
function LeadDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [show360, setShow360] = useState<string | null>(null)
  const { data: lead, isLoading } = useQuery({ queryKey: ['crm-lead', id], queryFn: () => api.get(`/crm/leads/${id}`).then((r) => r.data) })
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users').then((r) => r.data) })

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['crm-lead', id] }); qc.invalidateQueries({ queryKey: ['crm-leads'] }); qc.invalidateQueries({ queryKey: ['crm-followups'] }) }
  const patch = useMutation({ mutationFn: (b: any) => api.patch(`/crm/leads/${id}`, b), onSuccess: invalidate, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })
  const addInteraction = useMutation({ mutationFn: (b: any) => api.post('/crm/interactions', { ...b, leadId: id }), onSuccess: () => { invalidate(); toast.success('تعامل ثبت شد') }, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })
  const deleteLead = useMutation({ mutationFn: () => api.delete(`/crm/leads/${id}`), onSuccess: () => { qc.invalidateQueries({ queryKey: ['crm-leads'] }); qc.invalidateQueries({ queryKey: ['crm-followups'] }); toast.success('سرنخ حذف شد'); onClose() }, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })
  const handleDelete = async () => { if (await dialog.confirm({ title: 'حذف سرنخ؟', message: `سرنخ «${lead.name}» و همهٔ تعاملاتش برای همیشه حذف می‌شود.`, confirmLabel: 'حذف سرنخ', tone: 'danger' })) deleteLead.mutate() }

  const [it, setIt] = useState<any>({ type: 'CALL', note: '', outcome: '', nextFollowUpAt: '' })

  const convert = async () => {
    if (lead.customerId) { setShow360(lead.customerId); return }
    const code = await dialog.prompt({ title: 'تبدیل به مشتری', message: `سرنخ «${lead.name}» به‌عنوان مشتری جدید ثبت می‌شود. یک کد ۳ حرفیِ یکتا برای مشتری وارد کنید (مثل ABC).`, placeholder: 'کد ۳ حرفی', confirmLabel: 'تبدیل به مشتری' })
    if (!code) return
    if (code.trim().length !== 3) { toast.error('کد باید دقیقاً ۳ حرف باشد'); return }
    try {
      const res = await api.post(`/crm/leads/${id}/convert`, { shortCode: code.trim() })
      invalidate(); qc.invalidateQueries({ queryKey: ['customers'] })
      toast.success('سرنخ به مشتری تبدیل شد')
      setShow360(res.data.customer.id)
    } catch (e: any) { toast.error(e.response?.data?.message || 'خطا در تبدیل') }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 660 }}>
        <div className="modal-header">
          <h2>{isLoading ? '…' : lead?.name}</h2>
          <button onClick={onClose}>✕</button>
        </div>
        {lead && (
          <div className="modal-body">
            {/* وضعیت و مرحله */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 14 }}>
              <select value={lead.stage} onChange={(e) => patch.mutate({ stage: e.target.value })} style={{ width: 'auto', fontWeight: 700, color: stageOf(lead.stage).color }}>
                {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              {lead.customerId
                ? <button className="btn-secondary btn-sm" onClick={() => setShow360(lead.customerId)}>🔍 نمای ۳۶۰ مشتری</button>
                : <button className="btn-primary btn-sm" onClick={convert}>✓ تبدیل به مشتری</button>}
              <button className="btn-danger btn-sm" style={{ marginRight: 'auto' }} onClick={handleDelete} disabled={deleteLead.isPending} title="حذف سرنخ">🗑 حذف</button>
            </div>

            {/* اطلاعات پایه — ویرایش سریع */}
            <div className="form-grid-2">
              <div className="form-group"><label>شرکت</label><input defaultValue={lead.company || ''} onBlur={(e) => e.target.value !== (lead.company || '') && patch.mutate({ company: e.target.value })} /></div>
              <div className="form-group"><label>تلفن</label><input defaultValue={lead.phone || ''} onBlur={(e) => e.target.value !== (lead.phone || '') && patch.mutate({ phone: e.target.value })} /></div>
              <div className="form-group"><label>ایمیل</label><input defaultValue={lead.email || ''} onBlur={(e) => e.target.value !== (lead.email || '') && patch.mutate({ email: e.target.value })} /></div>
              <div className="form-group"><label>منبع</label><input defaultValue={lead.source || ''} onBlur={(e) => e.target.value !== (lead.source || '') && patch.mutate({ source: e.target.value })} /></div>
              <div className="form-group"><label>ارزش تخمینی (ت)</label><NumberInput value={lead.estimatedValue ?? ''} onChange={(v) => patch.mutate({ estimatedValue: v })} /></div>
              <div className="form-group"><label>پیگیری بعدی</label><DateField value={lead.nextFollowUpAt ? lead.nextFollowUpAt.slice(0, 10) : ''} onChange={(v) => patch.mutate({ nextFollowUpAt: v })} /></div>
              <div className="form-group"><label>مسئول</label>
                <SearchableSelect options={users.map((u: any) => ({ value: u.id, label: u.name }))} value={lead.assignedToId || ''} onChange={(v) => patch.mutate({ assignedToId: v })} placeholder="—" />
              </div>
            </div>
            {lead.stage === 'LOST' && (
              <div className="form-group"><label>دلیل از دست رفتن</label><input defaultValue={lead.lostReason || ''} onBlur={(e) => patch.mutate({ lostReason: e.target.value })} /></div>
            )}

            {/* ثبت تعامل */}
            <h3 className="section-title" style={{ marginTop: 16 }}>💬 ثبت تعامل جدید</h3>
            <div className="panel panel-pad" style={{ marginBottom: 14 }}>
              <div className="form-grid-2">
                <div className="form-group"><label>نوع</label>
                  <select value={it.type} onChange={(e) => setIt({ ...it, type: e.target.value })}>
                    {Object.entries(ITYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div className="form-group"><label>پیگیری بعدی (اختیاری)</label><DateField value={it.nextFollowUpAt} onChange={(v) => setIt({ ...it, nextFollowUpAt: v })} /></div>
              </div>
              <div className="form-group"><label>شرح *</label><textarea rows={2} value={it.note} onChange={(e) => setIt({ ...it, note: e.target.value })} placeholder="چه صحبتی شد؟" /></div>
              <div className="form-group"><label>نتیجه (اختیاری)</label><input value={it.outcome} onChange={(e) => setIt({ ...it, outcome: e.target.value })} /></div>
              <button className="btn-primary btn-sm" disabled={!it.note.trim() || addInteraction.isPending} onClick={() => addInteraction.mutate(it, { onSuccess: () => setIt({ type: 'CALL', note: '', outcome: '', nextFollowUpAt: '' }) })}>ثبت تعامل</button>
            </div>

            {/* تایم‌لاین تعاملات */}
            <h3 className="section-title">📜 تاریخچهٔ تعاملات ({lead.interactions.length})</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {lead.interactions.map((i: any) => <InteractionItem key={i.id} interaction={i} leadId={id} />)}
              {lead.interactions.length === 0 && <div className="hint-sm" style={{ opacity: .6 }}>هنوز تعاملی ثبت نشده.</div>}
            </div>
          </div>
        )}
      </div>
      {show360 && <Customer360Modal customerId={show360} onClose={() => setShow360(null)} />}
    </div>
  )
}

// ─── آیتم تعامل (نمایش + ویرایش/حذف inline) ──────────
function InteractionItem({ interaction: i, leadId }: { interaction: any; leadId: string }) {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [f, setF] = useState({ type: i.type, note: i.note, outcome: i.outcome || '' })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['crm-lead', leadId] })
  const save = useMutation({ mutationFn: () => api.patch(`/crm/interactions/${i.id}`, f), onSuccess: () => { invalidate(); setEditing(false); toast.success('تعامل ویرایش شد') }, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })
  const del = useMutation({ mutationFn: () => api.delete(`/crm/interactions/${i.id}`), onSuccess: () => { invalidate(); toast.success('تعامل حذف شد') }, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })
  const handleDelete = async () => { if (await dialog.confirm({ title: 'حذف تعامل؟', message: 'این تعامل برای همیشه حذف می‌شود.', confirmLabel: 'حذف', tone: 'danger' })) del.mutate() }

  if (editing) return (
    <div className="panel panel-pad" style={{ padding: 12, borderColor: 'var(--brand-300)' }}>
      <div className="form-group"><label>نوع</label>
        <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.entries(ITYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>
      <div className="form-group"><label>شرح *</label><textarea rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
      <div className="form-group"><label>نتیجه</label><input value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} /></div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn-primary btn-sm" disabled={!f.note.trim() || save.isPending} onClick={() => save.mutate()}>ذخیره</button>
        <button className="btn-secondary btn-sm" onClick={() => { setEditing(false); setF({ type: i.type, note: i.note, outcome: i.outcome || '' }) }}>انصراف</button>
      </div>
    </div>
  )

  return (
    <div className="panel panel-pad" style={{ padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
        <strong>{ITYPES[i.type] || i.type}</strong>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="hint-sm">{formatDateTime(i.occurredAt)}</span>
          <button onClick={() => setEditing(true)} title="ویرایش تعامل" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, opacity: .65 }}>✎</button>
          <button onClick={handleDelete} title="حذف تعامل" style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, opacity: .65 }}>🗑</button>
        </span>
      </div>
      <div style={{ fontSize: 13, marginTop: 4 }}>{i.note}</div>
      {i.outcome && <div className="hint-sm" style={{ marginTop: 3 }}>نتیجه: {i.outcome}</div>}
      {i.createdByName && <div className="hint-sm" style={{ marginTop: 3 }}>👤 {i.createdByName}</div>}
    </div>
  )
}

// ─── نمای ۳۶۰ مشتری ─────────────────────────────────
function Customer360Modal({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['crm-360', customerId], queryFn: () => api.get(`/crm/customers/${customerId}/360`).then((r) => r.data) })
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 720 }}>
        <div className="modal-header"><h2>🔍 نمای ۳۶۰ — {isLoading ? '…' : data?.customer?.name}</h2><button onClick={onClose}>✕</button></div>
        {data && (
          <div className="modal-body">
            <div className="grid-3" style={{ marginBottom: 16 }}>
              <div className="panel panel-pad" style={{ textAlign: 'center' }}><div style={{ fontSize: 22, fontWeight: 800 }}>{data.stats.projectCount}</div><div className="hint-sm">پروژه</div></div>
              <div className="panel panel-pad" style={{ textAlign: 'center' }}><div style={{ fontSize: 22, fontWeight: 800 }}>{data.stats.interactionCount}</div><div className="hint-sm">تعامل</div></div>
              <div className="panel panel-pad" style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{data.balances.length ? data.balances.map((b: any) => `${b.balance.toLocaleString('en-US')} ${b.currency}`).join(' · ') : '—'}</div>
                <div className="hint-sm">مانده حساب</div>
              </div>
            </div>

            <h3 className="section-title">📁 پروژه‌ها</h3>
            {data.projects.length === 0 ? <div className="hint-sm" style={{ opacity: .6, marginBottom: 12 }}>پروژه‌ای ندارد.</div> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                {data.projects.map((p: any) => (
                  <div key={p.id} className="panel panel-pad" style={{ padding: 10, display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span className="code-text">{p.code}{p.description ? ` — ${p.description}` : ''}</span>
                    <span className="hint-sm">{p.status} · {toShamsi(p.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}

            <h3 className="section-title">💬 تعاملات</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.interactions.map((i: any) => (
                <div key={i.id} className="panel panel-pad" style={{ padding: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><strong>{ITYPES[i.type] || i.type}</strong><span className="hint-sm">{formatDateTime(i.occurredAt)}</span></div>
                  <div style={{ fontSize: 13, marginTop: 3 }}>{i.note}</div>
                </div>
              ))}
              {data.interactions.length === 0 && <div className="hint-sm" style={{ opacity: .6 }}>تعاملی ثبت نشده.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
