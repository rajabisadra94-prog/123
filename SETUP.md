# راه‌اندازی لوکال — نسخهٔ test.xfab.ir (commit 25a0300، ۷ سپتامبر ۲۰۲۶)

این پوشه دقیقاً همون کدیه که الان روی `test.xfab.ir` زنده‌ست (بک‌اند مستقیم از خود سرور
کشیده شده، فرانت از همون commit گیت‌هاب export شده). `.git` و `node_modules` عمداً نیستن.

## پیش‌نیاز
- Node.js نسخهٔ 20 یا بالاتر
- PostgreSQL 16 یا بالاتر (لوکال یا داکر)

## ۱) دیتابیس
یک دیتابیس و یوزر بساز که با `.env` هماهنگ باشه (یا `.env` رو عوض کن):

```bash
psql -U postgres -c "CREATE USER factory_user WITH PASSWORD 'factory_pass';"
psql -U postgres -c "CREATE DATABASE factory_local OWNER factory_user;"
```

سپس دامپ دیتای استیجینگ رو بریز توش (دیتای واقعی، برای تست کافیه):

```bash
gunzip -c staging_db_dump.sql.gz | psql -U factory_user -h localhost -d factory_local
```

> اگه دیتابیس محلی دیگه‌ای داری یا نمی‌خوای از این دیتا استفاده کنی، به‌جاش:
> `cd backend && npx prisma migrate deploy && npx prisma db seed`

## ۲) بک‌اند

```bash
cd backend
npm install
npx prisma generate
npm run dev
```

روی پورت 3001 بالا میاد. `.env` از قبل آماده‌ست (مقادیر لوکال، نه رمزهای سرور واقعی).

## ۳) فرانت

```bash
cd frontend
npm install
npm run dev
```

روی پورت 5173 بالا میاد و به‌صورت پیش‌فرض به `http://localhost:3001` وصل می‌شه.

## ورود تست
اگه دامپ دیتابیس استیجینگ رو ریختی، با کاربرهای همونجا وارد شو (یوزر/رمزها رو از صدرا بپرس).
اگه دیتابیس خالی seed کردی: `admin@factory.com` / `admin123`

## نکته دربارهٔ تحویل تغییرات
تغییرات رو در قالب یه **پچ/دیف** یا با کپی کل پوشهٔ نهایی (بدون `node_modules`) برگردون،
نه فقط توضیح — همین‌جوری آسون‌تر merge می‌شه.
