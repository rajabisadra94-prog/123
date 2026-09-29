/**
 * برش نازک فاز ۶ — عبور یک فاکتور واقعی از هستهٔ جدید.
 *
 * هدف: پیش از ساختن پنج فاز دیگر روی هسته، طراحی را در برابر **یک جریان واقعی
 * کسب‌وکار** بسنجیم، نه در برابر تست‌هایی که خودمان نوشته‌ایم.
 *
 * تفاوت عمدی با هستهٔ قدیمی: آنجا یک فاکتور تا **چهار سند جدا** می‌زد
 * (طلب مشتری، بدهی سازنده، کمیسیون، پیش‌پرداخت). اینجا **یک سند** با چند ردیف
 * ثبت می‌شود — چون از نظر حسابداری یک رویداد است و یک مدرک دارد. سند برگشتی هم
 * آن‌وقت یکی است نه چهارتا.
 *
 * این آداپتور هنوز به هیچ مسیر HTTP وصل نیست.
 */
import { Prisma } from '@prisma/client';
import { post, DraftLine, PostInput } from '../poster';
import { fromLegacyAmount, fromLegacyRate } from '../legacy-amounts';
import { ensureSubsidiary } from '../subsidiary';
import { ensureProjectCostCenter } from '../costcenter';
import { resolveOpenFiscalYear } from '../period';
import { Rate } from '../money';

/** کدهای چارت که این جریان لمس می‌کند */
export const CODES = {
  cash: '110101',
  receivable: '1104',
  payable: '2101',
  vatPayable: '2107',
  sales: '4101',
  cogs: '5101',
  commission: '5103',
} as const;

const accountId = async (tx: Prisma.TransactionClient, code: string) =>
  (await tx.glAccount.findUniqueOrThrow({ where: { code }, select: { id: true } })).id;

export interface InvoiceEntryOptions {
  /** اگر ندهید، از تاریخ سند مشتق می‌شود (`resolveOpenFiscalYear`) */
  fiscalYearId?: string;
  createdById?: string | null;
  /** حساب نقدی که پیش‌پرداخت به آن واریز شده؛ پیش‌فرض صندوق */
  advanceAccountCode?: string;
}

/**
 * فاکتور تأییدشده → یک سند تراز.
 *
 * ترتیب ردیف‌ها عمداً روایت اقتصادی را دنبال می‌کند:
 * طلب مشتری ← درآمد و مالیات ← بهای تمام‌شده و بدهی سازنده ← کمیسیون ← پیش‌پرداخت
 */
export async function buildInvoiceEntry(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  opts: InvoiceEntryOptions,
): Promise<PostInput> {
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      project: {
        include: {
          customer: { select: { id: true, name: true } },
          commissions: { include: { agent: true } },
        },
      },
      items: { include: { part: { include: { selectedPrice: true } } } },
    },
  });
  if (!invoice) throw new Error('فاکتور یافت نشد');

  const currencies = new Map(
    (await tx.glCurrency.findMany()).map((c) => [c.code, c.decimalPlaces]),
  );
  const dec = (code: string) => {
    const d = currencies.get(code);
    if (d === undefined) throw new Error(`ارز «${code}» در هستهٔ جدید تعریف نشده است`);
    return d;
  };

  // این سه روی مدل nullable اند چون فاکتور پیش‌نویس هنوز مبلغ ندارد؛
  // ولی فاکتوری که سند می‌خورد حتماً باید داشته باشد.
  if (!invoice.totalAmount || !invoice.totalCurrency || !invoice.totalRateToIRR) {
    throw new Error(`فاکتور ${invoice.versionCode} مبلغ، ارز یا نرخ ندارد و سند نمی‌گیرد`);
  }
  const invCur = invoice.totalCurrency;
  const invRate: Rate = fromLegacyRate(invoice.totalRateToIRR, invCur);
  const amount = (v: Prisma.Decimal | number, cur: string) => fromLegacyAmount(v, cur, dec(cur));

  // ممیزی ب۵: درآمد و بهای تمام‌شدهٔ فاکتور به مرکز هزینهٔ **پروژه** برچسب می‌خورند
  // تا گزارش سودآوری پروژه معنا پیدا کند. (حساب‌های ۴/۵ مرکزِ اجباری ندارند، پس
  // اگر ساختِ مرکز به هر دلیل شکست خورد، سند بی‌مرکز هم معتبر است.)
  let projectCc: string | null = null;
  try {
    projectCc = (await ensureProjectCostCenter(tx, invoice.projectId)).id;
  } catch { projectCc = null; }

  const lines: DraftLine[] = [];

  // ── ۱) طلب از مشتری ──
  const customer = await ensureSubsidiary(
    tx, 'CUSTOMER', 'Customer', invoice.project.customerId, invoice.project.customer.name,
  );
  const total = amount(invoice.totalAmount, invCur);
  const vat = invoice.hasVat ? amount(invoice.vatAmount ?? 0, invCur) : 0n;
  // مالیات ارزش افزوده درآمد نیست — بدهی به دولت است
  const netSales = total - vat;

  lines.push({
    accountId: await accountId(tx, CODES.receivable),
    subsidiaryId: customer.id,
    currencyCode: invCur, debit: total, rate: invRate,
    memo: `فاکتور ${invoice.versionCode}`,
  });
  lines.push({
    accountId: await accountId(tx, CODES.sales),
    costCenterId: projectCc,
    currencyCode: invCur, credit: netSales, rate: invRate,
    memo: 'درآمد فروش (خالص)',
  });
  if (vat > 0n) {
    lines.push({
      accountId: await accountId(tx, CODES.vatPayable),
      currencyCode: invCur, credit: vat, rate: invRate,
      memo: 'مالیات بر ارزش افزوده',
    });
  }

  // ── ۲) بهای تمام‌شده و بدهی به طرفِ تأمین (سازنده یا تأمین‌کننده) ──
  //
  // هستهٔ قدیمی فقط مسیر سازنده را می‌گرفت و اقلام تأمین‌کننده را ساکت رد می‌کرد.
  // اینجا هر دو پوشش داده می‌شوند؛ چون تفصیلی شناور است، هر دو روی همان معین
  // ۲۱۰۱ می‌نشینند و فقط تفصیلی‌شان فرق می‌کند.
  type Group = {
    partyId: string;
    kind: 'PRODUCER' | 'SUPPLIER';
    currency: string;
    amount: bigint;
    weightedRate: bigint;
  };
  const groups = new Map<string, Group>();

  for (const item of invoice.items) {
    const sp = item.part.selectedPrice;
    if (!sp) continue;
    const partyId = sp.producerId ?? sp.supplierId;
    if (!partyId) continue;
    const kind = sp.producerId ? 'PRODUCER' as const : 'SUPPLIER' as const;

    const cur = item.costCurrency || sp.currency;
    const qty = BigInt(item.part.quantity || 1);
    const unit = Number(item.costAmount) > 0 ? item.costAmount : sp.amount;
    const amt = amount(unit, cur) * qty;         // قیمت «واحد» است، در تعداد ضرب می‌شود
    if (amt <= 0n) continue;

    const legacyRate = Number(item.costRateToIRR) > 0 ? item.costRateToIRR : invoice.totalRateToIRR;
    const r = fromLegacyRate(legacyRate, cur);

    const key = `${partyId}_${cur}`;
    const g = groups.get(key) ?? { partyId, kind, currency: cur, amount: 0n, weightedRate: 0n };
    g.amount += amt;
    // میانگین موزون نرخ در همان گروه — همان قاعدهٔ هستهٔ قدیمی
    g.weightedRate += r.scaled * amt;
    groups.set(key, g);
  }

  for (const g of groups.values()) {
    const party =
      g.kind === 'PRODUCER'
        ? await tx.producer.findUniqueOrThrow({ where: { id: g.partyId }, select: { name: true } })
        : await tx.supplier.findUniqueOrThrow({ where: { id: g.partyId }, select: { name: true } });

    const sub = await ensureSubsidiary(
      tx, g.kind, g.kind === 'PRODUCER' ? 'Producer' : 'Supplier', g.partyId, party.name,
    );
    const rate: Rate = { scaled: g.weightedRate / g.amount };

    lines.push({
      accountId: await accountId(tx, CODES.cogs),
      costCenterId: projectCc,
      currencyCode: g.currency, debit: g.amount, rate,
      memo: `بهای تمام‌شده — ${party.name}`,
    });
    lines.push({
      accountId: await accountId(tx, CODES.payable),
      subsidiaryId: sub.id,
      currencyCode: g.currency, credit: g.amount, rate,
      memo: `بدهی به ${g.kind === 'PRODUCER' ? 'سازنده' : 'تأمین‌کننده'} ${party.name}`,
    });
  }

  // ── ۳) کمیسیون ──
  for (const c of invoice.project.commissions) {
    const pct = new Prisma.Decimal(c.percentage);
    const amt = amount(new Prisma.Decimal(invoice.totalAmount).mul(pct).div(100), invCur);
    if (amt <= 0n) continue;

    const sub = await ensureSubsidiary(tx, 'AGENT', 'CommissionAgent', c.agentId, c.agent?.name ?? 'کمیسیون‌بگیر');
    lines.push({
      accountId: await accountId(tx, CODES.commission),
      costCenterId: projectCc,
      currencyCode: invCur, debit: amt, rate: invRate,
      memo: `کمیسیون ${c.agent?.name ?? ''} (${pct}٪)`,
    });
    lines.push({
      accountId: await accountId(tx, CODES.payable),
      subsidiaryId: sub.id,
      currencyCode: invCur, credit: amt, rate: invRate,
      memo: `بدهی کمیسیون ${c.agent?.name ?? ''}`,
    });
  }

  // ── ۴) پیش‌پرداخت ──
  if (invoice.advanceAmount && Number(invoice.advanceAmount) > 0) {
    const advCur = invoice.advanceCurrency || invCur;
    const advLegacyRate = Number((invoice as any).advanceRateToIRR) > 0
      ? (invoice as any).advanceRateToIRR
      : invoice.totalRateToIRR;
    const advRate = fromLegacyRate(advLegacyRate, advCur);
    const adv = amount(invoice.advanceAmount, advCur);

    lines.push({
      accountId: await accountId(tx, opts.advanceAccountCode ?? CODES.cash),
      currencyCode: advCur, debit: adv, rate: advRate,
      memo: 'دریافت پیش‌پرداخت',
    });
    lines.push({
      accountId: await accountId(tx, CODES.receivable),
      subsidiaryId: customer.id,
      currencyCode: advCur, credit: adv, rate: advRate,
      memo: 'پیش‌پرداخت مشتری',
    });
  }

  return {
    // اگر ندادند، `postInvoice` از تاریخ سند مشتق می‌کند
    fiscalYearId: opts.fiscalYearId as string,
    // تاریخ سند = تاریخ تأیید فاکتور، نه لحظهٔ اجرا. بدون این، سن‌بندی و
    // صورت‌های دوره‌ای همگی به «امروز» می‌لغزند.
    date: invoice.confirmedAt ?? invoice.createdAt,
    description: `فاکتور ${invoice.versionCode} — ${invoice.project.customer.name}`,
    entryType: 'NORMAL',
    sourceType: 'Invoice',
    sourceId: invoice.id,
    createdById: opts.createdById ?? null,
    lines,
  };
}

/** ثبت فاکتور در هستهٔ جدید — idempotent بر پایهٔ مرجع سند */
export async function postInvoice(
  tx: Prisma.TransactionClient,
  invoiceId: string,
  opts: InvoiceEntryOptions,
) {
  const existing = await tx.glEntry.findFirst({
    where: { sourceType: 'Invoice', sourceId: invoiceId, status: { not: 'REVERSED' } },
  });
  if (existing) return { posted: false as const, entry: existing };

  const input = await buildInvoiceEntry(tx, invoiceId, opts);
  if (!input.fiscalYearId) input.fiscalYearId = (await resolveOpenFiscalYear(tx, input.date)).id;
  const entry = await post(tx, input);
  return { posted: true as const, entry };
}
