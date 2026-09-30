import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { toast } from '../../components/ui/dialog'
import SearchableSelect from '../../components/shared/SearchableSelect'
import { CONTACT_TYPES, LANGUAGES, cityOptions } from './shared'
import PhoneField from './PhoneField'
import Icon from '../../components/ui/Icon'

const EMPTY = {
  name: '', nameAr: '', ownerName: '', type: 'SHOP', cityId: '', address: '',
  phone: '', whatsapp: '', instagram: '', email: '', source: '', language: 'AR', notes: '',
}

/** ساخت مخاطب تکی — برای وقتی شماره‌ای بیرون از فایل اکسل پیدا می‌شود */
export default function ContactFormModal({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: string) => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState({ ...EMPTY })
  const [sameWhatsapp, setSameWhatsapp] = useState(true)
  const set = (k: string, v: any) => setF((s) => ({ ...s, [k]: v }))

  const { data: cities = [] } = useQuery({ queryKey: ['market-cities'], queryFn: () => api.get('/market/cities').then((r) => r.data) })

  const create = useMutation({
    mutationFn: () => api.post('/market/contacts', { ...f, whatsapp: sameWhatsapp ? f.phone : f.whatsapp }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['market-contacts'] })
      qc.invalidateQueries({ queryKey: ['market-analytics'] })
      qc.invalidateQueries({ queryKey: ['market-queue'] })
      toast.success('مخاطب ثبت شد')
      onCreated?.(r.data.id)
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.message || 'ثبت نشد'),
  })


  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 580 }}>
        <div className="modal-header"><h2>مخاطب جدید</h2><button onClick={onClose} aria-label="بستن"><Icon name="x" /></button></div>
        <div className="modal-body">
          <div className="form-group"><label>نام مغازه / شرکت *</label>
            <input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="مثلاً: مركز الرافدين لطب الأسنان" />
          </div>
          <div className="form-grid-2">
            <div className="form-group"><label>نام عربی</label>
              <input dir="rtl" value={f.nameAr} onChange={(e) => set('nameAr', e.target.value)} />
            </div>
            <div className="form-group"><label>نام صاحب / مسئول</label>
              <input value={f.ownerName} onChange={(e) => set('ownerName', e.target.value)} />
            </div>
            <div className="form-group"><label>نوع</label>
              <select value={f.type} onChange={(e) => set('type', e.target.value)}>
                {CONTACT_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </div>
            <div className="form-group"><label>شهر</label>
              <SearchableSelect placeholder="انتخاب شهر…" value={f.cityId} onChange={(v) => set('cityId', v)}
                options={cityOptions(cities)} />
            </div>
            <div className="form-group"><label>تلفن</label>
              <PhoneField value={f.phone} onChange={(v) => set('phone', v)} />
            </div>
            <div className="form-group"><label>واتساپ</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 5 }}>
                <input type="checkbox" checked={sameWhatsapp} onChange={(e) => setSameWhatsapp(e.target.checked)} />
                همان شمارهٔ تلفن
              </label>
              {!sameWhatsapp && <PhoneField value={f.whatsapp} onChange={(v) => set('whatsapp', v)} />}
            </div>
            <div className="form-group"><label>اینستاگرام</label>
              <input dir="ltr" value={f.instagram} onChange={(e) => set('instagram', e.target.value)} placeholder="@username" />
            </div>
            <div className="form-group"><label>ایمیل</label>
              <input dir="ltr" value={f.email} onChange={(e) => set('email', e.target.value)} />
            </div>
            <div className="form-group"><label>منبع این شماره</label>
              <input value={f.source} onChange={(e) => set('source', e.target.value)} placeholder="اینستاگرام، معرفی، نمایشگاه…" />
            </div>
            <div className="form-group"><label>زبان مکالمه</label>
              <select value={f.language} onChange={(e) => set('language', e.target.value)}>
                {LANGUAGES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group"><label>آدرس</label><textarea rows={2} value={f.address} onChange={(e) => set('address', e.target.value)} /></div>
          <div className="form-group"><label>یادداشت</label><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>انصراف</button>
          <button className="btn-primary" disabled={!f.name.trim() || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? 'در حال ثبت…' : 'ثبت مخاطب'}
          </button>
        </div>
      </div>
    </div>
  )
}
