// ─── اعلان Push با FCM (Firebase Cloud Messaging) ───────────────────
// راه‌اندازی lazy: اگر فایل service account موجود نباشد، Push بی‌صدا غیرفعال می‌شود
// (اپ و سرور بدون آن هم کار می‌کنند؛ فقط اعلان پس‌زمینه نمی‌رود).
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import prisma from './prisma';

const SA_PATH = process.env.FCM_SA_PATH || resolve(process.cwd(), 'fcm-service-account.json');

let ready = false;
let disabled = false;

function ensureInit(): boolean {
  if (ready) return true;
  if (disabled) return false;
  try {
    if (!existsSync(SA_PATH)) {
      console.warn(`ℹ️ FCM غیرفعال: فایل کلید در ${SA_PATH} یافت نشد.`);
      disabled = true;
      return false;
    }
    const sa = JSON.parse(readFileSync(SA_PATH, 'utf8'));
    initializeApp({ credential: cert(sa) });
    ready = true;
    console.log('✅ FCM آماده شد.');
    return true;
  } catch (e) {
    console.error('✗ راه‌اندازی FCM شکست خورد:', (e as Error).message);
    disabled = true;
    return false;
  }
}

/**
 * ارسال اعلان Push به همهٔ دستگاه‌های کاربران داده‌شده.
 * توکن‌های نامعتبر خودکار از دیتابیس پاک می‌شوند. خطاها بلعیده می‌شوند تا جریان اصلی نشکند.
 */
export async function sendPushToUsers(
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<void> {
  try {
    if (!userIds.length) return;
    if (!ensureInit()) return;

    const rows = await prisma.deviceToken.findMany({
      where: { userId: { in: [...new Set(userIds)] } },
      select: { token: true },
    });
    const tokens = [...new Set(rows.map((r) => r.token))];
    if (!tokens.length) return;

    // channelId باید با کانالی که اپ می‌سازد یکی باشد (frontend/src/lib/push.ts).
    // بدون آن، اندروید ۸+ اعلان را به کانال پیش‌فرضِ کم‌اهمیت می‌برد و کاربر
    // اعلان را بی‌صدا و بدون پاپ‌آپ می‌گیرد — یعنی عملاً متوجهش نمی‌شود.
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: data || {},
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'fabrik_default',
          priority: 'max',
          defaultVibrateTimings: true,
        },
      },
    });

    // پاک‌سازی توکن‌های باطل‌شده
    const stale: string[] = [];
    res.responses.forEach((r: { success: boolean; error?: { code?: string } }, i: number) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
          stale.push(tokens[i]);
        }
      }
    });
    if (stale.length) {
      await prisma.deviceToken.deleteMany({ where: { token: { in: stale } } });
    }
  } catch (e) {
    console.error('✗ ارسال Push شکست خورد (نادیده گرفته شد):', (e as Error).message);
  }
}
