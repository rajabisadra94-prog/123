/**
 * یادداشت‌های صورت‌های مالی و فهرست مالیات حقوق — مرحلهٔ ۵ ب.
 *
 * قاعدهٔ حاکم: **یادداشت باید با صورت مالی بخواند.** یادداشتی که جمعش با
 * ترازنامه یکی نباشد، بدتر از نبودنش است — چون خواننده نمی‌داند کدام درست است.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, makeSubsidiary, accountByCode,
  D, resetBusinessData,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { statementNotes, payrollTaxList } from '../../src/modules/ledger/reports/disclosure';
import { balanceSheet } from '../../src/modules/ledger/reports/statements';

let fy: any, cash: any, bank: any, sales: any, ar: any, rent: any, capital: any, alpha: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const entry = (date: Date, description: string, lines: any[]) =>
  tx((t) => post(t, { fiscalYearId: fy.id, date, description, lines }));

const AS_OF = D('2026-11-01');
const YEAR = { asOf: AS_OF, from: D('2026-03-21') };

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
  ar = await accountByCode('1104'); rent = await accountByCode('6202');
  capital = await accountByCode('3101');
  bank = await gl.glAccount.findFirst({ where: { code: { startsWith: '1102' }, isPostable: true } });
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => {
  await gl.glDisclosureNote.deleteMany({});
  await resetGl(); await resetBusinessData();
  fy = await makeFiscalYear();
  alpha = await makeSubsidiary('CUSTOMER', 'مشتری الف');
});

const note = (r: any, key: string) => r.notes.find((n: any) => n.key === key);

// ═══════════════════════════════════════════════════════════════
describe('یادداشت‌های محاسبه‌شده', () => {
  it('ریز موجودی نقد را می‌دهد', async () => {
    await entry(D('2026-04-01'), 'آورده', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 5_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 5_000_000_000n },
    ]);
    const r = await statementNotes(gl, YEAR);
    const n = note(r, 'cash')!;
    expect(n.total).toBe('5000000000');
    expect(n.rows.some((x: any) => x.code === '110101')).toBe(true);
    expect(n.policy).toMatch(/موجودی نقد/);
  });

  it('جمعِ یادداشت با ترازنامه می‌خواند', async () => {
    // ⚠️ قاعدهٔ حاکم. یادداشتی که با صورت مالی نخواند بدتر از نبودنش است.
    await entry(D('2026-04-01'), 'آورده', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 5_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 5_000_000_000n },
    ]);
    await entry(D('2026-05-01'), 'فروش نسیه', [
      { accountId: ar.id, subsidiaryId: alpha.id, currencyCode: 'IRR', debit: 2_000_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 2_000_000_000n },
    ]);

    const r = await statementNotes(gl, YEAR);
    const bs: any = await balanceSheet(gl, AS_OF, { compare: false });
    const arInBs = bs.assets.find((a: any) => a.code === '1104');
    expect(note(r, 'receivable')!.total).toBe(String(arInBs.amount));
  });

  it('درآمد مثبت نشان داده می‌شود، نه منفی', async () => {
    // «درآمدِ منفی ۲ میلیارد» جمله‌ای است که کسی نمی‌فهمد
    await entry(D('2026-05-01'), 'فروش', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 2_000_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 2_000_000_000n },
    ]);
    const r = await statementNotes(gl, YEAR);
    expect(note(r, 'revenue')!.total).toBe('2000000000');
  });

  it('اقلام سود و زیانی بازه‌ای‌اند و ترازنامه‌ای‌ها تجمعی', async () => {
    await entry(D('2026-04-01'), 'فروش فروردین', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 1_000_000_000n },
    ]);
    // بازه‌ای که فروردین را نمی‌گیرد
    const late = await statementNotes(gl, { asOf: AS_OF, from: D('2026-09-01') });
    expect(note(late, 'revenue')).toBeUndefined();       // درآمدی در بازه نیست
    expect(note(late, 'cash')!.total).toBe('1000000000'); // ولی نقد تجمعی است
  });

  it('حسابِ چندارزی تفکیک ارز می‌گیرد، تک‌ارزی نه', async () => {
    await entry(D('2026-05-01'), 'فروش ریالی', [
      { accountId: ar.id, subsidiaryId: alpha.id, currencyCode: 'IRR', debit: 1_000_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 1_000_000_000n },
    ]);
    await entry(D('2026-05-02'), 'فروش دلاری', [
      { accountId: ar.id, subsidiaryId: alpha.id, currencyCode: 'USD', debit: 10_000n, rate: '900000' },
      { accountId: sales.id, currencyCode: 'USD', credit: 10_000n, rate: '900000' },
    ]);
    const r = await statementNotes(gl, YEAR);
    const arRow = note(r, 'receivable')!.rows.find((x: any) => x.code === '1104')!;
    expect(arRow.byCurrency).toHaveLength(2);

    const cashNote = note(r, 'cash');
    if (cashNote?.rows.length) expect(cashNote.rows[0].byCurrency).toHaveLength(0);
  });

  it('حسابِ بی‌گردش یادداشت نمی‌سازد', async () => {
    const r = await statementNotes(gl, YEAR);
    expect(r.notes).toHaveLength(0);
    expect(r.standalone).toHaveLength(0);
  });

  it('سند اختتامیه، یادداشتِ درآمد را صفر نمی‌کند', async () => {
    await entry(D('2026-05-01'), 'فروش', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 3_000_000_000n },
      { accountId: sales.id, currencyCode: 'IRR', credit: 3_000_000_000n },
    ]);
    const before = await statementNotes(gl, YEAR);
    const { closeFiscalYear } = await import('../../src/modules/ledger/year-close');
    await tx((t) => closeFiscalYear(t, { fiscalYearId: fy.id, acknowledgeChecklist: true }));
    const after = await statementNotes(gl, YEAR);
    expect(note(after, 'revenue')!.total).toBe(note(before, 'revenue')!.total);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('یادداشت‌های انسانی', () => {
  it('یادداشتِ چسبیده، ذیل همان بند می‌آید', async () => {
    await entry(D('2026-04-01'), 'آورده', [
      { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000_000n },
      { accountId: capital.id, currencyCode: 'IRR', credit: 1_000_000_000n },
    ]);
    await gl.glDisclosureNote.create({
      data: { noteKey: 'cash', title: 'حساب مسدود', body: 'مبلغ ۲۰۰ میلیون نزد بانک الف مسدود است.' },
    });
    const r = await statementNotes(gl, YEAR);
    expect(note(r, 'cash')!.remarks).toHaveLength(1);
    expect(note(r, 'cash')!.remarks![0].title).toBe('حساب مسدود');
  });

  it('یادداشتِ مستقل جدا برمی‌گردد', async () => {
    await gl.glDisclosureNote.create({
      data: { noteKey: null, title: 'بدهی احتمالی', body: 'پروندهٔ حقوقی در جریان است.' },
    });
    const r = await statementNotes(gl, YEAR);
    expect(r.standalone).toHaveLength(1);
    expect(r.standalone[0].title).toBe('بدهی احتمالی');
  });

  it('یادداشتِ منقضی‌شده نمی‌آید', async () => {
    await gl.glDisclosureNote.create({
      data: {
        noteKey: null, title: 'یادداشت قدیمی', body: '…',
        validTo: D('2026-05-01'),
      },
    });
    const r = await statementNotes(gl, YEAR);   // asOf آبان است
    expect(r.standalone).toHaveLength(0);
  });

  it('یادداشتی که هنوز شروع نشده هم نمی‌آید', async () => {
    await gl.glDisclosureNote.create({
      data: { noteKey: null, title: 'آینده', body: '…', validFrom: D('2027-01-01') },
    });
    expect((await statementNotes(gl, YEAR)).standalone).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('فهرست مالیات حقوق', () => {
  it('لیستِ نبود، `found=false` می‌دهد نه خطا', async () => {
    const r = await payrollTaxList(gl, { year: 1405, month: 5 });
    expect(r.found).toBe(false);
    expect(r.rows).toHaveLength(0);
    expect(r.totals.tax).toBe('0');
  });
});
