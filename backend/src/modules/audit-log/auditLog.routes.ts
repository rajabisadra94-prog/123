import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate, requireRole } from '../../shared/middleware/auth';

const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN', 'MANAGER'));

router.get('/', async (req: Request, res: Response) => {
  const { entity, entityId, userId, projectId, action, from, to, page = '1', limit = '50' } = req.query;
  const where: any = {};
  if (entity) where.entity = entity;
  if (entityId) where.entityId = entityId;
  if (userId) where.userId = userId;
  if (projectId) where.projectId = projectId;
  if (action) where.action = action;
  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from as string);
    if (to) { const t = new Date(to as string); t.setHours(23, 59, 59, 999); where.createdAt.lte = t; }
  }

  const skip = (Number(page) - 1) * Number(limit);

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit),
    }),
    prisma.auditLog.count({ where }),
  ]);

  res.json({ logs, total, page: Number(page), limit: Number(limit) });
});

export default router;
