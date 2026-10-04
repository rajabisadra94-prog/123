// منتظر می‌ماند تا دیتابیس محلی آماده شود (فایل .pgready ساخته شود)؛ حداکثر ۱۵ دقیقه
const fs = require('fs'); const path = require('path');
const flag = path.join(__dirname, '..', '.pgready');
const t0 = Date.now();
(function poll() {
  if (fs.existsSync(flag)) return process.exit(0);
  if (Date.now() - t0 > 15 * 60 * 1000) { console.error('دیتابیس آماده نشد. پنجره «دیتابیس» را بررسی کنید.'); process.exit(1); }
  setTimeout(poll, 2000);
})();
