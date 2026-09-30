import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import App from './App.tsx'
import { DialogProvider } from './components/ui/dialog'
import { IS_MARKET_ONLY, BRAND } from './lib/appMode'

/**
 * هویت بصری در زمان اجرا اعمال می‌شود.
 *
 * `index.html` یکی است و همان باندل به `xfab.ir` (فابریک) و
 * `pooyan.xfab.ir` (پویان طب تیکا) سرو می‌شود، پس عنوان، لوگو، فاو‌آیکون و
 * مانیفست نمی‌توانند در HTML هاردکد بمانند.
 *
 * فقط **هویت** عوض می‌شود، نه پالت رنگی: کاربر پالت خاکستریِ برند را دید و
 * ترجیح داد رنگ‌های قبلی بماند، پس تم مشترک است و همین‌جا دست نمی‌خورد.
 */
if (IS_MARKET_ONLY) {
  document.title = `${BRAND.name} | ${BRAND.tagline}`

  const setAttr = (selector: string, attr: string, value: string) => {
    const el = document.querySelector(selector)
    if (el) el.setAttribute(attr, value)
  }
  setAttr('link[rel="icon"][sizes="32x32"]', 'href', '/tika-favicon-32.png')
  setAttr('link[rel="icon"][sizes="48x48"]', 'href', '/tika-favicon-48.png')
  setAttr('link[rel="icon"][sizes="192x192"]', 'href', '/tika-pwa-192.png')
  setAttr('link[rel="icon"][sizes="512x512"]', 'href', '/tika-pwa-512.png')
  setAttr('link[rel="apple-touch-icon"]', 'href', '/tika-favicon-180.png')
  setAttr('link[rel="manifest"]', 'href', '/tika.webmanifest')
  setAttr('meta[name="apple-mobile-web-app-title"]', 'content', BRAND.name)
  // فاو‌آیکون ico مالِ فابریک است و اگر بماند بعضی مرورگرها همان را ترجیح می‌دهند
  document.querySelector('link[rel="icon"][type="image/x-icon"]')?.remove()
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DialogProvider>
        <App />
      </DialogProvider>
    </QueryClientProvider>
  </StrictMode>,
)

// ثبت Service Worker (PWA) — فقط در بیلد پروداکشن؛ در حالت توسعه غیرفعال تا با HMR تداخل نکند
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
