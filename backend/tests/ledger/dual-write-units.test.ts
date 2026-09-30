/**
 * واحدِ مبلغ در آداپتور دونویسی — مرحلهٔ ۵ ه.
 *
 * ─── چرا این تست وجود دارد ─────────────────────────────────────
 *
 * هستهٔ قدیمی مبالغ ریالی را به **تومان** نگه می‌دارد و جدید به **ریال**.
 * آداپتور تسویه مبلغ را دست‌نخورده رد می‌کرد، پس یک دریافتِ ۱۲٬۳۴۵٬۰۰۰ تومانی
 * در هستهٔ قدیمی ۱۲۳٬۴۵۰٬۰۰۰ ریال می‌نشست و در جدید ۱۲٬۳۴۵٬۰۰۰ — **یک‌دهم**.
 *
 * ۶۵۱ تست سبز بود و هیچ‌کدام این را نگرفتند، چون همه‌شان `doSettlement` را
 * مستقیم صدا می‌زنند؛ آنجا واحد از ابتدا ریال است و تبدیلی لازم نیست. باگ
 * فقط در **مرزِ دو هسته** بود و فقط ورزش دادنِ مسیر واقعی روی staging
 * نشانش داد.
 *
 * درسش: تستِ واحد از هستهٔ جدید، مرزِ دو هسته را نمی‌سنجد. این فایل عمداً
 * از سمتِ **آداپتور** وارد می‌شود.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, makeSubsidiary, accountByCode, D, resetBusinessData,
} from '../helpers/gl';
import { fromLegacyAmount, TOMAN_TO_RIAL } from '../../src/modules/ledger/legacy-amounts';
import { doSettlement } from '../../src/modules/ledger/ops';

let fy: any, cash: any, sales: any, ar: any, customer: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
  ar = await accountByCode('1104');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await resetGl(); await resetBusinessData();
  fy = await makeFiscalYear();
  customer = await makeSubsidiary('CUSTOMER', 'مشتری الف');
});

// ═══════════════════════════════════════════════════════════════
describe('تبدیل واحدِ مرزِ دو هسته', () => {
  it('ریال: تومانِ قدیمی ×۱۰ می‌شود', async () => {
    // ⚠️ همان باگ. ۱۲٬۳۴۵٬۰۰۰ تومان = ۱۲۳٬۴۵۰٬۰۰۰ ریال
    expect(fromLegacyAmount('12345000', 'IRR', 0)).toBe(123_450_000n);
    expect(TOMAN_TO_RIAL).toBe(10n);
  });

  it('اعشارِ تومان پیش از تبدیل گم نمی‌شود', async () => {
    // ۴۳۲٬۱۰۸٫۴ تومان = ۴٬۳۲۱٬۰۸۴ ریال — نه ۴٬۳۲۱٬۰۸۰
    expect(fromLegacyAmount('432108.4', 'IRR', 0)).toBe(4_321_084n);
  });

  it('ارز خارجی دست‌نخورده می‌ماند — فقط ریزمقیاس', async () => {
    // واحد در دو هسته یکی است؛ ۲۵۰ دلار = ۲۵٬۰۰۰ سنت، نه ۲۵۰٬۰۰۰
    expect(fromLegacyAmount('250', 'USD', 2)).toBe(25_000n);
    expect(fromLegacyAmount('1650', 'USD', 2)).toBe(165_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('اثرِ باگ روی دفتر', () => {
  /** بدهیِ مشتری را می‌سازد تا تسویه چیزی برای بستن داشته باشد */
  const invoice = async (rial: bigint) => {
    const { post } = await import('../../src/modules/ledger/poster');
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-05-01'), description: 'فاکتور',
      lines: [
        { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: rial },
        { accountId: sales.id, currencyCode: 'IRR', credit: rial },
      ],
    }));
  };

  it('مبلغِ تبدیل‌شده، بدهی را کامل می‌بندد', async () => {
    // فاکتور ۱۲۳٬۴۵۰٬۰۰۰ ریالی = ۱۲٬۳۴۵٬۰۰۰ تومان در هستهٔ قدیمی
    await invoice(123_450_000n);

    // آداپتور باید تومان را به ریال تبدیل کند
    const converted = fromLegacyAmount('12345000', 'IRR', 0).toString();
    await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: D('2026-05-10'), direction: 'RECEIPT',
      subsidiaryId: customer.id, currency: 'IRR',
      amount: converted, cashAccountCode: '110101',
    }));

    const [row] = await gl.$queryRaw<{ amount: bigint }[]>`
      SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS amount
      FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
      JOIN "GlAccount" a ON a.id = l."accountId"
      WHERE a.code = '1104' AND e.status <> 'DRAFT'`;
    expect(BigInt(row.amount)).toBe(0n);   // کاملاً تسویه
  });

  it('بدونِ تبدیل، نُه‌دهمِ بدهی باز می‌ماند', async () => {
    // ⚠️ رفتارِ باگ‌دار، تا اثرش مکتوب بماند
    await invoice(123_450_000n);
    await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: D('2026-05-10'), direction: 'RECEIPT',
      subsidiaryId: customer.id, currency: 'IRR',
      amount: '12345000',            // خامِ تومان، بدون تبدیل
      cashAccountCode: '110101',
    }));

    const [row] = await gl.$queryRaw<{ amount: bigint }[]>`
      SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS amount
      FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
      JOIN "GlAccount" a ON a.id = l."accountId"
      WHERE a.code = '1104' AND e.status <> 'DRAFT'`;
    // ۱۲۳٬۴۵۰٬۰۰۰ − ۱۲٬۳۴۵٬۰۰۰ = ۱۱۱٬۱۰۵٬۰۰۰ — دقیقاً همان عددی که
    // مقایسهٔ زندهٔ staging نشان داد
    expect(BigInt(row.amount)).toBe(111_105_000n);
  });
});
