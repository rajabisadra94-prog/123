/**
 * بررسیِ پیش‌پروازِ برش پروداکشن — مرحلهٔ ۵ د.
 *
 * رانبوک ۱۲ گام دارد و چند تای‌شان دروازهٔ «برو/نرو» هستند: «`unmapped` صفر»،
 * «هر ۴ سنجه صفر»، «۷ روز پیاپی diff پاک». تا امروز باید هرکدام را جدا صدا
 * می‌زدی و خودت قضاوت می‌کردی — روی سیستمی که اگر وسط کار بایستد، دفترِ
 * حسابداریِ یک شرکت نصفه می‌ماند.
 *
 * این ماژول همهٔ آن دروازه‌ها را **یک‌جا و فقط‌خواندنی** می‌سنجد و یک جواب
 * می‌دهد: آماده هست یا نه، و اگر نه، کدام بند و چرا.
 *
 * ─── دو قاعده که در کد اجبار شده ───────────────────────────────
 *
 * ۱) **هیچ نوشتنی.** نه سند، نه تنظیم، نه حتی یک ردیف لاگ. تابعی که قرار است
 *    بگوید «آیا امن است؟» خودش نباید چیزی را عوض کند؛ وگرنه اجرای دوباره‌اش
 *    دیگر همان چیز را نمی‌سنجد.
 *
 *    ⚠️ این ساده نبود: `buildMigrationPlan` از طریق `ensureSubsidiary` و
 *    `ensureCashLeaf` **می‌نویسد** — تفصیلی و برگِ نقدی می‌سازد. نسخهٔ اول
 *    این ماژول صادقانه نبود و تستِ «هیچ چیزی نمی‌سازد» گرفتش. حالا نقشه
 *    داخل تراکنشی ساخته می‌شود که عمداً **برگردانده** می‌شود، پس اثرش
 *    می‌ماند در حافظه و نه در دیتابیس.
 *
 * ۲) **بندِ نامعلوم = مانع، نه هشدار.** اگر چیزی را نتوانستیم بسنجیم (مثلاً
 *    بکاپ)، `UNKNOWN` برمی‌گردد و جلوی `ready` را می‌گیرد. دروازه‌ای که در
 *    شک سبز شود، دروازه نیست.
 */
import { Prisma } from '@prisma/client';
import { ledgerMode } from './dual-write';
import { buildMigrationPlan, verifyMigration } from './migration/migrate';
import { integrityCheck } from './integrity';
import { streak, CUTOVER_GATE_DAYS } from './diff-history';

export class PreflightError extends Error {}

/**
 * سنتینلِ «نقشه ساخته شد، حالا تراکنش را برگردان».
 *
 * تنها راهِ اجرای یک تابعِ نویسنده بدون ماندگار شدنِ اثرش، انداختنِ خطا از
 * داخل تراکنش است. خطای واقعی از این تشخیص داده می‌شود چون نوعش مشخص است.
 */
class PlanProbe<T> extends Error {
  constructor(public readonly result: T) { super('plan-probe'); }
}

/**
 * `buildMigrationPlan` را اجرا می‌کند و اثرِ نوشتاری‌اش را برمی‌گرداند.
 *
 * اگر کلاینتِ ورودی خودش تراکنش باشد (تو در تو ممکن نیست)، `null` برمی‌گردد
 * و بند با حالتِ نامعلوم گزارش می‌شود — نه اینکه بی‌صدا بنویسد.
 */
async function planDryRun(
  client: Prisma.TransactionClient,
  cutoff: Date,
): Promise<{ lines: unknown[]; unmapped: any[]; totalBase: bigint } | null> {
  const withTx = client as unknown as { $transaction?: unknown };
  if (typeof withTx.$transaction !== 'function') return null;

  try {
    await (client as any).$transaction(async (t: Prisma.TransactionClient) => {
      const plan = await buildMigrationPlan(t, cutoff);
      throw new PlanProbe(plan);
    }, { timeout: 120_000 });
    return null;
  } catch (e) {
    if (e instanceof PlanProbe) return e.result as any;
    throw e;
  }
}

export type CheckState = 'PASS' | 'FAIL' | 'UNKNOWN' | 'SKIP';

export interface PreflightItem {
  step: string;
  title: string;
  state: CheckState;
  detail: string;
  /** کارِ مشخصی که باید انجام شود */
  action?: string | null;
}

const DAY = 86_400_000;

export async function cutoverPreflight(
  tx: Prisma.TransactionClient,
  input: { cutoff?: Date | null } = {},
) {
  const items: PreflightItem[] = [];
  const add = (i: PreflightItem) => { items.push(i); return i; };

  // ── ۰) حالت فعلی ──────────────────────────────────────────
  const mode = ledgerMode();
  add({
    step: '۰',
    title: 'حالت فعلی هسته',
    state: mode === 'new' ? 'SKIP' : 'PASS',
    detail: mode === 'legacy'
      ? 'هستهٔ قدیمی مرجع است؛ برش هنوز انجام نشده'
      : mode === 'dual'
        ? 'دونویسی روشن است — قدیمی مرجع، جدید سایه'
        : 'برش از قبل انجام شده: هستهٔ جدید مرجع است',
    action: mode === 'new' ? null : null,
  });

  // ── ۱) schema و چارت ──────────────────────────────────────
  const accounts = await tx.glAccount.count();
  const postable = await tx.glAccount.count({ where: { isPostable: true } });
  add({
    step: '۱–۲',
    title: 'چارت حساب‌ها',
    state: accounts > 0 && postable > 0 ? 'PASS' : 'FAIL',
    detail: accounts === 0
      ? 'هیچ حسابی در چارت نیست — جدول‌های Gl* ساخته نشده‌اند'
      : `${accounts} حساب (${postable} برگ)`,
    action: accounts === 0 ? 'prisma db push و سپس npm run ledger:chart-sync' : null,
  });

  // ── تریگرهای پایگاه داده ──────────────────────────────────
  // بدون این‌ها قواعد پنج‌گانه فقط در کد اجرا می‌شوند، نه در دیتابیس.
  const triggers = await tx.$queryRaw<{ tgname: string }[]>`
    SELECT tgname FROM pg_trigger
    WHERE NOT tgisinternal AND tgname LIKE 'gl_%'
  `;
  add({
    step: '۱',
    title: 'تریگرها و قیدهای پایگاه داده',
    state: triggers.length > 0 ? 'PASS' : 'FAIL',
    detail: triggers.length
      ? `${triggers.length} تریگر فعال: ${triggers.map((t) => t.tgname).join('، ')}`
      : 'هیچ تریگر gl_* نصب نیست — قواعد فقط در کد اجرا می‌شوند',
    action: triggers.length ? null : 'اجرای prisma/manual/2026-08-27-gl-core-constraints.sql',
  });

  // ── سال مالی ──────────────────────────────────────────────
  const now = new Date();
  const fy = await tx.glFiscalYear.findFirst({
    where: { startDate: { lte: now }, endDate: { gte: now } },
  });
  add({
    step: '۲',
    title: 'سال مالیِ شاملِ امروز',
    state: fy ? 'PASS' : 'FAIL',
    detail: fy
      ? `${fy.title} (${fy.startDate.toISOString().slice(0, 10)} تا ${fy.endDate.toISOString().slice(0, 10)})`
      : 'سال مالیِ بازی که امروز داخلش باشد تعریف نشده',
    action: fy ? null : 'ساخت سال مالی در تب «تنظیمات و سلامت»',
  });

  // ── ۳) بکاپ — سنجیدنی نیست ────────────────────────────────
  // عمداً UNKNOWN و مانع: از داخل برنامه نمی‌شود فهمید بکاپ گرفته شده یا نه،
  // و «شاید گرفته شده» برای عملیاتی که دفتر شرکت را جابه‌جا می‌کند کافی نیست.
  add({
    step: '۳',
    title: 'بکاپ کامل پایگاه داده',
    state: 'UNKNOWN',
    detail: 'از داخل برنامه قابل تأیید نیست — باید دستی گرفته و بررسی شود',
    action: 'pg_dump کامل + بررسی حجم و قابل بازیابی بودنش',
  });

  // ── ۴) نقشهٔ مهاجرت ───────────────────────────────────────
  const cutoff = input.cutoff ?? now;
  try {
    const plan = await planDryRun(tx, cutoff);
    if (plan == null) {
      add({
        step: '۴', title: 'نقشهٔ مهاجرت', state: 'UNKNOWN',
        detail: 'داخل یک تراکنشِ باز اجرا شد؛ نقشه بدون نوشتن قابل ساخت نیست',
        action: 'این بررسی را با کلاینت اصلی اجرا کنید، نه داخل تراکنش',
      });
    } else {
      const planOk = plan.unmapped.length === 0;
      add({
        step: '۴',
        title: 'نقشهٔ مهاجرت',
        state: planOk ? 'PASS' : 'FAIL',
        detail: planOk
          ? `${plan.lines.length} ردیف، همه نگاشت‌شده · جمع پایه ${plan.totalBase.toString()}`
          : `${plan.unmapped.length} موضع نگاشت‌نشده: ${plan.unmapped.slice(0, 3).map((u: any) => `${u.source}/${u.currency}`).join('، ')}`,
        action: planOk ? null : 'نگاشت حساب‌های نگاشت‌نشده در CONTROL_MAP یا اصلاح دادهٔ قدیمی',
      });
    }
  } catch (e: any) {
    add({
      step: '۴', title: 'نقشهٔ مهاجرت', state: 'FAIL',
      detail: `ساخت نقشه شکست خورد: ${e.message}`,
      action: 'بررسی خطا پیش از هر اقدام دیگر',
    });
  }

  // ── ۵–۶) سند افتتاحیه و تطبیق ─────────────────────────────
  const migrated = await tx.glEntry.count({ where: { sourceType: 'Migration' } });
  if (migrated === 0) {
    add({
      step: '۵–۶',
      title: 'سند افتتاحیهٔ مهاجرت و تطبیق چهارگانه',
      state: 'SKIP',
      detail: 'هنوز مهاجرت اجرا نشده — پس از گام ۵ دوباره بررسی کنید',
      action: 'POST /ledger/migration/run',
    });
  } else {
    try {
      const v = await verifyMigration(tx, cutoff);
      const failing = [
        v.totalBaseDiff !== 0n ? `اختلاف پایه ${v.totalBaseDiff}` : null,
        v.amountMismatches.length ? `${v.amountMismatches.length} مبلغ ناهماهنگ` : null,
        v.valueMismatches.length ? `${v.valueMismatches.length} ارزش ناهماهنگ` : null,
        !v.integrity.ok ? 'سلامت دفتر خراب' : null,
      ].filter(Boolean);
      add({
        step: '۶',
        title: 'تطبیق چهارگانهٔ مهاجرت',
        state: v.ok ? 'PASS' : 'FAIL',
        detail: v.ok ? 'هر ۴ سنجه صفر' : failing.join(' · '),
        action: v.ok ? null : 'گزارش تطبیق حساب‌به‌حساب را بررسی کنید',
      });
    } catch (e: any) {
      add({
        step: '۶', title: 'تطبیق چهارگانهٔ مهاجرت', state: 'FAIL',
        detail: `تطبیق شکست خورد: ${e.message}`, action: null,
      });
    }
  }

  // ── سلامت دفتر جدید ───────────────────────────────────────
  const integrity = await integrityCheck(tx);
  const broken = Object.entries(integrity)
    .filter(([k, v]) => k !== 'ok' && k !== 'checked' && Array.isArray(v) && v.length > 0)
    .map(([k, v]) => `${k}=${(v as unknown[]).length}`);
  add({
    step: '۷',
    title: 'سلامت دفتر جدید',
    state: integrity.ok ? 'PASS' : 'FAIL',
    detail: integrity.ok
      ? `${integrity.checked.entries} سند / ${integrity.checked.lines} ردیف، بدون ایراد`
      : broken.join(' · '),
    action: integrity.ok ? null : 'تب «سلامت دفاتر» را ببینید',
  });

  // ── دروازهٔ diff ──────────────────────────────────────────
  let gate: ReturnType<typeof streak> | null = null;
  try { gate = streak(); } catch { gate = null; }
  add({
    step: '۸',
    title: `دروازهٔ اعتبارسنجی (${CUTOVER_GATE_DAYS} روز پیاپی)`,
    state: gate == null ? 'UNKNOWN' : gate.passesGate ? 'PASS' : 'FAIL',
    detail: gate == null
      ? 'سیاههٔ diff خوانده نشد'
      : `${gate.consecutiveCleanDays}/${gate.gate} روز پاک · ${gate.totalRuns} اجرا در ${gate.daysCovered} روز`
        + (gate.lastRun ? ` · آخرین ${gate.lastRun.slice(0, 10)}` : ''),
    action: gate?.passesGate ? null : 'cron شبانهٔ npm run ledger:diff -- --record باید هر شب پاک بماند',
  });

  // ── ۹) بازنشستگیِ هستهٔ قدیمی ─────────────────────────────
  const retired = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM pg_trigger
    WHERE NOT tgisinternal AND tgname LIKE '%legacy%readonly%'
  `;
  const isRetired = BigInt(retired[0]?.n ?? 0n) > 0n;
  add({
    step: '۹',
    title: 'هستهٔ قدیمی فقط‌خواندنی',
    state: isRetired ? 'PASS' : 'SKIP',
    detail: isRetired
      ? 'گاردِ فقط‌خواندنی نصب است'
      : 'هنوز نصب نشده — گام ۹، پس از اطمینان از برش',
    action: isRetired ? null : 'psql -f prisma/manual/2026-08-27-retire-legacy-core.sql',
  });

  // ── جمع‌بندی ──────────────────────────────────────────────
  const blockers = items.filter((i) => i.state === 'FAIL' || i.state === 'UNKNOWN');
  return {
    generatedAt: new Date().toISOString(),
    mode,
    cutoff,
    items,
    blockers: blockers.length,
    /**
     * فقط وقتی درست است که هیچ بندِ `FAIL` یا `UNKNOWN` نمانده باشد.
     * `SKIP` یعنی «هنوز نوبتش نرسیده»، نه «مشکل».
     */
    ready: blockers.length === 0,
  };
}

/** روزِ کاریِ گذشته از آخرین اجرای diff — برای هشدارِ کهنگی */
export const daysSince = (iso: string | null) =>
  iso == null ? null : Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
