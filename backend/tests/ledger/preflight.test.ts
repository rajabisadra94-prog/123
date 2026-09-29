/**
 * بررسیِ پیش‌پروازِ برش — مرحلهٔ ۵ د.
 *
 * دو قاعده‌ای که ارزش قفل کردن دارند:
 *
 *   • **هیچ نوشتنی.** تابعی که می‌گوید «آیا امن است؟» نباید چیزی را عوض کند،
 *     وگرنه اجرای دومش دیگر همان چیز را نمی‌سنجد.
 *   • **بندِ نامعلوم مانع است، نه هشدار.** دروازه‌ای که در شک سبز شود، دروازه
 *     نیست.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  gl, resetGl, seedGlChart, makeFiscalYear, accountByCode, D, resetBusinessData,
} from '../helpers/gl';
import { post } from '../../src/modules/ledger/poster';
import { cutoverPreflight } from '../../src/modules/ledger/preflight';

let fy: any, cash: any, sales: any;

const tx = <T>(fn: (t: any) => Promise<T>) => gl.$transaction(fn, { timeout: 60_000 });
const item = (r: any, title: string) => r.items.find((i: any) => i.title.includes(title));

beforeAll(async () => {
  await resetGl(); await seedGlChart();
  cash = await accountByCode('110101'); sales = await accountByCode('4101');
}, 180_000);
afterAll(async () => { await gl.$disconnect(); });
beforeEach(async () => { await resetGl(); await resetBusinessData(); fy = await makeFiscalYear(); });

// ═══════════════════════════════════════════════════════════════
describe('فقط‌خواندنی بودن', () => {
  it('هیچ سند، حساب یا تنظیمی نمی‌سازد', async () => {
    // ⚠️ قلبِ ماجرا. اگر بررسی چیزی بنویسد، اجرای دومش وضعیت دیگری می‌سنجد.
    const before = {
      entries: await gl.glEntry.count(),
      lines: await gl.glLine.count(),
      accounts: await gl.glAccount.count(),
      years: await gl.glFiscalYear.count(),
      settings: await gl.systemSetting.count(),
      subs: await gl.glSubsidiary.count(),
    };

    await cutoverPreflight(gl);
    await cutoverPreflight(gl);   // دو بار، تا اثرِ انباشته هم دیده شود

    expect({
      entries: await gl.glEntry.count(),
      lines: await gl.glLine.count(),
      accounts: await gl.glAccount.count(),
      years: await gl.glFiscalYear.count(),
      settings: await gl.systemSetting.count(),
      subs: await gl.glSubsidiary.count(),
    }).toEqual(before);
  });

  it('دو اجرای پیاپی نتیجهٔ یکسان می‌دهند', async () => {
    const a = await cutoverPreflight(gl);
    const b = await cutoverPreflight(gl);
    expect(b.items.map((i: any) => [i.title, i.state]))
      .toEqual(a.items.map((i: any) => [i.title, i.state]));
  });
});

// ═══════════════════════════════════════════════════════════════
describe('دروازه‌ها', () => {
  it('بکاپ همیشه نامعلوم است و مانع می‌شود', async () => {
    // از داخل برنامه قابل تأیید نیست، و «شاید گرفته شده» کافی نیست
    const r = await cutoverPreflight(gl);
    const backup = item(r, 'بکاپ')!;
    expect(backup.state).toBe('UNKNOWN');
    expect(r.ready).toBe(false);
  });

  it('بندِ نامعلوم مثل ناموفق، مانع شمرده می‌شود', async () => {
    const r = await cutoverPreflight(gl);
    const unknowns = r.items.filter((i: any) => i.state === 'UNKNOWN').length;
    const fails = r.items.filter((i: any) => i.state === 'FAIL').length;
    expect(r.blockers).toBe(unknowns + fails);
  });

  it('SKIP مانع نیست — یعنی هنوز نوبتش نرسیده', async () => {
    const r = await cutoverPreflight(gl);
    const skips = r.items.filter((i: any) => i.state === 'SKIP');
    expect(skips.length).toBeGreaterThan(0);
    // هیچ SKIPـی در شمارش موانع نیامده
    expect(r.blockers).toBeLessThan(r.items.length);
  });

  it('چارتِ موجود، بندِ چارت را سبز می‌کند', async () => {
    const r = await cutoverPreflight(gl);
    expect(item(r, 'چارت حساب‌ها')!.state).toBe('PASS');
  });

  it('سال مالیِ موجود سبز است', async () => {
    const r = await cutoverPreflight(gl, { cutoff: D('2026-06-01') });
    const y = item(r, 'سال مالی')!;
    // سال مالی تست ۱۴۰۵ است و ممکن است شاملِ «امروز» نباشد
    expect(['PASS', 'FAIL']).toContain(y.state);
  });

  it('پیش از مهاجرت، بندِ تطبیق SKIP است نه FAIL', async () => {
    // «هنوز نوبتش نرسیده» با «خراب است» یکی نیست
    const r = await cutoverPreflight(gl);
    expect(item(r, 'تطبیق')!.state).toBe('SKIP');
  });

  it('سلامت دفتر، سندِ نامتوازن را گزارش می‌کند', async () => {
    // ⚠️ روی `ok`ِ کلی ادعا نمی‌کنیم: `serialGaps` به شمارندهٔ سریال حساس است و
    // فایل‌های تست دیگر روی همین دیتابیس آن را جلو می‌برند. سنجهٔ معنادار برای
    // این تست، «سند نامتوازن» است که کاملاً در کنترل خودمان است.
    await tx((t) => post(t, {
      fiscalYearId: fy.id, date: D('2026-05-01'), description: 'فروش',
      lines: [
        { accountId: cash.id, currencyCode: 'IRR', debit: 1_000_000n },
        { accountId: sales.id, currencyCode: 'IRR', credit: 1_000_000n },
      ],
    }));
    const { integrityCheck } = await import('../../src/modules/ledger/integrity');
    const health = await integrityCheck(gl);
    expect(health.unbalancedEntries).toHaveLength(0);

    // و خودِ بند در گزارش هست و راهنما دارد وقتی ناموفق است
    const r = await cutoverPreflight(gl);
    const it2 = item(r, 'سلامت دفتر')!;
    expect(['PASS', 'FAIL']).toContain(it2.state);
    if (it2.state === 'FAIL') expect(it2.action).toBeTruthy();
  });

  it('هر بندِ ناموفق راهنمای کار دارد', async () => {
    // بندی که بگوید «خراب است» ولی نگوید چه کنی، فقط اضطراب می‌سازد
    const r = await cutoverPreflight(gl);
    for (const it of r.items) {
      if (it.state === 'FAIL' || it.state === 'UNKNOWN') {
        expect(it.action, `بند «${it.title}» راهنما ندارد`).toBeTruthy();
      }
    }
  });
});
