import axios from 'axios';
import * as outbox from './outbox';

// ریشهٔ سرور در یک جا — فایل‌های آپلودی، SSE و لینک‌های دانلود همه از همین می‌آیند.
// (هنوز جاهای دیگری localhost هاردکد دارند؛ باید همه به این منتقل شوند.)
//
// اگر VITE_API_URL موقع بیلد داده نشود، در پروداکشن «همان مبدأ صفحه» استفاده
// می‌شود. چون Nginx مسیر /api را روی همان دامنه پروکسی می‌کند، این باندل به
// دامنه گره نمی‌خورد: همان فایل روی http، https، دامنهٔ دیگر یا پورت دیگر
// کار می‌کند و برای هر آدرس جدید لازم نیست دوباره بیلد شود.
// در حالت توسعه همچنان بک‌اند محلی روی ۳۰۰۱ است.
export const API_ORIGIN =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD ? window.location.origin : 'http://localhost:3001');
export const fileUrl = (u?: string | null) =>
  !u ? '' : u.startsWith('http') ? u : `${API_ORIGIN}${u}`;

const api = axios.create({
  baseURL: `${API_ORIGIN}/api`,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (res) => {
    outbox.markOnline(true);
    return res;
  },
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      window.location.href = '/login';
      return Promise.reject(error);
    }

    // «پاسخی نیامد» یعنی درخواست اصلاً به سرور نرسید: اینترنت قطع، DNS خراب،
    // سرور خواب. با خطا دادن، چیزی که کاربر تایپ کرده بود از بین می‌رفت؛ پس
    // درخواست را در صندوق خروجی می‌گذاریم و همان‌جا موفق اعلامش می‌کنیم.
    // فقط مسیرهای /market و فقط درخواست‌های نوشتنیِ JSON — تصمیمش در outbox.
    const cfg: any = error.config;
    if (!error.response && cfg && !cfg.__replay && outbox.isQueueable(cfg)) {
      const item = outbox.enqueue(cfg);
      return Promise.resolve({
        data: { queued: true, outboxId: item.id },
        status: 202, statusText: 'Queued', headers: {}, config: cfg,
      });
    }
    return Promise.reject(error);
  },
);

// ارسال دوبارهٔ صف: همین نمونهٔ axios (تا هدر توکن بخورد) ولی با پرچمی که
// جلوی صف‌شدنِ دوبارهٔ همان درخواست را می‌گیرد.
outbox.setSender((item) =>
  api.request({ method: item.method, url: item.url, data: item.body, __replay: true } as any));

export default api;
