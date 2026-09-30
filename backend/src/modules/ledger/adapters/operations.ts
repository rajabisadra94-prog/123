/**
 * فاز ۶ — اتصال بقیهٔ ماژول‌های کسب‌وکار به هستهٔ جدید.
 *
 * سه رویدادی که در هستهٔ قدیمی سند می‌زنند و آداپتور فاکتور پوششان نمی‌دهد:
 *   • سفارش خرید از تأمین‌کننده  (`orders/purchase.service.ts`)
 *   • تأیید کرایهٔ فورواردینگ    (`forwarding/forwarding.routes.ts`)
 *   • فاکتور حمل                 (`accounting.routes.ts` → `FreightInvoice`)
 *
 * الگو همان آداپتور فاکتور است: **یک رویداد کسب‌وکاری = یک سند تراز**.
 * هیچ‌کدام هنوز به مسیر HTTP وصل نیستند.
 *
 * > `ProjectShippingCost` عمداً آداپتور ندارد: آن مدل «هزینهٔ حمل» نیست، بلکه
 * > **نرخ هر کیلو** برای قیمت‌گذاری است و اصلاً شرکت حمل ندارد. ساختن سند از آن
 * > یعنی اختراع بدهی‌ای که وجود ندارد.
 */
import { Prisma } from '@prisma/client';
import { post, DraftLine, PostInput } from '../poster';
import { fromLegacyAmount, fromLegacyRate } from '../legacy-amounts';
import { ensureSubsidiary } from '../subsidiary';
import { ensureProjectCostCenter } from '../costcenter';
import { resolveOpenFiscalYear } from '../period';
import { resolveRate } from '../fx';
import { allocate, Rate, Minor } from '../money';
import { CODES } from './invoice';

/** مرکز هزینهٔ پروژه، با تحمّلِ خطا (حساب‌های ۴/۵ مرکزِ اجباری ندارند) */
async function projectCostCenter(tx: Prisma.TransactionClient, projectId: string): Promise<string | null> {
  try { return (await ensureProjectCostCenter(tx, projectId)).id; }
  catch { return null; }
}

export const OP_CODES = {
  ...CODES,
  freightIncome: '4102',
  freightCost: '5102',
} as const;

const accountId = async (tx: Prisma.TransactionClient, code: string) =>
  (await tx.glAccount.findUniqueOrThrow({ where: { code }, select: { id: true } })).id;

async function currencyDecimals(tx: Prisma.TransactionClient) {
  const rows = await tx.glCurrency.findMany();
  const map = new Map(rows.map((c) => [c.code, c.decimalPlaces]));
  return (code: string) => {
    const d = map.get(code);
    if (d === undefined) throw new Error(`ارز «${code}» در هستهٔ جدید تعریف نشده است`);
    return d;
  };
}

export interface OpOptions {
  /** اگر ندهید، از تاریخ سند مشتق می‌شود */
  fiscalYearId?: string;
  createdById?: string | null;
}

// ───────────────────────────────────────────────────────────────
// سفارش خرید → بدهی به تأمین‌کننده
// ───────────────────────────────────────────────────────────────

/**
 * سفارش خرید → بدهکار بهای تمام‌شده / بستانکار تأمین‌کننده.
 *
 * گروه‌بندی بر **ارز** انجام می‌شود: یک سفارش می‌تواند اقلامی به دلار و اقلامی
 * به یوآن داشته باشد، و هرکدام باید موضع ارزی خودشان را بسازند.
 */
export async function buildPurchaseEntry(
  tx: Prisma.TransactionClient,
  orderId: string,
  opts: OpOptions,
): Promise<PostInput> {
  const order = await tx.productionOrder.findUnique({
    where: { id: orderId },
    include: {
      project: { select: { id: true, code: true } },
      supplier: { select: { id: true, name: true } },
    },
  });
  if (!order) throw new Error('سفارش خرید یافت نشد');
  if (!order.supplierId || !order.supplier) throw new Error('این سفارش تأمین‌کننده ندارد');

  const parts = await tx.part.findMany({
    where: { projectId: order.projectId, selectedPrice: { supplierId: order.supplierId } },
    include: { selectedPrice: true },
  });

  const dec = await currencyDecimals(tx);
  const groups = new Map<string, { currency: string; amount: bigint; weightedRate: bigint }>();

  for (const part of parts) {
    const sp = part.selectedPrice!;
    const qty = BigInt(part.quantity || 1);
    const amt = fromLegacyAmount(sp.amount, sp.currency, dec(sp.currency)) * qty;
    if (amt <= 0n) continue;

    const r = fromLegacyRate(sp.rateToIRR, sp.currency);
    const g = groups.get(sp.currency) ?? { currency: sp.currency, amount: 0n, weightedRate: 0n };
    g.amount += amt;
    g.weightedRate += r.scaled * amt;
    groups.set(sp.currency, g);
  }

  if (!groups.size) throw new Error(`سفارش ${order.code} قلمی با قیمت معتبر ندارد`);

  const sub = await ensureSubsidiary(tx, 'SUPPLIER', 'Supplier', order.supplierId, order.supplier.name);
  const projectCc = await projectCostCenter(tx, order.projectId);   // ممیزی ب۵
  const lines: DraftLine[] = [];

  for (const g of groups.values()) {
    const rate: Rate = { scaled: g.weightedRate / g.amount };
    lines.push({
      accountId: await accountId(tx, OP_CODES.cogs),
      costCenterId: projectCc,
      currencyCode: g.currency, debit: g.amount, rate,
      memo: `بهای تمام‌شدهٔ خرید — سفارش ${order.code}`,
    });
    lines.push({
      accountId: await accountId(tx, OP_CODES.payable),
      subsidiaryId: sub.id,
      currencyCode: g.currency, credit: g.amount, rate,
      memo: `بدهی به تأمین‌کننده ${order.supplier.name}`,
    });
  }

  return {
    fiscalYearId: opts.fiscalYearId as string,  // postOnce اگر خالی باشد از input.date مشتق می‌کند
    date: order.createdAt,
    description: `سفارش خرید ${order.code} — ${order.supplier.name} (${order.project.code})`,
    entryType: 'NORMAL',
    sourceType: 'ProductionOrder',
    sourceId: order.id,
    createdById: opts.createdById ?? null,
    lines,
  };
}

// ───────────────────────────────────────────────────────────────
// کرایهٔ فورواردینگ → درآمد خدمات
// ───────────────────────────────────────────────────────────────

/**
 * تأیید کرایه → بدهکار مشتری / بستانکار درآمد فورواردینگ.
 *
 * `ForwardingCargo` نرخ ارز ذخیره‌شده **ندارد** — هستهٔ قدیمی نرخ زنده می‌گرفت.
 * اینجا نرخ از `GlExchangeRate` در تاریخ تأیید کرایه خوانده می‌شود، هم برای
 * پرهیز از شبکه داخل تراکنش و هم برای بازتولیدپذیری.
 */
export async function buildForwardingIncomeEntry(
  tx: Prisma.TransactionClient,
  cargoId: string,
  opts: OpOptions,
): Promise<PostInput> {
  const cargo = await tx.forwardingCargo.findUnique({
    where: { id: cargoId },
    include: { project: { include: { customer: { select: { id: true, name: true } } } } },
  });
  if (!cargo) throw new Error('بار یافت نشد');
  if (!cargo.quotedAmount || Number(cargo.quotedAmount) <= 0) {
    throw new Error('کرایهٔ معتبری ثبت نشده است');
  }

  const dec = await currencyDecimals(tx);
  const cur = cargo.quoteCurrency;
  const date = cargo.quoteConfirmedAt ?? cargo.createdAt;
  const amount = fromLegacyAmount(cargo.quotedAmount, cur, dec(cur));
  const rate = await resolveRate(tx, cur, date);

  const sub = await ensureSubsidiary(
    tx, 'CUSTOMER', 'Customer', cargo.project.customerId, cargo.project.customer.name,
  );
  const projectCc = await projectCostCenter(tx, cargo.projectId);   // ممیزی ب۵

  return {
    fiscalYearId: opts.fiscalYearId as string,  // postOnce اگر خالی باشد از input.date مشتق می‌کند
    date,
    description: `درآمد فورواردینگ — پروژهٔ ${cargo.project.code}`,
    entryType: 'NORMAL',
    sourceType: 'ForwardingCargo',
    sourceId: cargo.id,
    createdById: opts.createdById ?? null,
    lines: [
      {
        accountId: await accountId(tx, OP_CODES.receivable),
        subsidiaryId: sub.id,
        currencyCode: cur, debit: amount, rate,
        memo: `کرایهٔ حمل — ${cargo.project.code}`,
      },
      {
        accountId: await accountId(tx, OP_CODES.freightIncome),
        costCenterId: projectCc,
        currencyCode: cur, credit: amount, rate,
        memo: 'درآمد خدمات فورواردینگ',
      },
    ],
  };
}

// ───────────────────────────────────────────────────────────────
// فاکتور حمل → بدهی به شرکت حمل، تسهیم بین پروژه‌ها
// ───────────────────────────────────────────────────────────────

interface FreightBreakdown {
  exchangeRate?: number | string;
  totalToman?: number;
  totalUSD?: number;
  allocations?: { projectId?: string; percentage?: number | string }[] | null;
}

/**
 * فاکتور حمل → **یک** سند، با تسهیم بین پروژه‌ها روی **مرکز هزینه**.
 *
 * دو تفاوت عمدی با هستهٔ قدیمی:
 *
 * ۱) آنجا به‌ازای هر پروژه یک سند جدا زده می‌شد. اینجا یک سند با چند ردیف است و
 *    سهم هر پروژه با **مرکز هزینه** مشخص می‌شود — همان چیزی که بُعد مرکز هزینه
 *    برایش ساخته شد. ابطال فاکتور هم یک سند برگشتی می‌شود نه چندتا.
 *
 * ۲) آنجا سهم هر پروژه با `Math.round(prop × total)` حساب می‌شد و جمع سهم‌ها
 *    می‌توانست چند ریال از کل کم یا زیاد شود. اینجا از `allocate` (بزرگ‌ترین
 *    باقی‌مانده) استفاده می‌شود که جمعش **دقیقاً** برابر کل است.
 */
export async function buildFreightInvoiceEntry(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  opts: OpOptions,
): Promise<PostInput> {
  const invoice = await tx.freightInvoice.findUnique({
    where: { shipmentId },
    include: { shipment: { include: { shippingCompany: { select: { id: true, name: true } } } } },
  });
  if (!invoice) throw new Error('فاکتور حمل یافت نشد');

  const dec = await currencyDecimals(tx);
  const bd = (invoice.costBreakdown ?? {}) as FreightBreakdown;
  const carrier = invoice.shipment.shippingCompany;
  const sub = await ensureSubsidiary(tx, 'CARRIER', 'ShippingCompany', carrier.id, carrier.name);
  const date = invoice.invoiceDate ?? invoice.registeredAt;

  /**
   * مبلغ به تفکیک ارز از `costBreakdown` می‌آید، نه از `totalAmount`.
   * `totalAmount` معادل تومانیِ **کل** است؛ اگر آن را مبنا بگیریم، بخش دلاری
   * فاکتور موضع ارزی خودش را از دست می‌دهد و تسعیر بعدی غلط می‌شود.
   */
  const legs: { currency: string; amount: Minor; rate: Rate }[] = [];
  if (bd.totalToman && bd.totalToman > 0) {
    legs.push({
      currency: 'IRR',
      amount: fromLegacyAmount(bd.totalToman, 'IRR', dec('IRR')),
      rate: fromLegacyRate(1, 'IRR'),
    });
  }
  if (bd.totalUSD && bd.totalUSD > 0) {
    legs.push({
      currency: 'USD',
      amount: fromLegacyAmount(bd.totalUSD, 'USD', dec('USD')),
      rate: bd.exchangeRate ? fromLegacyRate(bd.exchangeRate, 'USD') : await resolveRate(tx, 'USD', date),
    });
  }
  if (!legs.length) {
    // فاکتوری که تفکیک ارزی ندارد: کل مبلغ به ارز خودش
    legs.push({
      currency: invoice.totalCurrency,
      amount: fromLegacyAmount(invoice.totalAmount, invoice.totalCurrency, dec(invoice.totalCurrency)),
      rate: fromLegacyRate(invoice.totalRateToIRR, invoice.totalCurrency),
    });
  }

  // تسهیم بین پروژه‌ها؛ اگر تسهیمی ثبت نشده، سند بدون مرکز هزینه می‌ماند
  const allocations = (bd.allocations ?? []).filter((a) => a.projectId && Number(a.percentage) > 0);
  const costCenterIds: (string | null)[] = [];
  const weights: bigint[] = [];

  for (const a of allocations) {
    // مرکز هزینهٔ پروژه با کد قراردادی «۹.<کد پروژه>» ساخته می‌شود (costcenter.ts).
    // اگر هنوز ساخته نشده، سهمش بدون مرکز ثبت می‌شود و در گزارش زیر
    // «تخصیص‌نیافته» دیده می‌شود — نه اینکه سند شکست بخورد.
    const project = await tx.project.findUnique({ where: { id: a.projectId! }, select: { code: true } });
    const cc = project
      ? await tx.glCostCenter.findUnique({ where: { code: `9.${project.code}` } })
      : null;
    costCenterIds.push(cc?.id ?? null);
    // درصدها می‌توانند اعشاری باشند؛ در ۱۰۰۰ ضرب می‌شوند تا وزن صحیح شود
    weights.push(BigInt(Math.round(Number(a.percentage) * 1000)));
  }

  const lines: DraftLine[] = [];
  const cogsId = await accountId(tx, OP_CODES.freightCost);
  const payableId = await accountId(tx, OP_CODES.payable);

  for (const leg of legs) {
    // سمت بدهی: یک ردیف برای کل مبلغ همان ارز
    lines.push({
      accountId: payableId,
      subsidiaryId: sub.id,
      currencyCode: leg.currency, credit: leg.amount, rate: leg.rate,
      memo: `بدهی حمل به ${carrier.name}`,
    });

    // سمت هزینه: تسهیم‌شده بین مراکز هزینه، با جمع دقیقاً برابر کل
    if (weights.length) {
      const shares = allocate(leg.amount, weights);
      shares.forEach((share, i) => {
        if (share <= 0n) return;
        lines.push({
          accountId: cogsId,
          costCenterId: costCenterIds[i],
          currencyCode: leg.currency, debit: share, rate: leg.rate,
          memo: 'هزینهٔ حمل — سهم پروژه',
        });
      });
    } else {
      lines.push({
        accountId: cogsId,
        currencyCode: leg.currency, debit: leg.amount, rate: leg.rate,
        memo: 'هزینهٔ حمل (تسهیم‌نشده)',
      });
    }
  }

  return {
    fiscalYearId: opts.fiscalYearId as string,  // postOnce اگر خالی باشد از input.date مشتق می‌کند
    date,
    description: `فاکتور حمل ${invoice.invoiceNo ?? invoice.shipment.code} — ${carrier.name}`,
    entryType: 'NORMAL',
    sourceType: 'FreightInvoice',
    sourceId: invoice.id,
    createdById: opts.createdById ?? null,
    lines,
  };
}

// ───────────────────────────────────────────────────────────────
// ثبت idempotent
// ───────────────────────────────────────────────────────────────

/** هر رویداد فقط یک بار سند می‌گیرد؛ سند باطل‌شده مانع ثبت دوباره نیست */
async function postOnce(
  tx: Prisma.TransactionClient,
  sourceType: string,
  sourceId: string,
  build: () => Promise<PostInput>,
) {
  const existing = await tx.glEntry.findFirst({
    where: { sourceType, sourceId, status: { not: 'REVERSED' } },
  });
  if (existing) return { posted: false as const, entry: existing };
  const input = await build();
  if (!input.fiscalYearId) input.fiscalYearId = (await resolveOpenFiscalYear(tx, input.date)).id;
  return { posted: true as const, entry: await post(tx, input) };
}

export const postPurchase = (tx: Prisma.TransactionClient, orderId: string, opts: OpOptions) =>
  postOnce(tx, 'ProductionOrder', orderId, () => buildPurchaseEntry(tx, orderId, opts));

export const postForwardingIncome = (tx: Prisma.TransactionClient, cargoId: string, opts: OpOptions) =>
  postOnce(tx, 'ForwardingCargo', cargoId, () => buildForwardingIncomeEntry(tx, cargoId, opts));

export async function postFreightInvoice(
  tx: Prisma.TransactionClient,
  shipmentId: string,
  opts: OpOptions,
) {
  const invoice = await tx.freightInvoice.findUnique({ where: { shipmentId }, select: { id: true } });
  if (!invoice) throw new Error('فاکتور حمل یافت نشد');
  return postOnce(tx, 'FreightInvoice', invoice.id, () => buildFreightInvoiceEntry(tx, shipmentId, opts));
}
