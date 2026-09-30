-- ورود با «نام کاربری» به‌جای ایمیل (نسخه ۱.۸.۰)
--
-- چرا دستی: افزودن یک ستون «اجباری و یکتا» به جدولی که از قبل رکورد دارد با
-- `prisma db push` ممکن نیست — اول باید ستون nullable ساخته و از روی ایمیلِ
-- موجود پر شود، بعد NOT NULL شود. این اسکریپت idempotent است؛ اجرای دوباره‌اش
-- بی‌خطر است. باید **پیش از** `prisma db push` اجرا شود.
--
-- اجرا:  psql "$DATABASE_URL" -f prisma/manual/2026-08-02-username-login.sql

BEGIN;

-- ۱) ستون نام کاربری (فعلاً nullable تا بتوان پرش کرد)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" TEXT;

-- ۲) پر کردن از روی ایمیلِ موجود — کاربران فعلی دقیقاً با همان چیزی که
--    تا امروز وارد می‌کردند وارد می‌شوند و هیچ‌کس بیرون نمی‌ماند
UPDATE "User" SET "username" = lower(trim("email")) WHERE "username" IS NULL AND "email" IS NOT NULL;

-- ۳) اگر کاربری ایمیل نداشت (نباید باشد، ولی محض احتیاط) از شناسه‌اش نام بساز
UPDATE "User" SET "username" = 'user-' || lower("id") WHERE "username" IS NULL;

-- ۴) یکتا و اجباری
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
ALTER TABLE "User" ALTER COLUMN "username" SET NOT NULL;

-- ۵) ایمیل دیگر اجباری نیست (یکتایی‌اش سر جایش می‌ماند؛ در پستگرس چند NULL مجاز است)
ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;

COMMIT;

-- بررسی:
--   SELECT name, username, email FROM "User" ORDER BY name;
