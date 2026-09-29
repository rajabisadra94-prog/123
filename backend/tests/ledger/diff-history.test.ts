/**
 * فاز ۶ نقشهٔ پاریتی — رشتهٔ روزهای پاکِ مقایسهٔ دو هسته (دروازهٔ برش).
 *
 * منطق حساس: یک روز فقط وقتی «پاک» است که **همهٔ** اجراهای آن روز پاک باشند،
 * و شکافِ تقویمی رشته را می‌شکند (یعنی cron باید هر روز اجرا شده باشد).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { streak, recordDiffRun, readDiffHistory, CUTOVER_GATE_DAYS } from '../../src/modules/ledger/diff-history';

const LOG = join(tmpdir(), `ledger-diff-test-${process.pid}.jsonl`);

const line = (ts: string, mismatchCount: number) =>
  JSON.stringify({ ts, mismatchCount, totalBaseDelta: '0', legacyOnlyBase: '0', failing: [] });

const write = (...lines: string[]) => writeFileSync(LOG, lines.join('\n') + '\n', 'utf8');

beforeEach(() => { if (existsSync(LOG)) rmSync(LOG); });
afterAll(() => { if (existsSync(LOG)) rmSync(LOG); });

describe('رشتهٔ روزهای پاک', () => {
  it('فایلِ نبود ⇒ صفر، بدون خطا', () => {
    const s = streak(LOG);
    expect(s.totalRuns).toBe(0);
    expect(s.consecutiveCleanDays).toBe(0);
    expect(s.passesGate).toBe(false);
  });

  it('۷ روز پیاپیِ پاک ⇒ دروازه باز', () => {
    const days = Array.from({ length: 7 }, (_, i) =>
      line(`2026-09-0${i + 1}T02:00:00.000Z`, 0));
    write(...days);
    const s = streak(LOG);
    expect(s.consecutiveCleanDays).toBe(7);
    expect(s.passesGate).toBe(true);
    expect(s.gate).toBe(CUTOVER_GATE_DAYS);
  });

  it('یک اجرای ناهماهنگ در یک روز ⇒ همان روز کثیف، رشته صفر می‌شود', () => {
    write(
      line('2026-09-01T02:00:00.000Z', 0),
      line('2026-09-02T02:00:00.000Z', 0),
      line('2026-09-02T14:00:00.000Z', 3),   // اجرای دوم همان روز — کثیف
      line('2026-09-03T02:00:00.000Z', 0),
    );
    const s = streak(LOG);
    // فقط ۳ سپتامبر پاک است (بعد از ۲ سپتامبرِ کثیف)
    expect(s.consecutiveCleanDays).toBe(1);
    expect(s.days.find((d) => d.date === '2026-09-02')!.clean).toBe(false);
  });

  it('شکافِ تقویمی رشته را می‌شکند — cron باید هر روز بزند', () => {
    write(
      line('2026-09-01T02:00:00.000Z', 0),
      line('2026-09-02T02:00:00.000Z', 0),
      // ۳ سپتامبر جا افتاده
      line('2026-09-04T02:00:00.000Z', 0),
      line('2026-09-05T02:00:00.000Z', 0),
    );
    const s = streak(LOG);
    expect(s.consecutiveCleanDays).toBe(2);   // فقط ۴ و ۵
  });

  it('چند اجرا در روز، همه پاک ⇒ روز پاک', () => {
    write(
      line('2026-09-01T02:00:00.000Z', 0),
      line('2026-09-01T13:00:00.000Z', 0),
      line('2026-09-02T02:00:00.000Z', 0),
    );
    const s = streak(LOG);
    expect(s.consecutiveCleanDays).toBe(2);
    expect(s.daysCovered).toBe(2);
    expect(s.totalRuns).toBe(3);
  });

  it('recordDiffRun ته فایل اضافه می‌کند و خوانده می‌شود', () => {
    recordDiffRun({ ts: '2026-09-01T02:00:00.000Z', mismatchCount: 0, totalBaseDelta: '0', legacyOnlyBase: '0', failing: [] }, LOG);
    recordDiffRun({ ts: '2026-09-02T02:00:00.000Z', mismatchCount: 2, totalBaseDelta: '500', legacyOnlyBase: '0', failing: [{ concept: '1104', label: 'دریافتنی', currency: 'USD', baseDelta: '500', foreignDelta: '1' }] }, LOG);
    const h = readDiffHistory(LOG);
    expect(h).toHaveLength(2);
    expect(h[1].failing[0].currency).toBe('USD');
  });

  it('خطوط خراب نادیده گرفته می‌شوند', () => {
    write(line('2026-09-01T02:00:00.000Z', 0), '{بد', '', line('2026-09-02T02:00:00.000Z', 0));
    expect(readDiffHistory(LOG)).toHaveLength(2);
  });
});
