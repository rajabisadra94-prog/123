import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

/** کامیت جاری — اگر گیت در دسترس نبود (مثلاً بیلد از روی آرشیو)، خالی می‌ماند */
function gitCommit(): string {
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
  catch { return '' }
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // تلهٔ استقرار: Vite مقدار متغیرها را هنگام بیلد داخل باندل جاسازی می‌کند.
  // اگر روی سرور بدون VITE_API_URL بیلد بگیرید، فایل‌های نهایی برای همیشه به
  // localhost:3001 اشاره می‌کنند و سامانه روی مرورگرِ کاربران کار نمی‌کند —
  // بدون هیچ خطای بیلدی. پس همین‌جا جلویش را می‌گیریم.
  const apiUrl = process.env.VITE_API_URL
  if (command === 'build' && mode === 'production' && !apiUrl) {
    console.warn(
      '\n⚠️  VITE_API_URL تنظیم نشده — باندل به http://localhost:3001 اشاره خواهد کرد.' +
      '\n   برای استقرار روی سرور:  VITE_API_URL=https://your-domain.com npm run build\n'
    )
  }

  return {
    plugins: [react(), tailwindcss()],
    // نسخه و کامیت در زمان بیلد جاسازی می‌شوند تا در رابط کاربری دیده شوند
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __APP_COMMIT__: JSON.stringify(process.env.GIT_COMMIT || gitCommit()),
      __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
    },
  }
})
