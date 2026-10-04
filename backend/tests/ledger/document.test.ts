/**
 * مدرک، فاکتور دستی، برگشت، پیوست، افتتاحیه و بُعد پروژه.
 *
 * انطباق با ALIP CORE SPEC: بند ۱۱ · ۱۸ · ۲۵-۲۷ · ۲۸ · ۳-۷ · ۳۰
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, makeCostCenter, accountByCode,
  D, resetBusinessData, expectRejects, makeSubsidiary,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import {
  createDocument, transitionDocument, createReturn, postOpeningBalance,
  nextDocumentNumber,
} from '../../src/modules/ledger/document';
import { trialBalance } from '../../src/modules/ledger/reports/ledgers';
import { projectProfitability } from '../../src/modules/ledger/reports/statements';

let fy: any, customer: any, supplier: any, project: any, cc: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

const bal = async (code: string): Promise<bigint> => {
  const rows = await gl.$queryRawUnsafe<{ b: bigint | null }[]>(
    `SELECT COALESCE(SUM(l."debitBase" - l."creditBase"),0)::bigint AS b
     FROM "GlLine" l JOIN "GlEntry" e ON e.id=l."entryId" JOIN "GlAccount" a ON a.id=l."accountId"
     WHERE a.code = $1 AND e.status <> 'DRAFT'`, code);
  return rows[0]?.b ?? 0n;
};

beforeAll(async () => { await resetGl(); await seedGlChart(); }, 180_000);
afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await gl.glAttachment.deleteMany({});
  await gl.glDocumentTransition.deleteMany({});
  await gl.glDocumentLine.deleteMany({});
  await gl.glDocument.deleteMany({});
  await resetGl(); await resetBusinessData();
  await gl.project.deleteMany({});
  await gl.customer.deleteMany({});
  fy = await makeFiscalYear();
  customer = await makeSubsidiary('CUSTOMER', 'مشتری خدمات');
  supplier = await makeSubsidiary('SUPPLIER', 'تأمین‌کنندهٔ خدمات');
  cc = await makeCostCenter('81', 'اداری');
  const cust = await gl.customer.create({ data: { name: 'کارفرمای پروژه', shortCode: 'KP1' } });
  project = await gl.project.create({
    data: { code: 'PRJ-100', customerId: cust.id, description: 'پروژهٔ آزمون' },
  });
});

const serviceInvoice = (over: any = {}) => tx((t) => createDocument(t, {
  kind: 'SALES_INVOICE',
  date: D('2026-06-10'),
  subsidiaryId: customer.id,
  currencyCode: 'IRR',
  vatPercent: 10,
  description: 'فروش خدمات مشاوره',
  lines: [
    { description: 'مشاورهٔ فنی — تیر', amount: '6000000000', accountCode: '4102' },
    { description: 'بازدید کارگاه', amount: '4000000000', accountCode: '4102' },
  ],
  ...over,
}));

// ═══════════════════════════════════════════════════════════════
describe('بند ۲۷ — فاکتور فروش خدمات، بدون پروژه و بدون کالا', () => {
  it('ساخته می‌شود و جمع‌ها با مالیات درست است', async () => {
    const doc: any = await serviceInvoice();
    expect(doc.subtotal).toBe(10_000_000_000n);
    expect(doc.vatAmount).toBe(1_000_000_000n);
    expect(doc.total).toBe(11_000_000_000n);
    expect(doc.status).toBe('DRAFT');
    expect(doc.lines.length).toBe(2);
  });

  it('شمارهٔ مدرک یکتا و ترتیبی است', async () => {
    const a: any = await serviceInvoice();
    const b: any = await serviceInvoice();
    expect(a.number).toMatch(/^SI-\d{4}-0001$/);
    expect(b.number).toMatch(/^SI-\d{4}-0002$/);
    const next = await nextDocumentNumber(gl as any, 'SALES_INVOICE', D('2026-06-10'));
    expect(next).toMatch(/-0003$/);
  });

  it('خط بدون شرح یا با مبلغ صفر رد می‌شود', async () => {
    await expectRejects(() => serviceInvoice({ lines: [{ description: '  ', amount: '100', accountCode: '4102' }] }), /شرح/);
    await expectRejects(() => serviceInvoice({ lines: [{ description: 'x', amount: '0', accountCode: '4102' }] }), /بزرگ‌تر از صفر/);
  });

  it('فاکتور بدون طرف‌حساب رد می‌شود', async () => {
    await expectRejects(() => serviceInvoice({ subsidiaryId: null }), /طرف‌حساب/);
  });

  it('حساب سرگروه در خط مدرک رد می‌شود', async () => {
    await expectRejects(() => serviceInvoice({ lines: [{ description: 'x', amount: '100', accountCode: '41' }] }), /سرگروه/);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('بند ۳-۷ — چرخهٔ وضعیت', () => {
  it('پیش‌نویس ← ارسال ← تأیید ← ثبت', async () => {
    const doc: any = await serviceInvoice();
    for (const to of ['SUBMITTED', 'APPROVED', 'POSTED'] as const) {
      const r: any = await tx((t) => transitionDocument(t, { documentId: doc.id, to, byId: 'u1', byName: 'کاربر' }));
      expect(r.status).toBe(to);
    }
    const final = await gl.glDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(final.entryId).toBeTruthy();
    expect(final.submittedAt).toBeTruthy();
    expect(final.approvedAt).toBeTruthy();
    expect(final.postedAt).toBeTruthy();
  });

  it('پرش از تأیید به ثبت مجاز نیست', async () => {
    const doc: any = await serviceInvoice();
    await expectRejects(
      () => tx((t) => transitionDocument(t, { documentId: doc.id, to: 'POSTED' })),
      /مجاز نیست/,
    );
  });

  it('مدرک ثبت‌شده وضعیت پایانی دارد', async () => {
    const doc: any = await serviceInvoice();
    for (const to of ['SUBMITTED', 'APPROVED', 'POSTED'] as const) {
      await tx((t) => transitionDocument(t, { documentId: doc.id, to }));
    }
    await expectRejects(
      () => tx((t) => transitionDocument(t, { documentId: doc.id, to: 'CANCELLED' })),
      /پایانی/,
    );
  });

  it('ابطال با ثبت فرق دارد — مدرکِ ابطال‌شده سند نمی‌سازد', async () => {
    const doc: any = await serviceInvoice();
    const r: any = await tx((t) => transitionDocument(t, {
      documentId: doc.id, to: 'CANCELLED', note: 'مشتری منصرف شد',
    }));
    expect(r.status).toBe('CANCELLED');
    expect(r.entryId).toBeNull();
    expect(await gl.glEntry.count({ where: { sourceType: 'Document' } })).toBe(0);
  });

  it('هر گذار در تاریخچهٔ وضعیت می‌ماند', async () => {
    const doc: any = await serviceInvoice();
    await tx((t) => transitionDocument(t, { documentId: doc.id, to: 'SUBMITTED', byName: 'صدرا' }));
    await tx((t) => transitionDocument(t, { documentId: doc.id, to: 'APPROVED', byName: 'مدیر' }));
    const hist = await gl.glDocumentTransition.findMany({ where: { documentId: doc.id }, orderBy: { at: 'asc' } });
    expect(hist.map((h) => h.toState)).toEqual(['DRAFT', 'SUBMITTED', 'APPROVED']);
    expect(hist[2].byName).toBe('مدیر');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('بند ۲۶/۲۷ — اثر مالی درست است', () => {
  const postIt = async (doc: any) => {
    for (const to of ['SUBMITTED', 'APPROVED', 'POSTED'] as const) {
      await tx((t) => transitionDocument(t, { documentId: doc.id, to }));
    }
  };

  it('فاکتور فروش: دریافتنی بدهکار، درآمد و مالیات بستانکار', async () => {
    const doc: any = await serviceInvoice();
    await postIt(doc);
    expect(await bal('1104')).toBe(11_000_000_000n);
    expect(await bal('4102')).toBe(-10_000_000_000n);
    expect(await bal('2107')).toBe(-1_000_000_000n);
  });

  it('فاکتور خرید: هزینه و اعتبار مالیاتی بدهکار، پرداختنی بستانکار', async () => {
    const doc: any = await tx((t) => createDocument(t, {
      kind: 'PURCHASE_INVOICE', date: D('2026-06-12'), subsidiaryId: supplier.id,
      currencyCode: 'IRR', vatPercent: 10,
      lines: [{ description: 'خدمات حسابرسی', amount: '5000000000', accountCode: '6212' }],
    }));
    await postIt(doc);
    expect(await bal('6212')).toBe(5_000_000_000n);
    expect(await bal('1109')).toBe(500_000_000n);
    expect(await bal('2101')).toBe(-5_500_000_000n);
  });

  it('سند ساخته‌شده تراز است و به مدرک بند است', async () => {
    const doc: any = await serviceInvoice();
    await postIt(doc);
    const entry = await gl.glEntry.findFirstOrThrow({
      where: { sourceType: 'Document', sourceId: doc.id }, include: { lines: true },
    });
    const d = entry.lines.reduce((s, l) => s + l.debitBase, 0n);
    const c = entry.lines.reduce((s, l) => s + l.creditBase, 0n);
    expect(d).toBe(c);
    expect(entry.lines.length).toBe(4);   // دریافتنی + دو خط درآمد + مالیات
  });
});

// ═══════════════════════════════════════════════════════════════
describe('بند ۲۸ — بُعد پروژه روی ردیف سند', () => {
  const postIt = async (doc: any) => {
    for (const to of ['SUBMITTED', 'APPROVED', 'POSTED'] as const) {
      await tx((t) => transitionDocument(t, { documentId: doc.id, to }));
    }
  };

  it('پروژه و مرکز هزینه هم‌زمان روی یک ردیف می‌نشینند', async () => {
    const doc: any = await serviceInvoice({
      projectId: project.id, costCenterId: cc.id,
      lines: [{ description: 'کار پروژه', amount: '3000000000', accountCode: '4102' }],
      vatPercent: 0,
    });
    await postIt(doc);
    const line = await gl.glLine.findFirstOrThrow({
      where: { account: { code: '4102' }, entry: { sourceType: 'Document' } },
    });
    // ⚠️ همین که هر دو پر باشند، نقضِ مدلِ قبلی است: آنجا پروژه خودش را
    // در خانهٔ مرکز هزینه جا می‌کرد و یکی از دو بُعد قربانی می‌شد.
    expect(line.projectId).toBe(project.id);
    expect(line.costCenterId).toBe(cc.id);
  });

  it('یک فاکتور می‌تواند چند پروژه را پوشش دهد', async () => {
    const cust2 = await gl.customer.create({ data: { name: 'کارفرمای دوم', shortCode: 'KP2' } });
    const p2 = await gl.project.create({ data: { code: 'PRJ-200', customerId: cust2.id } });
    const doc: any = await serviceInvoice({
      vatPercent: 0,
      lines: [
        { description: 'پروژهٔ اول', amount: '1000000000', accountCode: '4102', projectId: project.id },
        { description: 'پروژهٔ دوم', amount: '2000000000', accountCode: '4102', projectId: p2.id },
      ],
    });
    await postIt(doc);
    const lines = await gl.glLine.findMany({
      where: { account: { code: '4102' }, entry: { sourceType: 'Document' } },
      orderBy: { lineNo: 'asc' },
    });
    expect(lines.map((l) => l.projectId).sort()).toEqual([project.id, p2.id].sort());
  });

  it('سند دستی هم پروژه می‌پذیرد', async () => {
    const cash = await accountByCode('110101');
    const sales = await accountByCode('4101');
    const e = await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-06-15'), description: 'سند دستی با پروژه',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 500_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 500_000_000n, projectId: project.id },
      ],
    }));
    const line = e.lines.find((l) => l.accountId === sales.id)!;
    expect(line.projectId).toBe(project.id);
  });

  it('سند برگشتی، بُعد پروژه را حفظ می‌کند', async () => {
    const doc: any = await serviceInvoice({
      projectId: project.id, vatPercent: 0,
      lines: [{ description: 'کار پروژه', amount: '1000000000', accountCode: '4102' }],
    });
    await postIt(doc);
    const entry = await gl.glEntry.findFirstOrThrow({ where: { sourceType: 'Document' } });
    const { reverse } = await import('../../src/modules/ledger/poster');
    const rev = await tx((t) => reverse(t, entry.id, { reason: 'آزمون' }));
    const line = rev.lines.find((l) => l.projectId)!;
    expect(line.projectId).toBe(project.id);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('بند ۲۵ — برگشت از فروش و خرید', () => {
  const postIt = async (doc: any) => {
    for (const to of ['SUBMITTED', 'APPROVED', 'POSTED'] as const) {
      await tx((t) => transitionDocument(t, { documentId: doc.id, to }));
    }
  };

  it('برگشت، اثر فاکتور را وارونه می‌کند', async () => {
    const inv: any = await serviceInvoice();
    await postIt(inv);
    expect(await bal('1104')).toBe(11_000_000_000n);

    const ret: any = await tx((t) => createReturn(t, inv.id, { date: D('2026-07-01') }));
    expect(ret.kind).toBe('SALES_RETURN');
    expect(ret.number).toMatch(/^SR-/);
    await postIt(ret);

    // فاکتور و برگشتش کامل خنثی می‌شوند
    expect(await bal('1104')).toBe(0n);
    expect(await bal('4102')).toBe(0n);
    expect(await bal('2107')).toBe(0n);
  });

  it('برگشت جزئی هم می‌شود', async () => {
    const inv: any = await serviceInvoice();
    await postIt(inv);
    const ret: any = await tx((t) => createReturn(t, inv.id, {
      date: D('2026-07-01'),
      lines: [{ description: 'برگشت بخشی', amount: '2000000000', accountCode: '4102' }],
    }));
    await postIt(ret);
    // ۱۱ میلیارد منهای ۲٫۲ میلیارد (با مالیات ۱۰٪)
    expect(await bal('1104')).toBe(8_800_000_000n);
  });

  it('فاکتور ثبت‌نشده برگشت نمی‌خورد', async () => {
    const inv: any = await serviceInvoice();
    await expectRejects(() => tx((t) => createReturn(t, inv.id, { date: D('2026-07-01') })), /ثبت‌شده/);
  });

  it('یک فاکتور دو بار برگشت نمی‌خورد', async () => {
    const inv: any = await serviceInvoice();
    await postIt(inv);
    await tx((t) => createReturn(t, inv.id, { date: D('2026-07-01') }));
    await expectRejects(() => tx((t) => createReturn(t, inv.id, { date: D('2026-07-02') })), /قبلاً برگشت/);
  });

  it('برگشت، فاکتور اصلی را دست نمی‌زند', async () => {
    const inv: any = await serviceInvoice();
    await postIt(inv);
    const ret: any = await tx((t) => createReturn(t, inv.id, { date: D('2026-07-01') }));
    await postIt(ret);
    const src = await gl.glDocument.findUniqueOrThrow({ where: { id: inv.id } });
    expect(src.status).toBe('POSTED');
    expect(src.total).toBe(11_000_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('بند ۱۸ — مانده افتتاحیه از مسیر کاربر', () => {
  const opening = (over: any = {}) => tx((t) => postOpeningBalance(t, {
    fiscalYearId: fy.id, date: D('2026-03-21'),
    lines: [
      { accountCode: '110101', currencyCode: 'IRR', debit: '5000000000' },
      { accountCode: '3101', currencyCode: 'IRR', credit: '5000000000' },
    ],
    ...over,
  }));

  it('سند افتتاحیه با نوع OPENING ثبت می‌شود', async () => {
    const e: any = await opening();
    expect(e.entryType).toBe('OPENING');
    expect(e.sourceType).toBe('OpeningBalance');
    expect(await bal('110101')).toBe(5_000_000_000n);
  });

  it('در تراز آزمایشی مثل بقیهٔ ثبت‌ها دیده می‌شود — سازوکار موازی نیست', async () => {
    await opening();
    const tb: any = await trialBalance(gl as any, { from: D('2026-03-21'), to: D('2027-03-20') }, 4);
    expect(String(tb.totals.closingDebit)).toBe(String(tb.totals.closingCredit));
    const cash = tb.rows.find((r: any) => r.code === '110101');
    expect(String(cash.closingDebit)).toBe('5000000000');
  });

  it('سند افتتاحیهٔ دوم در یک سال مالی رد می‌شود', async () => {
    await opening();
    await expectRejects(() => opening(), /از قبل سند افتتاحیه/);
  });

  it('ردیف ناتراز رد می‌شود', async () => {
    await expectRejects(() => opening({
      lines: [
        { accountCode: '110101', currencyCode: 'IRR', debit: '5000000000' },
        { accountCode: '3101', currencyCode: 'IRR', credit: '4000000000' },
      ],
    }), /تراز نیست/);
  });

  it('ردیفی که هم بدهکار دارد هم بستانکار رد می‌شود', async () => {
    await expectRejects(() => opening({
      lines: [
        { accountCode: '110101', currencyCode: 'IRR', debit: '100', credit: '100' },
        { accountCode: '3101', currencyCode: 'IRR', credit: '100' },
      ],
    }), /دقیقاً یکی/);
  });

  it('افتتاحیه هم بُعد پروژه می‌پذیرد', async () => {
    const e: any = await opening({
      lines: [
        { accountCode: '1104', subsidiaryId: customer.id, currencyCode: 'IRR', debit: '3000000000', projectId: project.id },
        { accountCode: '3101', currencyCode: 'IRR', credit: '3000000000' },
      ],
    });
    const line = e.lines.find((l: any) => l.projectId);
    expect(line.projectId).toBe(project.id);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('گزارش پروژه — بُعد واقعی و مرکز سایهٔ قدیمی با هم', () => {
  /**
   * ⚠️ چرا هر دو منبع لازم است: ردیف‌هایی که پیش از افزودن `projectId` ثبت
   * شده‌اند پروژه‌شان را در قالب مرکز هزینهٔ `9.<کد پروژه>` حمل می‌کنند، و
   * تریگر `gl_line_immutable` اجازهٔ مهاجرتشان را نمی‌دهد. پس گزارش باید
   * هر دو را ببیند، وگرنه تاریخِ پیش از این تغییر ناپدید می‌شود.
   */
  it('هزینهٔ ثبت‌شده روی مرکز سایه هم در سودآوری پروژه دیده می‌شود', async () => {
    const shadow = await makeCostCenter(`9.${project.code}`, `پروژهٔ ${project.code}`);
    const cash = await accountByCode('110101');
    const sales = await accountByCode('4101');
    const cogs = await accountByCode('5101');

    // سبک قدیمی: پروژه فقط در مرکز هزینه
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-05-01'), description: 'درآمد سبک قدیم',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 9_000_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 9_000_000_000n, costCenterId: shadow.id },
      ],
    }));
    // سبک تازه: بُعد واقعی
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-06-01'), description: 'هزینه سبک تازه',
      lines: [
        { accountId: cogs.id, currencyCode: 'IRR', debit: 4_000_000_000n, projectId: project.id },
        { accountId: cash.id, currencyCode: 'IRR', credit: 4_000_000_000n },
      ],
    }));

    const r: any = await projectProfitability(gl as any, {});
    const p = r.projects.find((x: any) => x.code === project.code);
    expect(p).toBeTruthy();
    expect(p.revenue).toBe(9_000_000_000n);      // از مرکز سایه
    expect(p.cogs).toBe(4_000_000_000n);         // از بُعد واقعی
    expect(p.netProfit).toBe(5_000_000_000n);
  });

  it('فیلتر پروژه در تراز آزمایشی هر دو منبع را می‌گیرد', async () => {
    const shadow = await makeCostCenter(`9.${project.code}`, `پروژهٔ ${project.code}`);
    const cash = await accountByCode('110101');
    const sales = await accountByCode('4101');

    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-05-01'), description: 'قدیم',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 1_000_000_000n, costCenterId: shadow.id },
      ],
    }));
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-06-01'), description: 'تازه',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 2_000_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 2_000_000_000n, projectId: project.id },
      ],
    }));
    // سندی بی‌ربط به پروژه — نباید در فیلتر بیاید
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-06-02'), description: 'بی‌پروژه',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 7_000_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 7_000_000_000n },
      ],
    }));

    const tb: any = await trialBalance(gl as any, {
      from: D('2026-03-21'), to: D('2027-03-20'), projectIds: [project.id],
    }, 4);
    const row = tb.rows.find((r: any) => r.code === '4101');
    // فقط ۱ + ۲ میلیارد، نه ۱۰
    expect(String(row.closingCredit)).toBe('3000000000');
  });
});
