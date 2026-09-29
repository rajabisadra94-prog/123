/**
 * پلِ بین ماژول‌های کسب‌وکار و دو هستهٔ حسابداری — فاز ۳ و ۶ نقشهٔ پاریتی.
 *
 * سه حالت، از دو فلگِ زنده‌خوانده (`LEDGER_PRIMARY`, `LEDGER_DUAL_WRITE`):
 *
 *   'legacy'  (پیش‌فرض)   فقط هستهٔ قدیمی. `pw*` و `dw*` بی‌اثر.
 *   'dual'    DUAL_WRITE=true   قدیمی مرجع (داخل تراکنشِ کسب‌وکار) + جدید سایه
 *             (تراکنش جدا، **بعد از** commit، خطا فقط لاگ). دورهٔ اعتبارسنجی.
 *   'new'     PRIMARY=new      **جدید مرجع، داخل همان تراکنش** — خطایش کار
 *             کسب‌وکار را برمی‌گرداند. قدیمی نوشته نمی‌شود (مسیر `if (writeLegacy())`).
 *
 * چرا سایه در تراکنش جدا و نه همان تراکنش: در حالت 'dual' نمی‌خواهیم باگِ هستهٔ
 * جدید کار کسب‌وکار را برگرداند. در حالت 'new' برعکس می‌خواهیم — پس `pw*` داخل
 * تراکنش صدا زده می‌شود. (`poster.post` تریگر توازن را با `SET CONSTRAINTS
 * IMMEDIATE` همان‌جا می‌سنجد، پس خطا در COMMIT بی‌صدا بلعیده نمی‌شود.)
 *
 * همهٔ آداپتورها idempotent‌اند (`sourceType`+`sourceId`)، پس اجرای دوباره بی‌خطر.
 */
import prisma from '../../shared/utils/prisma';
import { postInvoice } from './adapters/invoice';
import { postPurchase, postForwardingIncome, postFreightInvoice } from './adapters/operations';
import { doSettlement } from './ops';
import { fromLegacyAmount } from './legacy-amounts';
import { ensureSubsidiary } from './subsidiary';
import { resolveOpenFiscalYear } from './period';
import { GlSubsidiaryKind, Prisma } from '@prisma/client';

export type LedgerMode = 'legacy' | 'dual' | 'new';

/** حالت جاری — هر دو فلگ زنده خوانده می‌شوند (نه در لحظهٔ import) */
export function ledgerMode(): LedgerMode {
  if (process.env.LEDGER_PRIMARY === 'new') return 'new';
  if (process.env.LEDGER_DUAL_WRITE === 'true') return 'dual';
  return 'legacy';
}

/** مسیر کسب‌وکار باید به هستهٔ قدیمی بنویسد؟ فقط در حالت 'new' نه. */
export const writeLegacy = (): boolean => ledgerMode() !== 'new';

/** سایهٔ 'dual' فقط وقتی فعال است که حالت دقیقاً 'dual' باشد (نه 'new') */
export const dualWriteEnabled = (): boolean => ledgerMode() === 'dual';

/** هستهٔ جدید فقط وقتی آماده است که چارت و سال مالی داشته باشد */
async function ledgerReady(): Promise<boolean> {
  if (!dualWriteEnabled()) return false;
  const [accounts, fiscalYears] = await Promise.all([
    prisma.glAccount.count(),
    prisma.glFiscalYear.count(),
  ]);
  return accounts > 0 && fiscalYears > 0;
}

/**
 * گاردِ حالت 'new': اگر جدید مرجع است ولی چارت/سال مالی ندارد، **خطا** —
 * سکوت یعنی سندِ گم‌شده. (بر خلاف 'dual' که سکوت درست است.)
 */
async function assertPrimaryReady(tx: Prisma.TransactionClient): Promise<void> {
  const [a, f] = await Promise.all([tx.glAccount.count(), tx.glFiscalYear.count()]);
  if (a === 0 || f === 0) {
    throw new Error(
      'هستهٔ جدید مرجع است (LEDGER_PRIMARY=new) ولی چارت یا سال مالی ندارد — ' +
      '`/ledger/setup` و ساخت سال مالی را اجرا کنید یا فلگ را بردارید',
    );
  }
}

/** پوستهٔ نوشتنِ مرجع در حالت 'new': داخل تراکنشِ صداکننده، خطا بالا می‌رود */
async function primary(
  tx: Prisma.TransactionClient,
  fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
  opts: { needsFiscalYear?: boolean } = {},
): Promise<void> {
  if (ledgerMode() !== 'new') return;
  if (opts.needsFiscalYear !== false) await assertPrimaryReady(tx);
  await fn(tx);
}

/** پوستهٔ امن: تراکنش خودش، خطا فقط لاگ */
async function run(label: string, fn: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<void> {
  if (!(await ledgerReady())) return;
  try {
    await prisma.$transaction(fn, { timeout: 60_000 });
  } catch (e: any) {
    console.warn(`[dual-write] ${label} ناموفق — نادیده گرفته شد: ${e?.message ?? e}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// رویدادهای تعهد — idempotent، بدون نگاشت حساب شرکت
// ═══════════════════════════════════════════════════════════════

export const dwInvoice = (invoiceId: string, userId: string) =>
  run(`فاکتور ${invoiceId}`, (tx) => postInvoice(tx, invoiceId, { createdById: userId }));

export const dwPurchaseOrder = (orderId: string, userId: string) =>
  run(`سفارش خرید ${orderId}`, (tx) => postPurchase(tx, orderId, { createdById: userId }));

export const dwForwardingIncome = (cargoId: string, userId: string) =>
  run(`درآمد فورواردینگ ${cargoId}`, (tx) => postForwardingIncome(tx, cargoId, { createdById: userId }));

export const dwFreightInvoice = (shipmentId: string, userId: string) =>
  run(`فاکتور حمل ${shipmentId}`, (tx) => postFreightInvoice(tx, shipmentId, { createdById: userId }));

// ═══════════════════════════════════════════════════════════════
// تسویه — نیاز به نگاشت طرف‌حساب و حساب نقدیِ شرکت
// ═══════════════════════════════════════════════════════════════

const OWNER_TO_KIND: Record<string, GlSubsidiaryKind> = {
  CUSTOMER: 'CUSTOMER', PRODUCER: 'PRODUCER', SUPPLIER: 'SUPPLIER',
  CARRIER: 'CARRIER', EXCHANGE: 'EXCHANGE', COMMISSION_AGENT: 'AGENT',
};
const OWNER_TO_REFTYPE: Record<string, string> = {
  CUSTOMER: 'Customer', PRODUCER: 'Producer', SUPPLIER: 'Supplier',
  CARRIER: 'ShippingCompany', EXCHANGE: 'Exchange', COMMISSION_AGENT: 'CommissionAgent',
};

/**
 * ساخت تفصیلیِ یک طرف‌حساب همان لحظهٔ تعریفش — تا دراپ‌داون‌های هستهٔ جدید
 * پیش از اولین تراکنش هم پر باشند. آداپتورها خودشان هم موقع ثبت این کار را
 * می‌کنند، پس این فقط یک جلوجلو است.
 */
export const dwEnsureSubsidiary = (ownerType: string, ownerId: string, name: string) =>
  run(`تفصیلی ${ownerType}/${ownerId}`, (tx) => {
    const kind = OWNER_TO_KIND[ownerType];
    if (!kind) throw new Error(`نوع طرف‌حساب ناشناخته: ${ownerType}`);
    return ensureSubsidiary(tx, kind, OWNER_TO_REFTYPE[ownerType], ownerId, name);
  });

/** مدل رکورد اصلیِ هر نوع طرف‌حساب — برای خواندن نام */
const OWNER_MODEL: Record<string, 'customer' | 'producer' | 'supplier' | 'shippingCompany' | 'exchange' | 'commissionAgent'> = {
  CUSTOMER: 'customer', PRODUCER: 'producer', SUPPLIER: 'supplier',
  CARRIER: 'shippingCompany', EXCHANGE: 'exchange', COMMISSION_AGENT: 'commissionAgent',
};

export interface DualSettlement {
  /** شناسهٔ سند تسویهٔ هستهٔ قدیمی — کلید idempotency */
  legacyEntryId: string;
  direction: 'RECEIPT' | 'PAYMENT';
  ownerType: string;
  ownerId: string;
  currency: string;
  /** مبلغ تسویه به ارز تعهد، در واحد نمایش (نه کوچک‌ترین واحد) */
  amount: number | string;
  /** نام حساب نقدیِ هستهٔ قدیمی — با نامِ برگِ چارت جدید تطبیق داده می‌شود */
  legacyCashAccountName: string;
  date: Date;
  userId: string;
}

/**
 * مبلغِ تسویه از واحدِ نمایشِ **هستهٔ قدیمی** به واحدِ نمایشِ **هستهٔ جدید**.
 *
 * ⚠️ باگی که این تابع برای رفعش نوشته شد: هستهٔ قدیمی مبالغ ریالی را به
 * **تومان** نگه می‌دارد و جدید به **ریال**. آداپتور مبلغ را دست‌نخورده رد
 * می‌کرد، پس یک دریافتِ ۱۲٬۳۴۵٬۰۰۰ تومانی در هستهٔ قدیمی ۱۲۳٬۴۵۰٬۰۰۰ ریال
 * می‌نشست و در جدید ۱۲٬۳۴۵٬۰۰۰ ریال — **یک‌دهم**.
 *
 * تست‌ها این را نگرفتند چون همه‌شان هستهٔ جدید را مستقیم صدا می‌زنند، جایی
 * که واحد از ابتدا ریال است. فقط ورزش دادنِ مسیر واقعیِ HTTP روی staging
 * نشانش داد.
 *
 * ارزهای دیگر دست‌نخورده می‌مانند: واحدشان در دو هسته یکی است و فقط
 * ریزمقیاس (سنت/فِن) فرق می‌کند که `doSettlement` خودش انجام می‌دهد.
 */
async function toNewDisplayAmount(
  tx: Prisma.TransactionClient,
  amount: number | string,
  currencyCode: string,
): Promise<string> {
  const cur = await tx.glCurrency.findUnique({ where: { code: currencyCode } });
  if (!cur?.isBase) return String(amount);

  // ارز پایه: تومان → ریال. `fromLegacyAmount` مقیاس و گردکردن را یک‌جا
  // انجام می‌دهد (اعشارِ تومان پیش از تبدیل گم نمی‌شود)، و چون واحدِ نمایشِ
  // ریال صفر اعشار دارد، خودِ عددِ کوچک‌ترین‌واحد همان رشتهٔ نمایش است.
  return fromLegacyAmount(String(amount), currencyCode, cur.decimalPlaces).toString();
}

/** نگاشتِ مشترکِ تسویه: طرف‌حساب → تفصیلی، نامِ حساب نقدی → کد برگِ چارت جدید */
async function resolveSettlementRefs(
  tx: Prisma.TransactionClient,
  p: { ownerType: string; ownerId: string; cashAccountName: string; date: Date },
): Promise<{ subsidiaryId: string; cashAccountCode: string; fiscalYearId: string }> {
  const kind = OWNER_TO_KIND[p.ownerType];
  const model = OWNER_MODEL[p.ownerType];
  if (!kind || !model) throw new Error(`نوع طرف‌حساب ناشناخته: ${p.ownerType}`);

  const record = await (tx as any)[model].findUnique({ where: { id: p.ownerId }, select: { name: true } });
  const sub = await ensureSubsidiary(tx, kind, OWNER_TO_REFTYPE[p.ownerType], p.ownerId, record?.name ?? p.ownerId);

  const cashAcc = await tx.glAccount.findFirst({
    where: { name: p.cashAccountName, isPostable: true, code: { startsWith: '1101' } },
    select: { code: true },
  });
  if (!cashAcc) throw new Error(`حساب نقدیِ چارت جدید با نام «${p.cashAccountName}» پیدا نشد`);

  const fy = await resolveOpenFiscalYear(tx, p.date);
  return { subsidiaryId: sub.id, cashAccountCode: cashAcc.code, fiscalYearId: fy.id };
}

/**
 * سایهٔ 'dual' یک تسویه.
 *
 * نگاشت حساب نقدی **با نام** انجام می‌شود — مهاجرت هم برگِ نقدی جدید را با
 * همین نام ساخته (`ensureCashLeaf`). اگر نامی نخواند، سند رد می‌شود و لاگ
 * می‌گیرد؛ هارنس diff نشانش می‌دهد. کلید idempotency = شناسهٔ سند قدیمی.
 */
export const dwSettlement = (p: DualSettlement) =>
  run(`تسویه ${p.ownerType}/${p.ownerId}`, async (tx) => {
    const refs = await resolveSettlementRefs(tx, {
      ownerType: p.ownerType, ownerId: p.ownerId, cashAccountName: p.legacyCashAccountName, date: p.date,
    });
    await doSettlement(tx, {
      ...refs, date: p.date, direction: p.direction,
      currency: p.currency,
      amount: await toNewDisplayAmount(tx, p.amount, p.currency),
      createdById: p.userId, sourceId: p.legacyEntryId,
    });
  });

// ═══════════════════════════════════════════════════════════════
// نوشتنِ مرجع در حالت 'new' — داخل تراکنشِ کسب‌وکار، خطا بالا می‌رود
//
// هر تابع در حالت 'legacy'/'dual' بی‌اثر است (سایهٔ 'dual' جدا کار می‌کند).
// مسیرها این‌ها را داخل همان `$transaction`ی صدا می‌زنند که به هستهٔ قدیمی
// می‌نوشت (که حالا پشت `if (writeLegacy())` است).
// ═══════════════════════════════════════════════════════════════

export const pwInvoice = (tx: Prisma.TransactionClient, invoiceId: string, userId: string) =>
  primary(tx, (t) => postInvoice(t, invoiceId, { createdById: userId }));

export const pwPurchaseOrder = (tx: Prisma.TransactionClient, orderId: string, userId: string) =>
  primary(tx, (t) => postPurchase(t, orderId, { createdById: userId }));

export const pwForwardingIncome = (tx: Prisma.TransactionClient, cargoId: string, userId: string) =>
  primary(tx, (t) => postForwardingIncome(t, cargoId, { createdById: userId }));

export const pwFreightInvoice = (tx: Prisma.TransactionClient, shipmentId: string, userId: string) =>
  primary(tx, (t) => postFreightInvoice(t, shipmentId, { createdById: userId }));

export const pwEnsureSubsidiary = (tx: Prisma.TransactionClient, ownerType: string, ownerId: string, name: string) =>
  primary(tx, (t) => {
    const kind = OWNER_TO_KIND[ownerType];
    if (!kind) throw new Error(`نوع طرف‌حساب ناشناخته: ${ownerType}`);
    return ensureSubsidiary(t, kind, OWNER_TO_REFTYPE[ownerType], ownerId, name);
  }, { needsFiscalYear: false });   // ساخت تفصیلی به سال مالی بند نیست

export interface PrimarySettlement {
  direction: 'RECEIPT' | 'PAYMENT';
  ownerType: string;
  ownerId: string;
  currency: string;
  amount: number | string;
  /** نام حساب نقدیِ شرکت (هستهٔ قدیمی) — با برگِ چارت جدید تطبیق می‌شود */
  companyAccountName: string;
  date: Date;
  userId: string;
}

/**
 * تسویهٔ مرجع در حالت 'new'.
 *
 * فقط هم‌ارز — هستهٔ جدید تبدیل واحد را در تسویه نمی‌پذیرد. مسیرِ صداکننده باید
 * پیش از این، حالتِ چندارزی را با خطای روشن رد کرده باشد. `sourceId` نمی‌گیرد:
 * مسیرِ `/settlements` خودش هم کلید idempotency ندارد و رفتار یکی می‌ماند.
 */
export const pwSettlement = (tx: Prisma.TransactionClient, p: PrimarySettlement) =>
  primary(tx, async (t) => {
    const refs = await resolveSettlementRefs(t, {
      ownerType: p.ownerType, ownerId: p.ownerId, cashAccountName: p.companyAccountName, date: p.date,
    });
    await doSettlement(t, {
      ...refs, date: p.date, direction: p.direction,
      currency: p.currency,
      // همان تبدیل: مسیرِ `/accounting/settlements` در حالت 'new' هم مبلغ را
      // از رابطِ قدیمی می‌گیرد، که تومان می‌فرستد.
      amount: await toNewDisplayAmount(t, p.amount, p.currency),
      createdById: p.userId,
    });
  });
