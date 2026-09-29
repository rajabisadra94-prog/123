import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { API_ORIGIN } from '../lib/api'
import { PageHeader, TabChips, Badge, Loading, EmptyState } from '../components/ui'
import { dialog, toast } from '../components/ui/dialog'
import SearchableSelect from '../components/shared/SearchableSelect'
import { toShamsi } from '../lib/date'

type Kind = 'producer' | 'supplier'

const STATUS_META: Record<string, { label: string; tint: any }> = {
  ACTIVE: { label: '✓ تأییدشده', tint: 'success' },
  TRIAL: { label: '⏳ آزمایشی', tint: 'warning' },
  BLACKLIST: { label: '⛔ لیست سیاه', tint: 'danger' },
}
const DOC_TYPES: Record<string, string> = {
  CATALOG: 'کاتالوگ', CERTIFICATE: 'گواهی', CONTRACT: 'قرارداد',
  FACTORY_PHOTO: 'عکس کارخانه', PRODUCT_PHOTO: 'عکس محصول', OTHER: 'سایر',
}
const fmt = (n: number) => Number(n).toLocaleString('en-US')

/** نمایش امتیاز ستاره‌ای — خواندنی یا قابل‌انتخاب */
function Stars({ value, onChange, size = 15 }: { value?: number | null; onChange?: (v: number) => void; size?: number }) {
  return (
    <span style={{ display: 'inline-flex', gap: 1, whiteSpace: 'nowrap' }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} onClick={onChange ? () => onChange(i) : undefined}
          style={{ fontSize: size, cursor: onChange ? 'pointer' : 'default', color: (value ?? 0) >= i ? '#f5a623' : 'var(--border-strong)', lineHeight: 1 }}>★</span>
      ))}
    </span>
  )
}

export default function VendorsPage() {
  const [view, setView] = useState<Kind | 'categories'>('producer')
  const kind: Kind = view === 'categories' ? 'producer' : view
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [f, setF] = useState<Record<string, string>>({})
  const setFilter = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }))
  const activeCount = Object.values(f).filter(Boolean).length + (status ? 1 : 0) + (categoryId ? 1 : 0)
  const clearAll = () => { setF({}); setStatus(''); setCategoryId('') }

  const isCat = view === 'categories'
  const cleanF = Object.fromEntries(Object.entries(f).filter(([, v]) => v))
  const params = { ...(search ? { search } : {}), ...(status ? { status } : {}), ...(categoryId ? { categoryId } : {}), ...cleanF }
  const { data: list = [], isLoading } = useQuery({
    queryKey: ['vendors', kind, params],
    queryFn: () => api.get(`/vendors/${kind}`, { params }).then((r) => r.data),
    enabled: !isCat,
  })
  const { data: categories = [] } = useQuery({ queryKey: ['producer-categories'], queryFn: () => api.get('/settings/producer-categories').then((r) => r.data) })
  const { data: facets = {} } = useQuery({ queryKey: ['vendor-facets', kind], queryFn: () => api.get(`/vendors/${kind}/facets`).then((r) => r.data), enabled: !isCat })

  const kindLabel = kind === 'producer' ? 'سازنده' : 'تامین‌کننده'

  return (
    <div className="page" dir="rtl">
      <PageHeader
        title="بانک طرف‌های تأمین"
        subtitle="آرشیو کامل سازندگان و تامین‌کنندگان — توانمندی، ارزیابی، سابقهٔ همکاری و اسناد"
        actions={!isCat && <button className="band-btn-primary" onClick={() => setShowCreate(true)}>+ {kindLabel} جدید</button>}
        chips={<TabChips value={view} onChange={(v) => { setView(v as any); setCategoryId('') }} tabs={[
          { key: 'producer', label: '🏭 سازندگان' },
          { key: 'supplier', label: '🛒 تامین‌کنندگان' },
          { key: 'categories', label: '📂 دسته‌بندی' },
        ]} />}
      />

      {isCat ? <CategoriesTab /> : <>

      {/* نوار خلاصه */}
      {/* فیلترها — ردیف اصلی + پنل پیشرفتهٔ تاشو */}
      <div className="filters-bar" style={{ marginBottom: showFilters ? 0 : undefined, borderRadius: showFilters ? 'var(--radius) var(--radius) 0 0' : undefined }}>
        <input className="search-input" placeholder="جستجو در نام، شهر، تخصص، تلفن، مخاطب…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: '2 1 240px' }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }}>
          <option value="">همهٔ وضعیت‌ها</option>
          {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <SearchableSelect style={{ minWidth: 170 }} value={categoryId} onChange={setCategoryId} placeholder="همهٔ دسته‌ها"
          options={categories.map((c: any) => ({ value: c.id, label: c.name }))} />
        <select value={f.sort || ''} onChange={(e) => setFilter('sort', e.target.value)} style={{ width: 'auto' }}>
          <option value="">مرتب‌سازی: نام</option>
          <option value="rating">بالاترین امتیاز</option>
          <option value="newest">جدیدترین</option>
          <option value="oldest">قدیمی‌ترین</option>
        </select>
        <button className={`band-chip ${showFilters ? 'active' : ''}`} onClick={() => setShowFilters(!showFilters)}>
          ⚙ فیلتر پیشرفته{activeCount > 0 && <span className="n">{activeCount}</span>}
        </button>
        {activeCount > 0 && <button className="btn-ghost btn-sm" onClick={clearAll}>پاک‌کردن فیلترها</button>}
      </div>

      {showFilters && (
        <div className="filters-adv">
          <div className="fa-grid">
            <label>کشور<SearchableSelect value={f.country || ''} onChange={(v) => setFilter('country', v)} placeholder="همه"
              options={(facets.countries || []).map((x: string) => ({ value: x, label: x }))} /></label>
            <label>شهر<SearchableSelect value={f.city || ''} onChange={(v) => setFilter('city', v)} placeholder="همه"
              options={(facets.cities || []).map((x: string) => ({ value: x, label: x }))} /></label>
            <label>تخصص<SearchableSelect value={f.specialty || ''} onChange={(v) => setFilter('specialty', v)} placeholder="همه"
              options={(facets.specialties || []).map((x: string) => ({ value: x, label: x }))} /></label>
            {kind === 'producer' && (
              <label>مادهٔ کاری<SearchableSelect value={f.material || ''} onChange={(v) => setFilter('material', v)} placeholder="همه"
                options={(facets.materials || []).map((x: string) => ({ value: x, label: x }))} /></label>
            )}
            <label>گواهینامه<SearchableSelect value={f.certification || ''} onChange={(v) => setFilter('certification', v)} placeholder="همه"
              options={(facets.certifications || []).map((x: string) => ({ value: x, label: x }))} /></label>
            <label>ارز<SearchableSelect value={f.currency || ''} onChange={(v) => setFilter('currency', v)} placeholder="همه"
              options={(facets.currencies || []).map((x: string) => ({ value: x, label: x }))} /></label>
            <label>اینکوترمز<SearchableSelect value={f.incoterms || ''} onChange={(v) => setFilter('incoterms', v)} placeholder="همه"
              options={(facets.incoterms || []).map((x: string) => ({ value: x, label: x }))} /></label>
            <label>حداقل امتیاز
              <select value={f.minRating || ''} onChange={(e) => setFilter('minRating', e.target.value)}>
                <option value="">همه</option>{[5, 4, 3, 2].map((n) => <option key={n} value={n}>{n} ستاره و بالاتر</option>)}
              </select>
            </label>
            <label>حداکثر زمان تحویل
              <select value={f.maxLeadTime || ''} onChange={(e) => setFilter('maxLeadTime', e.target.value)}>
                <option value="">همه</option>{[7, 15, 30, 45, 60, 90].map((n) => <option key={n} value={n}>تا {n} روز</option>)}
              </select>
            </label>
            {kind === 'producer' && (
              <label>محل ساخت
                <select value={f.isDomestic || ''} onChange={(e) => setFilter('isDomestic', e.target.value)}>
                  <option value="">همه</option><option value="1">🇮🇷 داخلی</option><option value="0">خارجی</option>
                </select>
              </label>
            )}
            <label>مخاطب ثبت‌شده
              <select value={f.hasContacts || ''} onChange={(e) => setFilter('hasContacts', e.target.value)}>
                <option value="">همه</option><option value="1">دارد</option><option value="0">ندارد</option>
              </select>
            </label>
            <label>مدرک بارگذاری‌شده
              <select value={f.hasDocs || ''} onChange={(e) => setFilter('hasDocs', e.target.value)}>
                <option value="">همه</option><option value="1">دارد</option><option value="0">ندارد</option>
              </select>
            </label>
          </div>
        </div>
      )}

      {isLoading ? <Loading /> : list.length === 0 ? (
        <EmptyState icon="🏭" title={`${kindLabel}‌ای یافت نشد`}>با فیلتر دیگری جستجو کنید یا مورد جدیدی اضافه کنید.</EmptyState>
      ) : (
        <>
          <div className="hint-sm" style={{ margin: '14px 2px 8px' }}>{list.length} {kindLabel} یافت شد</div>
          <div className="table-container">
            <table className="data-table">
              <thead><tr>
                <th>نام</th><th>وضعیت</th><th>موقعیت</th><th>دسته‌بندی</th>
                <th>تخصص</th><th>امتیاز</th><th>تحویل</th><th>مخاطب</th>
              </tr></thead>
              <tbody>
                {list.map((v: any) => (
                  <tr key={v.id} onClick={() => setDetailId(v.id)} style={{ cursor: 'pointer' }}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                        <div className="vendor-logo sm">{v.logoUrl ? <img src={v.logoUrl.startsWith('http') ? v.logoUrl : `${API_ORIGIN}${v.logoUrl}`} alt="" /> : (v.name?.[0] || '?')}</div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700 }}>{v.name}{v.isDomestic && <span className="chip-soft" style={{ marginRight: 5 }}>🇮🇷</span>}</div>
                          {v.nameEn && <div className="hint-sm" style={{ direction: 'ltr', textAlign: 'right' }}>{v.nameEn}</div>}
                        </div>
                      </div>
                    </td>
                    <td><Badge tint={STATUS_META[v.status]?.tint || 'brand'}>{STATUS_META[v.status]?.label || v.status}</Badge></td>
                    <td className="hint-sm">{[v.city, v.country].filter(Boolean).join('، ') || '—'}</td>
                    <td className="hint-sm">{v.categories?.length ? v.categories.map((c: any) => c.category.name).join(' · ') : '—'}</td>
                    <td className="hint-sm">{v.specialties?.length ? v.specialties.slice(0, 2).join('، ') + (v.specialties.length > 2 ? ` +${v.specialties.length - 2}` : '') : '—'}</td>
                    <td>{v.avgRating != null ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Stars value={Math.round(v.avgRating)} size={11} /><span className="tabular">{v.avgRating}</span></span> : <span className="hint-sm">—</span>}</td>
                    <td className="hint-sm nowrap">{v.leadTimeDays ? `${v.leadTimeDays} روز` : '—'}</td>
                    <td className="hint-sm">{v.contacts?.length ? `👤 ${v.contacts.length}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      </>}

      {showCreate && <VendorFormModal kind={kind} onClose={() => setShowCreate(false)} />}
      {detailId && <VendorDetailModal kind={kind} id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  )
}

// ─── انتخابگر درختی دسته در فرم ──────────────────────
/** انتخاب چنددسته‌ای روی درخت: هر گره جدا انتخاب می‌شود، و «کل شاخه» تمام نوادگان را یکجا می‌گیرد */
function CategoryPicker({ selected, onToggle, onSet }: { selected: string[]; onToggle: (id: string) => void; onSet: (ids: string[]) => void }) {
  const [q, setQ] = useState('')
  const { data: tree = [] } = useQuery({ queryKey: ['category-tree'], queryFn: () => api.get('/vendors/categories/tree').then((r) => r.data) })
  if (!tree.length) return null

  const idsOf = (n: any): string[] => [n.id, ...(n.children || []).flatMap(idsOf)]
  const matches = (n: any): boolean => !q || n.name.includes(q) || (n.children || []).some(matches)

  const Node = ({ n, depth }: { n: any; depth: number }) => {
    if (!matches(n)) return null
    const kids = n.children || []
    const branch = idsOf(n)
    const on = selected.includes(n.id)
    const allBranchOn = branch.length > 1 && branch.every((id) => selected.includes(id))
    const pickedInside = branch.filter((id) => selected.includes(id)).length
    return (
      <>
        <div className={`cat-pick-row ${on ? 'is-on' : ''}`}>
          <label className="cat-pick-label">
            <input type="checkbox" checked={on} onChange={() => onToggle(n.id)} />
            <span style={{ fontWeight: depth === 0 ? 700 : 500 }}>{n.name}</span>
            {kids.length > 0 && pickedInside > 0 && !on && <span className="cat-pick-count">({pickedInside} داخلش)</span>}
          </label>
          {kids.length > 0 && (
            <button type="button" className={`cat-branch-btn ${allBranchOn ? 'is-on' : ''}`}
              title={allBranchOn ? 'برداشتن کل این شاخه' : 'انتخاب این شاخه و همهٔ زیرشاخه‌هایش'}
              onClick={() => onSet(allBranchOn ? selected.filter((id) => !branch.includes(id)) : [...new Set([...selected, ...branch])])}>
              {allBranchOn ? '✓ کل شاخه' : `کل شاخه (${branch.length})`}
            </button>
          )}
        </div>
        {kids.length > 0 && (
          <div className="cat-pick-children">
            {kids.map((c: any) => <Node key={c.id} n={c} depth={depth + 1} />)}
          </div>
        )}
      </>
    )
  }

  return (
    <div className="form-group">
      <label>دسته‌بندی {selected.length > 0 && <span className="cat-usage">{selected.length} انتخاب‌شده</span>}</label>
      <div className="hint-sm" style={{ marginBottom: 7 }}>هر شاخه یا زیرشاخه را جدا تیک بزنید، یا با «کل شاخه» یکجا بگیرید.</div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="جستجو در دسته‌ها…" style={{ marginBottom: 8 }} />
      <div className="cat-pick-box">
        {tree.map((n: any) => <Node key={n.id} n={n} depth={0} />)}
      </div>
      {selected.length > 0 && (
        <button type="button" className="btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => onSet([])}>پاک‌کردن انتخاب‌ها</button>
      )}
    </div>
  )
}

// ─── دسته‌بندی درختی چندسطحی ──────────────────────────
function CategoriesTab() {
  const qc = useQueryClient()
  const [newRoot, setNewRoot] = useState('')
  const { data: tree = [], isLoading } = useQuery({ queryKey: ['category-tree'], queryFn: () => api.get('/vendors/categories/tree').then((r) => r.data) })
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['category-tree'] }); qc.invalidateQueries({ queryKey: ['producer-categories'] }) }

  const create = useMutation({
    mutationFn: (body: any) => api.post('/vendors/categories', body),
    onSuccess: () => { invalidate(); setNewRoot(''); toast.success('دسته اضافه شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  const flatten = (nodes: any[], depth = 0, acc: any[] = []): any[] => {
    for (const n of nodes) { acc.push({ ...n, depth }); flatten(n.children || [], depth + 1, acc) }
    return acc
  }
  const allFlat = flatten(tree)

  return (
    <div>
      <div className="panel panel-pad" style={{ marginBottom: 14 }}>
        <h4 className="section-title">افزودن دستهٔ اصلی</h4>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={newRoot} onChange={(e) => setNewRoot(e.target.value)} placeholder="نام دستهٔ جدید (مثلاً: ماشین‌کاری)"
            onKeyDown={(e) => { if (e.key === 'Enter' && newRoot.trim()) create.mutate({ name: newRoot }) }} />
          <button className="btn-primary" disabled={!newRoot.trim() || create.isPending} onClick={() => create.mutate({ name: newRoot })}>افزودن</button>
        </div>
      </div>

      {isLoading ? <Loading /> : tree.length === 0 ? (
        <EmptyState icon="📂" title="دسته‌ای تعریف نشده">اولین دستهٔ اصلی را از بالا اضافه کنید.</EmptyState>
      ) : (
        <div className="panel panel-pad">
          <h4 className="section-title">درخت دسته‌بندی</h4>
          <div className="cat-tree">
            {tree.map((n: any) => <CatNode key={n.id} node={n} depth={0} allFlat={allFlat} onChange={invalidate} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function CatNode({ node, depth, allFlat, onChange }: { node: any; depth: number; allFlat: any[]; onChange: () => void }) {
  const [open, setOpen] = useState(true)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(node.name)
  const [adding, setAdding] = useState(false)
  const [childName, setChildName] = useState('')
  const [moving, setMoving] = useState(false)

  const err = (e: any) => toast.error(e.response?.data?.message || 'خطا')
  const rename = useMutation({ mutationFn: () => api.patch(`/vendors/categories/${node.id}`, { name }), onSuccess: () => { onChange(); setEditing(false); toast.success('تغییر نام شد') }, onError: err })
  const addChild = useMutation({ mutationFn: () => api.post('/vendors/categories', { name: childName, parentId: node.id }), onSuccess: () => { onChange(); setChildName(''); setAdding(false); setOpen(true); toast.success('زیرشاخه اضافه شد') }, onError: err })
  const move = useMutation({ mutationFn: (parentId: string) => api.patch(`/vendors/categories/${node.id}`, { parentId: parentId || null }), onSuccess: () => { onChange(); setMoving(false); toast.success('جابه‌جا شد') }, onError: err })
  const del = useMutation({ mutationFn: () => api.delete(`/vendors/categories/${node.id}`), onSuccess: () => { onChange(); toast.success('حذف شد') }, onError: err })

  const kids = node.children || []
  const usage = (node.totalProducers || 0) + (node.totalSuppliers || 0)
  // گزینه‌های مقصد جابه‌جایی: همه به‌جز خودش و نوادگانش
  const descendantIds = new Set<string>()
  const collect = (n: any) => { descendantIds.add(n.id); (n.children || []).forEach(collect) }
  collect(node)
  const moveOptions = [{ value: '', label: '— دستهٔ اصلی (بدون والد) —' },
    ...allFlat.filter((c) => !descendantIds.has(c.id)).map((c) => ({ value: c.id, label: '　'.repeat(c.depth) + c.name }))]

  return (
    <div className={`cat-node ${depth ? 'is-child' : 'is-root'}`}>
      <div className={`cat-row depth-${Math.min(depth, 3)}`}>
        <button className={`cat-toggle ${kids.length ? '' : 'is-leaf'}`} onClick={() => kids.length && setOpen(!open)}
          title={kids.length ? (open ? 'بستن شاخه' : 'باز کردن شاخه') : undefined} aria-label={open ? 'بستن' : 'باز کردن'}>
          {kids.length ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .18s' }}><path d="M15 18l-6-6 6-6" /></svg>
          ) : <span className="cat-leaf-dot" />}
        </button>

        {editing ? (
          <>
            <input value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 240, flex: 1 }} autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) rename.mutate(); if (e.key === 'Escape') { setEditing(false); setName(node.name) } }} />
            <button className="btn-primary btn-sm" disabled={!name.trim()} onClick={() => rename.mutate()}>ذخیره</button>
            <button className="btn-ghost btn-sm" onClick={() => { setEditing(false); setName(node.name) }}>انصراف</button>
          </>
        ) : (
          <>
            <span className="cat-name" onDoubleClick={() => setEditing(true)} title="دوبار کلیک برای تغییر نام">{node.name}</span>
            {kids.length > 0 && <span className="cat-badge">{kids.length}</span>}
            {usage > 0 && <span className="cat-usage" title={`${node.totalProducers} سازنده · ${node.totalSuppliers} تامین‌کننده (شامل زیرشاخه‌ها)`}>{usage} طرف</span>}
            <span className="cat-actions">
              <button className="cat-btn add" onClick={() => { setAdding(!adding); setMoving(false) }} title="افزودن زیرشاخه">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              </button>
              <button className="cat-btn" onClick={() => setEditing(true)} title="تغییر نام">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
              </button>
              <button className="cat-btn" onClick={() => { setMoving(!moving); setAdding(false) }} title="انتقال به شاخهٔ دیگر">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 9l-3 3 3 3" /><path d="M2 12h10a5 5 0 0 0 5-5V5" /></svg>
              </button>
              <button className="cat-btn danger" title="حذف دسته" onClick={async () => {
                if (await dialog.confirm({ title: 'حذف دسته؟', message: `«${node.name}»${usage ? ` — ${usage} طرف تأمین به این شاخه وصل‌اند` : ''}`, confirmLabel: 'حذف', tone: 'danger' })) del.mutate()
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>
              </button>
            </span>
          </>
        )}
      </div>

      {moving && (
        <div className="cat-inline">
          <span className="cat-inline-label">انتقال «{node.name}» به زیرِ:</span>
          <SearchableSelect style={{ minWidth: 230 }} value={node.parentId || ''} onChange={(v) => move.mutate(v)} options={moveOptions} placeholder="انتخاب شاخهٔ مقصد…" />
          <button className="btn-ghost btn-sm" onClick={() => setMoving(false)}>انصراف</button>
        </div>
      )}

      {adding && (
        <div className="cat-inline">
          <span className="cat-inline-label">زیرشاخهٔ جدید برای «{node.name}»:</span>
          <input value={childName} onChange={(e) => setChildName(e.target.value)} placeholder="نام زیرشاخه…" autoFocus style={{ maxWidth: 220 }}
            onKeyDown={(e) => { if (e.key === 'Enter' && childName.trim()) addChild.mutate(); if (e.key === 'Escape') setAdding(false) }} />
          <button className="btn-primary btn-sm" disabled={!childName.trim() || addChild.isPending} onClick={() => addChild.mutate()}>افزودن</button>
          <button className="btn-ghost btn-sm" onClick={() => { setAdding(false); setChildName('') }}>انصراف</button>
        </div>
      )}

      {open && kids.length > 0 && (
        <div className="cat-children">
          {kids.map((c: any) => <CatNode key={c.id} node={c} depth={depth + 1} allFlat={allFlat} onChange={onChange} />)}
        </div>
      )}
    </div>
  )
}

// ─── فرم ساخت/ویرایش ─────────────────────────────────
function VendorFormModal({ kind, vendor, onClose }: { kind: Kind; vendor?: any; onClose: () => void }) {
  const qc = useQueryClient()
  const isEdit = !!vendor
  const [f, setF] = useState<any>({
    name: vendor?.name || '', nameEn: vendor?.nameEn || '', country: vendor?.country || '', city: vendor?.city || '',
    phone: vendor?.phone || '', email: vendor?.email || '', website: vendor?.website || '', wechat: vendor?.wechat || '',
    whatsapp: vendor?.whatsapp || '', alibabaUrl: vendor?.alibabaUrl || '', address: vendor?.address || '',
    specialties: (vendor?.specialties || []).join('، '), materials: (vendor?.materials || []).join('، '),
    brands: (vendor?.brands || []).join('، '), certifications: (vendor?.certifications || []).join('، '),
    moq: vendor?.moq || '', capacity: vendor?.capacity || '', leadTimeDays: vendor?.leadTimeDays ?? '',
    status: vendor?.status || 'ACTIVE', riskNote: vendor?.riskNote || '',
    paymentTerms: vendor?.paymentTerms || '', currency: vendor?.currency || '', incoterms: vendor?.incoterms || '',
    bankInfo: vendor?.bankInfo || '', notes: vendor?.notes || '', isDomestic: vendor?.isDomestic || false,
    ratingQuality: vendor?.ratingQuality ?? null, ratingPrice: vendor?.ratingPrice ?? null,
    ratingDelivery: vendor?.ratingDelivery ?? null, ratingComms: vendor?.ratingComms ?? null,
    categoryIds: (vendor?.categories || []).map((c: any) => c.categoryId || c.category?.id),
  })
  const set = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }))
  const splitList = (s: string) => s.split(/[،,]/).map((x) => x.trim()).filter(Boolean)

  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, specialties: splitList(f.specialties), materials: splitList(f.materials), brands: splitList(f.brands), certifications: splitList(f.certifications) }
      return isEdit ? api.patch(`/vendors/${kind}/${vendor.id}`, body) : api.post(`/vendors/${kind}`, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vendors'] }); qc.invalidateQueries({ queryKey: ['vendors-summary'] })
      if (isEdit) qc.invalidateQueries({ queryKey: ['vendor', kind, vendor.id] })
      toast.success(isEdit ? 'ذخیره شد' : 'اضافه شد'); onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  const toggleCat = (id: string) => set('categoryIds', f.categoryIds.includes(id) ? f.categoryIds.filter((x: string) => x !== id) : [...f.categoryIds, id])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 760 }}>
        <div className="modal-header"><h2>{isEdit ? 'ویرایش' : 'افزودن'} {kind === 'producer' ? 'سازنده' : 'تامین‌کننده'}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <h3 className="section-title">🏷 هویت و تماس</h3>
          <div className="form-grid-2">
            <div className="form-group"><label>نام *</label><input value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
            <div className="form-group"><label>نام لاتین / چینی</label><input value={f.nameEn} onChange={(e) => set('nameEn', e.target.value)} dir="ltr" /></div>
            <div className="form-group"><label>کشور</label><input value={f.country} onChange={(e) => set('country', e.target.value)} placeholder="چین، ایران…" /></div>
            <div className="form-group"><label>شهر</label><input value={f.city} onChange={(e) => set('city', e.target.value)} /></div>
            <div className="form-group"><label>تلفن</label><input value={f.phone} onChange={(e) => set('phone', e.target.value)} dir="ltr" /></div>
            <div className="form-group"><label>ایمیل</label><input value={f.email} onChange={(e) => set('email', e.target.value)} dir="ltr" /></div>
            <div className="form-group"><label>وی‌چت</label><input value={f.wechat} onChange={(e) => set('wechat', e.target.value)} dir="ltr" /></div>
            <div className="form-group"><label>واتس‌اپ</label><input value={f.whatsapp} onChange={(e) => set('whatsapp', e.target.value)} dir="ltr" /></div>
            <div className="form-group"><label>وب‌سایت</label><input value={f.website} onChange={(e) => set('website', e.target.value)} dir="ltr" /></div>
            <div className="form-group"><label>علی‌بابا / 1688</label><input value={f.alibabaUrl} onChange={(e) => set('alibabaUrl', e.target.value)} dir="ltr" /></div>
          </div>
          <div className="form-group"><label>آدرس</label><input value={f.address} onChange={(e) => set('address', e.target.value)} /></div>

          <h3 className="section-title" style={{ marginTop: 14 }}>⚙️ توانمندی</h3>
          <div className="form-group"><label>تخصص‌ها (با ، جدا کنید)</label><input value={f.specialties} onChange={(e) => set('specialties', e.target.value)} placeholder="CNC، ریخته‌گری، آبکاری" /></div>
          {kind === 'producer' ? (
            <div className="form-group"><label>مواد قابل‌کار</label><input value={f.materials} onChange={(e) => set('materials', e.target.value)} placeholder="فولاد، آلومینیوم، برنج" /></div>
          ) : (
            <div className="form-group"><label>برندهای تأمینی</label><input value={f.brands} onChange={(e) => set('brands', e.target.value)} /></div>
          )}
          <div className="form-grid-2">
            <div className="form-group"><label>حداقل سفارش (MOQ)</label><input value={f.moq} onChange={(e) => set('moq', e.target.value)} /></div>
            <div className="form-group"><label>زمان تحویل معمول (روز)</label><input type="number" value={f.leadTimeDays} onChange={(e) => set('leadTimeDays', e.target.value)} /></div>
            {kind === 'producer' && <div className="form-group"><label>ظرفیت ماهانه</label><input value={f.capacity} onChange={(e) => set('capacity', e.target.value)} /></div>}
            <div className="form-group"><label>گواهی‌ها</label><input value={f.certifications} onChange={(e) => set('certifications', e.target.value)} placeholder="ISO9001، CE" /></div>
          </div>
          <CategoryPicker selected={f.categoryIds} onToggle={toggleCat} onSet={(ids) => set('categoryIds', ids)} />

          <h3 className="section-title" style={{ marginTop: 14 }}>⭐ ارزیابی</h3>
          <div className="form-grid-2">
            {([['ratingQuality', 'کیفیت'], ['ratingPrice', 'قیمت'], ['ratingDelivery', 'زمان‌بندی'], ['ratingComms', 'ارتباط']] as const).map(([k, label]) => (
              <div className="form-group" key={k}><label>{label}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Stars value={f[k]} onChange={(v) => set(k, v)} size={20} />
                  {f[k] ? <button type="button" className="btn-ghost btn-sm" onClick={() => set(k, null)}>پاک</button> : null}
                </div>
              </div>
            ))}
            <div className="form-group"><label>وضعیت</label>
              <select value={f.status} onChange={(e) => set('status', e.target.value)}>
                {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </div>
            <div className="form-group"><label>یادداشت ریسک</label><input value={f.riskNote} onChange={(e) => set('riskNote', e.target.value)} /></div>
          </div>

          <h3 className="section-title" style={{ marginTop: 14 }}>💳 شرایط تجاری</h3>
          <div className="form-grid-2">
            <div className="form-group"><label>شرایط پرداخت</label><input value={f.paymentTerms} onChange={(e) => set('paymentTerms', e.target.value)} placeholder="۳۰٪ بیعانه، ۷۰٪ قبل ارسال" /></div>
            <div className="form-group"><label>ارز ترجیحی</label><input value={f.currency} onChange={(e) => set('currency', e.target.value)} placeholder="USD / CNY" /></div>
            <div className="form-group"><label>شرایط تحویل</label><input value={f.incoterms} onChange={(e) => set('incoterms', e.target.value)} placeholder="FOB / EXW / CIF" /></div>
            <div className="form-group"><label>اطلاعات بانکی</label><input value={f.bankInfo} onChange={(e) => set('bankInfo', e.target.value)} /></div>
          </div>
          {kind === 'producer' && (
            <label className="check-row"><input type="checkbox" style={{ width: 'auto' }} checked={f.isDomestic} onChange={(e) => set('isDomestic', e.target.checked)} /> سازندهٔ داخل ایران</label>
          )}
          <div className="form-group" style={{ marginTop: 10 }}><label>یادداشت</label><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>انصراف</button>
          <button className="btn-primary" disabled={!f.name.trim() || save.isPending} onClick={() => save.mutate()}>ذخیره</button>
        </div>
      </div>
    </div>
  )
}

// ─── پروفایل کامل ────────────────────────────────────
function VendorDetailModal({ kind, id, onClose }: { kind: Kind; id: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'info' | 'contacts' | 'history' | 'docs'>('info')
  const [showEdit, setShowEdit] = useState(false)
  const { data: v, isLoading } = useQuery({ queryKey: ['vendor', kind, id], queryFn: () => api.get(`/vendors/${kind}/${id}`).then((r) => r.data) })
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['vendor', kind, id] }); qc.invalidateQueries({ queryKey: ['vendors'] }) }

  if (showEdit && v) return <VendorFormModal kind={kind} vendor={v} onClose={() => setShowEdit(false)} />

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <h2>{isLoading ? '…' : v?.name}</h2>
          <button onClick={onClose}>✕</button>
        </div>
        {v && (
          <div className="modal-body">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
              <div className="vendor-logo" style={{ width: 52, height: 52, fontSize: 20 }}>{v.logoUrl ? <img src={v.logoUrl.startsWith('http') ? v.logoUrl : `${API_ORIGIN}${v.logoUrl}`} alt="" /> : (v.name?.[0] || '?')}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {v.nameEn && <div className="hint-sm" dir="ltr" style={{ textAlign: 'right' }}>{v.nameEn}</div>}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 3 }}>
                  <Badge tint={STATUS_META[v.status]?.tint || 'brand'}>{STATUS_META[v.status]?.label}</Badge>
                  {v.avgRating != null && <span><Stars value={Math.round(v.avgRating)} /> <b>{v.avgRating}</b></span>}
                  <span className="hint-sm">{[v.city, v.country].filter(Boolean).join('، ')}</span>
                </div>
              </div>
              <button className="btn-secondary btn-sm" onClick={() => setShowEdit(true)}>✎ ویرایش</button>
            </div>

            <div className="settings-tabs" style={{ marginBottom: 14 }}>
              {([['info', 'اطلاعات'], ['contacts', `مخاطبان (${v.contacts?.length || 0})`], ['history', 'سابقهٔ همکاری'], ['docs', `اسناد (${v.documents?.length || 0})`]] as const).map(([k, label]) => (
                <button key={k} className={`tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k as any)}>{label}</button>
              ))}
            </div>

            {tab === 'info' && <InfoTab v={v} kind={kind} />}
            {tab === 'contacts' && <ContactsTab v={v} kind={kind} onChange={invalidate} />}
            {tab === 'history' && <HistoryTab v={v} />}
            {tab === 'docs' && <DocsTab v={v} kind={kind} onChange={invalidate} />}
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: any }) {
  if (!value) return null
  return <div style={{ display: 'flex', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
    <span className="hint-sm" style={{ width: 130, flex: 'none' }}>{label}</span>
    <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{value}</span>
  </div>
}

function InfoTab({ v, kind }: { v: any; kind: Kind }) {
  return (
    <div>
      {v.specialties?.length > 0 && <div className="vendor-tags" style={{ marginBottom: 12 }}>{v.specialties.map((s: string) => <span key={s} className="vendor-tag">{s}</span>)}</div>}
      <Row label="تلفن" value={v.phone} />
      <Row label="ایمیل" value={v.email} />
      <Row label="وی‌چت" value={v.wechat} />
      <Row label="واتس‌اپ" value={v.whatsapp} />
      <Row label="وب‌سایت" value={v.website ? <a href={v.website} target="_blank" rel="noreferrer">{v.website}</a> : null} />
      <Row label="علی‌بابا/1688" value={v.alibabaUrl ? <a href={v.alibabaUrl} target="_blank" rel="noreferrer">مشاهده</a> : null} />
      <Row label="آدرس" value={v.address} />
      <Row label="دسته‌بندی" value={v.categories?.map((c: any) => c.category.name).join(' · ')} />
      <Row label={kind === 'producer' ? 'مواد' : 'برندها'} value={(kind === 'producer' ? v.materials : v.brands)?.join('، ')} />
      <Row label="حداقل سفارش" value={v.moq} />
      <Row label="ظرفیت" value={v.capacity} />
      <Row label="زمان تحویل" value={v.leadTimeDays ? `${v.leadTimeDays} روز` : null} />
      <Row label="گواهی‌ها" value={v.certifications?.join('، ')} />
      <Row label="شرایط پرداخت" value={v.paymentTerms} />
      <Row label="ارز ترجیحی" value={v.currency} />
      <Row label="شرایط تحویل" value={v.incoterms} />
      <Row label="اطلاعات بانکی" value={v.bankInfo} />
      <Row label="یادداشت ریسک" value={v.riskNote ? <span style={{ color: 'var(--danger)' }}>{v.riskNote}</span> : null} />
      <Row label="یادداشت" value={v.notes} />
      {(v.ratingQuality || v.ratingPrice || v.ratingDelivery || v.ratingComms) && (
        <div style={{ marginTop: 14 }}>
          <h4 className="section-title">امتیازها</h4>
          {([['ratingQuality', 'کیفیت'], ['ratingPrice', 'قیمت'], ['ratingDelivery', 'زمان‌بندی'], ['ratingComms', 'ارتباط']] as const).map(([k, label]) => (
            v[k] ? <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0', fontSize: 13 }}>
              <span className="hint-sm" style={{ width: 80 }}>{label}</span><Stars value={v[k]} />
            </div> : null
          ))}
        </div>
      )}
    </div>
  )
}

function HistoryTab({ v }: { v: any }) {
  const s = v.scorecard
  return (
    <div>
      <div className="grid-3" style={{ marginBottom: 14 }}>
        <div className="panel panel-pad" style={{ textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800 }}>{s.orderCount}</div><div className="hint-sm">کل سفارش‌ها</div></div>
        <div className="panel panel-pad" style={{ textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: 'var(--success)' }}>{s.onTimeRate ?? '—'}{s.onTimeRate != null ? '٪' : ''}</div><div className="hint-sm">تحویل به‌موقع</div></div>
        <div className="panel panel-pad" style={{ textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800 }}>{s.quoteCount}</div><div className="hint-sm">استعلام قیمت</div></div>
      </div>
      {s.balances?.length > 0 && (
        <div className="panel panel-pad" style={{ marginBottom: 14 }}>
          <div className="hint-sm" style={{ marginBottom: 6 }}>مانده حساب</div>
          {s.balances.map((b: any) => (
            <div key={b.currency} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
              <span>{b.currency}</span><b style={{ color: b.balance < 0 ? 'var(--danger)' : 'var(--success)' }}>{fmt(b.balance)}</b>
            </div>
          ))}
        </div>
      )}
      {s.lastOrderAt && <div className="hint-sm" style={{ marginBottom: 10 }}>آخرین همکاری: {toShamsi(s.lastOrderAt)}</div>}
      <h4 className="section-title">سفارش‌های اخیر</h4>
      {v.orders?.length === 0 ? <div className="hint-sm" style={{ opacity: .6 }}>سفارشی ثبت نشده.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {v.orders.map((o: any) => (
            <div key={o.id} className="panel panel-pad" style={{ padding: 10, display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
              <span className="code-text">{o.code}</span>
              <span className="hint-sm">{o.project} — {o.customer}</span>
              <span className="hint-sm">{toShamsi(o.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ContactsTab({ v, kind, onChange }: { v: any; kind: Kind; onChange: () => void }) {
  const [f, setF] = useState<any>({ name: '', role: '', phone: '', email: '', wechat: '', language: '', isPrimary: false })
  const add = useMutation({
    mutationFn: () => api.post(`/vendors/${kind}/${v.id}/contacts`, f),
    onSuccess: () => { onChange(); setF({ name: '', role: '', phone: '', email: '', wechat: '', language: '', isPrimary: false }); toast.success('مخاطب اضافه شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const del = useMutation({ mutationFn: (cid: string) => api.delete(`/vendors/contacts/${cid}`), onSuccess: () => { onChange(); toast.success('حذف شد') } })

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
        {v.contacts?.map((c: any) => (
          <div key={c.id} className="panel panel-pad" style={{ padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5 }}>{c.name} {c.isPrimary && <span className="chip-soft" style={{ marginRight: 5 }}>اصلی</span>}</div>
                {c.role && <div className="hint-sm">{c.role}</div>}
                <div className="hint-sm" style={{ marginTop: 3 }}>{[c.phone, c.email, c.wechat && `WeChat: ${c.wechat}`, c.language].filter(Boolean).join(' · ')}</div>
              </div>
              <button className="btn-danger btn-sm" onClick={async () => { if (await dialog.confirm({ title: 'حذف مخاطب؟', message: c.name, confirmLabel: 'حذف', tone: 'danger' })) del.mutate(c.id) }}>🗑</button>
            </div>
          </div>
        ))}
        {(!v.contacts || v.contacts.length === 0) && <div className="hint-sm" style={{ opacity: .6 }}>مخاطبی ثبت نشده.</div>}
      </div>
      <div className="panel panel-pad">
        <h4 className="section-title">افزودن مخاطب</h4>
        <div className="form-grid-2">
          <div className="form-group"><label>نام *</label><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="form-group"><label>سِمت</label><input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="مدیر فروش" /></div>
          <div className="form-group"><label>تلفن</label><input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} dir="ltr" /></div>
          <div className="form-group"><label>ایمیل</label><input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} dir="ltr" /></div>
          <div className="form-group"><label>وی‌چت</label><input value={f.wechat} onChange={(e) => setF({ ...f, wechat: e.target.value })} dir="ltr" /></div>
          <div className="form-group"><label>زبان مکاتبه</label><input value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} placeholder="انگلیسی / چینی" /></div>
        </div>
        <label className="check-row"><input type="checkbox" style={{ width: 'auto' }} checked={f.isPrimary} onChange={(e) => setF({ ...f, isPrimary: e.target.checked })} /> مخاطب اصلی</label>
        <button className="btn-primary btn-sm" style={{ marginTop: 10 }} disabled={!f.name.trim() || add.isPending} onClick={() => add.mutate()}>افزودن</button>
      </div>
    </div>
  )
}

function DocsTab({ v, kind, onChange }: { v: any; kind: Kind; onChange: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [docType, setDocType] = useState('OTHER')
  const up = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      fd.append('file', file!); fd.append('title', title); fd.append('docType', docType)
      return api.post(`/vendors/${kind}/${v.id}/documents`, fd)
    },
    onSuccess: () => { onChange(); setFile(null); setTitle(''); toast.success('سند آپلود شد') },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })
  const del = useMutation({ mutationFn: (did: string) => api.delete(`/vendors/documents/${did}`), onSuccess: () => { onChange(); toast.success('حذف شد') } })

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
        {v.documents?.map((d: any) => (
          <div key={d.id} className="panel panel-pad" style={{ padding: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <a href={`${API_ORIGIN}${d.url}`} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600 }}>{d.title}</a>
              <div className="hint-sm">{DOC_TYPES[d.docType] || d.docType} · {toShamsi(d.createdAt)}</div>
            </div>
            <button className="btn-danger btn-sm" onClick={async () => { if (await dialog.confirm({ title: 'حذف سند؟', message: d.title, confirmLabel: 'حذف', tone: 'danger' })) del.mutate(d.id) }}>🗑</button>
          </div>
        ))}
        {(!v.documents || v.documents.length === 0) && <div className="hint-sm" style={{ opacity: .6 }}>سندی آپلود نشده.</div>}
      </div>
      <div className="panel panel-pad">
        <h4 className="section-title">آپلود سند</h4>
        <div className="form-grid-2">
          <div className="form-group"><label>عنوان</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="کاتالوگ ۲۰۲۵" /></div>
          <div className="form-group"><label>نوع</label>
            <select value={docType} onChange={(e) => setDocType(e.target.value)}>
              {Object.entries(DOC_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        </div>
        <div className="form-group"><label>فایل *</label><input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} /></div>
        <button className="btn-primary btn-sm" disabled={!file || up.isPending} onClick={() => up.mutate()}>آپلود</button>
      </div>
    </div>
  )
}
