import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { upload } from '../../shared/middleware/upload';
import { AppError } from '../../shared/middleware/errorHandler';
import { generateFileName } from '../../shared/utils/fileNaming';
import { notifyProjectAudience, projectAccessWhere } from '../../shared/utils/projectAccess';
import path from 'path';
import fs from 'fs';

const router = Router();
router.use(authenticate);

// Get all parts in technical-review stage (part-centric so newly added parts appear)
router.get('/', async (req: Request, res: Response) => {
  const { status, customerId, search } = req.query;
  // قطعاتی که نیاز به بازبینی دارند (milestone=CREATED) و نیز هر قطعه‌ای که قبلاً بازبینی شده
  // (حتی اگر به قیمت‌گیری رفته) — تا قطعات بازبینی‌شده ناپدید نشوند (رفع باگ #10).
  const where: any = {
    archivedAt: null,
    OR: [{ milestone: 'CREATED' }, { technicalReview: { isNot: null } }],
  };
  if (status) where.technicalStatus = status;
  if (customerId) where.project = { customerId };
  if (search) where.name = { contains: search as string, mode: 'insensitive' };
  Object.assign(where, await projectAccessWhere(req.user!.id, req.user!.role, 'projectId'));

  const parts = await prisma.part.findMany({
    where,
    include: {
      project: { include: { customer: { select: { id: true, name: true } } } },
      files: { where: { fileType: { in: ['DRAWING_CUSTOMER', 'DRAWING_ENGINEERING'] } } },
      technicalReview: { include: { reviewer: { select: { id: true, name: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Shape each part to match the review-row format the frontend expects
  const reviews = parts.map((p) => ({
    id: p.technicalReview?.id || p.id,
    status: p.technicalStatus,
    milestone: p.milestone,
    notes: p.technicalReview?.notes || '',
    rejectReason: p.technicalReview?.rejectReason || '',
    reviewer: p.technicalReview?.reviewer || null,
    reviewedAt: p.technicalReview?.reviewedAt || null,
    createdAt: p.createdAt,
    part: {
      id: p.id,
      name: p.name,
      files: p.files,
      project: p.project,
    },
  }));
  res.json(reviews);
});

// Get review for a specific part
router.get('/part/:partId', async (req: Request, res: Response) => {
  const review = await prisma.technicalReview.findUnique({
    where: { partId: req.params.partId },
    include: {
      part: { include: { files: true } },
      reviewer: { select: { id: true, name: true } },
    },
  });
  if (!review) throw new AppError(404, 'Review not found');
  res.json(review);
});

// Approve a part (with optional engineering drawing upload)
router.post('/part/:partId/approve', upload.single('engDrawing'), async (req: Request, res: Response) => {
  const { notes } = req.body;
  const part = await prisma.part.findUnique({ where: { id: req.params.partId }, include: { project: { include: { customer: { select: { name: true } } } } } });
  if (!part) throw new AppError(404, 'Part not found');

  // Handle engineering drawing file
  if (req.file) {
    const newName = generateFileName(
      {
        level: 'part',
        fileType: 'DRAWING_ENGINEERING',
        projectCode: part.project.code,
        partCode: part.id.slice(-6),
        partName: part.name,
        version: 'R01',
        originalExt: path.extname(req.file.originalname),
      },
      req.file.originalname,
    );
    const newPath = path.join(path.dirname(req.file.path), newName);
    fs.renameSync(req.file.path, newPath);

    await prisma.projectFile.create({
      data: {
        projectId: part.projectId,
        partId: part.id,
        fileType: 'DRAWING_ENGINEERING',
        originalName: req.file.originalname,
        storedName: newName,
        url: `/uploads/${newName}`,
        sizeBytes: req.file.size,
        mimeType: req.file.mimetype,
        uploadedById: req.user!.id,
      },
    });
  }

  const review = await prisma.technicalReview.upsert({
    where: { partId: req.params.partId },
    create: {
      partId: req.params.partId,
      status: 'APPROVED',
      reviewedById: req.user!.id,
      notes,
      reviewedAt: new Date(),
    },
    update: {
      status: 'APPROVED',
      reviewedById: req.user!.id,
      notes,
      rejectReason: null,
      reviewedAt: new Date(),
    },
  });

  await prisma.part.update({
    where: { id: req.params.partId },
    data: { technicalStatus: 'APPROVED' },
  });

  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'UPDATE',
      entity: 'TechnicalReview',
      entityId: review.id,
      projectId: part.projectId,
      changes: { status: 'APPROVED', notes },
    },
  });

  // Notify project manager
  await prisma.notification.create({
    data: {
      userId: req.user!.id,
      type: 'TECHNICAL_APPROVED',
      message: `✅ نقشهٔ قطعهٔ «${part.name}» در پروژهٔ ${part.project.code} (مشتری: ${part.project.customer?.name || '—'}) تأیید شد`,
      entityType: 'Part',
      entityId: part.id,
    },
  });

  res.json(review);
});

// Reject a part
router.post('/part/:partId/reject', async (req: Request, res: Response) => {
  const { rejectReason } = req.body;
  if (!rejectReason) throw new AppError(400, 'rejectReason is required');

  const part = await prisma.part.findUnique({ where: { id: req.params.partId }, include: { project: { include: { customer: { select: { name: true } } } } } });
  if (!part) throw new AppError(404, 'Part not found');

  // قفل: قطعهٔ تأییدشده نهایی است و قابل رد نیست (مگر در بخش پروژه‌ها دوباره ویرایش شود)
  if (part.technicalStatus === 'APPROVED') {
    throw new AppError(400, 'این قطعه قبلاً تأیید شده و دیگر قابل رد نیست. برای تغییر، ابتدا قطعه را در بخش پروژه‌ها ویرایش کنید.');
  }

  const review = await prisma.technicalReview.upsert({
    where: { partId: req.params.partId },
    create: {
      partId: req.params.partId,
      status: 'REJECTED',
      reviewedById: req.user!.id,
      rejectReason,
      reviewedAt: new Date(),
    },
    update: {
      status: 'REJECTED',
      reviewedById: req.user!.id,
      rejectReason,
      reviewedAt: new Date(),
    },
  });

  await prisma.part.update({
    where: { id: req.params.partId },
    data: { technicalStatus: 'REJECTED' },
  });

  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'UPDATE',
      entity: 'TechnicalReview',
      entityId: review.id,
      projectId: part.projectId,
      changes: { status: 'REJECTED', rejectReason },
    },
  });

  // اعلان به همهٔ اعضای پروژه (به‌جز اقدام‌کننده) تا برای اصلاح نقشه اقدام کنند
  await notifyProjectAudience(part.projectId, req.user!.id, 'TECHNICAL_REJECTED', `❌ نقشهٔ قطعهٔ «${part.name}» در پروژهٔ ${part.project.code} رد شد: ${rejectReason}`, 'Part', part.id);

  res.json(review);
});

// ═══════════════════════════════════════════════════════
// بازبینی per-drawing (چند نقشه به ازای هر قطعه)
// وضعیت قطعه از روی وضعیت تک‌تک نقشه‌ها محاسبه می‌شود.
// ═══════════════════════════════════════════════════════

const DRAWING_TYPES = ['DRAWING_CUSTOMER', 'DRAWING_ENGINEERING'];

// محاسبهٔ مجدد وضعیت کلی قطعه از روی وضعیت نقشه‌ها + همگام‌سازی خلاصهٔ TechnicalReview
async function recomputePartStatus(tx: any, partId: string, reviewedById?: string) {
  const drawings = await tx.projectFile.findMany({
    where: { partId, fileType: { in: DRAWING_TYPES } },
    select: { reviewStatus: true },
  });
  let status: 'PENDING' | 'APPROVED' | 'REJECTED';
  if (drawings.length === 0) status = 'PENDING';
  else if (drawings.some((d: any) => d.reviewStatus === 'REJECTED')) status = 'REJECTED';
  else if (drawings.every((d: any) => d.reviewStatus === 'APPROVED')) status = 'APPROVED';
  else status = 'PENDING';

  await tx.part.update({ where: { id: partId }, data: { technicalStatus: status } });
  await tx.technicalReview.upsert({
    where: { partId },
    create: { partId, status, reviewedById, reviewedAt: new Date() },
    update: { status, reviewedById, reviewedAt: new Date() },
  });
  return status;
}

// تأیید یک نقشه
router.post('/drawing/:fileId/approve', async (req: Request, res: Response) => {
  const file = await prisma.projectFile.findUnique({ where: { id: req.params.fileId } });
  if (!file || !file.partId) throw new AppError(404, 'نقشه یافت نشد');
  if (file.reviewStatus === 'APPROVED') throw new AppError(400, 'این نقشه قبلاً تأیید شده است');

  const status = await prisma.$transaction(async (tx) => {
    await tx.projectFile.update({
      where: { id: file.id },
      data: { reviewStatus: 'APPROVED', reviewReason: null, reviewedById: req.user!.id, reviewedAt: new Date() },
    });
    await tx.drawingReview.create({
      data: { fileId: file.id, partId: file.partId!, status: 'APPROVED', fileUrl: file.url, fileName: file.storedName, reviewedById: req.user!.id },
    });
    return recomputePartStatus(tx, file.partId!, req.user!.id);
  });

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'ProjectFile', entityId: file.id, projectId: file.projectId, changes: { drawingApproved: file.storedName, partStatus: status } },
  });
  res.json({ ok: true, partStatus: status });
});

// رد یک نقشه (با دلیل) — در آرشیو DrawingReview با snapshot فایل می‌ماند
router.post('/drawing/:fileId/reject', async (req: Request, res: Response) => {
  const { reason } = req.body;
  if (!reason) throw new AppError(400, 'دلیل رد الزامی است');
  const file = await prisma.projectFile.findUnique({ where: { id: req.params.fileId } });
  if (!file || !file.partId) throw new AppError(404, 'نقشه یافت نشد');
  // ۲.۴ — نقشهٔ تأییدشده دیگر قابل رد نیست
  if (file.reviewStatus === 'APPROVED') throw new AppError(400, 'این نقشه قبلاً تأیید شده و دیگر قابل رد نیست');
  const part = await prisma.part.findUnique({ where: { id: file.partId }, select: { name: true, project: { select: { code: true } } } });

  const status = await prisma.$transaction(async (tx) => {
    await tx.projectFile.update({
      where: { id: file.id },
      data: { reviewStatus: 'REJECTED', reviewReason: reason, reviewedById: req.user!.id, reviewedAt: new Date() },
    });
    await tx.drawingReview.create({
      data: { fileId: file.id, partId: file.partId!, status: 'REJECTED', reason, fileUrl: file.url, fileName: file.storedName, reviewedById: req.user!.id },
    });
    return recomputePartStatus(tx, file.partId!, req.user!.id);
  });

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'ProjectFile', entityId: file.id, projectId: file.projectId, changes: { drawingRejected: file.storedName, reason } },
  });
  // اعلان رد نقشه به همهٔ اعضای پروژه (به‌جز اقدام‌کننده)
  await notifyProjectAudience(file.projectId, req.user!.id, 'TECHNICAL_REJECTED', `❌ نقشهٔ قطعهٔ «${part?.name || ''}»${part?.project ? ` در پروژهٔ ${part.project.code}` : ''} رد شد: ${reason}`, 'Part', file.partId);
  res.json({ ok: true, partStatus: status });
});

// تاریخچه/آرشیو کامل بازبینی یک نقشه
router.get('/drawing/:fileId/history', async (req: Request, res: Response) => {
  const list = await prisma.drawingReview.findMany({ where: { fileId: req.params.fileId }, orderBy: { reviewedAt: 'desc' } });
  const userIds = [...new Set(list.map((l) => l.reviewedById).filter(Boolean))] as string[];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const nameOf: Record<string, string> = Object.fromEntries(users.map((u) => [u.id, u.name]));
  res.json(list.map((l) => ({ ...l, reviewerName: l.reviewedById ? nameOf[l.reviewedById] || null : null })));
});

// آپلود نسخهٔ اصلاح‌شده برای یک نقشهٔ ردشده (در همان ردیف) → وضعیت به «در انتظار» برمی‌گردد
router.post('/drawing/:fileId/replace', upload.single('drawing'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError(400, 'فایل نقشه الزامی است');
  const file = await prisma.projectFile.findUnique({ where: { id: req.params.fileId }, include: { part: { include: { project: true } } } });
  if (!file || !file.part) throw new AppError(404, 'نقشه یافت نشد');

  const newName = generateFileName(
    { level: 'part', fileType: file.fileType, projectCode: file.part.project.code, partCode: file.part.id.slice(-6), partName: file.part.name, version: 'R' + String(Date.now()).slice(-4), originalExt: path.extname(req.file.originalname) },
    req.file.originalname,
  );
  const newPath = path.join(path.dirname(req.file.path), newName);
  fs.renameSync(req.file.path, newPath);

  const status = await prisma.$transaction(async (tx) => {
    await tx.projectFile.update({
      where: { id: file.id },
      data: { url: `/uploads/${newName}`, storedName: newName, originalName: req.file!.originalname, reviewStatus: 'PENDING', reviewReason: null, reviewedById: null, reviewedAt: null },
    });
    return recomputePartStatus(tx, file.partId!, req.user!.id);
  });
  // اعلان به اعضای پروژه که نقشهٔ اصلاح‌شده آمادهٔ بازبینی مجدد است
  await notifyProjectAudience(file.projectId, req.user!.id, 'TECHNICAL_REVIEW_NEEDED', `📐 نقشهٔ اصلاح‌شدهٔ قطعهٔ «${file.part.name}» در پروژهٔ ${file.part.project.code} آمادهٔ بازبینی مجدد است`, 'Part', file.partId!);
  res.json({ ok: true, partStatus: status });
});

// ۲.۳ — آپلود نسخهٔ اصلاح‌شدهٔ مهندسی توسط اپراتور (بدون نیاز به رد کردن).
// نقشه در همان ردیف با نسخهٔ مهندسی (v_eng) جایگزین و «تأییدشده» می‌شود؛ نسخهٔ قبلی (مشتری) در آرشیو می‌ماند.
router.post('/drawing/:fileId/correct', upload.single('drawing'), async (req: Request, res: Response) => {
  if (!req.file) throw new AppError(400, 'فایل نقشهٔ اصلاح‌شده الزامی است');
  const { note } = req.body;
  const file = await prisma.projectFile.findUnique({ where: { id: req.params.fileId }, include: { part: { include: { project: true } } } });
  if (!file || !file.part) throw new AppError(404, 'نقشه یافت نشد');

  // نسخهٔ مهندسی با نام‌گذاری استاندارد (v_eng)
  const newName = generateFileName(
    { level: 'part', fileType: 'DRAWING_ENGINEERING', projectCode: file.part.project.code, partCode: file.part.id.slice(-6), partName: file.part.name, version: 'R' + String(Date.now()).slice(-4), originalExt: path.extname(req.file.originalname) },
    req.file.originalname,
  );
  const newPath = path.join(path.dirname(req.file.path), newName);
  fs.renameSync(req.file.path, newPath);

  const status = await prisma.$transaction(async (tx) => {
    // آرشیو نسخهٔ قبلی (مشتری/قبلی) پیش از جایگزینی — تا در اسناد و تاریخچه بماند
    await tx.drawingReview.create({
      data: { fileId: file.id, partId: file.partId!, status: (file.reviewStatus || 'PENDING') as any, reason: 'نسخهٔ قبلی — جایگزین با نسخهٔ اصلاح‌شدهٔ مهندسی', fileUrl: file.url, fileName: file.storedName, reviewedById: req.user!.id },
    });
    // جایگزینی در همان ردیف با نسخهٔ مهندسی و تأیید
    await tx.projectFile.update({
      where: { id: file.id },
      data: { fileType: 'DRAWING_ENGINEERING', url: `/uploads/${newName}`, storedName: newName, originalName: req.file!.originalname, reviewStatus: 'APPROVED', reviewReason: note || null, reviewedById: req.user!.id, reviewedAt: new Date() },
    });
    // ثبت تصمیم تأیید نسخهٔ اصلاح‌شده در آرشیو
    await tx.drawingReview.create({
      data: { fileId: file.id, partId: file.partId!, status: 'APPROVED', reason: note ? `اصلاح‌شدهٔ مهندسی: ${note}` : 'اصلاح‌شدهٔ مهندسی (تأیید)', fileUrl: `/uploads/${newName}`, fileName: newName, reviewedById: req.user!.id },
    });
    return recomputePartStatus(tx, file.partId!, req.user!.id);
  });

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'ProjectFile', entityId: file.id, projectId: file.projectId, changes: { drawingCorrectedApproved: newName, note: note || null } },
  });
  await notifyProjectAudience(file.projectId, req.user!.id, 'TECHNICAL_APPROVED', `✅ نقشهٔ اصلاح‌شدهٔ مهندسی برای قطعهٔ «${file.part.name}» در پروژهٔ ${file.part.project.code} آپلود و تأیید شد`, 'Part', file.partId!);
  res.json({ ok: true, partStatus: status });
});

export default router;
