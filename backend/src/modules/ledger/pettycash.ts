/**
 * تنخواه‌گردان — docs/ACCOUNTING_SPEC.md بند ۳-۵ (مدل imprest)
 *
 * **مدل imprest یعنی سقف صندوق ثابت است.** تنخواه‌دار مبلغی می‌گیرد، خرج می‌کند،
 * و شارژ مجدد دقیقاً به‌اندازهٔ خرج‌شده انجام می‌شود تا مانده به همان سقف برگردد.
 *
 * چرا این مهم است: در مدل imprest، ماندهٔ صندوق + رسیدهای خرج‌نشده **همیشه**
 * باید برابر سقف باشد. هر انحرافی یعنی خرجی ثبت نشده یا پولی گم شده — و همین
 * خاصیت است که تنخواه را قابل کنترل می‌کند. مدل «هر بار هرچقدر لازم شد بده»
 * این کنترل را ندارد.
 */
import { Prisma } from '@prisma/client';
import { post } from './poster';
import { Minor, Rate, rateFrom } from './money';
import { resolveRate } from './fx';

export const PETTY_CODES = {
  fund: '1102',      // تنخواه‌گردان
  expense: '6201',   // هزینه‌های عمومی (تنخواه)
} as const;

export class PettyCashError extends Error {}

const accountByCode = (tx: Prisma.TransactionClient, code: string) =>
  tx.glAccount.findUniqueOrThrow({ where: { code } });

const rateFor = (tx: Prisma.TransactionClient, cur: string, date: Date): Promise<Rate> =>
  cur === 'IRR' ? Promise.resolve(rateFrom(1)) : resolveRate(tx, cur, date);

export interface PettyContext {
  fiscalYearId: string;
  date: Date;
  createdById?: string | null;
}

/** ساخت صندوق تنخواه با سقف ثابت */
export async function createFund(
  tx: Prisma.TransactionClient,
  input: { name: string; subsidiaryId: string; currencyCode: string; floatAmount: Minor },
) {
  if (input.floatAmount <= 0n) throw new PettyCashError('سقف تنخواه باید بزرگ‌تر از صفر باشد');
  return tx.glPettyCashFund.create({ data: input });
}

/** ماندهٔ فعلی صندوق، از دفتر */
export async function fundBalance(tx: Prisma.TransactionClient, fundId: string): Promise<Minor> {
  const fund = await tx.glPettyCashFund.findUniqueOrThrow({ where: { id: fundId } });
  const account = await accountByCode(tx, PETTY_CODES.fund);

  const rows = await tx.$queryRaw<{ bal: bigint | null }[]>`
    SELECT (SUM(l.debit) - SUM(l.credit))::bigint AS bal
    FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE l."accountId" = ${account.id}
      AND l."subsidiaryId" = ${fund.subsidiaryId}
      AND l."currencyCode" = ${fund.currencyCode}
      AND e.status <> 'DRAFT'
  `;
  return BigInt(rows[0]?.bal ?? 0n);
}

/** تخصیص اولیه: نقد از شرکت به تنخواه‌دار */
export async function allocate(
  tx: Prisma.TransactionClient,
  input: PettyContext & { fundId: string; cashAccountCode: string; amount: Minor },
) {
  if (input.amount <= 0n) throw new PettyCashError('مبلغ تخصیص باید بزرگ‌تر از صفر باشد');

  const fund = await tx.glPettyCashFund.findUniqueOrThrow({ where: { id: input.fundId } });
  const current = await fundBalance(tx, input.fundId);
  if (current + input.amount > fund.floatAmount) {
    throw new PettyCashError(
      `تخصیص از سقف صندوق بیشتر می‌شود: مانده ${current} + ${input.amount} > سقف ${fund.floatAmount}`,
    );
  }

  const fundAcc = await accountByCode(tx, PETTY_CODES.fund);
  const cash = await accountByCode(tx, input.cashAccountCode);
  const rate = await rateFor(tx, fund.currencyCode, input.date);

  return post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.date,
    description: `تخصیص تنخواه — ${fund.name}`,
    entryType: 'NORMAL',
    sourceType: 'PettyCash',
    sourceId: fund.id,
    createdById: input.createdById ?? null,
    lines: [
      { accountId: fundAcc.id, subsidiaryId: fund.subsidiaryId, currencyCode: fund.currencyCode, debit: input.amount, rate, memo: 'تخصیص تنخواه' },
      { accountId: cash.id, currencyCode: fund.currencyCode, credit: input.amount, rate, memo: `تنخواه ${fund.name}` },
    ],
  });
}

/**
 * ثبت هزینهٔ تنخواه — مانده کم می‌شود، هزینه شناسایی می‌شود.
 *
 * مرکز هزینه اختیاری است ولی توصیه می‌شود؛ بدون آن هزینه زیر «تخصیص‌نیافته»
 * در گزارش می‌نشیند.
 */
export async function recordExpense(
  tx: Prisma.TransactionClient,
  input: PettyContext & {
    fundId: string;
    amount: Minor;
    expenseAccountCode?: string;
    costCenterId?: string | null;
    memo?: string;
  },
) {
  if (input.amount <= 0n) throw new PettyCashError('مبلغ هزینه باید بزرگ‌تر از صفر باشد');

  const fund = await tx.glPettyCashFund.findUniqueOrThrow({ where: { id: input.fundId } });
  const balance = await fundBalance(tx, input.fundId);
  if (input.amount > balance) {
    throw new PettyCashError(`هزینه از ماندهٔ تنخواه بیشتر است: ${input.amount} > ${balance}`);
  }

  const fundAcc = await accountByCode(tx, PETTY_CODES.fund);
  const expenseAcc = await accountByCode(tx, input.expenseAccountCode ?? PETTY_CODES.expense);
  const rate = await rateFor(tx, fund.currencyCode, input.date);

  return post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.date,
    description: input.memo ?? `هزینهٔ تنخواه — ${fund.name}`,
    entryType: 'NORMAL',
    sourceType: 'PettyCash',
    sourceId: fund.id,
    createdById: input.createdById ?? null,
    lines: [
      { accountId: expenseAcc.id, costCenterId: input.costCenterId ?? null, currencyCode: fund.currencyCode, debit: input.amount, rate, memo: input.memo ?? 'هزینهٔ تنخواه' },
      { accountId: fundAcc.id, subsidiaryId: fund.subsidiaryId, currencyCode: fund.currencyCode, credit: input.amount, rate, memo: 'کاهش تنخواه' },
    ],
  });
}

/**
 * شارژ مجدد تا سقف — **قلب مدل imprest**.
 *
 * مبلغ شارژ محاسبه می‌شود، نه اینکه از کاربر پرسیده شود:
 *   شارژ = سقف − ماندهٔ فعلی
 *
 * یعنی مبلغ شارژ همیشه دقیقاً برابر جمع هزینه‌های ثبت‌شده از آخرین شارژ است.
 * اگر کاربر بتواند عدد دلخواه بدهد، خاصیت کنترلی imprest از بین می‌رود.
 */
export async function replenish(
  tx: Prisma.TransactionClient,
  input: PettyContext & { fundId: string; cashAccountCode: string },
) {
  const fund = await tx.glPettyCashFund.findUniqueOrThrow({ where: { id: input.fundId } });
  const balance = await fundBalance(tx, input.fundId);
  const amount = fund.floatAmount - balance;

  if (amount <= 0n) {
    throw new PettyCashError('صندوق تنخواه پر است و شارژ لازم ندارد');
  }

  const fundAcc = await accountByCode(tx, PETTY_CODES.fund);
  const cash = await accountByCode(tx, input.cashAccountCode);
  const rate = await rateFor(tx, fund.currencyCode, input.date);

  const entry = await post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.date,
    description: `شارژ مجدد تنخواه — ${fund.name}`,
    entryType: 'NORMAL',
    sourceType: 'PettyCash',
    sourceId: fund.id,
    createdById: input.createdById ?? null,
    lines: [
      { accountId: fundAcc.id, subsidiaryId: fund.subsidiaryId, currencyCode: fund.currencyCode, debit: amount, rate, memo: 'شارژ مجدد تا سقف' },
      { accountId: cash.id, currencyCode: fund.currencyCode, credit: amount, rate, memo: `تنخواه ${fund.name}` },
    ],
  });

  return { entry, amount };
}

/** تسویهٔ نهایی: ماندهٔ باقی‌مانده به شرکت برمی‌گردد و صندوق بسته می‌شود */
export async function settle(
  tx: Prisma.TransactionClient,
  input: PettyContext & { fundId: string; cashAccountCode: string },
) {
  const fund = await tx.glPettyCashFund.findUniqueOrThrow({ where: { id: input.fundId } });
  const balance = await fundBalance(tx, input.fundId);

  if (balance < 0n) throw new PettyCashError('ماندهٔ تنخواه منفی است — ابتدا هزینه‌ها را بررسی کنید');

  let entry = null;
  if (balance > 0n) {
    const fundAcc = await accountByCode(tx, PETTY_CODES.fund);
    const cash = await accountByCode(tx, input.cashAccountCode);
    const rate = await rateFor(tx, fund.currencyCode, input.date);

    entry = await post(tx, {
      fiscalYearId: input.fiscalYearId,
      date: input.date,
      description: `تسویهٔ تنخواه — ${fund.name}`,
      entryType: 'NORMAL',
      sourceType: 'PettyCash',
      sourceId: fund.id,
      createdById: input.createdById ?? null,
      lines: [
        { accountId: cash.id, currencyCode: fund.currencyCode, debit: balance, rate, memo: `بازگشت ماندهٔ تنخواه ${fund.name}` },
        { accountId: fundAcc.id, subsidiaryId: fund.subsidiaryId, currencyCode: fund.currencyCode, credit: balance, rate, memo: 'تسویهٔ تنخواه' },
      ],
    });
  }

  await tx.glPettyCashFund.update({ where: { id: fund.id }, data: { isActive: false } });
  return { entry, returned: balance };
}
