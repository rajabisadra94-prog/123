/**
 * برش نازک فاز ۶ — یک فاکتور واقعی از هستهٔ جدید رد می‌شود.
 *
 * هدف این تست «پوشش» نیست؛ **سنجش طراحی در برابر واقعیت** است. سه چیزی که
 * قفل‌شده بودند اینجا برای اولین بار روی یک جریان واقعی امتحان می‌شوند:
 *
 *   ۱) ارز، ویژگی **ردیف** است نه سطح درخت — یک سند با دو ارز
 *   ۲) طرف‌حساب، تفصیلی **شناور** است — سازنده و کمیسیون‌بگیر روی **یک** حساب
 *      معین (۲۱۰۱) می‌نشینند و فقط با تفصیلی از هم جدا می‌شوند
 *   ۳) یک رویداد کسب‌وکاری = **یک سند** (هستهٔ قدیمی چهار سند جدا می‌زد)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, DEFAULT_DATE, resetBusinessData,
} from '../helpers/gl';
import { postInvoice, CODES } from '../../src/modules/ledger/adapters/invoice';
import { reverse } from '../../src/modules/ledger/poster';
import { fromLegacyAmount, fromLegacyRate } from '../../src/modules/ledger/legacy-amounts';

let fy: { id: string };

const D = (v: number | string) => new Prisma.Decimal(v);

/** شناسه‌های یکتا و قطعی — `shortCode` مشتری فقط سه کاراکتر جا دارد */
let seq = 0;
const nextId = () => String(++seq).padStart(2, '0');

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl();
  await resetBusinessData();
  await gl.invoiceItem.deleteMany({});
  await gl.invoice.deleteMany({});
  await gl.projectCommission.deleteMany({});
  await gl.selectedPrice.deleteMany({});
  await gl.part.deleteMany({});
  await gl.project.deleteMany({});
  await gl.commissionAgent.deleteMany({});
  await gl.producer.deleteMany({});
  await gl.customer.deleteMany({});
  fy = await makeFiscalYear();
});

/**
 * فاکتور واقع‌نما: فروش دلاری با مالیات، بهای تمام‌شدهٔ یوآنی از یک سازنده،
 * کمیسیون درصدی، و پیش‌پرداخت دلاری.
 */
async function buildInvoice(opts: { withCommission?: boolean; withAdvance?: boolean; currency?: 'USD' | 'IRR'; advanceIn?: 'USD' | 'IRR' } = {}) {
  const cur = opts.currency ?? 'USD';
  const id = nextId();
  const customer = await gl.customer.create({ data: { name: 'احترامیان', shortCode: `C${id}` } });
  const producer = await gl.producer.create({ data: { name: 'Sun' } });
  const project = await gl.project.create({
    data: { code: `P-${id}`, customerId: customer.id } as any,
  });

  // دو قطعه از یک سازنده، هر دو به یوآن ⇒ باید در یک ردیف گروه شوند
  const mkPart = async (name: string, qty: number, unitCny: number) => {
    const part = await gl.part.create({ data: { projectId: project.id, name, quantity: qty } as any });
    await gl.selectedPrice.create({
      data: {
        partId: part.id, producerId: producer.id,
        amount: D(unitCny), currency: 'CNY', rateToIRR: D(14_000), rateAt: DEFAULT_DATE,
      } as any,
    });
    return part;
  };
  const partA = await mkPart('قطعه الف', 2, 300);
  const partB = await mkPart('قطعه ب', 1, 400);

  const isIRR = cur === 'IRR';
  const total = isIRR ? D(165_000_000) : D('1650.00');
  const vat = isIRR ? D(15_000_000) : D('150.00');
  const rate = isIRR ? D(1) : D(100_000);

  const invoice = await gl.invoice.create({
    data: {
      projectId: project.id,
      versionCode: `INV-${id}`,
      status: 'APPROVED',
      confirmedAt: DEFAULT_DATE,
      totalAmount: total, totalCurrency: cur, totalRateToIRR: rate,
      hasVat: true, vatAmount: vat,
      ...(opts.withAdvance
        ? (() => {
            // پیش‌پرداخت می‌تواند به ارزی غیر از ارز فاکتور باشد —
            // مشتری ایرانی معمولاً بیعانهٔ فاکتور دلاری را تومانی می‌دهد
            const ac = opts.advanceIn ?? cur;
            return ac === 'IRR'
              ? { advanceAmount: D(50_000_000), advanceCurrency: 'IRR', advanceRateToIRR: D(1) }
              : { advanceAmount: D('500.00'), advanceCurrency: 'USD', advanceRateToIRR: D(100_000) };
          })()
        : {}),
    } as any,
  });

  for (const p of [partA, partB]) {
    const unit = p.id === partA.id ? 300 : 400;
    await gl.invoiceItem.create({
      data: {
        invoiceId: invoice.id, partId: p.id,
        costAmount: D(unit), costCurrency: 'CNY', costRateToIRR: D(14_000),
        saleAmount: total, saleCurrency: cur, saleRateToIRR: rate, saleRateAt: DEFAULT_DATE,
      } as any,
    });
  }

  if (opts.withCommission) {
    const agent = await gl.commissionAgent.create({ data: { name: 'کمیسیون‌بگیر الف' } });
    await gl.projectCommission.create({
      data: { projectId: project.id, agentId: agent.id, percentage: D(5) } as any,
    });
  }

  return { invoice, customer, producer, project };
}

const post = (invoiceId: string) =>
  gl.$transaction((tx) => postInvoice(tx, invoiceId, { fiscalYearId: fy.id }), { timeout: 60_000 });

describe('فاکتور واقعی از هستهٔ جدید', () => {
  it('کل فاکتور یک سند تراز می‌شود، نه چهار سند', async () => {
    const { invoice } = await buildInvoice({ withCommission: true, withAdvance: true });
    const res = await post(invoice.id);

    expect(res.posted).toBe(true);
    expect(await gl.glEntry.count()).toBe(1);           // ← هستهٔ قدیمی اینجا ۴ سند می‌زد

    const lines = await gl.glLine.findMany({ where: { entryId: res.entry.id } });
    // ۳ فروش + ۲ سازنده + ۲ کمیسیون + ۲ پیش‌پرداخت
    expect(lines).toHaveLength(9);

    const dr = lines.reduce((s, l) => s + l.debitBase, 0n);
    const cr = lines.reduce((s, l) => s + l.creditBase, 0n);
    expect(dr).toBe(cr);
  });

  it('مبالغ به ریالِ صحیح درست ترجمه می‌شوند', async () => {
    const { invoice } = await buildInvoice({ withCommission: true, withAdvance: true });
    const res = await post(invoice.id);
    const lines = await gl.glLine.findMany({
      where: { entryId: res.entry.id },
      include: { account: { select: { code: true } } },
    });

    const byCode = (code: string) => lines.filter((l) => l.account.code === code);

    // ۱۶۵۰٫۰۰ دلار × ۱۰۰٬۰۰۰ تومان = ۱۶۵٬۰۰۰٬۰۰۰ تومان = ۱٬۶۵۰٬۰۰۰٬۰۰۰ ریال
    const ar = byCode(CODES.receivable).find((l) => l.debitBase > 0n)!;
    expect(ar.debit).toBe(165_000n);                    // به سنت
    expect(ar.debitBase).toBe(1_650_000_000n);          // به ریال

    // خالص فروش = کل − مالیات
    expect(byCode(CODES.sales)[0].creditBase).toBe(1_500_000_000n);
    expect(byCode(CODES.vatPayable)[0].creditBase).toBe(150_000_000n);

    // ۲×۳۰۰ + ۱×۴۰۰ = ۱۰۰۰ یوآن × ۱۴٬۰۰۰ تومان = ۱۴۰٬۰۰۰٬۰۰۰ ریال
    const cogs = byCode(CODES.cogs)[0];
    expect(cogs.currencyCode).toBe('CNY');
    expect(cogs.debit).toBe(100_000n);                  // به فِن
    expect(cogs.debitBase).toBe(140_000_000n);

    // کمیسیون ۵٪ از ۱۶۵۰ = ۸۲٫۵۰ دلار
    expect(byCode(CODES.commission)[0].debit).toBe(8_250n);
  });

  it('یک سند، دو ارز — ارز ویژگی ردیف است نه سطح درخت', async () => {
    const { invoice } = await buildInvoice();
    const res = await post(invoice.id);
    const lines = await gl.glLine.findMany({ where: { entryId: res.entry.id } });

    // فروش دلاری و بهای تمام‌شدهٔ یوآنی، در **یک** سند
    expect(new Set(lines.map((l) => l.currencyCode))).toEqual(new Set(['USD', 'CNY']));
    expect(lines.reduce((s, l) => s + l.debitBase - l.creditBase, 0n)).toBe(0n);
  });

  it('بیعانهٔ تومانی روی فاکتور دلاری، دو موضع ارزی جدا روی همان مشتری می‌سازد', async () => {
    // مشتری ایرانی بیعانهٔ فاکتور دلاری را تومانی می‌دهد. بیعانه **به ارز خودش**
    // به حساب مشتری می‌نشیند، نه اینکه به دلار تبدیل شود.
    //
    // نتیجه: مشتری همزمان ۱۶۵۰ دلار بدهکار است و ۵۰ میلیون تومان بستانکار.
    // خالص‌کردنشان یک رویداد **تسویه** است با تسعیر محقق — کار فاز ۴، نه فاکتور.
    // همین رفتار در هستهٔ قدیمی هم هست؛ آداپتور عمداً از آن پیروی می‌کند.
    const { invoice } = await buildInvoice({ advanceIn: 'IRR', withAdvance: true });
    const res = await post(invoice.id);
    const lines = await gl.glLine.findMany({ where: { entryId: res.entry.id } });

    expect(new Set(lines.map((l) => l.currencyCode))).toEqual(new Set(['USD', 'CNY', 'IRR']));

    const ar = await accountByCode(CODES.receivable);
    const sub = await gl.glSubsidiary.findFirstOrThrow({ where: { refType: 'Customer' } });
    const positions = await gl.$queryRaw<{ currencyCode: string; bal: bigint }[]>`
      SELECT l."currencyCode", (SUM(l.debit) - SUM(l.credit))::bigint AS bal
      FROM "GlLine" l
      WHERE l."accountId" = ${ar.id} AND l."subsidiaryId" = ${sub.id}
      GROUP BY l."currencyCode" ORDER BY l."currencyCode"
    `;
    expect(positions.map((p) => p.currencyCode)).toEqual(['IRR', 'USD']);
    expect(BigInt(positions[0].bal)).toBe(-500_000_000n);   // ۵۰ میلیون تومان بستانکار، به ریال
    expect(BigInt(positions[1].bal)).toBe(165_000n);        // ۱۶۵۰ دلار بدهکار، به سنت

    // و سند همچنان به ارز پایه تراز است
    expect(lines.reduce((s, l) => s + l.debitBase - l.creditBase, 0n)).toBe(0n);
  });

  it('سازنده و کمیسیون‌بگیر روی یک معین می‌نشینند و با تفصیلی جدا می‌شوند', async () => {
    const { invoice, producer } = await buildInvoice({ withCommission: true });
    const res = await post(invoice.id);

    const payable = await accountByCode(CODES.payable);
    const lines = await gl.glLine.findMany({
      where: { entryId: res.entry.id, accountId: payable.id },
      include: { subsidiary: true },
    });

    // هر دو روی ۲۱۰۱ — بدون تکثیر گره در درخت کدینگ
    expect(lines).toHaveLength(2);
    const kinds = lines.map((l) => l.subsidiary!.kind).sort();
    expect(kinds).toEqual(['AGENT', 'PRODUCER']);

    const prodLine = lines.find((l) => l.subsidiary!.kind === 'PRODUCER')!;
    expect(prodLine.subsidiary!.refId).toBe(producer.id);
    expect(prodLine.subsidiary!.name).toBe('Sun');
  });

  it('یک مشتری با دو ارز = یک تفصیلی، دو موضع ارزی', async () => {
    // این همان تصمیمی است که طراحی قبلی («کیف پول به‌ازای هر ارز») را برگرداند
    const a = await buildInvoice({ currency: 'USD' });
    await post(a.invoice.id);

    // فاکتور دوم برای همان مشتری، این بار ریالی
    const invoice2 = await gl.invoice.create({
      data: {
        projectId: a.project.id, versionCode: 'INV-IRR-1', status: 'APPROVED', confirmedAt: DEFAULT_DATE,
        totalAmount: D(30_000_000), totalCurrency: 'IRR', totalRateToIRR: D(1),
        hasVat: false,
      } as any,
    });
    await post(invoice2.id);

    const subs = await gl.glSubsidiary.findMany({ where: { refType: 'Customer' } });
    expect(subs).toHaveLength(1);                      // ← یک تفصیلی، نه دو کیف پول

    const ar = await accountByCode(CODES.receivable);
    const rows = await gl.$queryRaw<{ currencyCode: string; bal: bigint }[]>`
      SELECT l."currencyCode", (SUM(l.debit) - SUM(l.credit))::bigint AS bal
      FROM "GlLine" l
      WHERE l."accountId" = ${ar.id} AND l."subsidiaryId" = ${subs[0].id}
      GROUP BY l."currencyCode" ORDER BY l."currencyCode"
    `;
    // هر ارز موضع خودش را نگه می‌دارد و خالص‌سازی نمی‌شود
    expect(rows.map((r) => r.currencyCode)).toEqual(['IRR', 'USD']);
    expect(BigInt(rows.find((r) => r.currencyCode === 'USD')!.bal)).toBe(165_000n);
    expect(BigInt(rows.find((r) => r.currencyCode === 'IRR')!.bal)).toBe(300_000_000n);
  });

  it('ثبت دوباره سند تکراری نمی‌سازد', async () => {
    const { invoice } = await buildInvoice();
    await post(invoice.id);
    const second = await post(invoice.id);

    expect(second.posted).toBe(false);
    expect(await gl.glEntry.count()).toBe(1);
  });

  it('ابطال فاکتور یک سند برگشتی می‌زند و همه‌چیز صفر می‌شود', async () => {
    const { invoice } = await buildInvoice({ withCommission: true, withAdvance: true });
    const res = await post(invoice.id);

    await gl.$transaction((tx) => reverse(tx, res.entry.id, { reason: 'ابطال فاکتور' }), { timeout: 60_000 });

    // یک سند برگشتی، نه چهارتا
    expect(await gl.glEntry.count()).toBe(2);

    const rows = await gl.$queryRaw<{ bal: bigint }[]>`
      SELECT COALESCE(SUM("debitBase") - SUM("creditBase"), 0)::bigint AS bal FROM "GlLine"
    `;
    expect(BigInt(rows[0].bal)).toBe(0n);

    // و هیچ ماندهٔ باقی‌مانده‌ای روی هیچ حسابی نیست
    const perAccount = await gl.$queryRaw<{ bal: bigint }[]>`
      SELECT (SUM("debitBase") - SUM("creditBase"))::bigint AS bal
      FROM "GlLine" GROUP BY "accountId", "subsidiaryId", "currencyCode"
      HAVING SUM("debitBase") - SUM("creditBase") <> 0
    `;
    expect(perAccount).toHaveLength(0);
  });

  it('فاکتور بدون مبلغ سند نمی‌گیرد', async () => {
    const { project } = await buildInvoice();
    const draft = await gl.invoice.create({
      data: { projectId: project.id, versionCode: 'INV-DRAFT', status: 'DRAFT' } as any,
    });
    await expect(post(draft.id)).rejects.toThrow(/مبلغ، ارز یا نرخ/);
  });

  it('ممیزی ب۵: درآمد و بهای تمام‌شده به مرکز هزینهٔ پروژه برچسب می‌خورند', async () => {
    const { invoice, project } = await buildInvoice();
    await post(invoice.id);

    const cc = await gl.glCostCenter.findUniqueOrThrow({ where: { code: `9.${project.code}` } });
    const lines = await gl.glLine.findMany({
      where: { entry: { sourceId: invoice.id } },
      include: { account: { select: { code: true } } },
    });
    const sales = lines.find((l) => l.account.code === CODES.sales)!;
    const cogs = lines.find((l) => l.account.code === CODES.cogs)!;
    expect(sales.costCenterId).toBe(cc.id);
    expect(cogs.costCenterId).toBe(cc.id);

    const { projectProfitability } = await import('../../src/modules/ledger/reports/statements');
    const pp = await projectProfitability(gl);
    /**
     * ⚠️ کد تغییر کرد: گزارش دیگر کدِ **مرکز سایه** (`9.<کد پروژه>`) را
     * برنمی‌گرداند بلکه کدِ **خودِ پروژه** را می‌دهد. آداپتور فاکتور هنوز
     * مرکز سایه می‌زند و گزارش آن را در زمان خواندن ترجمه می‌کند — پس
     * ردیف همان است، فقط با نام درست.
     */
    const row = pp.projects.find((p) => p.code === project.code)!;
    // ۱۶۵۰ دلار − ۱۵۰ مالیات = ۱۵۰۰ دلار @ نرخِ ریالیِ ۱٬۰۰۰٬۰۰۰ (۱۰۰٬۰۰۰ تومان ×۱۰)
    expect(row.revenue).toBe(1_500_000_000n);
    expect(row.cogs).toBeGreaterThan(0n);
    expect(row.netProfit).toBe(row.revenue - row.cogs - row.otherExpense);
    expect(row.grossProfit).toBe(row.revenue - row.cogs);
  });
});

describe('پل واحدها بین دو هسته', () => {
  it('تومان اعشاری به ریال صحیح، بدون گم‌شدن رقم', () => {
    // همان مقدار واقعی که در دفتر xfab.ir هست
    expect(fromLegacyAmount(D('432108.4335'), 'IRR', 0)).toBe(4_321_084n);
    expect(fromLegacyAmount(D('16050050'), 'IRR', 0)).toBe(160_500_500n);
  });

  it('ارز خارجی به کوچک‌ترین واحد خودش', () => {
    expect(fromLegacyAmount(D('1650.00'), 'USD', 2)).toBe(165_000n);
    expect(fromLegacyAmount(D('63'), 'CNY', 2)).toBe(6_300n);
  });

  it('نرخ تومانی به نرخ ریالی', () => {
    // ۲۸۶۱۶٫۵۶۴۱۸۹ تومان به‌ازای هر یوآن ⇒ ۲۸۶۱۶۵٫۶۴۱۸۹ ریال
    expect(fromLegacyRate(D('28616.5641892286')).scaled).toBe(2_861_656_418_922_860n);
  });

  it('نرخ فراتر از ده رقم اعشار گرد می‌شود — همان دقتی که ستون نگه می‌دارد', () => {
    // ستون Decimal(24,10) است؛ رقم یازدهم جا ندارد و گرد می‌شود.
    // روی نرخی در حد ۲۸٬۰۰۰، این یعنی خطای نسبی حدود ۱e-۱۵ — بی‌اثر.
    const r = fromLegacyRate(D('28616.56418922862'));
    expect(r.scaled).toBe(2_861_656_418_922_860n);
  });
});
