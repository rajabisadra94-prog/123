import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { upload } from '../../shared/middleware/upload';
import { AppError } from '../../shared/middleware/errorHandler';
import { sendPushToUsers } from '../../shared/utils/push';

const router = Router();
router.use(authenticate);

const userSelect = { select: { id: true, name: true, avatarUrl: true } };

// Upload an attachment for a comment; returns the stored URL
router.post('/upload', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError(400, 'file required');
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
});

// Notify @mentioned users. Mentions are encoded as @[Name](userId).
async function notifyMentions(text: string, actorId: string, actorName: string, context: string) {
  const re = /@\[(.+?)\]\((.+?)\)/g;
  let m: RegExpExecArray | null;
  const notified = new Set<string>();
  while ((m = re.exec(text)) !== null) {
    const uid = m[2];
    if (uid !== actorId && !notified.has(uid)) {
      notified.add(uid);
      await prisma.notification.create({
        data: { userId: uid, type: 'MENTION', message: `${actorName} در ${context} به شما اشاره کرد`, entityType: 'Comment', entityId: uid },
      });
    }
  }
  if (notified.size) await sendPushToUsers([...notified], 'فابریک', `${actorName} در ${context} به شما اشاره کرد`, { type: 'MENTION' });
}

// ── PROJECT COMMENTS (flat; frontend builds the reply tree) ──
router.get('/project/:projectId', async (req: Request, res: Response) => {
  const comments = await prisma.comment.findMany({
    where: { projectId: req.params.projectId },
    include: { user: userSelect },
    orderBy: { createdAt: 'asc' },
  });
  res.json(comments);
});

router.post('/project/:projectId', async (req: Request, res: Response) => {
  const { text, parentId, attachmentUrls } = req.body;
  if (!text?.trim()) throw new AppError(400, 'text required');
  const comment = await prisma.comment.create({
    data: { projectId: req.params.projectId, userId: req.user!.id, text, parentId: parentId || undefined, attachmentUrls: attachmentUrls || [] },
    include: { user: userSelect },
  });
  await notifyMentions(text, req.user!.id, req.user!.name, 'پروژه');
  res.status(201).json(comment);
});

// ── TASK COMMENTS (flat; frontend builds the reply tree) ──
router.get('/task/:taskId', async (req: Request, res: Response) => {
  const comments = await prisma.comment.findMany({
    where: { taskId: req.params.taskId },
    include: { user: userSelect },
    orderBy: { createdAt: 'asc' },
  });
  res.json(comments);
});

router.post('/task/:taskId', async (req: Request, res: Response) => {
  const { text, parentId, attachmentUrls } = req.body;
  if (!text?.trim()) throw new AppError(400, 'text required');
  const comment = await prisma.comment.create({
    data: { taskId: req.params.taskId, userId: req.user!.id, text, parentId: parentId || undefined, attachmentUrls: attachmentUrls || [] },
    include: { user: userSelect },
  });
  await notifyMentions(text, req.user!.id, req.user!.name, 'وظیفه');

  // also notify other assignees of the task about the new report
  const task = await prisma.task.findUnique({ where: { id: req.params.taskId }, select: { assigneeIds: true, title: true } });
  const taskRecipients = (task?.assigneeIds || []).filter((uid) => uid !== req.user!.id);
  for (const uid of taskRecipients) {
    await prisma.notification.create({
      data: { userId: uid, type: 'TASK_COMMENT', message: `گزارش جدید در وظیفه «${task!.title}»`, entityType: 'Task', entityId: req.params.taskId },
    });
  }
  await sendPushToUsers(taskRecipients, 'فابریک', `گزارش جدید در وظیفه «${task?.title || ''}»`, { type: 'TASK_COMMENT', entityId: req.params.taskId });
  res.status(201).json(comment);
});

export default router;
