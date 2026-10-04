@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ===== راه‌اندازی نسخه محلی فابریک =====
echo نیازی به نصب PostgreSQL نیست؛ دیتابیس خودکار با npm دانلود می‌شود.

where node >nul 2>&1 || (echo Node.js نصب نیست. از https://nodejs.org نصب کنید. & pause & exit /b 1)

if not exist backend\.env copy backend\.env.example backend\.env >nul

echo نصب بک‌اند (بار اول چند دقیقه طول می‌کشد)...
pushd backend
call npm install || (echo نصب بک‌اند ناموفق بود & pause & exit /b 1)
call npx prisma generate
popd

echo نصب فرانت...
pushd frontend
call npm install || (echo نصب فرانت ناموفق بود & pause & exit /b 1)
popd

if exist backend\.pgready del backend\.pgready
start "دیتابیس" cmd /k "cd /d %~dp0backend && node scripts\embedded-db.mjs"
echo منتظر آماده شدن دیتابیس (بار اول ریختن دیتای نمونه چند دقیقه طول می‌کشد)...
node backend\scripts\wait-db.js || (pause & exit /b 1)

pushd backend
node scripts\apply-local-migrations.js
node scripts\local-reset-admin.js
popd

start "بک‌اند" cmd /k "cd /d %~dp0backend && npm run dev"
start "فرانت" cmd /k "cd /d %~dp0frontend && npm run dev"
timeout /t 12 >nul
start http://localhost:5173
echo.
echo سایت باز شد: http://localhost:5173   ورود: admin@factory.com / admin123
echo برای توقف، سه پنجره دیتابیس و بک‌اند و فرانت را ببندید.
pause
