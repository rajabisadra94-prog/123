import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { seedMarket } from './market.seed';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create admin user
  const passwordHash = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { username: 'admin@factory.com' },
    update: {},
    create: {
      name: 'مدیر سیستم',
      username: 'admin@factory.com',   // نام کاربری = همان ایمیل قبلی تا ورودِ فعلی نشکند
      email: 'admin@factory.com',
      passwordHash,
      role: 'SUPER_ADMIN',
    },
  });
  console.log(`Created admin: ${admin.username}`);

  // Default system settings (fallback exchange rates)
  await prisma.systemSetting.upsert({
    where: { key: 'FALLBACK_USD_TO_IRR' },
    update: {},
    create: { key: 'FALLBACK_USD_TO_IRR', value: '600000' },
  });
  await prisma.systemSetting.upsert({
    where: { key: 'FALLBACK_CNY_TO_IRR' },
    update: {},
    create: { key: 'FALLBACK_CNY_TO_IRR', value: '85000' },
  });

  // Sample materials
  const materials = ['فولاد ST37', 'فولاد ST52', 'آلومینیوم 6061', 'برنج', 'مس'];
  for (const name of materials) {
    await prisma.material.upsert({ where: { name }, update: {}, create: { name } });
  }

  // Sample coatings
  const coatings = ['رنگ الکترواستاتیک', 'گالوانیزه گرم', 'کروم سخت', 'اکسیداسیون سیاه', 'بدون پوشش'];
  for (const name of coatings) {
    await prisma.coating.upsert({ where: { name }, update: {}, create: { name } });
  }

  // Sample producer categories
  const cats = ['ماشین‌کاری CNC', 'برشکاری لیزر', 'جوشکاری', 'ریخته‌گری', 'پرس‌کاری'];
  for (const name of cats) {
    await prisma.producerCategory.upsert({ where: { name }, update: {}, create: { name } });
  }

  // ماژول بازار صادرات: استان/شهرهای عراق، محصولات و قالب‌های پیام
  await seedMarket(prisma);

  console.log('Seed complete!');
}

main().catch(console.error).finally(() => prisma.$disconnect());
