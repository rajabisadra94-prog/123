import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'

export default function CurrencyTab() {
  const qc = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState(false)

  const { data } = useQuery({ queryKey: ['currency-config'], queryFn: () => api.get('/settings/currency').then((r) => r.data) })
  useEffect(() => { if (data) setForm(data) }, [data])

  const save = useMutation({
    mutationFn: () => api.put('/settings/currency', form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['currency-config'] }); setSaved(true); setTimeout(() => setSaved(false), 2500) },
  })

  const f = (key: string, label: string, placeholder = '') => (
    <div className="form-group">
      <label>{label}</label>
      <input value={form[key] || ''} placeholder={placeholder} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
    </div>
  )

  return (
    <div style={{ maxWidth: 560 }}>
      <div className="form-group">
        <label>ارز پایه سیستم</label>
        <select value={form.BASE_CURRENCY || 'IRR'} onChange={(e) => setForm({ ...form, BASE_CURRENCY: e.target.value })}>
          <option value="IRR">تومان</option><option value="USD">دلار</option><option value="CNY">یوآن</option>
        </select>
      </div>

      {/* S1 — منبع نرخ: خودکار از API یا دستی */}
      <h3 style={{ fontSize: 14, margin: '12px 0 8px' }}>منبع نرخ ارز لحظه‌ای</h3>
      <div className="form-group">
        <label>نرخ ارز از کجا خوانده شود؟</label>
        <select value={form.RATE_MODE || 'API'} onChange={(e) => setForm({ ...form, RATE_MODE: e.target.value })}>
          <option value="API">خودکار از API (بازار آزاد)</option>
          <option value="MANUAL">دستی (از نرخ‌های واردشدهٔ زیر)</option>
        </select>
        <span className="hint-sm">در حالت «دستی» سیستم API را صدا نمی‌زند و همیشه از نرخ‌های زیر استفاده می‌کند.</span>
      </div>

      <h3 style={{ fontSize: 14, margin: '12px 0 8px' }}>مدیریت API نرخ ارز</h3>
      {f('EXCHANGE_API_NAME', 'نام سرویس API', 'مثلاً exchangerate-api')}
      <p className="hint-sm" style={{ marginBottom: 12  }}>کلید API به‌دلایل امنیتی در فایل .env سرور نگهداری می‌شود (EXCHANGE_RATE_API_KEY).</p>

      <h3 style={{ fontSize: 14, margin: '12px 0 8px' }}>نرخ ارز دستی {form.RATE_MODE === 'MANUAL' ? '(فعال — ملاک محاسبات)' : '(Fallback — هنگام قطعی API)'}</h3>
      <p className="hint" style={{ marginBottom: 8  }}>{form.RATE_MODE === 'MANUAL' ? 'در حالت دستی، همهٔ محاسبات با این نرخ‌ها انجام می‌شود (به تومان).' : 'اگر API در دسترس نباشد، سیستم از این نرخ‌ها استفاده می‌کند (به تومان).'}</p>
      {f('FALLBACK_USD_TO_IRR', 'هر دلار چند تومان؟', 'مثلاً 600000')}
      {f('FALLBACK_CNY_TO_IRR', 'هر یوآن چند تومان؟', 'مثلاً 85000')}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8 }}>
        <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>ذخیره تنظیمات ارز</button>
        {saved && <span style={{ color: 'var(--success)', fontSize: 13 }}>ذخیره شد ✓</span>}
      </div>
    </div>
  )
}
