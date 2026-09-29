import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import { toShamsi, formatDateTime } from '../lib/date'
import { CreateTaskModal } from '../components/shared/TaskReminder'
import DateField from '../components/shared/DateField'
import { useAuthStore } from '../store/authStore'
import CommentThread from '../components/shared/CommentThread'
import ChecklistEditor, { type ChecklistDraft } from '../components/shared/ChecklistEditor'
import { PageHeader, TabChips, Card, EmptyState, ModalLoading } from '../components/ui'
import { dialog, toast } from '../components/ui/dialog'

const PRIORITY: Record<string, { label: string; color: string; soft: string }> = {
  LOW: { label: 'کم', color: '#15919b', soft: '#e0f3f4' },
  NORMAL: { label: 'متوسط', color: '#0f5569', soft: '#eaf3f4' },
  HIGH: { label: 'مهم', color: '#e52329', soft: '#fde7e7' },
}

const SCOPES = [
  { key: 'my', label: 'کارهای من' },
  { key: 'today', label: 'امروز' },
  { key: 'overdue', label: 'معوق' },
  { key: 'done', label: 'انجام‌شده' },
  { key: 'all', label: 'همه وظایف' },
]

export default function TasksPage() {
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.user)
  const [showCreate, setShowCreate] = useState(false)
  const [scope, setScope] = useState('my')
  const [projectId, setProjectId] = useState('')
  const [openTask, setOpenTask] = useState<string | null>(null)

  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks-page', projectId],
    queryFn: () => api.get('/tasks', { params: { includeDone: 'true', projectId: projectId || undefined } }).then((r) => r.data),
  })
  const { data: projects = [] } = useQuery({ queryKey: ['projects-min'], queryFn: () => api.get('/projects').then((r) => r.data) })

  const done = useMutation({
    mutationFn: ({ id, isDone }: any) => api.patch(`/tasks/${id}/done`, isDone ? { undo: true } : {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tasks-page'] }); qc.invalidateQueries({ queryKey: ['my-tasks'] }) },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  const now = new Date(); const todayStr = now.toDateString()
  const isMine = (t: any) => t.assignedToId === me?.id || (t.assigneeIds || []).includes(me?.id)

  const filtered = useMemo(() => tasks.filter((t: any) => {
    if (scope === 'my') return isMine(t) && !t.isDone
    if (scope === 'done') return t.isDone
    if (scope === 'today') return !t.isDone && t.dueAt && new Date(t.dueAt).toDateString() === todayStr
    if (scope === 'overdue') return !t.isDone && t.dueAt && new Date(t.dueAt) < now && new Date(t.dueAt).toDateString() !== todayStr
    return true // all
  }), [tasks, scope, me])

  return (
    <div className="page" dir="rtl">
      <PageHeader
        title="وظایف"
        subtitle="همه وظایف، یادآوری‌ها و گفتگوهای مرتبط در یک جا"
        actions={<button className="band-btn-primary" onClick={() => setShowCreate(true)}>+ ایجاد وظیفه</button>}
        chips={<TabChips value={scope} onChange={setScope} tabs={SCOPES.map((s) => ({ key: s.key, label: s.label }))} />}
      />

      <div className="toolbar">
        <select style={{ maxWidth: 220, marginRight: 'auto' }} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">همه پروژه‌ها</option>
          {projects.map((p: any) => <option key={p.id} value={p.id}>{p.code} — {p.customer.name}</option>)}
        </select>
      </div>

      <Card className="overflow-hidden">
        {filtered.map((t: any) => <TaskRow key={t.id} t={t} onOpen={() => setOpenTask(t.id)} onToggleDone={() => done.mutate({ id: t.id, isDone: t.isDone })} />)}
        {filtered.length === 0 && <EmptyState icon="✅" title="وظیفه‌ای در این دسته نیست">با فیلتر دیگری امتحان کنید یا وظیفهٔ جدید بسازید.</EmptyState>}
      </Card>

      {showCreate && <CreateTaskModal onClose={() => { setShowCreate(false); qc.invalidateQueries({ queryKey: ['tasks-page'] }) }} />}
      {openTask && <TaskDetailModal taskId={openTask} onClose={() => setOpenTask(null)} />}
    </div>
  )
}

function TaskRow({ t, onOpen, onToggleDone }: any) {
  const now = new Date()
  const overdue = !t.isDone && t.dueAt && new Date(t.dueAt) < now
  const daysLate = overdue ? Math.floor((now.getTime() - new Date(t.dueAt).getTime()) / 86400000) : 0
  const pr = PRIORITY[t.priority] || PRIORITY.NORMAL

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)', borderRight: overdue ? '3px solid var(--danger)' : '3px solid transparent', cursor: 'pointer', opacity: t.isDone ? 0.55 : 1 }} onClick={onOpen}>
      <input type="checkbox" style={{ width: 'auto' }} checked={t.isDone} onClick={(e) => e.stopPropagation()} onChange={onToggleDone} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, textDecoration: t.isDone ? 'line-through' : 'none' }}>{t.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
          {t.project && (
            <Link to={`/projects/${t.project.id}`} onClick={(e) => e.stopPropagation()} style={{ fontSize: 11, color: 'var(--brand)', textDecoration: 'none', background: 'var(--brand-50)', padding: '2px 8px', borderRadius: 100 }}>📁 {t.project.code}</Link>
          )}
          {t.notes && <span className="hint-sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280  }}>{t.notes}</span>}
          {t._count?.comments > 0 && <span className="hint-sm">💬 {t._count.comments}</span>}
        </div>
      </div>
      <span className="status-badge" style={{ background: pr.soft, color: pr.color }}>{pr.label}</span>
      {t.dueAt && (
        <span style={{ fontSize: 12, color: overdue ? 'var(--danger)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          📅 {toShamsi(t.dueAt)}{overdue ? ` · ${daysLate} روز تأخیر` : ''}
        </span>
      )}
      {t.assignedTo && <Avatar name={t.assignedTo.name} />}
    </div>
  )
}

function Avatar({ name }: { name: string }) {
  return <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'var(--brand)', color: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flex: 'none' }} title={name}>{name?.[0] || '؟'}</div>
}

// ─── CHECKLIST (read-only here; add/remove happens in create/edit forms) ──
function ChecklistSection({ task, onChange }: any) {
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.user)
  const assignees = task.assignees || []
  const items = task.checklist || []
  const doneCount = items.filter((i: any) => i.isDone).length

  const refresh = () => { qc.invalidateQueries({ queryKey: ['task', task.id] }); onChange?.() }
  const toggle = useMutation({ mutationFn: (itemId: string) => api.patch(`/tasks/${task.id}/checklist/${itemId}/toggle`), onSuccess: refresh, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })

  const canToggle = (item: any) => {
    if (me?.role === 'SUPER_ADMIN') return true
    if (item.assigneeIds.length > 0) return item.assigneeIds.includes(me?.id)
    return task.createdById === me?.id // unassigned item → creator
  }
  const nameOf = (id: string) => assignees.find((a: any) => a.id === id)?.name || '—'

  if (items.length === 0) return null
  const pct = Math.round((doneCount / items.length) * 100)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <h3 style={{ fontSize: 14, color: 'var(--brand-800)' }}>✅ چک‌لیست</h3>
        <span className="hint" style={{ fontWeight: 600  }}>{doneCount} از {items.length}</span>
      </div>
      <div style={{ height: 6, background: 'var(--border)', borderRadius: 100, overflow: 'hidden', marginBottom: 12 }}>
        <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, var(--brand), var(--success))', borderRadius: 100, transition: 'width 0.3s' }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((item: any) => (
          <label key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', background: item.isDone ? 'var(--surface-2)' : 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: canToggle(item) ? 'pointer' : 'not-allowed' }} title={canToggle(item) ? '' : 'فقط فرد مسئول این مورد یا مدیر کل می‌تواند تیک بزند'}>
            <input type="checkbox" style={{ width: 18, height: 18 }} checked={item.isDone} disabled={!canToggle(item)} onChange={() => toggle.mutate(item.id)} />
            <span style={{ flex: 1, fontSize: 13.5, textDecoration: item.isDone ? 'line-through' : 'none', color: item.isDone ? 'var(--text-muted)' : 'var(--text)' }}>{item.text}</span>
            {item.assigneeIds.length > 0 && (
              <span style={{ display: 'flex', gap: 4 }}>
                {item.assigneeIds.map((id: string) => (
                  <span key={id} style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--brand)', background: 'var(--brand-50)', padding: '2px 9px', borderRadius: 100 }}>{nameOf(id)}</span>
                ))}
              </span>
            )}
          </label>
        ))}
      </div>
      <p className="hint-sm" style={{ marginTop: 8  }}>برای افزودن/حذف موارد، از دکمه «✎ ویرایش» بالای صفحه استفاده کنید.</p>
    </div>
  )
}

// ─── TASK DETAIL (Mizito-style: info + reports/conversation) ──
export function TaskDetailModal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.user)
  const [editing, setEditing] = useState(false)
  const { data: task } = useQuery({ queryKey: ['task', taskId], queryFn: () => api.get(`/tasks/${taskId}`).then((r) => r.data) })

  const refresh = () => { qc.invalidateQueries({ queryKey: ['task', taskId] }); qc.invalidateQueries({ queryKey: ['tasks-page'] }); qc.invalidateQueries({ queryKey: ['comments', 'task', taskId] }) }
  const done = useMutation({ mutationFn: () => api.patch(`/tasks/${taskId}/done`, task.isDone ? { undo: true } : {}), onSuccess: refresh, onError: (e: any) => toast.error(e.response?.data?.message || 'خطا') })
  const del = useMutation({ mutationFn: () => api.delete(`/tasks/${taskId}`), onSuccess: () => { refresh(); onClose() } })

  if (!task) return <ModalLoading />
  const pr = PRIORITY[task.priority] || PRIORITY.NORMAL
  const canComplete = me?.role === 'SUPER_ADMIN' || task.createdById === me?.id

  if (editing) return <TaskEditForm task={task} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh() }} />

  const metaRow = (icon: string, label: string, value: any) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <span style={{ width: 20, textAlign: 'center' }}>{icon}</span>
      <span style={{ color: 'var(--text-muted)', minWidth: 72 }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  )

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 660 }}>
        <div className="modal-header">
          <h2>مشخصات وظیفه</h2>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-secondary btn-sm" onClick={() => setEditing(true)} style={{ width: 'auto', height: 'auto', padding: '6px 11px' }}>✎ ویرایش</button>
            <button onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="modal-body" style={{ padding: 20, background: 'var(--bg)' }}>

          {/* Title card */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 18, marginBottom: 14, borderRight: `4px solid ${pr.color}` }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <input type="checkbox" style={{ width: 20, height: 20, marginTop: 3 }} checked={task.isDone} disabled={!canComplete} title={canComplete ? '' : 'فقط ایجادکننده یا مدیر کل'} onChange={() => done.mutate()} />
              <div style={{ flex: 1 }}>
                <h3 style={{ fontSize: 19, fontWeight: 800, color: 'var(--brand-800)', textDecoration: task.isDone ? 'line-through' : 'none' }}>{task.title}</h3>
                {task.notes && <p className="hint-lg" style={{ marginTop: 6, lineHeight: 1.7  }}>{task.notes}</p>}
              </div>
              <span className="status-badge" style={{ background: pr.soft, color: pr.color }}>{pr.label}</span>
            </div>
          </div>

          {/* Meta card */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16, marginBottom: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {task.project ? metaRow('📁', 'پروژه', <Link to={`/projects/${task.project.id}`} onClick={onClose} style={{ color: 'var(--brand)' }}>{task.project.code}</Link>) : metaRow('📁', 'پروژه', <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>—</span>)}
            {metaRow('📅', 'مهلت', task.dueAt ? formatDateTime(task.dueAt) : <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>ندارد</span>)}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
              <span style={{ width: 20, textAlign: 'center' }}>👥</span>
              <span style={{ color: 'var(--text-muted)', minWidth: 72 }}>مسئولان</span>
              <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {(task.assignees?.length ? task.assignees : (task.assignedTo ? [task.assignedTo] : [])).map((a: any) => (
                  <span key={a.id} style={{ fontSize: 11.5, fontWeight: 600, background: 'var(--brand-50)', color: 'var(--brand)', padding: '2px 9px', borderRadius: 100 }}>{a.name}</span>
                ))}
              </span>
            </div>
            {task.createdBy && metaRow('✍️', 'ایجادکننده', task.createdBy.name)}
          </div>

          {task.isDone && task.doneReport && (
            <div style={{ background: 'var(--success-soft)', borderRadius: 'var(--radius)', padding: 12, marginBottom: 14, fontSize: 13 }}>✓ گزارش انجام: {task.doneReport}</div>
          )}

          {/* Checklist card */}
          {task.checklist?.length > 0 && (
            <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16, marginBottom: 14 }}>
              <ChecklistSection task={task} onChange={refresh} />
            </div>
          )}

          {/* Conversation card */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 16 }}>
            <h3 style={{ fontSize: 14, marginBottom: 12, color: 'var(--brand-800)', display: 'flex', alignItems: 'center', gap: 6 }}>💬 گزارش و گفتگو</h3>
            <CommentThread base={`/comments/task/${taskId}`} queryKey={['comments', 'task', taskId]} />
          </div>
        </div>
        <div className="modal-footer" style={{ justifyContent: 'space-between' }}>
          <button className="btn-danger btn-sm" onClick={async () => { if (await dialog.confirm({ title: 'حذف این وظیفه؟', message: 'وظیفه و چک‌لیستش حذف می‌شود.', confirmLabel: 'حذف وظیفه', tone: 'danger' })) del.mutate() }}>حذف وظیفه</button>
          <button className="btn-primary" disabled={!canComplete} title={canComplete ? '' : 'فقط ایجادکننده یا مدیر کل می‌تواند تکمیل کند'} onClick={() => done.mutate()}>{task.isDone ? 'بازگشایی وظیفه' : '✓ تکمیل وظیفه'}</button>
        </div>
      </div>
    </div>
  )
}

// ─── TASK EDIT FORM ──────────────────────────────────
function TaskEditForm({ task, onClose, onSaved }: any) {
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes || '')
  const [priority, setPriority] = useState(task.priority)
  const [dueAt, setDueAt] = useState(task.dueAt ? new Date(task.dueAt).toISOString().slice(0, 16) : '')
  const [assigneeIds, setAssigneeIds] = useState<Set<string>>(new Set(task.assigneeIds || []))
  const [checklist, setChecklist] = useState<ChecklistDraft[]>((task.checklist || []).map((c: any) => ({ id: c.id, text: c.text, assigneeIds: c.assigneeIds || [] })))
  const [error, setError] = useState('')
  const { data: users = [] } = useQuery({ queryKey: ['users-list'], queryFn: () => api.get('/users/list').then((r) => r.data) })

  const taskAssignees = users.filter((u: any) => assigneeIds.has(u.id))

  const save = useMutation({
    mutationFn: async () => {
      await api.patch(`/tasks/${task.id}`, { title, notes, priority, dueAt: dueAt || null, assigneeIds: [...assigneeIds] })
      await api.put(`/tasks/${task.id}/checklist`, { items: checklist.filter((c) => c.text.trim()) })
    },
    onSuccess: onSaved,
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>ویرایش وظیفه</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-group"><label>عنوان</label><input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="form-group"><label>توضیحات</label><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          <div className="form-group">
            <label>اولویت</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {Object.entries(PRIORITY).map(([k, p]) => (
                <button key={k} type="button" onClick={() => setPriority(k)} style={{ flex: 1, padding: 7, borderRadius: 8, border: `1px solid ${priority === k ? p.color : 'var(--border)'}`, background: priority === k ? p.color : 'var(--surface)', color: priority === k ? '#fff' : 'var(--text)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit' }}>{p.label}</button>
              ))}
            </div>
          </div>
          <div className="form-group"><label>مهلت</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <DateField value={dueAt ? dueAt.slice(0, 10) : ''} onChange={(d) => setDueAt(d ? `${d}T${dueAt.slice(11, 16) || '09:00'}` : '')} style={{ flex: 1 }} />
              <input type="time" value={dueAt.slice(11, 16)} onChange={(e) => setDueAt(`${dueAt.slice(0, 10) || new Date().toISOString().slice(0, 10)}T${e.target.value}`)} style={{ maxWidth: 110 }} />
            </div>
          </div>
          <div className="form-group">
            <label>مسئولان</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {users.map((u: any) => (
                <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, padding: '5px 10px', border: '1px solid var(--border)', borderRadius: 100, cursor: 'pointer', background: assigneeIds.has(u.id) ? 'var(--brand-50)' : 'transparent' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={assigneeIds.has(u.id)} onChange={() => { const n = new Set(assigneeIds); n.has(u.id) ? n.delete(u.id) : n.add(u.id); setAssigneeIds(n) }} />
                  {u.name}
                </label>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label>چک‌لیست</label>
            <ChecklistEditor items={checklist} onChange={setChecklist} assignees={taskAssignees} />
          </div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={!title || save.isPending} onClick={() => save.mutate()}>ذخیره</button>
        </div>
      </div>
    </div>
  )
}
