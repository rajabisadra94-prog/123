import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate, requireRole } from '../../shared/middleware/auth';
import { AppError } from '../../shared/middleware/errorHandler';

const router = Router();
router.use(authenticate);

const TYPE_FA: Record<string, string> = { BUG: 'باگ', FEATURE: 'قابلیت / نیاز جدید' };
const STATUS_FA: Record<string, string> = { OPEN: 'باز', IN_PROGRESS: 'در حال بررسی', DONE: 'انجام‌شده', DISMISSED: 'رد‌شده' };
const PRIO_FA: Record<string, string> = { LOW: 'کم', NORMAL: 'متوسط', HIGH: 'زیاد' };

// ثبت بازخورد — هر کاربری می‌تواند
router.post('/', async (req: Request, res: Response) => {
  const { type, module, page, title, description, steps, priority } = req.body;
  if (!title || !description) throw new AppError(400, 'عنوان و توضیحات الزامی است');
  const report = await prisma.feedbackReport.create({
    data: {
      type: type === 'FEATURE' ? 'FEATURE' : 'BUG',
      module: module || null,
      page: page || null,
      title,
      description,
      steps: steps || null,
      priority: ['LOW', 'HIGH'].includes(priority) ? priority : 'NORMAL',
      createdById: req.user!.id,
      createdByName: req.user!.name,
    },
  });
  res.status(201).json(report);
});

// لیست — کاربر عادی فقط بازخوردهای خودش؛ مدیر همه را
router.get('/', async (req: Request, res: Response) => {
  const { status, type } = req.query as Record<string, string>;
  const where: any = {};
  if (status) where.status = status;
  if (type) where.type = type;
  const isAdmin = req.user!.role === 'SUPER_ADMIN' || req.user!.role === 'MANAGER';
  if (!isAdmin) where.createdById = req.user!.id;
  const reports = await prisma.feedbackReport.findMany({ where, orderBy: { createdAt: 'desc' } });
  res.json(reports);
});

// تغییر وضعیت (فقط مدیر)
router.patch('/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { status } = req.body;
  const r = await prisma.feedbackReport.update({ where: { id: req.params.id }, data: { status } });
  res.json(r);
});

// خروجی متنی برای فرستادن به توسعه‌دهنده (فقط مدیر)
router.get('/export', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { status } = req.query as Record<string, string>;
  const where: any = status ? { status } : { status: { in: ['OPEN', 'IN_PROGRESS'] } };
  const reports = await prisma.feedbackReport.findMany({ where, orderBy: [{ type: 'asc' }, { priority: 'desc' }, { createdAt: 'asc' }] });

  const lines: string[] = [];
  lines.push(`# فهرست بازخوردها و باگ‌های سامانهٔ Fabrik (${reports.length} مورد)`);
  lines.push(`# تاریخ خروجی: ${new Date().toLocaleString('fa-IR')}`);
  lines.push('');
  reports.forEach((r, i) => {
    lines.push(`## ${i + 1}) [${TYPE_FA[r.type] || r.type}] ${r.title}`);
    if (r.module || r.page) lines.push(`- مکان دقیق: ${[r.module, r.page].filter(Boolean).join(' / ')}`);
    lines.push(`- اولویت: ${PRIO_FA[r.priority] || r.priority} | وضعیت: ${STATUS_FA[r.status] || r.status} | توسط: ${r.createdByName || '—'}`);
    lines.push(`- شرح: ${r.description}`);
    if (r.steps) lines.push(`- مراحل بازتولید / جزئیات بیشتر: ${r.steps}`);
    lines.push('');
  });

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="fabrik-feedback.txt"');
  res.send('﻿' + lines.join('\n'));
});

export default router;
