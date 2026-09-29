// اجرای مستقلِ دادهٔ پایهٔ ماژول بازار — بدون دست‌زدن به بقیهٔ seed.
// روی سروری که از قبل داده دارد، اجرای seed کامل ریسک ندارد ولی بی‌مورد است؛
// این‌جا فقط استان/شهر، محصولات و قالب‌های پیام upsert می‌شوند.
//   npm run db:seed:market
import { PrismaClient } from '@prisma/client';
import { seedMarket } from './market.seed';

const prisma = new PrismaClient();
seedMarket(prisma)
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
