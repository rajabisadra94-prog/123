/**
 * ساخت دیتابیس تست، از صفر، پیش از اجرای هر تست.
 *
 * چرا دیتابیس جدا: تست‌ها داده را پاک می‌کنند. اجرای آن‌ها روی factory_dev_db
 * کار توسعه را نابود می‌کند.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import path from 'node:path';
import { TEST_DB_NAME, testDatabaseUrl, adminDatabaseUrl } from './db-url';

const ROOT = path.resolve(__dirname, '../..');

export default async function setup() {
  const admin = new Client({ connectionString: adminDatabaseUrl() });
  await admin.connect();
  try {
    // اتصال‌های باز را ببند، وگرنه DROP DATABASE شکست می‌خورد
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB_NAME],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}"`);
    await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
  } finally {
    await admin.end();
  }

  const url = testDatabaseUrl();

  // prisma مستقیم با node اجرا می‌شود، نه با npx:
  // از Node 20.12 اجرای فایل‌های .cmd با execFile روی ویندوز EINVAL می‌دهد.
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: ROOT, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' },
  );

  // تریگرها و CHECKها جزئی از تعریف دامنه‌اند، نه افزونهٔ اختیاری.
  // Prisma نمی‌تواند بسازدشان، پس دستی اعمال می‌شوند — همان فایل‌هایی که
  // روی سرور هم اجرا می‌شوند، تا تست دقیقاً همان قواعد تولید را بسنجد.
  const MIGRATIONS = [
    'prisma/manual/2026-08-16-journal-balance-trigger.sql', // هستهٔ قدیمی
    'prisma/manual/2026-08-27-gl-core-constraints.sql',     // هستهٔ جدید
  ];

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    for (const rel of MIGRATIONS) {
      await db.query(readFileSync(path.join(ROOT, rel), 'utf8'));
    }
  } finally {
    await db.end();
  }
}
