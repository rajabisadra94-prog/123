import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { upload } from '../../shared/middleware/upload';
import { sendPushToUsers } from '../../shared/utils/push';
import { AppError } from '../../shared/middleware/errorHandler';
import { bus, sseHandler } from './messages.bus';

const router = Router();
router.use(authenticate);   // برای GETها توکن را از query هم می‌پذیرد (لینک دانلود و SSE)

/* ── دانلود پیوست با نام اصلی ──
   فایل روی دیسک نام امنِ غیرقابل‌حدس دارد (CHAT-…)، ولی کاربر باید آن را با نام
   اصلی خودش بگیرد. صفتِ download در <a> برای آدرس cross-origin نادیده گرفته
   می‌شود، پس نام درست باید از هدر Content-Disposition بیاید (کارِ res.download).
   ضمناً برخلاف /uploads که عمومی است، این‌جا فقط دو طرفِ گفتگو دسترسی دارند. */
router.get('/:id/attachment', async (req: Request, res: Response) => {
  const me = req.user!.id;
  const msg = await prisma.message.findUnique({
    where: { id: req.params.id },
    select: { fromUserId: true, toUserId: true, attachmentUrl: true, attachmentName: true, deletedAt: true },
  });
  if (!msg || !msg.attachmentUrl || msg.deletedAt) throw new AppError(404, 'فایل یافت نشد');
  if (msg.fromUserId !== me && msg.toUserId !== me) throw new AppError(403, 'به این فایل دسترسی ندارید');

  const stored = path.basename(msg.attachmentUrl);   // path traversal را می‌بندد
  const abs = path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads', stored);
  if (!fs.existsSync(abs)) throw new AppError(404, 'فایل روی سرور موجود نیست');

  res.download(abs, msg.attachmentName || stored);   // نام اصلی (UTF-8) را خودش انکود می‌کند
});

/* ============================================================
   گفتگو — بازنویسی‌شده
   • لیست مکالمات با ۲ کوئری ثابت (به‌جای ۲×تعداد کاربران)
   • صفحه‌بندی مبتنی بر cursor (بارگذاری پیام‌های قدیمی‌تر)
   • تیک خوانده‌شدن، ویرایش، حذف نرم، پاسخ، جستجو
   • سنجاق پیام به پروژه
   • رویدادهای زنده با SSE (بدون وابستگی جدید)
   ============================================================ */

/** کلید متعارفِ مکالمه — مستقل از اینکه چه کسی فرستنده است */
const convKeyOf = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

const MSG_SELECT = {
  id: true, fromUserId: true, toUserId: true, text: true,
  attachmentUrl: true, attachmentName: true, attachmentMime: true, attachmentSize: true,
  isRead: true, readAt: true, editedAt: true, deletedAt: true, createdAt: true,
  replyToId: true,
  replyTo: { select: { id: true, text: true, fromUserId: true, deletedAt: true } },
} as const;

/* ── جریان زندهٔ رویدادها (SSE) ── */
router.get('/stream', sseHandler);

/* ── آپلود پیوست ──
   نام فایل غیرقابل‌حدس + نگه‌داشتن نام و نوع اصلی برای نمایش درست */
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError(400, 'فایلی ارسال نشده است');
  const ext = path.extname(req.file.originalname).toLowerCase();
  const rand = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
  const safeName = `CHAT-${rand}${ext}`;
  fs.renameSync(req.file.path, path.join(path.dirname(req.file.path), safeName));
  res.json({
    url: `/uploads/${safeName}`,
    name: req.file.originalname,
    mime: req.file.mimetype,
    size: req.file.size,
  });
});

/* ── لیست مکالمات ──
   قبلاً برای هر کاربر ۲ کوئری جدا می‌رفت (N+1). حالا ۳ کوئری ثابت،
   مستقل از تعداد کاربران. */
router.get('/conversations', async (req: Request, res: Response) => {
  const me = req.user!.id;

  const users = await prisma.user.findMany({
    where: { isActive: true, NOT: { id: me } },
    select: { id: true, name: true, avatarUrl: true, role: true },
    orderBy: { name: 'asc' },
  });

  // آخرین پیامِ هر مکالمه — یک کوئری برای همه، با DISTINCT ON روی «طرف مقابل»
  const lasts = await prisma.$queryRaw<Array<{
    peer: string; id: string; text: string; fromUserId: string;
    attachmentUrl: string | null; deletedAt: Date | null; createdAt: Date;
  }>>`
    SELECT DISTINCT ON (peer) peer, id, text, "fromUserId", "attachmentUrl", "deletedAt", "createdAt"
    FROM (
      SELECT CASE WHEN "fromUserId" = ${me} THEN "toUserId" ELSE "fromUserId" END AS peer,
             id, text, "fromUserId", "attachmentUrl", "deletedAt", "createdAt"
      FROM "Message"
      WHERE "fromUserId" = ${me} OR "toUserId" = ${me}
    ) t
    ORDER BY peer, "createdAt" DESC
  `;

  // تعداد نخوانده‌ها — یک groupBy برای همه
  const unreads = await prisma.message.groupBy({
    by: ['fromUserId'],
    where: { toUserId: me, isRead: false, deletedAt: null },
    _count: { _all: true },
  });

  const lastByPeer = new Map(lasts.map((l) => [l.peer, l]));
  const unreadByPeer = new Map(unreads.map((u) => [u.fromUserId, u._count._all]));

  const result = users.map((u) => {
    const l = lastByPeer.get(u.id);
    return {
      user: u,
      lastMessage: l
        ? {
            id: l.id,
            text: l.deletedAt ? 'پیام حذف شد' : l.text,
            fromUserId: l.fromUserId,
            hasAttachment: !!l.attachmentUrl,
            createdAt: l.createdAt,
          }
        : null,
      unread: unreadByPeer.get(u.id) || 0,
    };
  });

  result.sort((a, b) => {
    const ta = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
    const tb = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
    return tb - ta;
  });
  res.json(result);
});

router.get('/unread-count', async (req: Request, res: Response) => {
  const count = await prisma.message.count({
    where: { toUserId: req.user!.id, isRead: false, deletedAt: null },
  });
  res.json({ count });
});

/* ── رشتهٔ گفتگو با صفحه‌بندی ──
   ?before=<messageId>  → یک صفحه قدیمی‌تر (اسکرول به بالا)
   ?limit=<n>           → پیش‌فرض ۵۰، سقف ۱۰۰ */
router.get('/thread/:userId', async (req: Request, res: Response) => {
  const me = req.user!.id;
  const other = req.params.userId;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  const before = req.query.before as string | undefined;

  let cursorFilter = {};
  if (before) {
    const anchor = await prisma.message.findUnique({ where: { id: before }, select: { createdAt: true } });
    if (anchor) cursorFilter = { createdAt: { lt: anchor.createdAt } };
  }

  const where = { convKey: convKeyOf(me, other), ...cursorFilter };

  // یکی بیشتر می‌گیریم تا بفهمیم صفحهٔ قدیمی‌تری هست یا نه
  const rows = await prisma.message.findMany({
    where, orderBy: { createdAt: 'desc' }, take: limit + 1, select: MSG_SELECT,
  });
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).reverse(); // به ترتیب زمانی برای نمایش

  // فقط وقتی صفحهٔ اول است، پیام‌های ورودی خوانده می‌شوند
  if (!before) {
    const unreadIds = messages.filter((m) => m.toUserId === me && !m.isRead).map((m) => m.id);
    if (unreadIds.length) {
      await prisma.message.updateMany({
        where: { id: { in: unreadIds } },
        data: { isRead: true, readAt: new Date() },
      });
      messages.forEach((m) => { if (unreadIds.includes(m.id)) { m.isRead = true; m.readAt = new Date(); } });
      bus.emit(other, { type: 'read', by: me });          // فرستنده تیک را ببیند
      bus.emit(me, { type: 'unread-changed' });
    }
  }

  res.json({ messages, hasMore });
});

/* ── جستجو در پیام‌ها ── */
router.get('/search', async (req: Request, res: Response) => {
  const me = req.user!.id;
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const withUser = req.query.userId as string | undefined;

  const messages = await prisma.message.findMany({
    where: {
      deletedAt: null,
      text: { contains: q, mode: 'insensitive' },
      ...(withUser
        ? { convKey: convKeyOf(me, withUser) }
        : { OR: [{ fromUserId: me }, { toUserId: me }] }),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { ...MSG_SELECT, fromUser: { select: { id: true, name: true } }, toUser: { select: { id: true, name: true } } },
  });
  res.json(messages);
});

/* ── ارسال پیام ── */
router.post('/', async (req: Request, res: Response) => {
  const me = req.user!.id;
  const { toUserId, text, attachmentUrl, attachmentName, attachmentMime, attachmentSize, replyToId } = req.body;

  if (!toUserId) throw new AppError(400, 'گیرنده مشخص نشده است');
  if (!text?.trim() && !attachmentUrl) throw new AppError(400, 'متن یا پیوست لازم است');
  if (toUserId === me) throw new AppError(400, 'ارسال پیام به خود ممکن نیست');

  const recipient = await prisma.user.findFirst({ where: { id: toUserId, isActive: true }, select: { id: true } });
  if (!recipient) throw new AppError(404, 'کاربر گیرنده یافت نشد');

  const msg = await prisma.message.create({
    data: {
      fromUserId: me, toUserId,
      convKey: convKeyOf(me, toUserId),
      text: text?.trim() || '',
      attachmentUrl: attachmentUrl || undefined,
      attachmentName: attachmentName || undefined,
      attachmentMime: attachmentMime || undefined,
      attachmentSize: attachmentSize || undefined,
      replyToId: replyToId || undefined,
    },
    select: MSG_SELECT,
  });

  await prisma.notification.create({
    data: {
      userId: toUserId, type: 'MESSAGE',
      message: `پیام جدید از ${req.user!.name}`,
      entityType: 'Message', entityId: msg.id,
    },
  });
  await sendPushToUsers([toUserId], `پیام از ${req.user!.name}`, msg.text || '📎 پیوست', { type: 'MESSAGE', fromUserId: me });

  bus.emit(toUserId, { type: 'message', message: msg });
  bus.emit(me, { type: 'message', message: msg });
  res.status(201).json(msg);
});

/* ── ویرایش پیام (فقط فرستنده، فقط تا ۱۵ دقیقه) ── */
router.patch('/:id', async (req: Request, res: Response) => {
  const me = req.user!.id;
  const { text } = req.body;
  if (!text?.trim()) throw new AppError(400, 'متن پیام لازم است');

  const existing = await prisma.message.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError(404, 'پیام یافت نشد');
  if (existing.fromUserId !== me) throw new AppError(403, 'فقط فرستنده می‌تواند پیام را ویرایش کند');
  if (existing.deletedAt) throw new AppError(400, 'پیام حذف‌شده قابل ویرایش نیست');
  if (Date.now() - existing.createdAt.getTime() > 15 * 60 * 1000)
    throw new AppError(400, 'مهلت ویرایش (۱۵ دقیقه) گذشته است');

  const msg = await prisma.message.update({
    where: { id: req.params.id },
    data: { text: text.trim(), editedAt: new Date() },
    select: MSG_SELECT,
  });
  bus.emit(existing.toUserId, { type: 'message-updated', message: msg });
  bus.emit(me, { type: 'message-updated', message: msg });
  res.json(msg);
});

/* ── حذف نرم (فقط فرستنده) — رشتهٔ پاسخ‌ها نمی‌شکند ── */
router.delete('/:id', async (req: Request, res: Response) => {
  const me = req.user!.id;
  const existing = await prisma.message.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError(404, 'پیام یافت نشد');
  if (existing.fromUserId !== me) throw new AppError(403, 'فقط فرستنده می‌تواند پیام را حذف کند');

  const msg = await prisma.message.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), text: '', attachmentUrl: null, attachmentName: null, attachmentMime: null },
    select: MSG_SELECT,
  });
  bus.emit(existing.toUserId, { type: 'message-updated', message: msg });
  bus.emit(me, { type: 'message-updated', message: msg });
  res.json(msg);
});

/* ── «در حال تایپ» — فقط رویداد زودگذر، چیزی ذخیره نمی‌شود ── */
router.post('/typing/:userId', async (req: Request, res: Response) => {
  bus.emit(req.params.userId, { type: 'typing', from: req.user!.id });
  res.status(204).end();
});

export default router;
