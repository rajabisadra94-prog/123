import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate, requireRole } from '../../shared/middleware/auth';
import { AppError } from '../../shared/middleware/errorHandler';

const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response) => {
  const { entityType, reason, from, to } = req.query;
  const where: any = { restoredAt: null };
  if (entityType) where.entityType = entityType;
  if (reason) where.reason = reason;
  if (from || to) {
    where.archivedAt = {};
    if (from) where.archivedAt.gte = new Date(from as string);
    if (to) { const t = new Date(to as string); t.setHours(23, 59, 59, 999); where.archivedAt.lte = t; }
  }

  const entries = await prisma.archiveEntry.findMany({
    where,
    orderBy: { archivedAt: 'desc' },
  });
  res.json(entries);
});

router.post('/restore/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const entry = await prisma.archiveEntry.findUnique({ where: { id: req.params.id } });
  if (!entry) throw new AppError(404, 'Archive entry not found');
  if (entry.restoredAt) throw new AppError(400, 'Already restored');

  await prisma.archiveEntry.update({
    where: { id: req.params.id },
    data: { restoredAt: new Date(), restoredById: req.user!.id },
  });

  // Restore the entity based on entityType
  if (entry.entityType === 'Project') {
    await prisma.project.update({
      where: { id: entry.entityId },
      data: { status: 'ACTIVE', archivedAt: null, archivedReason: null },
    });
  } else if (entry.entityType === 'Part') {
    await prisma.part.update({
      where: { id: entry.entityId },
      data: { archivedAt: null, archivedReason: null, milestone: 'CREATED' },
    });
  }

  res.json({ ok: true });
});

router.delete('/:id', requireRole('SUPER_ADMIN'), async (req: Request, res: Response) => {
  const { confirm } = req.body;
  if (confirm !== 'حذف دائمی') throw new AppError(400, 'Confirmation phrase required');

  await prisma.archiveEntry.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

export default router;
