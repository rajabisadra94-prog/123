/**
 * بررسیِ پیش‌پروازِ برش پروداکشن — فقط‌خواندنی.
 *
 * `npm run ledger:preflight` — هیچ چیزی نمی‌نویسد. کد خروج ۱ می‌دهد اگر
 * بندی مانع باشد، تا در CI یا اسکریپت هم قابل استفاده باشد.
 */
import prisma from '../src/shared/utils/prisma';
import { cutoverPreflight, type CheckState } from '../src/modules/ledger/preflight';

const MARK: Record<CheckState, string> = {
  PASS: '✓', FAIL: '✗', UNKNOWN: '؟', SKIP: '–',
};

async function main() {
  const cutoffArg = process.argv.find((a) => a.startsWith('--cutoff='));
  const cutoff = cutoffArg ? new Date(cutoffArg.split('=')[1]) : null;

  const r = await cutoverPreflight(prisma, { cutoff });

  console.log('\n  بررسیِ پیش‌پروازِ برش پروداکشن');
  console.log(`  حالت فعلی: ${r.mode}   ·   تاریخ برش: ${r.cutoff.toISOString().slice(0, 10)}`);
  console.log('  ' + '─'.repeat(78));

  for (const it of r.items) {
    console.log(`  ${MARK[it.state]} گام ${it.step.padEnd(5)} ${it.title}`);
    console.log(`      ${it.detail}`);
    if (it.action) console.log(`      ← ${it.action}`);
  }

  console.log('  ' + '─'.repeat(78));
  if (r.ready) {
    console.log('  ✓ همهٔ دروازه‌ها باز است.');
    console.log('    این یعنی پیش‌شرط‌های فنی برقرارند — نه اینکه الان وقت خوبی برای برش است.');
  } else {
    console.log(`  ✗ ${r.blockers} بند مانع است. برش نزنید.`);
    console.log('    بندِ «؟» یعنی نتوانستیم بسنجیم؛ در شک، دروازه بسته می‌ماند.');
  }
  console.log();
  return r.ready ? 0 : 1;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error('بررسی شکست خورد:', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
