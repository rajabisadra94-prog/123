import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * خطاهای دامنه‌ایِ ماژول دفترداری (و بقیه) که یعنی «ورودی/قاعده غلط»، نه خطای
 * سرور. همه `extends Error {}` ساده‌اند و `this.name` ندارند، پس با نام کلاس
 * (`err.constructor.name`) شناخته می‌شوند — بک‌اند با `tsc` بیلد می‌شود نه bundler،
 * پس نام کلاس در dist دست‌نخورده می‌ماند.
 */
const DOMAIN_ERROR_NAMES = new Set([
  'LedgerError', 'FxError', 'YearCloseError', 'ChequeError', 'PettyCashError',
  'PayrollError', 'PayrollRateError', 'MigrationError', 'SubsidiaryError',
  'CostCenterError', 'CodeError', 'NoFiscalYearError', 'AmountError', 'BudgetError',
  'AllocationError', 'TaxReportError', 'ProvisionError',
  'DepreciationError', 'MonthEndError', 'StatutoryError', 'DisclosureError',
]);

/** کدهای پستگرس که خطای ورودی‌اند، نه خطای سرور */
const PG_INPUT_CODES = ['23514', '23503', '23505', 'P0001', '23P01'];

/**
 * پیام فارسیِ داخلِ خطای تریگر/قید پستگرس را بیرون می‌کشد (ممیزی ب۶).
 *
 * تریگرهای هستهٔ جدید با `RAISE EXCEPTION '‹فارسی›' USING ERRCODE='check_violation'`
 * شلیک می‌کنند. Prisma این را در یک `PrismaClientUnknownRequestError` می‌پیچد که
 * `.message`اش کلِ dump داخلی است. اینجا فقط پیامِ انسانی را برمی‌گردانیم و بقیه
 * (ساختار جدول، `DETAIL`, `column`) را دور می‌ریزیم.
 */
export function extractPgMessage(err: any): string | null {
  const raw: string = typeof err?.message === 'string' ? err.message : '';
  if (!raw) return null;

  const looksLikePgError = /PostgresError|ConnectorError|kind: QueryError/.test(raw)
    || PG_INPUT_CODES.some((c) => raw.includes(`code: "${c}"`) || raw.includes(`code: '${c}'`));
  if (!looksLikePgError) return null;

  // آخرین `message: "..."` در dump = پیامِ خودِ پستگرس (متن Prisma قبلش می‌آید)
  const matches = [...raw.matchAll(/message: "((?:[^"\\]|\\.)*)"/g)];
  if (!matches.length) return null;
  let msg = matches[matches.length - 1][1];

  // unescape: Prisma/Rust نویسه‌های غیر-ASCII را `\u{200c}` می‌نویسد (نیم‌فاصله و…)
  msg = msg
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .trim();

  // فقط پیام فارسی را نشان می‌دهیم؛ خطای غیرفارسی یعنی چیزی ناخواسته ⇒ ۵۰۰ عمومی
  if (!/[؀-ۿ]/.test(msg)) return null;
  return msg;
}

export function errorHandler(err: Error, req: Request, res: Response, next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ message: err.message });
  }

  const op = err as any;

  // خطاهای عملیاتیِ میان‌افزارها (مثل فیلتر نوع فایل در multer)
  if (op?.isOperational && op?.statusCode) {
    return res.status(op.statusCode).json({ message: err.message });
  }
  if (op?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'حجم فایل بیش از حد مجاز است (سقف ۵۰ مگابایت)' });
  }

  // خطاهای دامنه‌ایِ ماژول‌ها ⇒ ۴۰۰ با پیام خودشان (ممیزی ب۱۱)
  if (DOMAIN_ERROR_NAMES.has(op?.constructor?.name)) {
    return res.status(400).json({ message: err.message });
  }

  // خطای تریگر/قید پستگرس ⇒ ۴۰۰ با پیام فارسیِ خودِ تریگر (ممیزی ب۶)
  const pg = extractPgMessage(op);
  if (pg) {
    return res.status(400).json({ message: pg });
  }
  // Prisma: رکورد تکراری / یافت‌نشده — پیام عمومیِ امن
  if (op?.code === 'P2002') {
    return res.status(409).json({ message: 'این رکورد از قبل وجود دارد' });
  }
  if (op?.code === 'P2025') {
    return res.status(404).json({ message: 'رکورد یافت نشد' });
  }

  console.error(err);
  return res.status(500).json({
    message: err.message || 'Internal server error',
    name: err.name,
  });
}
