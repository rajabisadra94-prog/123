/**
 * مرزهای ماه‌های شمسی درون یک سال مالی — بدون کتابخانهٔ تقویم.
 *
 * **چرا اصلاً لازم شد:** بودجه ماهانه ذخیره می‌شود و داشبورد روند ماهانه
 * می‌کشد؛ هر دو باید بدانند «فروردین» از کجا تا کجاست. نسخهٔ اول بودجه از
 * تقریبِ ۳۰ روزه استفاده می‌کرد (همان چیزی که `payroll/run.ts` دارد) و این
 * یک خطای واقعی بود: فروردین ۳۱ روز است، پس اجاره‌ای که ۳۱ فروردین ثبت
 * می‌شد در عملکردِ **اردیبهشت** می‌نشست و انحرافِ هر دو ماه غلط درمی‌آمد.
 * تا اسفند، خطا به شش روز می‌رسید.
 *
 * **چرا کتابخانه لازم نیست:** سال مالی ایرانی از ۱ فروردین شروع می‌شود، و
 * طول ماه‌های شمسی ثابت است — شش ماه ۳۱ روزه، پنج ماه ۳۰ روزه، و اسفندِ
 * ۲۹ یا ۳۰ روزه. کبیسه بودنِ سال از خودِ `endDate` خوانده می‌شود، پس هیچ
 * الگوریتم تقویمی اینجا بازنویسی نمی‌شود.
 */

const DAY_MS = 86_400_000;

/** فروردین تا بهمن؛ اسفند از طول سال حساب می‌شود */
const FIXED_LENGTHS = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30];
const DAYS_BEFORE_ESFAND = FIXED_LENGTHS.reduce((a, b) => a + b, 0); // ۳۳۶

export const MONTHS_IN_YEAR = 12;

export interface FiscalYearDates {
  startDate: Date;
  /** آخرین روزِ سال، شاملِ خودش */
  endDate: Date;
}

/**
 * بازهٔ میلادیِ هر ماه شمسی: `[from, to]` که هر دو **شامل** خودشان‌اند.
 *
 * خروجی همیشه ۱۲ عضو دارد، حتی اگر سال مالی کوتاه‌تر تعریف شده باشد — در آن
 * حالت ماه‌های بعد از پایان سال، بازهٔ خالی می‌گیرند تا حلقه‌های بالادست
 * لازم نباشد شرط بگذارند.
 */
export function shamsiMonths(fy: FiscalYearDates): { from: Date; to: Date }[] {
  const start = new Date(fy.startDate);
  const totalDays = Math.round((new Date(fy.endDate).getTime() - start.getTime()) / DAY_MS) + 1;

  // اسفند ۲۹ روزه است مگر سال کبیسه باشد؛ به‌جای الگوریتم کبیسه، از طولِ
  // خودِ سال مالی خوانده می‌شود. اگر سال مالی غیرعادی تعریف شده باشد،
  // در بازهٔ منطقی نگه داشته می‌شود تا مرزها به هم نریزند.
  const esfand = Math.min(Math.max(totalDays - DAYS_BEFORE_ESFAND, 29), 30);
  const lengths = [...FIXED_LENGTHS, esfand];

  const out: { from: Date; to: Date }[] = [];
  let cursor = 0;
  for (const len of lengths) {
    const from = new Date(start.getTime() + cursor * DAY_MS);
    const to = new Date(start.getTime() + (cursor + len - 1) * DAY_MS);
    out.push({ from, to });
    cursor += len;
  }
  return out;
}

/**
 * بازهٔ پیوستهٔ ماه `fromMonth` تا `toMonth` (یک‌مبنا، ۱ = فروردین).
 * مقادیر خارج از محدوده به ۱..۱۲ بریده می‌شوند.
 */
export function shamsiRange(fy: FiscalYearDates, fromMonth = 1, toMonth = MONTHS_IN_YEAR) {
  const months = shamsiMonths(fy);
  const from = Math.min(Math.max(fromMonth, 1), MONTHS_IN_YEAR);
  const to = Math.min(Math.max(toMonth, from), MONTHS_IN_YEAR);
  return { from: months[from - 1].from, to: months[to - 1].to };
}
