/**
 * آدرس دیتابیس تست از روی DATABASE_URL ساخته می‌شود — همان سرور و همان کاربر،
 * فقط نام دیتابیس عوض می‌شود. هم vitest.config.ts و هم global-setup از اینجا می‌خوانند
 * تا هرگز دو آدرس متفاوت در دو جا ساخته نشود.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const TEST_DB_NAME = 'factory_ledger_test';
const ROOT = path.resolve(__dirname, '../..');

function baseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) throw new Error('نه DATABASE_URL تعریف شده و نه فایل .env هست');
  const m = readFileSync(envPath, 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m);
  if (!m) throw new Error('DATABASE_URL در .env پیدا نشد');
  return m[1];
}

function withDatabase(name: string): string {
  const u = new URL(baseUrl());
  u.pathname = '/' + name;
  return u.toString();
}

export const testDatabaseUrl = () => withDatabase(TEST_DB_NAME);
export const adminDatabaseUrl = () => withDatabase('postgres');
