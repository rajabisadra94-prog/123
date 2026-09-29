import { useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import api from '../lib/api'
import { toShamsi } from '../lib/date'
import SearchableSelect from '../components/shared/SearchableSelect'
import { Card, SectionHeader, StatCard, Badge, ActionRow, FinanceStat, Dot, PageHeader, TabChips, TableEmpty } from '../components/ui'
import type { Tint } from '../components/ui'

function n(v: any) { return Math.round(Number(v) || 0).toLocaleString() }

const PIPELINE = [
  { key: 'projects', label: 'پروژه‌ها', to: '/projects', icon: '📁' },
  { key: 'pricing', label: 'قیمت‌گیری', to: '/pricing', icon: '🏷️' },
  { key: 'invoicing', label: 'صدور فاکتور', to: '/invoicing', icon: '🧾' },
  { key: 'production', label: 'در حال تولید', to: '/orders', icon: '🏭' },
  { key: 'shipping', label: 'حمل و نقل', to: '/shipping', icon: '🚢' },
  { key: 'completed', label: 'تکمیل شده', to: '/projects', icon: '✅' },
]

// سه کسب‌وکار — نوار تفکیک نوع (کلیک = فیلتر کل داشبورد)
const TYPE_CARDS = [
  { key: 'MANUFACTURING', icon: '🏭', label: 'ساخت قطعه' },
  { key: 'TRADING', icon: '🛒', label: 'خرید کالا' },
  { key: 'FORWARDING', icon: '🚚', label: 'حمل بار' },
]
const TYPE_LABEL: Record<string, string> = { MANUFACTURING: 'ساخت', TRADING: 'خرید', FORWARDING: 'حمل' }

export default function DashboardPage() {
  const [customerId, setCustomerId] = useState('')
  const [producerId, setProducerId] = useState('')
  const [typeFilter, setTypeFilter] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', customerId, producerId, typeFilter],
    queryFn: () => api.get('/dashboard', { params: { customerId: customerId || undefined, producerId: producerId || undefined, type: typeFilter || undefined } }).then((r) => r.data),
  })
  const { data: profit } = useQuery({
    queryKey: ['dashboard-profit', customerId, typeFilter],
    queryFn: () => api.get('/dashboard/profit', { params: { customerId: customerId || undefined, type: typeFilter || undefined } }).then((r) => r.data),
  })
  const { data: customers = [] } = useQuery({ queryKey: ['customers'], queryFn: () => api.get('/settings/customers').then((r) => r.data) })
  const { data: producers = [] } = useQuery({ queryKey: ['producers'], queryFn: () => api.get('/settings/producers').then((r) => r.data) })

  if (isLoading || !data) {
    return (
      <div className="page" dir="rtl">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[88px] rounded-2xl bg-surface border border-line animate-pulse" />
          ))}
        </div>
        <div className="mt-6 h-28 rounded-2xl bg-surface border border-line animate-pulse" />
        <div className="mt-6 h-64 rounded-2xl bg-surface border border-line animate-pulse" />
      </div>
    )
  }

  const k = data.kpis
  const ac = data.actionCenter
  const actionTotal = ac.stalePricing.length + ac.overdueOrders.length + ac.shipmentsAwaitingSettlement.length
    + (ac.purchasePending?.length || 0) + (ac.cargoAwaitingChina?.length || 0) + (ac.tradingNoInvoice?.length || 0)

  return (
    <div className="page" dir="rtl">
      <PageHeader
        title="داشبورد"
        subtitle="نمای کلی وضعیت سامانه"
        chips={<TabChips value={typeFilter} onChange={setTypeFilter} tabs={[
          { key: '', label: 'همه' },
          ...TYPE_CARDS.map((t) => ({ key: t.key, label: `${t.icon} ${t.label}`, count: data.byType?.[t.key] ?? 0 })),
        ]} />}
      />

      <div className="toolbar" style={{ justifyContent: 'flex-end', marginBottom: 16 }}>
        <SearchableSelect style={{ minWidth: 170 }} value={customerId} onChange={setCustomerId} placeholder="همه مشتریان"
          options={customers.map((c: any) => ({ value: c.id, label: c.name }))} />
        <SearchableSelect style={{ minWidth: 170 }} value={producerId} onChange={setProducerId} placeholder="همه سازندگان"
          options={producers.map((p: any) => ({ value: p.id, label: p.name }))} />
      </div>

      {/* KPI CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <StatCard value={n(k.activeProjects)} label="پروژه‌های فعال" icon="📁" tint="brand" to="/projects" />
        <StatCard value={n(k.ordersInProduction)} label="سفارش در حال تولید" icon="🏭" tint="warning" to="/orders" />
        <StatCard value={n(k.readyForInvoice)} label="منتظر صدور فاکتور" icon="🧾" tint="violet" to="/invoicing" />
        <StatCard value={n(k.pendingInvoices)} label="منتظر تأیید مشتری" icon="⏳" tint="info" to="/invoicing" />
        <StatCard value={n(k.shipmentsInTransit)} label="محموله در حال حمل" icon="🚢" tint="mint" to="/shipping" />
        <StatCard value={n(k.totalReceivableIRR)} label="طلب از مشتریان (تومان)" icon="💰" tint="success" />
      </div>

      {/* FINANCE SNAPSHOT + LIVE RATES */}
      {data.finance && (
        <Card className="p-5 mt-6">
          <div className="flex flex-wrap items-stretch justify-between gap-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 flex-1 min-w-[280px]">
              <FinanceStat label="نقدینگی شرکت" value={n(data.finance.cashIRR)} color="#15919b" />
              <FinanceStat label="طلب از مشتریان" value={n(data.finance.receivableIRR)} color="#2563eb" />
              <FinanceStat label="بدهی به طرف‌حساب‌ها" value={n(data.finance.payableIRR)} color="#e52329" />
              <FinanceStat label="خالص دارایی" value={n(data.finance.netIRR)} color="#0f5569" />
            </div>
            <div className="flex gap-2 items-center">
              <RateChip label="دلار" flag="💵" value={n(data.finance.rates.usd)} />
              <RateChip label="یوآن" flag="🇨🇳" value={n(data.finance.rates.cny)} />
              {data.finance.rates.stale && (
                <div className="self-center"><Badge tint="danger">⚠ نرخ قدیمی</Badge></div>
              )}
            </div>
          </div>
        </Card>
      )}

      <CrmWidget />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        {/* MY TASKS */}
        {data.myTasks && (data.myTasks.overdue.length > 0 || data.myTasks.today.length > 0) ? (
          <Card className="p-5">
            <SectionHeader
              icon="📋"
              title="وظایف من"
              badge={<span className="text-xs text-muted font-normal">({data.myTasks.totalOpen} باز)</span>}
            />
            {data.myTasks.overdue.length > 0 && (
              <Group title={`عقب‌مانده (${data.myTasks.overdue.length})`} tint="danger">
                {data.myTasks.overdue.map((t: any) => (
                  <ActionRow key={t.id} to="/tasks" tint="danger">
                    ⏰ {t.title}{t.project ? ` — پروژه ${t.project}` : ''}
                    <span className="text-muted text-[11px]"> (مهلت {toShamsi(t.dueAt)})</span>
                  </ActionRow>
                ))}
              </Group>
            )}
            {data.myTasks.today.length > 0 && (
              <Group title={`امروز (${data.myTasks.today.length})`} tint="info">
                {data.myTasks.today.map((t: any) => (
                  <ActionRow key={t.id} to="/tasks" tint="info">
                    📌 {t.title}{t.project ? ` — پروژه ${t.project}` : ''}
                  </ActionRow>
                ))}
              </Group>
            )}
          </Card>
        ) : (
          <Card className="p-5 flex flex-col items-center justify-center text-center min-h-[180px]">
            <div className="w-14 h-14 rounded-2xl bg-success-soft text-success grid place-items-center text-3xl mb-3">✓</div>
            <div className="font-bold text-ink">هیچ وظیفهٔ سررسیدشده‌ای نداری</div>
            <div className="text-sm text-muted mt-1">همه‌چیز به‌روز است</div>
          </Card>
        )}

        {/* ACTION CENTER */}
        <Card className="p-5">
          <SectionHeader
            icon="⚡"
            title="مرکز اقدام"
            badge={actionTotal > 0 ? <Badge tint="danger" soft={false}>{actionTotal}</Badge> : undefined}
          />
          {actionTotal === 0 && (
            <div className="flex items-center gap-2 text-sm text-muted py-6 justify-center">
              <Dot tint="success" /> موردی نیازمند اقدام فوری نیست
            </div>
          )}
          {ac.stalePricing.length > 0 && (
            <Group title="قیمت‌های معطل‌مانده (بیش از ۳ روز)" tint="warning">
              {ac.stalePricing.map((p: any) => (
                <ActionRow key={p.id} to="/pricing" tint="warning">پروژه {p.code} — {p.customer} <span className="text-muted text-[11px]">(از {toShamsi(p.createdAt)})</span></ActionRow>
              ))}
            </Group>
          )}
          {ac.overdueOrders.length > 0 && (
            <Group title="سفارش‌های تولید تأخیرخورده" tint="danger">
              {ac.overdueOrders.map((o: any) => (
                <ActionRow key={o.id} to="/orders" tint="danger">{o.code} — {o.producer} <span className="text-muted text-[11px]">(مهلت: {o.estimatedEndDate ? toShamsi(o.estimatedEndDate) : '-'})</span></ActionRow>
              ))}
            </Group>
          )}
          {ac.shipmentsAwaitingSettlement.length > 0 && (
            <Group title="محموله‌های آمادهٔ تسویه" tint="violet">
              {ac.shipmentsAwaitingSettlement.map((s: any) => (
                <ActionRow key={s.id} to="/shipping" tint="violet">{s.code} — {s.carrier}</ActionRow>
              ))}
            </Group>
          )}
          {ac.purchasePending?.length > 0 && (
            <Group title="سفارش‌های خرید معطلِ پرداخت" tint="warning">
              {ac.purchasePending.map((o: any) => (
                <ActionRow key={o.id} to="/orders" tint="warning">{o.code} — {o.supplier} <span className="text-muted text-[11px]">({o.stage})</span></ActionRow>
              ))}
            </Group>
          )}
          {ac.cargoAwaitingChina?.length > 0 && (
            <Group title="بار امانی منتظر رسیدن به انبار چین" tint="info">
              {ac.cargoAwaitingChina.map((c: any) => (
                <ActionRow key={c.id} to="/orders" tint="info">پروژه {c.project} — {c.customer} <span className="text-muted text-[11px]">(از {toShamsi(c.createdAt)})</span></ActionRow>
              ))}
            </Group>
          )}
          {ac.tradingNoInvoice?.length > 0 && (
            <Group title="خرید انجام‌شده بدون فاکتور مشتری" tint="danger">
              {ac.tradingNoInvoice.map((p: any) => (
                <ActionRow key={p.id} to="/invoicing" tint="danger">پروژه {p.code} — {p.customer}</ActionRow>
              ))}
            </Group>
          )}
        </Card>
      </div>

      {/* PIPELINE */}
      <Card className="p-5 mt-6">
        <SectionHeader icon="🔀" title="نمای کلی جریان کار" />
        <div className="flex flex-wrap items-stretch gap-2.5">
          {PIPELINE.map((stage, i) => (
            <div key={stage.key} className="flex items-stretch gap-2.5 flex-1 min-w-[130px]">
              <Link
                to={stage.to}
                className="group no-underline flex-1 rounded-xl border border-line bg-surface-2 p-4 text-center transition hover:border-brand-300 hover:bg-brand-50 hover:-translate-y-0.5"
              >
                <div className="text-xl mb-1">{stage.icon}</div>
                <div className="text-2xl font-extrabold text-brand-800 tabular-nums leading-none">{data.pipeline[stage.key]}</div>
                <div className="text-xs text-muted mt-1.5">{stage.label}</div>
              </Link>
              {i < PIPELINE.length - 1 && (
                <div className="hidden xl:flex items-center text-line-strong font-bold select-none">←</div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* PROFIT REPORT — فاز ۷: سود per-type + per-project (معادل تومان) */}
      {profit && (
        <Card className="p-5 mt-6">
          <SectionHeader icon="📈" title="گزارش سود (معادل تومان)" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
            {TYPE_CARDS.map((t) => {
              const v = profit.perType?.[t.key] || { revenue: 0, cost: 0, profit: 0 }
              return (
                <div key={t.key} className="rounded-xl border border-line bg-surface-2 p-4">
                  <div className="text-[12px] text-muted">{t.icon} سود {t.label}</div>
                  <div className={`text-xl font-extrabold tabular-nums mt-1 ${v.profit >= 0 ? 'text-success' : 'text-danger'}`}>{n(v.profit)}</div>
                  <div className="text-[11px] text-muted mt-0.5">فروش {n(v.revenue)} − هزینه {n(v.cost)}</div>
                </div>
              )
            })}
          </div>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead><tr><th>پروژه</th><th>نوع</th><th>مشتری</th><th>درآمد</th><th>هزینه</th><th>سود</th></tr></thead>
              <tbody>
                {profit.perProject?.map((p: any) => (
                  <tr key={p.id}>
                    <td className="code-text">{p.code}</td>
                    <td>{TYPE_LABEL[p.type] || p.type}</td>
                    <td>{p.customer}</td>
                    <td className="tabular-nums">{n(p.revenue)}</td>
                    <td className="tabular-nums">{n(p.cost)}</td>
                    <td className="tabular-nums font-bold" style={{ color: p.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{n(p.profit)}</td>
                  </tr>
                ))}
                {(!profit.perProject || profit.perProject.length === 0) && <TableEmpty colSpan={6}>داده‌ای برای گزارش سود نیست</TableEmpty>}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

function RateChip({ label, flag, value }: { label: string; flag: string; value: string }) {
  return (
    <div className="rounded-xl bg-brand-50 border border-brand-100 px-4 py-2.5 text-center min-w-[92px]">
      <div className="text-[11px] text-brand-700/70 mb-0.5">{flag} {label}</div>
      <div className="text-[15px] font-extrabold text-brand tabular-nums leading-none">{value}</div>
    </div>
  )
}

function CrmWidget() {
  const { data: a } = useQuery({ queryKey: ['crm-analytics'], queryFn: () => api.get('/crm/analytics').then((r) => r.data).catch(() => null) })
  const { data: f } = useQuery({ queryKey: ['crm-followups'], queryFn: () => api.get('/crm/follow-ups').then((r) => r.data).catch(() => null) })
  if (!a) return null
  const overdue = f?.overdue?.length || 0
  const today = f?.today?.length || 0
  const fmt = (v: number) => (v ? Number(v).toLocaleString('en-US') + ' ت' : '۰')
  const Stat = ({ val, label, color, to }: { val: ReactNode; label: string; color?: string; to?: string }) => {
    const inner = <><div style={{ fontSize: 20, fontWeight: 800, color: color || 'var(--text)' }}>{val}</div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div></>
    return to ? <Link to={to} style={{ textAlign: 'center', textDecoration: 'none' }}>{inner}</Link> : <div style={{ textAlign: 'center' }}>{inner}</div>
  }
  return (
    <Card className="p-5 mt-6">
      <SectionHeader icon="🤝" title="فروش و سرنخ‌ها (CRM)" action={<Link to="/crm" style={{ fontSize: 12, color: 'var(--brand)', textDecoration: 'none' }}>مشاهدهٔ CRM ›</Link>} />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
        <Stat val={a.total} label="کل سرنخ" color="var(--brand)" />
        <Stat val={`${a.conversionRate}%`} label="نرخ تبدیل" color="var(--success)" />
        <Stat val={overdue} label="پیگیری عقب‌افتاده" color={overdue ? 'var(--danger)' : undefined} to="/crm" />
        <Stat val={today} label="پیگیری امروز" color={today ? 'var(--warning)' : undefined} to="/crm" />
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 12 }}>ارزش قیف باز: <strong style={{ color: 'var(--text)' }}>{fmt(a.openValue)}</strong></div>
    </Card>
  )
}

function Group({ title, tint, children }: { title: string; tint: Tint; children: ReactNode }) {
  const colors: Record<string, string> = {
    danger: 'text-danger', info: 'text-info', warning: 'text-warning', violet: 'text-violet', brand: 'text-brand', success: 'text-success', mint: 'text-brand', accent: 'text-accent',
  }
  return (
    <div className="mt-3 first:mt-0">
      <h3 className={`text-[12px] font-bold mb-1.5 ${colors[tint]}`}>{title}</h3>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  )
}
