/**
 * سه راهِ واقعیِ رساندن یک فایل به واتساپ، به ترتیبِ کم‌دردسری.
 *
 * پس‌زمینه: پروتکل `wa.me` فقط پارامتر `text` دارد. هیچ نسخه‌ای از واتساپ
 * اجازه نمی‌دهد لینک، فایل پیوست کند. پس فایل باید از بیرونِ لینک برسد:
 *
 *  ۱. `navigator.share` — روی ویندوز/مک پنجرهٔ «اشتراک‌گذاری» سیستم باز می‌شود
 *     و اگر اپ دسکتاپ واتساپ نصب باشد خودش یکی از مقصدهاست. نزدیک‌ترین چیز
 *     به «ارسال مستقیم». روی فایرفاکس دسکتاپ وجود ندارد.
 *  ۲. کلیپ‌بورد — در واتساپ‌وب با Ctrl+V می‌چسبد و کادر عنوان باز می‌شود.
 *  ۳. دانلود — همیشه کار می‌کند، ولی کاربر باید دستی 📎 بزند.
 */

/** آیا مرورگر می‌تواند فایل را به اپ‌های سیستم بدهد؟ با یک فایلِ آزمایشی سنجیده می‌شود */
export function canShareFiles(): boolean {
  try {
    if (!navigator.share || !navigator.canShare) return false
    const probe = new File([new Blob(['x'], { type: 'image/png' })], 'probe.png', { type: 'image/png' })
    return navigator.canShare({ files: [probe] })
  } catch { return false }
}

export async function shareFiles(files: File[], opts?: { title?: string; text?: string }) {
  await navigator.share({ files, ...(opts?.title ? { title: opts.title } : {}), ...(opts?.text ? { text: opts.text } : {}) })
}

/**
 * فقط PNG را همهٔ مرورگرها در کلیپ‌بورد می‌پذیرند، پس JPEG/WebP اول روی بوم
 * به PNG تبدیل می‌شود؛ وگرنه مرورگر بی‌صدا ردش می‌کند.
 */
export async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d')!.drawImage(bmp, 0, 0)
  return new Promise<Blob>((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error('تبدیل نشد'))), 'image/png'))
}

export async function copyImage(blob: Blob) {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': await toPng(blob) })])
}

export const copyText = (text: string) => navigator.clipboard.writeText(text)

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // بلافاصله آزاد نکن — بعضی مرورگرها هنوز در حال خواندنش‌اند
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export const blobToFile = (blob: Blob, name: string) =>
  new File([blob], name, { type: blob.type || 'application/octet-stream' })

/** فایلِ یک پیوستِ ذخیره‌شده روی سرور را می‌آورد تا بشود اشتراکش گذاشت یا کپی‌اش کرد */
export async function fetchAsFile(url: string, name: string): Promise<File> {
  const res = await fetch(url)
  if (!res.ok) throw new Error('فایل خوانده نشد')
  return blobToFile(await res.blob(), name)
}
