import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { AppError } from '../../shared/middleware/errorHandler';

const router = Router();
router.use(authenticate);

router.get('/', async (req: Request, res: Response) => {
  const { archived } = req.query;
  const notes = await prisma.note.findMany({
    where: { userId: req.user!.id, isArchived: archived === 'true' },
    orderBy: { updatedAt: 'desc' },
  });
  res.json(notes);
});

router.post('/', async (req: Request, res: Response) => {
  const { content, color } = req.body;
  if (!content?.trim()) throw new AppError(400, 'content required');
  const note = await prisma.note.create({
    data: { userId: req.user!.id, content, color: color || '#fff8c5' },
  });
  res.status(201).json(note);
});

router.patch('/:id', async (req: Request, res: Response) => {
  const { content, color, isArchived } = req.body;
  const existing = await prisma.note.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.user!.id) throw new AppError(404, 'Note not found');
  const note = await prisma.note.update({
    where: { id: req.params.id },
    data: { content, color, isArchived },
  });
  res.json(note);
});

router.delete('/:id', async (req: Request, res: Response) => {
  const existing = await prisma.note.findUnique({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.user!.id) throw new AppError(404, 'Note not found');
  await prisma.note.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

export default router;
