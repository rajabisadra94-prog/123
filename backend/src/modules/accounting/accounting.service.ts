import { AccountType, Currency, Prisma, PrismaClient } from '@prisma/client';
import prisma from '../../shared/utils/prisma';
import { getRates } from '../../shared/utils/rates';
import {
  ensureChartOfAccounts, normalSideOf, controlLeafCode, walletParentCode, CASH_PARENT_CODE,
} from './chartOfAccounts';

export type OwnerType = 'COMPANY' | 'CUSTOMER' | 'PRODUCER' | 'SUPPLIER' | 'CARRIER' | 'EXCHANGE' | 'COMMISSION_AGENT';
export type ControlKind =
  | 'SALES' | 'PURCHASE' | 'COMMISSION' | 'FREIGHT' | 'FREIGHT_INCOME'
  | 'FEE' | 'OPENING' | 'EXPENSE' | 'VAT_PAYABLE'
  // تسعیر ارز چهار حساب جدا دارد — سود/زیان × محقق/تحقق‌نیافته (spec ۴-۳)
  | 'FX_GAIN_REALIZED' | 'FX_LOSS_REALIZED'
  | 'FX_GAIN_UNREALIZED' | 'FX_LOSS_UNREALIZED';

export interface JournalLineInput {
  accountId: string;
  debit?: number;
  credit?: number;
  currency: Currency;
  rateToIRR: number;
  memo?: string;
}

/** نرخ لحظه‌ای تبدیل یک ارز به تومان */
export async function rateFor(currency: Currency): Promise<number> {
  if (currency === 'IRR') return 1;
  const r = await getRates();
  return currency === 'USD' ? r.USD_TO_IRR : r.CNY_TO_IRR;
}

/**
 * ماهیت حساب: بدهکار (دارایی/هزینه) یا بستانکار (بدهی/سرمایه/درآمد).
 * برای نمایش مانده با علامت طبیعی — «بدهی ۵ میلیون» باید +۵٬۰۰۰٬۰۰۰ دیده شود نه منفی.
 *
 * منبع اصلی `accountType` است. مسیر پشتیبانِ قدیمی فقط برای حساب‌هایی می‌ماند که
 * (به هر دلیل) هنوز طبقه‌بندی نگرفته‌اند؛ بعد از مهاجرت کامل باید بی‌استفاده باشد.
 */
export function normalSide(account: {
  ownerType: string | null;
  controlKind: string | null;
  accountType?: AccountType | null;
}): 'DEBIT' | 'CREDIT' {
  if (account.accountType) return normalSideOf(account.accountType);

  // ── مسیر پشتیبان (حساب طبقه‌بندی‌نشده) ──
  if (account.controlKind?.startsWith('FX_GAIN')) return 'CREDIT';
  if (account.controlKind?.startsWith('FX_LOSS')) return 'DEBIT';
  if (account.controlKind === 'SALES') return 'CREDIT';
  if (account.controlKind === 'FREIGHT_INCOME') return 'CREDIT';
  if (account.controlKind === 'OPENING') return 'CREDIT';
  if (account.controlKind === 'VAT_PAYABLE') return 'CREDIT';
  if (account.controlKind) return 'DEBIT';
  switch (account.ownerType) {
    case 'CUSTOMER': return 'DEBIT';                      // حساب دریافتنی
    case 'PRODUCER':
    case 'SUPPLIER':
    case 'CARRIER':
    case 'EXCHANGE':
    case 'COMMISSION_AGENT': return 'CREDIT';             // حساب پرداختنی
    default: return 'DEBIT';                              // نقد/بانک شرکت
  }
}

/** نام واقعی طرف حساب از جدول مربوطه */
export async function getOwnerName(tx: Prisma.TransactionClient, ownerType: OwnerType, ownerId: string): Promise<string> {
  switch (ownerType) {
    case 'CUSTOMER': return (await tx.customer.findUnique({ where: { id: ownerId }, select: { name: true } }))?.name || 'مشتری';
    case 'PRODUCER': return (await tx.producer.findUnique({ where: { id: ownerId }, select: { name: true } }))?.name || 'سازنده';
    case 'SUPPLIER': return (await tx.supplier.findUnique({ where: { id: ownerId }, select: { name: true } }))?.name || 'تامین‌کننده';
    case 'CARRIER': return (await tx.shippingCompany.findUnique({ where: { id: ownerId }, select: { name: true } }))?.name || 'شرکت حمل';
    case 'EXCHANGE': return (await tx.exchange.findUnique({ where: { id: ownerId }, select: { name: true } }))?.name || 'صرافی';
    case 'COMMISSION_AGENT': return (await tx.commissionAgent.findUnique({ where: { id: ownerId }, select: { name: true } }))?.name || 'کمیسیون‌بگیر';
    default: return 'شرکت';
  }
}

/** کیف پول طرف حساب (یک حساب به ازای هر طرف و هر ارز) — در صورت نبود می‌سازد */
export async function getOrCreateWallet(
  tx: Prisma.TransactionClient,
  ownerType: OwnerType,
  ownerId: string,
  currency: Currency,
  ownerName?: string,
) {
  const field =
    ownerType === 'CUSTOMER' ? 'customerId' :
    ownerType === 'PRODUCER' ? 'producerId' :
    ownerType === 'SUPPLIER' ? 'supplierId' :
    ownerType === 'CARRIER' ? 'shippingCompanyId' :
    ownerType === 'EXCHANGE' ? 'exchangeId' : 'commissionAgentId';

  const existing = await tx.financialAccount.findFirst({
    where: { ownerType, currency, [field]: ownerId } as any,
  });
  if (existing) return existing;

  const name = ownerName || await getOwnerName(tx, ownerType, ownerId);
  // کیف پول = ردیف دفتر معین. زیر گروه ارزیِ خودش در چارت می‌نشیند تا
  // ماندهٔ گروه همیشه برابر جمع فرزندانش باشد (spec بخش ۵).
  const parentCode = walletParentCode(ownerType, currency);
  const parent = parentCode
    ? await tx.financialAccount.findUnique({ where: { code: parentCode }, select: { id: true, accountType: true } })
    : null;

  return tx.financialAccount.create({
    data: {
      name: `${name} - ${currency}`,
      type: 'WALLET',
      currency,
      ownerType,
      ownerId,
      accountType: parent?.accountType ?? (ownerType === 'CUSTOMER' ? 'ASSET' : 'LIABILITY'),
      parentId: parent?.id ?? null,
      [field]: ownerId,
    } as any,
  });
}

/** حساب کنترل شرکت (درآمد/هزینه/سرمایه) به تفکیک ارز */
/**
 * حساب کنترلی شرکت. حالا از چارت خوانده می‌شود (کد ثابت)، نه با جستجوی controlKind.
 * اگر گره چارت هنوز ساخته نشده باشد، یک‌بار کل چارت ساخته می‌شود.
 */
export async function getOrCreateControl(
  tx: Prisma.TransactionClient,
  kind: ControlKind,
  currency: Currency,
) {
  const code = controlLeafCode(kind, currency);
  if (!code) throw new Error(`نوع حساب کنترلی ناشناخته: ${kind}`);

  let acc = await tx.financialAccount.findUnique({ where: { code } });
  if (!acc) {
    await ensureChartOfAccounts(tx);
    acc = await tx.financialAccount.findUnique({ where: { code } });
  }
  if (!acc) throw new Error(`حساب کنترلی ${kind}/${currency} در چارت یافت نشد`);
  return acc;
}

/** سود یا زیان تسعیر — بسته به علامت، حساب درست را برمی‌گرداند (spec ۴-۳) */
export async function getFxAccount(
  tx: Prisma.TransactionClient,
  outcome: 'GAIN' | 'LOSS',
  realized: boolean,
  currency: Currency = 'IRR',
) {
  const kind = `FX_${outcome}_${realized ? 'REALIZED' : 'UNREALIZED'}` as ControlKind;
  return getOrCreateControl(tx, kind, currency);
}

/** صندوق پیش‌فرض دریافت‌ها (وقتی حساب مقصد مشخص نشده) */
export async function getOrCreateDefaultCash(tx: Prisma.TransactionClient, currency: Currency) {
  const existing = await tx.financialAccount.findFirst({
    where: { ownerType: 'COMPANY', type: 'CASH_DEFAULT', currency },
  });
  if (existing) return existing;

  // باید مثل بقیهٔ حساب‌های نقدی طبقه‌بندی و به چارت وصل شود، وگرنه در ترازنامه
  // جا می‌ماند و معادلهٔ حسابداری به اندازهٔ ماندهٔ همین حساب برقرار نمی‌شود.
  const parent = await tx.financialAccount.findUnique({ where: { code: CASH_PARENT_CODE }, select: { id: true } });
  return tx.financialAccount.create({
    data: {
      name: `صندوق دریافت‌های اولیه - ${currency}`,
      type: 'CASH_DEFAULT', currency, ownerType: 'COMPANY',
      accountType: 'ASSET', parentId: parent?.id ?? null, isPostable: true,
    },
  });
}

/**
 * نرخ «بهای تمام‌شدهٔ» ماندهٔ باز یک کیف پول ارزی — میانگین موزون متحرک.
 * مشتری (ماهیت بدهکار): تعهد با بدهکار باز می‌شود و با بستانکار بسته؛ بقیه برعکس.
 * برخلاف میانگینِ سادهٔ کل تاریخچه، اینجا هر کاهش، سهم خودش را از بهای انباشته
 * برمی‌دارد — پس نرخ همیشه مربوط به همان مانده‌ای است که هنوز باز مانده.
 * اگر مانده صفر (یا بی‌سابقه) باشد، نرخ زنده برمی‌گردد.
 */
export async function walletAvgBookedRate(
  tx: Prisma.TransactionClient,
  accountId: string,
  side: 'DEBIT' | 'CREDIT',
  currency: Currency,
): Promise<number> {
  const lines = await tx.journalLine.findMany({
    where: { accountId },
    select: { debit: true, credit: true, rateToIRR: true },
    orderBy: [{ entry: { date: 'asc' } }, { entry: { entryNo: 'asc' } }],
  });
  let qty = 0, cost = 0;
  for (const l of lines) {
    const inc = side === 'DEBIT' ? Number(l.debit) : Number(l.credit);   // افزایش مانده
    const dec = side === 'DEBIT' ? Number(l.credit) : Number(l.debit);   // کاهش مانده
    if (inc > 0) { qty += inc; cost += inc * Number(l.rateToIRR); }
    if (dec > 0) {
      const avg = qty > 0 ? cost / qty : 0;
      const used = Math.min(dec, qty);
      qty -= used; cost -= used * avg;
      if (qty <= 1e-9) { qty = 0; cost = 0; } // مانده بسته شد → سابقهٔ نرخ هم پاک
    }
  }
  if (qty > 0 && cost > 0) return cost / qty;
  return rateFor(currency);
}

/** نرخ حملِ (بهای تمام‌شدهٔ) یک حساب — تومان همیشه ۱ */
export async function carryingRate(
  tx: Prisma.TransactionClient,
  account: { id: string; currency: Currency; ownerType: string | null; controlKind: string | null },
): Promise<number> {
  if (account.currency === 'IRR') return 1;
  return walletAvgBookedRate(tx, account.id, normalSide(account), account.currency);
}

/** هر طرف حساب به‌محض تعریف، هر سه کیف (تومان/دلار/یوآن) را می‌گیرد */
export async function provisionWallets(
  tx: Prisma.TransactionClient,
  ownerType: OwnerType,
  ownerId: string,
  ownerName?: string,
) {
  for (const cur of ['IRR', 'USD', 'CNY'] as Currency[]) {
    await getOrCreateWallet(tx, ownerType, ownerId, cur, ownerName);
  }
}

/**
 * تبدیل ارز (عملیات ارزی) — بین دو حسابِ یک طرف (شرکت↔شرکت یا دو کیف یک شخص).
 *
 * اصل: تعویض دارایی به‌خودی‌خود سود و زیان نمی‌سازد.
 *  - سمتِ خروجی به «بهای تمام‌شدهٔ» خودش از دفتر خارج می‌شود (نرخ حمل).
 *  - سمتِ ورودی دقیقاً به همان بهایی می‌نشیند که بابتش پرداخت شده (نرخ = ارزش ریالی خروجی ÷ مبلغ ورودی).
 *  - تومان نرخش قطعی ۱ است و نمی‌تواند جذب کند؛ پس وقتی سمت ورودی تومان باشد،
 *    مابه‌التفاوت همان سود/زیان تسعیرِ «محقق‌شده» است و به FX_DIFF می‌رود.
 *
 * نتیجه: خرید ارز هیچ سود/زیانی ثبت نمی‌کند (فقط بهای تمام‌شده جابه‌جا می‌شود)،
 * ولی فروش ارز بالاتر/پایین‌تر از بهای تمام‌شده، سود/زیان واقعی ثبت می‌کند.
 */
export async function postConversion(
  tx: Prisma.TransactionClient,
  params: {
    fromAccountId: string;
    toAccountId: string;
    fromAmount: number;
    toAmount: number;
    description?: string;
    projectId?: string;
    createdById?: string;
    attachmentUrls?: string[];
    date?: Date;
  },
) {
  const { fromAccountId, toAccountId, fromAmount, toAmount } = params;
  const fromAcc = await tx.financialAccount.findUnique({ where: { id: fromAccountId } });
  const toAcc = await tx.financialAccount.findUnique({ where: { id: toAccountId } });
  if (!fromAcc || !toAcc) throw new Error('حساب یافت نشد');
  if (fromAcc.currency === toAcc.currency) throw new Error('واحد پولی مبدأ و مقصد باید متفاوت باشد');

  const fromRate = await carryingRate(tx, fromAcc);
  const fromIRR = fromAmount * fromRate;
  // سمت ورودی: تومان نرخ ثابت ۱ دارد، ارز به بهای واقعیِ پرداخت‌شده می‌نشیند
  const toRate = toAcc.currency === 'IRR' ? 1 : fromIRR / toAmount;
  const toIRR = toAmount * toRate;

  const lines: JournalLineInput[] = [
    { accountId: toAcc.id, debit: toAmount, currency: toAcc.currency, rateToIRR: toRate, memo: 'دریافت در تبدیل ارز' },
    { accountId: fromAcc.id, credit: fromAmount, currency: fromAcc.currency, rateToIRR: fromRate, memo: 'پرداخت در تبدیل ارز' },
  ];

  const fxIRR = toIRR - fromIRR; // فقط وقتی سمت ورودی تومان است غیرصفر می‌شود
  if (Math.abs(fxIRR) > 1) {
    // سود و زیان در دو حساب جدا می‌نشینند تا در صورت سود و زیان خالص‌نشده دیده شوند
    const fxAcc = await getFxAccount(tx, fxIRR > 0 ? 'GAIN' : 'LOSS', true);
    if (fxIRR > 0) lines.push({ accountId: fxAcc.id, credit: fxIRR, currency: 'IRR', rateToIRR: 1, memo: 'سود تسعیر محقق‌شده' });
    else lines.push({ accountId: fxAcc.id, debit: -fxIRR, currency: 'IRR', rateToIRR: 1, memo: 'زیان تسعیر محقق‌شده' });
  }

  return postJournal(tx, {
    description: params.description,
    eventType: 'CONVERSION',
    sourceType: 'Manual',
    projectId: params.projectId,
    createdById: params.createdById,
    attachmentUrls: params.attachmentUrls,
    date: params.date,
    lines,
  });
}

/**
 * تسویهٔ استاندارد چند‌ارزی با طرف حساب (دریافت از مشتری / پرداخت به فروشنده‌ها).
 * اصول:
 *  - تعهد در «ارز خودش» بسته می‌شود (کیف همان ارز)، با نرخِ میانگین ثبت تعهد (روش temporal).
 *  - وجه نقد در ارز حساب شرکت و به ارزش روز ثبت می‌شود.
 *  - اختلاف ریالی دو سمت = سود/زیان تسعیر «محقق‌شده» → FX_DIFF.
 * نتیجه: فاکتور دلاری که تومانی تسویه شود، کیف دلاری مشتری واقعاً صفر می‌شود و تسعیر سند می‌خورد.
 */
export async function postSettlement(
  tx: Prisma.TransactionClient,
  params: {
    direction: 'RECEIPT' | 'PAYMENT';        // دریافت از طرف حساب یا پرداخت به او
    ownerType: OwnerType;
    ownerId: string;
    ownerName?: string;
    obligationCurrency: Currency;             // ارز تعهدی که تسویه می‌شود
    settledAmount: number;                    // مبلغ تسویه به ارز تعهد
    companyAccountId: string;                 // حساب بانک/صندوق/تنخواه شرکت
    cashAmount: number;                       // مبلغ واقعی رد‌و‌بدل‌شده به ارز حساب شرکت
    description?: string;
    eventType?: string;
    sourceType?: string;
    sourceId?: string;
    projectId?: string;
    createdById?: string;
    attachmentUrls?: string[];
    date?: Date;
  },
) {
  const { direction, ownerType, ownerId, obligationCurrency, settledAmount, companyAccountId, cashAmount } = params;
  if (!(settledAmount > 0)) throw new Error('مبلغ تسویه باید بزرگ‌تر از صفر باشد');
  if (!(cashAmount > 0)) throw new Error('مبلغ نقدی باید بزرگ‌تر از صفر باشد');
  if (ownerType === 'COMPANY') throw new Error('تسویه فقط با طرف حساب خارجی معنا دارد');

  const companyAcc = await tx.financialAccount.findUnique({ where: { id: companyAccountId } });
  if (!companyAcc) throw new Error('حساب شرکت یافت نشد');
  if (companyAcc.ownerType !== 'COMPANY' || companyAcc.controlKind) throw new Error('حساب نقدی باید حساب بانک/صندوق شرکت باشد');

  const wallet = await getOrCreateWallet(tx, ownerType, ownerId, obligationCurrency, params.ownerName);
  const walletSide = normalSide(wallet); // مشتری DEBIT، بقیه CREDIT

  // نرخ‌ها: تعهد با نرخ میانگینِ ثبت (تا کیف به همان ارزشی بسته شود که باز شده)؛ نقد با نرخ روز
  const bookedRate = await walletAvgBookedRate(tx, wallet.id, walletSide, obligationCurrency);
  const cashRate = await rateFor(companyAcc.currency);

  const obligationIRR = settledAmount * bookedRate;
  const cashIRR = cashAmount * cashRate;

  const lines: JournalLineInput[] = [];
  let fxIRR = 0; // مثبت = سود تسعیر
  if (direction === 'RECEIPT') {
    // دریافت: بدهکار بانک شرکت / بستانکار کیف مشتری (بستن طلب به ارز خودش)
    lines.push({ accountId: companyAcc.id, debit: cashAmount, currency: companyAcc.currency, rateToIRR: cashRate, memo: 'دریافت وجه' });
    lines.push({ accountId: wallet.id, credit: settledAmount, currency: obligationCurrency, rateToIRR: bookedRate, memo: 'تسویه طلب' });
    fxIRR = cashIRR - obligationIRR; // بیشتر گرفتیم از آنچه دفتری بود → سود
  } else {
    // پرداخت: بدهکار کیف فروشنده (بستن بدهی به ارز خودش) / بستانکار بانک شرکت
    lines.push({ accountId: wallet.id, debit: settledAmount, currency: obligationCurrency, rateToIRR: bookedRate, memo: 'تسویه بدهی' });
    lines.push({ accountId: companyAcc.id, credit: cashAmount, currency: companyAcc.currency, rateToIRR: cashRate, memo: 'پرداخت وجه' });
    fxIRR = obligationIRR - cashIRR; // کمتر پرداختیم از بدهی دفتری → سود
  }

  if (Math.abs(fxIRR) > 1) {
    const fxAcc = await getFxAccount(tx, fxIRR > 0 ? 'GAIN' : 'LOSS', true);
    if (fxIRR > 0) lines.push({ accountId: fxAcc.id, credit: fxIRR, currency: 'IRR', rateToIRR: 1, memo: 'سود تسعیر محقق‌شده' });
    else lines.push({ accountId: fxAcc.id, debit: -fxIRR, currency: 'IRR', rateToIRR: 1, memo: 'زیان تسعیر محقق‌شده' });
  }

  return postJournal(tx, {
    description: params.description ||
      (direction === 'RECEIPT' ? 'دریافت از طرف حساب (تسویه)' : 'پرداخت به طرف حساب (تسویه)'),
    eventType: params.eventType || 'SETTLEMENT',
    sourceType: params.sourceType || 'Manual',
    sourceId: params.sourceId,
    projectId: params.projectId,
    createdById: params.createdById,
    attachmentUrls: params.attachmentUrls,
    date: params.date,
    lines,
  });
}

/** دقت تراز به ارز عملیاتی: مبالغ ریالی تا ۲ رقم اعشار معنا دارند (spec ۲-۲) */
export const LEDGER_PRECISION = 2;

const roundTo = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round((v + Number.EPSILON) * f) / f;
};

/**
 * قانون تراز: جمع بدهکار و بستانکار به ارز عملیاتی باید **دقیقاً** برابر باشند.
 *
 * روش: اختلاف را به دقت دفتر گرد کن و صفرِ دقیق بخواه — نه تلورانس نسبی.
 * تلورانس نسبی (روش قبلی) برای سند ۱۰ میلیاردی ۱۰ هزار تومان اجازه می‌داد و
 * خطا در طول هزاران سند انباشته می‌شد. گرد کردن خطای شناور را می‌بلعد ولی
 * اجازهٔ انباشت نمی‌دهد.
 */
/**
 * سرشکن یک مبلغ بین چند سهم، طوری که **جمع سهم‌ها دقیقاً برابر کل** شود.
 *
 * گرد کردن سادهٔ هر سهم، پول گم می‌کند: ۱۰۰۰ تومان بین ۳ نفر ⇒ ۳۳۳+۳۳۳+۳۳۳ = ۹۹۹.
 * اینجا از روش «بزرگ‌ترین باقی‌مانده» استفاده می‌شود: همه رو به پایین گرد می‌شوند و
 * واحدهای باقی‌مانده یکی‌یکی به سهم‌هایی می‌روند که بیشترین کسر را داشته‌اند.
 *
 * @param total   مبلغ کل
 * @param weights وزن هر سهم (لازم نیست جمعشان ۱ باشد)
 * @param decimals تعداد رقم اعشار مجاز (تومان ۰، ارز ۲)
 */
export function allocate(total: number, weights: number[], decimals = 0): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const step = 10 ** -decimals;
  const sumW = weights.reduce((s, w) => s + w, 0);
  if (!(sumW > 0)) return new Array(n).fill(0);

  const exact = weights.map((w) => (total * w) / sumW);
  const floored = exact.map((v) => Math.floor(v / step) * step);
  const used = floored.reduce((s, v) => s + v, 0);
  // تعداد واحدهایی که به‌خاطر گرد کردن به پایین جا مانده‌اند
  let remaining = Math.round((total - used) / step);

  const order = exact
    .map((v, i) => ({ i, frac: (v - floored[i]) / step }))
    .sort((a, b) => b.frac - a.frac);

  // در واحدِ گام کار می‌کنیم (عدد صحیح) تا نویز شناور وارد مبالغ نشود
  const units = floored.map((v) => Math.round(v / step));
  for (let k = 0; k < order.length && remaining > 0; k++, remaining--) {
    units[order[k].i] += 1;
  }
  // اگر هنوز چیزی مانده (وزن‌های خیلی نامتوازن)، به بزرگ‌ترین سهم اضافه شود
  if (remaining !== 0 && order.length) units[order[0].i] += remaining;

  return units.map((u) => Number((u * step).toFixed(decimals)));
}

/**
 * سرگروه‌های چارت فقط تجمیع می‌کنند و نباید مستقیم سند بگیرند.
 * جلوگیری اینجا انجام می‌شود چون سند از مسیرهای مختلفی ساخته می‌شود.
 */
export async function assertPostable(tx: Prisma.TransactionClient, accountIds: string[]): Promise<void> {
  const bad = await tx.financialAccount.findMany({
    where: { id: { in: [...new Set(accountIds)] }, isPostable: false },
    select: { name: true, code: true },
  });
  if (bad.length) {
    const list = bad.map((a) => `${a.code ? a.code + ' ' : ''}${a.name}`).join('، ');
    throw new Error(`این حساب‌ها سرگروه‌اند و سند نمی‌گیرند: ${list}`);
  }
}

export function assertBalanced(lines: JournalLineInput[]): void {
  const debitIRR = lines.reduce((s, l) => s + (l.debit || 0) * l.rateToIRR, 0);
  const creditIRR = lines.reduce((s, l) => s + (l.credit || 0) * l.rateToIRR, 0);
  const diff = roundTo(debitIRR - creditIRR, LEDGER_PRECISION);
  if (diff !== 0) {
    throw new Error(
      `سند تراز نیست: بدهکار=${roundTo(debitIRR, LEDGER_PRECISION)} بستانکار=${roundTo(creditIRR, LEDGER_PRECISION)} ` +
      `(اختلاف ${diff} تومان)`,
    );
  }
}

/**
 * ثبت سند دوطرفه تراز.
 * مانده هر حساب به اندازه (بدهکار − بستانکار) به ارز خودش به‌روز می‌شود.
 */
/** نام تریگر توازن — prisma/manual/2026-08-16-journal-balance-trigger.sql */
const BALANCE_TRIGGER = 'journal_must_balance';

/**
 * آیا تریگر توازن روی این دیتابیس نصب است؟ یک بار در عمر پروسه سنجیده می‌شود.
 * `null` یعنی هنوز سنجیده نشده.
 */
let balanceTriggerInstalled: boolean | null = null;

/**
 * تریگر توازن را همین‌جا داخل تراکنش شلیک می‌کند و دوباره معوقش می‌کند.
 *
 * چرا لازم است: تریگر `DEFERRABLE INITIALLY DEFERRED` در لحظهٔ COMMIT اجرا می‌شود،
 * و **Prisma خطای COMMIT را بی‌صدا می‌بلعد** — تراکنش برمی‌گردد ولی `$transaction`
 * با موفقیت و با شیء سند برمی‌گردد. یعنی برنامه فکر می‌کند سند ثبت شده در حالی که
 * دفتر خالی است. با IMMEDIATE کردن، خطا داخل تراکنش رخ می‌دهد و درست منتشر می‌شود.
 *
 * چرا بلافاصله DEFERRED می‌شود: حالت IMMEDIATE تا پایان تراکنش می‌ماند. اگر برنگردد،
 * سند **دومِ** همان تراکنش (مثل تجدید ارزیابی که سند تعدیل و سند برگشت را با هم
 * می‌زند) بعد از اولین ردیفش ناتراز دیده می‌شود و می‌شکند. آزموده شده.
 *
 * چرا با نام و نه `ALL`: دامنه‌اش محدود به همین تریگر می‌ماند و کلیدهای خارجی
 * معوقِ دیگر دست نمی‌خورند.
 */
async function flushBalanceCheck(tx: Prisma.TransactionClient): Promise<void> {
  if (balanceTriggerInstalled === null) {
    const rows = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM pg_trigger WHERE tgname = ${BALANCE_TRIGGER}
    `;
    balanceTriggerInstalled = Number(rows[0]?.n ?? 0) > 0;
    if (!balanceTriggerInstalled) {
      console.warn(
        `[حسابداری] تریگر «${BALANCE_TRIGGER}» روی این دیتابیس نصب نیست. ` +
        'قاعدهٔ توازن فقط در لایهٔ برنامه اعمال می‌شود. ' +
        'اجرا کنید: psql "$DATABASE_URL" -f prisma/manual/2026-08-16-journal-balance-trigger.sql',
      );
    }
  }
  if (!balanceTriggerInstalled) return;

  await tx.$executeRawUnsafe(`SET CONSTRAINTS "${BALANCE_TRIGGER}" IMMEDIATE`);
  await tx.$executeRawUnsafe(`SET CONSTRAINTS "${BALANCE_TRIGGER}" DEFERRED`);
}

export async function postJournal(
  tx: Prisma.TransactionClient,
  params: {
    description?: string;
    eventType?: string;
    sourceType?: string;
    sourceId?: string;
    projectId?: string;
    createdById?: string;
    attachmentUrls?: string[];
    date?: Date;
    lines: JournalLineInput[];
  },
) {
  const lines = params.lines.filter((l) => (l.debit || 0) !== 0 || (l.credit || 0) !== 0);
  if (lines.length < 2) throw new Error('سند حسابداری حداقل به دو ردیف غیرصفر نیاز دارد');
  for (const l of lines) {
    if ((l.debit || 0) < 0 || (l.credit || 0) < 0) throw new Error('مبلغ بدهکار/بستانکار نمی‌تواند منفی باشد');
    if ((l.debit || 0) > 0 && (l.credit || 0) > 0) throw new Error('یک ردیف نمی‌تواند همزمان بدهکار و بستانکار باشد');
  }

  assertBalanced(lines);
  await assertPostable(tx, lines.map((l) => l.accountId));

  const entry = await tx.journalEntry.create({
    data: {
      date: params.date || new Date(),
      description: params.description,
      eventType: params.eventType,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      projectId: params.projectId,
      createdById: params.createdById,
      attachmentUrls: params.attachmentUrls || [],
      lines: {
        create: lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit || 0,
          credit: l.credit || 0,
          currency: l.currency,
          rateToIRR: l.rateToIRR,
          memo: l.memo,
        })),
      },
    },
    include: { lines: true },
  });

  // همهٔ ردیف‌ها درج شده‌اند؛ حالا تریگر توازن را وادار به قضاوت می‌کنیم
  // تا خطای احتمالی داخل همین تراکنش منتشر شود، نه در COMMIT که بلعیده می‌شود.
  await flushBalanceCheck(tx);

  for (const l of lines) {
    const delta = (l.debit || 0) - (l.credit || 0);
    if (delta !== 0) {
      await tx.financialAccount.update({
        where: { id: l.accountId },
        data: { balance: { increment: delta } },
      });
    }
  }

  return entry;
}

// ═══════════════════════════════════════════════════════════════
// اصلاح سند: قفل دوره، سند برگشتی، و بازگردانی اثر مانده‌ها
// اصل حسابداری: سند تا وقتی دوره باز است مستقیم اصلاح می‌شود (با ثبت
// تاریخچه)، اما بعد از بستن دوره فقط با «سند برگشتی» خنثی می‌شود.
// ═══════════════════════════════════════════════════════════════

/** تبدیل تاریخ میلادی به سال/ماه شمسی — برای تطبیق با دوره‌های مالی */
export function toJalaliYM(d: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', {
    year: 'numeric', month: 'numeric', timeZone: 'Asia/Tehran',
  }).formatToParts(d);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  return { year, month };
}

/** اگر دورهٔ مالیِ آن تاریخ بسته باشد خطا می‌دهد (ماهِ مشخص یا کل سال) */
export async function assertPeriodOpen(tx: Prisma.TransactionClient, date: Date) {
  const { year, month } = toJalaliYM(date);
  const locks = await tx.fiscalPeriod.findMany({
    where: { year, OR: [{ month }, { month: null }], closedAt: { not: null } },
  });
  if (locks.length) {
    throw new Error(`دورهٔ مالی ${year}/${String(month).padStart(2, '0')} بسته است — برای اصلاح از «سند برگشتی» استفاده کنید`);
  }
}

/** آیا این سند قابل ویرایش مستقیم است؟ (دوره باز باشد و خودش باطل/برگشتی نباشد) */
export async function canEditEntry(
  tx: Prisma.TransactionClient,
  entry: { date: Date; status: string; eventType: string | null },
): Promise<{ ok: boolean; reason?: string }> {
  if (entry.status === 'REVERSED') return { ok: false, reason: 'این سند قبلاً باطل شده است' };
  if (entry.status === 'REVERSAL') return { ok: false, reason: 'سند برگشتی قابل ویرایش نیست' };
  try { await assertPeriodOpen(tx, entry.date); } catch (e: any) { return { ok: false, reason: e.message }; }
  return { ok: true };
}

/** اثر ردیف‌های یک سند را از مانده حساب‌ها برمی‌دارد (بدون حذف خود سند) */
async function unapplyLines(
  tx: Prisma.TransactionClient,
  lines: { accountId: string; debit: Prisma.Decimal | number; credit: Prisma.Decimal | number }[],
) {
  for (const l of lines) {
    const delta = Number(l.debit) - Number(l.credit);
    if (delta !== 0) {
      await tx.financialAccount.update({ where: { id: l.accountId }, data: { balance: { decrement: delta } } });
    }
  }
}

/**
 * سند برگشتی: یک سند جدید با بدهکار/بستانکارِ معکوس می‌سازد و سند اصلی را REVERSED علامت می‌زند.
 * سند اصلی دست‌نخورده می‌ماند — این همان چیزی است که حسابرسی می‌خواهد.
 */
export async function reverseJournal(
  tx: Prisma.TransactionClient,
  entryId: string,
  opts: { reason?: string; createdById?: string; date?: Date } = {},
) {
  const src = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
  if (!src) throw new Error('سند یافت نشد');
  if (src.status === 'REVERSED') throw new Error('این سند قبلاً باطل شده است');
  if (src.status === 'REVERSAL') throw new Error('سند برگشتی را نمی‌توان دوباره برگرداند');

  const reversal = await tx.journalEntry.create({
    data: {
      date: opts.date || new Date(),
      description: `ابطال سند #${src.entryNo}${opts.reason ? ` — ${opts.reason}` : ''}`,
      eventType: 'REVERSAL',
      sourceType: src.sourceType,
      sourceId: src.sourceId,
      projectId: src.projectId,
      categoryId: src.categoryId,
      createdById: opts.createdById,
      status: 'REVERSAL',
      reversesId: src.id,
      attachmentUrls: [],
      lines: {
        create: src.lines.map((l) => ({
          accountId: l.accountId,
          debit: Number(l.credit),     // جای بدهکار و بستانکار عوض می‌شود
          credit: Number(l.debit),
          currency: l.currency,
          rateToIRR: Number(l.rateToIRR),
          memo: l.memo,
        })),
      },
    },
    include: { lines: true },
  });

  // اثر معکوس روی مانده‌ها
  for (const l of src.lines) {
    const delta = Number(l.credit) - Number(l.debit);
    if (delta !== 0) {
      await tx.financialAccount.update({ where: { id: l.accountId }, data: { balance: { increment: delta } } });
    }
  }

  await tx.journalEntry.update({
    where: { id: src.id },
    data: { status: 'REVERSED', reversedAt: new Date(), reversalReason: opts.reason || null },
  });

  return reversal;
}

/**
 * ویرایش مستقیم سند (فقط وقتی دوره باز است).
 * وضعیت قبلی در JournalEntryRevision عکس‌برداری می‌شود، اثر ردیف‌های قدیم برداشته
 * و ردیف‌های جدید اعمال می‌شود. ردپای تغییر از بین نمی‌رود.
 */
export async function editJournal(
  tx: Prisma.TransactionClient,
  entryId: string,
  patch: {
    date?: Date;
    description?: string;
    projectId?: string | null;
    categoryId?: string | null;
    lines?: JournalLineInput[];
    reason?: string;
    editedById?: string;
  },
) {
  const src = await tx.journalEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
  if (!src) throw new Error('سند یافت نشد');

  const gate = await canEditEntry(tx, src);
  if (!gate.ok) throw new Error(gate.reason);
  // تاریخ جدید هم نباید داخل دورهٔ بسته بیفتد
  if (patch.date) await assertPeriodOpen(tx, patch.date);

  await tx.journalEntryRevision.create({
    data: {
      entryId: src.id,
      reason: patch.reason,
      editedById: patch.editedById,
      snapshot: {
        date: src.date.toISOString(),
        description: src.description,
        projectId: src.projectId,
        categoryId: src.categoryId,
        lines: src.lines.map((l) => ({
          accountId: l.accountId, debit: Number(l.debit), credit: Number(l.credit),
          currency: l.currency, rateToIRR: Number(l.rateToIRR), memo: l.memo,
        })),
      } as Prisma.InputJsonValue,
    },
  });

  if (patch.lines) {
    const lines = patch.lines.filter((l) => (l.debit || 0) !== 0 || (l.credit || 0) !== 0);
    if (lines.length < 2) throw new Error('سند حسابداری حداقل به دو ردیف غیرصفر نیاز دارد');
    assertBalanced(lines);

    await unapplyLines(tx, src.lines);
    await tx.journalLine.deleteMany({ where: { entryId: src.id } });
    await tx.journalLine.createMany({
      data: lines.map((l) => ({
        entryId: src.id,
        accountId: l.accountId,
        debit: l.debit || 0,
        credit: l.credit || 0,
        currency: l.currency,
        rateToIRR: l.rateToIRR,
        memo: l.memo,
      })),
    });

    // ردیف‌های تازه جایگزین شده‌اند؛ تریگر باید همین‌جا قضاوت کند نه در COMMIT
    await flushBalanceCheck(tx);

    for (const l of lines) {
      const delta = (l.debit || 0) - (l.credit || 0);
      if (delta !== 0) {
        await tx.financialAccount.update({ where: { id: l.accountId }, data: { balance: { increment: delta } } });
      }
    }
  }

  return tx.journalEntry.update({
    where: { id: src.id },
    data: {
      date: patch.date ?? undefined,
      description: patch.description ?? undefined,
      projectId: patch.projectId === undefined ? undefined : patch.projectId,
      categoryId: patch.categoryId === undefined ? undefined : patch.categoryId,
    },
    include: { lines: true },
  });
}

/**
 * ثبت تعهدات مالی فاکتور تأییدشده (طلب از مشتری، بدهی سازندگان، کمیسیون، پیش‌پرداخت).
 * Idempotent: اگر قبلاً سند خورده باشد دوباره نمی‌سازد.
 * advanceAccountId: حساب شرکت که پیش‌پرداخت به آن واریز شده (در صورت عدم تعیین → صندوق پیش‌فرض).
 */
export async function postInvoiceObligations(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  createdById?: string,
  advanceAccountId?: string,
): Promise<boolean> {
  const existing = await tx.journalEntry.findFirst({
    where: { sourceType: 'Invoice', sourceId: invoiceId, eventType: 'INVOICE_CONFIRMED' },
  });
  if (existing) return false;

  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      project: { include: { customer: { select: { id: true, name: true } }, commissions: { include: { agent: true } } } },
      items: { include: { part: { include: { selectedPrice: true } } } },
    },
  });
  if (!invoice) throw new Error('فاکتور یافت نشد');

  const invCur = invoice.totalCurrency as Currency;
  // نرخ ذخیره‌شده روی فاکتور (لحظه صدور) — برای بازسازی تاریخی صحیح؛ در نبودش نرخ زنده
  const invRate = Number(invoice.totalRateToIRR) > 0 ? Number(invoice.totalRateToIRR) : await rateFor(invCur);
  // تاریخ سند = تاریخ تأیید فاکتور، نه لحظهٔ اجرا. بدون این، هر بار بازسازی دفاتر
  // تاریخ همهٔ اسناد فاکتور را به «امروز» می‌برد و سن‌بندی مطالبات، صورت سود و
  // زیان دوره‌ای و ترازنامهٔ تاریخ‌دار همگی غلط می‌شوند.
  const invDate = invoice.confirmedAt ?? invoice.createdAt;
  const customerId = invoice.project.customerId;
  const customerName = invoice.project.customer.name;

  // ۱) طلب از مشتری: بدهکار مشتری (کل فاکتور) / بستانکار درآمد فروش (خالص) + مالیات پرداختنی (VAT)
  // اصل حسابداری: مالیات ارزش افزوده درآمد نیست — بدهی به دولت است.
  const custWallet = await getOrCreateWallet(tx, 'CUSTOMER', customerId, invCur, customerName);
  const salesCtrl = await getOrCreateControl(tx, 'SALES', invCur);
  const total = Number(invoice.totalAmount);
  const vat = invoice.hasVat ? Math.min(Number(invoice.vatAmount) || 0, total) : 0;
  const netSales = total - vat;
  const invoiceLines: JournalLineInput[] = [
    { accountId: custWallet.id, debit: total, currency: invCur, rateToIRR: invRate },
    { accountId: salesCtrl.id, credit: netSales, currency: invCur, rateToIRR: invRate, memo: 'درآمد فروش (خالص)' },
  ];
  if (vat > 0) {
    const vatCtrl = await getOrCreateControl(tx, 'VAT_PAYABLE', invCur);
    invoiceLines.push({ accountId: vatCtrl.id, credit: vat, currency: invCur, rateToIRR: invRate, memo: 'مالیات بر ارزش افزوده' });
  }
  await postJournal(tx, {
    description: `طلب از مشتری بابت فاکتور ${invoice.versionCode}`,
    eventType: 'INVOICE_CONFIRMED', sourceType: 'Invoice', sourceId: invoice.id, projectId: invoice.projectId, createdById, date: invDate,
    lines: invoiceLines,
  });

  // ۲) بدهی به سازندگان (گروه‌بندی بر اساس سازنده و ارز)
  // نرخ هر قلم از costRateToIRR ذخیره‌شده روی فاکتور → میانگین موزون هر گروه
  const producerCost: Record<string, { producerId: string; currency: Currency; amount: number; amountIRR: number }> = {};
  for (const item of invoice.items) {
    const sp = item.part.selectedPrice;
    if (!sp) continue;
    if (!sp.producerId) continue; // بدهی سازنده فقط برای مسیر ساخت؛ خرید کالا (تامین‌کننده) در فاز بعدی
    const cur = (item.costCurrency || sp.currency) as Currency;
    const qty = item.part.quantity || 1; // قیمت تمام‌شده «واحد» است → در تعداد ضرب می‌شود
    const unit = Number(item.costAmount) > 0 ? Number(item.costAmount) : Number(sp.amount);
    const amt = unit * qty;
    const r = Number(item.costRateToIRR) > 0 ? Number(item.costRateToIRR) : await rateFor(cur);
    const key = `${sp.producerId}_${cur}`;
    if (!producerCost[key]) producerCost[key] = { producerId: sp.producerId, currency: cur, amount: 0, amountIRR: 0 };
    producerCost[key].amount += amt;
    producerCost[key].amountIRR += amt * r;
  }
  for (const pc of Object.values(producerCost)) {
    if (pc.amount <= 0) continue;
    const prod = await tx.producer.findUnique({ where: { id: pc.producerId }, select: { name: true } });
    const prodWallet = await getOrCreateWallet(tx, 'PRODUCER', pc.producerId, pc.currency, prod?.name);
    const purchaseCtrl = await getOrCreateControl(tx, 'PURCHASE', pc.currency);
    const r = pc.amountIRR / pc.amount;
    await postJournal(tx, {
      description: `بدهی به سازنده ${prod?.name || ''} بابت فاکتور ${invoice.versionCode}`,
      eventType: 'INVOICE_CONFIRMED', sourceType: 'Invoice', sourceId: invoice.id, projectId: invoice.projectId, createdById, date: invDate,
      lines: [
        { accountId: purchaseCtrl.id, debit: pc.amount, currency: pc.currency, rateToIRR: r },
        { accountId: prodWallet.id, credit: pc.amount, currency: pc.currency, rateToIRR: r },
      ],
    });
  }

  // ۳) بدهی کمیسیون‌بگیرها
  for (const c of invoice.project.commissions) {
    const amt = (Number(c.percentage) / 100) * Number(invoice.totalAmount);
    if (amt <= 0) continue;
    const agentWallet = await getOrCreateWallet(tx, 'COMMISSION_AGENT', c.agentId, invCur, c.agent?.name);
    const commCtrl = await getOrCreateControl(tx, 'COMMISSION', invCur);
    await postJournal(tx, {
      description: `کمیسیون ${c.agent?.name || ''} (${Number(c.percentage)}٪) فاکتور ${invoice.versionCode}`,
      eventType: 'INVOICE_CONFIRMED', sourceType: 'Invoice', sourceId: invoice.id, projectId: invoice.projectId, createdById, date: invDate,
      lines: [
        { accountId: commCtrl.id, debit: amt, currency: invCur, rateToIRR: invRate },
        { accountId: agentWallet.id, credit: amt, currency: invCur, rateToIRR: invRate },
      ],
    });
  }

  // ۴) پیش‌پرداخت (در صورت ثبت روی فاکتور): بدهکار بانک/صندوق ← بستانکار مشتری
  if (invoice.advanceAmount && Number(invoice.advanceAmount) > 0) {
    const advCur = (invoice.advanceCurrency || invCur) as Currency;
    const advRate = Number((invoice as any).advanceRateToIRR) > 0 ? Number((invoice as any).advanceRateToIRR) : await rateFor(advCur);
    let cashId: string;
    if (advanceAccountId) {
      const acc = await tx.financialAccount.findUnique({ where: { id: advanceAccountId } });
      if (!acc) throw new Error('حساب واریز پیش‌پرداخت یافت نشد');
      if (acc.currency !== advCur) throw new Error('ارز حساب واریز با ارز پیش‌پرداخت یکسان نیست');
      cashId = acc.id;
    } else {
      cashId = (await getOrCreateDefaultCash(tx, advCur)).id;
    }
    const custWalletAdv = await getOrCreateWallet(tx, 'CUSTOMER', customerId, advCur, customerName);
    await postJournal(tx, {
      description: `پیش‌پرداخت مشتری بابت فاکتور ${invoice.versionCode}`,
      eventType: 'ADVANCE_RECEIVED', sourceType: 'Invoice', sourceId: invoice.id, projectId: invoice.projectId, createdById, date: invDate,
      lines: [
        { accountId: cashId, debit: Number(invoice.advanceAmount), currency: advCur, rateToIRR: advRate },
        { accountId: custWalletAdv.id, credit: Number(invoice.advanceAmount), currency: advCur, rateToIRR: advRate },
      ],
    });
  }

  return true;
}

/**
 * بازسازی دفاتر (فقط مدیر کل) — «غیرمخرب»:
 * فقط اسناد «مشتق» (که از روی مدارک منبع قابل بازتولیدند: فاکتور فروش، پیش‌پرداخت، فاکتور حمل، درآمد فورواردینگ)
 * پاک و از نو ساخته می‌شوند. اسناد دستی و تسویه‌ها (دریافت/پرداخت، انتقال، تبدیل ارز، هزینه، بدهی/پرداخت خرید،
 * افتتاحیه‌ها) دست‌نخورده می‌مانند — حذف آن‌ها یعنی نابودی تاریخچهٔ واقعی تسویه با طرف حساب‌ها.
 * در پایان، ماندهٔ همهٔ حساب‌ها از جمع سطرهای دفتر بازمحاسبه می‌شود (دفتر = تنها منبع حقیقت).
 */
const REPLAYED_EVENTS = ['INVOICE_CONFIRMED', 'ADVANCE_RECEIVED', 'FREIGHT_INVOICE', 'FORWARDING_INCOME'];

export async function rebuildLedger(client: PrismaClient, createdById?: string) {
  // گام ۱: کشف افتتاحیه‌های پنهان (ماندهٔ set شدهٔ مستقیم در کد قدیمی) پیش از هر تغییری
  const accounts = await client.financialAccount.findMany({
    include: { journalLines: { select: { debit: true, credit: true } } },
  });
  const legacyOpenings: { accountId: string; currency: Currency; amount: number }[] = [];
  for (const a of accounts) {
    if (a.ownerType !== 'COMPANY' || a.controlKind || a.type === 'CASH_DEFAULT') continue;
    const journalSum = a.journalLines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    const opening = Number(a.balance) - journalSum;
    if (Math.abs(opening) > 0.005) legacyOpenings.push({ accountId: a.id, currency: a.currency, amount: opening });
  }

  return client.$transaction(async (tx) => {
    // گام ۲: حذف فقط اسناد مشتق (اسناد دستی/تسویه حفظ می‌شوند)
    const { count: deletedEntries } = await tx.journalEntry.deleteMany({
      where: { eventType: { in: REPLAYED_EVENTS } },
    });

    // اصلاح نام کیف پول‌های بی‌نام قدیمی
    const wallets = await tx.financialAccount.findMany({ where: { ownerType: { not: 'COMPANY' }, controlKind: null } });
    for (const w of wallets) {
      if (!w.ownerId || !w.ownerType) continue;
      const realName = await getOwnerName(tx, w.ownerType as OwnerType, w.ownerId);
      const expected = `${realName} - ${w.currency}`;
      if (w.name !== expected) await tx.financialAccount.update({ where: { id: w.id }, data: { name: expected } });
    }

    // گام ۳: ثبت سند افتتاحیه برای حساب‌های شرکت
    for (const op of legacyOpenings) {
      const rate = await rateFor(op.currency);
      const openingCtrl = await getOrCreateControl(tx, 'OPENING', op.currency);
      await postJournal(tx, {
        description: 'سند افتتاحیه (بازسازی دفاتر)',
        eventType: 'OPENING_BALANCE', sourceType: 'Rebuild', createdById,
        lines: op.amount > 0
          ? [
              { accountId: op.accountId, debit: op.amount, currency: op.currency, rateToIRR: rate },
              { accountId: openingCtrl.id, credit: op.amount, currency: op.currency, rateToIRR: rate },
            ]
          : [
              { accountId: openingCtrl.id, debit: -op.amount, currency: op.currency, rateToIRR: rate },
              { accountId: op.accountId, credit: -op.amount, currency: op.currency, rateToIRR: rate },
            ],
      });
    }

    // گام ۴: بازسازی تعهدات فاکتورهای تأییدشده (به ترتیب تاریخ تأیید)
    const approved = await tx.invoice.findMany({
      where: { status: 'APPROVED' },
      orderBy: { confirmedAt: 'asc' },
      select: { id: true },
    });
    for (const inv of approved) await postInvoiceObligations(tx, inv.id, createdById);

    // گام ۵: بازسازی اسناد فاکتورهای حمل (سرشکن وزنی)
    const freights = await tx.freightInvoice.findMany({ include: { shipment: true } });
    for (const f of freights) {
      const shipment = await tx.mainShipment.findUnique({
        where: { id: f.shipmentId },
        include: { packages: { include: { package: { include: { items: { include: { order: true } } } } } }, forwardingCargos: true },
      });
      if (!shipment) continue;
      // وزن هر پروژه در این محموله
      const projWeight: Record<string, number> = {};
      for (const sp of shipment.packages) {
        for (const it of sp.package.items) {
          const parts = await tx.part.findMany({
            where: { projectId: it.order.projectId, selectedPrice: it.order.supplierId ? { supplierId: it.order.supplierId } : { producerId: it.order.producerId } },
            select: { quantity: true, weightGrams: true },
          });
          const w = parts.reduce((s, p) => s + (p.quantity || 0) * (Number(p.weightGrams) || 0), 0);
          projWeight[it.order.projectId] = (projWeight[it.order.projectId] || 0) + w;
        }
      }
      // بارهای فورواردینگ روی این محموله
      for (const cargo of shipment.forwardingCargos) {
        projWeight[cargo.projectId] = (projWeight[cargo.projectId] || 0) + (Number(cargo.weightKg) || 0) * 1000;
      }
      const totalW = Object.values(projWeight).reduce((s, w) => s + w, 0);
      const projIds = Object.keys(projWeight);

      // سهم هر پروژه: اول تسهیم دستی ذخیره‌شده، وگرنه وزنی
      const cb: any = f.costBreakdown || {};
      const projShare: Record<string, number> = {};
      if (Array.isArray(cb.allocations) && cb.allocations.length) {
        for (const a of cb.allocations) if (a.projectId) projShare[a.projectId] = (Number(a.percentage) || 0) / 100;
        for (const pid of projIds) if (projShare[pid] === undefined) projShare[pid] = 0;
      } else {
        for (const pid of projIds) projShare[pid] = totalW > 0 ? projWeight[pid] / totalW : 1 / projIds.length;
      }

      if (cb.totalToman != null || cb.totalUSD != null) {
        // بازپخش وفادار به سند اصلی: دو‌ارزی (تومان + دلار) — بدهی دلاری کریر نباید تومانی شود
        const totalToman = Number(cb.totalToman) || 0;
        const totalUSD = Number(cb.totalUSD) || 0;
        const usdRate = Number(cb.exchangeRate) > 0 ? Number(cb.exchangeRate) : await rateFor('USD');
        const carrierIRR = await getOrCreateWallet(tx, 'CARRIER', shipment.shippingCompanyId, 'IRR');
        const carrierUSD = await getOrCreateWallet(tx, 'CARRIER', shipment.shippingCompanyId, 'USD');
        const freightIRR = await getOrCreateControl(tx, 'FREIGHT', 'IRR');
        const freightUSD = await getOrCreateControl(tx, 'FREIGHT', 'USD');
        // سرشکن دقیق: جمع سهم پروژه‌ها باید مو‌به‌مو برابر کل فاکتور باشد،
        // وگرنه با گرد کردنِ هر سهم، مبلغی از هزینهٔ حمل بی‌صدا گم می‌شود.
        const weights = projIds.map((pid) => projShare[pid] || 0);
        const tomanShares = allocate(totalToman, weights, 0);
        const usdShares = allocate(totalUSD, weights, 2);

        for (let i = 0; i < projIds.length; i++) {
          const pid = projIds[i];
          if ((projShare[pid] || 0) <= 0) continue;
          const shareToman = tomanShares[i];
          const shareUSD = usdShares[i];
          const lines: JournalLineInput[] = [];
          if (shareToman > 0) {
            lines.push({ accountId: freightIRR.id, debit: shareToman, currency: 'IRR', rateToIRR: 1, memo: 'هزینه حمل (تومان)' });
            lines.push({ accountId: carrierIRR.id, credit: shareToman, currency: 'IRR', rateToIRR: 1, memo: 'بدهی حمل (تومان)' });
          }
          if (shareUSD > 0) {
            lines.push({ accountId: freightUSD.id, debit: shareUSD, currency: 'USD', rateToIRR: usdRate, memo: 'هزینه حمل (دلار)' });
            lines.push({ accountId: carrierUSD.id, credit: shareUSD, currency: 'USD', rateToIRR: usdRate, memo: 'بدهی حمل (دلار)' });
          }
          if (lines.length >= 2) {
            await postJournal(tx, {
              description: `فاکتور حمل ${f.invoiceNo || shipment.code} — سهم پروژه (بازسازی)`,
              eventType: 'FREIGHT_INVOICE', sourceType: 'Shipment', sourceId: f.shipmentId, projectId: pid, createdById,
              date: f.registeredAt,
              lines,
            });
          }
        }
      } else {
        // فاکتورهای حمل قدیمی بدون ریز دو‌ارزی
        const cur = f.totalCurrency as Currency;
        const rate = Number(f.totalRateToIRR) > 0 ? Number(f.totalRateToIRR) : await rateFor(cur);
        const carrierWallet = await getOrCreateWallet(tx, 'CARRIER', shipment.shippingCompanyId, cur);
        const freightCtrl = await getOrCreateControl(tx, 'FREIGHT', cur);
        // همان سرشکن دقیق؛ تومان بدون اعشار، ارز با دو رقم
        const shares = allocate(
          Number(f.totalAmount),
          projIds.map((pid) => projShare[pid] || 0),
          cur === 'IRR' ? 0 : 2,
        );
        for (let i = 0; i < projIds.length; i++) {
          const share = shares[i];
          if (share <= 0) continue;
          await postJournal(tx, {
            description: `فاکتور حمل ${f.invoiceNo || shipment.code} — سهم پروژه (بازسازی)`,
            eventType: 'FREIGHT_INVOICE', sourceType: 'Shipment', sourceId: f.shipmentId, projectId: projIds[i], createdById,
            date: f.registeredAt,
            lines: [
              { accountId: freightCtrl.id, debit: share, currency: cur, rateToIRR: rate, memo: 'هزینه حمل' },
              { accountId: carrierWallet.id, credit: share, currency: cur, rateToIRR: rate, memo: 'بدهی به شرکت حمل' },
            ],
          });
        }
      }
    }

    // گام ۶: بازسازی درآمد فورواردینگ (کرایه‌های تأییدشده)
    const confirmedCargos = await tx.forwardingCargo.findMany({
      where: { quoteConfirmedAt: { not: null }, quotedAmount: { not: null } },
      include: { project: { include: { customer: { select: { id: true, name: true } } } } },
    });
    for (const cargo of confirmedCargos) {
      const amount = Number(cargo.quotedAmount);
      if (!(amount > 0)) continue;
      const cur = cargo.quoteCurrency as Currency;
      const rate = await rateFor(cur);
      const custWallet = await getOrCreateWallet(tx, 'CUSTOMER', cargo.project.customerId, cur, cargo.project.customer.name);
      const incomeCtrl = await getOrCreateControl(tx, 'FREIGHT_INCOME', cur);
      await postJournal(tx, {
        description: `درآمد فورواردینگ — پروژهٔ ${cargo.project.code} (بازسازی)`,
        eventType: 'FORWARDING_INCOME', sourceType: 'ForwardingCargo', sourceId: cargo.id, projectId: cargo.projectId, createdById,
        date: cargo.quoteConfirmedAt || undefined,
        lines: [
          { accountId: custWallet.id, debit: amount, currency: cur, rateToIRR: rate },
          { accountId: incomeCtrl.id, credit: amount, currency: cur, rateToIRR: rate },
        ],
      });
    }

    // گام ۷: بازمحاسبهٔ ماندهٔ همهٔ حساب‌ها از جمع سطرهای دفتر (دفتر = تنها منبع حقیقت)
    const sums = await tx.journalLine.groupBy({
      by: ['accountId'],
      _sum: { debit: true, credit: true },
    });
    const sumMap = new Map(sums.map((s) => [s.accountId, Number(s._sum.debit || 0) - Number(s._sum.credit || 0)]));
    const allAccounts = await tx.financialAccount.findMany({ select: { id: true } });
    for (const a of allAccounts) {
      await tx.financialAccount.update({ where: { id: a.id }, data: { balance: sumMap.get(a.id) ?? 0 } });
    }

    const newEntries = await tx.journalEntry.count();
    return { deletedEntries, openingsPosted: legacyOpenings.length, invoicesReposted: approved.length, freightsReposted: freights.length, cargoIncomeReposted: confirmedCargos.length, newEntries };
  }, { timeout: 120000 });
}
