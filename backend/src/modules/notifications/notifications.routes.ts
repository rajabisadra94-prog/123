import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response) => {
  const notifications = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(notifications);
});

router.post('/read-all', async (req: Request, res: Response) => {
  await prisma.notification.updateMany({
    where: { userId: req.user!.id, isRead: false },
    data: { isRead: true },
  });
  res.json({ ok: true });
});

router.patch('/:id/read', async (req: Request, res: Response) => {
  await prisma.notification.update({
    where: { id: req.params.id },
    data: { isRead: true },
  });
  res.json({ ok: true });
});

// ثبت توکن دستگاه برای اعلان Push (اپ اندروید هنگام ورود صدا می‌زند)
router.post('/register-device', async (req: Request, res: Response) => {
  const { token, platform } = req.body as { token?: string; platform?: string };
  if (!token) return res.status(400).json({ message: 'token لازم است' });
  await prisma.deviceToken.upsert({
    where: { token },
    create: { token, platform: platform || 'android', userId: req.user!.id },
    update: { userId: req.user!.id, platform: platform || 'android' },
  });
  res.json({ ok: true });
});

// حذف توکن دستگاه (هنگام خروج از حساب)
router.post('/unregister-device', async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };
  if (token) await prisma.deviceToken.deleteMany({ where: { token, userId: req.user!.id } });
  res.json({ ok: true });
});

export default router;
