import multer from 'multer';
import path from 'path';
import fs from 'fs';

const UPLOAD_DIR = path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXTENSIONS = ['.pdf', '.dwg', '.step', '.x_t', '.zip', '.png', '.jpg', '.jpeg', '.xlsx', '.docx'];
const MAX_SIZE_MB = 50;

/**
 * ترمیم نام فایلِ غیرلاتین (فارسی).
 * busboy/multer نام فایل را با latin1 می‌خواند، پس نامی مثل «اصلاحات.docx»
 * به‌صورت «Ø§ØµÙ„Ø§Ø­Ø§Øª.docx» در می‌آید و کاربر فکر می‌کند نام فایل عوض شده.
 * این تابع بایت‌ها را دوباره به UTF-8 تفسیر می‌کند.
 */
export function fixFilename(name: string): string {
  if (!name || /^[\x00-\x7F]*$/.test(name)) return name;   // خالص ASCII → دست نزن
  try {
    const repaired = Buffer.from(name, 'latin1').toString('utf8');
    // اگر نتیجه کاراکتر جایگزین داشت یعنی نام از اول UTF-8 سالم بوده
    return repaired.includes('�') ? name : repaired;
  } catch { return name; }
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname).toLowerCase());
  },
});

function fileFilter(_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) {
  // همین‌جا و یک‌بار برای همیشه ترمیم می‌شود؛ همان شیء بعداً روی req.file می‌نشیند،
  // پس همهٔ مسیرهای آپلود (پروژه، بازبینی، سفارش، حمل، گفتگو…) نام درست می‌گیرند.
  file.originalname = fixFilename(file.originalname);
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext)) return cb(null, true);
  // خطای ورودی کاربر است، نه خطای سرور → ۴۰۰ با پیام فارسی، نه ۵۰۰
  const err: any = new Error(`فرمت «${ext || 'نامشخص'}» مجاز نیست. مجاز: ${ALLOWED_EXTENSIONS.join('، ')}`);
  err.statusCode = 400;
  err.isOperational = true;
  cb(err);
}

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_SIZE_MB * 1024 * 1024 },
});
