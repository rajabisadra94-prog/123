/**
 * اعتبارسنجی کد ملی ایران.
 *
 * ⚠️ چرا رقم کنترل، و نه فقط «۱۰ رقم است؟»:
 * فهرست مالیات حقوق به سازمان امور مالیاتی می‌رود. کدی مثل `1234567890`
 * ده رقم است و از بررسیِ طولی رد می‌شود، ولی در سامانهٔ مالیاتی برمی‌گردد —
 * و آن‌جا برگشت‌خوردن یعنی جریمهٔ تأخیر، نه یک پیام خطا.
 *
 * رقم آخر، رقمِ کنترل است: مجموعِ نُه رقم اول در وزن‌های ۱۰ تا ۲، باقی‌ماندهٔ
 * بر ۱۱. اگر باقی‌مانده کمتر از ۲ باشد، خودش رقمِ کنترل است؛ وگرنه ۱۱ منهای آن.
 *
 * کدهای تک‌رقمیِ تکراری (`0000000000`، `1111111111`، …) از این فرمول رد
 * می‌شوند ولی معتبر نیستند — صریحاً کنار گذاشته می‌شوند.
 */

const REPEATED = /^(\d)\1{9}$/;

/** فقط ارقام لاتین می‌ماند؛ ارقام فارسی/عربی و خط تیره تبدیل یا حذف می‌شوند. */
export function normalizeNationalId(raw: string): string {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  return [...raw.trim()]
    .map((ch) => {
      const i = fa.indexOf(ch) >= 0 ? fa.indexOf(ch) : ar.indexOf(ch);
      return i >= 0 ? String(i) : ch;
    })
    .filter((ch) => ch >= '0' && ch <= '9')
    .join('');
}

/** `null` یعنی معتبر؛ رشته یعنی دلیلِ ردشدن (فارسی، آمادهٔ نمایش). */
export function nationalIdProblem(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === '') return null;   // نبودنش اینجا خطا نیست
  const id = normalizeNationalId(raw);
  if (id.length !== 10) return 'کد ملی باید ۱۰ رقم باشد';
  if (REPEATED.test(id)) return 'کد ملی معتبر نیست (ارقام تکراری)';

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(id[i]) * (10 - i);
  const r = sum % 11;
  const check = Number(id[9]);
  const ok = r < 2 ? check === r : check === 11 - r;
  return ok ? null : 'کد ملی معتبر نیست (رقم کنترل نمی‌خواند)';
}

export function isValidNationalId(raw: string | null | undefined): boolean {
  return raw != null && raw.trim() !== '' && nationalIdProblem(raw) == null;
}
