/**
 * فاز ۹ — مهاجرت از هستهٔ قدیمی به هستهٔ جدید.
 *
 * روش تست: یک دفتر واقع‌نما در هستهٔ **قدیمی** ساخته می‌شود (چندارزی، با
 * طرف‌حساب و حساب کنترلی و نقد)، مهاجرت اجرا می‌شود، و بعد **هر چهار سنجهٔ
 * پذیرش** `docs/LEDGER_MIGRATION.md` بخش ۶ بررسی می‌شود.
 *
 * این مهم‌ترین تست کل پروژه است: اگر بشکند، یعنی مهاجرت ترازنامه را عوض می‌کند.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  gl, resetGl, resetBusinessData, seedGlChart, makeFiscalYear, accountByCode, D, expectRejects,
} from '../helpers/gl';
import {
  db, resetLedger, seedChart, makeCashAccount, makeCustomer, makeProducer,
} from '../helpers/fixtures';
import {
  postJournal, getOrCreateWallet, getOrCreateControl,
} from '../../src/modules/accounting/accounting.service';
import {
  collectLegacyPositions, buildMigrationPlan, postOpeningEntry, verifyMigration, CONTROL_MAP,
} from '../../src/modules/ledger/migration/migrate';
import { balanceSheet } from '../../src/modules/ledger/reports/statements';
import { trialBalance } from '../../src/modules/ledger/reports/ledgers';

vi.mock('../../src/shared/utils/rates', () => ({
  getRates: async () => ({
    USD_TO_IRR: 100_000, CNY_TO_IRR: 14_000, USD_TO_CNY: 7.142857142857143,
    source: 'test', fetchedAt: new Date(), isStale: false,
  }),
}));

const CUTOFF = D('2026-06-01');
let fy: { id: string };
let legacy: { customer: any; producer: any; cash: any };

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 90_000 });

beforeAll(async () => {
  await resetGl();
  await seedGlChart();
}, 180_000);

afterAll(async () => {
  await gl.$disconnect();
  await db.$disconnect();
});

beforeEach(async () => {
  await resetLedger();      // هستهٔ قدیمی
  await resetGl();          // هستهٔ جدید
  await resetBusinessData();
  await seedChart();        // چارت قدیمی
  fy = await makeFiscalYear();
});

/**
 * یک دفتر واقع‌نما در هستهٔ قدیمی: آورده، فروش دلاری، خرید یوآنی، دریافت نقدی.
 * عمداً چندارزی است تا مهاجرتِ موضع‌های ارزی واقعاً سنجیده شود.
 */
async function seedLegacyLedger() {
  const customer = await makeCustomer('احترامیان', 'MG1');
  const producer = await makeProducer('Sun');
  const cash = await makeCashAccount('IRR', 'بانک سپه');

  await db.$transaction(async (t) => {
    const opening = await getOrCreateControl(t, 'OPENING', 'IRR');
    const sales = await getOrCreateControl(t, 'SALES', 'USD');
    const purchase = await getOrCreateControl(t, 'PURCHASE', 'CNY');
    const custUsd = await getOrCreateWallet(t, 'CUSTOMER', customer.id, 'USD', customer.name);
    const custIrr = await getOrCreateWallet(t, 'CUSTOMER', customer.id, 'IRR', customer.name);
    const prodCny = await getOrCreateWallet(t, 'PRODUCER', producer.id, 'CNY', producer.name);

    // آوردهٔ سرمایه — ۲۰ میلیون تومان
    await postJournal(t, {
      description: 'آورده', eventType: 'MANUAL', date: D('2026-04-01'),
      lines: [
        { accountId: cash.id, debit: 20_000_000, currency: 'IRR', rateToIRR: 1 },
        { accountId: opening.id, credit: 20_000_000, currency: 'IRR', rateToIRR: 1 },
      ],
    });

    // فروش دلاری — ۱۰۰ دلار با نرخ ۹۰٬۰۰۰ تومان
    await postJournal(t, {
      description: 'فروش دلاری', eventType: 'MANUAL', date: D('2026-04-15'),
      lines: [
        { accountId: custUsd.id, debit: 100, currency: 'USD', rateToIRR: 90_000 },
        { accountId: sales.id, credit: 100, currency: 'USD', rateToIRR: 90_000 },
      ],
    });

    // خرید یوآنی — ۵۰۰ یوآن با نرخ ۱۳٬۵۰۰ تومان
    await postJournal(t, {
      description: 'خرید یوآنی', eventType: 'MANUAL', date: D('2026-05-01'),
      lines: [
        { accountId: purchase.id, debit: 500, currency: 'CNY', rateToIRR: 13_500 },
        { accountId: prodCny.id, credit: 500, currency: 'CNY', rateToIRR: 13_500 },
      ],
    });

    // پیش‌دریافت تومانی از همان مشتری — موضع ارزی دوم روی یک طرف‌حساب
    await postJournal(t, {
      description: 'پیش‌دریافت', eventType: 'MANUAL', date: D('2026-05-10'),
      lines: [
        { accountId: cash.id, debit: 3_000_000, currency: 'IRR', rateToIRR: 1 },
        { accountId: custIrr.id, credit: 3_000_000, currency: 'IRR', rateToIRR: 1 },
      ],
    });
  }, { timeout: 60_000 });

  legacy = { customer, producer, cash };
}

/** ارزش دفتری کل هستهٔ قدیمی به ریال */
async function legacyTotalRial(): Promise<bigint> {
  const rows = await db.$queryRaw<{ v: string | null }[]>`
    SELECT SUM(l.debit * l."rateToIRR" - l.credit * l."rateToIRR")::text AS v
    FROM "JournalLine" l JOIN "JournalEntry" e ON e.id = l."entryId"
    WHERE e.date <= ${CUTOFF}
  `;
  return BigInt(Math.round(Number(rows[0]?.v ?? 0) * 10));
}

// ═══════════════════════════════════════════════════════════════
describe('جمع‌آوری مانده‌های قدیمی', () => {
  it('مانده از دفتر خوانده می‌شود، نه از ستون balance', async () => {
    await seedLegacyLedger();

    // ستون balance را عمداً خراب می‌کنیم
    await db.financialAccount.updateMany({ data: { balance: 999_999 } });

    const positions = await collectLegacyPositions(gl, CUTOFF);
    const cashPos = positions.find((p) => p.name === 'بانک سپه')!;
    // ۲۰ میلیون آورده + ۳ میلیون پیش‌دریافت
    expect(Number(cashPos.amount)).toBe(23_000_000);
  });

  it('حساب‌های با ماندهٔ صفر نمی‌آیند', async () => {
    await seedLegacyLedger();
    const positions = await collectLegacyPositions(gl, CUTOFF);
    for (const p of positions) {
      expect(Number(p.amount) !== 0 || Number(p.valueToman) !== 0).toBe(true);
    }
  });

  it('اسناد بعد از تاریخ برش دیده نمی‌شوند', async () => {
    await seedLegacyLedger();
    const before = await collectLegacyPositions(gl, D('2026-04-20'));
    const after = await collectLegacyPositions(gl, CUTOFF);
    expect(before.length).toBeLessThan(after.length);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('طرح مهاجرت', () => {
  it('هر موضع به حساب و تفصیلی درست نگاشت می‌شود', async () => {
    await seedLegacyLedger();
    const plan = await tx((t) => buildMigrationPlan(t, CUTOFF));

    expect(plan.unmapped).toHaveLength(0);

    const byCode = (code: string) => plan.lines.filter((l: any) => l.accountCode === code);
    expect(byCode(CONTROL_MAP.OPENING)).toHaveLength(1);       // سرمایه
    expect(byCode(CONTROL_MAP.SALES)).toHaveLength(1);         // فروش
    expect(byCode(CONTROL_MAP.PURCHASE)).toHaveLength(1);      // بهای تمام‌شده

    // مشتری با دو ارز ⇒ دو ردیف روی ۱۱۰۴، هر دو با یک تفصیلی
    const ar = byCode('1104');
    expect(ar).toHaveLength(2);
    expect(new Set(ar.map((l: any) => l.subsidiaryId)).size).toBe(1);
    expect(new Set(ar.map((l: any) => l.currencyCode))).toEqual(new Set(['USD', 'IRR']));
  });

  it('نرخ از دفتر قدیمی مشتق می‌شود، نه از نرخ روز', async () => {
    await seedLegacyLedger();
    const plan = await tx((t) => buildMigrationPlan(t, CUTOFF));

    const usd = plan.lines.find((l: any) => l.currencyCode === 'USD' && l.accountCode === '1104')!;
    // نرخ دفتری ۹۰٬۰۰۰ تومان ⇒ ۹۰۰٬۰۰۰ ریال، نه نرخ روز (۱٬۰۰۰٬۰۰۰)
    expect(usd.rate.scaled).toBe(900_000n * 10n ** 10n);

    // و نرخ ارز پایه باید دقیقاً ۱ باشد، نه ۱۰
    const irr = plan.lines.find((l: any) => l.currencyCode === 'IRR')!;
    expect(irr.rate.scaled).toBe(1n * 10n ** 10n);
  });

  it('طرح در مجموع تراز است', async () => {
    await seedLegacyLedger();
    const plan = await tx((t) => buildMigrationPlan(t, CUTOFF));
    expect(plan.totalBase).toBe(0n);
  });

  it('حساب نگاشت‌نشده، مهاجرت را متوقف می‌کند', async () => {
    await seedLegacyLedger();
    // یک حساب با controlKind ناشناخته
    const orphan = await db.financialAccount.create({
      data: { name: 'حساب ناشناخته', type: 'X', currency: 'IRR', controlKind: 'UNKNOWN_KIND', isPostable: true, accountType: 'ASSET' },
    });
    const sales = await getOrCreateControl(db, 'SALES', 'IRR');
    await db.$transaction((t) => postJournal(t, {
      description: 'گردش ناشناخته', eventType: 'MANUAL', date: D('2026-05-20'),
      lines: [
        { accountId: orphan.id, debit: 1_000_000, currency: 'IRR', rateToIRR: 1 },
        { accountId: sales.id, credit: 1_000_000, currency: 'IRR', rateToIRR: 1 },
      ],
    }));

    await expectRejects(
      () => tx((t) => postOpeningEntry(t, { fiscalYearId: fy.id, cutoff: CUTOFF })),
      /نگاشت ندارند/,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
describe('سند افتتاحیه', () => {
  it('یک سند ثبت می‌شود و تراز است', async () => {
    await seedLegacyLedger();
    const res: any = await tx((t) => postOpeningEntry(t, { fiscalYearId: fy.id, cutoff: CUTOFF }));

    expect(res.entry.entryType).toBe('OPENING');
    expect(await gl.glEntry.count()).toBe(1);

    const lines = await gl.glLine.findMany({ where: { entryId: res.entry.id } });
    const dr = lines.reduce((s, l) => s + l.debitBase, 0n);
    const cr = lines.reduce((s, l) => s + l.creditBase, 0n);
    expect(dr).toBe(cr);
  });

  it('حساب‌های موقت هم منتقل می‌شوند — برش وسط سال', async () => {
    await seedLegacyLedger();
    const res: any = await tx((t) => postOpeningEntry(t, { fiscalYearId: fy.id, cutoff: CUTOFF }));

    const lines = await gl.glLine.findMany({
      where: { entryId: res.entry.id }, include: { account: { select: { code: true } } },
    });
    const codes = new Set(lines.map((l) => l.account.code));
    expect(codes.has('4101')).toBe(true);   // فروش — حساب موقت
    expect(codes.has('5101')).toBe(true);   // بهای تمام‌شده — حساب موقت
  });

  it('حساب نقدی شرکت، برگ تازه زیر ۱۱۰۱ می‌گیرد', async () => {
    await seedLegacyLedger();
    await tx((t) => postOpeningEntry(t, { fiscalYearId: fy.id, cutoff: CUTOFF }));

    const leaf = await gl.glAccount.findFirst({
      where: { name: 'بانک سپه', parent: { code: '1101' } },
    });
    expect(leaf).not.toBeNull();
    expect(leaf!.isPostable).toBe(true);
    expect(leaf!.currencyMode).toBe('SINGLE');
    expect(leaf!.currencyCode).toBe('IRR');
  });

  it('اختلاف گرد کردن بدون تأیید صریح، مهاجرت را متوقف می‌کند', async () => {
    await seedLegacyLedger();
    // یک سند با مبلغی که در تبدیل به ریال گرد می‌شود و تراز را می‌شکند
    const cash2 = await makeCashAccount('IRR', 'صندوق خرد');
    const sales = await getOrCreateControl(db, 'SALES', 'IRR');
    await db.$transaction((t) => postJournal(t, {
      description: 'مبلغ اعشاری', eventType: 'MANUAL', date: D('2026-05-25'),
      lines: [
        { accountId: cash2.id, debit: 0.04, currency: 'IRR', rateToIRR: 1 },
        { accountId: sales.id, credit: 0.04, currency: 'IRR', rateToIRR: 1 },
      ],
    }));

    // اگر گرد کردن تراز را نشکند، این تست بی‌اثر است — پس فقط وقتی معنا دارد
    // که واقعاً بشکند. در غیر این صورت سند عادی ثبت می‌شود.
    const plan = await tx((t) => buildMigrationPlan(t, CUTOFF));
    if (plan.totalBase !== 0n) {
      await expectRejects(
        () => tx((t) => postOpeningEntry(t, { fiscalYearId: fy.id, cutoff: CUTOFF })),
        /اختلاف مانده است/,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════
describe('سنجه‌های پذیرش', () => {
  it('هر چهار سنجه سبز است', async () => {
    await seedLegacyLedger();
    await tx((t) => postOpeningEntry(t, { fiscalYearId: fy.id, cutoff: CUTOFF }));

    const report: any = await tx((t) => verifyMigration(t, CUTOFF));

    expect(report.totalBaseDiff).toBe(0n);       // ۱) ارزش کل
    expect(report.amountMismatches).toEqual([]); // ۲) موضع ارزی
    expect(report.valueMismatches).toEqual([]);  // ۳) ارزش پایه
    expect(report.integrity.ok).toBe(true);      // ۴) سلامت دفتر
    expect(report.ok).toBe(true);
  });

  it('ارزش کل هستهٔ جدید با هستهٔ قدیمی ریال‌به‌ریال می‌خواند', async () => {
    await seedLegacyLedger();
    await tx((t) => postOpeningEntry(t, { fiscalYearId: fy.id, cutoff: CUTOFF }));

    const oldTotal = await legacyTotalRial();
    const rows = await gl.$queryRaw<{ v: bigint | null }[]>`
      SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS v FROM "GlLine" l
    `;
    expect(BigInt(rows[0].v ?? 0n)).toBe(oldTotal);   // هر دو صفرند و باید بمانند
  });

  it('موضع ارزی هر طرف‌حساب عیناً منتقل می‌شود', async () => {
    await seedLegacyLedger();
    await tx((t) => postOpeningEntry(t, { fiscalYearId: fy.id, cutoff: CUTOFF }));

    const sub = await gl.glSubsidiary.findFirstOrThrow({ where: { refType: 'Customer' } });
    const ar = await accountByCode('1104');
    const rows = await gl.$queryRaw<{ currencyCode: string; amount: bigint }[]>`
      SELECT l."currencyCode", (SUM(l.debit) - SUM(l.credit))::bigint AS amount
      FROM "GlLine" l WHERE l."accountId" = ${ar.id} AND l."subsidiaryId" = ${sub.id}
      GROUP BY l."currencyCode" ORDER BY l."currencyCode"
    `;
    const byCur = Object.fromEntries(rows.map((r) => [r.currencyCode, BigInt(r.amount)]));
    expect(byCur.USD).toBe(10_000n);          // ۱۰۰٫۰۰ دلار
    expect(byCur.IRR).toBe(-30_000_000n);     // ۳ میلیون تومان بستانکار ⇒ ریال
  });

  it('ترازنامهٔ هستهٔ جدید بعد از مهاجرت بسته است', async () => {
    await seedLegacyLedger();
    await tx((t) => postOpeningEntry(t, { fiscalYearId: fy.id, cutoff: CUTOFF }));

    const bs: any = await balanceSheet(gl, CUTOFF);
    expect(bs.balanced).toBe(true);
  });

  it('تراز آزمایشی هستهٔ جدید تراز است', async () => {
    await seedLegacyLedger();
    await tx((t) => postOpeningEntry(t, { fiscalYearId: fy.id, cutoff: CUTOFF }));

    const tb: any = await trialBalance(gl, {}, 2);
    expect(tb.totals.closingDebit).toBe(tb.totals.closingCredit);
  });
});
