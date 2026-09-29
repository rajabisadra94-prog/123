@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo ===== راه‌اندازی نسخه محلی فابریک =====

where node >nul 2>&1 || (echo Node.js نصب نیست. از https://nodejs.org نصب کنید. & pause & exit /b 1)
where psql >nul 2>&1 || (echo PostgreSQL نصب نیست یا psql در PATH نیست. از https://www.postgresql.org/download/windows نصب کنید. & pause & exit /b 1)

set /p PGPASS=رمز کاربر postgres (که موقع نصب PostgreSQL گذاشتید): 
set PGPASSWORD=%PGPASS%

psql -U postgres -h localhost -tAc "SELECT 1 FROM pg_roles WHERE rolname='factory_user'" | findstr 1 >nul || psql -U postgres -h localhost -c "CREATE USER factory_user WITH PASSWORD 'factory_pass' SUPERUSER;"
psql -U postgres -h localhost -tAc "SELECT 1 FROM pg_database WHERE datname='factory_local'" | findstr 1 >nul || psql -U postgres -h localhost -c "CREATE DATABASE factory_local OWNER factory_user;"

set PGPASSWORD=factory_pass
psql -U factory_user -h localhost -d factory_local -tAc "SELECT to_regclass('public.\"User\"')" | findstr User >nul
if errorlevel 1 (
  echo در حال ریختن دیتابیس نمونه...
  node -e "process.stdin.pipe(require('zlib').createGunzip()).pipe(process.stdout)" < staging_db_dump.sql.gz | psql -q -U factory_user -h localhost -d factory_local
)

if not exist backend\.env copy backend\.env.example backend\.env >nul

echo نصب بک‌اند...
pushd backend
call npm install || (echo نصب بک‌اند ناموفق بود & pause & exit /b 1)
call npx prisma generate
node scripts\local-reset-admin.js
popd

echo نصب فرانت...
pushd frontend
call npm install || (echo نصب فرانت ناموفق بود & pause & exit /b 1)
popd

start "بک‌اند" cmd /k "cd /d %~dp0backend && npm run dev"
start "فرانت" cmd /k "cd /d %~dp0frontend && npm run dev"
timeout /t 12 >nul
start http://localhost:5173
echo.
echo سایت باز شد: http://localhost:5173   ورود: admin@factory.com / admin123
echo برای توقف، دو پنجره بک‌اند و فرانت را ببندید.
pause
