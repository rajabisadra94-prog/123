import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { readFileSync } from 'fs';
import { join } from 'path';

dotenv.config();

import { errorHandler } from './shared/middleware/errorHandler';
import { auditMiddleware } from './shared/middleware/auditMiddleware';
import authRoutes from './modules/users/auth.routes';
import userRoutes from './modules/users/user.routes';
import settingsRoutes from './modules/settings/settings.routes';
import projectRoutes from './modules/projects/project.routes';
import technicalRoutes from './modules/technical-review/technical.routes';
import pricingRoutes from './modules/pricing/pricing.routes';
import invoicingRoutes from './modules/invoicing/invoicing.routes';
import ordersRoutes from './modules/orders/orders.routes';
import shippingRoutes from './modules/shipping/shipping.routes';
import forwardingRoutes from './modules/forwarding/forwarding.routes';
import accountingRoutes from './modules/accounting/accounting.routes';
import ledgerRoutes from './modules/ledger/ledger.routes';
import { startFxSyncLoop } from './modules/ledger/fx-sync';
import tasksRoutes from './modules/tasks/tasks.routes';
import notificationsRoutes from './modules/notifications/notifications.routes';
import commentsRoutes from './modules/comments/comments.routes';
import archiveRoutes from './modules/archive/archive.routes';
import auditLogRoutes from './modules/audit-log/auditLog.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import notesRoutes from './modules/notes/notes.routes';
import messagesRoutes from './modules/messages/messages.routes';
import feedbackRoutes from './modules/feedback/feedback.routes';
import crmRoutes from './modules/crm/crm.routes';
import marketRoutes from './modules/market/market.routes';
import { marketBridgeRouter } from './modules/market/market.whatsapp';
import vendorsRoutes from './modules/vendors/vendors.routes';

const app = express();
const PORT = process.env.PORT || 3001;

// پشت Nginx/پراکسی: IP واقعی کاربر (برای rate-limit) از X-Forwarded-For خوانده شود
app.set('trust proxy', 1);

// هدرهای امنیتی. CSP روی API لازم نیست (SPA جدا سرو می‌شود)؛
// CORP روی cross-origin تا <img>/دانلودِ فایل‌های /uploads از دامنهٔ فرانت لود شود.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// فشرده‌سازی پاسخ‌ها — به‌جز جریان زندهٔ SSE که نباید بافر/فشرده شود
app.use(compression({
  filter: (req, res) => {
    if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));

// CORS — دامنه‌های مجاز از env (چند مورد با کاما جدا)، پیش‌فرض توسعه.
// روی تولید اگر CORS_ORIGIN تنظیم نشده باشد، پیش‌فرضِ localhost یعنی مرورگرِ
// کاربران همهٔ درخواست‌ها را بلاک می‌کند و سامانه «بی‌دلیل» کار نمی‌کند —
// خطایی که در کنسول مرورگر پیدا می‌شود نه در لاگ سرور. پس همان ابتدا بلند فریاد بزند.
const IS_PROD = process.env.NODE_ENV === 'production';
if (IS_PROD && !process.env.CORS_ORIGIN) {
  console.error('✗ CORS_ORIGIN تنظیم نشده است. روی تولید باید دامنهٔ واقعی فرانت را بدهید (مثلاً https://app.example.com).');
  process.exit(1);
}
if (IS_PROD && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  console.error('✗ JWT_SECRET تنظیم نشده یا کوتاه است. یک رشتهٔ تصادفیِ حداقل ۳۲ کاراکتری بگذارید: openssl rand -hex 32');
  process.exit(1);
}
const CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

// بدنهٔ JSON کوچک نگه داشته می‌شود؛ آپلودهای بزرگ از multipart (multer) می‌روند نه این‌جا
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// health check سبک برای Nginx/uptime — پیش از rate-limit تا محدود نشود
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// نسخهٔ در حال اجرا — برای اینکه بدون SSH بشود فهمید روی سرور چه چیزی بالاست.
// GIT_COMMIT و BUILD_TIME را اسکریپت استقرار موقع انتشار ست می‌کند.
// package.json بیرون از rootDir است، پس به‌جای import (که کامپایل را می‌شکند)
// یک بار موقع بالا آمدن از فایل خوانده می‌شود.
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version as string;
  } catch {
    return process.env.npm_package_version || 'unknown';
  }
})();

app.get('/api/version', (_req, res) => res.json({
  version: APP_VERSION,
  commit: process.env.GIT_COMMIT || null,
  builtAt: process.env.BUILD_TIME || null,
  env: process.env.NODE_ENV || 'development',
  startedAt: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
}));

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads')));

// محدودیت نرخِ ورود — جلوگیری از brute-force روی رمز (سخت‌گیرانه)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 30, // هر IP در ۱۵ دقیقه
  standardHeaders: true, legacyHeaders: false,
  message: { message: 'تلاش‌های زیاد برای ورود. لطفاً چند دقیقه بعد دوباره امتحان کنید.' },
});
app.use('/api/auth', authLimiter);

// محدودیت نرخِ عمومی — سپر در برابر سیل درخواست/حلقهٔ خراب (سخاوتمند، بدون مزاحمت کاربر عادی)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT) || 1000, // هر IP در دقیقه
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path === '/messages/stream', // اتصال بلندمدت SSE استثناست
  message: { message: 'درخواست‌های بیش از حد. کمی صبر کنید.' },
});
app.use('/api', apiLimiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/technical-review', technicalRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/invoicing', invoicingRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/shipping', shippingRoutes);
app.use('/api/forwarding', forwardingRoutes);
app.use('/api/accounting', accountingRoutes);
// هستهٔ جدید دفترداری — موازی با accounting تا پایان مهاجرت
app.use('/api/ledger', ledgerRoutes);
app.use('/api/tasks', tasksRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/archive', archiveRoutes);
app.use('/api/audit-log', auditLogRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/messages', messagesRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/crm', crmRoutes);
// پیش از marketRoutes: آن روتر روی همهٔ مسیرهایش authenticate می‌گذارد و پلِ
// واتساپ حساب کاربری ندارد — با کلید اختصاصی خودش می‌آید.
app.use('/api/market', marketBridgeRouter);
app.use('/api/market', marketRoutes);
app.use('/api/vendors', vendorsRoutes);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Factory System API running on http://localhost:${PORT}`);
  // تغذیهٔ خودکار نرخ ارز هستهٔ جدید — هر ۶ ساعت، بی‌اثر تا وقتی چارت ساخته نشده
  startFxSyncLoop();
});

export default app;
