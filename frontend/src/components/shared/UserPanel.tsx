import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import api, { API_ORIGIN } from '../../lib/api'
import { useAuthStore } from '../../store/authStore'

const ROLE_FA: Record<string, string> = {
  SUPER_ADMIN: 'مدیر کل', MANAGER: 'مدیر', PROJECT_MANAGER: 'مدیر پروژه',
  ACCOUNTANT: 'حسابدار', ENGINEER: 'مهندس', VIEWER: 'بازدیدکننده',
}
const FILE_HOST = API_ORIGIN

function Avatar({ url, name, size }: { url?: string | null; name?: string; size: number }) {
  if (url) return <img src={url.startsWith('http') ? url : `${FILE_HOST}${url}`} alt="" style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }} />
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: 'var(--primary, #0f5569)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: size * 0.45 }}>
      {name?.[0] || '؟'}
    </span>
  )
}

export default function UserPanel() {
  const { user, logout, updateUser } = useAuthStore()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  if (!user) return null
  const handleLogout = () => { logout(); navigate('/login') }

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button onClick={() => setOpen(!open)} title={`${user.name} — ${ROLE_FA[user.role] || user.role}`} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 4, fontFamily: 'inherit', color: 'inherit' }}>
        <Avatar url={user.avatarUrl} name={user.name} size={32} />
        <span className="user-panel-name" style={{ fontSize: 13 }}>{user.name}</span>
        <span className="user-panel-caret" style={{ fontSize: 10, color: 'var(--text-muted)' }}>▼</span>
      </button>

      {open && (
        <div className="bell-panel" dir="rtl" style={{ left: 0, right: 'auto', width: 250 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 10, borderBottom: '1px solid var(--border)' }}>
            <Avatar url={user.avatarUrl} name={user.name} size={44} />
            <div>
              <div style={{ fontWeight: 700 }}>{user.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{ROLE_FA[user.role] || user.role}</div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>{user.username || user.email}</div>
          <button className="btn-secondary btn-sm" style={{ width: '100%', marginBottom: 6 }} onClick={() => { setShowEdit(true); setOpen(false) }}>ویرایش پروفایل</button>
          <button className="btn-danger btn-sm" style={{ width: '100%' }} onClick={handleLogout}>خروج از حساب</button>
        </div>
      )}

      {showEdit && createPortal(
        <ProfileModal onClose={() => setShowEdit(false)} onSaved={(u) => { updateUser(u); setShowEdit(false) }} />,
        document.body,
      )}
    </div>
  )
}

function ProfileModal({ onClose, onSaved }: { onClose: () => void; onSaved: (u: any) => void }) {
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [avatar, setAvatar] = useState<File | null>(null)
  const [error, setError] = useState('')

  const { data: me } = useQuery({ queryKey: ['auth-me'], queryFn: () => api.get('/auth/me').then((r) => r.data) })
  useEffect(() => { if (me) { setName(me.name || ''); setUsername(me.username || ''); setEmail(me.email || ''); setPhone(me.phone || '') } }, [me])

  const save = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      fd.append('name', name); fd.append('username', username); fd.append('email', email); fd.append('phone', phone)
      if (password) { fd.append('password', password); fd.append('currentPassword', currentPassword) }
      if (avatar) fd.append('avatar', avatar)
      return api.patch('/auth/me', fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data)
    },
    onSuccess: (data) => onSaved({ name: data.name, username: data.username, email: data.email, avatarUrl: data.avatarUrl }),
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>ویرایش پروفایل</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-group"><label>نام</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="form-group">
            <label>نام کاربری (برای ورود)</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="form-group"><label>ایمیل (اختیاری)</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="form-group"><label>شماره تماس</label><input value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="form-group"><label>عکس پروفایل</label><input type="file" accept="image/*" onChange={(e) => setAvatar(e.target.files?.[0] || null)} /></div>
          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' }} />
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>تغییر رمز (اختیاری) — رمز فعلی لازم است:</p>
          <div className="form-group"><label>رمز عبور فعلی</label><input type={showPw ? 'text' : 'password'} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></div>
          <div className="form-group">
            <label>رمز عبور جدید</label>
            <div style={{ position: 'relative' }}>
              <input type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} />
              <button type="button" onClick={() => setShowPw(!showPw)} title="نمایش/مخفی رمز" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }}>{showPw ? '🙈' : '👁'}</button>
            </div>
          </div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={save.isPending || !name} onClick={() => save.mutate()}>ذخیره</button>
        </div>
      </div>
    </div>
  )
}
