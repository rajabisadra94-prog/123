/**
 * مقایسهٔ دو هستهٔ دفترداری — اجرای دستی یا cron شبانه در دورهٔ دونویسی
 * (فاز ۳) و شمارش رشتهٔ روزهای پاک برای دروازهٔ برش prod (فاز ۶).
 *
 *   npm run ledger:diff                عکس فوری روی ترمینال
 *   npm run ledger:diff -- --record    + ثبت در سیاهه + گزارش رشتهٔ روزهای پاک
 *   npm run ledger:diff -- --json      خروجی JSON برای اسکریپت/CI
 *
 * کد خروج: ۰ = دو هسته یکی‌اند · ۱ = اختلاف هست · ۲ = خطای اجرا.
 * cron نمونه (staging، هر شب ۲ بامداد):
 *   0 2 * * *  cd /opt/fabrik-staging/backend && npm run ledger:diff -- --record >> /var/log/ledger-diff.log 2>&1
 */
import { compareCores } from '../src/modules/ledger/diff';
import { recordDiffRun, streak, CUTOVER_GATE_DAYS } from '../src/modules/ledger/diff-history';
import prisma from '../src/shared/utils/prisma';

function fmtRial(s: string): string {
  const neg = s.startsWith('-');
  const abs = (neg ? s.slice(1) : s).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '−' : '') + abs;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const d = await compareCores();

  if (args.has('--record')) {
    recordDiffRun({
      ts: d.generatedAt,
      mismatchCount: d.mismatchCount,
      totalBaseDelta: d.totalBaseDelta,
      legacyOnlyBase: d.legacyOnlyBase,
      failing: d.rows.filter((r) => !r.ok).map((r) => ({
        concept: r.concept, label: r.label, currency: r.currency,
        baseDelta: r.baseDelta, foreignDelta: r.foreignDelta,
      })),
    });
  }

  if (args.has('--json')) {
    console.log(JSON.stringify({ diff: d, streak: args.has('--record') ? streak() : undefined }, null, 2));
    await prisma.$disconnect();
    process.exit(d.mismatchCount > 0 ? 1 : 0);
  }

  console.log(`\n  مقایسهٔ هستهٔ قدیمی ↔ جدید — ${d.generatedAt}\n`);
  console.log('  ' + 'مفهوم'.padEnd(22) + 'ارز'.padEnd(6) + 'قدیمی (ریال)'.padStart(20) + 'جدید (ریال)'.padStart(20) + 'اختلاف'.padStart(18));
  console.log('  ' + '─'.repeat(84));

  for (const r of d.rows) {
    const mark = r.ok ? '  ' : '✗ ';
    console.log(
      mark +
      r.label.padEnd(22) +
      r.currency.padEnd(6) +
      fmtRial(r.legacyBase).padStart(20) +
      fmtRial(r.glBase).padStart(20) +
      fmtRial(r.baseDelta).padStart(18),
    );
  }

  console.log('  ' + '─'.repeat(84));
  console.log(`\n  ردیف ناهماهنگ: ${d.mismatchCount}`);
  console.log(`  مجموع قدرمطلق اختلاف پایه: ${fmtRial(d.totalBaseDelta)} ریال`);
  console.log(`  فقط در هستهٔ قدیمی (نگاشت‌نشده به جدید): ${fmtRial(d.legacyOnlyBase)} ریال`);

  // آنچه از مقایسه بیرون ماند — پنهان نمی‌شود، چون دروازه بدون آن قابل قضاوت نیست
  if (d.excluded.length) {
    console.log(`
  بیرون از مقایسه (فقط در هستهٔ جدید): ${fmtRial(d.excludedBase)} ریال`);
    for (const e of d.excluded) {
      console.log(`    ${e.sourceType.padEnd(18)} ${String(e.entries).padStart(4)} سند  ${fmtRial(e.base).padStart(22)}`);
    }
    console.log('    این‌ها معادلی در هستهٔ قدیمی ندارند (حقوق، چک، تنخواه، ذخایر،');
    console.log('    استهلاک، عملیات نوار فرمان، سند دستی) پس مقایسه‌شان بی‌معناست.');
  }

  if (args.has('--record')) {
    const s = streak();
    const bar = '█'.repeat(Math.min(s.consecutiveCleanDays, CUTOVER_GATE_DAYS))
      + '░'.repeat(Math.max(0, CUTOVER_GATE_DAYS - s.consecutiveCleanDays));
    console.log(`\n  دروازهٔ برش: ${bar}  ${s.consecutiveCleanDays}/${CUTOVER_GATE_DAYS} روز پیاپی پاک` +
      (s.passesGate ? '  ✅ آمادهٔ فاز ۶' : ''));
    console.log(`  سیاهه: ${s.totalRuns} اجرا در ${s.daysCovered} روز — ${s.path}`);
  }
  console.log();

  await prisma.$disconnect();
  process.exit(d.mismatchCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
