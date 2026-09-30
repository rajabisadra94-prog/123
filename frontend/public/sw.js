/* فابریک — Service Worker سبک (بدون کتابخانه)
   استراتژی:
   - ناوبری HTML: network-first → هر دیپلوی جدید فوراً دیده می‌شود؛ آفلاین از کش.
   - دارایی‌های hash‌دار (assets/…): cache-first با به‌روزرسانی پس‌زمینه.
   - درخواست‌های /api و /uploads هرگز کش نمی‌شوند (داده‌ی زنده). */
// با هر تغییرِ دارایی‌های ثابت (آیکون/مانیفست) این را بالا ببر —
// activate هر کشی را که با VERSION فعلی شروع نشود پاک می‌کند.
const VERSION = 'fabrik-v2';
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((c) => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // فقط same-origin؛ داده‌ی زنده هرگز کش نشود
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/uploads')) return;

  // ناوبری (HTML): network-first
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(RUNTIME_CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/')))
    );
    return;
  }

  // دارایی‌های ثابت: cache-first + رفرش پس‌زمینه (stale-while-revalidate)
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
