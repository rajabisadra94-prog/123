// تغییرهای دیتابیس لازم برای نسخهٔ محلی را اعمال می‌کند (بدون وابستگی به مسیر فایل در ویندوز؛ چندبار اجرا بی‌خطر است).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const FILES = ['20260929000000_forwarding_process'];

(async () => {
  for (const name of FILES) {
    const file = path.join(__dirname, '..', 'prisma', 'migrations', name, 'migration.sql');
    if (!fs.existsSync(file)) { console.error(`فایل تغییر دیتابیس پیدا نشد: ${file}`); process.exitCode = 1; continue; }
    const sql = fs.readFileSync(file, 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(stmt);
    console.log(`اعمال شد: ${name}`);
  }
})().catch((e) => { console.error('خطا در اعمال تغییر دیتابیس:', e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
