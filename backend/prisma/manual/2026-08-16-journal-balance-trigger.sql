-- اجبار قانون تراز در سطح دیتابیس (docs/accounting-spec.md بخش ۲-۲)
--
-- چرا تریگر معمولی کار نمی‌کند: ردیف‌های یک سند یکی‌یکی درج می‌شوند، پس تریگرِ
-- AFTER INSERT معمولی بعد از اولین ردیف شلیک می‌کند و همیشه سند را ناتراز می‌بیند.
-- راه‌حل: CONSTRAINT TRIGGER با DEFERRABLE INITIALLY DEFERRED که ارزیابی‌اش تا
-- **پایان تراکنش** عقب می‌افتد — یعنی وقتی همهٔ ردیف‌ها درج شده‌اند.
--
-- دقت: اختلاف به ۲ رقم اعشار گرد می‌شود و صفرِ دقیق خواسته می‌شود (نه تلورانس نسبی)،
-- دقیقاً همان قاعده‌ای که assertBalanced در لایهٔ اپلیکیشن اعمال می‌کند.
--
-- ⚠️ پیش از اجرا حتماً گزارش اسناد ناتراز گرفته شود (کوئری انتهای فایل)؛
--    اگر سند ناترازِ تاریخی وجود داشته باشد اولین UPDATE روی آن شکست می‌خورد.
--
-- اجرا:  psql "$DATABASE_URL" -f prisma/manual/2026-08-16-journal-balance-trigger.sql

BEGIN;

CREATE OR REPLACE FUNCTION assert_journal_balanced() RETURNS TRIGGER AS $$
DECLARE
  target_entry TEXT;
  diff NUMERIC;
  line_count INT;
BEGIN
  target_entry := COALESCE(NEW."entryId", OLD."entryId");

  SELECT count(*), COALESCE(round(SUM(debit * "rateToIRR") - SUM(credit * "rateToIRR"), 2), 0)
    INTO line_count, diff
    FROM "JournalLine" WHERE "entryId" = target_entry;

  -- سندی که همهٔ ردیف‌هایش حذف شده‌اند (مثلاً هنگام ویرایش) بررسی نمی‌شود؛
  -- ردیف‌های جدید در همان تراکنش درج می‌شوند و آن‌وقت دوباره سنجیده می‌شود.
  IF line_count = 0 THEN
    RETURN NULL;
  END IF;

  IF line_count < 2 THEN
    RAISE EXCEPTION 'سند % حداقل به دو ردیف نیاز دارد (الان % ردیف دارد)', target_entry, line_count
      USING ERRCODE = 'check_violation';
  END IF;

  IF diff <> 0 THEN
    RAISE EXCEPTION 'سند % تراز نیست: اختلاف بدهکار و بستانکار % تومان', target_entry, diff
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_must_balance ON "JournalLine";

CREATE CONSTRAINT TRIGGER journal_must_balance
  AFTER INSERT OR UPDATE OR DELETE ON "JournalLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_journal_balanced();

COMMIT;

-- ─────────────────────────────────────────────────────────────
-- گزارش تشخیصی: اسناد ناتراز (پیش از فعال‌سازی تریگر اجرا شود)
--
-- SELECT e."entryNo", e.description,
--        round(SUM(l.debit * l."rateToIRR") - SUM(l.credit * l."rateToIRR"), 2) AS اختلاف
-- FROM "JournalEntry" e JOIN "JournalLine" l ON l."entryId" = e.id
-- GROUP BY e.id, e."entryNo", e.description
-- HAVING round(SUM(l.debit * l."rateToIRR") - SUM(l.credit * l."rateToIRR"), 2) <> 0
-- ORDER BY e."entryNo";
