import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { upload } from '../../shared/middleware/upload';
import { AppError } from '../../shared/middleware/errorHandler';
import { calculateProjectProgress } from '../../shared/utils/progress';
import { generateFileName } from '../../shared/utils/fileNaming';
import { requirePermission } from '../../shared/middleware/permissions';
import { projectAccessWhere, canAccessProject, notifyProjectAudience } from '../../shared/utils/projectAccess';
import path from 'path';
import fs from 'fs';
import archiver from 'archiver';
import ExcelJS from 'exceljs';

const UPLOAD_DIR = path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads');

// productLinks از فرم multipart به‌صورت رشتهٔ JSON یا سطرهای جداگانه می‌آید → آرایهٔ لینک تمیز
function parseLinks(raw: any): string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const s = raw.trim();
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
    } catch { /* رشتهٔ ساده/چندخطی */ }
    return s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  }
  return undefined;
}

const router = Router();
router.use(authenticate);

// ─── LIST PROJECTS ────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  const { customerId, producerId, status, search, dateFrom, dateTo, sortBy, sortDir } = req.query as Record<string, string>;
  const where: any = {};
  if (customerId) where.customerId = customerId;
  if (status) where.status = status;
  if (producerId) where.parts = { some: { selectedPrice: { producerId } } };
  if (search) where.OR = [
    { code: { contains: search, mode: 'insensitive' } },
    { description: { contains: search, mode: 'insensitive' } },
  ];
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) { const d = new Date(dateTo); d.setHours(23, 59, 59); where.createdAt.lte = d; }
  }

  // محدودسازی به پروژه‌های قابل‌دسترس کاربر (ALL→بدون محدودیت، SPECIFIC→فقط تخصیص‌یافته‌ها)
  Object.assign(where, await projectAccessWhere(req.user!.id, req.user!.role, 'id'));

  const dbSort = sortBy === 'updatedAt' ? 'updatedAt' : 'createdAt';
  const projects = await prisma.project.findMany({
    where,
    include: {
      customer: { select: { id: true, name: true, shortCode: true } },
      parts: { select: { id: true, name: true, milestone: true, archivedAt: true } },
      invoices: { where: { status: 'APPROVED' }, select: { totalAmount: true, totalRateToIRR: true } },
    },
    orderBy: { [dbSort]: (sortDir === 'asc' ? 'asc' : 'desc') as any },
  });

  let result = projects.map((p) => {
    const amountIRR = p.invoices.reduce((s, i) => s + Number(i.totalAmount) * Number(i.totalRateToIRR), 0);
    return { ...p, progress: calculateProjectProgress(p.parts), amountIRR };
  });

  if (sortBy === 'amount') {
    result = result.sort((a, b) => (sortDir === 'asc' ? a.amountIRR - b.amountIRR : b.amountIRR - a.amountIRR));
  }

  res.json(result);
});

// ─── GET ONE PROJECT ──────────────────────────
router.get('/:id', async (req: Request, res: Response) => {
  if (!(await canAccessProject(req.user!.id, req.user!.role, req.params.id))) {
    throw new AppError(403, 'به این پروژه دسترسی ندارید');
  }
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      customer: true,
      parts: {
        include: {
          material: true,
          coating: true,
          group: true,
          technicalReview: true,
          selectedPrice: true,
          files: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
      partGroups: true,
      files: { orderBy: { createdAt: 'desc' } },
      commissions: { include: { agent: true } },
      shippingCost: true,
      invoices: { orderBy: { versionNumber: 'asc' } },
      tasks: { where: { isDone: false }, orderBy: { dueAt: 'asc' } },
    },
  });
  if (!project) throw new AppError(404, 'Project not found');
  res.json({ ...project, progress: calculateProjectProgress(project.parts) });
});

// ─── CREATE PROJECT ───────────────────────────
const PROJECT_TYPES = ['MANUFACTURING', 'TRADING', 'FORWARDING'];

router.post('/', requirePermission('projects', 'create'), async (req: Request, res: Response) => {
  const { customerId, needDate, description, type, specApprovalRequired } = req.body;
  if (!customerId) throw new AppError(400, 'customerId required');
  const projType = PROJECT_TYPES.includes(type) ? type : 'MANUFACTURING';

  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new AppError(404, 'Customer not found');

  // Generate code and increment counter atomically
  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: { projectCounter: { increment: 1 } },
  });
  const counter = String(updated.projectCounter).padStart(4, '0');
  const code = `${customer.shortCode}-${counter}`;

  const project = await prisma.project.create({
    data: { code, customerId, needDate: needDate ? new Date(needDate) : undefined, description, type: projType, specApprovalRequired: !!specApprovalRequired },
    include: { customer: { select: { id: true, name: true, shortCode: true } } },
  });

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'CREATE', entity: 'Project', entityId: project.id, projectId: project.id },
  });

  res.status(201).json(project);
});

// ─── UPDATE PROJECT ───────────────────────────
router.patch('/:id', async (req: Request, res: Response) => {
  const { needDate, description, type, specApprovalRequired } = req.body;
  const project = await prisma.project.update({
    where: { id: req.params.id },
    data: {
      needDate: needDate ? new Date(needDate) : undefined,
      description,
      type: PROJECT_TYPES.includes(type) ? type : undefined,
      specApprovalRequired: specApprovalRequired === undefined ? undefined : !!specApprovalRequired,
    },
  });
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'Project', entityId: project.id, projectId: project.id, changes: req.body },
  });
  res.json(project);
});

// ─── ARCHIVE PROJECT ──────────────────────────
const ARCHIVE_REASONS = ['PROJECT_COMPLETED', 'PRICE_REJECTED_BY_CUSTOMER', 'TECHNICAL_ISSUES', 'CUSTOMER_CANCELLED', 'OTHER'];
router.post('/:id/archive', async (req: Request, res: Response) => {
  const { reason, notes } = req.body;
  if (!reason) throw new AppError(400, 'reason required');
  const reasonEnum = ARCHIVE_REASONS.includes(reason) ? reason : 'OTHER';

  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: { parts: true, customer: { select: { name: true } } },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const activeParts = project.parts.filter((p) => !p.archivedAt);
  const hasActiveParts = activeParts.some((p) => p.milestone !== 'CREATED' && p.milestone !== 'PRICED_AND_INVOICED');
  if (hasActiveParts) throw new AppError(400, 'Cannot archive: some parts are in active production stages');

  await prisma.$transaction([
    prisma.project.update({
      where: { id: req.params.id },
      data: { status: 'ARCHIVED', archivedAt: new Date(), archivedReason: notes || reason },
    }),
    prisma.archiveEntry.create({
      data: {
        entityType: 'Project',
        entityId: project.id,
        reason: reasonEnum as any,
        reasonNotes: notes,
        snapshot: {
          code: project.code,
          customer: project.customer.name,
          status: project.status,
          partsCount: project.parts.length,
          createdAt: project.createdAt,
        },
        archivedById: req.user!.id,
      },
    }),
  ]);
  res.json({ ok: true });
});

// ─── PARTS: ADD ───────────────────────────────
router.post('/:id/parts', requirePermission('projects', 'edit'), upload.array('drawings', 10), async (req: Request, res: Response) => {
  const {
    name, quantity, weightGrams, materialId, coatingId, targetAmount, targetCurrency,
    brand, partModel, unit, dimensions, color, declaredValue, declaredCurrency, hsCode, description, productLinks,
  } = req.body;
  if (!name) throw new AppError(400, 'name required');
  if (!quantity || Number(quantity) < 1) throw new AppError(400, 'quantity must be >= 1');

  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) throw new AppError(404, 'Project not found');

  const isTrading = project.type === 'TRADING';

  const { getLiveRates } = await import('../../shared/utils/money');
  let targetRateToIRR: number | undefined;
  let targetRateAt: Date | undefined;
  if (targetAmount && targetCurrency) {
    const rates = await getLiveRates();
    targetRateToIRR = targetCurrency === 'IRR' ? 1 : targetCurrency === 'USD' ? rates.USD_TO_IRR : rates.CNY_TO_IRR;
    targetRateAt = new Date();
  }

  // productLinks از فرانت به‌صورت JSON string می‌آید (multipart) — پارس می‌شود به آرایه
  const parsedLinks = parseLinks(productLinks);

  // برای کالای خرید (TRADING): اگر تأیید مشخصات لازم نباشد، مستقیم APPROVED تا قابل قیمت‌گیری شود
  const initialTechStatus: 'PENDING' | 'APPROVED' =
    isTrading && !project.specApprovalRequired ? 'APPROVED' : 'PENDING';

  const part = await prisma.part.create({
    data: {
      projectId: req.params.id,
      name,
      quantity: Number(quantity),
      weightGrams: weightGrams ? Number(weightGrams) : undefined,
      materialId: materialId || undefined,
      coatingId: coatingId || undefined,
      targetAmount: targetAmount ? Number(targetAmount) : undefined,
      targetCurrency: targetCurrency || undefined,
      targetRateToIRR,
      targetRateAt,
      // فیلدهای کالای آماده (TRADING)
      brand: brand || undefined,
      partModel: partModel || undefined,
      unit: unit || undefined,
      dimensions: dimensions || undefined,
      color: color || undefined,
      declaredValue: declaredValue ? Number(declaredValue) : undefined,
      declaredCurrency: declaredCurrency || undefined,
      hsCode: hsCode || undefined,
      description: description || undefined,
      productLinks: parsedLinks,
      technicalStatus: initialTechStatus,
    },
  });

  // Handle uploaded files — برای TRADING عکس کالا، در غیر این‌صورت نقشهٔ مشتری
  const files = req.files as Express.Multer.File[];
  const fileType = isTrading ? 'COMMODITY_PHOTO' : 'DRAWING_CUSTOMER';
  if (files?.length) {
    const fileRecords = files.map((f, i) => {
      const newName = generateFileName(
        { level: 'part', fileType, projectCode: project.code, partCode: part.id.slice(-6), partName: part.name, version: `R${String(i + 1).padStart(2, '0')}`, originalExt: path.extname(f.originalname) },
        f.originalname,
      );
      const newPath = path.join(path.dirname(f.path), newName);
      fs.renameSync(f.path, newPath);
      return {
        projectId: req.params.id,
        partId: part.id,
        fileType,
        originalName: f.originalname,
        storedName: newName,
        url: `/uploads/${newName}`,
        sizeBytes: f.size,
        mimeType: f.mimetype,
        uploadedById: req.user!.id,
      };
    });
    await prisma.projectFile.createMany({ data: fileRecords });
  }

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'CREATE', entity: 'Part', entityId: part.id, projectId: req.params.id },
  });

  // اعلان: نقشه→بازبینی فنی (ساخت)؛ کالای خرید با نیاز به تأیید مشخصات→تأیید مشخصات
  if (isTrading) {
    if (project.specApprovalRequired) {
      await notifyProjectAudience(req.params.id, req.user!.id, 'SPEC_APPROVAL_NEEDED', `کالای جدید «${part.name}» در پروژهٔ ${project.code} نیازمند تأیید مشخصات است`, 'Part', part.id);
    }
  } else if (files?.length) {
    await notifyProjectAudience(req.params.id, req.user!.id, 'TECHNICAL_REVIEW_NEEDED', `قطعهٔ جدید «${part.name}» در پروژهٔ ${project.code} نیازمند بازبینی فنی است`, 'Part', part.id);
  }

  res.status(201).json(part);
});

// ─── PARTS: UPDATE ────────────────────────────
router.patch('/:id/parts/:partId', async (req: Request, res: Response) => {
  // Check part is not locked
  const part = await prisma.part.findUnique({ where: { id: req.params.partId } });
  if (!part) throw new AppError(404, 'Part not found');

  const LOCKED_MILESTONES = ['ORDER_PLACED', 'IN_PRODUCTION', 'QUALITY_CONTROL', 'COMPLETED', 'IN_TRANSIT', 'DELIVERED'];
  if (LOCKED_MILESTONES.includes(part.milestone)) {
    throw new AppError(400, `Part is locked at milestone ${part.milestone}. Cannot edit.`);
  }

  const {
    name, quantity, weightGrams, materialId, coatingId, targetAmount, targetCurrency,
    brand, partModel, unit, dimensions, color, declaredValue, declaredCurrency, hsCode, description, productLinks,
  } = req.body;
  const updated = await prisma.part.update({
    where: { id: req.params.partId },
    data: {
      name, quantity: quantity ? Number(quantity) : undefined, weightGrams: weightGrams ? Number(weightGrams) : undefined, materialId, coatingId, targetAmount: targetAmount ? Number(targetAmount) : undefined, targetCurrency,
      // فیلدهای کالای آماده (TRADING)
      brand, partModel, unit, dimensions, color,
      declaredValue: declaredValue !== undefined && declaredValue !== '' ? Number(declaredValue) : undefined,
      declaredCurrency: declaredCurrency || undefined,
      hsCode, description,
      productLinks: productLinks !== undefined ? parseLinks(productLinks) : undefined,
    },
  });
  res.json(updated);
});

// ─── PARTS: RE-UPLOAD CUSTOMER DRAWING (resets to technical review) ──
router.post('/:id/parts/:partId/redraw', upload.array('drawings', 10), async (req: Request, res: Response) => {
  const part = await prisma.part.findUnique({ where: { id: req.params.partId }, include: { project: true } });
  if (!part) throw new AppError(404, 'Part not found');

  const LOCKED = ['ORDER_PLACED', 'IN_PRODUCTION', 'QUALITY_CONTROL', 'COMPLETED', 'IN_TRANSIT', 'DELIVERED'];
  if (LOCKED.includes(part.milestone)) throw new AppError(400, 'Part is locked in production. Cannot revise drawing.');

  const files = req.files as Express.Multer.File[];
  if (!files?.length) throw new AppError(400, 'At least one drawing file is required');

  // Count existing customer drawings to version correctly
  const existing = await prisma.projectFile.count({ where: { partId: part.id, fileType: 'DRAWING_CUSTOMER' } });

  const fileRecords = files.map((f, i) => {
    const newName = generateFileName(
      { level: 'part', fileType: 'DRAWING_CUSTOMER', projectCode: part.project.code, partCode: part.id.slice(-6), partName: part.name, version: `R${String(existing + i + 1).padStart(2, '0')}`, originalExt: path.extname(f.originalname) },
      f.originalname,
    );
    const newPath = path.join(path.dirname(f.path), newName);
    fs.renameSync(f.path, newPath);
    return {
      projectId: part.projectId, partId: part.id, fileType: 'DRAWING_CUSTOMER',
      originalName: f.originalname, storedName: newName, url: `/uploads/${newName}`,
      sizeBytes: f.size, mimeType: f.mimetype, uploadedById: req.user!.id,
    };
  });
  await prisma.projectFile.createMany({ data: fileRecords });

  // Reset technical status back to pending and clear previous review verdict
  await prisma.part.update({ where: { id: part.id }, data: { technicalStatus: 'PENDING' } });
  await prisma.technicalReview.updateMany({
    where: { partId: part.id },
    data: { status: 'PENDING', rejectReason: null, reviewedAt: null },
  });

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'Part', entityId: part.id, projectId: part.projectId, changes: { event: 'DRAWING_REVISED', technicalStatus: 'PENDING' } },
  });

  // نقشه اصلاح شد و وضعیت به «در انتظار» برگشت → اعلان بازبینی مجدد
  await notifyProjectAudience(part.projectId, req.user!.id, 'TECHNICAL_REVIEW_NEEDED', `نقشهٔ قطعهٔ «${part.name}» اصلاح شد و نیازمند بازبینی مجدد است`, 'Part', part.id);

  res.json({ ok: true });
});

// ─── PARTS: ADD MORE DRAWINGS (افزودن نقشهٔ بیشتر به قطعهٔ موجود) ──
router.post('/:id/parts/:partId/drawings', upload.array('drawings', 10), async (req: Request, res: Response) => {
  const part = await prisma.part.findUnique({ where: { id: req.params.partId }, include: { project: true } });
  if (!part) throw new AppError(404, 'Part not found');
  const LOCKED = ['ORDER_PLACED', 'IN_PRODUCTION', 'QUALITY_CONTROL', 'COMPLETED', 'IN_TRANSIT', 'DELIVERED'];
  if (LOCKED.includes(part.milestone)) throw new AppError(400, 'این قطعه وارد تولید شده و افزودن نقشه ممکن نیست.');

  const files = req.files as Express.Multer.File[];
  if (!files?.length) throw new AppError(400, 'حداقل یک فایل لازم است');

  // برای TRADING این‌ها عکس کالا هستند (بدون بازبینی فنی)، در غیر این‌صورت نقشهٔ مشتری
  const isTrading = part.project.type === 'TRADING';
  const fileType = isTrading ? 'COMMODITY_PHOTO' : 'DRAWING_CUSTOMER';
  const existing = await prisma.projectFile.count({ where: { partId: part.id, fileType } });
  const records = files.map((f, i) => {
    const newName = generateFileName(
      { level: 'part', fileType, projectCode: part.project.code, partCode: part.id.slice(-6), partName: part.name, version: `R${String(existing + i + 1).padStart(2, '0')}`, originalExt: path.extname(f.originalname) },
      f.originalname,
    );
    const newPath = path.join(path.dirname(f.path), newName);
    fs.renameSync(f.path, newPath);
    return {
      projectId: part.projectId, partId: part.id, fileType,
      originalName: f.originalname, storedName: newName, url: `/uploads/${newName}`,
      sizeBytes: f.size, mimeType: f.mimetype, uploadedById: req.user!.id,
      ...(isTrading ? {} : { reviewStatus: 'PENDING' as const }),
    };
  });
  await prisma.projectFile.createMany({ data: records });

  if (isTrading) {
    // افزودن عکس کالا وضعیت تأیید مشخصات را تغییر نمی‌دهد
    await prisma.auditLog.create({
      data: { userId: req.user!.id, action: 'UPDATE', entity: 'Part', entityId: part.id, projectId: part.projectId, changes: { event: 'PHOTOS_ADDED', count: files.length } },
    });
    return res.status(201).json({ ok: true, added: files.length });
  }

  // نقشهٔ جدید نیاز به بازبینی دارد → وضعیت فنی قطعه «در انتظار»
  await prisma.part.update({ where: { id: part.id }, data: { technicalStatus: 'PENDING' } });
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'Part', entityId: part.id, projectId: part.projectId, changes: { event: 'DRAWINGS_ADDED', count: files.length } },
  });
  await notifyProjectAudience(part.projectId, req.user!.id, 'TECHNICAL_REVIEW_NEEDED', `${files.length} نقشهٔ جدید برای قطعهٔ «${part.name}» اضافه شد و نیازمند بازبینی است`, 'Part', part.id);
  res.status(201).json({ ok: true, added: files.length });
});

// ─── PARTS: APPROVE SPEC (تأیید مشخصات کالای خرید — جایگزین بازبینی فنی) ──
router.post('/:id/parts/:partId/approve-spec', requirePermission('projects', 'edit'), async (req: Request, res: Response) => {
  const part = await prisma.part.findUnique({ where: { id: req.params.partId }, include: { project: true } });
  if (!part) throw new AppError(404, 'Part not found');
  if (part.project.type !== 'TRADING') throw new AppError(400, 'تأیید مشخصات فقط برای پروژه‌های خرید کالا کاربرد دارد');
  if (part.milestone !== 'CREATED') throw new AppError(400, 'این کالا دیگر در مرحلهٔ تأیید مشخصات نیست');

  const updated = await prisma.part.update({ where: { id: part.id }, data: { technicalStatus: 'APPROVED' } });
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'Part', entityId: part.id, projectId: part.projectId, changes: { event: 'SPEC_APPROVED', technicalStatus: 'APPROVED' } },
  });
  await notifyProjectAudience(part.projectId, req.user!.id, 'SPEC_APPROVED', `مشخصات کالای «${part.name}» در پروژهٔ ${part.project.code} تأیید شد`, 'Part', part.id);
  res.json(updated);
});

// ─── PARTS: DELETE ────────────────────────────
// حذف تا قبل از ورود به تولید مجاز است (شامل قطعاتی که برای قیمت‌گیری رفته‌اند)؛
// اگر در فاکتور فعال (غیر ردشده) باشد مسدود می‌شود تا حساب‌ها خراب نشود.
router.delete('/:id/parts/:partId', async (req: Request, res: Response) => {
  const part = await prisma.part.findUnique({
    where: { id: req.params.partId },
    include: { invoiceItems: { include: { invoice: { select: { status: true, versionCode: true } } } } },
  });
  if (!part) throw new AppError(404, 'Part not found');

  const LOCKED = ['ORDER_PLACED', 'IN_PRODUCTION', 'QUALITY_CONTROL', 'COMPLETED', 'IN_TRANSIT', 'DELIVERED'];
  if (LOCKED.includes(part.milestone)) {
    throw new AppError(400, 'این قطعه وارد مرحلهٔ تولید/حمل شده و دیگر قابل حذف نیست.');
  }
  const activeInvoiceItem = part.invoiceItems.find((it) => it.invoice && it.invoice.status !== 'REJECTED');
  if (activeInvoiceItem) {
    throw new AppError(400, `این قطعه در فاکتور ${activeInvoiceItem.invoice!.versionCode} قرار دارد؛ ابتدا آن فاکتور را رد یا اصلاح کنید.`);
  }

  // پاک‌سازی امن وابستگی‌ها سپس حذف قطعه (در یک تراکنش)
  await prisma.$transaction([
    prisma.invoiceItem.deleteMany({ where: { partId: part.id } }),
    prisma.drawingReview.deleteMany({ where: { partId: part.id } }),
    prisma.selectedPrice.deleteMany({ where: { partId: part.id } }),
    prisma.partPrice.deleteMany({ where: { partId: part.id } }),
    prisma.technicalReview.deleteMany({ where: { partId: part.id } }),
    prisma.projectFile.deleteMany({ where: { partId: part.id } }),
    prisma.part.delete({ where: { id: part.id } }),
  ]);

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'DELETE', entity: 'Part', entityId: part.id, projectId: part.projectId, changes: { name: part.name, milestone: part.milestone } },
  });
  res.status(204).send();
});

// ─── PART GROUPS ──────────────────────────────
router.post('/:id/groups', async (req: Request, res: Response) => {
  const { partIds } = req.body;
  if (!partIds || partIds.length < 2) throw new AppError(400, 'At least 2 parts required for a group');

  const COLORS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fecaca', '#ddd6fe', '#fed7aa'];
  const existingGroups = await prisma.partGroup.count({ where: { projectId: req.params.id } });
  const color = COLORS[existingGroups % COLORS.length];

  const group = await prisma.partGroup.create({ data: { projectId: req.params.id, color } });

  await prisma.part.updateMany({
    where: { id: { in: partIds }, projectId: req.params.id, archivedAt: null },
    data: { groupId: group.id },
  });

  res.status(201).json(group);
});

router.delete('/:id/groups/remove', async (req: Request, res: Response) => {
  const { partIds } = req.body;
  await prisma.part.updateMany({
    where: { id: { in: partIds }, projectId: req.params.id },
    data: { groupId: null },
  });
  res.json({ ok: true });
});

// ─── PROJECT DOCUMENTS (aggregated across all levels) ──
router.get('/:id/documents', async (req: Request, res: Response) => {
  const projectId = req.params.id;

  const [projectFiles, orders, journalEntries, invoices, pricingRequests] = await Promise.all([
    prisma.projectFile.findMany({
      where: { projectId },
      include: { part: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.productionOrder.findMany({
      where: { projectId },
      include: { producer: { select: { name: true } }, supplier: { select: { name: true } }, orderFiles: true },
    }),
    prisma.journalEntry.findMany({
      where: { projectId, attachmentUrls: { isEmpty: false } },
      select: { id: true, description: true, attachmentUrls: true, date: true },
    }),
    // فاکتورهای فروش تأییدشده و فاکتورهای ردشده (با دلیل) — مدارک مشتری
    prisma.invoice.findMany({
      where: { projectId, status: { in: ['APPROVED', 'REJECTED'] } },
      select: { id: true, versionCode: true, status: true, rejectReason: true, createdAt: true },
      orderBy: { versionNumber: 'desc' },
    }),
    prisma.pricingRequest.findMany({ where: { projectId }, select: { id: true } }),
  ]);

  // ۱۰.۲ — پرفرماهای آپلودشدهٔ سازندگان در اسناد پروژه
  const proformaRows = await prisma.pricingProforma.findMany({
    where: { pricingRequestId: { in: pricingRequests.map((p) => p.id) } },
    orderBy: { createdAt: 'desc' },
  });
  const proformaProducerIds = [...new Set(proformaRows.map((p) => p.producerId).filter((x): x is string => !!x))];
  const proformaSupplierIds = [...new Set(proformaRows.map((p) => p.supplierId).filter((x): x is string => !!x))];
  const [proformaProducers, proformaSuppliers] = await Promise.all([
    proformaProducerIds.length ? prisma.producer.findMany({ where: { id: { in: proformaProducerIds } }, select: { id: true, name: true } }) : [],
    proformaSupplierIds.length ? prisma.supplier.findMany({ where: { id: { in: proformaSupplierIds } }, select: { id: true, name: true } }) : [],
  ]);
  const pName: Record<string, string> = Object.fromEntries([...proformaProducers, ...proformaSuppliers].map((p) => [p.id, p.name]));

  // اسناد حمل: فایل‌های محموله‌هایی که این پروژه در آن‌هاست — یک فاکتور حمل می‌تواند چند پروژه را پوشش دهد، پس در اسناد همهٔ آن پروژه‌ها دیده می‌شود
  const freightShipments = await prisma.mainShipment.findMany({
    where: { files: { some: {} }, packages: { some: { package: { items: { some: { order: { projectId } } } } } } },
    include: { shippingCompany: { select: { name: true } }, files: { orderBy: { createdAt: 'desc' } } },
  });
  const freightDocs = freightShipments.flatMap((s) =>
    s.files.map((f) => ({ id: f.id, fileType: f.fileType, storedName: f.storedName, url: f.url, createdAt: f.createdAt, shipmentCode: s.code, carrier: s.shippingCompany?.name || '—' })));

  // Categorize — علاوه بر منابع خودکار، فایل‌های دستیِ افزوده‌شده به هر دسته
  const PART_TYPES = ['DRAWING_CUSTOMER', 'DRAWING_ENGINEERING', 'RENDER', 'PART_DOC'];
  const ELSEWHERE = ['ORDER_DOC', 'FINANCIAL_DOC'];

  // اسناد سطح‌پروژه: هر فایل بدون قطعه که به بخش قطعات/سفارش/مالی تعلق ندارد (شامل عناوین سفارشی ۱.۶)
  const projectLevel = projectFiles.filter((f) => !f.partId && !PART_TYPES.includes(f.fileType) && !ELSEWHERE.includes(f.fileType));
  const partLevel = projectFiles.filter((f) => f.partId || PART_TYPES.includes(f.fileType));

  const orderLevel = [
    ...orders.flatMap((o) =>
      o.orderFiles.map((f) => ({ id: f.id, fileType: f.fileType, storedName: f.storedName, url: f.url, createdAt: f.createdAt, orderCode: o.code, producer: o.producer?.name ?? o.supplier?.name ?? '' }))),
    ...projectFiles.filter((f) => f.fileType === 'ORDER_DOC').map((f) => ({ id: f.id, fileType: f.fileType, storedName: f.storedName, url: f.url, createdAt: f.createdAt, orderCode: '—', producer: 'افزودهٔ دستی', description: f.description })),
  ];

  const financialLevel = [
    ...journalEntries.flatMap((e) => e.attachmentUrls.map((url, i) => ({ id: `${e.id}_${i}`, description: e.description, url, date: e.date }))),
    ...projectFiles.filter((f) => f.fileType === 'FINANCIAL_DOC').map((f) => ({ id: f.id, description: f.description || f.storedName, url: f.url, date: f.createdAt, storedName: f.storedName })),
  ];

  res.json({
    project: projectLevel,
    parts: partLevel.map((f) => ({ ...f, partName: f.part?.name })),
    orders: orderLevel,
    financial: financialLevel,
    proformas: proformaRows.map((p) => ({ id: p.id, url: p.url, storedName: (p.url.split('/').pop() || 'proforma'), description: p.note, createdAt: p.createdAt, producer: pName[(p.producerId ?? p.supplierId) || ''] || 'فروشنده' })),
    freightDocs,
    invoices: invoices.map((inv) => ({ id: inv.id, versionCode: inv.versionCode, status: inv.status, rejectReason: inv.rejectReason, createdAt: inv.createdAt })),
  });
});

// ─── N1/N2 — تجمیع همهٔ یادداشت‌های پروژه از بخش‌های مختلف (با بخش/جا/تاریخ/کاربر) ──
router.get('/:id/notes', async (req: Request, res: Response) => {
  const projectId = req.params.id;
  type NoteItem = { section: string; place: string; note: string; date: Date; userId: string | null };
  const items: NoteItem[] = [];
  const push = (section: string, place: string, note: any, date: any, userId: string | null = null) => {
    if (note != null && String(note).trim() !== '') items.push({ section, place, note: String(note).trim(), date: new Date(date || Date.now()), userId });
  };

  const [project, prs, orders, invoices, techReviews, tasks, delivery] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId }, select: { description: true, createdAt: true } }),
    prisma.pricingRequest.findMany({ where: { projectId }, select: { id: true, notes: true, updatedAt: true } }),
    prisma.productionOrder.findMany({ where: { projectId }, select: { id: true, code: true, notes: true, packagingDetails: true, updatedAt: true } }),
    prisma.invoice.findMany({ where: { projectId }, select: { versionCode: true, notes: true, rejectReason: true, prepNote: true, createdAt: true } }),
    prisma.technicalReview.findMany({ where: { part: { projectId } }, select: { notes: true, rejectReason: true, reviewedAt: true, reviewedById: true, part: { select: { name: true } } } }),
    prisma.task.findMany({ where: { projectId }, select: { title: true, notes: true, createdAt: true, createdById: true } }),
    prisma.customerDelivery.findUnique({ where: { projectId }, select: { notes: true, overrideReason: true, deliveredAt: true, deliveredById: true } }),
  ]);

  if (project?.description) push('پروژه‌ها', 'توضیحات پروژه', project.description, project.createdAt);
  for (const pr of prs) push('قیمت‌گیری', 'یادداشت درخواست قیمت', pr.notes, pr.updatedAt);

  const proformas = prs.length ? await prisma.pricingProforma.findMany({ where: { pricingRequestId: { in: prs.map((p) => p.id) } }, select: { note: true, createdAt: true, uploadedById: true, producerId: true, supplierId: true } }) : [];
  const profProducerIds = [...new Set(proformas.map((p) => p.producerId).filter((x): x is string => !!x))];
  const profSupplierIds = [...new Set(proformas.map((p) => p.supplierId).filter((x): x is string => !!x))];
  const [profProducers, profSuppliers] = await Promise.all([
    profProducerIds.length ? prisma.producer.findMany({ where: { id: { in: profProducerIds } }, select: { id: true, name: true } }) : [],
    profSupplierIds.length ? prisma.supplier.findMany({ where: { id: { in: profSupplierIds } }, select: { id: true, name: true } }) : [],
  ]);
  const profPName: Record<string, string> = Object.fromEntries([...profProducers, ...profSuppliers].map((p) => [p.id, p.name]));
  for (const pf of proformas) push('قیمت‌گیری', `پرفرمای ${profPName[(pf.producerId ?? pf.supplierId) || ''] || 'فروشنده'}`, pf.note, pf.createdAt, pf.uploadedById);

  for (const inv of invoices) {
    push('صدور فاکتور', `توافقات فاکتور ${inv.versionCode}`, inv.notes, inv.createdAt);
    push('صدور فاکتور', `دلیل رد فاکتور ${inv.versionCode}`, inv.rejectReason, inv.createdAt);
    push('صدور فاکتور', `یادداشت زمان آماده‌سازی ${inv.versionCode}`, inv.prepNote, inv.createdAt);
  }

  for (const o of orders) {
    push('سفارش‌ها', `سفارش ${o.code}`, o.notes, o.updatedAt);
    push('سفارش‌ها', `جزئیات بسته‌بندی ${o.code}`, o.packagingDetails, o.updatedAt);
  }

  for (const tr of techReviews) {
    push('بازبینی فنی', `قطعهٔ ${tr.part?.name || ''}`, tr.notes, tr.reviewedAt || project?.createdAt, tr.reviewedById);
    push('بازبینی فنی', `دلیل رد قطعهٔ ${tr.part?.name || ''}`, tr.rejectReason, tr.reviewedAt || project?.createdAt, tr.reviewedById);
  }

  for (const t of tasks) push('وظایف', t.title || 'وظیفه', t.notes, t.createdAt, t.createdById);

  // حمل و نقل — بسته‌های داخلی و محموله‌های اصلی مرتبط با سفارش‌های این پروژه + تحویل
  const orderIds = orders.map((o) => o.id);
  if (orderIds.length) {
    const domItems = await prisma.domesticPackageItem.findMany({ where: { orderId: { in: orderIds } }, select: { package: { select: { id: true, code: true, notes: true, createdAt: true } } } });
    const seenPkg = new Set<string>();
    const pkgIds: string[] = [];
    for (const di of domItems) {
      const p = di.package;
      if (!p) continue;
      pkgIds.push(p.id);
      if (p.notes && !seenPkg.has(p.id)) { seenPkg.add(p.id); push('حمل و نقل', `بستهٔ حمل داخلی ${p.code}`, p.notes, p.createdAt); }
    }
    if (pkgIds.length) {
      const shipPkgs = await prisma.shipmentPackage.findMany({ where: { packageId: { in: [...new Set(pkgIds)] } }, select: { shipment: { select: { id: true, code: true, notes: true, createdAt: true } } } });
      const seenShip = new Set<string>();
      for (const sp of shipPkgs) { const s = sp.shipment; if (s?.notes && !seenShip.has(s.id)) { seenShip.add(s.id); push('حمل و نقل', `محمولهٔ اصلی ${s.code}`, s.notes, s.createdAt); } }
    }
  }
  if (delivery) {
    push('حمل و نقل', 'توضیحات بسته‌بندی هنگام تحویل', delivery.notes, delivery.deliveredAt, delivery.deliveredById);
    push('حمل و نقل', 'دلیل «ادامه با مسئولیت خودتان»', delivery.overrideReason, delivery.deliveredAt, delivery.deliveredById);
  }

  const userIds = [...new Set(items.map((i) => i.userId).filter(Boolean))] as string[];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const uName: Record<string, string> = Object.fromEntries(users.map((u) => [u.id, u.name]));
  const result = items
    .map((i) => ({ section: i.section, place: i.place, note: i.note, date: i.date, user: i.userId ? uName[i.userId] || null : null }))
    .sort((a, b) => +new Date(b.date) - +new Date(a.date));
  res.json(result);
});

// ─── UPLOAD GENERAL PROJECT FILE ───────────────
router.post('/:id/files', upload.array('files', 10), async (req: Request, res: Response) => {
  const { fileType, shortDesc } = req.body;
  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) throw new AppError(404, 'Project not found');

  const files = req.files as Express.Multer.File[];
  if (!files?.length) throw new AppError(400, 'At least one file required');

  const type = fileType || 'GENERAL';
  const records = files.map((f) => {
    // نام فایل استاندارد بدون شرح؛ شرح جداگانه در فیلد description ذخیره می‌شود
    const newName = generateFileName(
      { level: 'project', fileType: type, projectCode: project.code, originalExt: path.extname(f.originalname) },
      f.originalname,
    );
    const newPath = path.join(path.dirname(f.path), newName);
    fs.renameSync(f.path, newPath);
    return {
      projectId: req.params.id, fileType: type,
      originalName: f.originalname, storedName: newName, url: `/uploads/${newName}`,
      sizeBytes: f.size, mimeType: f.mimetype, uploadedById: req.user!.id,
      description: shortDesc || null,
    };
  });
  await prisma.projectFile.createMany({ data: records });

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'CREATE', entity: 'ProjectFile', projectId: req.params.id, changes: { fileType: type, count: files.length } },
  });
  res.status(201).json({ ok: true });
});

// حذف یک سند پروژه
router.delete('/:id/files/:fileId', requirePermission('projects', 'edit'), async (req: Request, res: Response) => {
  const file = await prisma.projectFile.findUnique({ where: { id: req.params.fileId } });
  if (!file) throw new AppError(404, 'File not found');
  await prisma.projectFile.delete({ where: { id: req.params.fileId } });
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'DELETE', entity: 'ProjectFile', entityId: file.id, projectId: file.projectId, changes: { storedName: file.storedName } },
  });
  res.status(204).send();
});

// ویرایش شرح یک سند پروژه
router.patch('/:id/files/:fileId', requirePermission('projects', 'edit'), async (req: Request, res: Response) => {
  const { description } = req.body;
  const file = await prisma.projectFile.update({ where: { id: req.params.fileId }, data: { description: description ?? null } });
  res.json(file);
});

// ─── PROJECT TIMELINE ─────────────────────────
router.get('/:id/timeline', async (req: Request, res: Response) => {
  const logs = await prisma.auditLog.findMany({
    where: { projectId: req.params.id },
    include: { user: { select: { id: true, name: true, avatarUrl: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(logs);
});

// ─── زندگی‌نامهٔ کامل یک قطعه (ردپای همهٔ مراحل با شخص و زمان) ──
const PROD_STATUS_FA: Record<string, string> = { NEW: 'سفارش جدید', IN_PRODUCTION: 'در حال ساخت', QUALITY_CONTROL: 'کنترل کیفیت', COMPLETED: 'تکمیل‌شده (آماده ارسال)' };

router.get('/:id/parts/:partId/timeline', async (req: Request, res: Response) => {
  const part = await prisma.part.findUnique({
    where: { id: req.params.partId },
    include: { files: true, selectedPrice: true },
  });
  if (!part) throw new AppError(404, 'Part not found');

  type Ev = { at: Date; icon: string; title: string; detail?: string | null; user?: string | null };
  const events: Ev[] = [];

  // ۱) ایجاد قطعه
  events.push({ at: part.createdAt, icon: '➕', title: 'ایجاد قطعه', detail: `تعداد: ${part.quantity}` });

  // ۲) رویدادهای ثبت‌شدهٔ خود قطعه
  const logs = await prisma.auditLog.findMany({
    where: { entity: 'Part', entityId: part.id },
    include: { user: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });
  for (const l of logs) {
    const ch: any = l.changes || {};
    if (ch.event === 'DRAWING_REVISED') events.push({ at: l.createdAt, icon: '✏️', title: 'اصلاح نقشه', detail: 'بازگشت به بازبینی فنی', user: l.user?.name });
    else if (ch.archivedFromPricing) events.push({ at: l.createdAt, icon: '🗄️', title: 'بایگانی از قیمت‌گیری', detail: ch.reason || null, user: l.user?.name });
    else if (l.action === 'DELETE') events.push({ at: l.createdAt, icon: '🗑️', title: 'حذف قطعه', user: l.user?.name });
  }

  // ۳) بازبینی نقشه‌ها (هر تأیید/رد با دلیل، نقشه، بازبین و زمان)
  const dReviews = await prisma.drawingReview.findMany({ where: { partId: part.id }, orderBy: { reviewedAt: 'asc' } });
  const rIds = [...new Set(dReviews.map((d) => d.reviewedById).filter(Boolean))] as string[];
  const reviewers = rIds.length ? await prisma.user.findMany({ where: { id: { in: rIds } }, select: { id: true, name: true } }) : [];
  for (const d of dReviews) {
    events.push({
      at: d.reviewedAt,
      icon: d.status === 'APPROVED' ? '✅' : '❌',
      title: d.status === 'APPROVED' ? 'تأیید نقشه' : 'رد نقشه',
      detail: [d.fileName, d.reason].filter(Boolean).join(' — ') || null,
      user: reviewers.find((u) => u.id === d.reviewedById)?.name || null,
    });
  }

  // ۴) انتخاب قیمت/فروشنده و سفارش تولید
  if (part.selectedPrice) {
    const sp = part.selectedPrice;
    const producer = sp.producerId
      ? await prisma.producer.findUnique({ where: { id: sp.producerId }, select: { name: true } })
      : sp.supplierId ? await prisma.supplier.findUnique({ where: { id: sp.supplierId }, select: { name: true } }) : null;
    events.push({ at: sp.lockedAt, icon: '💲', title: 'انتخاب قیمت و فروشنده', detail: producer?.name || null });
    // سفارش تولید فقط برای مسیر ساخت (سازنده)؛ سفارش خرید تامین‌کننده در فاز بعدی
    const order = sp.producerId ? await prisma.productionOrder.findFirst({ where: { projectId: part.projectId, producerId: sp.producerId } }) : null;
    if (order) {
      events.push({ at: order.createdAt, icon: '🏭', title: 'ثبت سفارش تولید', detail: `${order.code} — ${producer?.name || ''}` });
      const oLogs = await prisma.auditLog.findMany({ where: { entity: 'ProductionOrder', entityId: order.id }, include: { user: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
      for (const ol of oLogs) {
        const ch: any = ol.changes || {};
        if (ch.status) events.push({ at: ol.createdAt, icon: '🔧', title: `تولید: ${PROD_STATUS_FA[ch.status] || ch.status}`, user: ol.user?.name });
      }
    }
  }

  // ۵) فاکتورها (صدور + تأیید/رد مشتری)
  const invItems = await prisma.invoiceItem.findMany({
    where: { partId: part.id },
    include: { invoice: { select: { versionCode: true, status: true, createdAt: true, confirmedAt: true, notes: true, rejectReason: true } } },
  });
  for (const it of invItems) {
    const inv = it.invoice;
    if (!inv) continue;
    events.push({ at: inv.createdAt, icon: '🧾', title: 'صدور پیش‌فاکتور', detail: inv.versionCode });
    // ۴.۲ — توضیحات توافق روی رویداد تأیید و دلیل رد روی رویداد رد در ردپای پروژه
    if (inv.status === 'APPROVED') events.push({ at: inv.confirmedAt || inv.createdAt, icon: '🤝', title: 'تأیید مشتری (فاکتور فروش)', detail: [inv.versionCode, inv.notes ? `توافق: ${inv.notes}` : null].filter(Boolean).join(' — ') });
    if (inv.status === 'REJECTED') events.push({ at: inv.createdAt, icon: '🚫', title: 'رد فاکتور توسط مشتری', detail: [inv.versionCode, inv.rejectReason ? `دلیل: ${inv.rejectReason}` : null].filter(Boolean).join(' — ') });
  }

  // ۶) حمل داخلی، محمولهٔ اصلی و تحویل — از طریق سفارشِ این قطعه
  if (part.selectedPrice?.producerId) {
    const shipOrder = await prisma.productionOrder.findFirst({ where: { projectId: part.projectId, producerId: part.selectedPrice.producerId }, select: { id: true } });
    if (shipOrder) {
      const domItems = await prisma.domesticPackageItem.findMany({
        where: { orderId: shipOrder.id },
        include: { package: { select: { id: true, code: true, referenceNo: true, createdAt: true } } },
      });
      for (const di of domItems) {
        events.push({ at: di.package.createdAt, icon: '📦', title: 'بستهٔ حمل داخلی', detail: [di.package.code, di.package.referenceNo && `رفرنس ${di.package.referenceNo}`, di.trackingNo && `رهگیری ${di.trackingNo}`].filter(Boolean).join(' — ') || null });
        const sp = await prisma.shipmentPackage.findFirst({ where: { packageId: di.package.id }, include: { shipment: { select: { code: true, forwarderRef: true, createdAt: true, arrivedAt: true, deliveredToUsAt: true } } } });
        if (sp?.shipment) {
          const sh = sp.shipment;
          events.push({ at: sh.createdAt, icon: '🚢', title: 'محمولهٔ اصلی', detail: [sh.code, sh.forwarderRef && `کد فورواردر ${sh.forwarderRef}`].filter(Boolean).join(' — ') || null });
          if (sh.arrivedAt) events.push({ at: sh.arrivedAt, icon: '🛬', title: 'محموله رسید', detail: null });
          if (sh.deliveredToUsAt) events.push({ at: sh.deliveredToUsAt, icon: '🏠', title: 'تحویل به ما', detail: null });
        }
      }
    }
  }
  const delivery = await prisma.customerDelivery.findUnique({ where: { projectId: part.projectId }, select: { deliveredAt: true } });
  if (delivery?.deliveredAt) events.push({ at: delivery.deliveredAt, icon: '🎯', title: 'تحویل به مشتری', detail: null });

  events.sort((a, b) => +new Date(a.at) - +new Date(b.at));
  res.json({
    part: { id: part.id, name: part.name, quantity: part.quantity, milestone: part.milestone, technicalStatus: part.technicalStatus, archivedAt: part.archivedAt, archivedReason: part.archivedReason },
    files: part.files,
    events,
  });
});

// ─── PROJECT COMMISSIONS ──────────────────────
router.put('/:id/commissions', async (req: Request, res: Response) => {
  const { commissions } = req.body; // [{ agentId, percentage }]
  await prisma.$transaction([
    prisma.projectCommission.deleteMany({ where: { projectId: req.params.id } }),
    ...(commissions?.length
      ? [prisma.projectCommission.createMany({
          data: commissions.filter((c: any) => c.agentId && c.percentage).map((c: any) => ({ projectId: req.params.id, agentId: c.agentId, percentage: Number(c.percentage) })),
        })]
      : []),
  ]);
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: 'UPDATE', entity: 'Project', entityId: req.params.id, projectId: req.params.id, changes: { commissions } } });
  res.json({ ok: true });
});

// ─── PROJECT SHIPPING COST (per-kg estimate) ──
router.put('/:id/shipping-cost', async (req: Request, res: Response) => {
  const { ratePerKgAmount, ratePerKgCurrency, estimatedWeightKg } = req.body;
  const { rateFor } = await import('../accounting/accounting.service');
  const rate = ratePerKgAmount ? await rateFor((ratePerKgCurrency || 'IRR') as any) : 1;
  await prisma.projectShippingCost.upsert({
    where: { projectId: req.params.id },
    create: { projectId: req.params.id, ratePerKgAmount: ratePerKgAmount ? Number(ratePerKgAmount) : null, ratePerKgCurrency: ratePerKgCurrency || 'IRR', ratePerKgRateToIRR: rate },
    update: { ratePerKgAmount: ratePerKgAmount ? Number(ratePerKgAmount) : null, ratePerKgCurrency: ratePerKgCurrency || 'IRR', ratePerKgRateToIRR: rate },
  });
  // وزن تخمینی کل پروژه (برای برآورد حمل وقتی وزن قطعات وارد نشده)
  if (estimatedWeightKg !== undefined) {
    await prisma.project.update({
      where: { id: req.params.id },
      data: { estimatedWeightKg: estimatedWeightKg !== null && estimatedWeightKg !== '' ? Number(estimatedWeightKg) : null },
    });
  }
  res.json({ ok: true });
});

// ─── PROJECT P&L REPORT (computed from double-entry journal) ──
router.get('/:id/pnl', async (req: Request, res: Response) => {
  const projectId = req.params.id;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      customer: { select: { id: true, name: true } },
      commissions: { include: { agent: { select: { name: true } } } },
      shippingCost: true,
      invoices: { where: { status: 'APPROVED' }, orderBy: { confirmedAt: 'desc' }, take: 1 },
    },
  });
  if (!project) throw new AppError(404, 'Project not found');

  const lines = await prisma.journalLine.findMany({
    where: { entry: { projectId } },
    include: { account: { select: { controlKind: true, ownerType: true, ownerId: true } }, entry: { select: { eventType: true, date: true } } },
  });

  const irr = (l: any, side: 'debit' | 'credit') => Number(l[side]) * Number(l.rateToIRR);

  let revenue = 0, cogs = 0, commission = 0, freight = 0;
  let custReceivableCreated = 0, custPaid = 0;
  let producerPayable = 0, producerPaid = 0;
  // FX tracking
  const custReceiptRates: { amt: number; rate: number }[] = [];
  const producerPayRates: { amt: number; rate: number }[] = [];
  // تفکیک به ازای هر سازنده (IRR) + فهرست واریزی‌های مشتری با تاریخ
  const producerMap: Record<string, { payable: number; paid: number }> = {};
  const customerPayments: { date: Date; amount: number; currency: string; amountIRR: number }[] = [];

  for (const l of lines) {
    const ck = l.account.controlKind;
    const ot = l.account.ownerType;
    if (ck === 'SALES') revenue += irr(l, 'credit');
    else if (ck === 'PURCHASE') cogs += irr(l, 'debit');
    else if (ck === 'COMMISSION') commission += irr(l, 'debit');
    else if (ck === 'FREIGHT') freight += irr(l, 'debit');
    else if (ot === 'CUSTOMER') {
      custReceivableCreated += irr(l, 'debit');
      const paid = irr(l, 'credit');
      custPaid += paid;
      if (Number(l.credit) > 0) {
        custReceiptRates.push({ amt: Number(l.credit), rate: Number(l.rateToIRR) });
        customerPayments.push({ date: l.entry.date, amount: Number(l.credit), currency: l.currency, amountIRR: paid });
      }
    } else if (ot === 'PRODUCER') {
      producerPayable += irr(l, 'credit');
      const paid = irr(l, 'debit');
      producerPaid += paid;
      if (Number(l.debit) > 0) producerPayRates.push({ amt: Number(l.debit), rate: Number(l.rateToIRR) });
      const pid = l.account.ownerId || 'unknown';
      if (!producerMap[pid]) producerMap[pid] = { payable: 0, paid: 0 };
      producerMap[pid].payable += irr(l, 'credit');
      producerMap[pid].paid += irr(l, 'debit');
    }
  }

  const netProfit = revenue - cogs - commission - freight;
  const remainingReceivable = custReceivableCreated - custPaid;
  const remainingPayable = producerPayable - producerPaid;

  // FX risk: weighted-avg rate at which we received customer money vs paid producers
  const wavg = (arr: { amt: number; rate: number }[]) => {
    const tot = arr.reduce((s, x) => s + x.amt, 0);
    return tot ? arr.reduce((s, x) => s + x.amt * x.rate, 0) / tot : 0;
  };

  // تفکیک سازندگان با نام
  const producerIds = Object.keys(producerMap).filter((id) => id !== 'unknown');
  const producers = producerIds.length
    ? await prisma.producer.findMany({ where: { id: { in: producerIds } }, select: { id: true, name: true } })
    : [];
  const producerBreakdown = Object.entries(producerMap).map(([id, v]) => ({
    id, name: producers.find((p) => p.id === id)?.name || 'سازنده',
    payable: v.payable, paid: v.paid, remaining: v.payable - v.paid,
  })).sort((a, b) => b.payable - a.payable);

  res.json({
    project: { id: project.id, code: project.code, customer: project.customer.name },
    agreement: project.invoices[0]?.notes || null,
    revenue, cogs, commission, freight, netProfit,
    customer: { receivableCreated: custReceivableCreated, paid: custPaid, remaining: remainingReceivable },
    producer: { payable: producerPayable, paid: producerPaid, remaining: remainingPayable },
    producerBreakdown,
    customerPayments: customerPayments.sort((a, b) => +new Date(b.date) - +new Date(a.date)),
    commissions: project.commissions.map((c) => ({ name: c.agent.name, percentage: Number(c.percentage) })),
    fx: {
      customerReceiptAvgRate: Math.round(wavg(custReceiptRates)),
      producerPayAvgRate: Math.round(wavg(producerPayRates)),
    },
  });
});

// ─── PROJECT FINANCIAL SUMMARY ────────────────
router.get('/:id/financial-summary', async (req: Request, res: Response) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      invoices: { where: { status: 'APPROVED' }, include: { items: true } },
      commissions: { include: { agent: true } },
      shippingCost: true,
      transactions: { where: { NOT: { type: undefined } } },
    },
  });
  if (!project) throw new AppError(404, 'Project not found');
  res.json(project);
});

// ─── فایل فشرده (ZIP) برای سازنده: نقشه‌های تأییدشدهٔ قطعات انتخابی + فایل اکسل ──
router.post('/:id/export-zip', async (req: Request, res: Response) => {
  const { partIds } = req.body;
  if (!Array.isArray(partIds) || !partIds.length) throw new AppError(400, 'حداقل یک قطعه انتخاب کنید');

  const project = await prisma.project.findUnique({ where: { id: req.params.id }, select: { code: true } });
  if (!project) throw new AppError(404, 'Project not found');

  const parts = await prisma.part.findMany({
    where: { id: { in: partIds }, projectId: req.params.id },
    include: {
      material: { select: { name: true } },
      coating: { select: { name: true } },
      // فقط نقشه‌هایی که از بازبینی فنی گذشته‌اند (تأییدشده)
      files: { where: { fileType: { in: ['DRAWING_CUSTOMER', 'DRAWING_ENGINEERING'] }, reviewStatus: 'APPROVED' }, orderBy: { createdAt: 'asc' } },
    },
    orderBy: { sortOrder: 'asc' },
  });
  if (!parts.length) throw new AppError(404, 'قطعه‌ای یافت نشد');

  // فایل اکسل: نام قطعه، تعداد، جنس، پوشش (به انگلیسی، یک ردیف به‌ازای هر قطعه)
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Parts');
  ws.columns = [
    { header: 'Part Name', key: 'name', width: 30 },
    { header: 'Quantity', key: 'qty', width: 12 },
    { header: 'Material', key: 'material', width: 22 },
    { header: 'Coating', key: 'coating', width: 22 },
  ];
  ws.getRow(1).font = { bold: true };
  for (const p of parts) ws.addRow({ name: p.name, qty: p.quantity, material: p.material?.name || '', coating: p.coating?.name || '' });
  const xlsxBuffer = await wb.xlsx.writeBuffer();

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${project.code}-package.zip"`);

  const archive = (archiver as any)('zip', { zlib: { level: 9 } });
  archive.on('error', () => { try { res.destroy(); } catch { /* noop */ } });
  archive.pipe(res);

  // اکسل
  archive.append(Buffer.from(xlsxBuffer), { name: `${project.code}-parts-list.xlsx` });

  // نقشه‌ها با نام استاندارد؛ چند نقشهٔ یک قطعه → پسوند _01/_02/...
  for (const p of parts) {
    p.files.forEach((f, i) => {
      const physical = path.join(UPLOAD_DIR, f.storedName);
      if (fs.existsSync(physical)) {
        const ext = path.extname(f.storedName);
        const base = path.basename(f.storedName, ext);
        const name = p.files.length > 1 ? `${base}_${String(i + 1).padStart(2, '0')}${ext}` : f.storedName;
        archive.file(physical, { name: `drawings/${name}` });
      }
    });
  }

  await archive.finalize();
});

export default router;
