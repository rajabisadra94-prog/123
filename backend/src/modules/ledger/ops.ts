/**
 * عملیات روزمرهٔ مالی روی هستهٔ جدید — لایهٔ نازک بین مسیر HTTP و موتور.
 *
 * ریاضیاتِ حسابداری در `fx.ts` (تسویه، تبدیل) و `poster.ts` (ثبت خام) است.
 * اینجا فقط **نگاشتِ ورودیِ کاربر** انجام می‌شود: «طرف‌حساب» → تفصیلی + معین
 * کنترلی، «حساب شرکت» → کد حساب، «مبلغ نمایشی» → کوچک‌ترین واحد.
 *
 * معادلِ هستهٔ جدیدِ چهار پنجرهٔ عملیاتیِ صفحهٔ `/accounting`:
 *   دریافت/پرداخت · تبدیل ارز · انتقال داخلی · ثبت هزینه
 *
 * هیچ‌کدام از این توابع تراکنش نمی‌سازند — مسیر HTTP باید داخل `$transaction`
 * صداشان بزند (سریال قفل‌دار و تریگر توازن به تراکنش بند است).
 */
import { Prisma, GlSubsidiaryKind } from '@prisma/client';
import { AppError } from '../../shared/middleware/errorHandler';
import { post } from './poster';
import { parseAmount, rateFrom, Rate, Minor } from './money';
import {
  postSettlement, postConversion, resolveRate, carryingRate, positionBalance, assertFxCover,
} from './fx';

/**
 * معین کنترلیِ پیش‌فرضِ هر نوع تفصیلی — مطابق `LEDGER_MIGRATION.md` بخش ۴-۲.
 * مشتری زیر «دریافتنی تجاری»، بقیه زیر «پرداختنی تجاری». مسیر می‌تواند با
 * `obligationAccountCode` صریح override کند (مثلاً پیش‌دریافت مشتری زیر ۲۱۰۳).
 */
const DEFAULT_OBLIGATION_CODE: Record<GlSubsidiaryKind, string> = {
  CUSTOMER: '1104',
  PRODUCER: '2101',
  SUPPLIER: '2101',
  CARRIER: '2101',
  EXCHANGE: '2101',
  AGENT: '2101',
  EMPLOYEE: '2101',
  PETTY_CASH_HOLDER: '2101',
  BANK: '2101',
  OTHER: '2101',
};

/** حساب هزینهٔ پیش‌فرض برای «ثبت هزینه/تنخواه» */
const DEFAULT_EXPENSE_CODE = '6201';
/** حساب هزینهٔ کارمزد صرافی */
const FEE_EXPENSE_CODE = '7102';

async function decimalsOf(tx: Prisma.TransactionClient, code: string): Promise<number> {
  const c = await tx.glCurrency.findUnique({ where: { code } });
  if (!c) throw new AppError(400, `ارز «${code}» تعریف نشده است`);
  return c.decimalPlaces;
}

async function accountByCodeOr404(tx: Prisma.TransactionClient, code: string) {
  const a = await tx.glAccount.findUnique({ where: { code } });
  if (!a) throw new AppError(404, `حساب با کد ${code} در چارت نیست`);
  if (!a.isActive) throw new AppError(400, `حساب ${code} غیرفعال است`);
  return a;
}

async function companyLeaf(tx: Prisma.TransactionClient, code: string) {
  const a = await accountByCodeOr404(tx, code);
  if (!a.isPostable) throw new AppError(400, `حساب ${code} سرگروه است و سند نمی‌پذیرد`);
  return a;
}

/**
 * نرخِ حملِ یک موضع (بهای تمام‌شدهٔ ماندهٔ باز) با fallback به نرخ روز.
 * برای انتقال و تبدیلِ ارزِ شرکت لازم است تا بهای تاریخی حفظ شود.
 */
async function positionOrDayRate(
  tx: Prisma.TransactionClient,
  accountId: string,
  currency: string,
  date: Date,
): Promise<Rate> {
  return (
    (await carryingRate(tx, { accountId, currencyCode: currency })) ??
    (await resolveRate(tx, currency, date))
  );
}

// ═══════════════════════════════════════════════════════════════
// دریافت / پرداخت
// ═══════════════════════════════════════════════════════════════

export interface SettlementRequest {
  fiscalYearId: string;
  date: Date;
  direction: 'RECEIPT' | 'PAYMENT';
  subsidiaryId: string;
  currency: string;
  /** مبلغ به واحد نمایش (نه کوچک‌ترین واحد) */
  amount: string;
  /** حساب نقدی شرکت — هم‌ارز با تعهد */
  cashAccountCode: string;
  /** پیش‌فرض از نوع تفصیلی مشتق می‌شود */
  obligationAccountCode?: string;
  /** نرخ روزِ ارز به ریال؛ اگر ندهی از جدول `GlExchangeRate` خوانده می‌شود */
  dayRate?: string;
  description?: string;
  attachmentUrls?: string[];
  createdById?: string | null;
  /** برای دونویسی — شناسهٔ سند هستهٔ قدیمی، تا دوباره ثبت نشود */
  sourceId?: string | null;
  /**
   * ممیزی ب۴: اگر مبلغ از ماندهٔ باز بیشتر بود، مازاد به‌جای منفی‌کردنِ حسابِ
   * تعهد، به پیش‌دریافت (۲۱۰۳) / پیش‌پرداخت (۱۱۰۵) می‌رود. بدون این فلگ، مازاد
   * با خطای روشن رد می‌شود.
   */
  allowPrepayment?: boolean;
  /**
   * ممیزی ج۹: تسویهٔ بین‌ارزی در یک سند. اگر ارز حساب نقدی با ارز تعهد فرق دارد،
   * مبلغِ واقعیِ نقدِ پرداخت/دریافت‌شده به ارز حساب اینجا داده می‌شود (واحد نمایش).
   * بدون این، فقط تسویهٔ هم‌ارز پذیرفته می‌شود.
   */
  cashCurrency?: string;
  cashAmount?: string;
}

/** حساب پیش‌دریافت/پیش‌پرداخت برای مازادِ تسویه */
const PREPAYMENT_CODE: Record<'RECEIPT' | 'PAYMENT', string> = { RECEIPT: '2103', PAYMENT: '1105' };

export async function doSettlement(tx: Prisma.TransactionClient, req: SettlementRequest) {
  const sub = await tx.glSubsidiary.findUnique({ where: { id: req.subsidiaryId } });
  if (!sub) throw new AppError(404, 'تفصیلی طرف‌حساب یافت نشد');

  const obligationCode = req.obligationAccountCode ?? DEFAULT_OBLIGATION_CODE[sub.kind];
  const obAcc = await accountByCodeOr404(tx, obligationCode);
  const cash = await companyLeaf(tx, req.cashAccountCode);

  // ارز و مبلغ سمتِ نقد: پیش‌فرض هم‌ارزِ تعهد؛ اگر cashCurrency داده شود، بین‌ارزی
  const cashCurrency = req.cashCurrency ?? cash.currencyCode ?? req.currency;
  const crossCurrency = cashCurrency !== req.currency;
  if (crossCurrency && !req.cashAmount) {
    throw new AppError(400, 'برای تسویهٔ بین‌ارزی، مبلغِ نقدِ پرداخت/دریافت‌شده به ارز حساب لازم است');
  }
  if (cash.currencyMode === 'SINGLE' && cash.currencyCode !== cashCurrency) {
    throw new AppError(400, `حساب «${cash.name}» فقط ${cash.currencyCode} می‌پذیرد`);
  }

  const fd = await decimalsOf(tx, req.currency);
  const cashFd = await decimalsOf(tx, cashCurrency);
  const settledAmount = parseAmount(req.amount, fd);

  /**
   * ممیزی ن۷: در تسویهٔ **هم‌ارز** مبلغ نقد اجباراً برابر مبلغ تعهد است. پیش از
   * این، `cashAmount`ی که کاربر می‌فرستاد بی‌صدا دور ریخته می‌شد — یعنی یک غلطِ
   * تایپی در مبلغ نقد به‌جای خطا، ناپدید می‌شد. حالا ناسازگاری صریح رد می‌شود.
   */
  if (!crossCurrency && req.cashAmount !== undefined && req.cashAmount !== null && req.cashAmount !== '') {
    const given = parseAmount(req.cashAmount, cashFd);
    if (given !== settledAmount) {
      throw new AppError(
        400,
        `در تسویهٔ هم‌ارز، مبلغ نقد باید برابر مبلغ تعهد باشد — ` +
        `تعهد ${formatAmountPlain(settledAmount, fd)} ولی نقد ${formatAmountPlain(given, cashFd)}. ` +
        'اگر ارز پرداخت فرق دارد، ارز حساب نقدی را عوض کنید.',
      );
    }
  }

  const cashAmount = crossCurrency ? parseAmount(req.cashAmount!, cashFd) : settledAmount;
  if (settledAmount <= 0n) throw new AppError(400, 'مبلغ باید بزرگ‌تر از صفر باشد');

  // ممیزی ب۴: مازاد بر ماندهٔ باز — رد یا پیش‌دریافت/پیش‌پرداخت
  const pos = await positionBalance(tx, {
    accountId: obAcc.id, subsidiaryId: req.subsidiaryId, currencyCode: req.currency,
  });
  const open = pos.amount > 0n ? pos.amount : 0n;
  if (settledAmount > open && !req.allowPrepayment) {
    const label = req.direction === 'RECEIPT' ? 'پیش‌دریافت' : 'پیش‌پرداخت';
    throw new AppError(
      400,
      `مبلغ تسویه از ماندهٔ باز (${formatAmountPlain(open, fd)}) بیشتر است. ` +
      `برای ثبتِ مازاد به‌عنوان ${label}، گزینهٔ «مازاد = ${label}» را فعال کنید.`,
    );
  }

  return postSettlement(tx, {
    fiscalYearId: req.fiscalYearId,
    date: req.date,
    direction: req.direction,
    obligationAccountCode: obligationCode,
    subsidiaryId: req.subsidiaryId,
    obligationCurrency: req.currency,
    settledAmount,
    cashAccountCode: req.cashAccountCode,
    cashCurrency,
    cashAmount,
    cashRate: req.dayRate ? rateFrom(req.dayRate) : undefined,
    description: req.description,
    attachmentUrls: req.attachmentUrls,
    createdById: req.createdById,
    sourceId: req.sourceId,
    // پیش‌دریافت فقط در تسویهٔ هم‌ارز
    prepaymentAccountCode: !crossCurrency && req.allowPrepayment ? PREPAYMENT_CODE[req.direction] : undefined,
  });
}

/** فقط برای پیام خطا — مبلغِ خوانا بدون وابستگی به ارز نمایش */
function formatAmountPlain(minor: Minor, decimals: number): string {
  if (decimals === 0) return minor.toString();
  const p = 10n ** BigInt(decimals);
  return `${minor / p}.${(minor % p).toString().padStart(decimals, '0')}`;
}

/** پیش‌نمایش تسویه — مانده و نرخ دفتریِ موضع، پیش از ثبت */
export async function settlementPreview(
  tx: Prisma.TransactionClient,
  subsidiaryId: string,
  currency: string,
  asOf: Date,
) {
  const sub = await tx.glSubsidiary.findUnique({ where: { id: subsidiaryId } });
  if (!sub) throw new AppError(404, 'تفصیلی طرف‌حساب یافت نشد');

  const obligationCode = DEFAULT_OBLIGATION_CODE[sub.kind];
  const acc = await accountByCodeOr404(tx, obligationCode);
  const key = { accountId: acc.id, subsidiaryId, currencyCode: currency };

  const [{ amount, base }, booked] = await Promise.all([
    positionBalance(tx, key),
    carryingRate(tx, key),
  ]);
  let dayRate: string | null = null;
  try {
    dayRate = rateToPlain(await resolveRate(tx, currency, asOf));
  } catch {
    dayRate = null; // نرخی ثبت نشده — فرم دستی پرش می‌کند
  }

  return {
    obligationAccountCode: obligationCode,
    balance: amount.toString(),
    balanceBase: base.toString(),
    carryingRate: booked ? rateToPlain(booked) : null,
    dayRate,
  };
}

// ═══════════════════════════════════════════════════════════════
// تبدیل ارز
// ═══════════════════════════════════════════════════════════════

export interface ConversionRequest {
  fiscalYearId: string;
  date: Date;
  fromAccountCode: string;
  fromCurrency: string;
  fromAmount: string;
  toAccountCode: string;
  toCurrency: string;
  toAmount: string;
  /** کارمزد صرافی — اختیاری */
  fee?: {
    amount: string;
    currency: string;
    /** حساب شرکت که کارمزد از آن پرداخت می‌شود */
    accountCode: string;
    /** اگر صراف مشخص است، گردش کارمزد در دفتر او هم ثبت می‌شود */
    exchangeSubsidiaryId?: string;
  };
  description?: string;
  attachmentUrls?: string[];
  createdById?: string | null;
}

export async function doConversion(tx: Prisma.TransactionClient, req: ConversionRequest) {
  const fromAcc = await companyLeaf(tx, req.fromAccountCode);
  const toAcc = await companyLeaf(tx, req.toAccountCode);
  if (req.fromCurrency === req.toCurrency) {
    throw new AppError(400, 'ارز مبدأ و مقصد باید متفاوت باشد — برای هم‌ارز از «انتقال» استفاده کنید');
  }
  for (const [acc, cur] of [[fromAcc, req.fromCurrency], [toAcc, req.toCurrency]] as const) {
    if (acc.currencyMode === 'SINGLE' && acc.currencyCode !== cur) {
      throw new AppError(400, `حساب «${acc.name}» فقط ${acc.currencyCode} می‌پذیرد`);
    }
  }

  const fromFd = await decimalsOf(tx, req.fromCurrency);
  const toFd = await decimalsOf(tx, req.toCurrency);
  const fromAmount = parseAmount(req.fromAmount, fromFd);
  const toAmount = parseAmount(req.toAmount, toFd);
  if (fromAmount <= 0n || toAmount <= 0n) throw new AppError(400, 'مبالغ باید بزرگ‌تر از صفر باشند');

  const entry = await postConversion(tx, {
    fiscalYearId: req.fiscalYearId,
    date: req.date,
    fromAccountCode: req.fromAccountCode,
    fromCurrency: req.fromCurrency,
    fromAmount,
    toAccountCode: req.toAccountCode,
    toCurrency: req.toCurrency,
    toAmount,
    description: req.description,
    attachmentUrls: req.attachmentUrls,
    createdById: req.createdById,
  });

  // ممیزی ب۷: اعشار از خودِ ارز کارمزد خوانده می‌شود، نه صفرِ ثابت —
  // وگرنه کارمزدِ کسری («۰٫۴ دلار») بی‌صدا حذف می‌شد.
  let feeEntry: Awaited<ReturnType<typeof post>> | undefined;
  if (req.fee && parseAmount(req.fee.amount, await decimalsOf(tx, req.fee.currency)) > 0n) {
    feeEntry = await postConversionFee(tx, req);
  }

  return { entry, feeEntry };
}

/**
 * سند کارمزد صرافی — سند جدا از خودِ تبدیل.
 *
 * بدهکار «کارمزد صرافی»؛ اگر صراف مشخص باشد یک گردشِ خنثی در دفتر او هم ثبت
 * می‌شود (بدهی و تسویهٔ آنی) تا کارمزد در حساب صراف دیده شود؛ بستانکار حساب شرکت.
 */
async function postConversionFee(tx: Prisma.TransactionClient, req: ConversionRequest) {
  const fee = req.fee!;
  const feeCur = fee.currency;
  /*
    مسیر HTTP وقتی حساب کارمزد داده نشود رشتهٔ خالی می‌فرستد، و آن‌وقت پیام
    خطا می‌شد «حساب با کد  در چارت نیست» — با یک جای خالی وسطش. کاربر از این
    جمله نمی‌فهمد چه چیزی را جا انداخته.
  */
  if (!fee.accountCode || !fee.accountCode.trim()) {
    throw new AppError(400, 'برای ثبت کارمزد، حسابی که کارمزد از آن پرداخت می‌شود را انتخاب کنید');
  }
  const feeAcc = await companyLeaf(tx, fee.accountCode.trim());
  if (feeAcc.currencyMode === 'SINGLE' && feeAcc.currencyCode !== feeCur) {
    throw new AppError(400, `کارمزد به ${feeCur} است — حساب پرداخت‌کننده هم باید ${feeCur} باشد`);
  }

  const fd = await decimalsOf(tx, feeCur);
  const amount = parseAmount(fee.amount, fd);
  if (amount <= 0n) throw new AppError(400, 'مبلغ کارمزد باید بزرگ‌تر از صفر باشد');

  await assertFxCover(tx, { accountId: feeAcc.id, currencyCode: feeCur, outgoing: amount });

  const feeExpense = await accountByCodeOr404(tx, FEE_EXPENSE_CODE);
  const rate = await positionOrDayRate(tx, feeAcc.id, feeCur, req.date);

  const lines = [
    { accountId: feeExpense.id, currencyCode: feeCur, debit: amount, rate, memo: 'هزینهٔ کارمزد صرافی' },
  ] as Parameters<typeof post>[1]['lines'];

  if (fee.exchangeSubsidiaryId) {
    const exSub = await tx.glSubsidiary.findUnique({ where: { id: fee.exchangeSubsidiaryId } });
    if (!exSub) throw new AppError(404, 'تفصیلی صراف یافت نشد');
    const payable = await accountByCodeOr404(tx, '2101');
    lines.push(
      { accountId: payable.id, subsidiaryId: exSub.id, currencyCode: feeCur, credit: amount, rate, memo: 'کارمزد صراف' },
      { accountId: payable.id, subsidiaryId: exSub.id, currencyCode: feeCur, debit: amount, rate, memo: 'تسویهٔ کارمزد' },
    );
  }
  lines.push({ accountId: feeAcc.id, currencyCode: feeCur, credit: amount, rate, memo: 'پرداخت کارمزد' });

  return post(tx, {
    fiscalYearId: req.fiscalYearId,
    date: req.date,
    description: `کارمزد عملیات ارزی (${feeCur})`,
    entryType: 'NORMAL',
    sourceType: 'ConversionFee',
    createdById: req.createdById ?? null,
    attachmentUrls: req.attachmentUrls,
    lines,
  });
}

// ═══════════════════════════════════════════════════════════════
// انتقال داخلی (هم‌ارز، بین حساب‌های شرکت)
// ═══════════════════════════════════════════════════════════════

export interface TransferRequest {
  fiscalYearId: string;
  date: Date;
  fromAccountCode: string;
  toAccountCode: string;
  currency: string;
  amount: string;
  dayRate?: string;
  description?: string;
  attachmentUrls?: string[];
  createdById?: string | null;
}

export async function doTransfer(tx: Prisma.TransactionClient, req: TransferRequest) {
  if (req.fromAccountCode === req.toAccountCode) {
    throw new AppError(400, 'حساب مبدأ و مقصد نمی‌تواند یکی باشد');
  }
  const fromAcc = await companyLeaf(tx, req.fromAccountCode);
  const toAcc = await companyLeaf(tx, req.toAccountCode);
  for (const acc of [fromAcc, toAcc]) {
    if (acc.currencyMode === 'SINGLE' && acc.currencyCode !== req.currency) {
      throw new AppError(400, `حساب «${acc.name}» فقط ${acc.currencyCode} می‌پذیرد`);
    }
  }

  const fd = await decimalsOf(tx, req.currency);
  const amount = parseAmount(req.amount, fd);
  if (amount <= 0n) throw new AppError(400, 'مبلغ باید بزرگ‌تر از صفر باشد');

  await assertFxCover(tx, { accountId: fromAcc.id, currencyCode: req.currency, outgoing: amount });

  // انتقالِ هم‌ارز واش است؛ نرخ فقط برای مبلغ پایه لازم است. نرخِ حملِ مبدأ
  // را می‌بریم تا بهای تاریخی حفظ شود.
  const rate = req.dayRate
    ? rateFrom(req.dayRate)
    : await positionOrDayRate(tx, fromAcc.id, req.currency, req.date);

  return post(tx, {
    fiscalYearId: req.fiscalYearId,
    date: req.date,
    description: req.description ?? 'انتقال وجه',
    entryType: 'NORMAL',
    sourceType: 'Transfer',
    createdById: req.createdById ?? null,
    attachmentUrls: req.attachmentUrls,
    lines: [
      { accountId: toAcc.id, currencyCode: req.currency, debit: amount, rate, memo: 'انتقال به حساب' },
      { accountId: fromAcc.id, currencyCode: req.currency, credit: amount, rate, memo: 'انتقال از حساب' },
    ],
  });
}

// ═══════════════════════════════════════════════════════════════
// ثبت هزینه / تنخواه
// ═══════════════════════════════════════════════════════════════

export interface ExpenseRequest {
  fiscalYearId: string;
  date: Date;
  /** حساب شرکت/تنخواه که هزینه از آن پرداخت می‌شود */
  fromAccountCode: string;
  /** حساب هزینه؛ پیش‌فرض ۶۲۰۱ */
  expenseAccountCode?: string;
  costCenterId?: string;
  currency: string;
  amount: string;
  dayRate?: string;
  description?: string;
  attachmentUrls?: string[];
  createdById?: string | null;
}

export async function doExpense(tx: Prisma.TransactionClient, req: ExpenseRequest) {
  const fromAcc = await companyLeaf(tx, req.fromAccountCode);
  const expenseAcc = await accountByCodeOr404(tx, req.expenseAccountCode ?? DEFAULT_EXPENSE_CODE);
  if (!expenseAcc.isPostable) throw new AppError(400, `حساب ${expenseAcc.code} سرگروه است`);
  if (fromAcc.currencyMode === 'SINGLE' && fromAcc.currencyCode !== req.currency) {
    throw new AppError(400, `حساب «${fromAcc.name}» فقط ${fromAcc.currencyCode} می‌پذیرد`);
  }
  if (expenseAcc.requiresCostCenter && !req.costCenterId) {
    throw new AppError(400, `حساب «${expenseAcc.name}» مرکز هزینهٔ اجباری دارد`);
  }

  const fd = await decimalsOf(tx, req.currency);
  const amount = parseAmount(req.amount, fd);
  if (amount <= 0n) throw new AppError(400, 'مبلغ باید بزرگ‌تر از صفر باشد');

  await assertFxCover(tx, { accountId: fromAcc.id, currencyCode: req.currency, outgoing: amount });

  const rate = req.dayRate
    ? rateFrom(req.dayRate)
    : await positionOrDayRate(tx, fromAcc.id, req.currency, req.date);

  return post(tx, {
    fiscalYearId: req.fiscalYearId,
    date: req.date,
    description: req.description ? `هزینه: ${req.description}` : 'هزینه',
    entryType: 'NORMAL',
    sourceType: 'Expense',
    createdById: req.createdById ?? null,
    attachmentUrls: req.attachmentUrls,
    lines: [
      {
        accountId: expenseAcc.id,
        costCenterId: req.costCenterId ?? null,
        currencyCode: req.currency, debit: amount, rate,
        memo: req.description ?? 'هزینه',
      },
      { accountId: fromAcc.id, currencyCode: req.currency, credit: amount, rate, memo: 'پرداخت هزینه' },
    ],
  });
}

// ───────────────────────────────────────────────────────────────

/** نرخ مقیاس‌دار → رشتهٔ ده‌دهیِ خوانا (بدون صفرهای انتهایی اضافه) */
function rateToPlain(r: Rate): string {
  const s = r.scaled.toString().padStart(11, '0');
  const int = s.slice(0, -10).replace(/^0+(?=\d)/, '');
  const frac = s.slice(-10).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int;
}
