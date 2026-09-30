import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import api, { fileUrl } from '../../lib/api'
import { useAuthStore } from '../../store/authStore'
import { toast } from '../../components/ui/dialog'
import { waLink, fillTemplate, normalizeIraqPhone } from './shared'
import Icon from '../../components/ui/Icon'
import { BRAND, WHATSAPP_SEND_ENABLED } from '../../lib/appMode'
import { renderBrochure, type BrochureProduct } from './brochure'
import { canShareFiles, shareFiles, copyImage, copyText, downloadBlob, blobToFile, fetchAsFile } from './sendFile'
import { useWaStatus, queueMessage, waitForJob } from './waBridge'

/**
 * دکمهٔ واتساپ با قالب پیام آماده.
 *
 * در عراق واتساپ کانال اصلی است، ولی تایپ‌کردن پیام عربی برای هر مغازه
 * غیرممکن است. پس قالب انتخاب می‌شود، جای‌گیرها خودکار پر می‌شوند
 * ({{name}}، {{city}}، {{product}}، {{products}}، {{price}}) و متن قبل از
 * ارسال قابل ویرایش است — چون هیچ قالبی برای همه جواب نمی‌دهد.
 */
export default function WhatsAppButton({ contact, iconOnly = false }: { contact: any; iconOnly?: boolean }) {
  const [open, setOpen] = useState(false)
  const number = contact.whatsapp || contact.phone
  // فعلاً خاموش — نگاه کن به WHATSAPP_SEND_ENABLED در lib/appMode
  if (!WHATSAPP_SEND_ENABLED) return null
  if (!normalizeIraqPhone(number)) return null

  return (
    <>
      {iconOnly ? (
        <button className="icon-btn" onClick={() => setOpen(true)} title="واتساپ" aria-label={`پیام واتساپ به ${contact.name}`}><Icon name="chat" /></button>
      ) : (
        <button className="btn-secondary btn-sm" style={{ color: '#16a34a', borderColor: '#16a34a' }} onClick={() => setOpen(true)}>
          <Icon name="chat" /> واتساپ
        </button>
      )}
      {open && <TemplatePicker contact={contact} onClose={() => setOpen(false)} />}
    </>
  )
}

/** نام فارسی جای‌گیرها، برای پیام هشدار */
const VAR_FA: Record<string, string> = {
  name: 'نام مخاطب', city: 'شهر', product: 'نام محصول', products: 'فهرست محصولات',
  price: 'قیمت پایه', myName: 'نام شما', company: 'نام شرکت', companyAr: 'نام عربی شرکت',
}

const isImage = (f: { mime?: string | null; originalName: string }) =>
  (f.mime || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(f.originalName)

/** متنِ عربیِ پیش‌فرض وقتی هیچ قالبی برای این ترکیب محصولات وجود ندارد */
const autoBody = `السلام عليكم ورحمة الله
معكم {{myName}} من شركة {{company}} — إيران
نحن منتجون ومصدّرون لمستلزمات طب الأسنان، ونقدّم لكم:
{{products}}
الكتالوج والأسعار مرفقة. بانتظار رأيكم الكريم 🌹`

function TemplatePicker({ contact, onClose }: { contact: any; onClose: () => void }) {
  const { user } = useAuthStore()
  const qc = useQueryClient()
  const [sending, setSending] = useState(false)
  // وضعیت پل فقط تا وقتی این پنجره باز است پرسیده می‌شود
  const { status: bridge } = useWaStatus(true)
  const [text, setText] = useState('')
  const [productIds, setProductIds] = useState<string[]>([])
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // جای‌گیرهایی که در این قالب به کار رفته‌اند ولی مقدارشان خالی است
  const [missing, setMissing] = useState<string[]>([])
  const [sheet, setSheet] = useState<{ blob: Blob; url: string } | null>(null)
  const [sheetBusy, setSheetBusy] = useState(false)

  const { data: templates = [] } = useQuery({ queryKey: ['market-templates'], queryFn: () => api.get('/market/templates').then((r) => r.data) })
  const { data: products = [] } = useQuery({ queryKey: ['market-products'], queryFn: () => api.get('/market/products').then((r) => r.data) })
  const { data: settings } = useQuery({
    queryKey: ['market-settings'],
    queryFn: () => api.get('/market/settings').then((r) => r.data),
    staleTime: 10 * 60 * 1000,
  })

  const canShare = useMemo(canShareFiles, [])
  // گیرندهٔ این پیام مغازه‌دار عراقی است، پس نامِ فارسی به دردش نمی‌خورد:
  // `{{company}}` لاتین می‌ماند (COMPANY_NAME، مثلاً «Tika Dent Plus») و نام
  // عربی تنظیم جداگانه‌ای دارد که سرصفحهٔ برگهٔ محصولات را می‌سازد.
  const companyLabel = settings?.companyName || BRAND.latin
  const companyAr = settings?.companyAr || ''
  const chosen: any[] = productIds.map((id) => products.find((p: any) => p.id === id)).filter(Boolean)
  const first = chosen[0]

  /** فهرست عربیِ محصولات انتخاب‌شده — همان چیزی که {{products}} جایش می‌نشیند */
  const productsBlock = chosen
    .map((p) => {
      const label = p.nameAr || p.nameEn || p.name
      const price = p.listPriceUsd != null ? ` — ${Number(p.listPriceUsd).toLocaleString('en-US')} $` : ''
      return `• ${label}${price}`
    })
    .join('\n')

  const vars = {
    name: contact.ownerName || contact.nameAr || contact.name,
    city: contact.city?.nameAr || contact.city?.name || '',
    // تک‌محصولی‌ها به «اولین انتخاب» می‌افتند تا قالب‌های قدیمی نشکنند
    product: first?.nameAr || first?.nameEn || first?.name || '',
    price: first?.listPriceUsd ?? '',
    products: productsBlock,
    myName: user?.name || '',
    company: companyLabel,
    companyAr,
  }

  const picked = templates.find((t: any) => t.id === pickedId)
  const files: any[] = picked?.files || []

  // قالب‌ها به محصول گره خورده‌اند. فقط قالب‌های محصولاتِ انتخاب‌شده
  // (به‌علاوهٔ عمومی‌ها) پیشنهاد می‌شود؛ وگرنه متنِ «فرز سرامیکی» برای
  // «وارمر» هم ظاهر می‌شد و کاربر پیام اشتباه می‌فرستاد.
  const forProduct = templates.filter((t: any) => t.productId && productIds.includes(t.productId))
  const general = templates.filter((t: any) => !t.productId)

  const usedVars = (body: string) =>
    [...new Set([...String(body).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))]

  /**
   * قالب را پر می‌کند و می‌گوید کدام جای‌گیر خالی مانده.
   * بدون این هشدار، مثلاً وقتی قیمت پایهٔ محصول تعیین نشده باشد، پیام
   * «سعر … هو  دولار» با یک حفرهٔ وسط جمله برای مشتری واقعی فرستاده می‌شد.
   */
  const applyBody = (body: string, id: string | null) => {
    setPickedId(id)
    setText(fillTemplate(body, vars))
    setMissing(usedVars(body).filter((k) => { const v = (vars as any)[k]; return v == null || v === '' }))
  }
  const apply = (t: any) => applyBody(t.body, t.id)

  /** قالبِ انتخاب‌شده تک‌محصولی است ولی چند محصول انتخاب شده — پیام فقط اولی را می‌گوید */
  const singleOnly = chosen.length > 1 && picked
    && usedVars(picked.body).some((k) => k === 'product' || k === 'price')
    && !usedVars(picked.body).includes('products')

  const link = waLink(contact.whatsapp || contact.phone, text)

  // ─── برگهٔ محصولات ───
  // با هر تغییر در انتخاب، دوباره کشیده می‌شود. `alive` جلوی نشستنِ نتیجهٔ
  // یک ساختِ قدیمی روی ساختِ جدید را می‌گیرد وقتی کاربر سریع چیپ می‌زند.
  useEffect(() => {
    if (!chosen.length) { setSheet((s) => { if (s) URL.revokeObjectURL(s.url); return null }) ; return }
    let alive = true
    setSheetBusy(true)
    const items: BrochureProduct[] = chosen.map((p) => ({
      name: p.name, nameAr: p.nameAr, nameEn: p.nameEn, unit: p.unit, moq: p.moq,
      listPriceUsd: p.listPriceUsd, imageUrl: p.imageUrl,
    }))
    renderBrochure(items, {
      title: companyAr || companyLabel,
      subtitle: companyAr ? companyLabel : '',
      footer: settings?.contactLine || '',
      iqdPerUsd: settings?.iqdPerUsd,
      logoUrl: BRAND.mark,
    })
      .then((blob) => {
        if (!alive) return
        setSheet((old) => { if (old) URL.revokeObjectURL(old.url); return { blob, url: URL.createObjectURL(blob) } })
      })
      .catch(() => alive && toast.error('برگهٔ محصولات ساخته نشد'))
      .finally(() => alive && setSheetBusy(false))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productIds.join(','), companyLabel, companyAr, settings?.contactLine, settings?.iqdPerUsd])

  useEffect(() => () => { if (sheet) URL.revokeObjectURL(sheet.url) }, [])

  const toggleProduct = (id: string) => {
    setProductIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
    // قالبی که مالِ محصولی بود که همین حالا برداشته شد نباید انتخاب بماند
    const still = templates.find((t: any) => t.id === pickedId)
    if (still?.productId === id && productIds.includes(id)) { setPickedId(null); setText(''); setMissing([]) }
  }

  const sheetName = `products-${chosen.map((p) => p.code || p.name).join('-').slice(0, 40) || 'list'}.png`

  /**
   * راه ۱ — پنجرهٔ اشتراک‌گذاری سیستم.
   * متن هم‌زمان در کلیپ‌بورد گذاشته می‌شود: بعضی مقصدها (از جمله واتساپِ
   * ویندوز) فقط فایل را می‌گیرند و caption را دور می‌ریزند؛ آن‌وقت کاربر با
   * یک Ctrl+V متن را هم دارد.
   */
  const doShare = async (label: string, getFiles: () => Promise<File[]> | File[]) => {
    setBusy(label)
    try {
      const fs = await getFiles()
      if (text.trim()) { try { await copyText(text) } catch { /* کلیپ‌بورد اجباری نیست */ } }
      await shareFiles(fs, { title: contact.name, text })
    } catch (e: any) {
      // بستنِ پنجرهٔ اشتراک‌گذاری توسط کاربر خطا نیست
      if (e?.name !== 'AbortError') toast.error('اشتراک‌گذاری انجام نشد — از «کپی تصویر» استفاده کنید')
    } finally { setBusy(null) }
  }

  const doCopyImage = async (blob: Blob, label: string) => {
    setBusy(label)
    try {
      await copyImage(blob)
      toast.success('تصویر کپی شد — در واتساپ Ctrl+V بزنید')
    } catch {
      toast.error('مرورگر اجازهٔ کپی تصویر نداد. از «دانلود» استفاده کنید.')
    } finally { setBusy(null) }
  }

  /** نشانی عمومی فایل را ته پیام می‌گذارد — مطمئن‌ترین راه، روی هر دستگاهی کار می‌کند */
  const appendLink = (f: any) => {
    const url = fileUrl(f.url)
    if (text.includes(url)) { toast.info('این لینک از قبل در متن هست'); return }
    setText((t) => (t.trimEnd() + '\n' + url).trim())
    toast.success('لینک به متن اضافه شد')
  }

  /** همهٔ پیوست‌های قالب را با هم به پنجرهٔ اشتراک‌گذاری می‌دهد — واتساپ چند فایل را یکجا می‌پذیرد */
  const shareAllFiles = () => doShare('all', async () => {
    const fs = await Promise.all(files.map((f) => fetchAsFile(fileUrl(f.url), f.originalName)))
    if (sheet) fs.unshift(blobToFile(sheet.blob, sheetName))
    return fs
  })

  const send = () => {
    if (!link) { toast.error('شمارهٔ واتساپ معتبر نیست'); return }
    window.open(link, '_blank', 'noopener')
  }

  /**
   * ارسال واقعی: متن و «برگهٔ محصولات» در **یک** پیام (عکس با caption).
   *
   * صفحه فقط در صف می‌گذارد؛ فرستنده، پلِ روی لپ‌تاپ است. پس این‌جا منتظر
   * نتیجه می‌مانیم تا کاربر بداند واقعاً رفت یا نه — «در صف قرار گرفت» برای
   * کسی که پشت خط منتظر است جواب نیست. ثبت در تایم‌لاین را هم خودِ سرور
   * موقع موفقیت انجام می‌دهد، نه این‌جا؛ وگرنه اگر مرورگر بسته می‌شد پیام
   * می‌رفت و هیچ ردی از آن نمی‌ماند.
   */
  const sendDirect = async () => {
    if (!text.trim() && !sheet) { toast.error('متن یا عکسی برای فرستادن نیست'); return }
    setSending(true)
    try {
      const job = await queueMessage({
        contactId: contact.id, text, image: sheet?.blob, filename: sheetName,
      })
      const done = await waitForJob(job.id)
      qc.invalidateQueries({ queryKey: ['market-contact', contact.id] })
      qc.invalidateQueries({ queryKey: ['market-contacts'] })

      if (done.status === 'SENT') { toast.success('فرستاده شد ✓'); onClose(); return }
      if (done.status === 'FAILED') { toast.error(done.error || 'ارسال نشد'); return }
      toast.info('در صف ماند — پل واتساپ روی لپ‌تاپ باز است؟ به‌محض روشن‌شدن خودش می‌فرستد.')
    } catch (e: any) {
      toast.error(e.response?.data?.message || 'ارسال نشد')
    } finally { setSending(false) }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} dir="rtl" style={{ maxWidth: 680 }}>
        <div className="modal-header"><h2>پیام واتساپ به {contact.name}</h2><button onClick={onClose} aria-label="بستن"><Icon name="x" /></button></div>
        <div className="modal-body">

          {/* ─── ۱. محصولات — چندتایی ─── */}
          <div className="form-group">
            <label>کدام محصول‌ها را معرفی می‌کنید؟ <span className="mk-label-sub">می‌توانید چندتا بزنید</span></label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {products.map((p: any) => (
                <button key={p.id} type="button" className={`band-chip ${productIds.includes(p.id) ? 'active' : ''}`}
                  onClick={() => toggleProduct(p.id)}>
                  {productIds.includes(p.id) && <Icon name="check" size={13} />}
                  {p.name}
                </button>
              ))}
              {products.length > 1 && (
                <button type="button" className="btn-ghost btn-sm"
                  onClick={() => setProductIds(productIds.length === products.length ? [] : products.map((p: any) => p.id))}>
                  {productIds.length === products.length ? 'هیچ‌کدام' : 'همه'}
                </button>
              )}
            </div>
          </div>

          {/* ─── ۲. قالب ─── */}
          <div className="form-group">
            <label>قالب پیام</label>
            {forProduct.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 7 }}>
                {forProduct.map((t: any) => {
                  const p = products.find((x: any) => x.id === t.productId)
                  return (
                    <button key={t.id} type="button" className={`band-chip ${pickedId === t.id ? 'active' : ''}`} onClick={() => apply(t)}>
                      {t.title}
                      {chosen.length > 1 && p ? <span className="mk-label-sub"> · {p.name}</span> : null}
                      {t.files?.length ? <span className="n">{t.files.length}</span> : null}
                    </button>
                  )
                })}
              </div>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {general.map((t: any) => (
                <button key={t.id} type="button" className={`band-chip ${pickedId === t.id ? 'active' : ''}`} onClick={() => apply(t)}>
                  {t.title}
                  {t.files?.length ? <span className="n">{t.files.length}</span> : null}
                </button>
              ))}
              <button type="button" className={`band-chip ${pickedId === '__auto' ? 'active' : ''}`}
                disabled={!chosen.length} title={chosen.length ? '' : 'اول محصول را انتخاب کنید'}
                onClick={() => applyBody(autoBody, '__auto')}>
                <Icon name="repeat" size={13} /> متن خودکار برای همین محصول‌ها
              </button>
            </div>
            {productIds.length === 0 && (
              <p className="hint-sm" style={{ marginTop: 6 }}>
                برای دیدن قالب‌های مخصوص هر محصول، بالا محصول را انتخاب کنید.
              </p>
            )}
          </div>

          {/* ─── ۳. متن ─── */}
          <div className="form-group">
            <label>متن پیام (قابل ویرایش)</label>
            <textarea rows={8} dir="rtl" value={text} onChange={(e) => setText(e.target.value)} placeholder="یک قالب انتخاب کنید یا خودتان بنویسید…" />
            {singleOnly && (
              <div className="alert alert-warning" style={{ marginTop: 7 }}>
                این قالب فقط از <strong>یک</strong> محصول استفاده می‌کند («{first?.name}») ولی {chosen.length} محصول انتخاب کرده‌اید.
                برای معرفی همه با هم، «متن خودکار» را بزنید یا در قالب از {'{{products}}'} استفاده کنید.
              </div>
            )}
            {missing.length > 0 && (
              <div className="alert alert-warning" style={{ marginTop: 7 }}>
                این‌ها در متن قالب هستند ولی مقداری ندارند و جایشان خالی مانده:{' '}
                <strong>{missing.map((k) => VAR_FA[k] || k).join('، ')}</strong>.
                {missing.includes('price') && ' قیمت پایهٔ این محصول را در «تنظیمات ← محصولات» پر کنید.'}
                {' '}متن را قبل از ارسال بازخوانی کنید.
              </div>
            )}
          </div>

          {/* ─── ۴. عکس ─── */}
          {chosen.length > 0 && (
            <div className="form-group">
              <label>برگهٔ محصولات <span className="mk-label-sub">{chosen.length} محصول روی یک تصویر</span></label>
              <div className="panel panel-pad" style={{ padding: 10, display: 'flex', gap: 11, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {sheetBusy || !sheet ? (
                  <div style={{ width: 92, height: 92, borderRadius: 8, background: 'var(--surface-2)', display: 'grid', placeItems: 'center', flex: 'none' }}>
                    <span className="hint-sm">{sheetBusy ? '…' : '—'}</span>
                  </div>
                ) : (
                  <a href={sheet.url} target="_blank" rel="noreferrer" style={{ flex: 'none' }} title="دیدن در اندازهٔ کامل">
                    <img src={sheet.url} alt="پیش‌نمایش برگهٔ محصولات"
                      style={{ width: 92, borderRadius: 8, border: '1px solid var(--border)', display: 'block' }} />
                  </a>
                )}
                <div style={{ flex: 1, minWidth: 210 }}>
                  <p className="hint-sm" style={{ marginBottom: 8 }}>
                    نام و قیمت هر {chosen.length} محصول روی <strong>یک عکس</strong> — به‌جای فرستادن چند فایل جدا.
                  </p>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {canShare && (
                      <button className="btn-primary btn-sm" disabled={!sheet || busy === 'sheet'}
                        onClick={() => sheet && doShare('sheet', () => [blobToFile(sheet.blob, sheetName)])}>
                        <Icon name="share" /> ارسال مستقیم به واتساپ
                      </button>
                    )}
                    <button className="btn-secondary btn-sm" disabled={!sheet || busy === 'sheet-c'}
                      onClick={() => sheet && doCopyImage(sheet.blob, 'sheet-c')}>
                      <Icon name="copy" /> کپی تصویر
                    </button>
                    <button className="btn-secondary btn-sm" disabled={!sheet}
                      onClick={() => sheet && downloadBlob(sheet.blob, sheetName)}>
                      <Icon name="download" /> دانلود
                    </button>
                  </div>
                </div>
              </div>
              {chosen.some((p) => !p.imageUrl) && (
                <p className="hint-sm" style={{ marginTop: 6 }}>
                  {chosen.filter((p) => !p.imageUrl).map((p) => p.name).join('، ')} هنوز عکس ندارد و با حرف اول نامش کشیده می‌شود —
                  از «تنظیمات ← محصولات» عکسشان را بگذارید.
                </p>
              )}
            </div>
          )}

          {files.length > 0 && (
            <div className="form-group">
              <label>پیوست‌های قالب «{picked?.title}»</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {files.map((f) => (
                  <div key={f.id} className="panel panel-pad" style={{ padding: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {isImage(f)
                      ? <img src={fileUrl(f.url)} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, flex: 'none' }} />
                      : <span className="icon-btn" style={{ pointerEvents: 'none' }}><Icon name="paperclip" /></span>}
                    <span style={{ fontSize: 12.5, flex: 1, minWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.originalName}</span>
                    {canShare && (
                      <button className="btn-secondary btn-sm" disabled={busy === f.id}
                        onClick={() => doShare(f.id, async () => [await fetchAsFile(fileUrl(f.url), f.originalName)])}>
                        <Icon name="share" /> ارسال
                      </button>
                    )}
                    {isImage(f) && (
                      <button className="btn-secondary btn-sm" disabled={busy === f.id}
                        onClick={async () => {
                          setBusy(f.id)
                          try { await doCopyImage(await (await fetch(fileUrl(f.url))).blob(), f.id) }
                          catch { toast.error('فایل خوانده نشد') }
                          finally { setBusy(null) }
                        }}>
                        <Icon name="copy" /> کپی
                      </button>
                    )}
                    <button className="btn-secondary btn-sm" onClick={() => appendLink(f)}>لینک در متن</button>
                    <a className="icon-btn" title="دانلود" aria-label={`دانلود ${f.originalName}`}
                      href={fileUrl(f.url)} download={f.originalName} target="_blank" rel="noreferrer"><Icon name="download" /></a>
                  </div>
                ))}
              </div>
              {canShare && (files.length > 1 || (files.length && sheet)) && (
                <button className="btn-secondary btn-sm" style={{ marginTop: 7 }} disabled={busy === 'all'} onClick={shareAllFiles}>
                  <Icon name="share" /> {busy === 'all' ? 'در حال آماده‌سازی…' : `ارسال همه با هم (${files.length + (sheet ? 1 : 0)} فایل)`}
                </button>
              )}
            </div>
          )}

          {bridge.status === 'connected' ? (
            <div className="alert alert-success">
              <strong>واتساپ وصل است</strong>
              {bridge.me?.number ? <span dir="ltr"> · +{bridge.me.number}</span> : null}
              <div style={{ marginTop: 4, fontSize: 12.5 }}>
                دکمهٔ «ارسال» متن و برگهٔ محصولات را در <strong>یک پیام</strong> می‌فرستد و در پروندهٔ مخاطب هم ثبتش می‌کند.
                {typeof bridge.sentToday === 'number' && <> امروز {bridge.sentToday} از {bridge.dailyCap} پیام.</>}
              </div>
            </div>
          ) : (
            /* راهنمای کوتاه — کدام دکمه در کدام حالت. بدون این، کاربر «کپی تصویر»
               می‌زند و منتظر می‌ماند اتفاقی بیفتد. */
            <div className="alert alert-info">
              <strong>ارسال یک‌کلیکی خاموش است</strong>
              <div style={{ marginTop: 4, fontSize: 12.5 }}>
                {bridge.status === 'qr' ? 'پل روشن است ولی هنوز به واتساپ وصل نشده — در «تنظیمات ← واتساپ» کد QR را با گوشی اسکن کنید.'
                  : bridge.status === 'logged-out' ? 'نشست واتساپ از گوشی قطع شده — در «تنظیمات ← واتساپ» دوباره وصلش کنید.'
                  : 'برای اینکه متن و عکس با یک دکمه بروند، «پل واتساپ» باید روی لپ‌تاپ باز باشد — در «تنظیمات ← واتساپ» نوشته چطور.'}
                {' '}تا آن موقع، این سه راه هست:
              </div>
              <div style={{ marginTop: 5, fontSize: 12.5, lineHeight: 2 }}>
                {canShare && <>۱) <strong>ارسال مستقیم</strong> — پنجرهٔ اشتراک‌گذاری ویندوز باز می‌شود، واتساپ را بزنید و مخاطب را انتخاب کنید. متن هم‌زمان کپی می‌شود؛ اگر خودش نیامد در کادر عنوان Ctrl+V کنید.<br /></>}
                {canShare ? '۲) ' : '۱) '}<strong>کپی تصویر</strong> سپس <strong>باز کردن واتساپ</strong> — متن از قبل داخل کادر پیام است؛ Ctrl+V بزنید تا عکس بچسبد.<br />
                {canShare ? '۳) ' : '۲) '}<strong>دانلود</strong> — بعد در واتساپ با گیرهٔ 📎 پیوستش کنید.
                {!canShare && <><br /><span className="hint-sm">«ارسال مستقیم» در این مرورگر نیست — با Chrome یا Edge باز کنید تا فعال شود.</span></>}
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>بستن</button>
          <button className="btn-secondary" disabled={!text.trim()} onClick={send}>
            <Icon name="chat" /> باز کردن واتساپ
          </button>
          {bridge.status === 'connected' && (
            <button className="btn-primary" disabled={sending || (!text.trim() && !sheet)} onClick={sendDirect}>
              <Icon name="send" /> {sending ? 'در حال ارسال…' : sheet ? 'ارسال متن و عکس' : 'ارسال'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
