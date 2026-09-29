/**
 * استهلاک و چک‌لیست پایان ماه — مرحلهٔ ۴ ه.
 *
 * دو نکتهٔ حساس: **ماهِ آخر باقی‌ماندهٔ گردکردن را می‌گیرد** (وگرنه دارایی هرگز
 * کاملاً مستهلک نمی‌شود)، و **ثبتِ دوبارهٔ یک دوره ممکن نیست** — که در روش
 * دستی رایج‌ترین اشتباه است.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, makeCostCenter, accountByCode,
  D, resetBusinessData, expectRejects,
} from '../helpers/gl';
import { post, createDraft } from '../../src/modules/ledger/poster';
import {
  upsertAsset, disposeAsset, schedule, listAssets, postDepreciation, monthlyAmount,
} from '../../src/modules/ledger/depreciation';
import { monthEndChecklist } from '../../src/modules/ledger/reports/monthend';

let fy: any, cash: any, sales: any, accum: any, depExp: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

const IN_SERVICE = D('2026-03-25');
/** n ماهِ ۳۰ روزه پس از بهره‌برداری */
const afterMonths = (n: number) => new Date(IN_SERVICE.getTime() + n * 30 * 86_400_000);

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
  accum = await accountByCode('1202'); depExp = await accountByCode('6205');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await gl.glDepreciationRun.deleteMany({});
  await gl.glFixedAsset.deleteMany({});
  await resetGl(); await resetBusinessData();
  fy = await makeFiscalYear();
});

const makeAsset = (over: any = {}) => tx((t) => upsertAsset(t, {
  code: 'FA-01', name: 'خودروی وانت',
  cost: 1_200_000_000n, salvage: 0n, usefulLifeMonths: 12,
  inServiceAt: IN_SERVICE, ...over,
}));

// ═══════════════════════════════════════════════════════════════
describe('محاسبهٔ سهم ماهانه', () => {
  it('تقسیم یکنواخت وقتی بدون باقی‌مانده است', () => {
    expect(monthlyAmount(1_200n, 0n, 12, 1)).toBe(100n);
    expect(monthlyAmount(1_200n, 0n, 12, 12)).toBe(100n);
  });

  it('ماهِ آخر باقی‌ماندهٔ گردکردن را می‌گیرد', () => {
    // ⚠️ ۱۰۰۰ ÷ ۳ = ۳۳۳ با باقی‌ماندهٔ ۱. اگر ماه آخر هم ۳۳۳ می‌شد، یک واحد
    // روی دفتر می‌ماند و دارایی هرگز کاملاً مستهلک نمی‌شد.
    expect(monthlyAmount(1_000n, 0n, 3, 1)).toBe(333n);
    expect(monthlyAmount(1_000n, 0n, 3, 2)).toBe(333n);
    expect(monthlyAmount(1_000n, 0n, 3, 3)).toBe(334n);
    const total = [1, 2, 3].reduce((s, i) => s + monthlyAmount(1_000n, 0n, 3, i), 0n);
    expect(total).toBe(1_000n);
  });

  it('ارزش اسقاط از پایه کم می‌شود', () => {
    const total = Array.from({ length: 10 }, (_, i) => monthlyAmount(1_000n, 200n, 10, i + 1))
      .reduce((s, x) => s + x, 0n);
    expect(total).toBe(800n);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ثبت دارایی', () => {
  it('جدول استهلاک، ماندهٔ دفتری را تا صفر می‌برد', async () => {
    await makeAsset();
    const s = await schedule(gl, 'FA-01');
    expect(s.rows).toHaveLength(12);
    expect(s.rows[11].bookValue).toBe('0');
    expect(s.rows.reduce((x, r) => x + BigInt(r.amount), 0n)).toBe(1_200_000_000n);
  });

  it('ارزش اسقاطِ بزرگ‌تر از بها رد می‌شود', async () => {
    await expectRejects(
      () => makeAsset({ salvage: 2_000_000_000n }),
      /کمتر از بهای تمام‌شده/,
    );
  });

  it('عمر مفید صفر رد می‌شود', async () => {
    await expectRejects(() => makeAsset({ usefulLifeMonths: 0 }), /دست‌کم یک ماه/);
  });

  it('پس از شروع استهلاک، مبنا قفل می‌شود', async () => {
    await makeAsset();
    await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(2) }));
    await expectRejects(
      () => makeAsset({ cost: 900_000_000n }),
      /دورهٔ استهلاکِ ثبت‌شده/,
    );
    // ولی نام و یادداشت هنوز عوض می‌شوند
    const ok = await makeAsset({ name: 'وانت — نام تازه' });
    expect(ok.name).toBe('وانت — نام تازه');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('ثبت استهلاک', () => {
  /**
   * ⚠️ ممیزی ب۶ — رفتار عمداً عوض شد.
   *
   * پیش‌تر همهٔ دوره‌های سررسیدشده در **یک** سند و به تاریخ اجرای دستور
   * بسته می‌شدند و همین تست آن را تثبیت می‌کرد. اما اگر کاربر سه ماه دیر
   * اجرا می‌کرد، هزینهٔ استهلاکِ سه ماه در ماه سوم می‌نشست و سود و زیانِ هر
   * چهار ماه غلط می‌شد. حالا هر ماه سند خودش را دارد، به تاریخ پایان همان
   * ماه شمسی.
   */
  it('هر ماه سند جدا می‌گیرد، به تاریخ پایان ماه شمسی', async () => {
    await makeAsset();
    const out: any = await tx((t) => postDepreciation(t, {
      fiscalYearId: fy.id, asOf: afterMonths(3),
    }));
    expect(out.posted).toBe(true);
    expect(out.periods).toBe(3);
    expect(out.total).toBe('300000000');
    expect(out.entry.entryType).toBe('ADJUSTING');
    expect(out.entry.sourceType).toBe('Depreciation');

    const posted = await gl.glEntry.findMany({
      where: { sourceType: 'Depreciation' }, orderBy: { date: 'asc' },
    });
    expect(posted.length).toBe(3);
    expect(out.months).toBe(3);

    // هیچ سندی به تاریخ اجرا نمی‌نشیند؛ همه پیش از آن و در ماه خودشان‌اند
    for (const e of posted) expect(e.date.getTime()).toBeLessThanOrEqual(afterMonths(3).getTime());
    // تاریخ‌ها یکتا و صعودی‌اند — یعنی واقعاً ماه‌به‌ماه تفکیک شده
    const days = posted.map((e) => e.date.getTime());
    expect(new Set(days).size).toBe(3);
    expect([...days].sort((a, b) => a - b)).toEqual(days);

    // جمع همچنان دقیقاً برابر کل استهلاک دوره است
    const lines = await gl.glLine.findMany({
      where: { entryId: { in: posted.map((e) => e.id) }, accountId: accum.id },
    });
    expect(lines.reduce((s, l) => s + l.credit, 0n)).toBe(300_000_000n);
  });

  it('اجرای دوباره در همان تاریخ چیزی ثبت نمی‌کند', async () => {
    await makeAsset();
    await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(3) }));
    const again = await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(3) }));
    expect(again.posted).toBe(false);
    expect((await schedule(gl, 'FA-01')).postedPeriods).toBe(3);
  });

  it('ماه بعد فقط همان ماه را اضافه می‌کند', async () => {
    await makeAsset();
    await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(3) }));
    const next: any = await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(4) }));
    expect(next.periods).toBe(1);
    expect((await schedule(gl, 'FA-01')).accumulated).toBe('400000000');
  });

  it('پس از پایان عمر مفید، چیزی ثبت نمی‌شود', async () => {
    await makeAsset();
    // ۱۲ ماه = پایان عمر مفید، و هنوز داخل سال مالی
    await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(12) }));
    const s = await schedule(gl, 'FA-01');
    expect(s.postedPeriods).toBe(12);
    expect(s.bookValue).toBe('0');

    const more = await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(12) }));
    expect(more.posted).toBe(false);
  });

  it('دارایی کنارگذاشته‌شده دیگر مستهلک نمی‌شود', async () => {
    await makeAsset();
    await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(2) }));
    await tx((t) => disposeAsset(t, 'FA-01', afterMonths(3)));
    const after = await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(6) }));
    expect(after.posted).toBe(false);
  });

  it('هزینه به مرکز هزینه می‌خورد ولی انباشته یک ردیف است', async () => {
    const cc = await makeCostCenter('81', 'اداری');
    await makeAsset({ costCenterCode: cc.code });
    const out: any = await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(2) }));

    const expLine = out.entry.lines.find((l: any) => l.accountId === depExp.id);
    const accLine = out.entry.lines.find((l: any) => l.accountId === accum.id);
    expect(expLine.costCenterId).toBe(cc.id);
    // حسابِ کاهندهٔ دارایی بُعدِ مرکز هزینه ندارد
    expect(accLine.costCenterId).toBeNull();
  });

  it('استهلاک انباشته ماندهٔ بستانکار می‌گیرد', async () => {
    await makeAsset();
    await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(3) }));
    const [row] = await gl.$queryRaw<{ amount: bigint }[]>`
      SELECT (SUM(l."creditBase") - SUM(l."debitBase"))::bigint AS amount
      FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
      JOIN "GlAccount" a ON a.id = l."accountId"
      WHERE a.code = '1202' AND e.status <> 'DRAFT'`;
    expect(BigInt(row.amount)).toBe(300_000_000n);
  });

  it('فهرست دارایی‌ها ماندهٔ دفتری را درست می‌دهد', async () => {
    await makeAsset();
    await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: afterMonths(5) }));
    const [a] = await listAssets(gl);
    expect(a.postedPeriods).toBe(5);
    expect(a.accumulated).toBe('500000000');
    expect(a.bookValue).toBe('700000000');
    expect(a.fullyDepreciated).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('چک‌لیست پایان ماه', () => {
  const check = (month: number) => monthEndChecklist(gl, { fiscalYearId: fy.id, month });
  const item = (r: any, key: string) => r.items.find((i: any) => i.key === key)!;

  it('دفترِ خالی هم بندهایش را دارد، با وضعیت NA', async () => {
    const r = await check(1);
    expect(r.items.length).toBeGreaterThanOrEqual(8);
    expect(item(r, 'depreciation').status).toBe('NA');
    expect(item(r, 'provision').status).toBe('NA');
  });

  it('پیش‌نویسِ باقی‌مانده به‌عنوان کارِ نکرده می‌آید', async () => {
    await tx((t) => createDraft(t, {
      fiscalYearId: fy.id, date: D('2026-04-01'), description: 'پیش‌نویس',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 1_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 1_000n },
      ],
    }));
    const r = await check(1);
    expect(item(r, 'drafts').status).toBe('TODO');
    expect(item(r, 'drafts').detail).toMatch(/۱ پیش‌نویس|1 پیش‌نویس/);
  });

  it('استهلاکِ سررسیدشدهٔ ثبت‌نشده، کارِ نکرده است', async () => {
    await makeAsset();
    // فروردین: هنوز چیزی سررسید نشده
    expect(item(await check(1), 'depreciation').status).toBe('DONE');
    // خرداد: دو دوره سررسید شده
    const r = await check(3);
    expect(item(r, 'depreciation').status).toBe('TODO');
  });

  it('پس از ثبت استهلاک، همان بند DONE می‌شود', async () => {
    await makeAsset();
    const before = await check(3);
    expect(item(before, 'depreciation').status).toBe('TODO');

    await tx((t) => postDepreciation(t, { fiscalYearId: fy.id, asOf: before.to }));
    const after = await check(3);
    expect(item(after, 'depreciation').status).toBe('DONE');
  });

  it('حساب نقدیِ منفی گرفته می‌شود', async () => {
    await entry(D('2026-04-05'), 'پرداخت بیش از موجودی', [
      { accountId: sales.id, currencyCode: 'IRR', debit: 5_000_000n },
      { accountId: cash.id, currencyCode: 'IRR', credit: 5_000_000n },
    ]);
    const r = await check(1);
    expect(item(r, 'negative-cash').status).toBe('TODO');
  });

  it('`ready` فقط وقتی درست است که هیچ کارِ نکرده‌ای نمانده باشد', async () => {
    const r = await check(1);
    expect(r.summary.ready).toBe(r.summary.todo === 0);
    // «لازم نبوده» جلوی آمادگی را نمی‌گیرد
    expect(r.summary.na).toBeGreaterThan(0);
  });
});
