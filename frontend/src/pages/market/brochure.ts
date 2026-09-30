import { fileUrl } from '../../lib/api'

/**
 * «برگهٔ محصولات» — چند محصول را روی **یک** تصویر می‌چیند.
 *
 * چرا اصلاً ساخته شد: لینک `wa.me` فقط `?text=` دارد و هیچ راهی برای پیوست‌کردن
 * فایل ندارد؛ این محدودیتِ خودِ پروتکل است، نه چیزی که بشود دورش زد. تنها
 * راه‌های واقعیِ رساندن عکس به واتساپ عبارت‌اند از Ctrl+V در واتساپ‌وب،
 * اشتراک‌گذاریِ سیستم‌عامل، یا پیوست دستی — و هر سه «یک فایل در هر بار» را
 * راحت انجام می‌دهند و «شش فایل» را سخت.
 *
 * پس به‌جای جنگیدن با محدودیت، تعداد فایل را کم می‌کنیم: n محصول → ۱ تصویر.
 * همان یک تصویر با یک Ctrl+V می‌رود و متن پیام هم همه را با هم پوشش می‌دهد.
 *
 * همه‌چیز سمتِ مرورگر روی canvas کشیده می‌شود؛ نه سرویس بیرونی لازم است نه
 * رفت‌وبرگشت با سرور. تصاویر با fetch→blob→createImageBitmap خوانده می‌شوند
 * تا بوم tainted نشود و `toBlob` کار کند.
 */

export type BrochureProduct = {
  name: string
  nameAr?: string | null
  nameEn?: string | null
  unit?: string | null
  moq?: string | null
  listPriceUsd?: number | null
  imageUrl?: string | null
}

export type BrochureOptions = {
  title: string          // نام شرکت
  subtitle?: string      // خط دوم سربرگ (لاتین یا شعار)
  footer?: string        // خط تماس پایین برگه
  iqdPerUsd?: number | null
  logoUrl?: string | null
}

const W = 1000
const PAD = 44
const HEAD_H = 168
const ROW_H = 196
const FOOT_H = 104

const BRAND = '#0f5569'
const BRAND_DARK = '#0a3a49'
const INK = '#15333b'
const MUTED = '#5a757c'
const LINE = '#d3e0e2'
const FONT = "'Vazirmatn', 'Segoe UI', Tahoma, Arial, sans-serif"

const f = (weight: number, size: number) => `${weight} ${size}px ${FONT}`

/**
 * `/uploads/...` روی سرور بک‌اند است و باید از مبدأ API بیاید؛ بقیهٔ مسیرها
 * (مثل `/brand/...`) دارایی‌های خودِ فرانت‌اند‌اند و در حالت توسعه پورتشان
 * فرق می‌کند — عبور دادنشان از fileUrl باعث ۴۰۴ می‌شد و لوگو غایب می‌ماند.
 */
const assetUrl = (u: string) => (u.startsWith('/uploads/') ? fileUrl(u) : u)

/** تصویر را طوری می‌خواند که بوم آلوده نشود؛ خطا را می‌بلعد چون نبودِ عکس نباید کل برگه را از کار بیندازد */
async function loadBitmap(url?: string | null): Promise<ImageBitmap | null> {
  if (!url) return null
  try {
    const res = await fetch(assetUrl(url), { cache: 'force-cache' })
    if (!res.ok) return null
    return await createImageBitmap(await res.blob())
  } catch { return null }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** «cover» — عکس محصول با نسبت‌های مختلف می‌آید و نباید کشیده شود */
function drawCover(ctx: CanvasRenderingContext2D, img: ImageBitmap, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / img.width, h / img.height)
  const dw = img.width * scale, dh = img.height * scale
  ctx.save()
  roundRect(ctx, x, y, w, h, 12)
  ctx.clip()
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
  ctx.restore()
}

/** متن را در عرضِ داده‌شده کوتاه می‌کند — نام‌های بلند نباید از کادر بزنند بیرون */
function clamp(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let t = text
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1)
  return t + '…'
}

/**
 * خطِ قیمت عمداً فقط لاتین/عدد است.
 * واحد فارسی («عدد»، «دستگاه») داخل یک رشتهٔ چپ‌به‌راست، ترتیب کاراکترها را
 * به‌هم می‌ریخت و «‎$12.5 / عدد» روی بوم به شکل «عدد / 12.5$» در می‌آمد.
 * واحد به خط راست‌به‌چپِ پایین منتقل شده.
 */
export const priceLine = (p: BrochureProduct, iqd?: number | null): string => {
  if (p.listPriceUsd == null) return ''
  const usd = `$${Number(p.listPriceUsd).toLocaleString('en-US')}`
  // دینار را فقط وقتی می‌آوریم که نرخ تعیین شده باشد؛ عدد نصفه بدتر از نبودنش است
  const iqdTxt = iqd ? ` ≈ ${Math.round(Number(p.listPriceUsd) * iqd).toLocaleString('en-US')} IQD` : ''
  return usd + iqdTxt
}

export async function renderBrochure(products: BrochureProduct[], o: BrochureOptions): Promise<Blob> {
  // بدون این، اولین ساختِ برگه با فونت جایگزین کشیده می‌شود و عربی‌اش زشت می‌افتد
  if ((document as any).fonts?.ready) { try { await (document as any).fonts.ready } catch { /* مهم نیست */ } }

  const rows = products.length
  const footH = o.footer?.trim() ? FOOT_H : 0
  const H = HEAD_H + rows * ROW_H + footH
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.direction = 'rtl'
  ctx.textBaseline = 'alphabetic'

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  // ─── سربرگ ───
  const grad = ctx.createLinearGradient(W, 0, 0, HEAD_H)
  grad.addColorStop(0, BRAND_DARK)
  grad.addColorStop(1, BRAND)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, W, HEAD_H)

  const logo = await loadBitmap(o.logoUrl)
  let headRight = W - PAD
  if (logo) {
    const lh = 72, lw = Math.min(240, (logo.width / logo.height) * lh)
    ctx.drawImage(logo, headRight - lw, (HEAD_H - lh) / 2, lw, lh)
    headRight -= lw + 26
  }

  ctx.textAlign = 'right'
  ctx.fillStyle = '#ffffff'
  ctx.font = f(800, 40)
  ctx.fillText(clamp(ctx, o.title, headRight - PAD), headRight, o.subtitle ? HEAD_H / 2 + 2 : HEAD_H / 2 + 14)
  if (o.subtitle) {
    ctx.font = f(500, 21)
    ctx.fillStyle = '#a9cdd5'
    ctx.fillText(clamp(ctx, o.subtitle, headRight - PAD), headRight, HEAD_H / 2 + 38)
  }

  // ─── ردیف هر محصول ───
  const bitmaps = await Promise.all(products.map((p) => loadBitmap(p.imageUrl)))

  for (let i = 0; i < rows; i++) {
    const p = products[i]
    const top = HEAD_H + i * ROW_H
    const imgSize = 148
    const imgX = W - PAD - imgSize
    const imgY = top + (ROW_H - imgSize) / 2

    if (i > 0) {
      ctx.strokeStyle = LINE
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(PAD, top + 0.5); ctx.lineTo(W - PAD, top + 0.5); ctx.stroke()
    }

    const bmp = bitmaps[i]
    if (bmp) {
      drawCover(ctx, bmp, imgX, imgY, imgSize, imgSize)
    } else {
      // بدون عکس هم برگه باید آبرومند باشد: کاشیِ حرفِ اولِ نام
      ctx.fillStyle = '#eaf3f4'
      roundRect(ctx, imgX, imgY, imgSize, imgSize, 12)
      ctx.fill()
      ctx.fillStyle = '#93b7bf'
      ctx.font = f(800, 56)
      ctx.textAlign = 'center'
      ctx.fillText((p.nameAr || p.name).trim().slice(0, 1), imgX + imgSize / 2, imgY + imgSize / 2 + 20)
      ctx.textAlign = 'right'
    }

    const tx = imgX - 26
    const maxW = tx - PAD
    let y = imgY + 34

    ctx.fillStyle = INK
    ctx.font = f(800, 32)
    ctx.fillText(clamp(ctx, p.nameAr || p.name, maxW), tx, y)

    const latin = p.nameEn || (p.nameAr ? p.name : '')
    if (latin) {
      y += 32
      ctx.fillStyle = MUTED
      ctx.font = f(500, 20)
      ctx.fillText(clamp(ctx, latin, maxW), tx, y)
    }

    const price = priceLine(p, o.iqdPerUsd)
    if (price) {
      y += 40
      ctx.fillStyle = BRAND
      ctx.font = f(800, 27)
      ctx.direction = 'ltr'
      ctx.fillText(clamp(ctx, price, maxW), tx, y)
      ctx.direction = 'rtl'
    }
    const extra = [p.unit ? `الوحدة: ${p.unit}` : '', p.moq ? `أقل كمية: ${p.moq}` : ''].filter(Boolean).join('  ·  ')
    if (extra) {
      y += 30
      ctx.fillStyle = MUTED
      ctx.font = f(500, 19)
      ctx.fillText(clamp(ctx, extra, maxW), tx, y)
    }
  }

  // ─── پاورقی ───
  if (footH) {
    const fy = H - footH
    ctx.fillStyle = '#eaf3f4'
    ctx.fillRect(0, fy, W, footH)
    ctx.fillStyle = BRAND_DARK
    ctx.font = f(700, 23)
    ctx.textAlign = 'center'
    ctx.direction = 'ltr'
    ctx.fillText(clamp(ctx, o.footer!.trim(), W - PAD * 2), W / 2, fy + footH / 2 + 9)
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('تصویر ساخته نشد'))), 'image/png')
  })
}
