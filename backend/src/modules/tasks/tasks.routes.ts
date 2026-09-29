import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { AppError } from '../../shared/middleware/errorHandler';
import { logTaskActivity } from '../../shared/utils/taskActivity';

const router = Router();
router.use(authenticate);

const PRIORITY_FA: Record<string, string> = { LOW: 'کم', NORMAL: 'متوسط', HIGH: 'مهم' };

const taskInclude = {
  project: { select: { id: true, code: true, customer: { select: { name: true } } } },
  assignedTo: { select: { id: true, name: true, avatarUrl: true } },
};

// Tasks assigned to me (single or shared) and not done
router.get('/my', async (req: Request, res: Response) => {
  const me = req.user!.id;
  const tasks = await prisma.task.findMany({
    where: { isDone: false, OR: [{ assignedToId: me }, { assigneeIds: { has: me } }] },
    include: taskInclude,
    orderBy: { dueAt: 'asc' },
  });
  res.json(tasks);
});

// All tasks with filters
router.get('/', async (req: Request, res: Response) => {
  const { projectId, entityType, entityId, assignedToId, includeDone } = req.query as Record<string, string>;
  const where: any = {};
  if (projectId) where.projectId = projectId;
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (includeDone !== 'true') where.isDone = false;

  // محدودیت دید (ماژول ۱۳): فقط مدیرکل همهٔ وظایف را می‌بیند؛ بقیه فقط وظایف مرتبط با خودشان
  const and: any[] = [];
  if (assignedToId) and.push({ OR: [{ assignedToId }, { assigneeIds: { has: assignedToId } }] });
  if (req.user!.role !== 'SUPER_ADMIN') {
    const me = req.user!.id;
    and.push({ OR: [{ assignedToId: me }, { assigneeIds: { has: me } }, { createdById: me }] });
  }
  if (and.length) where.AND = and;

  const tasks = await prisma.task.findMany({
    where,
    include: { ...taskInclude, _count: { select: { comments: true } } },
    orderBy: [{ isDone: 'asc' }, { dueAt: 'asc' }],
  });
  res.json(tasks);
});

// Single task with full detail (+ checklist)
router.get('/:id', async (req: Request, res: Response) => {
  const task = await prisma.task.findUnique({
    where: { id: req.params.id },
    include: { ...taskInclude, createdBy: { select: { id: true, name: true } }, checklist: { orderBy: { order: 'asc' } } },
  });
  if (!task) throw new AppError(404, 'Task not found');
  // دید تک‌وظیفه (ماژول ۱۳): غیر از مدیرکل، فقط افراد مرتبط
  const me = req.user!.id;
  const involved = task.assignedToId === me || task.assigneeIds.includes(me) || task.createdById === me;
  if (req.user!.role !== 'SUPER_ADMIN' && !involved) throw new AppError(403, 'به این وظیفه دسترسی ندارید');
  const assignees = task.assigneeIds.length
    ? await prisma.user.findMany({ where: { id: { in: task.assigneeIds } }, select: { id: true, name: true, avatarUrl: true } })
    : [];
  res.json({ ...task, assignees });
});

// ── CHECKLIST ──
router.post('/:id/checklist', async (req: Request, res: Response) => {
  const { text, assigneeIds } = req.body;
  if (!text?.trim()) throw new AppError(400, 'text required');
  const count = await prisma.checklistItem.count({ where: { taskId: req.params.id } });
  const item = await prisma.checklistItem.create({
    data: { taskId: req.params.id, text, assigneeIds: assigneeIds || [], order: count },
  });
  // notify assignees
  for (const uid of (assigneeIds || [])) {
    if (uid !== req.user!.id) {
      await prisma.notification.create({ data: { userId: uid, type: 'CHECKLIST_ASSIGNED', message: `مورد چک‌لیست به شما تخصیص یافت: ${text}`, entityType: 'Task', entityId: req.params.id } });
    }
  }
  res.status(201).json(item);
});

// Replace the whole checklist (used by the edit-task form). Keeps isDone of items kept by id.
router.put('/:id/checklist', async (req: Request, res: Response) => {
  const { items } = req.body as { items: { id?: string; text: string; assigneeIds?: string[] }[] };
  const existing = await prisma.checklistItem.findMany({ where: { taskId: req.params.id } });
  const keepIds = (items || []).filter((i) => i.id).map((i) => i.id);

  const toDelete = existing.filter((e) => !keepIds.includes(e.id)).map((e) => e.id);
  if (toDelete.length) await prisma.checklistItem.deleteMany({ where: { id: { in: toDelete } } });

  let order = 0;
  for (const it of (items || [])) {
    if (!it.text?.trim()) continue;
    if (it.id && existing.find((e) => e.id === it.id)) {
      await prisma.checklistItem.update({ where: { id: it.id }, data: { text: it.text, assigneeIds: it.assigneeIds || [], order } });
    } else {
      await prisma.checklistItem.create({ data: { taskId: req.params.id, text: it.text, assigneeIds: it.assigneeIds || [], order } });
    }
    order++;
  }
  const fresh = await prisma.checklistItem.findMany({ where: { taskId: req.params.id }, orderBy: { order: 'asc' } });
  res.json(fresh);
});

router.patch('/:id/checklist/:itemId/toggle', async (req: Request, res: Response) => {
  const item = await prisma.checklistItem.findUnique({ where: { id: req.params.itemId } });
  if (!item) throw new AppError(404, 'Checklist item not found');
  const task = await prisma.task.findUnique({ where: { id: req.params.id } });

  const isAdmin = req.user!.role === 'SUPER_ADMIN';
  const isCreator = task?.createdById === req.user!.id;
  const isAssignee = item.assigneeIds.includes(req.user!.id);
  // Only the item's assignee or the super-admin may toggle an assigned item.
  // Unassigned items can be toggled by the task creator or super-admin.
  const allowed = item.assigneeIds.length > 0 ? (isAssignee || isAdmin) : (isCreator || isAdmin);
  if (!allowed) throw new AppError(403, 'فقط فرد مسئول این مورد یا مدیر کل می‌تواند آن را تیک بزند');

  const updated = await prisma.checklistItem.update({
    where: { id: req.params.itemId },
    data: { isDone: !item.isDone, doneById: !item.isDone ? req.user!.id : null, doneAt: !item.isDone ? new Date() : null },
  });
  await logTaskActivity(req.params.id, req.user!.id, `${req.user!.name} مورد «${item.text}» را ${updated.isDone ? 'انجام‌شده' : 'باز'} کرد`);
  res.json(updated);
});

router.delete('/:id/checklist/:itemId', async (req: Request, res: Response) => {
  await prisma.checklistItem.delete({ where: { id: req.params.itemId } });
  res.status(204).send();
});

router.post('/', async (req: Request, res: Response) => {
  const { title, notes, assigneeIds, priority, dueAt, repeat, projectId, entityType, entityId, orderId, checklist } = req.body;
  if (!title) throw new AppError(400, 'title required');

  const ids: string[] = (assigneeIds?.length ? assigneeIds : [req.user!.id]);

  const task = await prisma.task.create({
    data: {
      title,
      notes: notes || undefined,
      assigneeIds: ids,
      priority: priority || 'NORMAL',
      repeat: repeat || 'NONE',
      dueAt: dueAt ? new Date(dueAt) : undefined,
      entityType: entityType || undefined,
      entityId: entityId || undefined,
      assignedTo: { connect: { id: ids[0] } },
      createdBy: { connect: { id: req.user!.id } },
      ...(projectId ? { project: { connect: { id: projectId } } } : {}),
      ...(orderId ? { order: { connect: { id: orderId } } } : {}),
    },
  });

  // optional checklist items provided at creation time
  if (Array.isArray(checklist) && checklist.length) {
    await prisma.checklistItem.createMany({
      data: checklist.filter((c: any) => c.text?.trim()).map((c: any, i: number) => ({
        taskId: task.id, text: c.text, assigneeIds: c.assigneeIds || [], order: i,
      })),
    });
  }

  // notify all assignees except the creator
  for (const uid of ids) {
    if (uid !== req.user!.id) {
      await prisma.notification.create({
        data: { userId: uid, type: 'TASK_ASSIGNED', message: `وظیفه جدید: ${title}`, entityType: 'Task', entityId: task.id },
      });
    }
  }
  await logTaskActivity(task.id, req.user!.id, `${req.user!.name} این وظیفه را ایجاد کرد`);
  res.status(201).json(task);
});

router.patch('/:id', async (req: Request, res: Response) => {
  const { title, notes, assigneeIds, priority, dueAt, repeat, projectId } = req.body;
  const before = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (!before) throw new AppError(404, 'Task not found');

  const data: any = {};
  const changes: string[] = [];
  if (title !== undefined && title !== before.title) { data.title = title; changes.push(`عنوان را به «${title}» تغییر داد`); }
  if (notes !== undefined && notes !== (before.notes || '')) { data.notes = notes; changes.push('توضیحات را ویرایش کرد'); }
  if (priority !== undefined && priority !== before.priority) { data.priority = priority; changes.push(`اولویت را به «${PRIORITY_FA[priority] || priority}» تغییر داد`); }
  if (dueAt !== undefined) {
    const nd = dueAt ? new Date(dueAt) : null;
    if (String(nd) !== String(before.dueAt)) { data.dueAt = nd; changes.push(nd ? `مهلت را تغییر داد` : 'مهلت را حذف کرد'); }
  }
  if (repeat !== undefined) data.repeat = repeat;
  if (projectId !== undefined) {
    data.project = projectId ? { connect: { id: projectId } } : { disconnect: true };
    changes.push(projectId ? 'پروژه مرتبط را تغییر داد' : 'پروژه مرتبط را حذف کرد');
  }
  if (assigneeIds !== undefined) {
    data.assigneeIds = assigneeIds;
    data.assignedTo = assigneeIds[0] ? { connect: { id: assigneeIds[0] } } : { disconnect: true };
    changes.push('مسئولان را تغییر داد');
  }

  const task = await prisma.task.update({ where: { id: req.params.id }, data });
  if (changes.length) await logTaskActivity(task.id, req.user!.id, `${req.user!.name}: ${changes.join('، ')}`);
  res.json(task);
});

router.patch('/:id/done', async (req: Request, res: Response) => {
  const { doneReport, undo } = req.body;
  const existing = await prisma.task.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError(404, 'Task not found');

  // Only the creator or the super-admin can complete/reopen the whole task
  const isAdmin = req.user!.role === 'SUPER_ADMIN';
  const isCreator = existing.createdById === req.user!.id;
  if (!isAdmin && !isCreator) {
    throw new AppError(403, 'فقط ایجادکننده یا مدیر کل می‌تواند کل وظیفه را تکمیل کند');
  }

  const task = await prisma.task.update({
    where: { id: req.params.id },
    data: undo ? { isDone: false, doneAt: null } : { isDone: true, doneAt: new Date(), doneReport },
  });
  await logTaskActivity(task.id, req.user!.id, `${req.user!.name} وضعیت وظیفه را به «${undo ? 'باز' : 'تکمیل‌شده'}» تغییر داد${doneReport ? ` — گزارش: ${doneReport}` : ''}`);
  res.json(task);
});

router.delete('/:id', async (req: Request, res: Response) => {
  await prisma.comment.deleteMany({ where: { taskId: req.params.id } });
  await prisma.task.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

export default router;
