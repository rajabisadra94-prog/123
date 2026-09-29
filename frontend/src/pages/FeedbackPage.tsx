import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { useAuthStore } from '../store/authStore'
import { formatDateTime } from '../lib/date'
import { PageHeader } from '../components/ui'

const MODULES = ['پروژه‌ها', 'بازبینی فنی', 'قیمت‌گیری', 'صدور فاکتور', 'سفارش‌ها', 'حمل و نقل', 'حسابداری', 'وظایف', 'داشبورد', 'بایگانی', 'تاریخچه', 'تنظیمات', 'چت / پیام‌ها', 'سایر']
const TYPE_FA: Record<string, string> = { BUG: '🐞 باگ', FEATURE: '💡 قابلیت/نیاز جدید' }
const STATUS_FA: Record<string, { label: string; cls: string }> = {
  OPEN: { label: 'باز', cls: 'status-in_progress' },
  IN_PROGRESS: { label: 'در حال بررسی', cls: 'status-in_production' },
  DONE: { label: 'انجام‌شده', cls: 'status-completed' },
  DISMISSED: { label: 'رد‌شده', cls: 'status-archived' },
}
const PRIO_FA: Record<string, string> = { LOW: 'کم', NORMAL: 'متوسط', HIGH: 'زیاد' }
const EMPTY = { type: 'BUG', module: '', page: '', title: '', description: '', steps: '', priority: 'NORMAL' }

export default function FeedbackPage() {
  const qc = useQueryClient()
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'SUPER_ADMIN' || user?.role === 'MANAGER'
  const [form, setForm] = useState<any>(EMPTY)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const { data: reports = [] } = useQuery({ queryKey: ['feedback'], queryFn: () => api.get('/feedback').then((r) => r.data) })

  const submit = useMutation({
    mutationFn: () => api.post('/feedback', form),
    onSuccess: () => { setSent(true); setForm(EMPTY); qc.invalidateQueries({ queryKey: ['feedback'] }); setTimeout(() => setSent(false), 3500) },
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })
  const setStatus = useMutation({
    mutationFn: ({ id, status }: any) => api.patch(`/feedback/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feedback'] }),
  })

  const set = (k: string, v: any) => setForm({ ...form, [k]: v })

  const downloadExport = async () => {
    const res = await api.get('/feedback/export', { responseType: 'blob' })
    const url = URL.createObjectURL(res.data)
    const a = document.createElement('a'); a.href = url; a.download = 'fabrik-feedback.txt'; a.click(); URL.revokeObjectURL(url)
  }

  return (
    <div className="page" dir="rtl">
      <PageHeader title="بازخورد و ثبت باگ" subtitle="هرچه دقیق‌تر بگویید کجای سیستم و چه مشکلی هست، آپدیت‌های بعدی سریع‌تر و دقیق‌تر انجام می‌شوند." />

      <div className={isAdmin ? 'grid-2' : ''} style={{ gap: 20, alignItems: 'start' }}>
        {/* فرم ثبت */}
        <div className="panel panel-pad">
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>ثبت مورد جدید</h3>
          <div className="settings-tabs" style={{ marginBottom: 12 }}>
            <button className={`tab-btn ${form.type === 'BUG' ? 'active' : ''}`} onClick={() => set('type', 'BUG')}>🐞 گزارش باگ</button>
            <button className={`tab-btn ${form.type === 'FEATURE' ? 'active' : ''}`} onClick={() => set('type', 'FEATURE')}>💡 قابلیت جدید</button>
          </div>
          <div className="form-group"><label>کدام بخش سیستم؟ *</label>
            <select value={form.module} onChange={(e) => set('module', e.target.value)}>
              <option value="">انتخاب کنید...</option>
              {MODULES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div className="form-group"><label>مکان دقیق (کدام صفحه / پنجره / دکمه؟)</label><input value={form.page} onChange={(e) => set('page', e.target.value)} placeholder="مثلاً: پنجرهٔ ایجاد پیش‌فاکتور، دکمهٔ نهایی‌سازی" /></div>
          <div className="form-group"><label>عنوان کوتاه *</label><input value={form.title} onChange={(e) => set('title', e.target.value)} /></div>
          <div className="form-group"><label>{form.type === 'BUG' ? 'دقیقاً چه مشکلی رخ می‌دهد؟ *' : 'چه قابلیتی نیاز دارید؟ *'}</label><textarea rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} /></div>
          <div className="form-group"><label>{form.type === 'BUG' ? 'مراحل بازتولید (قدم‌به‌قدم چه کردید؟)' : 'کاربرد و جزئیات بیشتر'}</label><textarea rows={3} value={form.steps} onChange={(e) => set('steps', e.target.value)} placeholder={form.type === 'BUG' ? '۱) ... ۲) ... ۳) نتیجهٔ اشتباه: ...' : 'چرا لازم است و چطور باید کار کند'} /></div>
          <div className="form-group"><label>اولویت</label>
            <select value={form.priority} onChange={(e) => set('priority', e.target.value)}>
              <option value="LOW">کم</option><option value="NORMAL">متوسط</option><option value="HIGH">زیاد</option>
            </select>
          </div>
          {error && <div className="error-msg">{error}</div>}
          {sent && <div style={{ color: 'var(--success)', fontSize: 13, marginBottom: 8 }}>✓ ثبت شد، ممنون!</div>}
          <button className="btn-primary" disabled={!form.module || !form.title || !form.description || submit.isPending} onClick={() => { setError(''); submit.mutate() }}>ثبت بازخورد</button>
        </div>

        {/* لیست */}
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ fontSize: 14 }}>{isAdmin ? `همهٔ بازخوردها (${reports.length})` : `بازخوردهای من (${reports.length})`}</h3>
            {isAdmin && <button className="btn-secondary btn-sm" onClick={downloadExport}>📄 دریافت خروجی متنی</button>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 560, overflowY: 'auto' }}>
            {reports.map((r: any) => (
              <div key={r.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{TYPE_FA[r.type]} — {r.title}</span>
                  <span className={`status-badge ${STATUS_FA[r.status]?.cls}`} style={{ fontSize: 10 }}>{STATUS_FA[r.status]?.label}</span>
                </div>
                <div className="hint-sm" style={{ marginTop: 3  }}>{[r.module, r.page].filter(Boolean).join(' / ')} • اولویت {PRIO_FA[r.priority]} • {r.createdByName} • {formatDateTime(r.createdAt)}</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>{r.description}</div>
                {r.steps && <div className="hint-sm" style={{ marginTop: 3  }}>جزئیات: {r.steps}</div>}
                {isAdmin && (
                  <select value={r.status} onChange={(e) => setStatus.mutate({ id: r.id, status: e.target.value })} style={{ fontSize: 11, width: 'auto', marginTop: 6 }}>
                    <option value="OPEN">باز</option><option value="IN_PROGRESS">در حال بررسی</option><option value="DONE">انجام‌شده</option><option value="DISMISSED">رد‌شده</option>
                  </select>
                )}
              </div>
            ))}
            {reports.length === 0 && <p className="hint">موردی ثبت نشده.</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
