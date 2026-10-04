/**
 * فاز ۳ — تفصیلی شناور و مراکز هزینه.
 *
 * دو بُعد مستقل و عمود بر درخت کدینگ. آنچه اینجا سنجیده می‌شود:
 *
 *   • تفصیلی از رکورد کسب‌وکاری مشتق می‌شود و کپی نمی‌شود
 *   • کد تفصیلی معنادار است (بلوک به تفکیک نوع)
 *   • یک طرف‌حساب زیر چند معین و چند ارز، همچنان **یک** تفصیلی است
 *   • مرکز هزینه بُعد جداست و روی سود و زیان تفکیک می‌دهد
 *   • تطبیق کنترلی با معین تفصیلی نمی‌تواند منحرف شود
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, DEFAULT_DATE, D, expectRejects, resetBusinessData,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import {
  ensureSubsidiary, createStandalone, backfillSubsidiaries,
  subsidiaryPositions, subsidiaryLedger, KIND_BLOCKS,
} from '../../src/modules/ledger/subsidiary';
import {
  ensureDefaultCostCenters, createCostCenter, ensureProjectCostCenter,
  costCenterSubtree, costCenterTotals, CostCenterError,
} from '../../src/modules/ledger/costcenter';
import { integrityCheck } from '../../src/modules/ledger/integrity';

let fy: { id: string };
let ar: { id: string };
let payable: { id: string };
let sales: { id: string };
let cash: { id: string };
let payrollAcc: { id: string };

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
  ar = await accountByCode('1104');
  payable = await accountByCode('2101');
  sales = await accountByCode('4101');
  cash = await accountByCode('110101');
  payrollAcc = await accountByCode('6101');
}, 180_000);

afterAll(async () => { await gl.$disconnect(); });

beforeEach(async () => {
  await resetGl();
  await resetBusinessData();
  await gl.projectCommission.deleteMany({});
  await gl.selectedPrice.deleteMany({});
  await gl.part.deleteMany({});
  await gl.project.deleteMany({});
  await gl.customer.deleteMany({});
  await gl.producer.deleteMany({});
  await gl.supplier.deleteMany({});
  await gl.shippingCompany.deleteMany({});
  await gl.exchange.deleteMany({});
  await gl.commissionAgent.deleteMany({});
  fy = await makeFiscalYear();
});

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });

// ═══════════════════════════════════════════════════════════════
describe('تفصیلی شناور', () => {
  it('کد از بلوک نوع خودش گرفته می‌شود', async () => {
    const c = await gl.customer.create({ data: { name: 'مشتری الف', shortCode: 'AA1' } });
    const p = await gl.producer.create({ data: { name: 'سازندهٔ الف' } });

    const cs = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
    const ps = await tx((t) => ensureSubsidiary(t, 'PRODUCER', 'Producer', p.id, p.name));

    expect(Number(cs.code)).toBeGreaterThan(KIND_BLOCKS.CUSTOMER);
    expect(Number(cs.code)).toBeLessThan(KIND_BLOCKS.CUSTOMER + 1000);
    expect(Number(ps.code)).toBeGreaterThan(KIND_BLOCKS.PRODUCER);
    // با دیدن کد می‌شود فهمید طرف‌حساب از چه جنسی است
    expect(cs.code).not.toBe(ps.code);
  });

  it('کدها در هر بلوک پشت سر هم می‌روند', async () => {
    const codes: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const c = await gl.customer.create({ data: { name: `مشتری ${i}`, shortCode: `B${i}${i}` } });
      const s = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
      codes.push(s.code);
    }
    expect(codes).toEqual(['1001', '1002', '1003']);
  });

  it('فراخوانی دوباره تفصیلی تکراری نمی‌سازد', async () => {
    const c = await gl.customer.create({ data: { name: 'مشتری الف', shortCode: 'CC1' } });
    const a = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
    const b = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));

    expect(b.id).toBe(a.id);
    expect(await gl.glSubsidiary.count()).toBe(1);
  });

  it('تغییر نام طرف‌حساب به تفصیلی سرایت می‌کند', async () => {
    const c = await gl.customer.create({ data: { name: 'نام قدیم', shortCode: 'DD1' } });
    await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, 'نام قدیم'));

    await gl.customer.update({ where: { id: c.id }, data: { name: 'نام جدید' } });
    const after = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, 'نام جدید'));

    expect(after.name).toBe('نام جدید');
    expect(await gl.glSubsidiary.count()).toBe(1);   // نه یکی تازه
  });

  it('پرکردن از داده‌های موجود، همهٔ انواع طرف‌حساب را پوشش می‌دهد', async () => {
    await gl.customer.create({ data: { name: 'مشتری', shortCode: 'EE1' } });
    await gl.producer.create({ data: { name: 'سازنده' } });
    await gl.supplier.create({ data: { name: 'تأمین‌کننده' } as any });
    await gl.shippingCompany.create({ data: { name: 'شرکت حمل' } as any });
    await gl.exchange.create({ data: { name: 'صرافی' } as any });
    await gl.commissionAgent.create({ data: { name: 'کمیسیون‌بگیر' } });

    const res = await tx((t) => backfillSubsidiaries(t));
    expect(res.created).toBe(6);
    expect(res.total).toBe(6);

    const kinds = (await gl.glSubsidiary.findMany({ select: { kind: true } })).map((s) => s.kind).sort();
    expect(kinds).toEqual(['AGENT', 'CARRIER', 'CUSTOMER', 'EXCHANGE', 'PRODUCER', 'SUPPLIER']);

    // اجرای دوباره چیزی نمی‌سازد
    const again = await tx((t) => backfillSubsidiaries(t));
    expect(again.created).toBe(0);
  });

  it('تفصیلی مستقل بدون رکورد کسب‌وکاری هم ساخته می‌شود', async () => {
    const s = await tx((t) => createStandalone(t, 'OTHER', 'متفرقه'));
    expect(s.refType).toBeNull();
    expect(Number(s.code)).toBeGreaterThan(KIND_BLOCKS.OTHER);
  });

  it('یک طرف‌حساب زیر دو معین و دو ارز — همچنان یک تفصیلی', async () => {
    const c = await gl.customer.create({ data: { name: 'احترامیان', shortCode: 'FF1' } });
    const sub = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));

    // طلب دلاری و پیش‌دریافت ریالی — دو معین متفاوت
    const prepaid = await accountByCode('2103');
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش و پیش‌دریافت',
      lines: [
        { accountId: ar.id, subsidiaryId: sub.id, currencyCode: 'USD', debit: 100_000n, rate: '1000000' },
        { accountId: sales.id, currencyCode: 'USD', credit: 100_000n, rate: '1000000' },
        { accountId: cash.id, currencyCode: 'IRR', debit: 500_000_000n },
        { accountId: prepaid.id, subsidiaryId: sub.id, currencyCode: 'IRR', credit: 500_000_000n },
      ],
    }));

    expect(await gl.glSubsidiary.count()).toBe(1);

    const positions = await subsidiaryPositions(gl, sub.id);
    expect(positions).toHaveLength(2);
    expect(positions.map((p) => `${p.code}/${p.currencyCode}`).sort())
      .toEqual(['1104/USD', '2103/IRR']);
  });

  it('دفتر تفصیلی یک معین، همهٔ طرف‌حساب‌هایش را با مانده می‌دهد', async () => {
    const p1 = await gl.producer.create({ data: { name: 'Sun' } });
    const p2 = await gl.producer.create({ data: { name: 'Amy' } });
    const s1 = await tx((t) => ensureSubsidiary(t, 'PRODUCER', 'Producer', p1.id, p1.name));
    const s2 = await tx((t) => ensureSubsidiary(t, 'PRODUCER', 'Producer', p2.id, p2.name));

    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'خرید از دو سازنده',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 300_000_000n },
        { accountId: payable.id, subsidiaryId: s1.id, currencyCode: 'IRR', credit: 100_000_000n },
        { accountId: payable.id, subsidiaryId: s2.id, currencyCode: 'IRR', credit: 200_000_000n },
      ],
    }));

    const ledger = await subsidiaryLedger(gl, '2101');
    expect(ledger).toHaveLength(2);
    const byName = Object.fromEntries(ledger.map((r) => [r.name, BigInt(r.balanceBase)]));
    expect(byName.Sun).toBe(-100_000_000n);
    expect(byName.Amy).toBe(-200_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('مراکز هزینه', () => {
  beforeEach(async () => {
    await gl.glCostCenter.deleteMany({});
    await tx((t) => ensureDefaultCostCenters(t));
  });

  it('درخت پیش‌فرض ساخته می‌شود', async () => {
    const all = await gl.glCostCenter.findMany({ orderBy: { code: 'asc' } });
    expect(all.map((c) => c.code)).toEqual(['1', '2', '3', '9']);
  });

  it('والدی که فرزند می‌گیرد دیگر سند نمی‌پذیرد', async () => {
    await tx((t) => createCostCenter(t, { code: '1.1', name: 'خط تولید الف', parentCode: '1' }));
    const parent = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '1' } });
    expect(parent.isPostable).toBe(false);
  });

  it('والدی که گردش دارد به سرگروه تبدیل نمی‌شود', async () => {
    const admin = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '3' } });
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'حقوق اداری',
      lines: [
        { accountId: payrollAcc.id, costCenterId: admin.id, currencyCode: 'IRR', debit: 50_000_000n },
        { accountId: cash.id, currencyCode: 'IRR', credit: 50_000_000n },
      ],
    }));

    await expectRejects(
      () => tx((t) => createCostCenter(t, { code: '3.1', name: 'مالی', parentCode: '3' })),
      /گردش دارد/,
    );
  });

  it('مرکز هزینهٔ پروژه زیر سرگروه پروژه‌ها می‌نشیند', async () => {
    const c = await gl.customer.create({ data: { name: 'مشتری', shortCode: 'GG1' } });
    const project = await gl.project.create({ data: { code: 'PRJ-7', customerId: c.id } as any });

    const cc = await tx((t) => ensureProjectCostCenter(t, project.id));
    expect(cc.code).toBe('9.PRJ-7');

    const parent = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '9' } });
    expect(cc.parentId).toBe(parent.id);

    // دوباره صدا زدن، تکراری نمی‌سازد
    const again = await tx((t) => ensureProjectCostCenter(t, project.id));
    expect(again.id).toBe(cc.id);
  });

  it('زیردرخت شامل خود گره و همهٔ نوادگان است', async () => {
    await tx((t) => createCostCenter(t, { code: '1.1', name: 'خط الف', parentCode: '1' }));
    await tx((t) => createCostCenter(t, { code: '1.1.1', name: 'شیفت شب', parentCode: '1.1' }));

    const root = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '1' } });
    const subtree = await costCenterSubtree(gl, root.id);
    expect(subtree).toHaveLength(3);
  });

  it('سود و زیان به تفکیک مرکز هزینه جدا می‌شود', async () => {
    const prod = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '1' } });
    const admin = await gl.glCostCenter.findUniqueOrThrow({ where: { code: '3' } });

    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'حقوق دو واحد',
      lines: [
        { accountId: payrollAcc.id, costCenterId: prod.id, currencyCode: 'IRR', debit: 70_000_000n },
        { accountId: payrollAcc.id, costCenterId: admin.id, currencyCode: 'IRR', debit: 30_000_000n },
        { accountId: cash.id, currencyCode: 'IRR', credit: 100_000_000n },
      ],
    }));

    const totals = await costCenterTotals(gl);
    const byCode = Object.fromEntries(totals.map((t) => [t.code, BigInt(t.totalBase)]));
    expect(byCode['1']).toBe(70_000_000n);
    expect(byCode['3']).toBe(30_000_000n);
  });

  it('هزینهٔ بدون مرکز، زیر «تخصیص‌نیافته» دیده می‌شود نه اینکه گم شود', async () => {
    const general = await accountByCode('6201');   // مرکز هزینه اجباری ندارد
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'هزینهٔ عمومی',
      lines: [
        { accountId: general.id, currencyCode: 'IRR', debit: 20_000_000n },
        { accountId: cash.id, currencyCode: 'IRR', credit: 20_000_000n },
      ],
    }));

    const totals = await costCenterTotals(gl);
    const unassigned = totals.find((t) => t.costCenterId === null);
    expect(unassigned).toBeDefined();
    expect(BigInt(unassigned!.totalBase)).toBe(20_000_000n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('سلامت دفاتر', () => {
  it('دفتر سالم ⇒ ok', async () => {
    const c = await gl.customer.create({ data: { name: 'مشتری', shortCode: 'HH1' } });
    const sub = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));

    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش',
      lines: [
        { accountId: ar.id, subsidiaryId: sub.id, currencyCode: 'IRR', debit: 10_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 10_000_000n },
      ],
    }));

    const report = await integrityCheck(gl);
    expect(report.ok).toBe(true);
    expect(report.checked.entries).toBe(1);
  });

  it('ماندهٔ کنترلی همیشه برابر جمع تفصیلی‌هاست — انحراف ممکن نیست', async () => {
    // نگرانی‌ای که طراحی قبلی («کیف پول به‌ازای هر ارز») را ساخته بود.
    // چون ماندهٔ ذخیره‌شده‌ای وجود ندارد، دو طرف از یک منبع محاسبه می‌شوند.
    const c = await gl.customer.create({ data: { name: 'مشتری', shortCode: 'II1' } });
    const sub = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));

    for (const amt of [10_000_000n, 25_000_000n, 7_500_000n]) {
      await tx((t) => post(t, {
        fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'فروش',
        lines: [
          { accountId: ar.id, subsidiaryId: sub.id, currencyCode: 'IRR', debit: amt },
          { accountId: sales.id, currencyCode: 'IRR', credit: amt },
        ],
      }));
    }

    const report = await integrityCheck(gl);
    expect(report.controlMismatch).toHaveLength(0);
  });

  it('تفصیلی یتیم (رکورد اصلی حذف‌شده) گزارش می‌شود', async () => {
    const c = await gl.customer.create({ data: { name: 'مشتری موقت', shortCode: 'JJ1' } });
    await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
    await gl.customer.delete({ where: { id: c.id } });

    const report = await integrityCheck(gl);
    expect(report.ok).toBe(false);
    expect(report.orphanSubsidiaries).toHaveLength(1);
    expect(report.orphanSubsidiaries[0].name).toBe('مشتری موقت');
  });

  it('شکاف در شمارهٔ سند گزارش می‌شود', async () => {
    const c = await gl.customer.create({ data: { name: 'مشتری', shortCode: 'KK1' } });
    const sub = await tx((t) => ensureSubsidiary(t, 'CUSTOMER', 'Customer', c.id, c.name));
    const mk = () => tx((t) => post(t, {
      fiscalYearId: fy.id, date: DEFAULT_DATE, description: 'سند',
      lines: [
        { accountId: ar.id, subsidiaryId: sub.id, currencyCode: 'IRR', debit: 1_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 1_000_000n },
      ],
    }));
    await mk();
    const second = await mk();
    await mk();

    // حذف مستقیم با دور زدن تریگر تغییرناپذیری — شبیه‌سازی دستکاری
    await gl.$executeRawUnsafe('ALTER TABLE "GlEntry" DISABLE TRIGGER gl_entry_transitions_trg');
    await gl.$executeRawUnsafe('ALTER TABLE "GlLine" DISABLE TRIGGER gl_line_immutable_trg');
    await gl.$executeRawUnsafe(`DELETE FROM "GlLine" WHERE "entryId" = '${second.id}'`);
    await gl.$executeRawUnsafe(`DELETE FROM "GlEntry" WHERE id = '${second.id}'`);
    await gl.$executeRawUnsafe('ALTER TABLE "GlEntry" ENABLE TRIGGER gl_entry_transitions_trg');
    await gl.$executeRawUnsafe('ALTER TABLE "GlLine" ENABLE TRIGGER gl_line_immutable_trg');

    const report = await integrityCheck(gl);
    expect(report.serialGaps).toHaveLength(1);
    expect(report.serialGaps[0].missing).toBe(2);
  });
});
