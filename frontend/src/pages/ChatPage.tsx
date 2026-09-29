import { useState, useRef, useEffect, useCallback, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { API_ORIGIN, fileUrl } from '../lib/api'
import { useAuthStore } from '../store/authStore'
import { EmptyState, Loading } from '../components/ui'
import { dialog, toast } from '../components/ui/dialog'

const PAGE = 50
const isImage = (mime?: string | null) => !!mime && mime.startsWith('image/')
const humanSize = (n?: number | null) =>
  !n ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

/** لینک دانلودِ پیوست — از مسیری می‌رود که فایل را با نام اصلی برمی‌گرداند */
const downloadUrl = (msgId: string) =>
  `${API_ORIGIN}/api/messages/${msgId}/attachment?token=${encodeURIComponent(localStorage.getItem('token') || '')}`

/** ساعت پیام (برای نمایش داخل حباب) */
const clockOf = (d: string) => new Date(d).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })

/** برچسب روز برای جداکنندهٔ تاریخ: امروز / دیروز / تاریخ شمسی */
function dayLabel(d: string) {
  const date = new Date(d)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const that = new Date(date); that.setHours(0, 0, 0, 0)
  const diff = Math.round((today.getTime() - that.getTime()) / 86400000)
  if (diff === 0) return 'امروز'
  if (diff === 1) return 'دیروز'
  return date.toLocaleDateString('fa-IR', { weekday: 'long', day: 'numeric', month: 'long' })
}
const sameDay = (a: string, b: string) =>
  new Date(a).toDateString() === new Date(b).toDateString()

type Msg = any

export default function ChatPage() {
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.user)
  const [activeUser, setActiveUser] = useState<any>(null)
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [msgSearch, setMsgSearch] = useState('')
  const [replyTo, setReplyTo] = useState<Msg | null>(null)
  const [editing, setEditing] = useState<Msg | null>(null)
  const [peerTyping, setPeerTyping] = useState(false)
  // وضعیت آپلود جاری: نام/حجم فایل + درصد پیشرفت (null = آپلودی در جریان نیست)
  const [uploading, setUploading] = useState<{ name: string; size: number; percent: number } | null>(null)
  const [older, setOlder] = useState<Msg[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const typingTimer = useRef<number | undefined>(undefined)
  const lastTypingSent = useRef(0)

  const { data: conversations = [], isLoading: convLoading } = useQuery({
    queryKey: ['conversations'],
    // SSE به‌روزرسانی را می‌رساند؛ این فقط یک تورِ ایمنی با فاصلهٔ زیاد است
    queryFn: () => api.get('/messages/conversations').then((r) => r.data),
    refetchInterval: 120000,
  })

  const { data: threadData, isLoading: threadLoading } = useQuery({
    queryKey: ['thread', activeUser?.id],
    queryFn: () => api.get(`/messages/thread/${activeUser.id}?limit=${PAGE}`).then((r) => r.data),
    enabled: !!activeUser,
  })

  const thread: Msg[] = [...older, ...(threadData?.messages || [])]

  useEffect(() => { setOlder([]) }, [activeUser?.id])
  useEffect(() => { if (threadData) setHasMore(!!threadData.hasMore) }, [threadData])

  /* ── جریان زنده (SSE) — جایگزین پولینگ هر ۸ ثانیه ── */
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) return
    const es = new EventSource(`${API_ORIGIN}/api/messages/stream?token=${encodeURIComponent(token)}`)

    es.onmessage = (e) => {
      let ev: any
      try { ev = JSON.parse(e.data) } catch { return }

      if (ev.type === 'message' || ev.type === 'message-updated') {
        const m = ev.message
        const peer = m.fromUserId === me?.id ? m.toUserId : m.fromUserId
        qc.setQueryData(['thread', peer], (old: any) => {
          if (!old) return old
          const exists = old.messages.some((x: Msg) => x.id === m.id)
          return {
            ...old,
            messages: exists ? old.messages.map((x: Msg) => (x.id === m.id ? m : x)) : [...old.messages, m],
          }
        })
        qc.invalidateQueries({ queryKey: ['conversations'] })
        qc.invalidateQueries({ queryKey: ['chat-unread'] })
      }

      if (ev.type === 'read') {
        qc.setQueryData(['thread', ev.by], (old: any) =>
          old ? { ...old, messages: old.messages.map((m: Msg) => (m.toUserId === ev.by ? { ...m, isRead: true } : m)) } : old)
      }

      if (ev.type === 'typing') {
        setPeerTyping(true)
        window.clearTimeout(typingTimer.current)
        typingTimer.current = window.setTimeout(() => setPeerTyping(false), 3000)
      }

      if (ev.type === 'unread-changed') qc.invalidateQueries({ queryKey: ['chat-unread'] })
    }

    return () => { es.close(); window.clearTimeout(typingTimer.current) }
  }, [qc, me?.id])

  /* ── ارسال ── */
  const send = useMutation({
    mutationFn: (extra: any = {}) => api.post('/messages', {
      toUserId: activeUser.id, text, replyToId: replyTo?.id, ...extra,
    }),
    onSuccess: () => {
      setText(''); setReplyTo(null)
      qc.invalidateQueries({ queryKey: ['thread', activeUser.id] })
      qc.invalidateQueries({ queryKey: ['conversations'] })
    },
    onError: (e: any) => toast.error(e.response?.data?.message || 'ارسال پیام ناموفق بود'),
  })

  const saveEdit = useMutation({
    mutationFn: ({ id, text }: any) => api.patch(`/messages/${id}`, { text }),
    onSuccess: () => { setEditing(null); setText(''); qc.invalidateQueries({ queryKey: ['thread', activeUser.id] }) },
    onError: (e: any) => toast.error(e.response?.data?.message || 'ویرایش ناموفق بود'),
  })

  const removeMsg = useMutation({
    mutationFn: (id: string) => api.delete(`/messages/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['thread', activeUser.id] }); qc.invalidateQueries({ queryKey: ['conversations'] }) },
    onError: (e: any) => toast.error(e.response?.data?.message || 'حذف ناموفق بود'),
  })

  const sendFile = async (file: File) => {
    setUploading({ name: file.name, size: file.size, percent: 0 })
    try {
      const fd = new FormData(); fd.append('file', file)
      const r = await api.post('/messages/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        // درصد واقعی آپلود — تا کاربر بداند کجای کار است
        onUploadProgress: (e) => {
          const pct = e.total ? Math.round((e.loaded * 100) / e.total) : 0
          setUploading((u) => (u ? { ...u, percent: pct } : u))
        },
      })
      await send.mutateAsync({
        attachmentUrl: r.data.url, attachmentName: r.data.name,
        attachmentMime: r.data.mime, attachmentSize: r.data.size,
      })
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'بارگذاری فایل ناموفق بود')
    } finally { setUploading(null) }
  }

  const notifyTyping = useCallback(() => {
    if (!activeUser) return
    const now = Date.now()
    if (now - lastTypingSent.current < 2000) return   // حداکثر هر ۲ ثانیه یک بار
    lastTypingSent.current = now
    api.post(`/messages/typing/${activeUser.id}`).catch(() => {})
  }, [activeUser])

  const loadOlder = async () => {
    const first = thread[0]
    if (!first || loadingOlder) return
    setLoadingOlder(true)
    const box = scrollRef.current
    const prevH = box?.scrollHeight || 0
    try {
      const r = await api.get(`/messages/thread/${activeUser.id}?limit=${PAGE}&before=${first.id}`)
      setOlder((o) => [...r.data.messages, ...o])
      setHasMore(!!r.data.hasMore)
      requestAnimationFrame(() => { if (box) box.scrollTop = box.scrollHeight - prevH })
    } catch { toast.error('بارگذاری پیام‌های قدیمی‌تر ناموفق بود') }
    finally { setLoadingOlder(false) }
  }

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [threadData])
  useEffect(() => { setReplyTo(null); setEditing(null); setPeerTyping(false); setMsgSearch(''); setText('') }, [activeUser?.id])

  const filteredConvs = conversations.filter((c: any) => !search || c.user.name.toLowerCase().includes(search.toLowerCase()))
  const searching = msgSearch.trim().length >= 2
  const shown = searching ? thread.filter((m) => (m.text || '').toLowerCase().includes(msgSearch.toLowerCase())) : thread
  const totalUnread = conversations.reduce((s: number, c: any) => s + c.unread, 0)

  const submit = () => {
    if (!text.trim()) return
    if (editing) saveEdit.mutate({ id: editing.id, text })
    else send.mutate({})
  }

  return (
    <div className={`page chat-page ${activeUser ? 'has-active' : ''}`} dir="rtl">
      {/* بدون سربرگ صفحه — مثل پیام‌رسان‌ها عنوان داخل خودِ فهرست است تا تمام ارتفاع به پیام‌ها برسد */}
      <div className="chat-grid">
        {/* ── فهرست مکالمات ── */}
        <aside className="chat-list">
          <div className="chat-list-head">
            <div className="chat-list-title">
              <strong>گفتگو</strong>
              {totalUnread > 0 && <span className="conv-badge">{totalUnread}</span>}
            </div>
            <input className="search-input" placeholder="جستجوی همکار…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="chat-list-body">
            {convLoading ? <Loading /> : filteredConvs.map((c: any) => (
              <button key={c.user.id} onClick={() => setActiveUser(c.user)}
                className={`conv-item ${activeUser?.id === c.user.id ? 'is-active' : ''}`}>
                <Avatar name={c.user.name} url={c.user.avatarUrl} />
                <span className="conv-text">
                  <span className="conv-top">
                    <strong>{c.user.name}</strong>
                    {c.lastMessage && <span className="conv-time">{clockOf(c.lastMessage.createdAt)}</span>}
                  </span>
                  <span className="conv-bottom">
                    <span className="conv-last">
                      {c.lastMessage
                        ? <>
                            {c.lastMessage.fromUserId === me?.id && <span className="muted">شما: </span>}
                            {c.lastMessage.hasAttachment && !c.lastMessage.text ? '📎 پیوست' : c.lastMessage.text}
                          </>
                        : <span className="muted">شروع گفتگو</span>}
                    </span>
                    {c.unread > 0 && <span className="conv-badge">{c.unread}</span>}
                  </span>
                </span>
              </button>
            ))}
            {!convLoading && filteredConvs.length === 0 && <p className="hint" style={{ padding: 16 }}>همکاری یافت نشد</p>}
          </div>
        </aside>

        {/* ── رشتهٔ گفتگو ── */}
        <section className="chat-thread">
          {!activeUser ? (
            <EmptyState icon="💬" title="یک همکار را انتخاب کنید">برای شروع گفتگو، از فهرست کنار یک نفر را انتخاب کنید.</EmptyState>
          ) : (
            <>
              <header className="chat-head">
                <button className="chat-back" onClick={() => setActiveUser(null)} aria-label="بازگشت به فهرست">‹</button>
                <Avatar name={activeUser.name} url={activeUser.avatarUrl} />
                <div className="chat-head-text">
                  <strong>{activeUser.name}</strong>
                  {peerTyping && <span className="typing">در حال نوشتن…</span>}
                </div>
                <input className="search-input chat-msg-search" placeholder="جستجو در این گفتگو…"
                  value={msgSearch} onChange={(e) => setMsgSearch(e.target.value)} />
              </header>

              <div className="chat-body" ref={scrollRef}>
                {threadLoading ? <Loading /> : (
                  <>
                    {hasMore && !searching && (
                      <div className="chat-more">
                        <button className="btn-secondary btn-sm" disabled={loadingOlder} onClick={loadOlder}>
                          {loadingOlder ? 'در حال بارگذاری…' : '↑ پیام‌های قدیمی‌تر'}
                        </button>
                      </div>
                    )}
                    {searching && (
                      <div className="chat-more"><span className="hint">{shown.length} نتیجه در پیام‌های بارگذاری‌شده</span></div>
                    )}
                    {shown.map((m, i) => {
                      const prev = shown[i - 1]
                      const mine = m.fromUserId === me?.id
                      // جداکنندهٔ روز + گروه‌بندی پیام‌های پشت‌سرهمِ یک نفر
                      const showDay = !prev || !sameDay(prev.createdAt, m.createdAt)
                      const grouped = !!prev && !showDay && prev.fromUserId === m.fromUserId
                      return (
                      <Fragment key={m.id}>
                      {showDay && <div className="chat-day"><span>{dayLabel(m.createdAt)}</span></div>}
                      <Bubble m={m} mine={mine} thread={thread} grouped={grouped}
                        onReply={() => { setReplyTo(m); setEditing(null) }}
                        onEdit={() => { setEditing(m); setText(m.text); setReplyTo(null) }}
                        onDelete={async () => {
                          if (await dialog.confirm({ title: 'این پیام حذف شود؟', message: 'برای طرف مقابل هم «پیام حذف شد» نمایش داده می‌شود.', confirmLabel: 'حذف', tone: 'danger' }))
                            removeMsg.mutate(m.id)
                        }} />
                      </Fragment>
                      )
                    })}
                    {thread.length === 0 && <p className="hint" style={{ textAlign: 'center', marginTop: 24 }}>پیامی رد و بدل نشده. اولین پیام را بفرستید.</p>}
                    <div ref={bottomRef} />
                  </>
                )}
              </div>

              {(replyTo || editing) && (
                <div className="chat-context">
                  <span className="chat-context-label">{editing ? '✏️ ویرایش پیام' : '↩ پاسخ به'}</span>
                  <span className="chat-context-text">{(editing || replyTo)?.text || '📎 پیوست'}</span>
                  <button className="icon-btn" aria-label="انصراف"
                    onClick={() => { setReplyTo(null); setEditing(null); setText('') }}>✕</button>
                </div>
              )}

              {/* پیشرفت آپلود — نام، حجم و درصد واقعی */}
              {uploading && (
                <div className="upload-bar">
                  <span className="upload-icon">📄</span>
                  <span className="upload-meta">
                    <span className="upload-name">{uploading.name}</span>
                    <span className="upload-sub">{humanSize(uploading.size)} · در حال بارگذاری… {uploading.percent}٪</span>
                    <span className="upload-track"><i style={{ width: `${uploading.percent}%` }} /></span>
                  </span>
                  <span className="upload-pct">{uploading.percent}٪</span>
                </div>
              )}

              <footer className="chat-input">
                <label className={`icon-btn chat-attach ${uploading ? 'is-busy' : ''}`} title="پیوست فایل">
                  📎
                  <input type="file" hidden disabled={!!uploading}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) sendFile(f); e.target.value = '' }} />
                </label>
                <input placeholder={uploading ? 'در حال بارگذاری فایل…' : 'پیام خود را بنویسید…'}
                  value={text}
                  onChange={(e) => { setText(e.target.value); notifyTyping() }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }} />
                <button className="btn-primary" disabled={!text.trim() || send.isPending || saveEdit.isPending} onClick={submit}>
                  {editing ? 'ذخیره' : 'ارسال'}
                </button>
              </footer>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function Bubble({ m, mine, thread, grouped, onReply, onEdit, onDelete }: any) {
  const deleted = !!m.deletedAt
  const canEdit = mine && !deleted && Date.now() - new Date(m.createdAt).getTime() < 15 * 60 * 1000
  const quoted = m.replyToId ? thread.find((x: Msg) => x.id === m.replyToId) || m.replyTo : null

  return (
    <div className={`bubble-row ${mine ? 'is-mine' : ''} ${grouped ? 'is-grouped' : ''}`}>
      <div className={`bubble ${mine ? 'is-mine' : ''} ${deleted ? 'is-deleted' : ''}`}>
        {quoted && (
          <div className="bubble-quote">
            <span className="bubble-quote-bar" />
            <span>{quoted.deletedAt ? 'پیام حذف شد' : (quoted.text || '📎 پیوست')}</span>
          </div>
        )}

        {deleted ? <em>پیام حذف شد</em> : (
          <>
            {m.text && <div className="bubble-text">{m.text}</div>}
            {m.attachmentUrl && (
              isImage(m.attachmentMime) ? (
                <a href={fileUrl(m.attachmentUrl)} target="_blank" rel="noreferrer" className="bubble-image">
                  <img src={fileUrl(m.attachmentUrl)} alt={m.attachmentName || 'تصویر'} loading="lazy" />
                </a>
              ) : (
                /* از مسیر اختصاصی دانلود می‌رود تا فایل با «نام اصلی» ذخیره شود
                   (صفت download برای آدرس cross-origin نادیده گرفته می‌شود) */
                <a href={downloadUrl(m.id)} className="bubble-file">
                  <span className="bubble-file-icon">📄</span>
                  <span className="bubble-file-meta">
                    <span className="bubble-file-name">{m.attachmentName || 'فایل پیوست'}</span>
                    {m.attachmentSize ? <span className="bubble-file-size">{humanSize(m.attachmentSize)}</span> : null}
                  </span>
                  <span className="bubble-file-dl" title="دانلود">⤓</span>
                </a>
              )
            )}
          </>
        )}

        {/* ساعت و تیک داخل حباب (مثل پیام‌رسان‌ها) — نه یک خط جدا زیر آن */}
        <span className="bubble-stamp">
          {m.editedAt && <span className="bubble-edited">ویرایش‌شده</span>}
          <span className="bubble-time">{clockOf(m.createdAt)}</span>
          {mine && !deleted && <span className={`bubble-tick ${m.isRead ? 'is-read' : ''}`}>{m.isRead ? '✓✓' : '✓'}</span>}
        </span>

        {!deleted && (
          <div className="bubble-actions">
            <button onClick={onReply} title="پاسخ">↩</button>
            {canEdit && <button onClick={onEdit} title="ویرایش">✏️</button>}
            {mine && <button onClick={onDelete} title="حذف">🗑</button>}
          </div>
        )}
      </div>
    </div>
  )
}

function Avatar({ name, url }: { name: string; url?: string }) {
  if (url) return <img className="chat-avatar" src={fileUrl(url)} alt={name} />
  return <div className="chat-avatar is-fallback">{name?.[0] || '؟'}</div>
}
