import { Request, Response } from 'express';

/* ============================================================
   گذرگاه رویدادهای زندهٔ گفتگو — Server-Sent Events

   چرا SSE و نه WebSocket؟
   جهتِ داده یک‌طرفه است (سرور → مرورگر)؛ ارسال پیام همان REST قبلی است.
   SSE روی همان HTTP کار می‌کند، پس نه وابستگی جدید می‌خواهد، نه تنظیمات
   جداگانه در Nginx برای ارتقای پروتکل، و اتصال قطع‌شده را خودِ مرورگر
   دوباره برقرار می‌کند. برای این حجم کاربر کاملاً کافی است.

   نکتهٔ استقرار: این نگهدارندهٔ حالت در حافظهٔ همین پروسه است. اگر روزی
   بک‌اند را چند-پروسه‌ای (cluster/PM2 -i) کردید، باید به Redis pub/sub
   منتقل شود وگرنه کاربرانِ روی پروسه‌های مختلف رویداد هم را نمی‌بینند.
   ============================================================ */

type Client = { userId: string; res: Response };

const clients = new Set<Client>();

export const bus = {
  /** ارسال رویداد به همهٔ اتصال‌های باز یک کاربر (چند تب/دستگاه) */
  emit(userId: string, payload: unknown) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) {
      if (c.userId !== userId) continue;
      try { c.res.write(data); } catch { clients.delete(c); }
    }
  },
  get connectionCount() { return clients.size; },
};

export function sseHandler(req: Request, res: Response) {
  const userId = req.user!.id;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // جلوگیری از بافر کردن پاسخ توسط Nginx
  });
  res.write('retry: 5000\n\n');

  const client: Client = { userId, res };
  clients.add(client);

  // ضربان: هم اتصال را از تایم‌اوت پراکسی نجات می‌دهد، هم قطع‌شدن را لو می‌دهد
  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { cleanup(); }
  }, 25_000);

  function cleanup() {
    clearInterval(beat);
    clients.delete(client);
  }

  req.on('close', cleanup);
  req.on('error', cleanup);
}
