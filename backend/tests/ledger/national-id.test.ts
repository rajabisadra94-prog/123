/**
 * کد ملی — رقم کنترل.
 *
 * این عدد به سازمان امور مالیاتی می‌رود؛ بررسیِ طولیِ صرف یعنی خطا در
 * سامانهٔ مالیاتی کشف می‌شود، نه در سامانهٔ ما.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { nationalIdProblem, normalizeNationalId, isValidNationalId } from '../../src/modules/ledger/national-id';
import { gl, resetGl, seedGlChart, resetBusinessData } from '../helpers/gl';
import { createEmployee, updateEmployee } from '../../src/modules/ledger/payroll/admin';

/** کدهای معتبر — آخری عمداً حالتِ «باقی‌مانده کمتر از ۲» را می‌آزماید */
const VALID = ['0499370899', '0790419904', '0084575948', '1234567891'];

describe('اعتبارسنجی کد ملی', () => {
  it('کدهای معتبر پذیرفته می‌شوند', () => {
    for (const id of VALID) expect(nationalIdProblem(id)).toBeNull();
  });

  it('رقمِ کنترلِ نادرست رد می‌شود — نه فقط طولِ نادرست', () => {
    // ۱۰ رقم است و از بررسی طولی رد می‌شد
    expect(nationalIdProblem('1234567890')).toMatch(/رقم کنترل/);
    expect(nationalIdProblem('0499370898')).toMatch(/رقم کنترل/);
  });

  it('طول نادرست پیغام خودش را دارد', () => {
    expect(nationalIdProblem('12345')).toMatch(/۱۰ رقم/);
    expect(nationalIdProblem('12345678901')).toMatch(/۱۰ رقم/);
  });

  it('ارقام تکراری رد می‌شوند حتی وقتی فرمول را رد کنند', () => {
    // 1111111111 از نظر فرمول درست درمی‌آید ولی کد ملیِ واقعی نیست
    expect(nationalIdProblem('1111111111')).toMatch(/تکراری/);
    expect(nationalIdProblem('0000000000')).toMatch(/تکراری/);
  });

  it('نبودنِ کد خطا نیست — «اختیاری» یعنی اختیاری', () => {
    expect(nationalIdProblem(null)).toBeNull();
    expect(nationalIdProblem('')).toBeNull();
    expect(nationalIdProblem('   ')).toBeNull();
    expect(isValidNationalId(null)).toBe(false);   // ولی «معتبر» هم نیست
  });

  it('ارقام فارسی و جداکننده‌ها یکدست می‌شوند', () => {
    expect(normalizeNationalId('۰۴۹۹۳۷۰۸۹۹')).toBe('0499370899');
    expect(normalizeNationalId('049-937-0899')).toBe('0499370899');
    expect(nationalIdProblem('۰۴۹۹۳۷۰۸۹۹')).toBeNull();
  });
});

describe('کد ملی در ساخت و ویرایش کارمند', () => {
  beforeAll(async () => { await resetGl(); await seedGlChart(); }, 180_000);
  afterAll(async () => { await gl.$disconnect(); });
  beforeEach(async () => { await resetGl(); await resetBusinessData(); });

  const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
  const base = { name: 'کارمند آزمون', hireDate: new Date('2026-03-21'), baseSalary: 100_000_000n };

  it('کد ملیِ نامعتبر در ساخت رد می‌شود', async () => {
    await expect(
      tx((t) => createEmployee(t, { ...base, code: 'E1', nationalId: '1234567890' })),
    ).rejects.toThrow(/کد ملی/);
  });

  it('کد ملیِ معتبر با ارقام فارسی، لاتین ذخیره می‌شود', async () => {
    const e = await tx((t) => createEmployee(t, { ...base, code: 'E2', nationalId: '۰۴۹۹۳۷۰۸۹۹' }));
    expect(e.nationalId).toBe('0499370899');
  });

  it('ویرایش هم از همان در رد می‌شود', async () => {
    const e = await tx((t) => createEmployee(t, { ...base, code: 'E3' }));
    expect(e.nationalId).toBeNull();
    await expect(
      tx((t) => updateEmployee(t, e.id, { nationalId: '1234567890' })),
    ).rejects.toThrow(/کد ملی/);
    const ok = await tx((t) => updateEmployee(t, e.id, { nationalId: '0790419904' }));
    expect(ok.nationalId).toBe('0790419904');
  });

  it('ویرایشِ فیلدِ دیگر، کد ملیِ قدیمیِ نامعتبر را دست نمی‌زند', async () => {
    // دادهٔ قدیمی که پیش از این بررسی وارد شده بود نباید ویرایشِ نام را ببندد
    const e = await tx((t) => createEmployee(t, { ...base, code: 'E4' }));
    await gl.glEmployee.update({ where: { id: e.id }, data: { nationalId: '1234567890' } });
    const out = await tx((t) => updateEmployee(t, e.id, { name: 'نام تازه' }));
    expect(out.name).toBe('نام تازه');
    expect(out.nationalId).toBe('1234567890');
  });
});
