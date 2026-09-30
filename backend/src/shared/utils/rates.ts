// ─────────────────────────────────────────────────────────────
// سرویس نرخ ارز چندمنبعی — دلار→تومان (بازار آزاد) و دلار→یوآن
// زنجیره: tgju + er-api → ترکیب با نرخ دستی → آخرین نرخ معتبر → پیش‌فرض
// ─────────────────────────────────────────────────────────────
import axios from 'axios';
import prisma from './prisma';

export interface LiveRates {
  USD_TO_IRR: number; // تومان به ازای ۱ دلار
  CNY_TO_IRR: number; // تومان به ازای ۱ یوآن
  USD_TO_CNY: number; // یوآن به ازای ۱ دلار
  source: string;
  fetchedAt: Date;
  isStale: boolean;
}

let cache: LiveRates | null = null;
const TTL_MS = 5 * 60 * 1000;
let lastSnapshotAt = 0;

// دلار بازار آزاد تهران از tgju (قیمت به ریال → تقسیم بر ۱۰ = تومان)
async function fromTgju(): Promise<number> {
  const res = await axios.get(
    'https://api.tgju.org/v1/market/indicator/summary-table-data/price_dollar_rl',
    // tgju از ایران معمولاً ۳ تا ۴ ثانیه طول می‌کشد. با timeout=4000 قبلی، هر نوسان
    // کوچک شبکه باعث رد شدنش می‌شد و نرخ به منبع دیگری می‌افتاد — دقیقاً همان
    // بالا-پایین‌پریدن نرخ دلار در تاریخچه. چون فراخوانی‌ها موازی‌اند و cache دارند،
    // مهلت بلندتر هیچ هزینه‌ای برای کاربر ندارد.
    { timeout: 10000 },
  );
  const row: string[] = res.data?.data?.[0];
  if (!Array.isArray(row)) throw new Error('tgju: bad shape');
  const nums = row.slice(0, 4)
    .map((c) => parseFloat(String(c).replace(/[^0-9.]/g, '')))
    .filter((v) => isFinite(v) && v > 200000);
  const rial = nums[3] ?? nums[nums.length - 1];
  if (!rial) throw new Error('tgju: bad value');
  return rial / 10;
}

// نرخ تتر (≈ دلار آزاد) از tetherland — قیمت مستقیم به تومان
async function fromTetherland(): Promise<number> {
  const res = await axios.get('https://api.tetherland.com/currencies', { timeout: 8000 });
  const toman = Number(res.data?.data?.currencies?.USDT?.price);
  if (!isFinite(toman) || toman < 20000) throw new Error('tetherland: bad value');
  return toman;
}

/**
 * دلار→تومان: هر دو منبع را **موازی** صدا می‌زند و اولین پاسخ معتبر را برمی‌دارد.
 * قبلاً زنجیره‌ای بود؛ چون tgju از کار افتاده و ۷ ثانیه timeout می‌خورد، هر
 * «به‌روزرسانی» ۷ ثانیه معطل می‌ماند و کاربر فکر می‌کرد دکمه کار نمی‌کند.
 */
async function fetchUsdIrr(): Promise<{ value: number; src: string }> {
  const attempts: Promise<{ value: number; src: string }>[] = [
    fromTgju().then((value) => ({ value, src: 'tgju' })),
    fromTetherland().then((value) => ({ value, src: 'tetherland' })),
  ];
  const settled = await Promise.allSettled(attempts);
  // tgju (بازار آزاد) بر tetherland (تتر) اولویت دارد چون به نرخ حواله نزدیک‌تر است
  for (const s of settled) if (s.status === 'fulfilled') return s.value;
  throw new Error('هیچ منبع نرخ دلار در دسترس نیست');
}

// دلار→یوآن از er-api (بدون کلید)
async function fromErApi(): Promise<number> {
  const res = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 6000 });
  const cny = Number(res.data?.rates?.CNY);
  if (!isFinite(cny) || cny < 1 || cny > 20) throw new Error('er-api: bad value');
  return cny;
}

async function manualRates(): Promise<{ usdIrr: number; cnyIrr: number }> {
  const [u, c] = await Promise.all([
    prisma.systemSetting.findUnique({ where: { key: 'FALLBACK_USD_TO_IRR' } }),
    prisma.systemSetting.findUnique({ where: { key: 'FALLBACK_CNY_TO_IRR' } }),
  ]);
  return { usdIrr: u ? parseFloat(u.value) : 0, cnyIrr: c ? parseFloat(c.value) : 0 };
}

async function lastKnown(): Promise<LiveRates | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: 'LAST_RATES_JSON' } });
  if (!row) return null;
  try {
    const j = JSON.parse(row.value);
    return { ...j, fetchedAt: new Date(j.fetchedAt), source: 'last-known', isStale: true };
  } catch { return null; }
}

async function persist(r: LiveRates) {
  try {
    await prisma.systemSetting.upsert({
      where: { key: 'LAST_RATES_JSON' },
      create: { key: 'LAST_RATES_JSON', value: JSON.stringify(r) },
      update: { value: JSON.stringify(r) },
    });
    if (Date.now() - lastSnapshotAt > 10 * 60 * 1000) {
      lastSnapshotAt = Date.now();
      await prisma.exchangeRateSnapshot.create({
        data: { usdToIrr: r.USD_TO_IRR, cnyToIrr: r.CNY_TO_IRR, usdToCny: r.USD_TO_CNY, source: r.source },
      });
    }
  } catch { /* persistence is best-effort */ }
}

export async function getRates(force = false): Promise<LiveRates> {
  // S1 — حالت «دستی»: مستقیماً از نرخ واردشده استفاده کن (بدون فراخوانی API)
  const modeRow = await prisma.systemSetting.findUnique({ where: { key: 'RATE_MODE' } });
  if (modeRow?.value === 'MANUAL') {
    const m = await manualRates();
    if (m.usdIrr && m.cnyIrr) {
      return { USD_TO_IRR: m.usdIrr, CNY_TO_IRR: m.cnyIrr, USD_TO_CNY: m.usdIrr / m.cnyIrr, source: 'دستی (تنظیمات)', fetchedAt: new Date(), isStale: false };
    }
    // اگر نرخ دستی کامل واردنشده باشد، به‌ناچار از API استفاده می‌شود
  }

  if (!force && cache && Date.now() - cache.fetchedAt.getTime() < TTL_MS) return cache;

  let usdIrr = 0, usdCny = 0;
  const srcs: string[] = [];
  const [irr, erapi] = await Promise.allSettled([fetchUsdIrr(), fromErApi()]);
  if (irr.status === 'fulfilled') { usdIrr = irr.value.value; srcs.push(irr.value.src); }
  if (erapi.status === 'fulfilled') { usdCny = erapi.value; srcs.push('er-api'); }

  if (usdIrr && usdCny) {
    cache = { USD_TO_IRR: usdIrr, USD_TO_CNY: usdCny, CNY_TO_IRR: usdIrr / usdCny, source: srcs.join('+'), fetchedAt: new Date(), isStale: false };
    await persist(cache);
    return cache;
  }

  // ── موفقیت جزئی ──
  // قاعدهٔ کلیدی: نرخِ «بازار» و نرخِ «دستی» دو چیزِ متفاوت‌اند (نوع خرید ارز فرق
  // می‌کند و اختلافشان می‌تواند چندبرابر باشد). پس یک قطعیِ چندثانیه‌ایِ شبکه
  // هرگز نباید بی‌صدا نوعِ نرخ را عوض کند — این نرخ روی rateToIRR هر سطر سند
  // مهر می‌شود و دفتر را خراب می‌کند.
  // ترتیب درست: آخرین نرخِ *بازار* (با علامت کهنه) → و فقط در نبودِ آن، نرخ دستی.
  const manual = await manualRates();
  const known = await lastKnown();
  const knownFresh = known && Date.now() - known.fetchedAt.getTime() < 48 * 3600 * 1000 ? known : null;

  if (usdIrr && !usdCny) {
    // دلار→تومانِ بازار را داریم، فقط دلار→یوآن نیامده
    const cny = knownFresh?.USD_TO_CNY || (manual.usdIrr && manual.cnyIrr ? manual.usdIrr / manual.cnyIrr : 0);
    if (cny) {
      cache = { USD_TO_IRR: usdIrr, USD_TO_CNY: cny, CNY_TO_IRR: usdIrr / cny,
        source: `${srcs.join('+') || 'market'}+آخرین‌نرخ`, fetchedAt: new Date(), isStale: true };
      await persist(cache);
      return cache;
    }
  }

  if (!usdIrr) {
    // نرخ بازار نیامده: به آخرین نرخِ بازار برمی‌گردیم، نه به نرخ دستی
    if (knownFresh) {
      cache = { ...knownFresh, USD_TO_CNY: usdCny || knownFresh.USD_TO_CNY,
        source: 'آخرین نرخ بازار (کهنه)', isStale: true };
      return cache;
    }
  }

  // آخرین چاره — نرخ دستی، ولی صریحاً «کهنه/دستی» علامت می‌خورد تا در رابط دیده شود
  if (manual.usdIrr && manual.cnyIrr) {
    cache = { USD_TO_IRR: manual.usdIrr, CNY_TO_IRR: manual.cnyIrr, USD_TO_CNY: manual.usdIrr / manual.cnyIrr,
      source: 'نرخ دستی (بازار در دسترس نیست)', fetchedAt: new Date(), isStale: true };
    return cache;
  }
  cache = { USD_TO_IRR: 100000, CNY_TO_IRR: 14000, USD_TO_CNY: 7.15, source: 'default', fetchedAt: new Date(), isStale: true };
  return cache;
}

/**
 * نرخ بدون بلاک‌شدن روی API خارجی — برای صفحات پرترافیک مثل داشبورد (رفع SF4).
 * cache تازه یا نرخ دستی یا آخرین نرخ معتبر یا پیش‌فرض را فوراً برمی‌گرداند و در پس‌زمینه تازه می‌کند.
 */
export async function getCachedRates(): Promise<LiveRates> {
  const modeRow = await prisma.systemSetting.findUnique({ where: { key: 'RATE_MODE' } });
  if (modeRow?.value === 'MANUAL') {
    const m = await manualRates();
    if (m.usdIrr && m.cnyIrr) return { USD_TO_IRR: m.usdIrr, CNY_TO_IRR: m.cnyIrr, USD_TO_CNY: m.usdIrr / m.cnyIrr, source: 'دستی (تنظیمات)', fetchedAt: new Date(), isStale: false };
  }
  if (cache && Date.now() - cache.fetchedAt.getTime() < TTL_MS) return cache;
  // تازه‌سازی در پس‌زمینه بدون انتظار (تا فراخوانی بعدی cache گرم باشد)
  void getRates(false).catch(() => { /* best-effort */ });
  if (cache) return cache;
  const known = await lastKnown();
  return known || { USD_TO_IRR: 100000, CNY_TO_IRR: 14000, USD_TO_CNY: 7.15, source: 'default', fetchedAt: new Date(), isStale: true };
}

/** تبدیل مبلغ بین دو ارز با نرخ‌های داده‌شده */
export function convertAmount(amount: number, from: string, to: string, r: LiveRates): number {
  if (from === to) return amount;
  const irr = from === 'IRR' ? amount : from === 'USD' ? amount * r.USD_TO_IRR : amount * r.CNY_TO_IRR;
  return to === 'IRR' ? irr : to === 'USD' ? irr / r.USD_TO_IRR : irr / r.CNY_TO_IRR;
}
