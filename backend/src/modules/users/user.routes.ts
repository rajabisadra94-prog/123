import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import prisma from '../../shared/utils/prisma';
import { authenticate, requireRole } from '../../shared/middleware/auth';
import { AppError } from '../../shared/middleware/errorHandler';
import { normalizeUsername } from './auth.routes';

const router = Router();
router.use(authenticate);

// Lightweight list for mentions / task assignment (any authenticated user)
router.get('/list', async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, name: true, avatarUrl: true },
    orderBy: { name: 'asc' },
  });
  res.json(users);
});

router.get('/', requireRole('SUPER_ADMIN', 'MANAGER'), async (_req, res) => {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, username: true, email: true, role: true, phone: true, isActive: true, projectAccessMode: true, createdAt: true },
    orderBy: { name: 'asc' },
  });
  res.json(users);
});

router.post('/', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { name, username, email, password, role, phone } = req.body;
  if (!name || !username || !password) throw new AppError(400, 'نام، نام کاربری و رمز عبور الزامی است');

  const uname = normalizeUsername(username);
  if (!uname) throw new AppError(400, 'نام کاربری نمی‌تواند خالی باشد');
  if (await prisma.user.findUnique({ where: { username: uname } })) {
    throw new AppError(409, 'این نام کاربری قبلاً استفاده شده است');
  }

  // ایمیل اختیاری است؛ اگر داده شد باید یکتا باشد
  const mail = email?.trim() ? normalizeUsername(email) : null;
  if (mail && await prisma.user.findUnique({ where: { email: mail } })) {
    throw new AppError(409, 'این ایمیل قبلاً استفاده شده است');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, username: uname, email: mail, passwordHash, role: role || 'PROJECT_MANAGER', phone },
    select: { id: true, name: true, username: true, email: true, role: true, phone: true, isActive: true },
  });
  res.status(201).json(user);
});

router.patch('/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { name, username, email, role, phone, isActive, password } = req.body;
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw new AppError(404, 'کاربر یافت نشد');

  const data: any = {};
  if (name !== undefined) data.name = name;
  if (role !== undefined) data.role = role;
  if (phone !== undefined) data.phone = phone;
  if (isActive !== undefined) data.isActive = isActive;
  if (password) data.passwordHash = await bcrypt.hash(password, 10);

  if (username !== undefined) {
    const uname = normalizeUsername(username);
    if (!uname) throw new AppError(400, 'نام کاربری نمی‌تواند خالی باشد');
    if (uname !== target.username) {
      if (await prisma.user.findUnique({ where: { username: uname } })) {
        throw new AppError(409, 'این نام کاربری قبلاً استفاده شده است');
      }
      data.username = uname;
    }
  }

  if (email !== undefined) {
    const mail = email?.trim() ? normalizeUsername(email) : null;
    if (mail !== target.email) {
      if (mail && await prisma.user.findUnique({ where: { email: mail } })) {
        throw new AppError(409, 'این ایمیل قبلاً استفاده شده است');
      }
      data.email = mail;
    }
  }

  const user = await prisma.user.update({
    where: { id: req.params.id },
    data,
    select: { id: true, name: true, username: true, email: true, role: true, phone: true, isActive: true },
  });
  res.json(user);
});

// ─── دسترسی کاربر به پروژه‌ها ───
router.get('/:id/projects', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { projectAccessMode: true } });
  if (!user) throw new AppError(404, 'کاربر یافت نشد');
  const members = await prisma.projectMember.findMany({ where: { userId: req.params.id }, select: { projectId: true } });
  res.json({ mode: user.projectAccessMode, projectIds: members.map((m) => m.projectId) });
});

router.put('/:id/projects', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { mode, projectIds } = req.body; // mode: ALL | NONE | SPECIFIC
  if (!['ALL', 'NONE', 'SPECIFIC'].includes(mode)) throw new AppError(400, 'حالت دسترسی نامعتبر است');
  await prisma.user.update({ where: { id: req.params.id }, data: { projectAccessMode: mode } });
  await prisma.projectMember.deleteMany({ where: { userId: req.params.id } });
  if (mode === 'SPECIFIC' && Array.isArray(projectIds) && projectIds.length) {
    await prisma.projectMember.createMany({
      data: projectIds.map((pid: string) => ({ userId: req.params.id, projectId: pid })),
      skipDuplicates: true,
    });
  }
  res.json({ ok: true });
});

export default router;
