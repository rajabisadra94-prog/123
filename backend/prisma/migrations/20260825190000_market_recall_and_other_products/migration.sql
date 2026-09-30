-- «نیاز به تماس مجدد»: صحبت شد ولی جواب نهایی نداد.
-- در پستگرس افزودن مقدار به enum در همان تراکنشِ استفاده‌اش مجاز نیست،
-- ولی این‌جا فقط تعریف می‌شود و مصرفش در درخواست‌های بعدی است.
ALTER TYPE "MarketStatus" ADD VALUE 'NEEDS_RECALL';

-- «محصول دیگری هم خواست؟» — متن آزاد، چون از قبل نمی‌دانیم چه می‌خواهند.
ALTER TABLE "MarketContact" ADD COLUMN     "otherProductsNote" TEXT;
