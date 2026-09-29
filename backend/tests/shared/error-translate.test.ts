/**
 * ممیزی ب۶/ب۱۱ — تبدیل خطای تریگر پستگرس و خطای دامنه به ۴۰۰ فارسی.
 *
 * حساس‌ترین بخش: بیرون‌کشیدنِ **آخرین** `message: "..."` از dump داخلی Prisma
 * (متنِ خودِ Prisma قبلش می‌آید) و unescape نیم‌فاصله.
 */
import { describe, it, expect, vi } from 'vitest';
import { errorHandler, extractPgMessage, AppError } from '../../src/shared/middleware/errorHandler';
import { LedgerError } from '../../src/modules/ledger/poster';
import { YearCloseError } from '../../src/modules/ledger/year-close';

/** dump واقعیِ Prisma برای یک RAISE EXCEPTION تریگر */
const TRIGGER_DUMP =
  '\nInvalid `prisma.glEntry.create()` invocation:\n\n' +
  'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(' +
  'PostgresError { code: "23514", message: "حساب «1101 موجودی نقد و بانک» سرگروه است و سند نمی‌گیرد", ' +
  'severity: "ERROR", detail: None, column: None, hint: None }) })';

describe('extractPgMessage', () => {
  it('پیام فارسیِ تریگر را از dump بیرون می‌کشد', () => {
    expect(extractPgMessage({ message: TRIGGER_DUMP }))
      .toBe('حساب «1101 موجودی نقد و بانک» سرگروه است و سند نمی‌گیرد');
  });

  it('نیم‌فاصلهٔ escape‌شده را برمی‌گرداند (هر دو شکل \\u200c و \\u{200c})', () => {
    const a = 'kind: QueryError(PostgresError { code: "P0001", message: "بسته شده\\u200cاست" })';
    const b = 'kind: QueryError(PostgresError { code: "P0001", message: "سند نمی\\u{200c}گیرد" })';
    expect(extractPgMessage({ message: a })).toBe('بسته شده‌است');
    expect(extractPgMessage({ message: b })).toBe('سند نمی‌گیرد');
  });

  it('خطای بدونِ نشانهٔ پستگرس ⇒ null', () => {
    expect(extractPgMessage({ message: 'TypeError: cannot read x of undefined' })).toBeNull();
  });

  it('خطای پستگرسِ غیرفارسی ⇒ null (۵۰۰ عمومی می‌ماند)', () => {
    const dump = 'PostgresError { code: "23514", message: "new row violates check constraint foo" }';
    expect(extractPgMessage({ message: dump })).toBeNull();
  });

  it('پیام بدون کدِ ورودی و بدون نشانه ⇒ null', () => {
    expect(extractPgMessage({})).toBeNull();
    expect(extractPgMessage({ message: '' })).toBeNull();
  });
});

describe('errorHandler', () => {
  const mockRes = () => {
    const res: any = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
  };
  const run = (err: any) => {
    const res = mockRes();
    errorHandler(err, {} as any, res, (() => {}) as any);
    return { status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
  };

  it('AppError → کد و پیام خودش', () => {
    expect(run(new AppError(404, 'نیست'))).toEqual({ status: 404, body: { message: 'نیست' } });
  });

  it('LedgerError → ۴۰۰ با پیام (ب۱۱)', () => {
    expect(run(new LedgerError('این سند قبلاً باطل شده است')))
      .toEqual({ status: 400, body: { message: 'این سند قبلاً باطل شده است' } });
  });

  it('YearCloseError → ۴۰۰', () => {
    expect(run(new YearCloseError('سال مالی بسته است')).status).toBe(400);
  });

  it('خطای تریگر پستگرس → ۴۰۰ با پیام فارسی، نه ۵۰۰ با dump (ب۶)', () => {
    const r = run({ message: TRIGGER_DUMP, constructor: { name: 'PrismaClientUnknownRequestError' } });
    expect(r.status).toBe(400);
    expect(r.body.message).toBe('حساب «1101 موجودی نقد و بانک» سرگروه است و سند نمی‌گیرد');
    expect(r.body.name).toBeUndefined();   // ساختار داخلی نشت نمی‌کند
  });

  it('خطای ناشناخته → ۵۰۰', () => {
    expect(run(new Error('boom')).status).toBe(500);
  });

  it('P2025 → ۴۰۴', () => {
    expect(run({ code: 'P2025', message: 'x' }).status).toBe(404);
  });
});
