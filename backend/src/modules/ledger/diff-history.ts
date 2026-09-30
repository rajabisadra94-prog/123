/**
 * سیاههٔ مقایسهٔ دو هسته در طول زمان — دروازهٔ فاز ۶.
 *
 * `compareCores()` یک عکس فوری می‌دهد؛ برش prod وقتی مجاز است که این عکس
 * **۷ روز پیاپی** پاک بوده باشد (`docs/LEDGER_PARITY_ROADMAP.md` فاز ۶، پیش‌نیاز).
 * cron شبانه روی staging هر شب `npm run ledger:diff -- --record` می‌زند و این
 * فایل رشد می‌کند؛ اینجا رشتهٔ روزهای پاک شمرده می‌شود.
 *
 * فایل JSONL است (یک شیء در هر خط) تا append اتمیک و بی‌نیاز از قفل باشد.
 */
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

/** روزهای پاکِ لازم برای مجوز برش */
export const CUTOVER_GATE_DAYS = 7;

export interface DiffRecord {
  ts: string;
  mismatchCount: number;
  totalBaseDelta: string;
  legacyOnlyBase: string;
  /** فقط ردیف‌های ناهماهنگ — تا فایل بی‌دلیل بزرگ نشود */
  failing: { concept: string; label: string; currency: string; baseDelta: string; foreignDelta: string }[];
}

export interface StreakReport {
  path: string;
  totalRuns: number;
  daysCovered: number;
  /** روزهای تقویمیِ پیاپیِ پاک، از آخرین روزِ ثبت‌شده به عقب */
  consecutiveCleanDays: number;
  gate: number;
  passesGate: boolean;
  firstRun: string | null;
  lastRun: string | null;
  /** آخرین اجرا پاک بود؟ */
  lastClean: boolean | null;
  days: { date: string; runs: number; clean: boolean }[];
}

/** مسیر فایل سیاهه — از `LEDGER_DIFF_LOG` یا پیش‌فرضِ کنار prisma */
export function diffLogPath(): string {
  return process.env.LEDGER_DIFF_LOG
    ? resolve(process.env.LEDGER_DIFF_LOG)
    : resolve(__dirname, '../../../prisma/ledger-diff-history.jsonl');
}

/** یک اجرا را ته فایل اضافه می‌کند */
export function recordDiffRun(rec: DiffRecord, path = diffLogPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
}

export function readDiffHistory(path = diffLogPath()): DiffRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l) as DiffRecord; } catch { return null; }
    })
    .filter((r): r is DiffRecord => r != null && typeof r.mismatchCount === 'number' && typeof r.ts === 'string');
}

const dayKey = (iso: string) => new Date(iso).toISOString().slice(0, 10);
/** روز بعدیِ تقویمی (UTC) */
const nextDay = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

export function streak(path = diffLogPath()): StreakReport {
  const history = readDiffHistory(path).sort((a, b) => a.ts.localeCompare(b.ts));

  const byDay = new Map<string, { runs: number; clean: boolean }>();
  for (const r of history) {
    const k = dayKey(r.ts);
    const cur = byDay.get(k) ?? { runs: 0, clean: true };
    cur.runs += 1;
    // یک روز فقط وقتی پاک است که **همهٔ** اجراهای آن روز پاک باشند
    if (r.mismatchCount !== 0) cur.clean = false;
    byDay.set(k, cur);
  }

  const days = [...byDay.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // از آخرین روزِ ثبت‌شده به عقب، تا اولین شکستِ رشته یا شکافِ تقویمی
  let consecutive = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (!d.clean) break;
    if (i < days.length - 1 && nextDay(d.date) !== days[i + 1].date) break; // شکاف روز
    consecutive += 1;
  }

  return {
    path,
    totalRuns: history.length,
    daysCovered: days.length,
    consecutiveCleanDays: consecutive,
    gate: CUTOVER_GATE_DAYS,
    passesGate: consecutive >= CUTOVER_GATE_DAYS,
    firstRun: history[0]?.ts ?? null,
    lastRun: history[history.length - 1]?.ts ?? null,
    lastClean: history.length ? history[history.length - 1].mismatchCount === 0 : null,
    days,
  };
}
