import { createPortal } from 'react-dom'

/**
 * مودال را به‌جای جای خودش در درخت، مستقیم زیر <body> رندر می‌کند.
 *
 * چرا لازم است: `.modal-overlay` با `position:fixed; z-index:1000` ساخته شده، ولی
 * اگر داخل عنصری رندر شود که خودش stacking context می‌سازد (مثل
 * `.project-info-card` که `position:sticky` دارد)، آن z-index داخل همان عنصر
 * محبوس می‌شود. آن‌وقت هر عنصر دیگری در صفحه که stacking context بسازد
 * (`opacity<1`، `filter`، `will-change`، `transform`) و در DOM بعد از آن کانتینر
 * بیاید، روی مودال می‌افتد — مثل دکمهٔ 🕐 جدول قطعات که روی پنجرهٔ
 * «کمیسیون و هزینه حمل» دیده می‌شد.
 *
 * با portal به body، مودال در stacking context ریشه می‌نشیند و z-index آن واقعاً
 * نسبت به کل صفحه سنجیده می‌شود.
 */
export default function ModalPortal({ children }: { children: React.ReactNode }) {
  return createPortal(children, document.body)
}
