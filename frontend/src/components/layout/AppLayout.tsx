import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Outlet, NavLink, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../../store/authStore'
import api from '../../lib/api'
import { initPushNotifications } from '../../lib/push'
import { IS_MARKET_ONLY, HOME_PATH, BRAND } from '../../lib/appMode'
import NotificationBell from '../shared/NotificationBell'
import UserPanel from '../shared/UserPanel'
import Icon from '../ui/Icon'
import OutboxIndicator from '../OutboxIndicator'

const navGroups: { title: string | null; items: { to: string; label: string; icon: string; module: string | null }[] }[] = [
  {
    title: null,
    items: [{ to: '/dashboard', label: 'داشبورد', icon: 'dashboard', module: null }],
  },
  {
    title: 'فرایند کاری',
    items: [
      { to: '/projects', label: 'پروژه‌ها', icon: 'projects', module: 'projects' },
      { to: '/technical-review', label: 'بازبینی فنی', icon: 'review', module: 'technical' },
      { to: '/pricing', label: 'قیمت‌گیری', icon: 'pricing', module: 'pricing' },
      { to: '/invoicing', label: 'صدور فاکتور', icon: 'invoice', module: 'invoicing' },
      { to: '/orders', label: 'سفارش‌ها', icon: 'orders', module: 'orders' },
      { to: '/shipping', label: 'حمل و نقل', icon: 'shipping', module: 'shipping' },
      // هستهٔ جدید حالا مرجع است (LEDGER_PRIMARY=new). برچسبِ «اعتبارسنجی»
      // برداشته شد چون دیگر یک آزمایش کنارِ سامانه نیست — خودِ سامانه است.
      // قدیمی تا برشِ نهایی می‌ماند ولی صریحاً «قدیمی» نامیده می‌شود تا کسی
      // اشتباهی در آن کار نکند.
      { to: '/ledger', label: 'حسابداری', icon: 'accounting', module: 'accounting' },
      { to: '/accounting', label: 'حسابداری (قدیمی)', icon: 'accounting', module: 'accounting' },
    ],
  },
  {
    title: 'همکاری',
    items: [
      { to: '/crm', label: 'CRM (سرنخ‌ها)', icon: 'crm', module: 'crm' },
      { to: '/market', label: 'بازار صادرات', icon: 'market', module: 'market' },
      { to: '/tasks', label: 'وظایف', icon: 'tasks', module: null },
      { to: '/notes', label: 'یادداشت‌های من', icon: 'notes', module: null },
      { to: '/chat', label: 'گفتگو', icon: 'chat', module: null },
      { to: '/feedback', label: 'بازخورد / ثبت باگ', icon: 'feedback', module: null },
    ],
  },
  {
    title: 'سیستم',
    items: [
      { to: '/vendors', label: 'بانک طرف‌های تأمین', icon: 'vendors', module: 'settings' },
      { to: '/archive', label: 'بایگانی', icon: 'archive', module: 'archive' },
      { to: '/settings', label: 'تنظیمات', icon: 'settings', module: 'settings' },
      { to: '/audit-log', label: 'تاریخچه', icon: 'history', module: 'settings' },
    ],
  },
]

export default function AppLayout() {
  const { user } = useAuthStore()
  useEffect(() => { initPushNotifications() }, [])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === '1')
  const toggleCollapse = () => setCollapsed((c) => { localStorage.setItem('sidebarCollapsed', c ? '0' : '1'); return !c })

  const { data: matrix } = useQuery({
    queryKey: ['role-permissions'],
    queryFn: () => api.get('/settings/config/ROLE_PERMISSIONS').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
  })

  const { data: chatUnread } = useQuery({
    queryKey: ['chat-unread'],
    queryFn: () => api.get('/messages/unread-count').then((r) => r.data.count).catch(() => 0),
    refetchInterval: 20000,
    enabled: !IS_MARKET_ONLY,
  })

  const canView = (mod: string | null) => {
    if (!mod) return true
    // در حالت «فقط بازار» تنها آیتم منو همین است؛ اگر پنهانش کنیم کاربر یک
    // نوار کناریِ خالی می‌بیند و فکر می‌کند برنامه خراب است. دسترسی واقعی را
    // خودِ API اعمال می‌کند (۴۰۳ روی نوشتن).
    if (IS_MARKET_ONLY && mod === 'market') return true
    if (user?.role === 'SUPER_ADMIN') return true
    if (!matrix || !Object.keys(matrix).length) return true
    return !!matrix?.[user!.role]?.[mod]?.view
  }

  return (
    <div className={`app-layout ${sidebarOpen ? 'sidebar-open' : ''} ${collapsed ? 'sidebar-collapsed' : ''}`} dir="rtl">
      <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      <aside className="sidebar">
        <div className="sidebar-header">
          <Link to={HOME_PATH} className="brand-lockup" aria-label="خانه" onClick={() => setSidebarOpen(false)}>
            <img className="brand-logo-full" src={BRAND.lockup} alt={BRAND.name} />
            <img className="brand-logo-mark" src={BRAND.mark} alt={BRAND.name} />
          </Link>
          <button className="sidebar-collapse" onClick={toggleCollapse} title="جمع / باز کردن نوار کناری" aria-label="جمع یا باز کردن منو">{collapsed ? '»' : '«'}</button>
        </div>
        <nav className="sidebar-nav">
          {navGroups.map((group, gi) => {
            // حالت «فقط بازار»: تنها آیتم بازار می‌ماند، بی‌عنوانِ گروه
            const source = IS_MARKET_ONLY ? group.items.filter((i) => i.to === '/market') : group.items
            const items = source.filter((i) => canView(i.module))
            if (items.length === 0) return null
            return (
              <div key={gi} style={{ marginBottom: 6 }}>
                {group.title && !IS_MARKET_ONLY && <div className="nav-group-title">{group.title}</div>}
                {items.map((item) => (
                  <NavLink key={item.to} to={item.to} title={item.label} onClick={() => setSidebarOpen(false)} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                    <span className="nav-icon"><NavGlyph name={item.icon} /></span>
                    <span>{item.label}</span>
                    {item.to === '/chat' && chatUnread > 0 && (
                      <span style={{ marginRight: 'auto', background: 'var(--accent)', color: '#fff', fontSize: 10, fontWeight: 700, minWidth: 18, height: 18, borderRadius: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}>{chatUnread}</span>
                    )}
                  </NavLink>
                ))}
              </div>
            )
          })}
        </nav>
        <VersionBadge />
      </aside>
      <main className="main-content">
        <div className="topbar">
          <button className="hamburger" onClick={() => setSidebarOpen(true)} aria-label="باز کردن منو"><Icon name="list" size={20} /></button>
          <div className="topbar-actions">
            <NotificationBell />
            <UserPanel />
          </div>
        </div>
        <Outlet />
      </main>
      {/* بیرونِ <main> و شناور، چون پروندهٔ مخاطب یک لایهٔ تمام‌صفحه است و
          نشانگر باید آن‌جا هم دیده شود */}
      <OutboxIndicator />
    </div>
  )
}

/* نسخهٔ در حال اجرا — تا وقتی باگی گزارش می‌شود معلوم باشد روی چه نسخه‌ای بوده.
   نسخهٔ فرانت موقع بیلد جاسازی می‌شود؛ نسخهٔ سرور از /api/version می‌آید و اگر
   با هم نخوانند (مثلاً بک‌اند به‌روز شده ولی مرورگر نسخهٔ کش‌شده را دارد) هشدار می‌دهد. */
function VersionBadge() {
  const { data: server } = useQuery({
    queryKey: ['app-version'],
    queryFn: () => api.get('/version').then((r) => r.data).catch(() => null),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
  const mismatch = server?.version && server.version !== __APP_VERSION__
  const title = [
    `نسخهٔ رابط: ${__APP_VERSION__}`,
    server?.version ? `نسخهٔ سرور: ${server.version}` : null,
    __APP_COMMIT__ ? `کامیت: ${__APP_COMMIT__}` : null,
    mismatch ? '⚠️ نسخهٔ سرور و مرورگر یکی نیست — صفحه را نوسازی کنید (Ctrl+Shift+R)' : null,
  ].filter(Boolean).join('\n')

  return (
    <div className="version-badge" title={title}>
      <span>v{__APP_VERSION__}</span>
      {mismatch && <span className="version-warn" aria-label="ناهماهنگی نسخه">⚠</span>}
    </div>
  )
}

function NavGlyph({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 20v-6M18 20V9" /></>,
    crm: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    market: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" /></>,
    vendors: <><path d="M3 21h18M4 21V8l8-5 8 5v13" /><path d="M9 21v-6h6v6" /><path d="M9 11h.01M15 11h.01" /></>,
    projects: <><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.5h6.5A2.5 2.5 0 0 1 21 10v8.5A2.5 2.5 0 0 1 18.5 21h-13A2.5 2.5 0 0 1 3 18.5z" /><path d="M3 10h18" /></>,
    review: <><path d="M14 4l6 6-9 9-6-6z" /><path d="M13 5l-2-2-7 7 2 2M5 19l-2 2M3 17l4 4" /></>,
    pricing: <><path d="M20 13l-7 7L3 10V3h7z" /><circle cx="7.5" cy="7.5" r="1" /><path d="M13 10v7M10 13h6" /></>,
    invoice: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
    orders: <><path d="M3 8l9-5 9 5-9 5z" /><path d="M3 8v8l9 5 9-5V8M12 13v8" /></>,
    shipping: <><path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z" /><circle cx="7" cy="18" r="2" /><circle cx="18" cy="18" r="2" /></>,
    accounting: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h3" /></>,
    tasks: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 3v3M16 3v3M8 11l2 2 5-5M8 17h8" /></>,
    notes: <><path d="M5 3h10l4 4v14H5z" /><path d="M15 3v5h5M8 12h8M8 16h6" /></>,
    chat: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 10h8" /></>,
    feedback: <><path d="M12 3l2.2 4.8L19 8.5l-3.5 3.7.8 5.3-4.8-2.7-4.8 2.7.8-5.3L4 8.5l4.8-.7z" /></>,
    archive: <><path d="M3 7h18v14H3zM2 3h20v4H2zM9 12h6" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.1 2.1-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-3v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-2.1-2.1.1-.1A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.5-1H5.3v-3h.2A1.7 1.7 0 0 0 7 10a1.7 1.7 0 0 0-.3-1.9l-.1-.1 2.1-2.1.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5v-.2h3v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.1 2.1-.1.1A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 1.5 1h.2v3h-.2a1.7 1.7 0 0 0-1.5 1z" /></>,
    history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5M4 4v4.5h4.5M12 7v5l3 2" /></>,
  }
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.dashboard}</svg>
}
