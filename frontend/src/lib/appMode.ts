/**
 * حالت اجرای برنامه.
 *
 * `full` = پنل کامل فابریک (xfab.ir و test.xfab.ir).
 * `market` = فقط ماژول «بازار صادرات» (pooyan.xfab.ir) — همان بک‌اند و همان
 *   دیتابیس، ولی پوستهٔ برنامه بقیهٔ ماژول‌ها را نه نشان می‌دهد و نه مسیرشان را
 *   ثبت می‌کند. این «قفل امنیتی» نیست (دسترسی واقعی کار ماتریس نقش‌هاست)؛
 *   هدفش این است که کاربرِ کمپین تماس با یک صفحهٔ شلوغ روبه‌رو نشود.
 *
 * با `VITE_APP_MODE=market` موقع بیلد تعیین می‌شود.
 */
export type AppMode = 'full' | 'market'

export const APP_MODE: AppMode =
  (import.meta.env.VITE_APP_MODE as AppMode) === 'market' ? 'market' : 'full'

export const IS_MARKET_ONLY = APP_MODE === 'market'

/**
 * ارسال واتساپ از داخل سامانه (دکمهٔ واتساپ، قالب‌ها، برگهٔ محصولات، پلِ لپ‌تاپ).
 *
 * فعلاً به‌خواست کاربر خاموش است. کدش سرِ جایش مانده — بک‌اند، صف، و برنامهٔ
 * `whatsapp-bridge/` همه دست‌نخورده‌اند؛ فقط از رابط کاربری برداشته شده.
 * برای برگرداندن، همین یک مقدار را `true` کنید.
 */
export const WHATSAPP_SEND_ENABLED = false

/** صفحهٔ خانهٔ هر حالت — بعد از ورود و روی مسیرهای ناشناخته به این‌جا می‌رویم */
export const HOME_PATH = IS_MARKET_ONLY ? '/market' : '/dashboard'

/**
 * هویت برند هر حالت.
 *
 * یک باندل به دو دامنه سرو می‌شود، پس لوگو و نام نمی‌توانند در کد هاردکد
 * شوند: `xfab.ir` فابریک است و `pooyan.xfab.ir` پویان طب تیکا. دارایی‌های
 * هر دو کنار هم در `public/` می‌مانند و این‌جا انتخاب می‌شوند.
 */
export const BRAND = IS_MARKET_ONLY
  ? {
      name: 'پویان طب تیکا',
      latin: 'Tika Dent Plus',
      tagline: 'بازار صادرات — عراق',
      lockup: '/brand/tika/lockup.png',
      mark: '/brand/tika/mark.png',
    }
  : {
      name: 'فابریک',
      latin: 'Fabrik',
      tagline: 'مدیریت فرایند تولید',
      lockup: '/brand/logo-fa-mint.png',
      mark: '/brand/mark.png',
    }
