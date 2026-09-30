import path from 'path';
import fs from 'fs';
import { generateFileName } from './fileNaming';

/**
 * نام‌گذاری استاندارد رسیدهای مالی و انتقال فایل آپلودشده به نام دائمی.
 *
 * multer فایل را با نام موقت روی دیسک می‌گذارد؛ اینجا به نام گویا
 * (`TRN-{نوع}-{توکن}_RCPT_..._{تاریخ}`) تغییر نام می‌یابد و مسیر عمومی برمی‌گردد.
 *
 * قبلاً کپیِ محلی این تابع در `accounting.routes.ts` بود؛ هستهٔ جدید هم لازمش
 * داشت، پس اینجا مشترک شد.
 */
export function storeReceipt(
  file: Express.Multer.File,
  kind: string,
  extra: Partial<Parameters<typeof generateFileName>[0]>,
): string {
  const newName = generateFileName(
    {
      ...extra,
      level: 'transaction',
      fileType: 'PAYMENT_RECEIPT',
      transactionCode: `${kind}-${Date.now().toString(36)}`,
      originalExt: path.extname(file.originalname),
    },
    file.originalname,
  );
  fs.renameSync(file.path, path.join(path.dirname(file.path), newName));
  return `/uploads/${newName}`;
}
