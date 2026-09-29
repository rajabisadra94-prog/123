import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { ROLE_LABELS } from './UsersTab'
import { Loading } from '../../components/ui'

const MODULES: [string, string][] = [
  ['crm', 'CRM (ارتباط با مشتری)'],
  ['market', 'بازار صادرات'],
  ['projects', 'پروژه‌ها'],
  ['technical', 'بازبینی فنی'],
  ['pricing', 'قیمت‌گیری'],
  ['invoicing', 'صدور فاکتور'],
  ['orders', 'سفارش‌ها'],
  ['shipping', 'حمل و نقل'],
  ['accounting', 'حسابداری'],
  ['archive', 'بایگانی'],
  ['settings', 'تنظیمات'],
]
const ACTIONS: [string, string][] = [['view', 'مشاهده'], ['create', 'ایجاد'], ['edit', 'ویرایش'], ['delete', 'حذف']]
const ROLES = Object.keys(ROLE_LABELS)

type Matrix = Record<string, Record<string, Record<string, boolean>>>

// Sensible defaults (SUPER_ADMIN = full; others scoped)
function defaultMatrix(): Matrix {
  const m: Matrix = {}
  for (const role of ROLES) {
    m[role] = {}
    for (const [mod] of MODULES) {
      m[role][mod] = {}
      for (const [act] of ACTIONS) {
        let allowed = role === 'SUPER_ADMIN'
        if (!allowed) {
          if (role === 'MANAGER') allowed = true
          else if (role === 'VIEWER') allowed = act === 'view'
          else if (role === 'ACCOUNTANT') allowed = mod === 'accounting' || act === 'view'
          else if (role === 'ENGINEER') allowed = mod === 'technical' || mod === 'projects' || act === 'view'
          else if (role === 'PROJECT_MANAGER') allowed = mod !== 'settings' && mod !== 'accounting' || act === 'view'
        }
        m[role][mod][act] = allowed
      }
    }
  }
  return m
}

export default function PermissionsTab() {
  const qc = useQueryClient()
  const [role, setRole] = useState('PROJECT_MANAGER')
  const [matrix, setMatrix] = useState<Matrix | null>(null)
  const [saved, setSaved] = useState(false)

  const { data } = useQuery({ queryKey: ['role-permissions'], queryFn: () => api.get('/settings/config/ROLE_PERMISSIONS').then((r) => r.data) })

  // ماتریسِ ذخیره‌شده روی پیش‌فرض‌ها می‌نشیند، نه جایگزینشان می‌شود.
  // وگرنه ماژولی که بعد از آخرین ذخیره اضافه شده (مثل «بازار صادرات») این‌جا
  // یک ردیفِ کاملاً خاموش نشان می‌داد و مدیر فکر می‌کرد چیزی خراب است.
  // دسترسی واقعی تا وقتی ذخیره نکند تغییر نمی‌کند.
  useEffect(() => {
    if (!data || !Object.keys(data).length) { setMatrix(defaultMatrix()); return }
    const merged = defaultMatrix()
    for (const role of Object.keys(data)) {
      merged[role] = { ...merged[role], ...data[role] }
    }
    setMatrix(merged)
  }, [data])

  const save = useMutation({
    mutationFn: () => api.put('/settings/config/ROLE_PERMISSIONS', matrix),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['role-permissions'] }); setSaved(true); setTimeout(() => setSaved(false), 2500) },
  })

  if (!matrix) return <Loading />

  const rm = matrix[role] || {}
  const toggle = (mod: string, act: string) => {
    setMatrix({ ...matrix, [role]: { ...rm, [mod]: { ...rm[mod], [act]: !rm[mod]?.[act] } } })
  }
  const toggleAll = (mod: string, val: boolean) => {
    const next = { ...rm[mod] }; ACTIONS.forEach(([a]) => next[a] = val)
    setMatrix({ ...matrix, [role]: { ...rm, [mod]: next } })
  }

  return (
    <div>
      <div className="settings-tabs">
        {ROLES.map((r) => <button key={r} className={`tab-btn ${role === r ? 'active' : ''}`} onClick={() => setRole(r)}>{ROLE_LABELS[r]}</button>)}
      </div>

      <p className="hint" style={{ marginBottom: 12  }}>
        مجوزهای نقش «{ROLE_LABELS[role]}» را برای هر ماژول تعیین کنید. {role === 'SUPER_ADMIN' && '(مدیر کل همیشه دسترسی کامل دارد)'}
      </p>

      <table className="data-table">
        <thead>
          <tr><th>ماژول</th>{ACTIONS.map(([a, l]) => <th key={a} style={{ textAlign: 'center' }}>{l}</th>)}<th style={{ textAlign: 'center' }}>همه</th></tr>
        </thead>
        <tbody>
          {MODULES.map(([mod, label]) => (
            <tr key={mod}>
              <td>{label}</td>
              {ACTIONS.map(([act]) => (
                <td key={act} style={{ textAlign: 'center' }}>
                  <input type="checkbox" style={{ width: 'auto' }} disabled={role === 'SUPER_ADMIN'}
                    checked={role === 'SUPER_ADMIN' ? true : !!rm[mod]?.[act]} onChange={() => toggle(mod, act)} />
                </td>
              ))}
              <td style={{ textAlign: 'center' }}>
                <button className="btn-secondary btn-sm" disabled={role === 'SUPER_ADMIN'} onClick={() => toggleAll(mod, !ACTIONS.every(([a]) => rm[mod]?.[a]))}>تغییر</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button className="btn-primary" disabled={save.isPending || role === 'SUPER_ADMIN'} onClick={() => save.mutate()}>ذخیره مجوزها</button>
        {saved && <span style={{ color: 'var(--success)', fontSize: 13 }}>ذخیره شد ✓</span>}
      </div>
    </div>
  )
}
