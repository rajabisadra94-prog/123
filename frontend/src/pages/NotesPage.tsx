import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api from '../lib/api'
import { formatDateTime } from '../lib/date'
import { PageHeader } from '../components/ui'
import { dialog } from '../components/ui/dialog'

/* پالت یادداشت‌ها — کاملاً از خانوادهٔ برند (پترول / مینت) + یک لهجهٔ قرمز سازمانی و یک کهربایی خنثی.
   بدون بنفش/صورتی/سبزِ روشن که با بقیهٔ سیستم ناهماهنگ بود. */
const COLORS = [
  { bg: '#ffffff', dot: '#0f5569' }, // ساده
  { bg: '#eaf3f4', dot: '#0f5569' }, // پترول روشن
  { bg: '#d8edeb', dot: '#15919b' }, // مینت
  { bg: '#e4eef0', dot: '#0a3a49' }, // پترول تیره
  { bg: '#fde7e7', dot: '#e52329' }, // قرمز سازمانی
  { bg: '#fbf0dd', dot: '#e08a1e' }, // کهربایی (هشدار)
  { bg: '#f8fafb', dot: '#6a868d' }, // خاکستری
]

export default function NotesPage() {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [draftColor, setDraftColor] = useState(COLORS[0].bg)
  const [search, setSearch] = useState('')
  const [focused, setFocused] = useState(false)

  const { data: notes = [] } = useQuery({ queryKey: ['notes'], queryFn: () => api.get('/notes').then((r) => r.data) })

  const create = useMutation({
    mutationFn: () => api.post('/notes', { content: draft, color: draftColor }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['notes'] }); setDraft(''); setFocused(false) },
  })
  const update = useMutation({ mutationFn: ({ id, ...data }: any) => api.patch(`/notes/${id}`, data), onSuccess: () => qc.invalidateQueries({ queryKey: ['notes'] }) })
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/notes/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notes'] }) })

  const filtered = notes.filter((nt: any) => !search || nt.content.toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="page" dir="rtl">
      <PageHeader
        title="یادداشت‌های من"
        subtitle={`${notes.length} یادداشت · فقط برای شما قابل مشاهده است`}
        actions={<input className="search-input" placeholder="🔍 جستجو در یادداشت‌ها..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 260 }} />}
      />

      {/* Composer */}
      <div style={{ maxWidth: 600, margin: '0 auto 32px' }}>
        <div style={{ background: draftColor, borderRadius: 'var(--radius)', padding: focused ? 20 : 16, boxShadow: focused ? 'var(--shadow-lg)' : 'var(--shadow)', transition: 'all 0.2s', border: '1px solid rgba(0,0,0,0.04)' }}>
          <textarea
            rows={focused ? 4 : 1}
            placeholder="✏️ چیزی بنویسید..."
            value={draft}
            onFocus={() => setFocused(true)}
            onChange={(e) => setDraft(e.target.value)}
            style={{ background: 'transparent', border: 'none', resize: 'none', fontSize: 15, padding: 4, transition: 'all 0.2s' }}
          />
          {(focused || draft) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(0,0,0,0.08)' }}>
              {COLORS.map((c) => (
                <button key={c.bg} onClick={() => setDraftColor(c.bg)} title="رنگ"
                  style={{ width: 22, height: 22, borderRadius: '50%', background: c.bg, border: draftColor === c.bg ? `2px solid ${c.dot}` : '1px solid rgba(0,0,0,0.12)', cursor: 'pointer', padding: 0, transform: draftColor === c.bg ? 'scale(1.15)' : 'scale(1)', transition: 'transform 0.15s' }} />
              ))}
              <button className="btn-primary btn-sm" style={{ marginRight: 'auto' }} disabled={!draft.trim() || create.isPending} onClick={() => create.mutate()}>افزودن یادداشت</button>
            </div>
          )}
        </div>
      </div>

      {/* Notes masonry */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 56, marginBottom: 12 }}>📝</div>
          <p style={{ fontSize: 15 }}>{search ? 'یادداشتی با این جستجو پیدا نشد' : 'هنوز یادداشتی ندارید. اولین یادداشت را بنویسید!'}</p>
        </div>
      ) : (
        <div style={{ columns: '230px', columnGap: 18 }}>
          {filtered.map((nt: any) => (
            <NoteCard key={nt.id} note={nt} onSave={(content: string) => update.mutate({ id: nt.id, content })}
              onColor={(color: string) => update.mutate({ id: nt.id, color })}
              onDelete={async () => { if (await dialog.confirm({ title: 'این یادداشت حذف شود؟', message: 'این کار برگشت‌پذیر نیست.', confirmLabel: 'حذف', tone: 'danger' })) remove.mutate(nt.id) }} />
          ))}
        </div>
      )}
    </div>
  )
}

function NoteCard({ note, onSave, onColor, onDelete }: any) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState(note.content)
  const [hover, setHover] = useState(false)
  const dot = COLORS.find((c) => c.bg === note.color)?.dot || '#0f5569'

  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ background: note.color, borderRadius: 'var(--radius-sm)', padding: 16, marginBottom: 18, breakInside: 'avoid', boxShadow: hover ? 'var(--shadow)' : 'var(--shadow-sm)', border: '1px solid rgba(0,0,0,0.05)', position: 'relative', transition: 'box-shadow 0.18s, transform 0.18s', transform: hover ? 'translateY(-2px)' : 'none' }}
    >
      <div style={{ position: 'absolute', top: 14, right: 0, width: 4, height: 22, background: dot, borderRadius: '0 3px 3px 0' }} />

      {editing ? (
        <div>
          <textarea rows={4} value={val} onChange={(e) => setVal(e.target.value)} autoFocus
            style={{ background: 'rgba(255,255,255,0.6)', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 'var(--radius-sm)', fontSize: 14 }} />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="btn-primary btn-sm" onClick={() => { onSave(val); setEditing(false) }}>ذخیره</button>
            <button className="btn-secondary btn-sm" onClick={() => { setVal(note.content); setEditing(false) }}>انصراف</button>
          </div>
        </div>
      ) : (
        <div onClick={() => setEditing(true)} style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap', cursor: 'text', minHeight: 24, wordBreak: 'break-word', paddingRight: 8 }}>
          {note.content}
        </div>
      )}

      {/* Footer actions (reveal on hover) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(0,0,0,0.07)', opacity: hover || editing ? 1 : 0.35, transition: 'opacity 0.18s' }}>
        {COLORS.map((c) => (
          <button key={c.bg} onClick={() => onColor(c.bg)} title="تغییر رنگ"
            style={{ width: 15, height: 15, borderRadius: '50%', background: c.bg, border: note.color === c.bg ? `2px solid ${c.dot}` : '1px solid rgba(0,0,0,0.12)', cursor: 'pointer', padding: 0 }} />
        ))}
        <button onClick={onDelete} title="حذف" style={{ marginRight: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: 'rgba(0,0,0,0.45)' }}>🗑</button>
      </div>
      <div style={{ fontSize: 10, color: 'rgba(0,0,0,0.38)', marginTop: 6 }}>{formatDateTime(note.updatedAt)}</div>
    </div>
  )
}
