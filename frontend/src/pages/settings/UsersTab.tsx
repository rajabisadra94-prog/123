import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { Loading, TableEmpty } from '../../components/ui'

export const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'مدیر کل',
  MANAGER: 'مدیر',
  PROJECT_MANAGER: 'مدیر پروژه',
  ACCOUNTANT: 'حسابدار',
  ENGINEER: 'مهندس',
  VIEWER: 'بازدیدکننده',
}

const ACCESS_LABELS: Record<string, string> = {
  ALL: 'همه پروژه‌ها',
  NONE: 'هیچ پروژه‌ای',
  SPECIFIC: 'پروژه‌های منتخب',
}

export default function UsersTab() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [editUser, setEditUser] = useState<any>(null)
  const [accessUser, setAccessUser] = useState<any>(null)

  const { data: users = [], isLoading } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users').then((r) => r.data) })

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: any) => api.patch(`/users/${id}`, { isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  if (isLoading) return <Loading />

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <button className="btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ کاربر جدید</button>
      </div>
      <table className="data-table">
        <thead><tr><th>نام کامل</th><th>نام کاربری</th><th>ایمیل</th><th>تماس</th><th>نقش</th><th>وضعیت</th><th>دسترسی پروژه</th><th>اقدام</th></tr></thead>
        <tbody>
          {users.map((u: any) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td className="code-text">{u.username}</td>
              <td className="code-text">{u.email || '-'}</td>
              <td>{u.phone || '-'}</td>
              <td><span className="status-badge status-in_progress">{ROLE_LABELS[u.role] || u.role}</span></td>
              <td>
                <span className={`status-badge ${u.isActive ? 'status-active' : 'status-archived'}`}>{u.isActive ? 'فعال' : 'غیرفعال'}</span>
              </td>
              <td>
                <button className="btn-secondary btn-sm" onClick={() => setAccessUser(u)} title="مدیریت دسترسی به پروژه‌ها">
                  {ACCESS_LABELS[u.projectAccessMode] || 'همه پروژه‌ها'} ⚙
                </button>
              </td>
              <td>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className="btn-secondary btn-sm" onClick={() => setEditUser(u)}>ویرایش</button>
                  <button className="btn-secondary btn-sm" onClick={() => toggleActive.mutate({ id: u.id, isActive: !u.isActive })}>
                    {u.isActive ? 'غیرفعال‌سازی' : 'فعال‌سازی'}
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {users.length === 0 && <TableEmpty colSpan={8}>کاربری وجود ندارد</TableEmpty>}
        </tbody>
      </table>

      {showCreate && <UserModal onClose={() => setShowCreate(false)} onSuccess={() => { setShowCreate(false); qc.invalidateQueries({ queryKey: ['users'] }) }} />}
      {editUser && <UserModal user={editUser} onClose={() => setEditUser(null)} onSuccess={() => { setEditUser(null); qc.invalidateQueries({ queryKey: ['users'] }) }} />}
      {accessUser && <ProjectAccessModal user={accessUser} onClose={() => setAccessUser(null)} onSuccess={() => { setAccessUser(null); qc.invalidateQueries({ queryKey: ['users'] }) }} />}
    </div>
  )
}

// ─── مدیریت دسترسی یک کاربر به پروژه‌ها ───
function ProjectAccessModal({ user, onClose, onSuccess }: any) {
  const [mode, setMode] = useState('ALL')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')

  const { data: access } = useQuery({ queryKey: ['user-projects', user.id], queryFn: () => api.get(`/users/${user.id}/projects`).then((r) => r.data) })
  const { data: projects = [] } = useQuery({ queryKey: ['projects-for-access'], queryFn: () => api.get('/projects').then((r) => r.data) })

  useEffect(() => { if (access) { setMode(access.mode); setSelected(new Set(access.projectIds || [])) } }, [access])

  const save = useMutation({
    mutationFn: () => api.put(`/users/${user.id}/projects`, { mode, projectIds: [...selected] }),
    onSuccess,
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  const filtered = (projects || []).filter((p: any) => {
    if (!search) return true
    const s = search.toLowerCase()
    return p.code?.toLowerCase().includes(s) || p.customer?.name?.toLowerCase().includes(s)
  })

  const toggle = (id: string) => { const n = new Set(selected); n.has(id) ? n.delete(id) : n.add(id); setSelected(n) }

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 560 }}>
        <div className="modal-header"><h2>دسترسی پروژه‌ها — {user.name}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-group">
            <label>این کاربر به کدام پروژه‌ها دسترسی دارد؟</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {[['ALL', 'همهٔ پروژه‌ها'], ['NONE', 'هیچ پروژه‌ای'], ['SPECIFIC', 'فقط پروژه‌های منتخب (پایین انتخاب کن)']].map(([v, label]) => (
                <label key={v} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                  <input type="radio" name="access-mode" style={{ width: 'auto' }} checked={mode === v} onChange={() => setMode(v)} />{label}
                </label>
              ))}
            </div>
          </div>

          {mode === 'SPECIFIC' && (
            <div className="form-group">
              <input placeholder="جستجوی پروژه یا مشتری..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ marginBottom: 8 }} />
              <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 8 }}>
                {filtered.map((p: any) => (
                  <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 4, fontSize: 13 }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                    <span className="code-text">{p.code}</span> — {p.customer?.name}
                  </label>
                ))}
                {filtered.length === 0 && <p className="hint">پروژه‌ای یافت نشد</p>}
              </div>
              <p className="hint-sm" style={{ marginTop: 4  }}>{selected.size} پروژه انتخاب شده</p>
            </div>
          )}
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>ذخیره دسترسی</button>
        </div>
      </div>
    </div>
  )
}

function UserModal({ user, onClose, onSuccess }: any) {
  const isEdit = !!user
  const [name, setName] = useState(user?.name || '')
  const [username, setUsername] = useState(user?.username || '')
  const [email, setEmail] = useState(user?.email || '')
  const [phone, setPhone] = useState(user?.phone || '')
  const [role, setRole] = useState(user?.role || 'PROJECT_MANAGER')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const mutation = useMutation({
    mutationFn: () => isEdit
      ? api.patch(`/users/${user.id}`, { name, username, email, role, phone, password: password || undefined })
      : api.post('/users', { name, username, email, phone, role, password }),
    onSuccess,
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>{isEdit ? 'ویرایش کاربر' : 'کاربر جدید'}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-group"><label>نام کامل *</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="form-group">
            <label>نام کاربری (برای ورود) *</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="هر چیزی: نام لاتین، ایمیل، شمارهٔ تماس…" />
            <span className="hint-sm">با همین وارد سیستم می‌شود. بزرگ و کوچکی حروف مهم نیست.</span>
          </div>
          <div className="form-group"><label>ایمیل (اختیاری)</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="form-group"><label>شماره تماس</label><input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="form-group">
            <label>نقش *</label>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>{isEdit ? 'رمز عبور جدید (خالی = بدون تغییر)' : 'رمز عبور *'}</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <p className="hint">کاربر می‌تواند با نام کاربری، ایمیل یا شمارهٔ تماسش وارد شود.</p>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={!name || !username || (!isEdit && !password) || mutation.isPending} onClick={() => mutation.mutate()}>ذخیره</button>
        </div>
      </div>
    </div>
  )
}
