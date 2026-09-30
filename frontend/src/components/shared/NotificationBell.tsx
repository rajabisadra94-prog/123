import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { formatDateTime, toShamsi } from '../../lib/date'
import { dialog } from '../../components/ui/dialog'
import Icon from '../../components/ui/Icon'

export default function NotificationBell() {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'notifications' | 'tasks'>('tasks')
  const wrapRef = useRef<HTMLDivElement>(null)

  // بستن پنل با کلیک هرجای بیرون (backdrop قبلی به‌خاطر backdrop-filter نوار بالا کار نمی‌کرد)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const { data: notifications = [] } = useQuery({
    queryKey: ['notifications'], queryFn: () => api.get('/notifications').then((r) => r.data),
    refetchInterval: 30000,
  })
  const { data: tasks = [] } = useQuery({
    queryKey: ['my-tasks'], queryFn: () => api.get('/tasks/my').then((r) => r.data),
    refetchInterval: 30000,
  })

  const unread = notifications.filter((n: any) => !n.isRead).length
  const now = new Date()
  const todayStr = now.toDateString()
  const overdue = tasks.filter((t: any) => t.dueAt && new Date(t.dueAt) < now && new Date(t.dueAt).toDateString() !== todayStr)
  const badge = unread + overdue.length

  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) })

  return (
    <div style={{ position: 'relative' }} ref={wrapRef}>
      <button className="bell-btn" onClick={() => setOpen(!open)} title="اعلان‌ها و وظایف"
        aria-label={badge > 0 ? `اعلان‌ها و وظایف — ${badge} مورد خوانده‌نشده` : 'اعلان‌ها و وظایف'}
        aria-expanded={open}>
        <Icon name="bell" size={18} />
        {badge > 0 && <span className="bell-badge">{badge}</span>}
      </button>

      {open && (
        <>
          <div className="bell-panel" dir="rtl" style={{ left: 0, right: 'auto' }}>
            <div className="settings-tabs" style={{ marginBottom: 12 }}>
              <button className={`tab-btn ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>وظایف من</button>
              <button className={`tab-btn ${tab === 'notifications' ? 'active' : ''}`} onClick={() => setTab('notifications')}>
                اعلان‌ها {unread > 0 && `(${unread})`}
              </button>
            </div>

            {tab === 'tasks' ? <MyTasks tasks={tasks} /> : (
              <div>
                {unread > 0 && <button className="btn-secondary btn-sm" style={{ marginBottom: 8 }} onClick={() => readAll.mutate()}>علامت‌گذاری همه به‌عنوان خوانده‌شده</button>}
                {notifications.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>اعلانی وجود ندارد</p>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {notifications.map((nt: any) => (
                    <div key={nt.id} style={{ padding: 8, borderRadius: 6, background: nt.isRead ? '#f8fafc' : '#eff6ff', fontSize: 13 }}>
                      <div>{nt.message}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{formatDateTime(nt.createdAt)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function MyTasks({ tasks }: { tasks: any[] }) {
  const qc = useQueryClient()
  const now = new Date()
  const todayStr = now.toDateString()

  const cols = {
    todo: tasks.filter((t: any) => !t.dueAt || (new Date(t.dueAt) > now && new Date(t.dueAt).toDateString() !== todayStr)),
    today: tasks.filter((t: any) => t.dueAt && new Date(t.dueAt).toDateString() === todayStr),
    overdue: tasks.filter((t: any) => t.dueAt && new Date(t.dueAt) < now && new Date(t.dueAt).toDateString() !== todayStr),
  }

  const done = useMutation({
    mutationFn: ({ id, report }: any) => api.patch(`/tasks/${id}/done`, { doneReport: report }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-tasks'] }),
  })

  const TaskItem = ({ t, color }: any) => (
    <div style={{ padding: 8, borderRadius: 6, background: '#fff', border: `1px solid var(--border)`, borderRight: `3px solid ${color}`, marginBottom: 6 }}>
      <div style={{ fontSize: 13 }}>{t.title}</div>
      {t.project && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>پروژه {t.project.code}</div>}
      {t.dueAt && <div style={{ fontSize: 11, color }}>{toShamsi(t.dueAt)}</div>}
      <button className="btn-secondary btn-sm" style={{ marginTop: 4 }} onClick={async () => { const r = (await dialog.prompt({ title: 'ثبت انجام وظیفه', message: 'گزارش انجام — اختیاری.', placeholder: 'چه کاری انجام شد؟', multiline: true, confirmLabel: 'ثبت انجام' })) ?? undefined; done.mutate({ id: t.id, report: r }) }}>✓ انجام شد</button>
    </div>
  )

  return (
    <div style={{ maxHeight: 360, overflowY: 'auto' }}>
      {cols.overdue.length > 0 && <Section title="معوق" color="#ef4444">{cols.overdue.map((t: any) => <TaskItem key={t.id} t={t} color="#ef4444" />)}</Section>}
      {cols.today.length > 0 && <Section title="امروز" color="#f59e0b">{cols.today.map((t: any) => <TaskItem key={t.id} t={t} color="#f59e0b" />)}</Section>}
      <Section title="برای انجام" color="#2563eb">{cols.todo.length ? cols.todo.map((t: any) => <TaskItem key={t.id} t={t} color="#2563eb" />) : <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</p>}</Section>
      {tasks.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>وظیفه‌ای ندارید</p>}
    </div>
  )
}

function Section({ title, color, children }: any) {
  return (
    <div style={{ marginBottom: 10 }}>
      <h4 style={{ fontSize: 12, color, marginBottom: 4 }}>{title}</h4>
      {children}
    </div>
  )
}
