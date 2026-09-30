/**
 * تغذیهٔ خودکار جدول نرخ ارز هستهٔ جدید (`GlExchangeRate`).
 *
 * پیش از این، تنها نویسندهٔ این جدول `POST /ledger/fx/rates` دستی بود؛ یعنی
 * لحظه‌ای که `LEDGER_PRIMARY=new` شود، هر فاکتور/تسویهٔ ارزیِ بدون نرخِ صریح با
 * «نرخ … ثبت نشده است» می‌شکند (`resolveRate` عمداً پیش‌فرض نمی‌گذارد).
 *
 * این ماژول همان منبعِ زندهٔ هستهٔ قدیمی (`getRates()` — بازار آزاد تهران) را
 * روزی چند بار در `GlExchangeRate` می‌نویسد، با `source: 'AUTO'` تا نرخِ دستیِ
 * حسابدار هرگز بازنویسی نشود (کلید یکتا `[from,to,date,source]`).
 *
 * واحد: `getRates()` تومان می‌دهد، هستهٔ جدید ریال ⇒ **×۱۰**.
 */
import axios from 'axios';
import { Prisma } from '@prisma/client';
import prisma from '../../shared/utils/prisma';
import { getRates } from '../../shared/utils/rates';

export const GL_AUTO_SOURCE = 'AUTO';
export const GL_BACKFILL_SOURCE = 'BACKFILL';

/** فقط منبعِ واقعیِ بازار پذیرفته است — «default»/«دستی»/«کهنه» نباید در دفتر بنشیند */
const GENUINE_SOURCE = /tgju|tetherland|er-api/i;

const dayOnly = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/** نرخ‌های متقاطعِ دلار از er-api (بی‌کلید) — برای درهم که در getRates نیست */
async function usdCrosses(): Promise<{ AED?: number; CNY?: number }> {
  try {
    const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 8000 });
    const r = res.data?.rates ?? {};
    const out: { AED?: number; CNY?: number } = {};
    if (Number.isFinite(r.AED) && r.AED > 1 && r.AED < 10) out.AED = r.AED;     // ~۳٫۶۷
    if (Number.isFinite(r.CNY) && r.CNY > 3 && r.CNY < 12) out.CNY = r.CNY;     // ~۷٫۲
    return out;
  } catch {
    return {};
  }
}

export interface SyncResult {
  ok: boolean;
  date: string;
  source: string;
  written: { from: string; to: string; rate: string }[];
  skipped?: string;
}

/**
 * نرخ‌های امروز را از منبع زنده می‌گیرد و به‌ازای هر ارزِ فعالِ غیرپایه یک ردیف
 * `AUTO` برای **امروز** upsert می‌کند.
 */
export async function syncGlRates(opts: { date?: Date; force?: boolean } = {}): Promise<SyncResult> {
  const date = dayOnly(opts.date ?? new Date());
  const iso = date.toISOString().slice(0, 10);

  const base = await prisma.glCurrency.findFirst({ where: { isBase: true } });
  if (!base) return { ok: false, date: iso, source: '-', written: [], skipped: 'ارز پایه تعریف نشده' };

  const live = await getRates(opts.force ?? true);
  if (!GENUINE_SOURCE.test(live.source)) {
    return { ok: false, date: iso, source: live.source, written: [], skipped: `منبع زنده در دسترس نیست (${live.source})` };
  }

  const usdRial = live.USD_TO_IRR * 10;
  const cnyRial = live.CNY_TO_IRR * 10;
  const crosses = await usdCrosses();

  const wanted: Record<string, number> = { USD: usdRial, CNY: cnyRial };
  if (crosses.AED && crosses.AED > 0) wanted.AED = usdRial / crosses.AED;

  // فقط ارزهایی که در چارت فعال‌اند
  const active = new Set(
    (await prisma.glCurrency.findMany({ where: { isActive: true } })).map((c) => c.code),
  );

  const written: SyncResult['written'] = [];
  for (const [from, rialPerUnit] of Object.entries(wanted)) {
    if (from === base.code || !active.has(from) || !(rialPerUnit > 0)) continue;
    const rate = new Prisma.Decimal(rialPerUnit.toFixed(4));
    await prisma.glExchangeRate.upsert({
      where: { from_to_date_source: { from, to: base.code, date, source: GL_AUTO_SOURCE } },
      update: { rate },
      create: { from, to: base.code, date, rate, source: GL_AUTO_SOURCE },
    });
    written.push({ from, to: base.code, rate: rate.toString() });
  }

  return { ok: written.length > 0, date: iso, source: live.source, written };
}

/**
 * پُرکردن یک‌بارهٔ تاریخچه از `ExchangeRateSnapshot` هستهٔ قدیمی.
 *
 * برای هر روزِ تقویمی، آخرین snapshot همان روز برداشته می‌شود (منبع = `BACKFILL`).
 * درهم در snapshot‌ها نیست، پس فقط USD و CNY پر می‌شوند.
 */
export async function backfillGlRatesFromSnapshots(): Promise<{ days: number; rows: number; from: string | null; to: string | null }> {
  const base = await prisma.glCurrency.findFirstOrThrow({ where: { isBase: true } });
  const snaps = await prisma.exchangeRateSnapshot.findMany({ orderBy: { createdAt: 'asc' } });
  if (!snaps.length) return { days: 0, rows: 0, from: null, to: null };

  // آخرین snapshot هر روز
  const byDay = new Map<string, typeof snaps[number]>();
  for (const s of snaps) byDay.set(s.createdAt.toISOString().slice(0, 10), s);

  let rows = 0;
  const days = [...byDay.keys()].sort();
  for (const key of days) {
    const s = byDay.get(key)!;
    const date = dayOnly(new Date(`${key}T00:00:00Z`));
    for (const [from, tomanPerUnit] of [['USD', Number(s.usdToIrr)], ['CNY', Number(s.cnyToIrr)]] as const) {
      if (!(tomanPerUnit > 0)) continue;
      const rate = new Prisma.Decimal((tomanPerUnit * 10).toFixed(4));
      await prisma.glExchangeRate.upsert({
        where: { from_to_date_source: { from, to: base.code, date, source: GL_BACKFILL_SOURCE } },
        update: { rate },
        create: { from, to: base.code, date, rate, source: GL_BACKFILL_SOURCE },
      });
      rows++;
    }
  }
  return { days: days.length, rows, from: days[0], to: days[days.length - 1] };
}

// ───────────────────────────────────────────────────────────────
// حلقهٔ درون‌پروسه‌ای — تضمین می‌کند حتی بدون cron سیستمی هم نرخ نوشته شود
// ───────────────────────────────────────────────────────────────

let loopTimer: NodeJS.Timeout | null = null;
const LOOP_INTERVAL_MS = 6 * 60 * 60 * 1000;   // هر ۶ ساعت

/** از `app.ts` صدا زده می‌شود؛ اگر هستهٔ جدید راه‌اندازی نشده باشد بی‌اثر است */
export function startFxSyncLoop(): void {
  if (loopTimer || process.env.GL_FX_SYNC_DISABLED === 'true') return;

  const tick = async () => {
    try {
      const ready = await prisma.glCurrency.count();
      if (ready === 0) return;   // چارت هنوز نیست
      const r = await syncGlRates({ force: false });
      if (r.ok) {
        console.log(`[gl-fx-sync] ${r.date}: ${r.written.map((w) => `${w.from}→${w.rate}`).join(' , ')} (${r.source})`);
      } else {
        console.warn(`[gl-fx-sync] رد شد: ${r.skipped}`);
      }
    } catch (e: any) {
      console.warn(`[gl-fx-sync] خطا: ${e?.message ?? e}`);
    }
  };

  // اجرای اول با تأخیرِ کوتاه تا استارتاپ را کند نکند
  setTimeout(tick, 15_000);
  loopTimer = setInterval(tick, LOOP_INTERVAL_MS);
  loopTimer.unref?.();
}
