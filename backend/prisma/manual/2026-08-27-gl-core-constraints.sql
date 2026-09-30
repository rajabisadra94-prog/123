-- ═══════════════════════════════════════════════════════════════════════
-- اجبار پنج قاعدهٔ تخطی‌ناپذیر در سطح دیتابیس — docs/ACCOUNTING_SPEC.md بخش ۲
--
-- این فایل بخشی از تعریف دامنه است، نه یک افزونهٔ اختیاری. Prisma نمی‌تواند
-- CHECK و CONSTRAINT TRIGGER بسازد، پس اینجا دستی نگه داشته می‌شوند.
--
-- اجرا:  psql "$DATABASE_URL" -f prisma/manual/2026-08-27-gl-core-constraints.sql
-- idempotent است و می‌شود چند بار اجرا کرد.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ───────────────────────────────────────────────────────────────
-- ارز: دقیقاً یک ارز پایه
-- ───────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS gl_currency_single_base;
CREATE UNIQUE INDEX gl_currency_single_base
  ON "GlCurrency" (("isBase")) WHERE "isBase";

ALTER TABLE "GlCurrency" DROP CONSTRAINT IF EXISTS gl_currency_decimals_sane;
ALTER TABLE "GlCurrency" ADD CONSTRAINT gl_currency_decimals_sane
  CHECK ("decimalPlaces" BETWEEN 0 AND 6);

-- ───────────────────────────────────────────────────────────────
-- نرخ ارز باید مثبت باشد  (ممیزی دوم — ن۲)
--
-- `GlLine` از روز اول `gl_line_rate_positive` داشت، ولی جدولِ **منبعِ** نرخ
-- هیچ قیدی نداشت. نتیجه: `POST /ledger/fx/rates` با `rate: "0"` یا منفی، ۲۰۰
-- می‌گرفت و در دفتر می‌نشست. ردیفِ سند را تریگر می‌گرفت، ولی تجدید ارزیابی
-- سندِ **متوازنِ خودش** را می‌سازد: یک نرخ صفر، کلِ یک موضع ارزی را صفر ارزیابی
-- می‌کند و زیانِ ساختگیِ میلیاردی ثبت می‌کند بی‌آنکه چیزی بگیردش.
--
-- ردیف‌های آلودهٔ موجود پیش از افزودن قید پاک می‌شوند: نرخِ نامثبت داده نیست،
-- خرابی است — نگه‌داشتنش فقط ضرر دارد و افزودن قید را هم شکست می‌دهد.
-- ───────────────────────────────────────────────────────────────
DO $$
DECLARE
  bad INT;
BEGIN
  SELECT count(*) INTO bad FROM "GlExchangeRate" WHERE rate <= 0;
  IF bad > 0 THEN
    RAISE NOTICE 'ممیزی ن۲: % ردیف نرخِ نامثبت پاک شد', bad;
    DELETE FROM "GlExchangeRate" WHERE rate <= 0;
  END IF;
END $$;

ALTER TABLE "GlExchangeRate" DROP CONSTRAINT IF EXISTS gl_exchange_rate_positive;
ALTER TABLE "GlExchangeRate" ADD CONSTRAINT gl_exchange_rate_positive
  CHECK (rate > 0);

-- ───────────────────────────────────────────────────────────────
-- بودجه: یک ردیف به‌ازای هر (سال مالی × حساب × مرکز هزینه)
--
-- چرا دو ایندکس جزئی و نه یک UNIQUE ساده: پستگرس NULL را در ایندکس یکتا
-- **متمایز** می‌شمارد، پس `UNIQUE(fy, account, costCenter)` برای ردیف‌های
-- بدون مرکز هزینه هیچ چیزی نمی‌گیرد و می‌شود بی‌نهایت بودجهٔ تکراری ثبت کرد.
-- ───────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS gl_budget_unique_with_cc;
CREATE UNIQUE INDEX gl_budget_unique_with_cc
  ON "GlBudget" ("fiscalYearId", "accountId", "costCenterId")
  WHERE "costCenterId" IS NOT NULL;

DROP INDEX IF EXISTS gl_budget_unique_no_cc;
CREATE UNIQUE INDEX gl_budget_unique_no_cc
  ON "GlBudget" ("fiscalYearId", "accountId")
  WHERE "costCenterId" IS NULL;

-- ───────────────────────────────────────────────────────────────
-- قاعدهٔ ۱ — ردیف معتبر: یک‌سویه و نامنفی
-- ───────────────────────────────────────────────────────────────
ALTER TABLE "GlLine" DROP CONSTRAINT IF EXISTS gl_line_one_sided;
ALTER TABLE "GlLine" ADD CONSTRAINT gl_line_one_sided
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0));

ALTER TABLE "GlLine" DROP CONSTRAINT IF EXISTS gl_line_non_negative;
ALTER TABLE "GlLine" ADD CONSTRAINT gl_line_non_negative
  CHECK (debit >= 0 AND credit >= 0 AND "debitBase" >= 0 AND "creditBase" >= 0);

-- سمتِ مبلغ پایه باید با سمتِ مبلغ ارزی یکی باشد
ALTER TABLE "GlLine" DROP CONSTRAINT IF EXISTS gl_line_base_same_side;
ALTER TABLE "GlLine" ADD CONSTRAINT gl_line_base_same_side
  CHECK ((debit > 0) = ("debitBase" > 0) AND (credit > 0) = ("creditBase" > 0));

ALTER TABLE "GlLine" DROP CONSTRAINT IF EXISTS gl_line_rate_positive;
ALTER TABLE "GlLine" ADD CONSTRAINT gl_line_rate_positive
  CHECK (rate > 0);

-- ───────────────────────────────────────────────────────────────
-- قاعدهٔ ۱ — قواعد حساب برای هر ردیف
--   • ثبت فقط روی برگ
--   • تفصیلی و مرکز هزینهٔ اجباری
--   • نوع تفصیلی مجاز
--   • ارزِ حساب تک‌ارزی
--   • سازگاری مبلغ پایه با نرخ (قاعدهٔ ۵)
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_line_rules() RETURNS TRIGGER AS $$
DECLARE
  acc            RECORD;
  sub_kind       "GlSubsidiaryKind";
  foreign_dec    INT;
  base_dec       INT;
  expected_base  NUMERIC;
  actual_base    NUMERIC;
  amount_foreign NUMERIC;
BEGIN
  SELECT * INTO acc FROM "GlAccount" WHERE id = NEW."accountId";
  IF acc IS NULL THEN
    RAISE EXCEPTION 'حساب % یافت نشد', NEW."accountId" USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT acc."isPostable" THEN
    RAISE EXCEPTION 'حساب «% %» سرگروه است و سند نمی‌گیرد', acc.code, acc.name
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT acc."isActive" THEN
    RAISE EXCEPTION 'حساب «% %» غیرفعال است', acc.code, acc.name
      USING ERRCODE = 'check_violation';
  END IF;

  -- تفصیلی
  IF acc."requiresSubsidiary" AND NEW."subsidiaryId" IS NULL THEN
    RAISE EXCEPTION 'حساب «% %» تفصیلی اجباری دارد', acc.code, acc.name
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."subsidiaryId" IS NOT NULL THEN
    SELECT kind INTO sub_kind FROM "GlSubsidiary" WHERE id = NEW."subsidiaryId";
    IF array_length(acc."subsidiaryKinds", 1) IS NOT NULL
       AND NOT (sub_kind = ANY (acc."subsidiaryKinds")) THEN
      RAISE EXCEPTION 'تفصیلی از نوع % زیر حساب «% %» مجاز نیست', sub_kind, acc.code, acc.name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- مرکز هزینه
  IF acc."requiresCostCenter" AND NEW."costCenterId" IS NULL THEN
    RAISE EXCEPTION 'حساب «% %» مرکز هزینهٔ اجباری دارد', acc.code, acc.name
      USING ERRCODE = 'check_violation';
  END IF;

  -- ارز حساب تک‌ارزی
  IF acc."currencyMode" = 'SINGLE'
     AND acc."currencyCode" IS NOT NULL
     AND acc."currencyCode" <> NEW."currencyCode" THEN
    RAISE EXCEPTION 'حساب «% %» فقط ارز % می‌پذیرد، نه %',
      acc.code, acc.name, acc."currencyCode", NEW."currencyCode"
      USING ERRCODE = 'check_violation';
  END IF;

  -- قاعدهٔ ۵ — مبلغ پایه باید با نرخ بخواند.
  -- تلورانس ۱ واحد کوچک، چون گرد کردن اجتناب‌ناپذیر است.
  SELECT "decimalPlaces" INTO foreign_dec FROM "GlCurrency" WHERE code = NEW."currencyCode";
  SELECT "decimalPlaces" INTO base_dec    FROM "GlCurrency" WHERE "isBase";
  IF foreign_dec IS NULL THEN
    RAISE EXCEPTION 'ارز % تعریف نشده است', NEW."currencyCode" USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF base_dec IS NULL THEN
    RAISE EXCEPTION 'هیچ ارز پایه‌ای تعریف نشده است' USING ERRCODE = 'check_violation';
  END IF;

  amount_foreign := GREATEST(NEW.debit, NEW.credit);
  actual_base    := GREATEST(NEW."debitBase", NEW."creditBase");
  expected_base  := round(amount_foreign / power(10::numeric, foreign_dec)
                          * NEW.rate * power(10::numeric, base_dec));

  IF abs(actual_base - expected_base) > 1 THEN
    RAISE EXCEPTION 'مبلغ پایه با نرخ نمی‌خواند: انتظار % ، ثبت‌شده % (ارز % نرخ %)',
      expected_base, actual_base, NEW."currencyCode", NEW.rate
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gl_line_rules_trg ON "GlLine";
CREATE TRIGGER gl_line_rules_trg
  BEFORE INSERT OR UPDATE ON "GlLine"
  FOR EACH ROW EXECUTE FUNCTION gl_line_rules();

-- ───────────────────────────────────────────────────────────────
-- قاعدهٔ ۱ — توازن سند (تریگر معوق)
--
-- چرا معوق: ردیف‌ها یکی‌یکی درج می‌شوند؛ تریگر معمولی بعد از ردیف اول
-- همیشه سند را ناتراز می‌بیند.
--
-- ⚠️ موتور ثبت باید بعد از درج ردیف‌ها این جفت را اجرا کند:
--      SET CONSTRAINTS "gl_entry_must_balance" IMMEDIATE;
--      SET CONSTRAINTS "gl_entry_must_balance" DEFERRED;
--    خط اول خطا را داخل تراکنش منتشر می‌کند (Prisma خطای COMMIT را می‌بلعد)؛
--    خط دوم لازم است وگرنه سند دومِ همان تراکنش می‌شکند.
--
-- فقط اسناد POSTED سنجیده می‌شوند — پیش‌نویس هنوز سند نیست.
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_entry_balanced() RETURNS TRIGGER AS $$
DECLARE
  target   TEXT;
  st       "GlEntryStatus";
  n_lines  INT;
  diff     NUMERIC;
BEGIN
  target := COALESCE(NEW."entryId", OLD."entryId");

  SELECT status INTO st FROM "GlEntry" WHERE id = target;
  -- سند حذف شده (cascade) یا هنوز پیش‌نویس است
  IF st IS NULL OR st = 'DRAFT' THEN
    RETURN NULL;
  END IF;

  SELECT count(*), COALESCE(SUM("debitBase") - SUM("creditBase"), 0)
    INTO n_lines, diff
    FROM "GlLine" WHERE "entryId" = target;

  IF n_lines = 0 THEN
    RETURN NULL;
  END IF;

  IF n_lines < 2 THEN
    RAISE EXCEPTION 'سند % حداقل به دو ردیف نیاز دارد (الان % ردیف)', target, n_lines
      USING ERRCODE = 'check_violation';
  END IF;

  IF diff <> 0 THEN
    RAISE EXCEPTION 'سند % تراز نیست: اختلاف بدهکار و بستانکار % (کوچک‌ترین واحد ارز پایه)',
      target, diff
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "gl_entry_must_balance" ON "GlLine";
CREATE CONSTRAINT TRIGGER "gl_entry_must_balance"
  AFTER INSERT OR UPDATE OR DELETE ON "GlLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION gl_entry_balanced();

CREATE OR REPLACE FUNCTION gl_entry_balanced_self() RETURNS TRIGGER AS $$
DECLARE
  n_lines INT;
  diff    NUMERIC;
BEGIN
  SELECT count(*), COALESCE(SUM("debitBase") - SUM("creditBase"), 0)
    INTO n_lines, diff
    FROM "GlLine" WHERE "entryId" = NEW.id;

  IF n_lines < 2 THEN
    RAISE EXCEPTION 'سند % حداقل به دو ردیف نیاز دارد (الان % ردیف)', NEW.id, n_lines
      USING ERRCODE = 'check_violation';
  END IF;
  IF diff <> 0 THEN
    RAISE EXCEPTION 'سند % تراز نیست: اختلاف %', NEW.id, diff
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- سند POSTED که تازه POSTED می‌شود هم باید سنجیده شود (ردیف‌هایش قبلاً درج شده‌اند)
DROP TRIGGER IF EXISTS "gl_entry_balance_on_post" ON "GlEntry";
CREATE CONSTRAINT TRIGGER "gl_entry_balance_on_post"
  AFTER UPDATE ON "GlEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.status = 'POSTED')
  EXECUTE FUNCTION gl_entry_balanced_self();


-- ───────────────────────────────────────────────────────────────
-- قاعدهٔ ۴ — تغییرناپذیری
--
-- سند POSTED نه ویرایش می‌شود نه حذف. اصلاح فقط با سند برگشتی.
-- روی سربرگ، تنها گذارهای مجاز:  DRAFT → POSTED  و  POSTED → REVERSED
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_line_immutable() RETURNS TRIGGER AS $$
DECLARE
  st "GlEntryStatus";
BEGIN
  SELECT status INTO st FROM "GlEntry" WHERE id = COALESCE(OLD."entryId", NEW."entryId");
  IF st IS NULL THEN
    -- سند در همین تراکنش حذف شده (cascade) — مانعی نیست
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF st <> 'DRAFT' THEN
    RAISE EXCEPTION 'ردیف سند ثبت‌شده تغییر نمی‌کند. اصلاح فقط با سند برگشتی.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gl_line_immutable_trg ON "GlLine";
CREATE TRIGGER gl_line_immutable_trg
  BEFORE UPDATE OR DELETE ON "GlLine"
  FOR EACH ROW EXECUTE FUNCTION gl_line_immutable();

CREATE OR REPLACE FUNCTION gl_entry_transitions() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'سند ثبت‌شده حذف نمی‌شود. اصلاح فقط با سند برگشتی.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = NEW.status THEN
    -- تغییر محتوا فقط روی پیش‌نویس مجاز است
    IF OLD.status <> 'DRAFT'
       AND (OLD.date <> NEW.date
            OR OLD.description IS DISTINCT FROM NEW.description
            OR OLD."entryType" <> NEW."entryType"
            OR OLD.serial IS DISTINCT FROM NEW.serial
            OR OLD."fiscalYearId" <> NEW."fiscalYearId") THEN
      RAISE EXCEPTION 'سند ثبت‌شده ویرایش نمی‌شود. اصلاح فقط با سند برگشتی.'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT'  AND NEW.status = 'POSTED'   THEN RETURN NEW; END IF;
  IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED' THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'گذار وضعیت % ← % مجاز نیست', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gl_entry_transitions_trg ON "GlEntry";
CREATE TRIGGER gl_entry_transitions_trg
  BEFORE UPDATE OR DELETE ON "GlEntry"
  FOR EACH ROW EXECUTE FUNCTION gl_entry_transitions();

-- سریال: سند POSTED حتماً سریال دارد، پیش‌نویس حتماً ندارد
ALTER TABLE "GlEntry" DROP CONSTRAINT IF EXISTS gl_entry_serial_matches_status;
ALTER TABLE "GlEntry" ADD CONSTRAINT gl_entry_serial_matches_status
  CHECK ((status = 'DRAFT' AND serial IS NULL) OR (status <> 'DRAFT' AND serial IS NOT NULL));

-- ───────────────────────────────────────────────────────────────
-- قاعدهٔ ۴ — قفل دوره
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gl_entry_period_open() RETURNS TRIGGER AS $$
DECLARE
  locked DATE;
  fy     RECORD;
BEGIN
  IF NEW.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  SELECT max("lockToDate") INTO locked
    FROM "GlPeriodLock" WHERE module IN ('ALL', COALESCE(NEW."sourceType", 'ALL'));

  IF locked IS NOT NULL AND NEW.date <= locked THEN
    RAISE EXCEPTION 'دورهٔ تا % بسته است؛ سند با تاریخ % ثبت نمی‌شود', locked, NEW.date
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO fy FROM "GlFiscalYear" WHERE id = NEW."fiscalYearId";
  IF fy."closedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'سال مالی «%» بسته شده است', fy.title USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.date < fy."startDate" OR NEW.date > fy."endDate" THEN
    RAISE EXCEPTION 'تاریخ سند % بیرون از بازهٔ سال مالی «%» (% تا %) است',
      NEW.date, fy.title, fy."startDate", fy."endDate"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS gl_entry_period_open_trg ON "GlEntry";
CREATE TRIGGER gl_entry_period_open_trg
  BEFORE INSERT OR UPDATE ON "GlEntry"
  FOR EACH ROW EXECUTE FUNCTION gl_entry_period_open();

COMMIT;
