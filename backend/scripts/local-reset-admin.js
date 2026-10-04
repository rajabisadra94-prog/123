// فقط برای دیتابیس محلی: رمز کاربر admin@factory.com را روی admin123 می‌گذارد (ایجاد می‌کند اگر نبود).
require('dotenv').config();
const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const passwordHash = await bcrypt.hash('admin123', 10);
  const u = await prisma.user.findUnique({ where: { email: 'admin@factory.com' } });
  if (u) await prisma.user.update({ where: { id: u.id }, data: { passwordHash } });
  else console.log('کاربر admin@factory.com در دیتابیس نبود؛ با یکی از کاربران دیتابیس وارد شوید.');
  console.log('رمز ورود محلی: admin@factory.com / admin123');
})().finally(() => prisma.$disconnect());
