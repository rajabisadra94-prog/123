/**
 * فاز ۷ — چک و تنخواه‌گردان.
 *
 * دو چیزی که این تست‌ها بیش از همه می‌سنجند:
 *   • **هر انتقال وضعیت چک سند می‌زند** — الزام صریح بند ۳-۵
 *   • **مدل imprest**: مانده + هزینه‌ها همیشه برابر سقف است
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, resetBusinessData, seedGlChart, makeFiscalYear, accountByCode,
  D, DEFAULT_DATE, expectRejects,
} from '../helpers/gl';
import { ensureSubsidiary, createStandalone } from '../../src/modules/ledger/subsidiary';
import { ensureDefaultCostCenters } from '../../src/modules/ledger/costcenter';
import { post } from '../../src/modules/ledger/poster';
import {
  receiveCheque, issueCheque, transitionCheque, overdueCheques, CHEQUE_CODES,
} from '../../src/modules/ledger/cheque';
import {
  createFund, fundBalance, allocate, recordExpense, replenish, settle, PETTY_CODES,
} from '../../src/modules/ledger/pettycash';

let fy: { id: string };
let customer: any, producer: any, holder: any;
let ar: any, cash: any, sales: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
let seq = 0;
const nextId = () => String(++seq).padStart(2, '0');

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
  ar = await accountByCode('1104');
  cash = await accountByCode('110101');
  sales = await accountByCode('4101');
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl();
  await resetBusinessData();
  fy = await makeFiscalYear();
  await tx((t) => ensureDefaultCostCenters(t));

  const id = nextId();
  const c = await gl.customer.create({ data: { name: 'مشتری چک', shortCode: `Q${id}` } });
  const p = await gl.producer.create({ data: { name: 'سازندهٔ چک' } });
  customer = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
  producer = await tx((t) => ensureSubsidiary(t, 'PRODUCER', 'Producer', p.id, p.name));
  holder = await tx((t) => createStandalone(t, 'PETTY_CASH_HOLDER', 'تنخواه‌دار الف'));
});

/** ماندهٔ یک حساب به ارز پایه، مستقیم از دفتر */
async function balanceOf(accountCode: string): Promise<bigint> {
  const acc = await accountByCode(accountCode);
  const rows = await gl.$queryRaw<{ bal: bigint | null }[]>`
    SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS bal
    FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE l."accountId" = ${acc.id} AND e.status <> 'DRAFT'
  `;
  return BigInt(rows[0]?.bal ?? 0n);
}

/** طلب اولیه از مشتری تا چک بتواند آن را ببندد */
const openReceivable = (amount: bigint) =>
  tx((t) => post(t, {
    fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش نسیه',
    lines: [
      { accountId: ar.id, subsidiaryId: customer.id, currencyCode: 'IRR', debit: amount },
      { accountId: sales.id, currencyCode: 'IRR', credit: amount },
    ],
  }));

const newCheque = (over: Partial<any> = {}) => ({
  fiscalYearId: fy.id, date: DEFAULT_DATE,
  number: `CHQ-${nextId()}`, bankName: 'ملت',
  amount: 50_000_000n, currencyCode: 'IRR',
  issueDate: D('2026-05-01'), dueDate: D('2026-08-01'),
  subsidiaryId: customer.id,
  ...over,
});

// ═══════════════════════════════════════════════════════════════
describe('چک دریافتی', () => {
  it('دریافت چک، طلب تجاری را می‌بندد و اسناد دریافتنی باز می‌کند', async () => {
    await openReceivable(50_000_000n);
    const { cheque } = await tx((t) => receiveCheque(t, newCheque()));

    expect(cheque.status).toBe('IN_HAND');
    expect(await balanceOf(CHEQUE_CODES.receivable)).toBe(0n);      // طلب بسته شد
    expect(await balanceOf(CHEQUE_CODES.inHand)).toBe(50_000_000n); // چک نشست
  });

  it('هر انتقال وضعیت یک سند می‌زند — بدون استثنا', async () => {
    await openReceivable(50_000_000n);
    const { cheque } = await tx((t) => receiveCheque(t, newCheque()));

    await tx((t) => transitionCheque(t, {
      fiscalYearId: fy.id, date: D('2026-07-01'), chequeId: cheque.id, to: 'IN_COLLECTION',
    }));
    await tx((t) => transitionCheque(t, {
      fiscalYearId: fy.id, date: D('2026-08-01'), chequeId: cheque.id, to: 'COLLECTED',
      cashAccountCode: '110101',
    }));

    const transitions = await gl.glChequeTransition.findMany({ where: { chequeId: cheque.id } });
    expect(transitions).toHaveLength(3);            // دریافت + دو گذار
    // هیچ گذاری بدون سند نیست — schema اجازه نمی‌دهد، اینجا هم تأیید می‌شود
    for (const t of transitions) expect(t.entryId).toBeTruthy();
    expect(await gl.glEntry.count()).toBe(4);       // فروش + سه سند چک
  });

  it('چرخهٔ کامل تا وصول: پول به صندوق می‌رسد و چک صفر می‌شود', async () => {
    await openReceivable(50_000_000n);
    const { cheque } = await tx((t) => receiveCheque(t, newCheque()));
    await tx((t) => transitionCheque(t, { fiscalYearId: fy.id, date: D('2026-07-01'), chequeId: cheque.id, to: 'IN_COLLECTION' }));
    await tx((t) => transitionCheque(t, {
      fiscalYearId: fy.id, date: D('2026-08-01'), chequeId: cheque.id, to: 'COLLECTED', cashAccountCode: '110101',
    }));

    expect(await balanceOf(CHEQUE_CODES.inHand)).toBe(0n);
    expect(await balanceOf(CHEQUE_CODES.inCollection)).toBe(0n);
    expect(await balanceOf('110101')).toBe(50_000_000n);
  });

  it('چک برگشتی روی حساب خودش می‌نشیند و طلب از مشتری باقی می‌ماند', async () => {
    await openReceivable(50_000_000n);
    const { cheque } = await tx((t) => receiveCheque(t, newCheque()));
    await tx((t) => transitionCheque(t, { fiscalYearId: fy.id, date: D('2026-07-01'), chequeId: cheque.id, to: 'IN_COLLECTION' }));
    await tx((t) => transitionCheque(t, { fiscalYearId: fy.id, date: D('2026-08-05'), chequeId: cheque.id, to: 'BOUNCED' }));

    expect(await balanceOf(CHEQUE_CODES.bounced)).toBe(50_000_000n);
    expect(await balanceOf(CHEQUE_CODES.inCollection)).toBe(0n);
  });

  it('خرج‌کردن چک، بدهی به شخص ثالث را می‌بندد', async () => {
    await openReceivable(50_000_000n);
    const { cheque } = await tx((t) => receiveCheque(t, newCheque()));

    // ابتدا بدهی به سازنده
    await tx(async (t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'خرید نسیه',
      lines: [
        { accountId: (await accountByCode('5101')).id, currencyCode: 'IRR', debit: 50_000_000n },
        { accountId: (await accountByCode('2101')).id, subsidiaryId: producer.id, currencyCode: 'IRR', credit: 50_000_000n },
      ],
    }));

    await tx((t) => transitionCheque(t, {
      fiscalYearId: fy.id, date: D('2026-07-01'), chequeId: cheque.id,
      to: 'ENDORSED', endorseToSubsidiaryId: producer.id,
    }));

    expect(await balanceOf(CHEQUE_CODES.inHand)).toBe(0n);
    expect(await balanceOf(CHEQUE_CODES.payable)).toBe(0n);   // بدهی به سازنده بسته شد
  });

  it('گذار غیرمجاز رد می‌شود و گذارهای ممکن را می‌گوید', async () => {
    await openReceivable(50_000_000n);
    const { cheque } = await tx((t) => receiveCheque(t, newCheque()));
    // نزد صندوق نمی‌تواند مستقیم وصول شود
    await expectRejects(
      () => tx((t) => transitionCheque(t, {
        fiscalYearId: fy.id, date: DEFAULT_DATE, chequeId: cheque.id, to: 'COLLECTED', cashAccountCode: '110101',
      })),
      /مجاز نیست/,
    );
  });

  it('وضعیت پایانی هیچ گذاری ندارد', async () => {
    await openReceivable(50_000_000n);
    const { cheque } = await tx((t) => receiveCheque(t, newCheque()));
    await tx((t) => transitionCheque(t, { fiscalYearId: fy.id, date: D('2026-07-01'), chequeId: cheque.id, to: 'IN_COLLECTION' }));
    await tx((t) => transitionCheque(t, {
      fiscalYearId: fy.id, date: D('2026-08-01'), chequeId: cheque.id, to: 'COLLECTED', cashAccountCode: '110101',
    }));
    await expectRejects(
      () => tx((t) => transitionCheque(t, { fiscalYearId: fy.id, date: D('2026-08-02'), chequeId: cheque.id, to: 'BOUNCED' })),
      /وضعیت پایانی/,
    );
  });

  it('سررسید پیش از تاریخ صدور رد می‌شود', async () => {
    await expectRejects(
      () => tx((t) => receiveCheque(t, newCheque({ issueDate: D('2026-08-01'), dueDate: D('2026-05-01') }))),
      /سررسید/,
    );
  });

  it('چک سررسیدشده و تعیین‌تکلیف‌نشده گزارش می‌شود', async () => {
    await openReceivable(50_000_000n);
    await tx((t) => receiveCheque(t, newCheque({ dueDate: D('2026-06-15') })));

    const overdue = await overdueCheques(gl, D('2026-07-01'));
    expect(overdue).toHaveLength(1);
    expect(overdue[0].status).toBe('IN_HAND');

    // پیش از سررسید، چیزی گزارش نمی‌شود
    expect(await overdueCheques(gl, D('2026-06-01'))).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('چک پرداختی', () => {
  const openPayable = (amount: bigint) =>
    tx(async (t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'خرید نسیه',
      lines: [
        { accountId: (await accountByCode('5101')).id, currencyCode: 'IRR', debit: amount },
        { accountId: (await accountByCode('2101')).id, subsidiaryId: producer.id, currencyCode: 'IRR', credit: amount },
      ],
    }));

  it('صدور چک، بدهی تجاری را به اسناد پرداختنی تبدیل می‌کند', async () => {
    await openPayable(30_000_000n);
    const { cheque } = await tx((t) => issueCheque(t, newCheque({
      amount: 30_000_000n, subsidiaryId: producer.id,
    })));

    expect(cheque.status).toBe('ISSUED');
    expect(await balanceOf(CHEQUE_CODES.payable)).toBe(0n);
    expect(await balanceOf(CHEQUE_CODES.notesPayable)).toBe(-30_000_000n);
  });

  it('پاس‌شدن چک، پول را از صندوق کم می‌کند', async () => {
    await openPayable(30_000_000n);
    await tx(async (t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'تأمین نقد',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 100_000_000n },
        { accountId: (await accountByCode('3101')).id, currencyCode: 'IRR', credit: 100_000_000n },
      ],
    }));

    const { cheque } = await tx((t) => issueCheque(t, newCheque({ amount: 30_000_000n, subsidiaryId: producer.id })));
    await tx((t) => transitionCheque(t, {
      fiscalYearId: fy.id, date: D('2026-08-01'), chequeId: cheque.id, to: 'CLEARED', cashAccountCode: '110101',
    }));

    expect(await balanceOf(CHEQUE_CODES.notesPayable)).toBe(0n);
    expect(await balanceOf('110101')).toBe(70_000_000n);
  });

  it('ابطال چک، بدهی را به شکل اولش برمی‌گرداند', async () => {
    await openPayable(30_000_000n);
    const { cheque } = await tx((t) => issueCheque(t, newCheque({ amount: 30_000_000n, subsidiaryId: producer.id })));
    await tx((t) => transitionCheque(t, {
      fiscalYearId: fy.id, date: D('2026-07-01'), chequeId: cheque.id, to: 'VOIDED',
    }));

    expect(await balanceOf(CHEQUE_CODES.notesPayable)).toBe(0n);
    expect(await balanceOf(CHEQUE_CODES.payable)).toBe(-30_000_000n);   // بدهی برگشت
  });
});

// ═══════════════════════════════════════════════════════════════
describe('تنخواه‌گردان (imprest)', () => {
  const FLOAT = 20_000_000n;

  async function setupFund() {
    // نقد اولیه برای شرکت
    await tx(async (t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'آورده',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 500_000_000n },
        { accountId: (await accountByCode('3101')).id, currencyCode: 'IRR', credit: 500_000_000n },
      ],
    }));
    return tx((t) => createFund(t, {
      name: 'تنخواه دفتر', subsidiaryId: holder.id, currencyCode: 'IRR', floatAmount: FLOAT,
    }));
  }

  it('تخصیص، مانده را تا سقف بالا می‌برد', async () => {
    const fund = await setupFund();
    await tx((t) => allocate(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, fundId: fund.id, cashAccountCode: '110101', amount: FLOAT,
    }));
    expect(await fundBalance(gl, fund.id)).toBe(FLOAT);
  });

  it('تخصیص بیش از سقف رد می‌شود', async () => {
    const fund = await setupFund();
    await expectRejects(
      () => tx((t) => allocate(t, {
        fiscalYearId: fy.id, date: DEFAULT_DATE, fundId: fund.id,
        cashAccountCode: '110101', amount: FLOAT + 1n,
      })),
      /سقف صندوق/,
    );
  });

  it('هزینه، مانده را کم می‌کند و هزینه را شناسایی می‌کند', async () => {
    const fund = await setupFund();
    await tx((t) => allocate(t, { fiscalYearId: fy.id, date: DEFAULT_DATE, fundId: fund.id, cashAccountCode: '110101', amount: FLOAT }));

    const admin = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '3' } });
    await tx((t) => recordExpense(t, {
      fiscalYearId: fy.id, date: D('2026-06-05'), fundId: fund.id,
      amount: 3_000_000n, costCenterId: admin.id, memo: 'خرید لوازم اداری',
    }));

    expect(await fundBalance(gl, fund.id)).toBe(17_000_000n);
    expect(await balanceOf(PETTY_CODES.expense)).toBe(3_000_000n);
  });

  it('هزینهٔ بیش از مانده رد می‌شود', async () => {
    const fund = await setupFund();
    await tx((t) => allocate(t, { fiscalYearId: fy.id, date: DEFAULT_DATE, fundId: fund.id, cashAccountCode: '110101', amount: FLOAT }));
    await expectRejects(
      () => tx((t) => recordExpense(t, {
        fiscalYearId: fy.id, date: DEFAULT_DATE, fundId: fund.id, amount: FLOAT + 1n,
      })),
      /بیشتر است/,
    );
  });

  it('شارژ مجدد، مبلغ را خودش حساب می‌کند و مانده را به سقف برمی‌گرداند', async () => {
    const fund = await setupFund();
    await tx((t) => allocate(t, { fiscalYearId: fy.id, date: DEFAULT_DATE, fundId: fund.id, cashAccountCode: '110101', amount: FLOAT }));
    await tx((t) => recordExpense(t, { fiscalYearId: fy.id, date: D('2026-06-05'), fundId: fund.id, amount: 3_000_000n }));
    await tx((t) => recordExpense(t, { fiscalYearId: fy.id, date: D('2026-06-06'), fundId: fund.id, amount: 4_500_000n }));

    const res: any = await tx((t) => replenish(t, {
      fiscalYearId: fy.id, date: D('2026-06-10'), fundId: fund.id, cashAccountCode: '110101',
    }));

    // مبلغ شارژ دقیقاً برابر جمع هزینه‌هاست — نه عددی که کاربر می‌دهد
    expect(res.amount).toBe(7_500_000n);
    expect(await fundBalance(gl, fund.id)).toBe(FLOAT);
  });

  it('شارژ صندوق پر رد می‌شود', async () => {
    const fund = await setupFund();
    await tx((t) => allocate(t, { fiscalYearId: fy.id, date: DEFAULT_DATE, fundId: fund.id, cashAccountCode: '110101', amount: FLOAT }));
    await expectRejects(
      () => tx((t) => replenish(t, { fiscalYearId: fy.id, date: DEFAULT_DATE, fundId: fund.id, cashAccountCode: '110101' })),
      /پر است/,
    );
  });

  it('خاصیت imprest: مانده + هزینه‌ها همیشه برابر سقف است', async () => {
    const fund = await setupFund();
    await tx((t) => allocate(t, { fiscalYearId: fy.id, date: DEFAULT_DATE, fundId: fund.id, cashAccountCode: '110101', amount: FLOAT }));

    let spent = 0n;
    for (const amt of [1_000_000n, 2_500_000n, 800_000n]) {
      await tx((t) => recordExpense(t, { fiscalYearId: fy.id, date: D('2026-06-05'), fundId: fund.id, amount: amt }));
      spent += amt;
      expect(await fundBalance(gl, fund.id) + spent).toBe(FLOAT);
    }
  });

  it('تسویه، مانده را برمی‌گرداند و صندوق را می‌بندد', async () => {
    const fund = await setupFund();
    await tx((t) => allocate(t, { fiscalYearId: fy.id, date: DEFAULT_DATE, fundId: fund.id, cashAccountCode: '110101', amount: FLOAT }));
    await tx((t) => recordExpense(t, { fiscalYearId: fy.id, date: D('2026-06-05'), fundId: fund.id, amount: 5_000_000n }));

    const res: any = await tx((t) => settle(t, {
      fiscalYearId: fy.id, date: D('2026-06-30'), fundId: fund.id, cashAccountCode: '110101',
    }));

    expect(res.returned).toBe(15_000_000n);
    expect(await fundBalance(gl, fund.id)).toBe(0n);
    const after = await gl.glPettyCashFund.findUniqueOrThrow({ where: { id: fund.id } });
    expect(after.isActive).toBe(false);
  });
});
