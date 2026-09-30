-- ═══════════════════════════════════════════════════════════════════════
-- بازنشسته‌کردن هستهٔ قدیمی — آخرین گام فاز ۹
--
-- ⛔ این فایل **خودکار اجرا نمی‌شود** و نباید بشود.
--
-- تا وقتی مهاجرت روی نسخهٔ آزمایشی تمرین نشده و هر چهار سنجهٔ پذیرش
-- (`docs/LEDGER_MIGRATION.md` بخش ۶) سبز نشده، اجرای این فایل یعنی از کار
-- انداختن سیستمِ در حال کار.
--
-- ترتیب درست:
--   ۱) بکاپ کامل
--   ۲) بازگردانی روی دیتابیس موقت و تمرین مهاجرت
--   ۳) اجرای verifyMigration و بازبینی انسانیِ گزارش
--   ۴) تکرار روی پروداکشن در پنجرهٔ خاموشی، با بکاپ تازه
--   ۵) **بعد** این فایل
--
-- اجرا:  psql "$DATABASE_URL" -f prisma/manual/2026-08-27-retire-legacy-core.sql
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────
-- گارد: بدون سند افتتاحیه، بازنشستگی معنا ندارد
-- ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  opening_count INT;
BEGIN
  SELECT count(*) INTO opening_count
    FROM "GlEntry" WHERE "entryType" = 'OPENING' AND "sourceType" = 'Migration';

  IF opening_count = 0 THEN
    RAISE EXCEPTION
      'سند افتتاحیهٔ مهاجرت پیدا نشد. پیش از بازنشسته‌کردن هستهٔ قدیمی، مهاجرت باید انجام و تأیید شده باشد.';
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────────
-- هستهٔ قدیمی فقط‌خواندنی می‌شود
--
-- داده **حذف نمی‌شود**: تاریخچهٔ سند‌به‌سندِ پیش از برش تنها جایی است که
-- جزئیات گذشته را دارد (سند افتتاحیه فقط مانده را منتقل می‌کند). پس جدول‌ها
-- می‌مانند و فقط نوشتن روی‌شان بسته می‌شود.
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION legacy_core_is_readonly() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'هستهٔ حسابداری قدیمی بازنشسته شده و فقط‌خواندنی است. از ماژول ledger استفاده کنید.'
    USING ERRCODE = 'read_only_sql_transaction';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'JournalLine', 'JournalEntry', 'JournalEntryRevision',
    'FinancialAccount', 'FiscalPeriod'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS legacy_readonly_trg ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER legacy_readonly_trg BEFORE INSERT OR UPDATE OR DELETE ON %I
       FOR EACH STATEMENT EXECUTE FUNCTION legacy_core_is_readonly()', t);
  END LOOP;
END $$;

COMMIT;

-- ───────────────────────────────────────────────────────────────
-- برگشت (اگر لازم شد پیش از پایدارشدن مهاجرت):
--
--   DROP TRIGGER legacy_readonly_trg ON "JournalLine";
--   DROP TRIGGER legacy_readonly_trg ON "JournalEntry";
--   DROP TRIGGER legacy_readonly_trg ON "JournalEntryRevision";
--   DROP TRIGGER legacy_readonly_trg ON "FinancialAccount";
--   DROP TRIGGER legacy_readonly_trg ON "FiscalPeriod";
-- ───────────────────────────────────────────────────────────────
