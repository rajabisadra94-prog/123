import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { Alert } from '../../components/ui'
import { toast } from '../../components/ui/dialog'
import SearchableSelect from '../../components/shared/SearchableSelect'
import { prettyPhone } from './shared'
import Icon from '../../components/ui/Icon'

type Item = {
  row: number
  status: 'NEW' | 'DUPLICATE_DB' | 'DUPLICATE_FILE' | 'INVALID'
  issues: string[]
  duplicateOf: { id: string; code: string; name: string } | null
  data: any
}

const STATUS_STYLE: Record<string, { label: string; color: string }> = {
  NEW: { label: 'جدید', color: 'var(--success)' },
  DUPLICATE_DB: { label: 'تکراری (در سیستم هست)', color: 'var(--warning)' },
  DUPLICATE_FILE: { label: 'تکراری در همین فایل', color: 'var(--warning)' },
  INVALID: { label: 'ناقص', color: 'var(--danger)' },
}

/**
 * ورود اکسل در دو مرحله: اول نشان می‌دهیم چه چیزی وارد می‌شود،
 * بعد کاربر تأیید می‌کند. تکراری‌ها پیش‌فرض تیک ندارند تا کسی
 * ناخواسته لیستش را دوبار وارد نکند.
 */
export default function ImportWizard({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const [preview, setPreview] = useState<any>(null)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const [defaultCityId, setDefaultCityId] = useState('')
  const [defaultSource, setDefaultSource] = useState('')

  const { data: cities = [] } = useQuery({ queryKey: ['market-cities'], queryFn: () => api.get('/market/cities').then((r) => r.data) })

  const downloadTemplate = async () => {
    try {
      const res = await api.get('/market/import/template.xlsx', { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = 'market-import-template.xlsx'
      a.click()
      URL.revokeObjectURL(url)
    } catch { toast.error('فایل نمونه ساخته نشد') }
  }

  const upload = async (file: File) => {
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await api.post('/market/import/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      setPreview(res.data)
      // پیش‌فرض فقط ردیف‌های سالم تیک می‌خورند
      setPicked(new Set(res.data.items.filter((i: Item) => i.status === 'NEW').map((i: Item) => i.row)))
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'فایل خوانده نشد')
    } finally { setBusy(false) }
  }

  const commit = async () => {
    const items = preview.items.filter((i: Item) => picked.has(i.row) && i.data.name)
    if (!items.length) { toast.error('هیچ ردیفی انتخاب نشده'); return }
    setBusy(true)
    try {
      const res = await api.post('/market/import/commit', { items, defaultCityId, defaultSource })
      qc.invalidateQueries({ queryKey: ['market-contacts'] })
      qc.invalidateQueries({ queryKey: ['market-analytics'] })
      qc.invalidateQueries({ queryKey: ['market-cities'] })
      qc.invalidateQueries({ queryKey: ['market-facets'] })
      toast.success(`${res.data.created} مخاطب وارد شد`)
      if (res.data.failed?.length) toast.error(`${res.data.failed.length} ردیف وارد نشد`)
      onClose()
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'ثبت نشد')
    } finally { setBusy(false) }
  }

  const toggle = (row: number) => {
    const next = new Set(picked)
    next.has(row) ? next.delete(row) : next.add(row)
    setPicked(next)
  }
  const pickAll = (status: string) => {
    const next = new Set(picked)
    for (const i of preview.items as Item[]) if (i.status === status && i.data.name) next.add(i.row)
    setPicked(next)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 900 }}>
        <div className="modal-header"><h2>ورود مخاطبین از اکسل</h2><button onClick={onClose} aria-label="بستن"><Icon name="x" /></button></div>
        <div className="modal-body">
          {!preview ? (
            <>
              <Alert tint="info">
                فایل اکسل شما باید سرستون‌ها را در <strong>ردیف اول</strong> داشته باشد. ستون «نام» اجباری است؛ بقیه اختیاری‌اند.
                نام ستون‌ها فارسی یا انگلیسی هر دو شناخته می‌شوند (نام، تلفن، شهر، استان، واتساپ، آدرس، …).
              </Alert>
              <div style={{ display: 'flex', gap: 8, margin: '14px 0' }}>
                <button className="btn-secondary btn-sm" onClick={downloadTemplate}><Icon name="download" /> دانلود فایل نمونه</button>
              </div>
              <div className="form-group">
                <label>فایل اکسل (xlsx)</label>
                <input type="file" accept=".xlsx" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              </div>
              {busy && <div className="hint-sm">در حال خواندن فایل…</div>}
            </>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12, alignItems: 'center' }}>
                <Badge n={preview.counts.new} label="جدید" color="var(--success)" onClick={() => pickAll('NEW')} />
                <Badge n={preview.counts.duplicateDb} label="تکراری در سیستم" color="var(--warning)" onClick={() => pickAll('DUPLICATE_DB')} />
                <Badge n={preview.counts.duplicateFile} label="تکراری در فایل" color="var(--warning)" onClick={() => pickAll('DUPLICATE_FILE')} />
                <Badge n={preview.counts.invalid} label="ناقص" color="var(--danger)" />
                <strong style={{ marginRight: 'auto', fontSize: 13 }}>{picked.size} ردیف انتخاب شده</strong>
              </div>

              {preview.unmappedColumns?.length > 0 && (
                <Alert tint="warning">
                  این ستون‌ها شناخته نشدند و وارد نمی‌شوند: {preview.unmappedColumns.join('، ')}
                </Alert>
              )}

              <div className="form-grid-2" style={{ marginTop: 12 }}>
                <div className="form-group"><label>شهر پیش‌فرض (برای ردیف‌هایی که شهرشان تشخیص داده نشد)</label>
                  <SearchableSelect placeholder="بدون شهر" value={defaultCityId} onChange={setDefaultCityId}
                    options={cities.map((c: any) => ({ value: c.id, label: `${c.governorate} / ${c.name}` }))} />
                </div>
                <div className="form-group"><label>منبع پیش‌فرض</label>
                  <input value={defaultSource} onChange={(e) => setDefaultSource(e.target.value)} placeholder="مثلاً: لیست اینستاگرام مرداد" />
                </div>
              </div>

              <div className="table-container" style={{ maxHeight: 380, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr><th style={{ width: 32 }}></th><th>ردیف</th><th>نام</th><th>شهر</th><th>تلفن</th><th>وضعیت</th></tr>
                  </thead>
                  <tbody>
                    {preview.items.map((i: Item) => {
                      const st = STATUS_STYLE[i.status]
                      return (
                        <tr key={i.row} style={i.status === 'INVALID' ? { opacity: .55 } : undefined}>
                          <td><input type="checkbox" disabled={!i.data.name} checked={picked.has(i.row)} onChange={() => toggle(i.row)} /></td>
                          <td className="hint-sm">{i.row}</td>
                          <td style={{ fontSize: 12.5 }}>
                            {i.data.name || <span style={{ color: 'var(--danger)' }}>—</span>}
                            {i.data.ownerName && <div className="hint-sm">{i.data.ownerName}</div>}
                          </td>
                          <td className="hint-sm">{i.data.cityLabel || '—'}</td>
                          <td className="hint-sm" dir="ltr" style={{ textAlign: 'right' }}>{i.data.phone ? prettyPhone(i.data.phone) : '—'}</td>
                          <td>
                            <span className="chip-soft" style={{ color: st.color }}>{st.label}</span>
                            {i.duplicateOf && <div className="hint-sm">همان «{i.duplicateOf.name}» ({i.duplicateOf.code})</div>}
                            {i.issues.map((x, n) => <div key={n} className="hint-sm" style={{ color: 'var(--warning)' }}>{x}</div>)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>انصراف</button>
          {preview && <button className="btn-secondary" onClick={() => { setPreview(null); setPicked(new Set()) }}>فایل دیگر</button>}
          {preview && (
            <button className="btn-primary" disabled={busy || picked.size === 0} onClick={commit}>
              {busy ? 'در حال ثبت…' : `ثبت ${picked.size} مخاطب`}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Badge({ n, label, color, onClick }: { n: number; label: string; color: string; onClick?: () => void }) {
  return (
    <button type="button" disabled={!onClick || !n} onClick={onClick} className="chip-soft"
      style={{ color, cursor: onClick && n ? 'pointer' : 'default', borderColor: color }}>
      {label}: <strong>{n}</strong>{onClick && n ? ' (انتخاب همه)' : ''}
    </button>
  )
}
