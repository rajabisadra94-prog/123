// ─── ثبت اعلان Push (فقط داخل اپ نیتیو اندروید) ───────────────
// در مرورگر/PWA بی‌اثر است. توکن FCM را می‌گیرد و به سرور می‌فرستد.
import { Capacitor } from '@capacitor/core'
import api from './api'

let started = false

/** شناسهٔ کانال اعلان — بک‌اند هم همین را در payload می‌فرستد */
export const PUSH_CHANNEL_ID = 'fabrik_default'

export async function initPushNotifications() {
  if (started) return
  if (!Capacitor.isNativePlatform()) return // فقط اپ نیتیو
  started = true
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications')

    PushNotifications.addListener('registration', async (token) => {
      try { await api.post('/notifications/register-device', { token: token.value, platform: 'android' }) } catch { /* بعداً دوباره تلاش می‌شود */ }
    })
    PushNotifications.addListener('registrationError', (err) => console.warn('خطای ثبت Push:', err))

    let perm = await PushNotifications.checkPermissions()
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await PushNotifications.requestPermissions()
    }
    if (perm.receive !== 'granted') { started = false; return }

    // کانال با اهمیت بالا — بدون این، اندروید ۸+ اعلان را در کانال پیش‌فرضِ
    // کم‌اهمیت می‌گذارد: بی‌صدا و بدون پاپ‌آپ، طوری که کاربر اصلاً متوجه نمی‌شود.
    // createChannel روی اندروید بی‌اثر نیست ولی اگر پلتفرم پشتیبانی نکند خطا می‌دهد،
    // پس شکستش نباید کل راه‌اندازی را متوقف کند.
    try {
      await PushNotifications.createChannel({
        id: PUSH_CHANNEL_ID,
        name: 'اعلان‌های فابریک',
        description: 'یادآور وظایف، پیام‌های گفتگو و رویدادهای پروژه',
        importance: 5,        // MAX — صدا + نمایش روی صفحه
        visibility: 1,        // PUBLIC
        vibration: true,
        lights: true,
      })
    } catch (e) {
      console.warn('ساخت کانال اعلان انجام نشد:', e)
    }

    await PushNotifications.register()
  } catch (e) {
    started = false
    console.warn('راه‌اندازی Push شکست خورد:', e)
  }
}
