import type { ReactNode, CSSProperties } from 'react'
import { Link } from 'react-router-dom'

/* ============================================================
   FABRIK UI — کامپوننت‌های پایهٔ مدرن (Tailwind)
   طراحی هماهنگ با توکن‌های برند: petrol / mint / red
   ============================================================ */

type Tint = 'brand' | 'mint' | 'info' | 'violet' | 'success' | 'warning' | 'danger' | 'accent'

const TINT_CHIP: Record<Tint, string> = {
  brand: 'bg-brand-50 text-brand',
  mint: 'bg-mint-soft text-brand',
  info: 'bg-info-soft text-info',
  violet: 'bg-violet-soft text-violet',
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  accent: 'bg-accent-soft text-accent',
}

const TINT_DOT: Record<Tint, string> = {
  brand: 'bg-brand',
  mint: 'bg-mint',
  info: 'bg-info',
  violet: 'bg-violet',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  accent: 'bg-accent',
}

/* کارت سطح‌بندی‌شده (surface card) */
export function Card({ children, className = '', as }: { children: ReactNode; className?: string; as?: 'section' | 'div' }) {
  const Comp: any = as || 'div'
  return <Comp className={`brand-card bg-surface border border-line rounded-lg shadow-md ${className}`}>{children}</Comp>
}

/* سربرگ بخش داخل کارت */
export function SectionHeader({ icon, title, badge, action }: { icon?: ReactNode; title: ReactNode; badge?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <h2 className="flex items-center gap-2 text-[15px] font-bold text-brand-800">
        {icon && <span className="text-lg leading-none">{icon}</span>}
        {title}
        {badge != null && badge}
      </h2>
      {action}
    </div>
  )
}

/* کارت KPI مدرن با چیپ آیکون */
export function StatCard({ value, label, icon, tint = 'brand', to }: { value: ReactNode; label: string; icon: ReactNode; tint?: Tint; to?: string }) {
  const inner = (
    <>
      <div className={`w-12 h-12 rounded-lg grid place-items-center text-2xl shrink-0 ${TINT_CHIP[tint]}`}>{icon}</div>
      <div className="min-w-0">
        <div className="text-[26px] font-extrabold text-ink leading-none tabular-nums">{value}</div>
        <div className="mt-1.5 text-[13px] text-muted truncate">{label}</div>
      </div>
    </>
  )
  const cls = 'brand-stat-card group no-underline flex items-center gap-4 bg-surface border border-line rounded-lg shadow-md p-5 transition duration-200 hover:shadow-lg hover:-translate-y-0.5 hover:border-line-strong'
  return to ? <Link to={to} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>
}

/* برچسب کوچک (pill) */
export function Badge({ children, tint = 'brand', soft = true }: { children: ReactNode; tint?: Tint; soft?: boolean }) {
  const base = 'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold leading-5'
  return <span className={`${base} ${soft ? TINT_CHIP[tint] : `${TINT_DOT[tint]} text-white`}`}>{children}</span>
}

/* نقطهٔ رنگی وضعیت */
export function Dot({ tint = 'brand' }: { tint?: Tint }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${TINT_DOT[tint]}`} />
}

/* ردیف اقدام قابل‌کلیک */
export function ActionRow({ to, tint = 'brand', children }: { to: string; tint?: Tint; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="brand-action-row group no-underline flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg bg-surface-2 border border-transparent text-[13px] text-ink transition hover:bg-brand-50 hover:border-brand-100"
    >
      <Dot tint={tint} />
      <span className="min-w-0 flex-1">{children}</span>
      <span className="text-muted text-xs opacity-0 group-hover:opacity-100">←</span>
    </Link>
  )
}

/* بلوک آماری مالی */
export function FinanceStat({ label, value, unit = 'تومان', color }: { label: string; value: ReactNode; unit?: string; color?: string }) {
  return (
    <div className="rounded-lg bg-surface-2 border border-line px-4 py-3">
      <div className="text-[11px] text-muted mb-1">{label}</div>
      <div className="text-[17px] font-extrabold tabular-nums leading-none" style={color ? { color } as CSSProperties : undefined}>
        {value} <span className="text-[11px] font-normal text-muted">{unit}</span>
      </div>
    </div>
  )
}

/* سربرگ صفحه — نوار فرمان پترول با عنوان/زیرعنوان/اقدام‌ها + ردیف چیپ اختیاری (یکنواخت در همهٔ صفحات)
   `filter` یک جایگاهِ اختصاصیِ ثابت در بالا-چپ دارد و همیشه بیرونی‌ترین عنصر است،
   تا جای دکمهٔ فیلتر در هیچ صفحه‌ای با تعداد یا نوعِ اقدام‌های آن صفحه جابه‌جا نشود. */
export function PageHeader({ title, subtitle, actions, filter, chips }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; filter?: ReactNode; chips?: ReactNode }) {
  return (
    <div className="cmd-band">
      <div className="cmd-band-top">
        <div className="cmd-heading">
          <h1 className="cmd-title">{title}</h1>
          {subtitle && <p className="cmd-subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="cmd-actions">{actions}</div>}
        {filter && <div className="cmd-filter">{filter}</div>}
      </div>
      {chips && <div className="cmd-chips">{chips}</div>}
    </div>
  )
}

/* گروه چیپ فیلتر شمارشی — برای ردیف چیپ روی نوار فرمان */
export function TabChips<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { key: T; label: ReactNode; count?: number }[] }) {
  return (
    <>
      {tabs.map((t) => (
        <button key={t.key} type="button" className={`band-chip ${value === t.key ? 'active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count != null && <span className="n">{t.count}</span>}
        </button>
      ))}
    </>
  )
}

/* دکمهٔ فیلتر جمع‌شونده — روی نوار فرمان، با نشانگر تعداد فیلتر فعال */
export function FilterToggle({ open, onToggle, count, label = 'فیلتر' }: { open: boolean; onToggle: () => void; count?: number; label?: string }) {
  return (
    <button type="button" onClick={onToggle} className={`band-chip ${open ? 'active' : ''}`}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16M7 12h10M10 19h4" /></svg>
      {label}
      {!!count && <span className="band-badge">{count}</span>}
    </button>
  )
}

/* حالت خالی هماهنگ */
export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon && <div className="es-icon">{icon}</div>}
      <h4>{title}</h4>
      {children && <p>{children}</p>}
    </div>
  )
}

/* بارگذاری هماهنگ */
export function Loading({ label = 'در حال بارگذاری…' }: { label?: string }) {
  return <div className="loading-wrap"><div className="spinner" /><span>{label}</span></div>
}

/* ردیف «چیزی نیست» داخل جدول — یکنواخت در همهٔ جدول‌ها */
export function TableEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return <tr><td colSpan={colSpan} className="table-empty">{children}</td></tr>
}

/* بارگذاری داخل مودال — وقتی خودِ مودال منتظر داده است */
export function ModalLoading({ label }: { label?: string }) {
  return (
    <div className="modal-overlay">
      <div className="modal dialog-modal" dir="rtl"><Loading label={label} /></div>
    </div>
  )
}

/* آلرت درون‌صفحه‌ای */
export function Alert({ tint = 'info', children }: { tint?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode }) {
  return <div className={`alert alert-${tint}`}>{children}</div>
}

export { TINT_CHIP, TINT_DOT }
export type { Tint }
