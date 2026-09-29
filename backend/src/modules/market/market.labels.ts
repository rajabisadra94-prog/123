/**
 * برچسب‌های فارسیِ مقادیر enum برای خروجی‌ها (اکسل، vCard).
 *
 * جدا شده چون خروجی اکسل نسخهٔ خودش را داخل تابع داشت و خروجی دفترچه‌تلفن
 * هم به همان‌ها نیاز داشت؛ دو نسخه یعنی روزی که وضعیتی اضافه شود، یکی از
 * دو خروجی کد خام انگلیسی نشان می‌دهد.
 * (رابط کاربری برچسب‌های خودش را در `frontend/pages/market/shared.ts` دارد،
 *  چون آن‌جا رنگ و آیکون هم لازم است.)
 */

export const STATUS_FA: Record<string, string> = {
  NEW: 'تماس گرفته نشده',
  ATTEMPTED: 'پاسخ نداد',
  CONTACTED: 'صحبت شد',
  NEEDS_RECALL: 'نیاز به تماس مجدد',
  INTERESTED: 'علاقه‌مند',
  NEGOTIATING: 'در حال مذاکره',
  SAMPLE_SENT: 'نمونه ارسال شد',
  CUSTOMER: 'مشتری',
  NOT_INTERESTED: 'علاقه‌مند نیست',
  UNREACHABLE: 'در دسترس نیست',
  BLACKLIST: 'لیست سیاه',
};

export const TYPE_FA: Record<string, string> = {
  SHOP: 'مغازه',
  DISTRIBUTOR: 'شرکت پخش',
  CLINIC: 'مطب / کلینیک',
  LAB: 'لابراتوار',
  IMPORTER: 'واردکننده',
  OTHER: 'سایر',
};

export const LEVEL_FA: Record<string, string> = {
  NOT_DISCUSSED: '', POSITIVE: 'مثبت', NEUTRAL: 'خنثی', NEGATIVE: 'منفی',
};

export const PRICE_FA: Record<string, string> = {
  NOT_DISCUSSED: '', GOOD: 'خوب', ACCEPTABLE: 'قابل قبول', EXPENSIVE: 'گران',
};

export const PROMISE_FA: Record<string, string> = {
  SAMPLE: 'نمونه', CATALOG: 'کاتالوگ', PRICE_LIST: 'لیست قیمت',
  QUOTE: 'پیش‌فاکتور', VIDEO: 'ویدیو', CERTIFICATE: 'گواهی', OTHER: 'سایر',
};

const MAPS = { status: STATUS_FA, type: TYPE_FA, level: LEVEL_FA, price: PRICE_FA, promise: PROMISE_FA };

/** برچسب فارسی یک مقدار؛ اگر ناشناخته بود خودِ مقدار برمی‌گردد نه رشتهٔ خالی */
export function toneOf(kind: keyof typeof MAPS, value: string | null | undefined): string {
  if (!value) return '';
  return MAPS[kind][value] ?? value;
}
