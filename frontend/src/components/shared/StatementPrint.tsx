import { useQuery } from '@tanstack/react-query'
import api, { API_ORIGIN } from '../../lib/api'
import { toShamsi } from '../../lib/date'

/**
 * سربرگ رسمیِ صورت‌های مالی — فقط هنگام چاپ دیده می‌شود (مرحلهٔ ۴ ب).
 *
 * تا امروز تنها راه بیرون بردن صورت‌های مالی، CSV بود. CSV برای کار کردن با
 * عدد خوب است ولی چیزی نیست که به بانک یا حسابرس بدهی: نه نام شرکت دارد، نه
 * عنوان صورت، نه تاریخ، نه واحد پول، و نه جای امضا.
 *
 * **چرا کتابخانهٔ PDF نیامد:** مرورگر خودش موتور PDF دارد و `Ctrl+P → ذخیره
 * به‌صورت PDF` همان خروجی را می‌دهد. jsPDF روی باندلِ ۱٫۲ مگابایتی نیم‌مگابایت
 * دیگر می‌خواست و — مهم‌تر — فارسیِ راست‌به‌چپ را باید دستی می‌چیدیم، چون
 * shaping عربی را خودش انجام نمی‌دهد. اینجا صفحه از قبل درست چیده شده.
 *
 * سربرگ همان `COMPANY_*` فاکتورهاست، پس شرکت یک بار تنظیم می‌شود نه دو بار.
 */
export function useCompanyInfo() {
  return useQuery({
    queryKey: ['settings', 'company-info'],
    queryFn: async () => (await api.get('/settings/company-info')).data as Record<string, string>,
    staleTime: 5 * 60_000,
  })
}

export function StatementPrintHead({ title, from, to, asOf, note }: {
  title: string
  from?: string | Date | null
  to?: string | Date | null
  asOf?: string | Date | null
  note?: string
}) {
  const { data: c } = useCompanyInfo()
  const name = c?.COMPANY_NAME || 'نام شرکت'
  const logo = c?.COMPANY_LOGO_URL ? `${API_ORIGIN}${c.COMPANY_LOGO_URL}` : null

  const period = asOf
    ? `در تاریخ ${toShamsi(asOf)}`
    : from && to ? `برای دورهٔ ${toShamsi(from)} تا ${toShamsi(to)}`
      : to ? `تا تاریخ ${toShamsi(to)}` : ''

  return (
    <div className="print-only statement-head">
      <div className="statement-head-top">
        {logo && <img src={logo} alt="" className="statement-logo" />}
        <div>
          <div className="statement-company">{name}</div>
          {c?.COMPANY_ADDRESS && <div className="statement-sub">{c.COMPANY_ADDRESS}</div>}
        </div>
      </div>
      <h1 className="statement-title">{title}</h1>
      {period && <div className="statement-period">{period}</div>}
      <div className="statement-unit">ارقام به ریال است</div>
      {note && <div className="statement-note">{note}</div>}
    </div>
  )
}

/** جای امضا — پایین هر صورت مالیِ چاپ‌شده */
export function StatementSignatures() {
  return (
    <div className="print-only statement-signs">
      {['مدیر مالی', 'مدیرعامل', 'حسابرس'].map((r) => (
        <div key={r} className="statement-sign">
          <div className="statement-sign-line" />
          <div>{r}</div>
        </div>
      ))}
    </div>
  )
}

/** دکمهٔ چاپ — کاری جز `window.print()` نمی‌کند؛ چیدمانِ چاپ کارِ CSS است */
export function PrintButton({ label = 'چاپ / PDF' }: { label?: string }) {
  return (
    <button type="button" className="btn-secondary btn-sm no-print" onClick={() => window.print()}>
      {label}
    </button>
  )
}
