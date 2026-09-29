/**
 * ممیزی — مرحلهٔ ۳ (درستی). یک فایل برای باگ‌های عددیِ رفع‌شده:
 *   ب۴ اضافه‌دریافت → پیش‌دریافت      ب۷ اعشار کارمزد
 *   ب۸ دفتر کلِ سرگروه               ب۹ برگشتِ سند برگشتی
 *   ب۱۰ خروج چک برگشتی               ج۱۵ کنترل عقلانیت نرخ
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D, DEFAULT_DATE,
  resetBusinessData, expectRejects,
} from '../helpers/gl';
import { ensureSubsidiary } from '../../src/modules/ledger/subsidiary';
import { createAccount } from '../../src/modules/ledger/codes';
import { post, reverse } from '../../src/modules/ledger/poster';
import { accountLedger } from '../../src/modules/ledger/reports/ledgers';
import { checkRateOutlier } from '../../src/modules/ledger/fx';
import { doSettlement, doConversion } from '../../src/modules/ledger/ops';
import { receiveCheque, transitionCheque, overdueCheques, CHEQUE_CODES } from '../../src/modules/ledger/cheque';

let fy: any, ar: any, sales: any, cogs: any, cashUsd: any, customer: any, equity: any, cash101: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const rate = (from: string, r: string, date = DEFAULT_DATE) =>
  gl.glExchangeRate.upsert({
    where: { from_to_date_source: { from, to: 'IRR', date, source: 'MANUAL' } },
    update: { rate: r }, create: { from, to: 'IRR', date, rate: r, source: 'MANUAL' },
  });

/** ماندهٔ پایه (ریال) یک حساب — اگر ارز بدهی، فقط همان ارز */
async function bal(code: string, currency?: string): Promise<bigint> {
  const a = await accountByCode(code);
  const rows = currency
    ? await gl.$queryRaw<{ b: bigint | null }[]>`
        SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS b
        FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
        WHERE l."accountId" = ${a.id} AND e.status <> 'DRAFT' AND l."currencyCode" = ${currency}`
    : await gl.$queryRaw<{ b: bigint | null }[]>`
        SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS b
        FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
        WHERE l."accountId" = ${a.id} AND e.status <> 'DRAFT'`;
  return BigInt(rows[0]?.b ?? 0n);
}

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  ar = await accountByCode('1104');
  sales = await accountByCode('4101');
  cogs = await accountByCode('5101');
  equity = await accountByCode('3101');
  cash101 = await accountByCode('110101');
}, 180_000);

afterAll(async () => {
  await resetGl();
  await gl.glAccount.deleteMany({ where: { isSystem: false } });
  await gl.$disconnect();
});

beforeEach(async () => {
  await resetGl();
  await gl.glAccount.deleteMany({ where: { isSystem: false } });
  await resetBusinessData();
  await gl.glExchangeRate.deleteMany({});
  await gl.customer.deleteMany({});
  fy = await makeFiscalYear();
  await rate('USD', '900000');
  cashUsd = await tx((t) => createAccount(t, { code: '110109', name: 'صندوق ارزی' }));
  const c = await gl.customer.create({ data: { name: 'مشتری مرحله۳', shortCode: 'S31' } });
  customer = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
});

// ═══════════════════════════════════════════════════════════════
describe('ب۴ — اضافه‌دریافت به پیش‌دریافت، نه دارایی منفی', () => {
  const openAr = (cents: bigint) => tx((t) => post(t, {
    fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش',
    lines: [
      { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'USD', debit: cents, rate: '900000' },
      { accountId: sales.id, currencyCode: 'USD', credit: cents, rate: '900000' },
    ],
  }));

  it('مازاد بدون فلگ ⇒ رد با پیام روشن', async () => {
    await openAr(10_000n);   // ۱۰۰ دلار طلب
    await expectRejects(
      () => tx((t) => doSettlement(t, {
        fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT', subsidiaryId: customer.id,
        currency: 'USD', amount: '150', cashAccountCode: '110109',
      })),
      /بیشتر است.*پیش‌دریافت/s,
    );
  });

  it('با فلگ ⇒ ۱۰۰ به طلب، ۵۰ به ۲۱۰۳، ۱۱۰۴ منفی نمی‌شود', async () => {
    await openAr(10_000n);
    await tx((t) => doSettlement(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, direction: 'RECEIPT', subsidiaryId: customer.id,
      currency: 'USD', amount: '150', cashAccountCode: '110109', allowPrepayment: true,
    }));
    expect(await bal('1104', 'USD')).toBe(0n);              // طلب دقیقاً بسته شد، نه منفی
    expect(await bal('2103', 'USD')).toBe(-45_000_000n);    // ۵۰ دلار پیش‌دریافت (بستانکار)
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ب۷ — کارمزد کسری حذف نمی‌شود', () => {
  it('کارمزد ۰٫۴ دلاری سند می‌خورد', async () => {
    // نقد اولیه
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'شارژ',
      lines: [
        { accountId: cashUsd.id, currencyCode: 'USD', debit: 100_000n, rate: '900000' },
        { accountId: equity.id, currencyCode: 'USD', credit: 100_000n, rate: '900000' },
      ],
    }));
    await rate('CNY', '128000');
    const cnyCash = await tx((t) => createAccount(t, { code: '110110', name: 'صندوق یوآن' }));
    void cnyCash;
    const res: any = await tx((t) => doConversion(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE,
      fromAccountCode: '110109', fromCurrency: 'USD', fromAmount: '50',
      toAccountCode: '110110', toCurrency: 'CNY', toAmount: '351',
      fee: { amount: '0.4', currency: 'USD', accountCode: '110109' },
    }));
    expect(res.feeEntry).toBeTruthy();
    // ۰٫۴ دلار = ۴۰ سنت روی ۷۱۰۲
    const feeLines = await gl.glLine.findMany({ where: { entryId: res.feeEntry.id } });
    const feeDr = feeLines.find((l: any) => l.debit > 0n)!;
    expect(feeDr.debit).toBe(40n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ب۸ — دفتر کلِ سرگروه نوادگان را جمع می‌زند', () => {
  it('کد سرگروه ۱۱۰۴؟ نه — ۱۱ و ۱۱۰۱ که سرگروه‌اند', async () => {
    // گردش روی برگِ ۱۱۰۱۰۱ و ۱۱۰۱۰۹
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'آورده',
      lines: [
        { accountId: cash101.id, currencyCode: 'IRR', debit: 500_000_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 500_000_000n },
      ],
    }));
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'آوردهٔ ارزی',
      lines: [
        { accountId: cashUsd.id, currencyCode: 'USD', debit: 1_000n, rate: '900000' },
        { accountId: equity.id, currencyCode: 'USD', credit: 1_000n, rate: '900000' },
      ],
    }));

    const leaf = await accountLedger(gl, '110101');
    expect(leaf.rows.length).toBe(1);   // فقط گردش خودش

    const group = await accountLedger(gl, '1101');   // سرگروهِ «نقد و بانک»
    expect(group.rows.length).toBe(2);               // هر دو برگ
    expect(group.closingBalance).toBe(509_000_000n); // ۵۰۰م + ۹م (۱۰۰۰ دلار × ۹۰۰٬۰۰۰ / ۱۰۰)
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ب۹ — سند برگشتی دوباره برگشت نمی‌خورد', () => {
  it('برگشتِ یک سند REVERSING رد می‌شود', async () => {
    const e: any = await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'سند',
      lines: [
        { accountId: cash101.id, currencyCode: 'IRR', debit: 1_000n },
        { accountId: equity.id, currencyCode: 'IRR', credit: 1_000n },
      ],
    }));
    const rev: any = await tx((t) => reverse(t, e.id, { reason: 'اصلاح' }));
    await expectRejects(
      () => tx((t) => reverse(t, rev.id, { reason: 'دوباره' })),
      /برگشتی را نمی‌توان دوباره/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ب۱۰ — چک برگشتیِ دریافتی بن‌بست نیست', () => {
  async function bouncedCheque() {
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش نسیه',
      lines: [
        { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: 50_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 50_000_000n },
      ],
    }));
    const { cheque } = await tx((t) => receiveCheque(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, number: 'CHQ-B10', bankName: 'ملت',
      amount: 50_000_000n, currencyCode: 'IRR', issueDate: D('2026-05-01'), dueDate: D('2026-08-01'),
      subsidiaryId: customer.id,
    }));
    await tx((t) => transitionCheque(t, { fiscalYearId: fy.id, date: D('2026-07-01'), chequeId: cheque.id, to: 'IN_COLLECTION' }));
    await tx((t) => transitionCheque(t, { fiscalYearId: fy.id, date: D('2026-08-05'), chequeId: cheque.id, to: 'BOUNCED' }));
    return cheque;
  }

  it('BOUNCED → RETURNED، بدهی به ۱۱۰۴ برمی‌گردد', async () => {
    const cheque = await bouncedCheque();
    expect(await bal(CHEQUE_CODES.receivable)).toBe(0n);   // هنوز صفر (چک بدهی را برده)

    await tx((t) => transitionCheque(t, { fiscalYearId: fy.id, date: D('2026-08-10'), chequeId: cheque.id, to: 'RETURNED' }));

    const c = await gl.glCheque.findUniqueOrThrow({ where: { id: cheque.id } });
    expect(c.status).toBe('RETURNED');
    expect(await bal(CHEQUE_CODES.receivable)).toBe(50_000_000n);   // بدهی برگشت
    expect(await bal(CHEQUE_CODES.bounced)).toBe(0n);
  });

  it('BOUNCED → IN_HAND برای وصول مجدد', async () => {
    const cheque = await bouncedCheque();
    await tx((t) => transitionCheque(t, { fiscalYearId: fy.id, date: D('2026-08-10'), chequeId: cheque.id, to: 'IN_HAND' }));
    expect(await bal(CHEQUE_CODES.inHand)).toBe(50_000_000n);
    expect(await bal(CHEQUE_CODES.bounced)).toBe(0n);
  });

  it('چک برگشتی در فهرست «تعیین تکلیف نشده» می‌آید حتی اگر سررسید نگذشته باشد', async () => {
    const cheque = await bouncedCheque();
    const list = await overdueCheques(gl, D('2026-01-01'));   // خیلی قبل از سررسید
    expect(list.map((c) => c.id)).toContain(cheque.id);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ج۱۵ — کنترل عقلانیت نرخ', () => {
  it('انحراف کمتر از ۱۵٪ ⇒ ok', async () => {
    const c = await checkRateOutlier(gl, 'USD', 'IRR', '950000', DEFAULT_DATE);   // +۵٫۵٪
    expect(c.ok).toBe(true);
  });
  it('انحراف بیش از ۱۵٪ ⇒ ok=false با آخرین نرخ', async () => {
    const c = await checkRateOutlier(gl, 'USD', 'IRR', '3000000', DEFAULT_DATE);   // ۳٫۳ برابر
    expect(c.ok).toBe(false);
    expect(c.deviation).toBeGreaterThan(2);
    expect(c.last?.rate).toBe('900000');
  });
  it('نرخِ نخستِ یک ارز ⇒ تأیید صریح می‌خواهد (ممیزی ن۹)', async () => {
    // پیش‌تر «بدون اشکال» برمی‌گشت؛ یعنی حساس‌ترین نرخِ هر ارز تنها نرخی بود
    // که هیچ گاردی نداشت. حالا یک‌بار در عمرِ هر ارز تأیید می‌خواهد.
    const c = await checkRateOutlier(gl, 'AED', 'IRR', '99999999', DEFAULT_DATE);
    expect(c.ok).toBe(false);
    expect(c.reason).toBe('FIRST_RATE');
    expect(c.last).toBeNull();
  });
});
