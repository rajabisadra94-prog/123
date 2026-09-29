/**
 * نوشتن نرخ زندهٔ بازار آزاد در GlExchangeRate — برای cron سیستمی.
 *
 *   npm run ledger:fx-sync
 *
 * حلقهٔ درون‌پروسه‌ای (app.ts) هم همین کار را هر ۶ ساعت می‌کند؛ این برای وقتی
 * است که بخواهی زمان‌بندی مستقل از پروسهٔ اصلی باشد.
 * cron نمونه (هر روز ۲ بامداد و ۲ بعدازظهر):
 *   0 2,14 * * *  cd /opt/fabrik-staging/backend && /usr/bin/npm run ledger:fx-sync >> /var/log/fabrik/gl-fx-sync.log 2>&1
 */
import { syncGlRates } from '../src/modules/ledger/fx-sync';
import prisma from '../src/shared/utils/prisma';

async function main() {
  const r = await syncGlRates({ force: true });
  const stamp = r.date;
  if (r.ok) {
    console.log(`[${stamp}] ثبت شد (${r.source}): ` + r.written.map((w) => `${w.from}→${w.rate}`).join(' , '));
  } else {
    console.warn(`[${stamp}] رد شد: ${r.skipped}`);
  }
  await prisma.$disconnect();
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
