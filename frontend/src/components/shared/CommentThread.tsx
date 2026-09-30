import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { API_ORIGIN } from '../../lib/api'
import { formatDateTime } from '../../lib/date'

const EMOJIS = ['😊', '👍', '✅', '⚠️', '❗', '🙏', '🔥', '📌', '💡', '🚀']
const FILE_HOST = API_ORIGIN

export function renderCommentText(text: string) {
  const parts: any[] = []
  const re = /@\[(.+?)\]\((.+?)\)/g
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(<span key={m.index} style={{ color: 'var(--brand)', fontWeight: 700 }}>@{m[1]}</span>)
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** Unified comment/report thread. `base` e.g. `/comments/task/123` or `/comments/project/abc`. */
export default function CommentThread({ base, queryKey }: { base: string; queryKey: any[] }) {
  const qc = useQueryClient()
  const { data: flat = [] } = useQuery({ queryKey, queryFn: () => api.get(base).then((r) => r.data) })
  const refresh = () => qc.invalidateQueries({ queryKey })

  // build tree
  const tree = useMemo(() => {
    const byId: Record<string, any> = {}
    flat.forEach((c: any) => { byId[c.id] = { ...c, children: [] } })
    const roots: any[] = []
    flat.forEach((c: any) => {
      if (c.parentId && byId[c.parentId]) byId[c.parentId].children.push(byId[c.id])
      else roots.push(byId[c.id])
    })
    // newest roots first; replies oldest first (chronological within a thread)
    return roots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  }, [flat])

  return (
    <div>
      <Composer base={base} onPosted={refresh} />
      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {tree.map((c: any) => <CommentNode key={c.id} c={c} base={base} onChange={refresh} depth={0} />)}
        {tree.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>هنوز گزارشی ثبت نشده است.</p>}
      </div>
    </div>
  )
}

function CommentNode({ c, base, onChange, depth }: any) {
  const [replying, setReplying] = useState(false)

  // System activity message: render as a small centered note
  if (c.isSystem) {
    return (
      <div style={{ textAlign: 'center', margin: '2px 0' }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)', background: 'var(--surface-2)', padding: '3px 12px', borderRadius: 100, display: 'inline-block' }}>
          🛈 {c.text} · {formatDateTime(c.createdAt)}
        </span>
        {c.children?.length > 0 && (
          <div style={{ marginTop: 8, paddingRight: depth < 6 ? 16 : 0, borderRight: '2px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'right' }}>
            {c.children.map((ch: any) => <CommentNode key={ch.id} c={ch} base={base} onChange={onChange} depth={depth + 1} />)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ background: depth === 0 ? 'var(--surface)' : 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12 }}>
      <Header c={c} />
      <div style={{ fontSize: 13.5, margin: '6px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderCommentText(c.text)}</div>
      <Attachments urls={c.attachmentUrls} />
      <button className="btn-secondary btn-sm" onClick={() => setReplying(!replying)}>پاسخ</button>
      {replying && <div style={{ marginTop: 8 }}><Composer base={base} parentId={c.id} compact onPosted={() => { setReplying(false); onChange() }} /></div>}
      {c.children?.length > 0 && (
        <div style={{ marginTop: 10, paddingRight: depth < 6 ? 14 : 4, borderRight: '2px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {c.children.map((ch: any) => <CommentNode key={ch.id} c={ch} base={base} onChange={onChange} depth={depth + 1} />)}
        </div>
      )}
    </div>
  )
}

function Header({ c }: any) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--brand)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>{c.user?.name?.[0] || '؟'}</div>
      <strong style={{ fontSize: 12.5 }}>{c.user?.name}</strong>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatDateTime(c.createdAt)}</span>
    </div>
  )
}

function Attachments({ urls }: { urls?: string[] }) {
  if (!urls?.length) return null
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '6px 0' }}>
      {urls.map((u, i) => <a key={i} href={`${FILE_HOST}${u}`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">📎 پیوست {i + 1}</a>)}
    </div>
  )
}

function Composer({ base, parentId, compact, onPosted }: any) {
  const [text, setText] = useState('')
  const [attachmentUrls, setAttachmentUrls] = useState<string[]>([])
  const [showMentions, setShowMentions] = useState(false)
  const [uploading, setUploading] = useState(false)
  const { data: users = [] } = useQuery({ queryKey: ['users-list'], queryFn: () => api.get('/users/list').then((r) => r.data) })

  const post = useMutation({
    mutationFn: () => api.post(base, { text, parentId, attachmentUrls }),
    onSuccess: () => { setText(''); setAttachmentUrls([]); onPosted() },
  })

  const addMention = (u: any) => { setText((t) => t.replace(/@(\w*)$/, '') + `@[${u.name}](${u.id}) `); setShowMentions(false) }
  const onChange = (v: string) => { setText(v); setShowMentions(/@\w*$/.test(v)) }
  const uploadFile = async (file: File) => {
    setUploading(true)
    try { const fd = new FormData(); fd.append('file', file); const r = await api.post('/comments/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); setAttachmentUrls((a) => [...a, r.data.url]) }
    finally { setUploading(false) }
  }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12, position: 'relative' }}>
      <textarea rows={compact ? 2 : 3} placeholder="درج گزارش و یا نظر شما... (با @ به افراد اشاره کنید)" value={text} onChange={(e) => onChange(e.target.value)} style={{ border: 'none', resize: 'vertical', padding: 4 }} />
      {showMentions && users.length > 0 && (
        <div style={{ position: 'absolute', background: '#fff', border: '1px solid var(--border)', borderRadius: 8, boxShadow: 'var(--shadow)', zIndex: 20, maxHeight: 160, overflowY: 'auto', width: 200 }}>
          {users.map((u: any) => <div key={u.id} style={{ padding: 8, cursor: 'pointer', fontSize: 13 }} onMouseDown={(e) => e.preventDefault()} onClick={() => addMention(u)}>{u.name}</div>)}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }}>📎<input type="file" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])} /></label>
        {EMOJIS.map((em) => <button key={em} type="button" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }} onClick={() => setText((t) => t + em)}>{em}</button>)}
        {uploading && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>در حال آپلود...</span>}
        {attachmentUrls.length > 0 && <span style={{ fontSize: 12, color: 'var(--success)' }}>{attachmentUrls.length} پیوست</span>}
        <button className="btn-primary btn-sm" style={{ marginRight: 'auto' }} disabled={(!text.trim() && attachmentUrls.length === 0) || post.isPending} onClick={() => post.mutate()}>ثبت</button>
      </div>
    </div>
  )
}
