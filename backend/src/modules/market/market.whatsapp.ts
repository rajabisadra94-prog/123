import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import path from 'path';
import prisma from '../../shared/utils/prisma';
import { AppError } from '../../shared/middleware/errorHandler';
import { requirePermission } from '../../shared/middleware/permissions';
import { upload } from '../../shared/middleware/upload';
import { normalizeIraqPhone, refreshScore } from './market.service';

/**
 * صف پیام واتساپ.
 *
 * ─ چرا این‌طوری و نه ساده‌تر ─────────────────────────────────────────────
 * ۱. لینک `wa.me` هرگز فایل پیوست نمی‌کند؛ پروتکلش فقط `?text=` دارد.
 * ۲. API رسمی متا (Cloud API) تأیید کسب‌وکار و پرداخت می‌خواهد که برای شرکت
 *    ایرانی عملاً بسته است، و از سرور تهران `graph.facebook.com` هم باز نمی‌شود.
 * ۳. کتابخانه‌ای که با خودِ پروتکل واتساپ حرف بزند از سرور کار نمی‌کند، چون
 *    `web.whatsapp.com` از تهران باز نمی‌شود. از لپ‌تاپِ کاربر باز است.
 * ۴. صفحهٔ https هم نمی‌تواند مستقیم به برنامهٔ روی `127.0.0.1` وصل شود —
 *    کروم دسترسی صفحهٔ اینترنتی به شبکهٔ محلی را می‌بندد.
 *
 * پس جهت برعکس شد: صفحه پیام را در همین صف می‌گذارد، و «پلِ» روی لپ‌تاپ
 * هر چند ثانیه سر می‌زند، برمی‌دارد و می‌فرستد. سود جانبی‌اش این است که از
 * گوشی هم می‌شود پیام گذاشت و لپ‌تاپ هر وقت روشن بود می‌فرستدش.
 */

/** آخرین خبری که پل داده. در حافظه است نه دیتابیس — با ری‌استارت سرور، پل ظرف چند ثانیه دوباره خبر می‌دهد. */
type BridgeBeat = {
  at: number;
  status: string;              // starting | qr | connected | logged-out | error
  me?: { number: string; name?: string } | null;
  qr?: string | null;
  sentToday?: number;
  dailyCap?: number;
  minGapMs?: number;
  error?: string | null;
};
let beat: BridgeBeat | null = null;

/** پل بیش از این ساکت بماند یعنی خاموش است */
const BEAT_TTL_MS = 25_000;
const bridgeOnline = () => !!beat && Date.now() - beat.at < BEAT_TTL_MS;

const BRIDGE_KEY_SETTING = 'MARKET_WA_BRIDGE_KEY';

async function getBridgeKey(create = false): Promise<string | null> {
  const row = await prisma.systemSetting.findUnique({ where: { key: BRIDGE_KEY_SETTING } });
  if (row?.value) return row.value;
  if (!create) return null;
  const value = crypto.randomBytes(24).toString('base64url');
  await prisma.systemSetting.upsert({
    where: { key: BRIDGE_KEY_SETTING },
    create: { key: BRIDGE_KEY_SETTING, value },
    update: { value },
  });
  return value;
}

/**
 * احراز هویت پل — با کلید اختصاصی، نه با حساب کاربری.
 *
 * عمداً JWT نیست: پل باید ماه‌ها بدون دخالت کار کند و توکنِ منقضی‌شونده یعنی
 * نگه‌داشتن نام‌کاربری و رمز مدیر در یک فایل روی لپ‌تاپ. این کلید فقط همین سه
 * مسیر را باز می‌کند و از تنظیمات هر لحظه قابل تعویض است.
 */
async function bridgeAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const sent = String(req.headers['x-bridge-key'] || '');
    const real = await getBridgeKey();
    if (!real || !sent) throw new AppError(401, 'کلید پل نامعتبر است');
    const a = Buffer.from(sent);
    const b = Buffer.from(real);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AppError(401, 'کلید پل نامعتبر است');
    next();
  } catch (e) { next(e); }
}

/**
 * مسیرهای پل روی روتر جداگانه‌اند و **پیش از** روتر اصلی سوار می‌شوند، چون
 * روتر اصلیِ market روی همهٔ مسیرهایش `authenticate` می‌گذارد و پل حساب کاربری
 * ندارد — با کلید اختصاصی خودش می‌آید.
 */
export const marketBridgeRouter = Router();

{
  const router = marketBridgeRouter;

  /** پل هر چند ثانیه وضعیتش را می‌گوید و کارهای منتظر را می‌گیرد — یک رفت‌وبرگشت، نه دو تا */
  router.post('/whatsapp/bridge/poll', bridgeAuth, async (req: Request, res: Response) => {
    const b = req.body || {};
    beat = {
      at: Date.now(),
      status: String(b.status || 'starting'),
      me: b.me ?? null,
      qr: b.qr ?? null,
      sentToday: b.sentToday,
      dailyCap: b.dailyCap,
      minGapMs: b.minGapMs,
      error: b.error ?? null,
    };

    // تا وقتی واتساپ وصل نشده، کاری تحویل نمی‌دهیم — وگرنه کار به SENDING
    // می‌رفت و همان‌جا می‌ماند.
    if (beat.status !== 'connected') return res.json({ jobs: [] });

    // یکی‌یکی. فاصلهٔ بین ارسال‌ها را خود پل نگه می‌دارد و تحویل دسته‌ای
    // فقط باعث می‌شد اگر پل وسط کار بسته شود، چند کار در SENDING گیر کنند.
    const job = await prisma.marketWaJob.findFirst({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    if (!job) return res.json({ jobs: [] });

    await prisma.marketWaJob.update({
      where: { id: job.id },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    });
    res.json({
      jobs: [{ id: job.id, phone: job.phone, text: job.text, imageUrl: job.imageUrl, imageName: job.imageName }],
    });
  });

  /** نتیجهٔ ارسال. موفق که شد، خودِ سرور گفت‌وگو را در پروندهٔ مخاطب ثبت می‌کند. */
  router.post('/whatsapp/bridge/result/:id', bridgeAuth, async (req: Request, res: Response) => {
    const { ok, error } = req.body as { ok?: boolean; error?: string };
    const job = await prisma.marketWaJob.findUnique({ where: { id: req.params.id } });
    if (!job) throw new AppError(404, 'کار یافت نشد');

    if (!ok) {
      await prisma.marketWaJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: String(error || 'ارسال نشد').slice(0, 400) },
      });
      return res.json({ ok: true });
    }

    const sentAt = new Date();
    await prisma.marketWaJob.update({ where: { id: job.id }, data: { status: 'SENT', sentAt, error: null } });

    // ثبت خودکار در تایم‌لاین. بدون این، دو هفته بعد هیچ‌کس نمی‌داند برای این
    // مغازه چه فرستاده شده — و همین «فراموش نشدن» کل هدف این ماژول است.
    const contact = await prisma.marketContact.findUnique({
      where: { id: job.contactId }, select: { id: true, firstContactAt: true },
    });
    if (contact) {
      await prisma.marketCall.create({
        data: {
          contactId: job.contactId,
          channel: 'WHATSAPP',
          direction: 'OUT',
          occurredAt: sentAt,
          summary: (job.imageUrl ? '[برگهٔ محصولات فرستاده شد]\n' : '') + job.text,
          createdById: job.createdById,
        },
      });
      await prisma.marketContact.update({
        where: { id: job.contactId },
        data: {
          lastContactAt: sentAt,
          contactAttempts: { increment: 1 },
          ...(contact.firstContactAt ? {} : { firstContactAt: sentAt }),
        },
      });
      await refreshScore(job.contactId);
    }
    res.json({ ok: true });
  });
}

// ══ مسیرهای کاربر — روی روتر اصلی که خودش authenticate دارد ═══════
export function registerWhatsAppRoutes(router: Router) {
  /** وضعیت پل، برای صفحهٔ تنظیمات و دکمهٔ ارسال */
  router.get('/whatsapp/state', async (_req: Request, res: Response) => {
    const [pending, failed] = await Promise.all([
      prisma.marketWaJob.count({ where: { status: { in: ['PENDING', 'SENDING'] } } }),
      prisma.marketWaJob.count({ where: { status: 'FAILED' } }),
    ]);
    if (!bridgeOnline()) return res.json({ status: 'offline', pending, failed });
    res.json({
      status: beat!.status, me: beat!.me, qr: beat!.qr, error: beat!.error,
      sentToday: beat!.sentToday, dailyCap: beat!.dailyCap, minGapMs: beat!.minGapMs,
      lastBeatAgoMs: Date.now() - beat!.at,
      pending, failed,
    });
  });

  /** کلید پل — نمایش و ساخت دوباره */
  router.get('/whatsapp/key', requirePermission('market', 'edit'), async (_req: Request, res: Response) => {
    res.json({ key: await getBridgeKey(true) });
  });
  router.post('/whatsapp/key/rotate', requirePermission('market', 'edit'), async (_req: Request, res: Response) => {
    await prisma.systemSetting.deleteMany({ where: { key: BRIDGE_KEY_SETTING } });
    beat = null;   // پل قدیمی دیگر معتبر نیست
    res.json({ key: await getBridgeKey(true) });
  });

  /** گذاشتن یک پیام در صف. عکس اختیاری است و به‌صورت multipart می‌آید. */
  router.post(
    '/whatsapp/jobs',
    requirePermission('market', 'create'), upload.single('image'),
    async (req: Request, res: Response) => {
      const { contactId, text } = req.body as { contactId?: string; text?: string };
      if (!contactId) throw new AppError(400, 'مخاطب مشخص نشده است');
      const body = String(text || '').trim();
      if (!body && !req.file) throw new AppError(400, 'پیام خالی است');

      const contact = await prisma.marketContact.findUnique({
        where: { id: contactId },
        select: { id: true, name: true, phone: true, whatsapp: true, doNotCall: true },
      });
      if (!contact) throw new AppError(404, 'مخاطب یافت نشد');
      if (contact.doNotCall) throw new AppError(400, 'این مخاطب «دیگر تماس نگیرید» علامت خورده است');

      const phone = normalizeIraqPhone(contact.whatsapp || contact.phone);
      if (!phone) throw new AppError(400, 'شمارهٔ واتساپ معتبری برای این مخاطب ثبت نشده است');

      // پیامِ تکراری در صف، یعنی کاربر دوبار کلیک کرده — نه اینکه واقعاً دو
      // پیام یکسان می‌خواهد. مغازه‌دار دو تا پیام مثل هم گرفتن یعنی اسپم.
      const dup = await prisma.marketWaJob.findFirst({
        where: { contactId, status: { in: ['PENDING', 'SENDING'] } },
        select: { id: true },
      });
      if (dup) throw new AppError(409, 'یک پیام برای همین مخاطب هنوز در صف است');

      const job = await prisma.marketWaJob.create({
        data: {
          contactId, phone, text: body,
          imageUrl: req.file ? '/uploads/' + path.basename(req.file.path) : null,
          imageName: req.file ? req.file.originalname : null,
          createdById: req.user!.id,
        },
      });
      res.status(201).json(job);
    },
  );

  /** پیگیری وضعیت یک پیام — صفحه بعد از ارسال همین را می‌پرسد */
  router.get('/whatsapp/jobs/:id', async (req: Request, res: Response) => {
    const job = await prisma.marketWaJob.findUnique({ where: { id: req.params.id } });
    if (!job) throw new AppError(404, 'کار یافت نشد');
    res.json({ ...job, bridgeOnline: bridgeOnline() });
  });

  /** صف: چه چیزی منتظر است، چه چیزی نرفت */
  router.get('/whatsapp/jobs', async (req: Request, res: Response) => {
    const q = req.query as Record<string, string>;
    const where: any = {};
    if (q.contactId) where.contactId = q.contactId;
    if (q.status) where.status = { in: q.status.split(',').filter(Boolean) };
    res.json(await prisma.marketWaJob.findMany({
      where,
      include: { contact: { select: { id: true, code: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(q.take) || 50, 200),
    }));
  });

  /** تلاش دوباره برای پیامی که نرفت */
  router.post('/whatsapp/jobs/:id/retry', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
    const job = await prisma.marketWaJob.findUnique({ where: { id: req.params.id } });
    if (!job) throw new AppError(404, 'کار یافت نشد');
    if (job.status === 'SENT') throw new AppError(400, 'این پیام قبلاً فرستاده شده است');
    res.json(await prisma.marketWaJob.update({
      where: { id: job.id }, data: { status: 'PENDING', error: null },
    }));
  });

  router.delete('/whatsapp/jobs/:id', requirePermission('market', 'edit'), async (req: Request, res: Response) => {
    const job = await prisma.marketWaJob.findUnique({ where: { id: req.params.id } });
    if (!job) throw new AppError(404, 'کار یافت نشد');
    if (job.status === 'SENT') throw new AppError(400, 'پیام فرستاده‌شده را نمی‌شود از صف برداشت');
    await prisma.marketWaJob.delete({ where: { id: job.id } });
    res.json({ ok: true });
  });
}
