// راه‌اندازی اولیهٔ محیط pooyan — فقط یک بار موقع نصب.
//
// عمداً از prisma/seed.ts جدا است: آن‌جا ادمین با رمز ثابت `admin123` ساخته
// می‌شود که برای یک سایت عمومی قابل قبول نیست. این‌جا رمز از متغیر محیطی
// ADMIN_PASSWORD خوانده می‌شود که اسکریپت راه‌اندازی روی سرور تصادفی ساخته
// و در /root/.fabrik/pooyan_admin_pass با دسترسی ۶۰۰ گذاشته است.
//
//   ADMIN_PASSWORD=... ADMIN_USERNAME=... npm run db:seed:pooyan
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { seedMarket } from './market.seed';

const prisma = new PrismaClient();

async function main() {
  const username = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error('ADMIN_PASSWORD تنظیم نشده یا کوتاه است (حداقل ۸ کاراکتر).');
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.log(`کاربر «${username}» از قبل هست — رمزش دست‌نخورده ماند.`);
  } else {
    await prisma.user.create({
      data: {
        name: process.env.ADMIN_NAME || 'مدیر',
        username,
        passwordHash: await bcrypt.hash(password, 10),
        role: 'SUPER_ADMIN',
      },
    });
    console.log(`کاربر «${username}» ساخته شد.`);
  }

  await seedMarket(prisma);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
