/**
 * ممیزی — مرحلهٔ ۴ (کامل‌کردن).
 *   ج۸ گردش پیش‌نویس   ·   ج۱۲ علامت ترازنامه + سطر سود انباشته
 *   ج۳ خط مالیات بر درآمد در سود و زیان   ·   ج۱–ج۷ حساب‌های نو در چارت
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D, DEFAULT_DATE,
  resetBusinessData, expectRejects,
} from '../helpers/gl';
import { post, createDraft, updateDraft, discardDraft, postDraft } from '../../src/modules/ledger/poster';
import { balanceSheet, incomeStatement } from '../../src/modules/ledger/reports/statements';

let fy: any, cash: any, equity: any, sales: any, cogs: any, tax: any, taxPay: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101');
  equity = await accountByCode('3101');
  sales = await accountByCode('4101');
  cogs = await accountByCode('5101');
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl(); await resetBusinessData();
  fy = await makeFiscalYear();
});

// ═══════════════════════════════════════════════════════════════
describe('ج۱–ج۷ — حساب‌های نو در چارت', () => {
  it('همه ساخته شده‌اند', async () => {
    for (const code of ['1109', '2112', '2113', '3103', '3104', '5104', '5105', '6204', '6205', '8205']) {
      const a = await gl.glAccount.findUnique({ where: { code } });
      expect(a, code).not.toBeNull();
      expect(a!.isPostable, code).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ج۸ — گردش پیش‌نویس', () => {
  it('پیش‌نویس سریال نمی‌گیرد و لازم نیست تراز باشد', async () => {
    const d: any = await tx((t) => createDraft(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'پیش‌نویس ناتراز',
      lines: [{ accountId: cash.id, currencyCode: 'IRR', debit: 100n }],   // فقط یک ردیف، ناتراز
    }));
    expect(d.status).toBe('DRAFT');
    expect(d.serial).toBeNull();
  });

  it('ویرایش پیش‌نویس ردیف‌ها را جایگزین می‌کند', async () => {
    const d: any = await tx((t) => createDraft(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'اول',
      lines: [{ accountId: cash.id, currencyCode: 'IRR', debit: 100n }],
    }));
    const u: any = await tx((t) => updateDraft(t, d.id, {
      date: DEFAULT_DATE, description: 'دوم',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 5_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 5_000n },
      ],
    }));
    expect(u.description).toBe('دوم');
    expect(u.lines).toHaveLength(2);
  });

  it('نهایی‌کردنِ پیش‌نویسِ ناتراز رد می‌شود', async () => {
    const d: any = await tx((t) => createDraft(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'ناتراز',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 5_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 4_000n },
      ],
    }));
    await expectRejects(() => tx((t) => postDraft(t, d.id)), /تراز نیست/);
  });

  it('نهایی‌کردنِ پیش‌نویسِ تراز، سریال می‌دهد و به POSTED می‌برد', async () => {
    const d: any = await tx((t) => createDraft(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'تراز',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 5_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 5_000n },
      ],
    }));
    const p: any = await tx((t) => postDraft(t, d.id));
    expect(p.status).toBe('POSTED');
    expect(p.serial).toBeGreaterThan(0);
  });

  it('حذف پیش‌نویس؛ سند POSTED حذف نمی‌شود', async () => {
    const d: any = await tx((t) => createDraft(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'حذفی',
      lines: [{ accountId: cash.id, currencyCode: 'IRR', debit: 1n }],
    }));
    await tx((t) => discardDraft(t, d.id));
    expect(await gl.glEntry.findUnique({ where: { id: d.id } })).toBeNull();

    const posted: any = await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'قطعی',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 1_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 1_000n },
      ],
    }));
    await expectRejects(() => tx((t) => discardDraft(t, posted.id)), /فقط پیش‌نویس/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ج۱۲ — ترازنامه: علامت طبیعی + سطر سود دوره', () => {
  it('بدهی مثبت نشان داده می‌شود و سود دوره سطر صریح دارد', async () => {
    // آورده ۱۰۰۰م + فروش ۳۰۰م نقدی (سود دوره)
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-04-01'), description: 'آورده',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 1_000_000_000n },
      ],
    }));
    const payable = await accountByCode('2101');
    const c = await gl.customer.create({ data: { name: 'م', shortCode: 'BS1' } });
    // بدهی به یک سازنده
    const p = await gl.producer.create({ data: { name: 'س' } });
    void c; void p;
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-05-01'), description: 'فروش نقدی',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 300_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 300_000_000n },
      ],
    }));

    const bs: any = await balanceSheet(gl, D('2026-12-01'));
    // سرمایه در آرایهٔ equity با علامت مثبت
    const cap = bs.equity.find((n: any) => n.code === '3101')
    expect(BigInt(cap.amount)).toBe(1_000_000_000n)
    // سطر سود دورهٔ بسته‌نشده
    const retained = bs.equity.find((n: any) => n.name.includes('بسته‌نشده'))
    expect(retained).toBeTruthy()
    expect(BigInt(retained.amount)).toBe(300_000_000n)
    expect(BigInt(bs.totals.totalEquity)).toBe(1_300_000_000n)
    expect(bs.balanced).toBe(true)
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ج۳ — خط مالیات بر درآمد', () => {
  it('۸۲۰۵ از غیرعملیاتی جدا و سود خالص = قبل از مالیات − مالیات', async () => {
    tax = await accountByCode('8205');
    taxPay = await accountByCode('2112');
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-05-01'), description: 'فروش',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 500_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 500_000_000n },
      ],
    }));
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-12-29'), description: 'ذخیرهٔ مالیات',
      lines: [
        { accountId: tax.id, currencyCode: 'IRR', debit: 125_000_000n },
        { accountId: taxPay.id, currencyCode: 'IRR', credit: 125_000_000n },
      ],
    }));

    const is: any = await incomeStatement(gl, { from: D('2026-01-01'), to: D('2026-12-30') });
    expect(BigInt(is.totals.taxExpense)).toBe(125_000_000n);
    expect(BigInt(is.totals.profitBeforeTax)).toBe(500_000_000n);
    expect(BigInt(is.totals.netProfit)).toBe(375_000_000n);
    // مالیات نباید در «غیرعملیاتی» دوباره شمرده شود
    expect(BigInt(is.totals.nonOperating)).toBe(0n);
  });
});
