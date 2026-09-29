import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ir.xfab.app',
  appName: 'Fabrik',
  webDir: 'dist',
  android: {
    // اسکیمای https برای وب‌ویو → origin اپ = https://localhost
    // (بک‌اند باید این origin را در CORS بپذیرد)
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
    // اپ مستقیماً سایت زنده را بارگذاری می‌کند → هر تغییر وب بدون ساخت مجدد APK دیده می‌شود
    // (مثل PWA در iOS). فقط تغییرات نیتیو (آیکون/پلاگین) نیاز به rebuild دارند.
    url: 'https://xfab.ir',
    cleartext: false,
  },
};

export default config;
