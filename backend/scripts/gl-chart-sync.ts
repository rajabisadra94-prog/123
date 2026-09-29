/**
 * همگام‌سازی چارت دفترداری پس از هر استقرار — idempotent.
 *
 * **چرا لازم شد:** حسابِ «۱۱۱۰ ذخیرهٔ مطالبات مشکوک‌الوصول» به `chart.ts` اضافه
 * شد، کد و تست‌ها سبز بودند، ولی روی staging گزارش با «حساب ۱۱۱۰ در چارت
 * نیست» شکست — چون چارت فقط با فراخوانیِ دستیِ `POST /ledger/setup` ساخته
 * می‌شود و استقرار آن را صدا نمی‌زد.
 *
 * همان تلهٔ کلاسیک: تغییرِ داده‌ایِ همراهِ تغییرِ کد، که در تست دیده نمی‌شود
 * چون تست‌ها چارت را خودشان می‌سازند. حالا استقرار خودش انجامش می‌دهد.
 *
 * `ensureChart` فقط upsert می‌کند — نه حسابی حذف می‌شود، نه نامی که کاربر
 * عوض کرده بازنویسی. اجرای دوباره بی‌خطر است.
 */
import { PrismaClient } from '@prisma/client';
import { ensureChart } from '../src/modules/ledger/chart';
import { ensureDefaultCostCenters } from '../src/modules/ledger/costcenter';

const prisma = new PrismaClient();

async function main() {
  const before = await prisma.glAccount.count();
  await prisma.$transaction(async (tx) => {
    await ensureChart(tx);
    await ensureDefaultCostCenters(tx);
  }, { timeout: 120_000 });
  const after = await prisma.glAccount.count();
  console.log(`چارت دفترداری همگام شد: ${before} → ${after} حساب`);
}

main()
  .catch((e) => { console.error('همگام‌سازی چارت شکست خورد:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
