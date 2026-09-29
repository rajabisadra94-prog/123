import { defineConfig } from 'vitest/config';
import { testDatabaseUrl } from './tests/helpers/db-url';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/helpers/global-setup.ts'],
    // globalSetup در پروسهٔ دیگری اجرا می‌شود و process.env آن به worker ها نمی‌رسد؛
    // پس آدرس دیتابیس تست همین‌جا تزریق می‌شود.
    env: { DATABASE_URL: testDatabaseUrl() },
    // همهٔ تست‌ها روی یک دیتابیس مشترک کار می‌کنند؛ موازی‌سازی تداخل داده می‌سازد.
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
