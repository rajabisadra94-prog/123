import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../../lib/api'
import { Loading, TableEmpty } from '../../components/ui'
import Icon from '../../components/ui/Icon'
import { dialog, toast } from '../../components/ui/dialog'
import DateField from '../../components/shared/DateField'
import SearchableSelect from '../../components/shared/SearchableSelect'
import { faDate } from '../../lib/date'
import {
  STATUSES, STATUS_MAP, LEVEL_MAP, FOLLOWUP_STAGES,
  toneOf, prettyPhone, telLink, waLink, dueBucket, ratingStars,
} from './shared'

import type { MarketFilters } from './MarketPage'

/** ستاره‌های رتبه به‌صورت آیکون — نه رشتهٔ «★★★☆☆» که با فونت سیستم می‌آمد */
function Stars({ n }: { n?: number | null }) {
  if (!n) return <span className="hint-sm">—</span>
  return (
    <span style={{ display: 'inline-flex', gap: 1 }} title={`${n} از ۵`}>
      {ratingStars(n).map((on, i) => (
        <Icon key={i} name="star" size={12} style={{ color: on ? '#d97706' : 'var(--border-strong)', fill: on ? '#d97706' : 'none' }} />
      ))}
    </span>
  )
}

/** «تبدیل به مشتری» فقط از دکمهٔ اختصاصی داخل پروندهٔ مخاطب مجاز است، نه از این دراپ‌داونِ تغییر گروهی */
const CHANGEABLE_STATUSES = STATUSES.filter((s) => s.key !== 'CUSTOMER')


export default function ContactsTable({ filters, setFilters, onOpen }: {
  filters: MarketFilters
  setFilters: (f: MarketFilters) => void
  onOpen: (id: string, navIds: string[]) => void
}) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // مرتب‌سازی ثابت: امتیاز بالاتر اول. دراپ‌داونش برداشته شد چون در فاز
  // پیگیری، ترتیبِ داخل هر صف تصمیمِ کاربر نیست — «مهم‌ترین اول» همیشه درست است.
  const params = { ...filters, sort: 'score' }
  const { data, isLoading } = useQuery({
    queryKey: ['market-contacts', params],
    queryFn: () => api.get('/market/contacts', { params }).then((r) => r.data),
  })
  const { data: products = [] } = useQuery({ queryKey: ['market-products'], queryFn: () => api.get('/market/products').then((r) => r.data) })
  const { data: cities = [] } = useQuery({ queryKey: ['market-cities'], queryFn: () => api.get('/market/cities').then((r) => r.data) })
  // فیلتر روی دادهٔ موجود کار می‌کند، پس شهری که هیچ مخاطبی ندارد در آن بی‌معنی
  // است. شهرهای غیرفعال (که از تنظیمات خاموش شده‌اند) این‌جا نمی‌آیند تا
  // دراپ‌داون با ۸۰ شهر خالی شلوغ نشود.
  const activeCities = cities.filter((c: any) => c.isActive)
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users').then((r) => r.data) })

  const set = (patch: MarketFilters) => {
    const next = { ...filters, ...patch }
    for (const k of Object.keys(next)) if (!next[k]) delete next[k]
    setFilters(next)
    setSelected(new Set())
  }

  const bulk = useMutation({
    mutationFn: (b: any) => api.post('/market/contacts/bulk', { ...b, ids: [...selected] }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['market-contacts'] })
      // بدون این، عددِ روی چیپ‌ها بعد از بایگانی/تغییر مرحله کهنه می‌ماند
      qc.invalidateQueries({ queryKey: ['market-stage-counts'] })
      qc.invalidateQueries({ queryKey: ['market-analytics'] })
      toast.success(`${r.data.count} مخاطب به‌روز شد`)
      setSelected(new Set())
    },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  const rows: any[] = data?.rows || []
  // ترتیبِ دیده‌شده مبنای «بعدی/قبلی» در پروندهٔ مخاطب است
  const navIds = useMemo(() => rows.map((r: any) => r.id), [rows])

  // شمارندهٔ چیپ‌ها: همان فیلترهای فعلی منهای خودِ مرحله، تا عددها با لیست بخوانند
  const { data: counts = {} as any } = useQuery({
    queryKey: ['market-stage-counts', filters.cityId || '', filters.search || ''],
    queryFn: () => api.get('/market/contacts/stage-counts', {
      params: { cityId: filters.cityId || undefined, search: filters.search || undefined },
    }).then((r) => r.data),
  })
  const fmt = (n?: number) => (n || 0).toLocaleString('fa-IR')
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
  const toggleOne = (id: string) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
  }

  const bulkAction = async (action: string) => {
    if (action === 'delete') {
      const ok = await dialog.confirm({
        title: `حذف ${selected.size} مخاطب؟`,
        message: 'همهٔ تماس‌ها، نظرها و تعهدهای ارسال این مخاطب‌ها هم برای همیشه حذف می‌شود.',
        confirmLabel: 'حذف کن', tone: 'danger',
      })
      if (ok) bulk.mutate({ action: 'delete' })
      return
    }
    if (action === 'tag') {
      const tag = await dialog.prompt({ title: 'افزودن برچسب', message: `برچسب به ${selected.size} مخاطب اضافه می‌شود.`, placeholder: 'مثلاً: پیگیری ویژه' })
      if (tag?.trim()) bulk.mutate({ action: 'tag', value: tag.trim() })
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="panel panel-pad" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <input className="search-input" type="search" aria-label="جستجو در مخاطبین" placeholder="جستجوی نام، صاحب، شماره، کد…" style={{ minWidth: 220 }}
          value={filters.search || ''} onChange={(e) => set({ search: e.target.value })} />
        {/* تنها فیلترِ باقی‌مانده. بقیه (استان/وضعیت/نوع/محصول/رتبه/…) برداشته
            شدند: در فاز پیگیری، «مرحله» را چیپ‌های بالا تعیین می‌کنند و بقیه
            فقط نویز بودند. */}
        <SearchableSelect placeholder="همهٔ شهرها" style={{ minWidth: 170 }} value={filters.cityId || ''} onChange={(v) => set({ cityId: v })}
          options={activeCities.map((c: any) => ({ value: c.id, label: `${c.name} (${c._count?.contacts ?? 0})` }))} />
        <span className="mk-count" style={{ marginInlineStart: 'auto' }}>
          <strong>{isLoading ? '…' : (data?.total ?? 0).toLocaleString('fa-IR')}</strong>
          <span>مخاطب</span>
          {data && data.total > rows.length ? <em>نمایش {rows.length}</em> : null}
        </span>
      </div>

      {/* ── صف‌های کاری فاز پیگیری ──
          این‌ها جایگزین هم پنل ۱۳ فیلتره شدند و هم دراپ‌داون گروه‌بندی: در فاز
          پیگیری تنها سؤال «الان سراغ کی بروم؟» است، و هر چیپ دقیقاً یک جواب. */}
      <div className="panel panel-pad mk-stages">
        <button type="button" className={`mk-stage ${!filters.status && filters.archived !== '1' ? 'active' : ''}`}
          onClick={() => set({ status: '', archived: '' })}>
          <span>همه</span><b>{fmt(counts.active)}</b>
        </button>
        {FOLLOWUP_STAGES.map((key) => {
          const t = toneOf(STATUS_MAP, key)
          const n = counts.byStatus?.[key] || 0
          const on = filters.status === key && filters.archived !== '1'
          return (
            <button key={key} type="button" className={`mk-stage ${on ? 'active' : ''}`}
              style={on ? { borderColor: t.color, color: t.color } : undefined}
              onClick={() => set({ status: on ? '' : key, archived: '' })}>
              {t.icon && <Icon name={t.icon} size={14} style={{ color: t.color }} />}
              <span>{t.label}</span><b>{fmt(n)}</b>
            </button>
          )
        })}
        {/* بایگانی ته صف و خاکستری — عمداً شبیه بقیه نیست، چون صف کاری نیست */}
        <button type="button" className={`mk-stage archive ${filters.archived === '1' ? 'active' : ''}`}
          onClick={() => set({ status: '', archived: filters.archived === '1' ? '' : '1' })}>
          <Icon name="ban" size={14} />
          <span>بایگانی</span><b>{fmt(counts.archived)}</b>
        </button>
      </div>

      {selected.size > 0 && (
        <div className="panel panel-pad" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', borderColor: 'var(--brand-300)' }}>
          <strong style={{ fontSize: 13 }}>{selected.size} مخاطب انتخاب شده</strong>
          <select defaultValue="" style={{ maxWidth: 170 }} onChange={(e) => { if (e.target.value) { bulk.mutate({ action: 'status', value: e.target.value }); e.target.value = '' } }}>
            <option value="">تغییر وضعیت به…</option>
            {CHANGEABLE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
          <select defaultValue="" style={{ maxWidth: 170 }} onChange={(e) => { if (e.target.value) { bulk.mutate({ action: 'assign', value: e.target.value === 'none' ? '' : e.target.value }); e.target.value = '' } }}>
            <option value="">تعیین مسئول…</option>
            <option value="none">حذف مسئول</option>
            {users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <DateField placeholder="پیگیری همه در تاریخ…" style={{ minWidth: 165 }} value="" onChange={(v) => v && bulk.mutate({ action: 'followUp', value: v })} />
          {/* بعد از یک نمایشگاه، ده‌ها غرفه‌دار با هم علامت می‌خورند */}
          <select defaultValue="" style={{ maxWidth: 180 }} onChange={(e) => { if (e.target.value) { bulk.mutate({ action: 'exhibition', value: e.target.value }); e.target.value = '' } }}>
            <option value="">نمایشگاه…</option>
            <option value="1">شرکت می‌کند</option>
            <option value="0">شرکت نمی‌کند</option>
            <option value="none">برگردان به «نپرسیده‌ایم»</option>
          </select>
          <select defaultValue="" style={{ maxWidth: 180 }} onChange={(e) => { if (e.target.value) { bulk.mutate({ action: 'agency', value: e.target.value }); e.target.value = '' } }}>
            <option value="">نمایندگی…</option>
            <option value="1">تمایل دارد</option>
            <option value="0">تمایل ندارد</option>
            <option value="none">برگردان به «نپرسیده‌ایم»</option>
          </select>
          {/* بایگانی گروهی: بعد از یک دور تماس، ده‌ها «شمارهٔ اشتباه» با هم کنار می‌روند */}
          {filters.archived === '1' ? (
            <button className="btn-secondary btn-sm" onClick={() => bulk.mutate({ action: 'unarchive' })}>
              <Icon name="repeat" /> برگرداندن از بایگانی
            </button>
          ) : (
            <select defaultValue="" style={{ maxWidth: 190 }} onChange={(e) => { if (e.target.value) { bulk.mutate({ action: 'archive', value: e.target.value }); e.target.value = '' } }}>
              <option value="">بایگانی کن…</option>
              <option value="شمارهٔ نامعتبر یا بدون شماره">شمارهٔ نامعتبر</option>
              <option value="محصولات ما را نمی‌خواهد">محصولات ما را نمی‌خواهد</option>
              <option value="سایر">سایر</option>
            </select>
          )}
          <button className="btn-secondary btn-sm" onClick={() => bulkAction('tag')}><Icon name="plus" /> برچسب</button>
          <button className="btn-danger btn-sm" onClick={() => bulkAction('delete')}><Icon name="trash" /> حذف</button>
          <button className="btn-ghost btn-sm" style={{ marginRight: 'auto' }} onClick={() => setSelected(new Set())}>لغو انتخاب</button>
        </div>
      )}

      {isLoading ? <Loading /> : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 34 }}><input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="انتخاب همهٔ ردیف‌ها" /></th>
                <th>مخاطب</th>
                <th>شهر</th>
                <th>تماس</th>
                <th>وضعیت</th>
                <th>نظر محصولات</th>
                <th>رتبه</th>
                <th>امتیاز</th>
                <th>پیگیری</th>
                <th style={{ width: 90 }}>اقدام</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c: any) => (
                <Row key={c.id} c={c} products={products} selected={selected.has(c.id)}
                  onToggle={() => toggleOne(c.id)} onOpen={() => onOpen(c.id, navIds)} />
              ))}
              {rows.length === 0 && <TableEmpty colSpan={10}>مخاطبی با این فیلترها پیدا نشد.</TableEmpty>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}



function Row({ c, products, selected, onToggle, onOpen }: { c: any; products: any[]; selected: boolean; onToggle: () => void; onOpen: () => void }) {
  const status = toneOf(STATUS_MAP, c.status)
  const tel = telLink(c.phone)
  const wa = waLink(c.whatsapp || c.phone)
  const overdue = dueBucket(c.nextFollowUpAt) === 'overdue'

  return (
    <tr style={selected ? { background: 'var(--brand-50)' } : undefined}>
      <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected} onChange={onToggle} aria-label={`انتخاب ${c.name}`} /></td>
      <td>
        <button onClick={onOpen} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', textAlign: 'right', fontFamily: 'inherit' }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{c.name}</div>
          <div className="hint-sm">
            <span className="code-text">{c.code}</span>
            {c.ownerName ? ` · ${c.ownerName}` : ''}
            {c.attendsExhibition && <span className="chip-soft" style={{ marginRight: 5, color: 'var(--brand)' }} title="در نمایشگاه شرکت می‌کند"><Icon name="store" size={12} />نمایشگاه</span>}
            {c.wantsAgency && <span className="chip-soft" style={{ marginRight: 5, color: 'var(--success)' }} title="تمایل به نمایندگی دارد"><Icon name="handshake" size={12} />نمایندگی</span>}
          </div>
        </button>
      </td>
      <td className="hint-sm">{c.city ? `${c.city.name}` : '—'}<div style={{ opacity: .75, fontSize: 12 }}>{c.city?.governorate || ''}</div></td>
      <td className="hint-sm nowrap" style={{ direction: 'ltr', textAlign: 'right' }}>{prettyPhone(c.phone || c.whatsapp)}</td>
      <td><span className="chip-soft" style={{ color: status.color, borderColor: status.color }}>
        {status.icon && <Icon name={status.icon} size={13} />}{status.label}
      </span></td>
      <td>
        {/* نوار ۵ محصول: هر مربع یک محصول، رنگش نظر مخاطب */}
        <div style={{ display: 'flex', gap: 3 }}>
          {products.map((p: any) => {
            const it = c.interests?.find((i: any) => i.productId === p.id)
            const lv = toneOf(LEVEL_MAP, it?.level || 'NOT_DISCUSSED')
            return (
              <span key={p.id} title={`${p.name}: ${lv.label}`} style={{
                width: 15, height: 15, borderRadius: 4, display: 'inline-block',
                background: it && it.level !== 'NOT_DISCUSSED' ? lv.color : 'var(--bg)',
                border: '1px solid var(--border)',
              }} />
            )
          })}
        </div>
      </td>
      <td className="nowrap"><Stars n={c.rating} /></td>
      <td><strong style={{ fontSize: 13 }}>{c.score}</strong></td>
      <td className="hint-sm nowrap" style={overdue ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>
        {c.nextFollowUpAt ? faDate(c.nextFollowUpAt) : '—'}
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', gap: 4 }}>
          {tel && <a className="icon-btn" href={tel} title="تماس" aria-label={`تماس با ${c.name}`}><Icon name="phone" /></a>}
          {wa && <a className="icon-btn" href={wa} target="_blank" rel="noreferrer" title="واتساپ" aria-label={`واتساپ به ${c.name}`}><Icon name="chat" /></a>}
        </div>
      </td>
    </tr>
  )
}
