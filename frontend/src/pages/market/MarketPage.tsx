import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../../lib/api'
import { PageHeader } from '../../components/ui'
import Icon, { type IconName } from '../../components/ui/Icon'
import { usePermission } from '../../lib/permissions'
import ContactsTable from './ContactsTable'
import FollowUps from './FollowUps'
import Promises from './Promises'
import ProductMatrix from './ProductMatrix'
import Analytics from './Analytics'
import MarketSettings from './MarketSettings'
import ContactWorkspace from './ContactWorkspace'
import ImportWizard from './ImportWizard'
import ContactFormModal from './ContactFormModal'

export type MarketFilters = Record<string, string>

type View = 'contacts' | 'followups' | 'promises' | 'matrix' | 'analytics' | 'settings'

/**
 * فقط دو تبِ سطح‌اول: کارِ روزمره (مخاطبین) و تنظیمات.
 * چهار نمای گزارشی زیر یک دکمهٔ «سایر گزارشات» جمع شدند، چون هیچ‌کدام صفِ
 * کارِ روزانه نیستند و کنار «مخاطبین» فقط نوار بالا را شلوغ می‌کردند.
 */
const TABS: { key: View; label: string; icon: IconName }[] = [
  { key: 'contacts', label: 'مخاطبین', icon: 'contacts' },
  { key: 'settings', label: 'تنظیمات', icon: 'settings' },
]

const REPORT_TABS: { key: View; label: string; icon: IconName }[] = [
  { key: 'followups', label: 'پیگیری‌ها', icon: 'alarm' },
  { key: 'promises', label: 'تعهد ارسال', icon: 'package' },
  { key: 'matrix', label: 'ماتریس محصول', icon: 'grid' },
  { key: 'analytics', label: 'گزارش', icon: 'chart' },
]

export default function MarketPage() {
  const [view, setView] = useState<View>('contacts')
  const [filters, setFilters] = useState<MarketFilters>({})
  const [detailId, setDetailId] = useState<string | null>(null)
  // ترتیب همان لیستی که کاربر روی آن کلیک کرده — تا داخل پروندهٔ مخاطب بشود
  // «بعدی/قبلی» زد و پشت‌سرهم کار کرد، بدون حالت جداگانه برای تماس
  const [navIds, setNavIds] = useState<string[]>([])
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [reportsOpen, setReportsOpen] = useState(false)

  const openContact = (id: string, ids: string[] = []) => { setNavIds(ids); setDetailId(id) }

  const canCreate = usePermission('market', 'create')

  // شمارشگرهای روی چیپ‌ها — تا بدون باز کردن تب بفهمی چیزی معلق مانده یا نه
  const { data: followUps } = useQuery({
    queryKey: ['market-followups'],
    queryFn: () => api.get('/market/contacts/follow-ups').then((r) => r.data),
    staleTime: 60_000,
  })
  const { data: promises } = useQuery({
    queryKey: ['market-promises'],
    queryFn: () => api.get('/market/promises').then((r) => r.data),
    staleTime: 60_000,
  })

  const dueCount = (followUps?.overdue?.length || 0) + (followUps?.today?.length || 0)
  const promiseCount = (promises?.overdue?.length || 0) + (promises?.today?.length || 0)

  const reportsInView = REPORT_TABS.some((t) => t.key === view)
  // مجموع کارهای معلق — روی دکمهٔ بستهٔ «سایر گزارشات» تا معلوم باشد داخلش چیزی هست
  const pendingCount = dueCount + promiseCount

  /** از «پوشش شهرها»ی گزارش به لیست مخاطبین همان شهر پرش می‌کند */
  const openCity = (patch: MarketFilters) => { setFilters(patch); setView('contacts') }

  return (
    <div className="page" dir="rtl">
      <PageHeader
        title={`بازار صادرات — عراق`}
        subtitle="مخاطبین، نظرشان دربارهٔ هر محصول، صحبت‌ها، پیگیری‌ها و تعهدهای ارسال"
        actions={canCreate ? (
          <>
            <button className="btn-secondary" onClick={() => setShowImport(true)}><Icon name="upload" /> ورود از اکسل</button>
            <button className="btn-primary" onClick={() => setShowCreate(true)}><Icon name="plus" /> مخاطب جدید</button>
          </>
        ) : undefined}
        chips={[
          ...TABS.map((t) => (
            <button key={t.key} className={`band-chip ${view === t.key ? 'active' : ''}`} onClick={() => setView(t.key)}
              aria-current={view === t.key ? 'page' : undefined}>
              <Icon name={t.icon} />{t.label}
            </button>
          )),
          /* «سایر گزارشات» — بازشونده. وقتی یکی از نماهای گزارشی باز است خودِ
             دکمه فعال می‌شود تا کاربر گم نشود که کجاست. */
          <div key="reports" className="mk-reports">
            <button className={`band-chip ${reportsInView ? 'active' : ''}`}
              onClick={() => setReportsOpen((o) => !o)} aria-expanded={reportsOpen}>
              <Icon name="chart" />
              {reportsInView ? REPORT_TABS.find((t) => t.key === view)!.label : 'سایر گزارشات'}
              {!reportsInView && pendingCount > 0 && <span className="band-badge">{pendingCount}</span>}
              <Icon name="chevron-left" size={14} style={{ transform: reportsOpen ? 'rotate(90deg)' : 'rotate(-90deg)', transition: 'transform .15s ease' }} />
            </button>
            {reportsOpen && (
              <>
                <div className="mk-reports-scrim" onClick={() => setReportsOpen(false)} />
                <div className="mk-reports-menu" role="menu">
                  {REPORT_TABS.map((t) => (
                    <button key={t.key} role="menuitem" className={view === t.key ? 'active' : ''}
                      onClick={() => { setView(t.key); setReportsOpen(false) }}>
                      <Icon name={t.icon} />
                      <span>{t.label}</span>
                      {t.key === 'followups' && dueCount > 0 && <b>{dueCount}</b>}
                      {t.key === 'promises' && promiseCount > 0 && <b>{promiseCount}</b>}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>,
        ]}
      />

      {view === 'contacts' && <ContactsTable filters={filters} setFilters={setFilters} onOpen={openContact} />}
      {view === 'followups' && <FollowUps onOpen={openContact} />}
      {view === 'promises' && <Promises onOpen={openContact} />}
      {view === 'matrix' && <ProductMatrix onOpen={openContact} />}
      {view === 'analytics' && <Analytics onOpenCity={openCity} />}
      {view === 'settings' && <MarketSettings />}

      {detailId && (
        <ContactWorkspace id={detailId} navIds={navIds} onNavigate={setDetailId} onClose={() => setDetailId(null)} />
      )}
      {showCreate && <ContactFormModal onClose={() => setShowCreate(false)} onCreated={(id) => openContact(id)} />}
      {showImport && <ImportWizard onClose={() => setShowImport(false)} />}
    </div>
  )
}
