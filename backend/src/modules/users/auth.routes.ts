import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import prisma from '../../shared/utils/prisma';
import { AppError } from '../../shared/middleware/errorHandler';
import { authenticate } from '../../shared/middleware/auth';
import { upload } from '../../shared/middleware/upload';

const router = Router();

/** نام کاربری همیشه کوچک و بدون فاصلهٔ اضافه — تا «Ali» و «ali» یک نفر باشند */
export const normalizeUsername = (v: string) => v.trim().toLowerCase();

router.post('/login', async (req: Request, res: Response) => {
  // `email` برای سازگاری با نسخه‌های قدیمی کلاینت (اپ اندروید نصب‌شده) هم پذیرفته می‌شود
  const identifier: string | undefined = req.body.username ?? req.body.email;
  const { password } = req.body;
  if (!identifier || !password) throw new AppError(400, 'نام کاربری و رمز عبور الزامی است');

  // ورود با هر شناسه‌ای: نام کاربری، ایمیل یا شمارهٔ تماس.
  // به ترتیب اولویت و جداگانه جستجو می‌شود — نه با یک OR — چون:
  //  ۱) username و email یکتا هستند ولی phone نیست؛ یک OR ممکن است چند کاربر را
  //     بگیرد و findFirst یکی را دلبخواهی بردارد (همین باعث شد کاربری با شمارهٔ
  //     تماسِ برابرِ نام کاربریِ شخص دیگر، ورود او را بدزدد).
  //  ۲) اگر شماره تماس تکراری باشد شناسه مبهم است و باید رد شود، نه اینکه
  //     شانسی یکی انتخاب شود.
  const id = normalizeUsername(identifier);
  const raw = identifier.trim();
  let user =
    await prisma.user.findUnique({ where: { username: id } }) ||
    await prisma.user.findUnique({ where: { email: id } });
  if (!user) {
    const byPhone = await prisma.user.findMany({ where: { phone: raw, isActive: true } });
    if (byPhone.length === 1) user = byPhone[0];   // فقط وقتی یکتا باشد
  }
  if (!user || !user.isActive) throw new AppError(401, 'نام کاربری یا رمز عبور اشتباه است');

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new AppError(401, 'نام کاربری یا رمز عبور اشتباه است');

  const token = jwt.sign(
    { id: user.id, username: user.username, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET!,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' } as any,
  );

  await prisma.auditLog.create({
    data: { userId: user.id, action: 'LOGIN_SUCCESS', entity: 'User', entityId: user.id },
  });

  res.json({
    token,
    user: { id: user.id, name: user.name, username: user.username, email: user.email, role: user.role, avatarUrl: user.avatarUrl },
  });
});

router.get('/me', authenticate, async (req: Request, res: Response) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, name: true, username: true, email: true, role: true, phone: true, avatarUrl: true },
  });
  if (!user) throw new AppError(404, 'User not found');
  res.json(user);
});

// ویرایش پروفایل توسط خود کاربر (پنل کاربری)
router.patch('/me', authenticate, upload.single('avatar'), async (req: Request, res: Response) => {
  const { name, username, email, phone, password, currentPassword } = req.body;
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw new AppError(404, 'User not found');

  const data: any = {};
  if (name !== undefined && name.trim()) data.name = name.trim();
  if (phone !== undefined) data.phone = phone;
  if (req.file) data.avatarUrl = `/uploads/${req.file.filename}`;

  if (username !== undefined) {
    const next = normalizeUsername(username);
    if (!next) throw new AppError(400, 'نام کاربری نمی‌تواند خالی باشد');
    if (next !== user.username) {
      const exists = await prisma.user.findUnique({ where: { username: next } });
      if (exists) throw new AppError(409, 'این نام کاربری قبلاً استفاده شده است');
      data.username = next;
    }
  }

  if (email !== undefined) {
    const next = email.trim() ? normalizeUsername(email) : null;
    if (next !== user.email) {
      if (next) {
        const exists = await prisma.user.findUnique({ where: { email: next } });
        if (exists) throw new AppError(409, 'این ایمیل قبلاً استفاده شده است');
      }
      data.email = next;
    }
  }

  if (password) {
    if (!currentPassword || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new AppError(400, 'برای تغییر رمز، رمز عبور فعلی را درست وارد کنید');
    }
    data.passwordHash = await bcrypt.hash(password, 10);
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data,
    select: { id: true, name: true, username: true, email: true, role: true, phone: true, avatarUrl: true },
  });
  res.json(updated);
});

export default router;
