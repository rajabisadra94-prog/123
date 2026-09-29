/**
 * فاز ۶ — اتصال ماژول‌های کسب‌وکار.
 *
 * سه رویداد واقعی (خرید، کرایهٔ فورواردینگ، فاکتور حمل) از هستهٔ جدید رد می‌شوند.
 * تأکید تست‌ها روی جاهایی است که آداپتور **عمداً** با هستهٔ قدیمی فرق دارد.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D, DEFAULT_DATE, expectRejects, resetBusinessData,
} from '../helpers/gl';
import { ensureDefaultCostCenters, ensureProjectCostCenter } from '../../src/modules/ledger/costcenter';
import {
  postPurchase, postForwardingIncome, postFreightInvoice, OP_CODES,
} from '../../src/modules/ledger/adapters/operations';
import { postInvoice } from '../../src/modules/ledger/adapters/invoice';

let fy: { id: string };
const Dec = (v: number | string) => new Prisma.Decimal(v);
const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

let seq = 0;
const nextId = () => String(++seq).padStart(2, '0');

beforeAll(async () => {
  await resetGl();
  await resetBusinessData();
  await seedGlChart();
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl();
  await gl.glExchangeRate.deleteMany({});

  fy = await makeFiscalYear();
  await tx((t) => ensureDefaultCostCenters(t));
  await gl.glExchangeRate.create({
    data: { from: 'USD', to: 'IRR', date: D('2026-04-01'), rate: '1000000', source: 'MANUAL' },
  });
});

async function makeProject() {
  const id = nextId();
  const customer = await gl.customer.create({ data: { name: `مشتری ${id}`, shortCode: `O${id}` } });
  const project = await gl.project.create({ data: { code: `PRJ-${id}`, customerId: customer.id } as any });
  return { customer, project };
}

const linesOf = (entryId: string) =>
  gl.glLine.findMany({
    where: { entryId },
    include: { account: { select: { code: true } }, costCenter: { select: { code: true } }, subsidiary: true },
  });

// ═══════════════════════════════════════════════════════════════
describe('سفارش خرید', () => {
  async function makePurchaseOrder(currencies: { cur: string; unit: number; qty: number }[]) {
    const { project } = await makeProject();
    const supplier = await gl.supplier.create({ data: { name: 'تأمین‌کنندهٔ الف' } as any });

    for (const [i, c] of currencies.entries()) {
      const part = await gl.part.create({
        data: { projectId: project.id, name: `قطعه ${i}`, quantity: c.qty } as any,
      });
      await gl.selectedPrice.create({
        data: {
          partId: part.id, supplierId: supplier.id,
          amount: Dec(c.unit), currency: c.cur, rateToIRR: Dec(c.cur === 'IRR' ? 1 : 100_000),
          rateAt: DEFAULT_DATE,
        } as any,
      });
    }

    const order = await gl.productionOrder.create({
      data: {
        code: `ORD-${nextId()}`, projectId: project.id, supplierId: supplier.id,
        kind: 'PURCHASE', status: 'NEW', createdAt: DEFAULT_DATE,
      } as any,
    });
    return { order, supplier, project };
  }

  it('بدهی به تأمین‌کننده با تفصیلی درست ثبت می‌شود', async () => {
    const { order, supplier } = await makePurchaseOrder([{ cur: 'IRR', unit: 5_000_000, qty: 2 }]);
    const res = await tx((t) => postPurchase(t, order.id, { fiscalYearId: fy.id }));

    expect(res.posted).toBe(true);
    const lines = await linesOf(res.entry.id);
    expect(lines).toHaveLength(2);

    const payable = lines.find((l) => l.account.code === OP_CODES.payable)!;
    expect(payable.subsidiary!.kind).toBe('SUPPLIER');
    expect(payable.subsidiary!.refId).toBe(supplier.id);
    // ۲ × ۵٬۰۰۰٬۰۰۰ تومان = ۱۰۰٬۰۰۰٬۰۰۰ ریال
    expect(payable.creditBase).toBe(100_000_000n);
  });

  it('اقلام چندارزی، موضع ارزی جدا می‌سازند', async () => {
    const { order } = await makePurchaseOrder([
      { cur: 'IRR', unit: 1_000_000, qty: 1 },
      { cur: 'USD', unit: 100, qty: 2 },
    ]);
    const res = await tx((t) => postPurchase(t, order.id, { fiscalYearId: fy.id }));
    const lines = await linesOf(res.entry.id);

    expect(new Set(lines.map((l) => l.currencyCode))).toEqual(new Set(['IRR', 'USD']));
    const usdPayable = lines.find((l) => l.account.code === OP_CODES.payable && l.currencyCode === 'USD')!;
    expect(usdPayable.credit).toBe(20_000n);   // ۲۰۰٫۰۰ دلار به سنت
  });

  it('ثبت دوباره سند تکراری نمی‌سازد', async () => {
    const { order } = await makePurchaseOrder([{ cur: 'IRR', unit: 1_000_000, qty: 1 }]);
    await tx((t) => postPurchase(t, order.id, { fiscalYearId: fy.id }));
    const second = await tx((t) => postPurchase(t, order.id, { fiscalYearId: fy.id }));
    expect(second.posted).toBe(false);
    expect(await gl.glEntry.count()).toBe(1);
  });

  it('سفارش بدون قلم قیمت‌دار خطا می‌دهد', async () => {
    const { project } = await makeProject();
    const supplier = await gl.supplier.create({ data: { name: 'خالی' } as any });
    const order = await gl.productionOrder.create({
      data: { code: `ORD-${nextId()}`, projectId: project.id, supplierId: supplier.id, kind: 'PURCHASE', status: 'NEW' } as any,
    });
    await expectRejects(
      () => tx((t) => postPurchase(t, order.id, { fiscalYearId: fy.id })),
      /قلمی با قیمت معتبر/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
describe('کرایهٔ فورواردینگ', () => {
  async function makeCargo(amount: number, cur: 'USD' | 'IRR' = 'USD') {
    const { project, customer } = await makeProject();
    const cargo = await gl.forwardingCargo.create({
      data: {
        projectId: project.id, quoteCurrency: cur, quotedAmount: Dec(amount),
        quoteConfirmedAt: D('2026-04-01'),
      } as any,
    });
    return { cargo, project, customer };
  }

  it('درآمد فورواردینگ روی حساب ۴۱۰۲ می‌نشیند', async () => {
    const { cargo, customer } = await makeCargo(500);
    const res = await tx((t) => postForwardingIncome(t, cargo.id, { fiscalYearId: fy.id }));

    const lines = await linesOf(res.entry.id);
    expect(lines).toHaveLength(2);

    const income = lines.find((l) => l.account.code === OP_CODES.freightIncome)!;
    expect(income.credit).toBe(50_000n);                 // ۵۰۰٫۰۰ دلار
    expect(income.creditBase).toBe(500_000_000n);        // × ۱٬۰۰۰٬۰۰۰ ریال

    const ar = lines.find((l) => l.account.code === OP_CODES.receivable)!;
    expect(ar.subsidiary!.refId).toBe(customer.id);
  });

  it('نرخ از جدول نرخ خوانده می‌شود، نه از شبکه', async () => {
    const { cargo } = await makeCargo(100);
    const res = await tx((t) => postForwardingIncome(t, cargo.id, { fiscalYearId: fy.id }));
    const lines = await linesOf(res.entry.id);
    expect(lines[0].rate.toString()).toBe('1000000');
  });

  it('نبودِ نرخ برای آن تاریخ، خطای روشن می‌دهد', async () => {
    await gl.glExchangeRate.deleteMany({});
    const { cargo } = await makeCargo(100);
    await expectRejects(
      () => tx((t) => postForwardingIncome(t, cargo.id, { fiscalYearId: fy.id })),
      /ثبت نشده/,
    );
  });

  it('کرایهٔ صفر ثبت نمی‌شود', async () => {
    const { cargo } = await makeCargo(0);
    await expectRejects(
      () => tx((t) => postForwardingIncome(t, cargo.id, { fiscalYearId: fy.id })),
      /کرایهٔ معتبری/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
describe('فاکتور حمل', () => {
  async function makeFreight(opts: {
    totalToman?: number; totalUSD?: number;
    allocations?: { projectId: string; percentage: number }[];
  }) {
    const carrier = await gl.shippingCompany.create({ data: { name: 'شرکت حمل الف' } as any });
    const { project } = await makeProject();
    const shipment = await gl.mainShipment.create({
      data: { code: `SHP-${nextId()}`, shippingCompanyId: carrier.id, type: 'SEA', status: 'ARRIVED' } as any,
    });
    const invoice = await gl.freightInvoice.create({
      data: {
        shipmentId: shipment.id, invoiceNo: `FR-${nextId()}`, invoiceDate: D('2026-04-01'),
        totalAmount: Dec((opts.totalToman ?? 0) + (opts.totalUSD ?? 0) * 100_000),
        totalCurrency: 'IRR', totalRateToIRR: Dec(1), totalRateAt: DEFAULT_DATE,
        costBreakdown: {
          exchangeRate: 100_000,
          totalToman: opts.totalToman ?? 0,
          totalUSD: opts.totalUSD ?? 0,
          allocations: opts.allocations ?? null,
        } as any,
      } as any,
    });
    return { invoice, shipment, carrier, project };
  }

  it('بخش تومانی و دلاری هرکدام موضع ارزی خودشان را می‌سازند', async () => {
    const { shipment } = await makeFreight({ totalToman: 20_000_000, totalUSD: 300 });
    const res = await tx((t) => postFreightInvoice(t, shipment.id, { fiscalYearId: fy.id }));

    const lines = await linesOf(res.entry.id);
    const payables = lines.filter((l) => l.account.code === OP_CODES.payable);
    expect(payables).toHaveLength(2);

    const irr = payables.find((l) => l.currencyCode === 'IRR')!;
    const usd = payables.find((l) => l.currencyCode === 'USD')!;
    expect(irr.credit).toBe(200_000_000n);   // ۲۰ میلیون تومان = ۲۰۰ میلیون ریال
    expect(usd.credit).toBe(30_000n);        // ۳۰۰٫۰۰ دلار
  });

  it('یک سند برای کل فاکتور، نه یکی به‌ازای هر پروژه', async () => {
    const a = await makeProject();
    const b = await makeProject();
    await tx((t) => ensureProjectCostCenter(t, a.project.id));
    await tx((t) => ensureProjectCostCenter(t, b.project.id));

    const { shipment } = await makeFreight({
      totalToman: 30_000_000,
      allocations: [
        { projectId: a.project.id, percentage: 60 },
        { projectId: b.project.id, percentage: 40 },
      ],
    });
    const res = await tx((t) => postFreightInvoice(t, shipment.id, { fiscalYearId: fy.id }));

    expect(await gl.glEntry.count()).toBe(1);   // ← هستهٔ قدیمی اینجا ۲ سند می‌زد

    const lines = await linesOf(res.entry.id);
    const costs = lines.filter((l) => l.account.code === OP_CODES.freightCost);
    expect(costs).toHaveLength(2);
    expect(costs.map((c) => c.costCenter!.code).sort())
      .toEqual([`9.${a.project.code}`, `9.${b.project.code}`].sort());
  });

  it('جمع سهم پروژه‌ها دقیقاً برابر کل است — حتی با درصدهای بدقلق', async () => {
    const a = await makeProject();
    const b = await makeProject();
    const c = await makeProject();
    for (const p of [a, b, c]) await tx((t) => ensureProjectCostCenter(t, p.project.id));

    // سه سهم مساوی از عددی که بر ۳ بخش‌پذیر نیست
    const { shipment } = await makeFreight({
      totalToman: 10_000_001,
      allocations: [
        { projectId: a.project.id, percentage: 33.33 },
        { projectId: b.project.id, percentage: 33.33 },
        { projectId: c.project.id, percentage: 33.34 },
      ],
    });
    const res = await tx((t) => postFreightInvoice(t, shipment.id, { fiscalYearId: fy.id }));

    const lines = await linesOf(res.entry.id);
    const costs = lines.filter((l) => l.account.code === OP_CODES.freightCost);
    const payable = lines.find((l) => l.account.code === OP_CODES.payable)!;

    const sum = costs.reduce((s, l) => s + l.debit, 0n);
    expect(sum).toBe(payable.credit);   // هیچ ریالی گم یا اضافه نشده
  });

  it('فاکتور بدون تسهیم، بدون مرکز هزینه ثبت می‌شود نه اینکه بشکند', async () => {
    const { shipment } = await makeFreight({ totalToman: 5_000_000 });
    const res = await tx((t) => postFreightInvoice(t, shipment.id, { fiscalYearId: fy.id }));

    const costs = (await linesOf(res.entry.id)).filter((l) => l.account.code === OP_CODES.freightCost);
    expect(costs).toHaveLength(1);
    expect(costs[0].costCenterId).toBeNull();
  });

  it('بدهی روی تفصیلی شرکت حمل می‌نشیند', async () => {
    const { shipment, carrier } = await makeFreight({ totalToman: 5_000_000 });
    const res = await tx((t) => postFreightInvoice(t, shipment.id, { fiscalYearId: fy.id }));

    const payable = (await linesOf(res.entry.id)).find((l) => l.account.code === OP_CODES.payable)!;
    expect(payable.subsidiary!.kind).toBe('CARRIER');
    expect(payable.subsidiary!.refId).toBe(carrier.id);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('فاکتور فروش — مسیر تأمین‌کننده', () => {
  it('اقلام تأمین‌کننده هم مثل اقلام سازنده سند می‌گیرند', async () => {
    // هستهٔ قدیمی این اقلام را ساکت رد می‌کرد
    const { project, customer } = await makeProject();
    const supplier = await gl.supplier.create({ data: { name: 'تأمین‌کنندهٔ ب' } as any });

    const part = await gl.part.create({
      data: { projectId: project.id, name: 'قطعهٔ خریدنی', quantity: 1 } as any,
    });
    await gl.selectedPrice.create({
      data: {
        partId: part.id, supplierId: supplier.id,
        amount: Dec(2_000_000), currency: 'IRR', rateToIRR: Dec(1), rateAt: DEFAULT_DATE,
      } as any,
    });

    const invoice = await gl.invoice.create({
      data: {
        projectId: project.id, versionCode: `INV-S${nextId()}`, status: 'APPROVED',
        confirmedAt: DEFAULT_DATE,
        totalAmount: Dec(3_000_000), totalCurrency: 'IRR', totalRateToIRR: Dec(1), hasVat: false,
      } as any,
    });
    await gl.invoiceItem.create({
      data: {
        invoiceId: invoice.id, partId: part.id,
        costAmount: Dec(2_000_000), costCurrency: 'IRR', costRateToIRR: Dec(1),
        saleAmount: Dec(3_000_000), saleCurrency: 'IRR', saleRateToIRR: Dec(1), saleRateAt: DEFAULT_DATE,
      } as any,
    });

    const res = await tx((t) => postInvoice(t, invoice.id, { fiscalYearId: fy.id }));
    const lines = await linesOf(res.entry.id);

    const payable = lines.find((l) => l.account.code === OP_CODES.payable)!;
    expect(payable.subsidiary!.kind).toBe('SUPPLIER');
    expect(payable.creditBase).toBe(20_000_000n);   // ۲ میلیون تومان

    // و سود ناخالص از دفتر درمی‌آید
    const cogs = lines.find((l) => l.account.code === OP_CODES.cogs)!;
    const sales = lines.find((l) => l.account.code === OP_CODES.sales)!;
    expect(sales.creditBase - cogs.debitBase).toBe(10_000_000n);
  });
});
