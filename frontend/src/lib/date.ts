// @ts-ignore
import jalaali from 'jalaali-js';
import { format } from 'date-fns';

export function toShamsi(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const { jy, jm, jd } = jalaali.toJalaali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
}

// تاریخ شمسی امن؛ مقدار خالی → «—»
export function faDate(date: Date | string | null | undefined): string {
  return date ? toShamsi(date) : '—';
}

export function fromShamsi(shamsiDate: string): Date {
  const [jy, jm, jd] = shamsiDate.split('/').map(Number);
  const { gy, gm, gd } = jalaali.toGregorian(jy, jm, jd);
  return new Date(gy, gm - 1, gd);
}

/** سال و ماه و روزِ شمسیِ امروز — برای پیش‌فرضِ دورهٔ حقوق */
export function nowJalali(): { jy: number; jm: number; jd: number } {
  const d = new Date();
  return jalaali.toJalaali(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** میانهٔ ماه شمسی → رشتهٔ YYYY-MM-DD میلادی (پیش‌فرضِ تاریخِ سندِ لیست حقوق) */
export function jalaliMonthToGregorian(jy: number, jm: number, jd = 15): string {
  const { gy, gm, gd } = jalaali.toGregorian(jy, jm, jd);
  return `${gy}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
}

export const J_MONTHS = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
];

export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return `${toShamsi(d)} ${format(d, 'HH:mm')}`;
}

/** «فروردین ۱۴۰۵» — برچسبِ گروه‌بندیِ ماهانه (ممیزی سوم — ج۲) */
export function shamsiMonthLabel(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const { jy, jm } = jalaali.toJalaali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return `${J_MONTHS[jm - 1]} ${jy}`;
}
