import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import ChecklistEditor, { type ChecklistDraft } from './ChecklistEditor'
import DateField from './DateField'
import SearchableSelect from './SearchableSelect'

/**
 * Module 13: Bell icon to create a task/reminder next to any key item.
 * Usage: <TaskReminderButton title="پیگیری قیمت از سازنده X" projectId={...} entityType="PricingRequest" entityId={...} />
 */
export function TaskReminderButton(props: { title?: string; projectId?: string; entityType?: string; entityId?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="icon-btn" title="ایجاد وظیفه/یادآوری" aria-label="ایجاد وظیفه یا یادآوری" onClick={(e) => { e.stopPropagation(); setOpen(true) }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
      </button>
      {open && <CreateTaskModal {...props} onClose={() => setOpen(false)} />}
    </>
  )
}

const PRIORITIES = [
  { value: 'LOW', label: 'کم', color: '#15919b' },
  { value: 'NORMAL', label: 'متوسط', color: '#0f5569' },
  { value: 'HIGH', label: 'مهم', color: '#e52329' },
]

export function CreateTaskModal({ title: presetTitle, projectId: presetProjectId, entityType, entityId, onClose }: any) {
  const qc = useQueryClient()
  const [title, setTitle] = useState(presetTitle || '')
  const [assigneeIds, setAssigneeIds] = useState<Set<string>>(new Set())
  const [priority, setPriority] = useState('NORMAL')
  const [projectId, setProjectId] = useState(presetProjectId || '')
  const [dueAt, setDueAt] = useState('')
  const [repeat, setRepeat] = useState('NONE')
  const [notes, setNotes] = useState('')
  const [checklist, setChecklist] = useState<ChecklistDraft[]>([])
  const [error, setError] = useState('')

  const { data: users = [] } = useQuery({ queryKey: ['users-list'], queryFn: () => api.get('/users/list').then((r) => r.data) })
  const { data: projects = [] } = useQuery({ queryKey: ['projects-min'], queryFn: () => api.get('/projects').then((r) => r.data), enabled: !presetProjectId })

  const taskAssignees = users.filter((u: any) => assigneeIds.has(u.id))

  const create = useMutation({
    mutationFn: () => api.post('/tasks', { title, assigneeIds: [...assigneeIds], priority, dueAt: dueAt || undefined, repeat, notes, projectId: projectId || undefined, entityType, entityId, checklist }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['my-tasks'] }); qc.invalidateQueries({ queryKey: ['tasks-page'] }); qc.invalidateQueries({ queryKey: ['project-tasks'] }); qc.invalidateQueries({ queryKey: ['notifications'] }); onClose() },
    onError: (e: any) => setError((e.response?.status ? `[${e.response.status}] ` : '') + (e.response?.data?.message || e.message || 'خطا در ثبت وظیفه')),
  })

  const quick = (days: number) => {
    const d = new Date(); d.setDate(d.getDate() + days); d.setHours(9, 0, 0, 0)
    setDueAt(d.toISOString().slice(0, 16))
  }
  const toggle = (id: string) => { const n = new Set(assigneeIds); n.has(id) ? n.delete(id) : n.add(id); setAssigneeIds(n) }

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>ایجاد وظیفه / یادآوری</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-group"><label>عنوان وظیفه *</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="عنوان فعالیت جدید..." /></div>

          <div className="form-group">
            <label>مسئول انجام (چند نفر — مشترک)</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {users.map((u: any) => (
                <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, padding: '5px 10px', border: '1px solid var(--border)', borderRadius: 100, cursor: 'pointer', background: assigneeIds.has(u.id) ? 'var(--brand-50)' : 'transparent', borderColor: assigneeIds.has(u.id) ? 'var(--brand-300)' : 'var(--border)' }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={assigneeIds.has(u.id)} onChange={() => toggle(u.id)} />
                  {u.name}
                </label>
              ))}
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>اگر کسی انتخاب نشود، به خودتان تخصیص می‌یابد.</p>
          </div>

          <div className="form-group">
            <label>اولویت</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {PRIORITIES.map((p) => (
                <button key={p.value} type="button" onClick={() => setPriority(p.value)}
                  style={{ flex: 1, padding: '7px', borderRadius: 8, border: `1px solid ${priority === p.value ? p.color : 'var(--border)'}`, background: priority === p.value ? p.color : 'var(--surface)', color: priority === p.value ? '#fff' : 'var(--text)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit' }}>{p.label}</button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label>زمان یادآوری</label>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <button type="button" className="btn-secondary btn-sm" onClick={() => quick(0)}>امروز</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => quick(1)}>فردا</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setDueAt('')}>بدون زمان</button>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
              <DateField value={dueAt ? dueAt.slice(0, 10) : ''} onChange={(d) => setDueAt(d ? `${d}T${dueAt.slice(11, 16) || '09:00'}` : '')} style={{ flex: 1 }} />
              <input type="time" value={dueAt.slice(11, 16)} onChange={(e) => setDueAt(`${dueAt.slice(0, 10) || new Date().toISOString().slice(0, 10)}T${e.target.value}`)} style={{ maxWidth: 110 }} />
            </div>
          </div>

          <div className="form-group">
            <label>تکرار</label>
            <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
              <option value="NONE">بدون تکرار</option>
              <option value="DAILY">روزانه</option>
              <option value="WEEKLY">هفتگی</option>
              <option value="MONTHLY">ماهانه</option>
            </select>
          </div>
          {!presetProjectId && (
            <div className="form-group">
              <label>پروژه مرتبط (اختیاری)</label>
              <SearchableSelect value={projectId} onChange={setProjectId} placeholder="بدون پروژه"
                options={projects.map((p: any) => ({ value: p.id, label: `${p.code} — ${p.customer.name}` }))} />
            </div>
          )}
          <div className="form-group">
            <label>چک‌لیست (اختیاری)</label>
            <ChecklistEditor items={checklist} onChange={setChecklist} assignees={taskAssignees} />
          </div>
          <div className="form-group"><label>توضیحات</label><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="توضیحات مربوط به این فعالیت..." /></div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={!title || create.isPending} onClick={() => create.mutate()}>ثبت وظیفه</button>
        </div>
      </div>
    </div>
  )
}
