import { useState, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import api, { API_ORIGIN } from '../lib/api'
import { toShamsi, formatDateTime } from '../lib/date'
import DateField from '../components/shared/DateField'
import NumberInput from '../components/shared/NumberInput'
import SearchableSelect from '../components/shared/SearchableSelect'
import { TaskReminderButton, CreateTaskModal } from '../components/shared/TaskReminder'
import { TaskDetailModal } from './TasksPage'
import { PageHeader, TabChips, EmptyState, Loading, TableEmpty } from '../components/ui'
import ModalPortal from '../components/ui/ModalPortal'
import { dialog, toast } from '../components/ui/dialog'

const MILESTONE_LABELS: Record<string, string> = {
  CREATED: 'ایجاد شده',
  PRICED_AND_INVOICED: 'قیمت‌گذاری شده',
  ORDER_PLACED: 'سفارش ثبت شده',
  IN_PRODUCTION: 'در حال ساخت',
  QUALITY_CONTROL: 'کنترل کیفیت',
  COMPLETED: 'تکمیل شده',
  IN_TRANSIT: 'در حال حمل',
  DELIVERED: 'تحویل شده',
  ARCHIVED: 'بایگانی',
}

const TECH_STATUS: Record<string, { label: string; color: string; icon: string }> = {
  PENDING: { label: 'در انتظار بازبینی', color: '#f59e0b', icon: '🟡' },
  APPROVED: { label: 'تأیید شده', color: '#22c55e', icon: '🟢' },
  REJECTED: { label: 'رد شده / نیازمند اصلاح', color: '#ef4444', icon: '🔴' },
}

const CURRENCY_LABELS: Record<string, string> = { IRR: 'تومان', USD: 'دلار', CNY: 'یوآن' }

export default function ProjectDetailPage() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [showAddPart, setShowAddPart] = useState(false)
  const [editPart, setEditPart] = useState<any>(null)
  const [showEditProject, setShowEditProject] = useState(false)
  const [showArchive, setShowArchive] = useState(false)
  const [showPricing, setShowPricing] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detailPart, setDetailPart] = useState<any>(null)
  const [redrawPart, setRedrawPart] = useState<any>(null)
  const [view, setView] = useState<'parts' | 'documents' | 'tasks' | 'pnl' | 'timeline' | 'notes' | 'zip'>('parts')

  const { data: project, isLoading } = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.get(`/projects/${id}`).then((r) => r.data),
  })

  const refresh = () => qc.invalidateQueries({ queryKey: ['project', id] })

  const deletePart = useMutation({
    mutationFn: (partId: string) => api.delete(`/projects/${id}/parts/${partId}`),
    onSuccess: refresh,
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا در حذف'),
  })

  const createGroup = useMutation({
    mutationFn: (partIds: string[]) => api.post(`/projects/${id}/groups`, { partIds }),
    onSuccess: () => { setSelected(new Set()); refresh() },
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا'),
  })

  const removeGroup = useMutation({
    mutationFn: (partIds: string[]) => api.delete(`/projects/${id}/groups/remove`, { data: { partIds } }),
    onSuccess: () => { setSelected(new Set()); refresh() },
  })

  // بازگردانی قطعهٔ بایگانی‌شده تا دوباره قابل ارسال برای قیمت‌گیری شود
  const restorePart = useMutation({
    mutationFn: (partId: string) => api.post(`/pricing/parts/${partId}/restore`),
    onSuccess: refresh,
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا در بازگردانی'),
  })

  // تأیید مشخصات کالای خرید (TRADING) — جایگزین بازبینی فنی
  const approveSpec = useMutation({
    mutationFn: (partId: string) => api.post(`/projects/${id}/parts/${partId}/approve-spec`),
    onSuccess: refresh,
    onError: (e: any) => toast.error(e.response?.data?.message || 'خطا در تأیید مشخصات'),
  })

  const activeParts = useMemo(
    () => (project?.parts || []).filter((p: any) => !p.archivedAt),
    [project],
  )

  const totalWeight = useMemo(
    () => activeParts.reduce((s: number, p: any) => s + (p.quantity || 0) * (p.weightGrams || 0), 0),
    [activeParts],
  )

  if (isLoading) return <div className="page" dir="rtl"><Loading /></div>
  if (!project) return <div className="page" dir="rtl"><p>پروژه یافت نشد</p></div>

  // Selecting a part auto-selects its whole correlation group
  function toggleSelect(part: any) {
    const next = new Set(selected)
    const groupMembers = part.groupId
      ? project.parts.filter((p: any) => p.groupId === part.groupId).map((p: any) => p.id)
      : [part.id]
    const isSel = next.has(part.id)
    groupMembers.forEach((pid: string) => (isSel ? next.delete(pid) : next.add(pid)))
    setSelected(next)
  }

  const selectedParts = project.parts.filter((p: any) => selected.has(p.id))
  const canCreatePricing =
    selectedParts.length > 0 && selectedParts.every((p: any) => p.technicalStatus === 'APPROVED')
  const selectedInGroups = selectedParts.some((p: any) => p.groupId)

  // پروژهٔ خرید کالای آماده — واژگان و فرم «کالا» به‌جای «قطعه/نقشه»
  const isTrading = project.type === 'TRADING'
  const isForwarding = project.type === 'FORWARDING'
  const itemWord = isTrading ? 'کالا' : 'قطعه'

  return (
    <div className="page" dir="rtl">
      <PageHeader
        title={project.code}
        subtitle={project.customer.name}
        actions={<>
          <span className="band-chip" style={{ cursor: 'default' }}>{project.progress}% پیشرفت</span>
          <TaskReminderButton title={`پیگیری پروژه ${project.code}`} projectId={id} entityType="Project" entityId={id} />
          <button className="btn-secondary btn-sm" onClick={() => setShowEditProject(true)}>✎ ویرایش</button>
          <button className="btn-secondary btn-sm" onClick={() => setShowArchive(true)}>🗄 بایگانی</button>
        </>}
        chips={<TabChips value={view} onChange={setView} tabs={[
          { key: 'parts', label: isTrading ? 'کالاها و جریان کار' : 'قطعات و جریان کار' },
          { key: 'tasks', label: '✅ وظایف' },
          { key: 'pnl', label: '📊 گزارش مالی' },
          { key: 'timeline', label: '🕐 ردپای مراحل' },
          { key: 'notes', label: '📝 یادداشت‌ها' },
          { key: 'documents', label: '📁 اسناد پروژه' },
          ...(!isTrading && !isForwarding ? [{ key: 'zip' as const, label: '📦 فایل فشرده' }] : []),
        ]} />}
      />

      {/* SF5 — نمایش دلیل بایگانی/رد پروژه */}
      {project.status === 'ARCHIVED' && (
        <div style={{ background: 'var(--danger-soft)', border: '1px solid var(--danger-soft)', borderRadius: 'var(--radius)', padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
          <strong style={{ color: 'var(--danger)' }}>🗄 این پروژه بایگانی شده است</strong>
          {project.archivedReason && <span> — دلیل: {({ PROJECT_COMPLETED: 'پروژه با موفقیت تکمیل شد', PRICE_REJECTED_BY_CUSTOMER: 'قیمت توسط مشتری رد شد', TECHNICAL_ISSUES: 'مشکلات فنی در تولید', CUSTOMER_CANCELLED: 'لغو توسط مشتری', OTHER: 'دلایل دیگر' } as Record<string, string>)[project.archivedReason] || project.archivedReason}</span>}
          {project.archivedAt && <span className="muted"> — {toShamsi(project.archivedAt)}</span>}
        </div>
      )}

      {view === 'tasks' && <ProjectTasksTab projectId={id!} />}
      {view === 'pnl' && <PnlTab projectId={id!} />}
      {view === 'timeline' && <TimelineTab projectId={id!} />}
      {view === 'notes' && <NotesTab projectId={id!} />}
      {view === 'documents' && <DocumentsTab projectId={id!} projectCode={project.code} />}
      {view === 'zip' && <ZipTab project={project} />}

      {view === 'parts' && (
      <div className="project-detail-grid">
        <div className="project-info-card">
          <h3>اطلاعات پروژه</h3>
          <p>تاریخ ایجاد: {toShamsi(project.createdAt)}</p>
          {project.needDate && <p>تاریخ نیاز مشتری: {toShamsi(project.needDate)}</p>}
          {project.description && <p>توضیحات: {project.description}</p>}
          <hr style={{ margin: '12px 0', border: 'none', borderTop: '1px solid var(--border)' }} />
          <p><strong>مجموع وزن خالص:</strong> {totalWeight.toLocaleString()} گرم</p>
          <p><strong>تعداد قطعات فعال:</strong> {activeParts.length}</p>
          <p><strong>تعداد گروه‌های همبستگی:</strong> {project.partGroups?.length || 0}</p>

          <CommissionShippingPanel project={project} totalWeightGrams={totalWeight} onSaved={refresh} />
        </div>

        <div className="parts-section">
          <div className="section-header">
            <h3>{isTrading ? 'کالاها' : 'قطعات'} ({project.parts.length})</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              {selected.size >= 2 && (
                <button className="btn-secondary btn-sm" onClick={() => createGroup.mutate([...selected])}>
                  ⛓ ایجاد گروه همبستگی
                </button>
              )}
              {selectedInGroups && (
                <button className="btn-secondary btn-sm" onClick={() => removeGroup.mutate([...selected])}>
                  ✂ خارج کردن از گروه‌بندی
                </button>
              )}
              <button className="btn-primary btn-sm" onClick={() => setShowAddPart(true)}>+ افزودن {itemWord}</button>
            </div>
          </div>

          <div className="table-container" style={{ overflowX: 'auto' }}>
          <table className="parts-table">
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th>نام {itemWord}</th>
                <th>تعداد</th>
                <th>وزن (گرم)</th>
                <th>{isTrading ? 'واحد / رنگ' : 'جنس / پوشش'}</th>
                <th>قیمت تارگت</th>
                <th>{isTrading ? 'تأیید مشخصات' : 'وضعیت فنی'}</th>
                <th>مرحله</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {project.parts.map((part: any) => {
                const tech = TECH_STATUS[part.technicalStatus] || TECH_STATUS.PENDING
                const group = project.partGroups?.find((g: any) => g.id === part.groupId)
                return (
                  <tr
                    key={part.id}
                    className={part.archivedAt ? 'row-archived' : ''}
                    style={group ? { background: group.color } : undefined}
                  >
                    <td>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={selected.has(part.id)}
                        onChange={() => toggleSelect(part)}
                        disabled={!!part.archivedAt}
                      />
                    </td>
                    <td>
                      <a style={{ cursor: 'pointer', color: 'var(--primary)' }} onClick={() => setDetailPart(part)}
                        title="نمایش تاریخچهٔ کامل قطعه شامل تأیید/رد بازبینی فنی">
                        {part.name}
                      </a>
                      {/* بدون opacity/filter: هر کدام یک stacking context می‌سازند و روی
                          مودال‌های باز می‌افتند (ریشهٔ اصلی در ModalPortal توضیح داده شده). */}
                      <button type="button" onClick={() => setDetailPart(part)} title="تاریخچه و بازبینی فنی این قطعه"
                        style={{ marginRight: 6, border: 'none', background: 'none', cursor: 'pointer', fontSize: 13 }}>🕐</button>
                    </td>
                    <td>{part.quantity}</td>
                    <td>{part.weightGrams || '-'}</td>
                    <td style={{ fontSize: 12 }}>
                      {isTrading
                        ? `${part.unit || '-'} / ${part.color || '-'}`
                        : `${part.material?.name || '-'} / ${part.coating?.name || '-'}`}
                    </td>
                    <td>
                      {part.targetAmount
                        ? `${Number(part.targetAmount).toLocaleString()} ${CURRENCY_LABELS[part.targetCurrency] || ''}`
                        : '-'}
                    </td>
                    <td>
                      <span style={{ color: tech.color, fontWeight: 600, fontSize: 12 }}>
                        {tech.icon} {isTrading && part.technicalStatus === 'PENDING' ? 'در انتظار تأیید مشخصات' : tech.label}
                      </span>
                      {part.technicalStatus === 'REJECTED' && part.technicalReview?.rejectReason && (
                        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4, maxWidth: 200 }}>
                          دلیل رد: {part.technicalReview.rejectReason}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {part.milestone === 'CREATED' && !part.archivedAt
                        ? <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 100, background: 'var(--warning-soft)', color: '#92400e', fontSize: 11, fontWeight: 600 }} title="هنوز برای قیمت‌گیری ارسال نشده">⚠ ارسال‌نشده به قیمت‌گیری</span>
                        : (MILESTONE_LABELS[part.milestone] || part.milestone)}
                    </td>
                    <td>
                      {part.archivedAt ? (
                        <button className="btn-secondary btn-sm" title={`بازگردانی از بایگانی و امکان ارسال دوبارهٔ آن برای قیمت‌گیری${part.archivedReason ? ` — دلیل بایگانی: ${part.archivedReason}` : ''}`} onClick={async () => { if (await dialog.confirm({ title: 'بازگردانی از بایگانی؟', message: 'این قطعه دوباره قابل ارسال برای قیمت‌گیری می‌شود.', confirmLabel: 'بازگردانی' })) restorePart.mutate(part.id) }}>♻️ بازگردانی</button>
                      ) : !['ORDER_PLACED', 'IN_PRODUCTION', 'QUALITY_CONTROL', 'COMPLETED', 'IN_TRANSIT', 'DELIVERED'].includes(part.milestone) && (
                        <div style={{ display: 'flex', gap: 4 }}>
                          {isTrading && part.milestone === 'CREATED' && part.technicalStatus !== 'APPROVED' && (
                            <button className="btn-primary btn-sm" disabled={approveSpec.isPending} onClick={async () => { if (await dialog.confirm({ title: `تأیید مشخصات «${part.name}»؟`, message: 'پس از تأیید، این کالا آمادهٔ استعلام قیمت می‌شود.', confirmLabel: 'تأیید مشخصات' })) approveSpec.mutate(part.id) }} title="تأیید مشخصات کالا">✓ تأیید مشخصات</button>
                          )}
                          {!isTrading && part.milestone === 'CREATED' && part.technicalStatus === 'REJECTED' && (
                            <button className="btn-primary btn-sm" onClick={() => setRedrawPart(part)} title="آپلود نقشه اصلاح‌شده و ارسال مجدد به بازبینی">📐 اصلاح نقشه</button>
                          )}
                          <button className="btn-secondary btn-sm" onClick={() => setEditPart(part)} title="ویرایش قطعه">✎</button>
                          <button className="btn-danger btn-sm" title="حذف قطعه" onClick={async () => { if (await dialog.confirm({ title: 'حذف این قطعه؟', message: part.milestone === 'CREATED' ? 'این قطعه هنوز وارد جریان کاری نشده است.' : 'این قطعه برای قیمت‌گیری رفته است؛ با حذف، قیمت‌های واردشده‌اش هم پاک می‌شود.', confirmLabel: 'حذف قطعه', tone: 'danger' })) deletePart.mutate(part.id) }}>🗑</button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
              {project.parts.length === 0 && (
                <TableEmpty colSpan={9}>هنوز قطعه‌ای اضافه نشده است</TableEmpty>
              )}
            </tbody>
          </table>
          </div>

          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="hint-lg">
              {selected.size > 0 && `${selected.size} قطعه انتخاب شده`}
            </span>
            <button
              className="btn-primary"
              disabled={!canCreatePricing}
              title={!canCreatePricing ? 'تمام قطعات انتخابی باید وضعیت «تأیید شده» داشته باشند' : ''}
              onClick={() => setShowPricing(true)}
            >
              💰 ایجاد درخواست قیمت
            </button>
          </div>
        </div>
      </div>
      )}

      {showAddPart && <PartModal projectId={id!} projectType={project.type} onClose={() => setShowAddPart(false)} onSuccess={() => { setShowAddPart(false); refresh() }} />}
      {editPart && <PartModal projectId={id!} projectType={project.type} part={editPart} onClose={() => setEditPart(null)} onSuccess={() => { setEditPart(null); refresh() }} />}
      {showEditProject && <EditProjectModal project={project} onClose={() => setShowEditProject(false)} onSuccess={() => { setShowEditProject(false); refresh() }} />}
      {showArchive && <ArchiveModal projectId={id!} onClose={() => setShowArchive(false)} onSuccess={() => { setShowArchive(false); refresh() }} />}
      {showPricing && <PricingRequestModal projectId={id!} projectType={project.type} parts={selectedParts} onClose={() => setShowPricing(false)} onSuccess={() => { setShowPricing(false); setSelected(new Set()); refresh() }} />}
      {detailPart && <PartDetailDrawer projectId={id!} part={detailPart} onClose={() => setDetailPart(null)} />}
      {redrawPart && <RedrawModal projectId={id!} part={redrawPart} onClose={() => setRedrawPart(null)} onSuccess={() => { setRedrawPart(null); refresh() }} />}
    </div>
  )
}

// ─── COMMISSION & SHIPPING COST PANEL ─────────────────
function CommissionShippingPanel({ project, totalWeightGrams, onSaved }: any) {
  const [open, setOpen] = useState(false)
  const locked = project.status !== 'ACTIVE' && project.status !== 'READY_FOR_INVOICE'

  return (
    <>
      <hr style={{ margin: '12px 0', border: 'none', borderTop: '1px solid var(--border)' }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 13 }}>کمیسیون و هزینه حمل</strong>
        <button className="btn-secondary btn-sm" onClick={() => setOpen(true)} disabled={locked}>مدیریت</button>
      </div>
      <div className="hint" style={{ marginTop: 6  }}>
        {project.commissions?.length ? project.commissions.map((c: any) => `${c.agent.name} (${Number(c.percentage)}%)`).join('، ') : 'کمیسیونی تعریف نشده'}
      </div>
      {project.shippingCost?.ratePerKgAmount && (() => {
        const partKg = totalWeightGrams / 1000
        const effKg = partKg > 0 ? partKg : Number(project.estimatedWeightKg || 0)
        const basis = partKg > 0 ? 'وزن قطعات' : 'وزن تخمینی'
        return (
          <div className="hint" style={{ marginTop: 4  }}>
            نرخ حمل: {Number(project.shippingCost.ratePerKgAmount).toLocaleString()} / کیلوگرم →
            تخمین ({basis} {effKg.toLocaleString()} کیلو): {Math.round(effKg * Number(project.shippingCost.ratePerKgAmount)).toLocaleString()}
          </div>
        )
      })()}
      {open && <CommissionShippingModal project={project} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onSaved() }} />}
    </>
  )
}

function CommissionShippingModal({ project, onClose, onSaved }: any) {
  const [rows, setRows] = useState<any[]>(project.commissions?.map((c: any) => ({ agentId: c.agentId, percentage: Number(c.percentage) })) || [])
  const [shipRate, setShipRate] = useState(project.shippingCost?.ratePerKgAmount || '')
  const [shipCur, setShipCur] = useState(project.shippingCost?.ratePerKgCurrency || 'IRR')
  const [estWeight, setEstWeight] = useState(project.estimatedWeightKg || '')
  const { data: agents = [] } = useQuery({ queryKey: ['commission-agents'], queryFn: () => api.get('/settings/commission-agents').then((r) => r.data) })

  const saveCom = useMutation({ mutationFn: () => api.put(`/projects/${project.id}/commissions`, { commissions: rows }) })
  const saveShip = useMutation({ mutationFn: () => api.put(`/projects/${project.id}/shipping-cost`, { ratePerKgAmount: shipRate || null, ratePerKgCurrency: shipCur, estimatedWeightKg: estWeight || null }) })

  const save = async () => { await saveCom.mutateAsync(); await saveShip.mutateAsync(); onSaved() }

  // portal لازم است: این مودال داخل `.project-info-card` رندر می‌شود که sticky است
  // و stacking context می‌سازد ⇒ بدون portal، z-index مودال داخل همان کارت حبس
  // می‌ماند و آیکون‌های جدول قطعات روی مودال می‌افتند.
  return (
    <ModalPortal>
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>کمیسیون و هزینه حمل</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <h3 style={{ fontSize: 13, marginBottom: 8 }}>کمیسیون‌بگیرها</h3>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <SearchableSelect value={r.agentId} onChange={(v) => { const n = [...rows]; n[i].agentId = v; setRows(n) }} placeholder="انتخاب شخص..." style={{ flex: 1 }}
                options={agents.map((a: any) => ({ value: a.id, label: a.name }))} />
              <input type="number" placeholder="درصد" style={{ width: 90 }} value={r.percentage} onChange={(e) => { const n = [...rows]; n[i].percentage = e.target.value; setRows(n) }} />
              <button className="btn-danger btn-sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button className="btn-secondary btn-sm" onClick={() => setRows([...rows, { agentId: '', percentage: '' }])}>+ افزودن کمیسیون‌بگیر</button>

          <hr style={{ margin: '16px 0', border: 'none', borderTop: '1px solid var(--border)' }} />
          <h3 style={{ fontSize: 13, marginBottom: 8 }}>هزینه حمل (به ازای هر کیلوگرم)</h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <NumberInput placeholder="نرخ هر کیلوگرم" value={shipRate} onChange={setShipRate} decimals style={{ flex: 1 }} />
            <select style={{ width: 110 }} value={shipCur} onChange={(e) => setShipCur(e.target.value)}>
              <option value="IRR">تومان</option><option value="USD">دلار</option><option value="CNY">یوآن</option>
            </select>
          </div>
          <div className="form-group" style={{ marginTop: 12 }}>
            <label>وزن تخمینی کل پروژه (کیلوگرم)</label>
            <NumberInput placeholder="اگر وزن تک‌تک قطعات وارد نشده، کل را اینجا وارد کنید" value={estWeight} onChange={setEstWeight} decimals />
            <span className="hint-sm">وقتی وزن قطعات صفر باشد، برآورد حمل از این عدد محاسبه می‌شود.</span>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" onClick={save}>ذخیره</button>
        </div>
      </div>
    </div>
    </ModalPortal>
  )
}

// ─── PROJECT P&L (FINANCIAL REPORT) TAB ───────────────
function money(v: any) { return Math.round(Number(v) || 0).toLocaleString() + ' تومان' }

function PnlTab({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['project-pnl', projectId],
    queryFn: () => api.get(`/projects/${projectId}/pnl`).then((r) => r.data),
    retry: false,
  })
  if (isLoading) return <p>در حال محاسبه گزارش مالی...</p>
  if (error || !data) return <p className="muted">گزارش مالی هنوز در دسترس نیست (پس از تأیید فاکتور محاسبه می‌شود).</p>

  const fxDiff = data.fx.customerReceiptAvgRate && data.fx.producerPayAvgRate
    ? data.fx.customerReceiptAvgRate - data.fx.producerPayAvgRate : 0

  return (
    <div style={{ maxWidth: 760 }}>
      {/* P&L summary cards */}
      <div className="kpi-grid" style={{ marginBottom: 20 }}>
        <div className="kpi-card" style={{ borderTop: '3px solid var(--success)' }}>
          <div className="kpi-value" style={{ fontSize: 22, color: 'var(--success)' }}>{money(data.revenue)}</div>
          <div className="kpi-label">درآمد (فاکتور مشتری)</div>
        </div>
        <div className="kpi-card" style={{ borderTop: '3px solid var(--danger)' }}>
          <div className="kpi-value" style={{ fontSize: 22, color: 'var(--danger)' }}>{money(data.cogs)}</div>
          <div className="kpi-label">هزینه ساخت (سازنده)</div>
        </div>
        <div className="kpi-card" style={{ borderTop: `3px solid ${data.netProfit >= 0 ? '#2563eb' : '#ef4444'}` }}>
          <div className="kpi-value" style={{ fontSize: 22, color: data.netProfit >= 0 ? '#2563eb' : 'var(--danger)' }}>{money(data.netProfit)}</div>
          <div className="kpi-label">سود خالص</div>
        </div>
      </div>

      {/* P&L breakdown */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 16 }}>
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>صورت سود و زیان</h3>
        <PnlRow label="درآمد فروش به مشتری" value={data.revenue} sign="+" />
        <PnlRow label="هزینه تمام‌شده تولید" value={-data.cogs} sign="−" />
        <PnlRow label="کمیسیون‌ها" value={-data.commission} sign="−" />
        <PnlRow label="هزینه حمل" value={-data.freight} sign="−" />
        <div style={{ borderTop: '2px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
          <PnlRow label="سود خالص پروژه" value={data.netProfit} bold />
        </div>
      </div>

      {/* Customer / Producer balances */}
      <div className="grid-2" style={{ gap: 16, marginBottom: 16 }}>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16 }}>
          <h3 style={{ fontSize: 13, marginBottom: 8 }}>حساب مشتری</h3>
          <PnlRow label="کل مبلغ پروژه" value={data.customer.receivableCreated} small />
          <PnlRow label="دریافت‌شده" value={data.customer.paid} small />
          <PnlRow label="بدهی مانده مشتری" value={data.customer.remaining} small bold />
          {data.customerPayments?.length > 0 && (
            <div style={{ marginTop: 8, borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
              <div className="hint-sm" style={{ marginBottom: 4  }}>واریزی‌های مشتری (به تفکیک):</div>
              {data.customerPayments.map((pay: any, i: number) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 2 }}>
                  <span>{toShamsi(pay.date)}</span>
                  <span style={{ fontWeight: 600 }}>{Number(pay.amount).toLocaleString()} {CURRENCY_LABELS[pay.currency] || pay.currency}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16 }}>
          <h3 style={{ fontSize: 13, marginBottom: 8 }}>حساب سازندگان</h3>
          <PnlRow label="کل تعهد به سازنده" value={data.producer.payable} small />
          <PnlRow label="پرداخت‌شده" value={data.producer.paid} small />
          <PnlRow label="بدهی مانده ما" value={data.producer.remaining} small bold />
          {data.producerBreakdown?.length > 1 && (
            <div style={{ marginTop: 8, borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
              <div className="hint-sm" style={{ marginBottom: 4  }}>تفکیک هر سازنده:</div>
              {data.producerBreakdown.map((p: any) => (
                <div key={p.id} style={{ fontSize: 12, marginBottom: 5 }}>
                  <div style={{ fontWeight: 600 }}>{p.name}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: 11 }}>
                    <span>مانده: {Math.round(p.remaining).toLocaleString()}</span>
                    <span>تعهد {Math.round(p.payable).toLocaleString()} • پرداخت {Math.round(p.paid).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {data.agreement && (
        <div style={{ background: 'var(--warning-soft)', border: '1px solid var(--warning-soft)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 16 }}>
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>توافق صورت‌گرفته (هنگام تأیید فاکتور)</h3>
          <p style={{ fontSize: 13 }}>{data.agreement}</p>
        </div>
      )}

      {/* FX risk analysis */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16 }}>
        <h3 style={{ fontSize: 14, marginBottom: 10 }}>تحلیل ریسک نرخ ارز</h3>
        <PnlRow label="میانگین نرخ دریافت از مشتری" value={data.fx.customerReceiptAvgRate} small suffix=" تومان/واحد" />
        <PnlRow label="میانگین نرخ پرداخت به سازنده" value={data.fx.producerPayAvgRate} small suffix=" تومان/واحد" />
        {fxDiff !== 0 && (
          <p style={{ fontSize: 13, marginTop: 8, color: fxDiff >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            {fxDiff >= 0 ? 'سود' : 'زیان'} ناشی از نوسان نرخ ارز: {Math.abs(fxDiff).toLocaleString()} تومان به ازای هر واحد ارز
          </p>
        )}
        {data.fx.customerReceiptAvgRate === 0 && data.fx.producerPayAvgRate === 0 && (
          <p className="hint">هنوز تراکنش ارزی برای تحلیل ثبت نشده است.</p>
        )}
      </div>
    </div>
  )
}

function PnlRow({ label, value, sign, bold, small, suffix }: any) {
  const color = bold ? (value >= 0 ? 'var(--success)' : 'var(--danger)') : 'inherit'
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: small ? 12 : 13, fontWeight: bold ? 700 : 400 }}>
      <span>{sign} {label}</span>
      <span style={{ color }}>{Math.round(Number(value) || 0).toLocaleString()}{suffix || ' تومان'}</span>
    </div>
  )
}

// ─── PROJECT TIMELINE TAB (ردپای مراحل) ───────────────
const EVENT_LABELS: Record<string, { label: string; icon: string }> = {
  'CREATE_Project': { label: 'ایجاد پروژه', icon: '📁' },
  'CREATE_Part': { label: 'افزودن قطعه', icon: '➕' },
  'UPDATE_TechnicalReview': { label: 'بازبینی فنی', icon: '🔧' },
  'CREATE_PricingRequest': { label: 'ارسال برای قیمت‌گیری', icon: '💰' },
  'UPDATE_PricingRequest': { label: 'نهایی‌سازی قیمت', icon: '✅' },
  'UPDATE_Invoice': { label: 'تأیید فاکتور / صدور', icon: '🧾' },
  'UPDATE_ProductionOrder': { label: 'تغییر وضعیت تولید', icon: '🏭' },
  'CREATE_Transaction': { label: 'تراکنش مالی', icon: '💳' },
  'CREATE_JournalEntry': { label: 'سند مالی', icon: '💳' },
  'UPDATE_Part': { label: 'به‌روزرسانی قطعه', icon: '📐' },
  'CREATE_ProjectFile': { label: 'افزودن سند', icon: '📎' },
  'CREATE_DomesticPackage': { label: 'بستهٔ حمل داخلی', icon: '📦' },
  'CREATE_MainShipment': { label: 'محمولهٔ اصلی', icon: '🚢' },
}

// برچسب رویداد با توجه به نوع رویداد ثبت‌شده در changes
function eventInfo(log: any): { label: string; icon: string } {
  const ce = log.changes?.event
  if (ce === 'TRACKING_NO') return { label: 'ثبت شماره رهگیری', icon: '🔢' }
  if (ce === 'DOMESTIC_PACKAGE') return { label: 'ایجاد بستهٔ حمل داخلی', icon: '📦' }
  if (ce === 'MAIN_SHIPMENT') return { label: 'ایجاد محمولهٔ اصلی', icon: '🚢' }
  return EVENT_LABELS[`${log.action}_${log.entity}`] || { label: `${log.action} ${log.entity}`, icon: '•' }
}

// جزئیات خوانا از روی changes (رفرنس‌ها، کد مرجع، رهگیری و...)
function timelineDetail(ch: any): string {
  if (!ch) return ''
  const parts: string[] = []
  if (ch.code) parts.push(`کد: ${ch.code}`)
  if (ch.referenceNo) parts.push(`رفرنس بسته: ${ch.referenceNo}`)
  if (ch.forwarderRef) parts.push(`کد مرجع فورواردر: ${ch.forwarderRef}`)
  if (ch.trackingNo) parts.push(`شماره رهگیری: ${ch.trackingNo}${ch.order ? ` (سفارش ${ch.order})` : ''}`)
  if (ch.carrier) parts.push(`شرکت حمل: ${ch.carrier}`)
  if (ch.notes) parts.push(`یادداشت: ${ch.notes}`)
  if (ch.status) parts.push(`وضعیت: ${ch.status}`)
  return parts.join(' • ')
}

function TimelineTab({ projectId }: { projectId: string }) {
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['project-timeline-full', projectId],
    queryFn: () => api.get(`/projects/${projectId}/timeline`).then((r) => r.data),
  })
  if (isLoading) return <Loading />

  if (logs.length === 0) return <EmptyState icon="🕐" title="رویدادی ثبت نشده">به‌محض انجام اولین اقدام روی این پروژه، اینجا ثبت می‌شود.</EmptyState>

  return (
    <div className="tl-wrap">
      <div className="tl-head">
        <h3>ردپای مراحل</h3>
        <p>همهٔ رویدادهای پروژه به‌ترتیب زمانی (جدیدترین بالا) — {logs.length} رویداد</p>
      </div>
      <div className="tl-list">
        {logs.map((log: any) => {
          const ev = eventInfo(log)
          const detail = timelineDetail(log.changes)
          return (
            <div key={log.id} className="tl-row">
              <div><span className="tl-dot">{ev.icon}</span></div>
              <div>
                <div className="tl-title">{ev.label}</div>
                <div className="tl-detail">{detail || <span style={{ opacity: .55 }}>—</span>}</div>
              </div>
              <div className="tl-meta">
                <span className="tl-time">{formatDateTime(log.createdAt)}</span>
                <span className="tl-user">{log.user?.name || 'سیستم'}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── N1/N2 — بخش یادداشت‌ها: تجمیع همهٔ یادداشت‌های پروژه از بخش‌های مختلف ──
function NotesTab({ projectId }: { projectId: string }) {
  const [section, setSection] = useState('')
  const [search, setSearch] = useState('')
  const { data: notes = [], isLoading } = useQuery({
    queryKey: ['project-notes', projectId],
    queryFn: () => api.get(`/projects/${projectId}/notes`).then((r) => r.data),
  })
  if (isLoading) return <Loading label="در حال بارگذاری یادداشت‌ها…" />

  const counts: Record<string, number> = {}
  notes.forEach((n: any) => { counts[n.section] = (counts[n.section] || 0) + 1 })
  const sections = Object.keys(counts)
  const filtered = notes.filter((n: any) => {
    if (section && n.section !== section) return false
    if (search) { const s = search.toLowerCase(); return (n.note || '').toLowerCase().includes(s) || (n.place || '').toLowerCase().includes(s) }
    return true
  })

  // لهجهٔ رنگی فقط از پالت برند — چهار حالت، بدون رنگین‌کمان
  const SECTION_TONE: Record<string, string> = {
    'حسابداری': 'is-accent', 'صدور فاکتور': 'is-accent',
    'حمل و نقل': 'is-mint', 'سفارش‌ها': 'is-mint',
    'پروژه‌ها': 'is-deep', 'بازبینی فنی': 'is-deep',
  }

  return (
    <div>
      <div className="tl-head" style={{ borderRadius: 'var(--radius) var(--radius) 0 0', border: '1px solid var(--border)', borderBottom: 'none' }}>
        <h3>یادداشت‌های پروژه</h3>
        <p>همهٔ یادداشت‌های ثبت‌شده در بخش‌های مختلف این پروژه، یکجا — با بخش، محل، تاریخ و نویسنده.</p>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '0 0 var(--radius) var(--radius)', marginBottom: 14 }}>
        <input className="search-input" placeholder="جستجو در یادداشت‌ها..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 240 }} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className={`tab-btn ${section === '' ? 'active' : ''}`} onClick={() => setSection('')}>همه ({notes.length})</button>
          {sections.map((s) => <button key={s} className={`tab-btn ${section === s ? 'active' : ''}`} onClick={() => setSection(s)}>{s} ({counts[s]})</button>)}
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="📝" title="یادداشتی یافت نشد">با تغییر فیلتر یا عبارت جستجو دوباره تلاش کنید.</EmptyState>
      ) : (
        <div className="notes-grid">
          {filtered.map((n: any, i: number) => (
            <div key={i} className={`note-card ${SECTION_TONE[n.section] || ''}`}>
              <div className="note-top">
                <span>
                  <span className="note-section">{n.section}</span>
                  <span className="note-place"> · {n.place}</span>
                </span>
                <span className="note-time">{formatDateTime(n.date)}</span>
              </div>
              <div className="note-body">{n.note}</div>
              {n.user && <div className="note-author">✍ {n.user}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── MODULE 13/14: PROJECT TASKS TAB (each task has its own chat) ──
function ProjectTasksTab({ projectId }: { projectId: string }) {
  const [showCreate, setShowCreate] = useState(false)
  const [openTask, setOpenTask] = useState<string | null>(null)
  const { data: tasks = [] } = useQuery({
    queryKey: ['project-tasks', projectId],
    queryFn: () => api.get('/tasks', { params: { projectId, includeDone: 'true' } }).then((r) => r.data),
  })

  const now = new Date()
  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <p className="hint-lg">وظایف، یادآوری‌ها و گفتگوهای این پروژه</p>
        <button className="btn-primary btn-sm" onClick={() => setShowCreate(true)}>+ وظیفه جدید</button>
      </div>

      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
        {tasks.map((t: any) => {
          const overdue = !t.isDone && t.dueAt && new Date(t.dueAt) < now
          return (
            <div key={t.id} onClick={() => setOpenTask(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)', cursor: 'pointer', opacity: t.isDone ? 0.55 : 1, borderRight: overdue ? '3px solid var(--danger)' : '3px solid transparent' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={t.isDone} readOnly onClick={(e) => e.stopPropagation()} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600, textDecoration: t.isDone ? 'line-through' : 'none' }}>{t.title}</div>
                {t.notes && <div className="hint-sm" style={{ marginTop: 2  }}>{t.notes}</div>}
              </div>
              {t._count?.comments > 0 && <span className="hint-sm">💬 {t._count.comments}</span>}
              {t.dueAt && <span style={{ fontSize: 12, color: overdue ? 'var(--danger)' : 'var(--text-muted)' }}>📅 {toShamsi(t.dueAt)}</span>}
              {t.assignedTo && <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--brand)', color: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }} title={t.assignedTo.name}>{t.assignedTo.name?.[0]}</div>}
            </div>
          )
        })}
        {tasks.length === 0 && <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>هنوز وظیفه‌ای برای این پروژه ثبت نشده است</div>}
      </div>

      {showCreate && <CreateTaskModal projectId={projectId} onClose={() => setShowCreate(false)} />}
      {openTask && <TaskDetailModal taskId={openTask} onClose={() => setOpenTask(null)} />}
    </div>
  )
}

// ─── MODULE 10: PROJECT DOCUMENTS TAB ─────────────────
const DOC_TYPE_LABELS: Record<string, string> = {
  CONTRACT: 'قرارداد', CORRESPONDENCE: 'مکاتبات', POD: 'اثبات تحویل', GENERAL: 'عمومی', ADVANCE_RECEIPT: 'رسید پیش‌پرداخت',
  PART_DOC: 'مدرک قطعه', ORDER_DOC: 'مدرک سفارش', FINANCIAL_DOC: 'مدرک مالی',
  DRAWING_CUSTOMER: 'نقشه مشتری', DRAWING_ENGINEERING: 'نقشه مهندسی', RENDER: 'تصویر/رندر',
  PROFORMA: 'پیش‌فاکتور سازنده', VENDOR_INVOICE: 'اینویس سازنده', QC_REPORT: 'گزارش کیفیت', PACKING_LIST: 'پکینگ لیست',
  MATERIAL_CERT: 'گواهی مواد', PRODUCTION_PHOTO: 'عکس تولید', PACKAGED_PHOTO: 'عکس بسته‌بندی', GENERAL_ORDER: 'سند سفارش',
  FREIGHT_INVOICE: 'فاکتور حمل', BILL_OF_LADING: 'بارنامه', CUSTOMS: 'ترخیص گمرک', FORWARDER_RECEIPT: 'رسید فورواردر', LOADING_PHOTO: 'عکس بارگیری',
}
function docLabel(t: string) { return DOC_TYPE_LABELS[t] || t }

function DocumentsTab({ projectId, projectCode }: { projectId: string; projectCode: string }) {
  const qc = useQueryClient()
  const [uploadType, setUploadType] = useState('GENERAL')
  const [shortDesc, setShortDesc] = useState('')
  const [files, setFiles] = useState<FileList | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['project-documents', projectId],
    queryFn: () => api.get(`/projects/${projectId}/documents`).then((r) => r.data),
  })
  // ۱.۶ — عناوین سفارشی اسناد از تنظیمات
  const { data: customDocTypes = [] } = useQuery({ queryKey: ['doc-types'], queryFn: () => api.get('/settings/config/DOC_TYPES').then((r) => r.data || []) })
  const customMap: Record<string, string> = Object.fromEntries((customDocTypes || []).map((t: any) => [t.value, t.label]))

  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData()
      fd.append('fileType', uploadType)
      if (shortDesc) fd.append('shortDesc', shortDesc)
      if (files) Array.from(files).forEach((f) => fd.append('files', f))
      return api.post(`/projects/${projectId}/files`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    },
    onSuccess: () => { setFiles(null); setShortDesc(''); qc.invalidateQueries({ queryKey: ['project-documents', projectId] }) },
  })

  const del = useMutation({
    mutationFn: (fileId: string) => api.delete(`/projects/${projectId}/files/${fileId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-documents', projectId] }),
  })

  if (isLoading) return <Loading label="در حال بارگذاری اسناد…" />

  const fileRow = (label: string, f: any, canDelete = false) => {
    const name = f.storedName || f.description || 'سند'
    const note = f.storedName ? f.description : null
    return (
      <li key={f.id || f.url} style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12 }}><span className="status-badge status-active" style={{ marginLeft: 6 }}>{label}</span>{name}</div>
          {note && <div className="hint-sm" style={{ marginTop: 2  }}>{note}</div>}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <a href={`${API_ORIGIN}${f.url}`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">دانلود</a>
          {canDelete && f.id && <button className="btn-danger btn-sm" onClick={async () => { if (await dialog.confirm({ title: 'حذف این فایل؟', message: 'فایل از سرور هم پاک می‌شود.', confirmLabel: 'حذف', tone: 'danger' })) del.mutate(f.id) }}>🗑</button>}
        </div>
      </li>
    )
  }

  return (
    <div>
      {/* Upload general project files */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 20 }}>
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>افزودن سند به پروژه</h3>
        <div className="add-form">
          <select value={uploadType} onChange={(e) => setUploadType(e.target.value)} style={{ maxWidth: 180 }}>
            <option value="GENERAL">فایل عمومی</option>
            <option value="CONTRACT">قرارداد / الحاقیه</option>
            <option value="CORRESPONDENCE">مکاتبات / صورت‌جلسه</option>
            <option value="POD">سند اثبات تحویل</option>
            <option value="PART_DOC">نقشه / مدرک قطعه</option>
            <option value="ORDER_DOC">مدرک سفارش / تولید</option>
            <option value="FINANCIAL_DOC">مدرک مالی</option>
            {(customDocTypes || []).map((t: any) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <input placeholder="شرح کوتاه (اختیاری)" value={shortDesc} onChange={(e) => setShortDesc(e.target.value)} style={{ maxWidth: 200 }} />
          <input type="file" multiple onChange={(e) => setFiles(e.target.files)} />
          <button className="btn-primary btn-sm" disabled={!files?.length || upload.isPending} onClick={() => upload.mutate()}>آپلود</button>
        </div>
        <p className="hint-sm" style={{ marginTop: 8  }}>فایل‌ها خودکار با الگوی استاندارد سازمان (مثلاً PRJ-{projectCode}_GEN_..._تاریخ) نام‌گذاری می‌شوند.</p>
      </div>

      <DocSection title="اسناد پروژه" items={data.project} render={(f: any) => fileRow(customMap[f.fileType] || docLabel(f.fileType), f, true)} />
      {/* دو سری نقشهٔ قطعه: (۱) نقشهٔ ارسالیِ مشتری همیشه دیده می‌شود، (۲) نقشهٔ تأییدشدهٔ ساخت.
          نقشه‌های مهندسیِ ردشده/میانی مخفی می‌مانند تا شلوغ نشود. */}
      <DocSection
        title="نقشه‌ها و اسناد قطعات (مشتری + تأییدشدهٔ ساخت)"
        items={(data.parts || []).filter((f: any) => {
          if (f.fileType === 'DRAWING_CUSTOMER') return true // نقشهٔ اولیهٔ مشتری همیشه
          if (f.fileType === 'DRAWING_ENGINEERING') return f.reviewStatus === 'APPROVED' // فقط نقشهٔ مهندسیِ تأییدشده
          return true // سایر اسناد قطعه
        })}
        render={(f: any) => {
          const st = f.reviewStatus ? ({ APPROVED: '🟢 تأییدشده', PENDING: '🟡 در انتظار بازبینی', REJECTED: '🔴 اصلاح‌شده' } as Record<string, string>)[f.reviewStatus] || '' : ''
          const kind = f.fileType === 'DRAWING_CUSTOMER' ? 'نقشهٔ ارسالی مشتری'
            : f.fileType === 'DRAWING_ENGINEERING' ? 'نقشهٔ تأییدشده (ساخت)'
            : docLabel(f.fileType)
          return fileRow(`${kind}${f.partName ? ' — ' + f.partName : ''}${st ? ' · ' + st : ''}`, f, true)
        }}
      />
      <DocSection title="اسناد سفارش و تولید" items={data.orders} render={(f: any) => fileRow(`${docLabel(f.fileType)} — ${f.orderCode} (${f.producer})`, f, false)} />
      {/* ۱۰.۲ — پرفرمای سازندگان در اسناد پروژه */}
      <DocSection title="پرفرمای سازندگان" items={data.proformas || []} render={(f: any) => fileRow(`پرفرما — ${f.producer}`, f, false)} />
      <DocSection title="اسناد مالی (رسیدها)" items={data.financial} render={(f: any) => fileRow('رسید', f, false)} />
      {/* اسناد حمل — یک فاکتور حمل می‌تواند چند پروژه را پوشش دهد؛ اسناد محموله‌های شامل این پروژه اینجا دیده می‌شوند */}
      <DocSection title="اسناد حمل (فاکتور حمل و مدارک محموله)" items={data.freightDocs || []} render={(f: any) => fileRow(`${docLabel(f.fileType)} — محموله ${f.shipmentCode} (${f.carrier})`, f, false)} />

      {data.invoices && data.invoices.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>فاکتورهای مشتری <span className="hint">({data.invoices.length})</span></h3>
          <ul className="simple-list">
            {data.invoices.map((inv: any) => (
              <li key={inv.id} style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12 }}>
                    <span className="status-badge" style={{ marginLeft: 6, background: inv.status === 'APPROVED' ? 'var(--success-soft)' : 'var(--danger-soft)', color: inv.status === 'APPROVED' ? 'var(--success)' : 'var(--danger)' }}>
                      {inv.status === 'APPROVED' ? 'فاکتور فروش (تأییدشده)' : 'ردشده توسط مشتری'}
                    </span>
                    {inv.versionCode}
                  </div>
                  {inv.status === 'REJECTED' && inv.rejectReason && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>دلیل رد: {inv.rejectReason}</div>}
                </div>
                <button className="btn-secondary btn-sm" onClick={() => { const token = localStorage.getItem('token') || ''; window.open(`${API_ORIGIN}/api/invoicing/${inv.id}/print?token=${encodeURIComponent(token)}`, '_blank') }}>مشاهده / چاپ</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function DocSection({ title, items, render }: any) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>{title} <span className="hint">({items.length})</span></h3>
      {items.length === 0
        ? <p className="hint">سندی موجود نیست</p>
        : <ul className="simple-list">{items.map(render)}</ul>}
    </div>
  )
}

// ─── فایل فشرده (ZIP) برای سازنده ───────────
function ZipTab({ project }: any) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [downloading, setDownloading] = useState(false)
  const parts = (project.parts || []).filter((p: any) => !p.archivedAt)
  const toggle = (id: string) => { const n = new Set(selected); n.has(id) ? n.delete(id) : n.add(id); setSelected(n) }
  const approvedCount = (p: any) => (p.files || []).filter((f: any) => (f.fileType === 'DRAWING_CUSTOMER' || f.fileType === 'DRAWING_ENGINEERING') && f.reviewStatus === 'APPROVED').length

  const download = async () => {
    setDownloading(true)
    try {
      const res = await api.post(`/projects/${project.id}/export-zip`, { partIds: [...selected] }, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a'); a.href = url; a.download = `${project.code}-package.zip`; a.click(); URL.revokeObjectURL(url)
    } catch (e: any) {
      const msg = e.response?.data instanceof Blob ? 'خطا در تولید فایل فشرده' : (e.response?.data?.message || 'خطا')
      toast.error(msg)
    } finally { setDownloading(false) }
  }

  return (
    <div>
      <p className="hint-lg" style={{ marginBottom: 12  }}>
        قطعاتی را که می‌خواهید برای یک سازنده بفرستید انتخاب کنید. فایل فشرده شامل <b>نقشه‌های تأییدشدهٔ فنی</b> آن قطعات + یک <b>فایل اکسل</b> (نام قطعه، تعداد، جنس، پوشش — انگلیسی) است. برای هر ترکیب قطعات، فایل جداگانه بگیرید (نام سازنده در فایل نمی‌آید).
      </p>
      <table className="data-table">
        <thead><tr>
          <th><input type="checkbox" checked={parts.length > 0 && selected.size === parts.length} onChange={(e) => setSelected(e.target.checked ? new Set(parts.map((p: any) => p.id)) : new Set())} /></th>
          <th>نام قطعه</th><th>تعداد</th><th>وضعیت فنی</th><th>نقشهٔ تأییدشده</th>
        </tr></thead>
        <tbody>
          {parts.map((p: any) => (
            <tr key={p.id}>
              <td><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} /></td>
              <td>{p.name}</td>
              <td>{p.quantity}</td>
              <td style={{ fontSize: 12 }}>{p.technicalStatus === 'APPROVED' ? '🟢 تأیید' : p.technicalStatus === 'REJECTED' ? '🔴 رد' : '🟡 در انتظار'}</td>
              <td>{approvedCount(p) > 0 ? `${approvedCount(p)} نقشه` : <span className="muted">—</span>}</td>
            </tr>
          ))}
          {parts.length === 0 && <TableEmpty colSpan={5}>قطعه‌ای نیست</TableEmpty>}
        </tbody>
      </table>
      <button className="btn-primary" style={{ marginTop: 12 }} disabled={selected.size === 0 || downloading} onClick={download}>
        {downloading ? 'در حال تولید...' : `📦 دانلود فایل فشرده (${selected.size} قطعه)`}
      </button>
    </div>
  )
}

// ─── REDRAW (revise rejected drawing) MODAL ───────────
// ۲.۸ — هر نقشهٔ ردشده با نسخهٔ اصلاح‌شده «در همان ردیف» جایگزین می‌شود (نه افزودن نقشهٔ جدید)
function RedrawModal({ projectId, part, onClose }: any) {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [done, setDone] = useState<Set<string>>(new Set())
  const rejectedDrawings = (part.files || []).filter((f: any) => (f.fileType === 'DRAWING_CUSTOMER' || f.fileType === 'DRAWING_ENGINEERING') && f.reviewStatus === 'REJECTED')

  const replaceOne = async (fileId: string, file: File) => {
    setError(''); setBusyId(fileId)
    try {
      const fd = new FormData(); fd.append('drawing', file)
      await api.post(`/technical-review/drawing/${fileId}/replace`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
      setDone((d) => new Set(d).add(fileId))
      qc.invalidateQueries({ queryKey: ['project', projectId] })
    } catch (e: any) { setError(e.response?.data?.message || 'خطا') } finally { setBusyId(null) }
  }

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>اصلاح نقشه: {part.name}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <p className="hint" style={{ marginBottom: 12  }}>
            برای هر نقشهٔ ردشده، نسخهٔ اصلاح‌شده را آپلود کنید — <strong>جایگزین همان نقشه</strong> می‌شود و برای بازبینی مجدد به مهندس می‌رود (نقشهٔ جدیدی اضافه نمی‌شود).
          </p>
          {rejectedDrawings.length === 0 && (
            <div style={{ padding: 10, background: 'var(--warning-soft)', border: '1px solid var(--warning-soft)', borderRadius: 'var(--radius-sm)', fontSize: 13 }}>نقشهٔ ردشده‌ای برای این قطعه یافت نشد.</div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rejectedDrawings.map((f: any) => (
              <div key={f.id} style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{f.storedName}</div>
                {f.reviewReason && <div style={{ fontSize: 12, color: 'var(--danger)', marginTop: 2 }}>دلیل رد: {f.reviewReason}</div>}
                <div style={{ marginTop: 8 }}>
                  {done.has(f.id) ? (
                    <span style={{ color: 'var(--success)', fontSize: 13, fontWeight: 600 }}>✓ جایگزین شد — در انتظار بازبینی</span>
                  ) : (
                    <label className="btn-primary btn-sm" style={{ cursor: 'pointer', opacity: busyId === f.id ? 0.6 : 1 }}>
                      {busyId === f.id ? 'در حال آپلود...' : '📐 آپلود نسخهٔ اصلاح‌شده (جایگزین همین نقشه)'}
                      <input type="file" style={{ display: 'none' }} accept=".pdf,.dwg,.step,.stp,.x_t,.zip,.png,.jpg" disabled={busyId === f.id}
                        onChange={(e) => { const file = e.target.files?.[0]; if (file) replaceOne(f.id, file) }} />
                    </label>
                  )}
                </div>
              </div>
            ))}
          </div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">بستن</button>
        </div>
      </div>
    </div>
  )
}

// ─── PART ADD/EDIT MODAL ──────────────────────────────
function PartModal({ projectId, projectType, part, onClose, onSuccess }: any) {
  const isEdit = !!part
  const isTrading = projectType === 'TRADING'
  const itemWord = isTrading ? 'کالا' : 'قطعه'
  const [name, setName] = useState(part?.name || '')
  const [quantity, setQuantity] = useState(part?.quantity || 1)
  const [weightGrams, setWeightGrams] = useState(part?.weightGrams || '')
  const [materialId, setMaterialId] = useState(part?.materialId || '')
  const [coatingId, setCoatingId] = useState(part?.coatingId || '')
  const [targetAmount, setTargetAmount] = useState(part?.targetAmount || '')
  const [targetCurrency, setTargetCurrency] = useState(part?.targetCurrency || 'IRR')
  // ۱.۳ — هر نقشه/عکس در یک باکس تک‌فایل جدا؛ دکمهٔ «افزودن» باکس جدید می‌سازد
  const [drawings, setDrawings] = useState<(File | null)[]>([null])
  // ─── فیلدهای کالای آماده (TRADING) ───
  const [unit, setUnit] = useState(part?.unit || '')
  const [dimensions, setDimensions] = useState(part?.dimensions || '')
  const [color, setColor] = useState(part?.color || '')
  const [description, setDescription] = useState(part?.description || '')
  const [productLinks, setProductLinks] = useState<string[]>(
    Array.isArray(part?.productLinks) && part.productLinks.length ? part.productLinks : [''],
  )
  const [error, setError] = useState('')

  const { data: materials = [] } = useQuery({ queryKey: ['materials'], queryFn: () => api.get('/settings/materials').then((r) => r.data), enabled: !isTrading })
  const { data: coatings = [] } = useQuery({ queryKey: ['coatings'], queryFn: () => api.get('/settings/coatings').then((r) => r.data), enabled: !isTrading })

  const mutation = useMutation({
    mutationFn: async () => {
      const validDrawings = drawings.filter((f): f is File => !!f)
      const cleanLinks = productLinks.map((l) => l.trim()).filter(Boolean)
      // فیلدهای مشترک/کالا برای create و patch
      const commodity = isTrading
        ? { unit, dimensions, color, description, productLinks: JSON.stringify(cleanLinks) }
        : {}
      if (isEdit) {
        await api.patch(`/projects/${projectId}/parts/${part.id}`, {
          name, quantity, weightGrams,
          materialId: isTrading ? undefined : (materialId || undefined),
          coatingId: isTrading ? undefined : (coatingId || undefined),
          targetAmount, targetCurrency, ...commodity,
        })
        // افزودن نقشه/عکس جدید (در صورت انتخاب)
        if (validDrawings.length) {
          const dfd = new FormData()
          validDrawings.forEach((f) => dfd.append('drawings', f))
          await api.post(`/projects/${projectId}/parts/${part.id}/drawings`, dfd, { headers: { 'Content-Type': 'multipart/form-data' } })
        }
        return
      }
      const fd = new FormData()
      fd.append('name', name)
      fd.append('quantity', String(quantity))
      if (weightGrams) fd.append('weightGrams', String(weightGrams))
      if (!isTrading && materialId) fd.append('materialId', materialId)
      if (!isTrading && coatingId) fd.append('coatingId', coatingId)
      if (targetAmount) { fd.append('targetAmount', String(targetAmount)); fd.append('targetCurrency', targetCurrency) }
      if (isTrading) {
        if (unit) fd.append('unit', unit)
        if (dimensions) fd.append('dimensions', dimensions)
        if (color) fd.append('color', color)
        if (description) fd.append('description', description)
        if (cleanLinks.length) fd.append('productLinks', JSON.stringify(cleanLinks))
      }
      validDrawings.forEach((f) => fd.append('drawings', f))
      return api.post(`/projects/${projectId}/parts`, fd, { headers: { 'Content-Type': 'multipart/form-data' } })
    },
    onSuccess,
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header">
          <h2>{isEdit ? `ویرایش ${itemWord}` : `افزودن ${itemWord}`}</h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>نام {itemWord} *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label>تعداد *</label>
              <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
            </div>
            <div className="form-group">
              <label>وزن واحد (گرم)</label>
              <NumberInput value={weightGrams} onChange={setWeightGrams} decimals />
            </div>
          </div>

          {isTrading ? (
            <>
              <div className="grid-2">
                <div className="form-group">
                  <label>واحد شمارش</label>
                  <SearchableSelect value={unit} onChange={setUnit} placeholder="انتخاب..."
                    options={['عدد', 'کارتن', 'کیلوگرم', 'متر', 'جفت', 'بسته', 'رول'].map((u) => ({ value: u, label: u }))} />
                </div>
                <div className="form-group">
                  <label>ابعاد / سایز</label>
                  <input value={dimensions} onChange={(e) => setDimensions(e.target.value)} placeholder="مثلاً ۲۰×۳۰×۱۰ سانتی‌متر" />
                </div>
              </div>
              <div className="form-group">
                <label>رنگ</label>
                <input value={color} onChange={(e) => setColor(e.target.value)} />
              </div>
              <div className="form-group">
                <label>لینک‌های محصول / فروشنده</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {productLinks.map((lnk, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input dir="ltr" style={{ flex: 1 }} value={lnk} placeholder="https://..."
                        onChange={(e) => { const n = [...productLinks]; n[i] = e.target.value; setProductLinks(n) }} />
                      {productLinks.length > 1 && <button type="button" className="btn-danger btn-sm" title="حذف" onClick={() => setProductLinks(productLinks.filter((_, j) => j !== i))}>✕</button>}
                    </div>
                  ))}
                </div>
                <button type="button" className="btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => setProductLinks([...productLinks, ''])}>+ افزودن لینک</button>
              </div>
              <div className="form-group">
                <label>توضیحات کالا</label>
                <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </>
          ) : (
            <div className="grid-2">
              <div className="form-group">
                <label>جنس</label>
                <SearchableSelect value={materialId} onChange={setMaterialId} placeholder="انتخاب..."
                  options={materials.map((m: any) => ({ value: m.id, label: m.name }))} />
              </div>
              <div className="form-group">
                <label>نوع پوشش</label>
                <SearchableSelect value={coatingId} onChange={setCoatingId} placeholder="انتخاب..."
                  options={coatings.map((c: any) => ({ value: c.id, label: c.name }))} />
              </div>
            </div>
          )}

          <div className="form-group">
            <label>قیمت تارگت خریدار</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <NumberInput value={targetAmount} onChange={setTargetAmount} placeholder="مبلغ" decimals style={{ flex: 1 }} />
              <select style={{ width: 120 }} value={targetCurrency} onChange={(e) => setTargetCurrency(e.target.value)}>
                <option value="IRR">تومان</option>
                <option value="USD">دلار</option>
                <option value="CNY">یوآن</option>
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>
              {isTrading
                ? (isEdit ? 'افزودن عکس جدید (اختیاری)' : 'عکس‌های کالا (png, jpg)')
                : (isEdit ? 'افزودن نقشهٔ جدید (اختیاری)' : 'فایل‌های نقشه (pdf, dwg, step, x_t, zip, png, jpg)')}
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {drawings.map((_, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="hint" style={{ minWidth: 18  }}>{i + 1}.</span>
                  <input type="file" accept={isTrading ? '.png,.jpg,.jpeg,.webp' : '.pdf,.dwg,.step,.stp,.x_t,.zip,.png,.jpg,.jpeg'} style={{ flex: 1 }}
                    onChange={(e) => { const n = [...drawings]; n[i] = e.target.files?.[0] || null; setDrawings(n) }} />
                  {drawings.length > 1 && <button type="button" className="btn-danger btn-sm" title="حذف این باکس" onClick={() => setDrawings(drawings.filter((_, j) => j !== i))}>✕</button>}
                </div>
              ))}
            </div>
            <button type="button" className="btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => setDrawings([...drawings, null])}>+ افزودن {isTrading ? 'عکس' : 'نقشه'}</button>
            {!isTrading && isEdit && <span className="hint-sm" style={{ display: 'block', marginTop: 6  }}>هر نقشهٔ افزوده‌شده جداگانه برای بازبینی فنی ارسال می‌شود.</span>}
          </div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={!name || quantity < 1 || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? 'در حال ذخیره...' : 'ذخیره'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── EDIT PROJECT MODAL ───────────────────────────────
function EditProjectModal({ project, onClose, onSuccess }: any) {
  const [needDate, setNeedDate] = useState(project.needDate ? project.needDate.slice(0, 10) : '')
  const [description, setDescription] = useState(project.description || '')
  const mutation = useMutation({
    mutationFn: () => api.patch(`/projects/${project.id}`, { needDate: needDate || undefined, description }),
    onSuccess,
  })
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>ویرایش پروژه</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-group"><label>تاریخ نیاز (شمسی یا میلادی)</label><DateField value={needDate} onChange={setNeedDate} /></div>
          <div className="form-group"><label>توضیحات</label><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-primary" disabled={mutation.isPending} onClick={() => mutation.mutate()}>ذخیره</button>
        </div>
      </div>
    </div>
  )
}

// ─── ARCHIVE MODAL ────────────────────────────────────
function ArchiveModal({ projectId, onClose, onSuccess }: any) {
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const mutation = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/archive`, { reason, notes }),
    onSuccess,
    onError: (e: any) => setError(e.response?.data?.message || 'خطا'),
  })
  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header"><h2>بایگانی پروژه</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div className="form-group">
            <label>دلیل بایگانی *</label>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">انتخاب...</option>
              <option value="PROJECT_COMPLETED">پروژه با موفقیت تکمیل شد</option>
              <option value="PRICE_REJECTED_BY_CUSTOMER">قیمت توسط مشتری رد شد</option>
              <option value="TECHNICAL_ISSUES">مشکلات فنی در تولید</option>
              <option value="CUSTOMER_CANCELLED">لغو توسط مشتری</option>
              <option value="OTHER">دلایل دیگر</option>
            </select>
          </div>
          <div className="form-group"><label>توضیحات تکمیلی</label><textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">انصراف</button>
          <button className="btn-danger" disabled={!reason || mutation.isPending} onClick={() => mutation.mutate()}>بایگانی</button>
        </div>
      </div>
    </div>
  )
}

// ─── PRICING REQUEST MODAL (Window C) — تخصیص سازنده به قطعات (per-part / دسته‌ای) ──
function PricingRequestModal({ projectId, projectType, parts, onClose, onSuccess }: any) {
  const qc = useQueryClient()
  const partList: any[] = parts || []
  const allPartIds = partList.map((p) => p.id)
  // فروشنده = سازنده (ساخت) یا تامین‌کننده (خرید کالا)
  const isTrading = projectType === 'TRADING'
  const vendorWord = isTrading ? 'تامین‌کننده' : 'سازنده'
  const itemWord = isTrading ? 'کالا' : 'قطعه'
  const vendorEndpoint = isTrading ? '/settings/suppliers' : '/settings/producers'
  const [selectedVendors, setSelectedVendors] = useState<Set<string>>(new Set())
  const [assign, setAssign] = useState<Record<string, Set<string>>>({}) // vendorId → set of assigned partIds
  const [perPart, setPerPart] = useState(false)
  const [error, setError] = useState('')
  const [quickName, setQuickName] = useState('')
  const { data: vendors = [] } = useQuery({ queryKey: [isTrading ? 'suppliers' : 'producers'], queryFn: () => api.get(vendorEndpoint).then((r) => r.data) })

  // اعضای گروه هم‌بستگی با هم جابه‌جا می‌شوند (قاعدهٔ سطح‌گروه)
  const groupSiblings = (partId: string): string[] => {
    const p = partList.find((x) => x.id === partId)
    if (!p?.groupId) return [partId]
    return partList.filter((x) => x.groupId === p.groupId).map((x) => x.id)
  }
  const vendorName = (id: string) => vendors.find((p: any) => p.id === id)?.name || '—'

  function toggleVendor(id: string, checked: boolean) {
    const n = new Set(selectedVendors); const a = { ...assign }
    if (checked) { n.add(id); a[id] = new Set(allPartIds) } else { n.delete(id); delete a[id] }
    setSelectedVendors(n); setAssign(a)
  }
  function togglePart(vendorId: string, partId: string) {
    const a = { ...assign }
    const set = new Set(a[vendorId] ?? new Set(allPartIds))
    const has = set.has(partId)
    groupSiblings(partId).forEach((sid) => (has ? set.delete(sid) : set.add(sid)))
    a[vendorId] = set; setAssign(a)
  }

  // تعریف سریع فروشنده همان‌لحظه (تصمیم #۲) — با نام حداقلی، سپس انتخاب خودکار
  const quickCreate = useMutation({
    mutationFn: () => api.post(vendorEndpoint, { name: quickName.trim() }).then((r) => r.data),
    onSuccess: (created: any) => {
      setQuickName('')
      qc.invalidateQueries({ queryKey: [isTrading ? 'suppliers' : 'producers'] })
      toggleVendor(created.id, true)
    },
    onError: (e: any) => setError(e.response?.data?.message || 'خطا در تعریف سریع'),
  })

  const mutation = useMutation({
    mutationFn: () => {
      const assignments = [...selectedVendors]
        .map((vid) => ({ [isTrading ? 'supplierId' : 'producerId']: vid, partIds: [...(assign[vid] ?? new Set(allPartIds))] }))
        .filter((x) => x.partIds.length)
      return api.post('/pricing', { projectId, assignments })
    },
    onSuccess,
    onError: (e: any) => setError(e.response?.data?.message || 'خطا در ثبت درخواست'),
  })

  const emptyVendor = [...selectedVendors].find((vid) => (assign[vid]?.size ?? allPartIds.length) === 0)

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 640 }}>
        <div className="modal-header"><h2>ارسال برای قیمت‌گیری</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <p style={{ marginBottom: 12, color: 'var(--text-muted)', fontSize: 13 }}>{partList.length} {itemWord} انتخاب شده — {vendorWord}‌های مورد نظر را انتخاب کنید:</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
            {vendors.map((p: any) => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={selectedVendors.has(p.id)}
                  onChange={(e) => toggleVendor(p.id, e.target.checked)} />
                {p.name}
              </label>
            ))}
            {vendors.length === 0 && <p className="muted">هنوز {vendorWord}ای تعریف نشده — از کادر زیر سریع اضافه کنید.</p>}
          </div>

          {/* تعریف سریع فروشنده همان‌لحظه */}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
            <input style={{ flex: 1 }} value={quickName} placeholder={`تعریف سریع ${vendorWord} جدید (نام)`}
              onChange={(e) => setQuickName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && quickName.trim()) { e.preventDefault(); quickCreate.mutate() } }} />
            <button type="button" className="btn-secondary btn-sm" disabled={!quickName.trim() || quickCreate.isPending} onClick={() => quickCreate.mutate()}>+ افزودن سریع</button>
          </div>

          {/* تخصیص دقیق قطعات به هر فروشنده (اختیاری) — پیش‌فرض: همه به همه */}
          {selectedVendors.size > 0 && partList.length > 1 && (
            <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={perPart} onChange={(e) => setPerPart(e.target.checked)} />
                🎯 تخصیص دقیق «کدام {vendorWord} برای کدام {itemWord}‌ها» (پیش‌فرض: همه به همه)
              </label>
              {perPart && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {[...selectedVendors].map((vid) => {
                    const set = assign[vid] ?? new Set(allPartIds)
                    return (
                      <div key={vid}>
                        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{vendorName(vid)}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {partList.map((part) => {
                            const on = set.has(part.id)
                            return (
                              <button key={part.id} type="button" onClick={() => togglePart(vid, part.id)}
                                style={{ padding: '3px 10px', borderRadius: 100, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                                  border: '1px solid ' + (on ? 'var(--brand, var(--brand))' : 'var(--border)'),
                                  background: on ? 'var(--brand, var(--brand))' : 'var(--surface)', color: on ? 'var(--surface)' : 'var(--text)' }}>
                                {part.name}{part.groupId ? ' 🔗' : ''}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                  <p className="hint-sm">🔗 = عضو گروه هم‌بستگی؛ اعضای یک گروه همیشه با هم به یک {vendorWord} تخصیص می‌یابند.</p>
                </div>
              )}
            </div>
          )}

          {emptyVendor && <div className="error-msg" style={{ marginTop: 10 }}>برای «{vendorName(emptyVendor)}» هیچ {itemWord}ای انتخاب نشده است.</div>}
          {error && <div className="error-msg">{error}</div>}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="btn-secondary">بستن</button>
          <button className="btn-primary" disabled={selectedVendors.size === 0 || !!emptyVendor || mutation.isPending} onClick={() => mutation.mutate()}>ثبت درخواست</button>
        </div>
      </div>
    </div>
  )
}

// ─── PART DETAIL DRAWER ───────────────────────────────
const T_STATUS_FA: Record<string, string> = { PENDING: '🟡 در انتظار بازبینی', APPROVED: '🟢 تأیید فنی', REJECTED: '🔴 رد فنی' }

function PartDetailDrawer({ projectId, part, onClose }: any) {
  const { data } = useQuery({
    queryKey: ['part-timeline', part.id],
    queryFn: () => api.get(`/projects/${projectId}/parts/${part.id}/timeline`).then((r) => r.data),
  })
  const events = data?.events || []
  const files = data?.files || part.files || []
  const info = data?.part || part

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 640 }}>
        <div className="modal-header"><h2>زندگی‌نامهٔ قطعه: {info.name}</h2><button onClick={onClose}>✕</button></div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <span className="status-badge status-active">{MILESTONE_LABELS[info.milestone] || info.milestone}</span>
            <span className="status-badge" style={{ background: 'var(--bg)' }}>{T_STATUS_FA[info.technicalStatus] || info.technicalStatus}</span>
            <span className="status-badge" style={{ background: 'var(--bg)' }}>تعداد: {info.quantity}</span>
          </div>
          {info.archivedAt && (
            <div style={{ padding: 8, background: 'var(--danger-soft)', color: 'var(--danger)', borderRadius: 'var(--radius-sm)', fontSize: 13, marginBottom: 14 }}>
              🗄️ این قطعه بایگانی شده و فرآیندش متوقف است{info.archivedReason ? ` — ${info.archivedReason}` : ''}
            </div>
          )}

          <h3 style={{ fontSize: 14, marginBottom: 8 }}>فایل‌های نقشه ({files.length})</h3>
          {files.length ? (
            <ul className="simple-list" style={{ marginBottom: 18 }}>
              {files.map((f: any) => (
                <li key={f.id}>
                  <span style={{ fontSize: 12 }}>{f.storedName}{f.reviewStatus ? ` — ${T_STATUS_FA[f.reviewStatus] || ''}` : ''}</span>
                  <a href={`${API_ORIGIN}${f.url}`} target="_blank" rel="noreferrer" className="btn-secondary btn-sm">دانلود</a>
                </li>
              ))}
            </ul>
          ) : <p style={{ color: 'var(--text-muted)', marginBottom: 18 }}>فایلی موجود نیست</p>}

          <h3 style={{ fontSize: 14, marginBottom: 12 }}>ردپای مراحل (زندگی‌نامه)</h3>
          {events.length ? (
            <div style={{ position: 'relative', paddingRight: 22 }}>
              <div style={{ position: 'absolute', right: 9, top: 4, bottom: 4, width: 2, background: 'var(--border)' }} />
              {events.map((e: any, i: number) => (
                <div key={i} style={{ position: 'relative', marginBottom: 14 }}>
                  <div style={{ position: 'absolute', right: -22, top: 0, width: 20, height: 20, borderRadius: '50%', background: 'var(--surface)', border: '2px solid var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10 }}>{e.icon}</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{e.title}</div>
                  {e.detail && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{e.detail}</div>}
                  <div className="hint-sm">{e.user ? `${e.user} • ` : ''}{formatDateTime(e.at)}</div>
                </div>
              ))}
            </div>
          ) : <p className="muted">رویدادی ثبت نشده</p>}
        </div>
      </div>
    </div>
  )
}
