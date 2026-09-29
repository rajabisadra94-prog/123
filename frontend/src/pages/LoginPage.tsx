import { useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { useNavigate } from 'react-router-dom'
import { HOME_PATH, IS_MARKET_ONLY, BRAND } from '../lib/appMode'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { login } = useAuthStore()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await api.post('/auth/login', { username, password })
      login(res.data.token, res.data.user)
      navigate(HOME_PATH)
    } catch (err: any) {
      if (!err.response) {
        setError('⚠️ سرور بک‌اند در دسترس نیست. مطمئن شوید پنجره start-backend.bat باز و در حال اجراست.')
      } else if (err.response.status === 401) {
        setError('نام کاربری یا رمز عبور اشتباه است.')
      } else {
        setError(err.response?.data?.message || 'خطا در ورود')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page" dir="rtl">
      <div className="login-card">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 18 }}>
          <img className="login-brand-logo" src={BRAND.lockup} alt={BRAND.name} />
        </div>
        <h1>{BRAND.name}</h1>
        <p>ورود به پنل داخلی · FABRIK</p>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>نام کاربری</label>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              placeholder="نام کاربری، ایمیل یا شمارهٔ تماس"
            />
          </div>
          <div className="form-group">
            <label>رمز عبور</label>
            <div style={{ position: 'relative' }}>
              <input
                type={showPw ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                style={{ width: '100%' }}
              />
              <button
                type="button"
                onClick={() => setShowPw(!showPw)}
                title="نمایش/مخفی رمز"
                style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}
              >{showPw ? '🙈' : '👁'}</button>
            </div>
          </div>
          {error && <div className="error-msg">{error}</div>}
          <button type="submit" disabled={loading} className="btn-primary">
            {loading ? 'در حال ورود...' : 'ورود'}
          </button>
        </form>
        {!Capacitor.isNativePlatform() && !IS_MARKET_ONLY && (
          <a href="/downloads/fabrik.apk" download
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 16, fontSize: 13, color: 'var(--brand)', fontWeight: 600, textDecoration: 'none' }}>
            📱 دانلود اپلیکیشن اندروید
          </a>
        )}
      </div>
    </div>
  )
}
