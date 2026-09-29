import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { upload } from '../../shared/middleware/upload';
import { AppError } from '../../shared/middleware/errorHandler';
import { requirePermission } from '../../shared/middleware/permissions';
import { getLiveRates } from '../../shared/utils/money';
import { projectAccessWhere } from '../../shared/utils/projectAccess';
import { generateFileName } from '../../shared/utils/fileNaming';
import path from 'path';
import fs from 'fs';

const router = Router();
router.use(authenticate);

// گسترش قطعات به هم‌گروهی‌ها: اگر قطعه‌ای در «گروه هم‌بستگی» باشد، همهٔ اعضای گروه با هم تخصیص می‌یابند
// (قاعدهٔ سطح‌گروه: اعضای یک گروه همیشه سازنده‌های یکسان می‌گیرند)
async function expandWithGroupSiblings(projectId: string, partIds: string[]): Promise<string[]> {
  const parts = await prisma.part.findMany({ where: { projectId }, select: { id: true, groupId: true } });
  const byGroup: Record<string, string[]> = {};
  for (const p of parts) if (p.groupId) (byGroup[p.groupId] ||= []).push(p.id);
  const set = new Set(partIds);
  for (const p of parts) if (set.has(p.id) && p.groupId) byGroup[p.groupId].forEach((id) => set.add(id));
  return [...set];
}

// فروشنده = سازنده (ساخت) یا تامین‌کننده (خرید). ورودی دقیقاً یکی از producerId/supplierId را دارد.
type VendorRef = { producerId?: string | null; supplierId?: string | null };

// where برای یافتن ردیف فروشنده در یک درخواست، بر اساس نوع فروشنده
function vendorCols(v: VendorRef): { producerId?: string; supplierId?: string } {
  return v.supplierId ? { supplierId: v.supplierId } : { producerId: v.producerId! };
}

// upsert ردیف PricingProducer برای فروشنده (سازنده از compound-unique، تامین‌کننده از findFirst)
async function upsertPricingVendor(pricingRequestId: string, v: VendorRef) {
  if (v.supplierId) {
    const found = await prisma.pricingProducer.findFirst({ where: { pricingRequestId, supplierId: v.supplierId } });
    return found ?? prisma.pricingProducer.create({ data: { pricingRequestId, supplierId: v.supplierId } });
  }
  return prisma.pricingProducer.upsert({
    where: { pricingRequestId_producerId: { pricingRequestId, producerId: v.producerId! } },
    create: { pricingRequestId, producerId: v.producerId! },
    update: {},
  });
}

// استخراج فهرست فروشنده‌ها از بدنه: assignments یا (producerIds/supplierIds + partIds)
function readVendorList(body: any): VendorRef[] {
  if (body.producerIds?.length) return body.producerIds.map((id: string) => ({ producerId: id }));
  if (body.supplierIds?.length) return body.supplierIds.map((id: string) => ({ supplierId: id }));
  return [];
}

// List all pricing requests
router.get('/', async (req: Request, res: Response) => {
  const { status, customerId } = req.query;
  const where: any = {};
  if (status) where.status = status;
  if (customerId) where.project = { customerId };
  Object.assign(where, await projectAccessWhere(req.user!.id, req.user!.role, 'projectId'));

  const requests = await prisma.pricingRequest.findMany({
    where,
    include: {
      project: { include: { customer: { select: { id: true, name: true } } } },
      producers: { include: { producer: { select: { id: true, name: true } }, supplier: { select: { id: true, name: true } } } },
      partPrices: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(requests);
});

// Create pricing request — با تخصیص سازنده به قطعات (per-part)
// بدنه یکی از این دو حالت:
//   - assignments: [{ producerId, partIds }]  (تخصیص دقیق «کدام سازنده برای کدام قطعات»)
//   - legacy/دسته‌ای: producerIds + partIds     (همهٔ سازنده‌ها برای همهٔ قطعات)
router.post('/', requirePermission('pricing', 'create'), async (req: Request, res: Response) => {
  const { projectId } = req.body;
  if (!projectId) throw new AppError(400, 'projectId required');

  // بدنه: assignments: [{ producerId?|supplierId?, partIds }]  یا  (producerIds/supplierIds + partIds)
  let assignments: (VendorRef & { partIds: string[] })[] = req.body.assignments;
  if (!assignments?.length) {
    const vendors = readVendorList(req.body);
    const { partIds } = req.body;
    if (!vendors.length || !partIds?.length) {
      throw new AppError(400, 'assignments یا (producerIds/supplierIds و partIds) لازم است');
    }
    assignments = vendors.map((v) => ({ ...v, partIds }));
  }

  // گسترش گروه هم‌بستگی برای هر تخصیص + جمع همهٔ قطعات
  const expanded = await Promise.all(
    assignments.map(async (a) => ({ producerId: a.producerId, supplierId: a.supplierId, partIds: await expandWithGroupSiblings(projectId, a.partIds || []) })),
  );
  const allPartIds = [...new Set(expanded.flatMap((a) => a.partIds))];
  if (!allPartIds.length) throw new AppError(400, 'هیچ قطعه‌ای انتخاب نشده است');

  // Validate all selected parts are technically approved
  const parts = await prisma.part.findMany({ where: { id: { in: allPartIds }, projectId } });
  const unapproved = parts.filter((p) => p.technicalStatus !== 'APPROVED');
  if (unapproved.length > 0) {
    throw new AppError(400, `Parts not technically approved: ${unapproved.map((p) => p.name).join(', ')}`);
  }

  // Check if an active pricing request already exists for this project
  let pricingRequest = await prisma.pricingRequest.findFirst({ where: { projectId, status: 'IN_PROGRESS' } });
  if (!pricingRequest) pricingRequest = await prisma.pricingRequest.create({ data: { projectId } });

  // برای هر فروشنده: upsert PricingProducer، سپس تخصیص قطعات (PricingProducerPart)
  for (const a of expanded) {
    const pp = await upsertPricingVendor(pricingRequest.id, a);
    for (const partId of a.partIds) {
      await prisma.pricingProducerPart.upsert({
        where: { pricingProducerId_partId: { pricingProducerId: pp.id, partId } },
        create: { pricingProducerId: pp.id, partId },
        update: {},
      });
    }
  }

  // Update parts milestone — و پاک‌کردن بایگانیِ قبلی تا قطعهٔ بایگانی‌شده دوباره قابل ارسال برای قیمت‌گیری باشد (رفع باگ ۳.۳)
  await prisma.part.updateMany({
    where: { id: { in: allPartIds } },
    data: { milestone: 'PRICED_AND_INVOICED', archivedAt: null, archivedReason: null },
  });

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'CREATE', entity: 'PricingRequest', entityId: pricingRequest.id, projectId, changes: { assignments: expanded } },
  });

  res.status(201).json(pricingRequest);
});

// Get pricing request detail
router.get('/:id', async (req: Request, res: Response) => {
  const pr = await prisma.pricingRequest.findUnique({
    where: { id: req.params.id },
    include: {
      project: {
        include: {
          customer: true,
          parts: {
            // ۴.۳ — قطعاتی که هنوز در قیمت‌گیری‌اند یا در همین درخواست قیمت خورده‌اند (حتی اگر به تولید رفته‌اند)
            // تا در درخواست‌های تکمیل‌شده هم قطعات و قیمت سایر سازنده‌ها قابل‌مشاهده باشد
            where: { archivedAt: null, OR: [{ milestone: 'PRICED_AND_INVOICED' }, { partPrices: { some: { pricingRequestId: req.params.id } } }] },
            include: { group: true, selectedPrice: true },
            orderBy: { sortOrder: 'asc' },
          },
          partGroups: true,
        },
      },
      producers: {
        include: { producer: true, supplier: true, parts: { select: { partId: true } } },
      },
      partPrices: { include: { part: true } },
    },
  });
  if (!pr) throw new AppError(404, 'Pricing request not found');
  res.json(pr);
});

// Enter/update a price for a part + producer
router.put('/:id/prices', async (req: Request, res: Response) => {
  const { prices } = req.body;
  // prices: Array<{ partId, producerId?|supplierId?, amount, currency }>
  if (!prices?.length) throw new AppError(400, 'prices array required');

  const rates = await getLiveRates();
  const now = new Date();

  const ops = prices.map((p: any) => {
    const rateToIRR = p.currency === 'IRR' ? 1 : p.currency === 'USD' ? rates.USD_TO_IRR : rates.CNY_TO_IRR;
    // مسیر سازنده از compound-unique استفاده می‌کند؛ مسیر تامین‌کننده از upsert دستی
    if (p.supplierId) {
      return (async () => {
        const existing = await prisma.partPrice.findFirst({
          where: { pricingRequestId: req.params.id, partId: p.partId, supplierId: p.supplierId },
        });
        if (existing) {
          return prisma.partPrice.update({ where: { id: existing.id }, data: { amount: p.amount, currency: p.currency, rateToIRR, rateAt: now } });
        }
        return prisma.partPrice.create({
          data: { pricingRequestId: req.params.id, partId: p.partId, supplierId: p.supplierId, amount: p.amount, currency: p.currency, rateToIRR, rateAt: now },
        });
      })();
    }
    return prisma.partPrice.upsert({
      where: { pricingRequestId_partId_producerId: { pricingRequestId: req.params.id, partId: p.partId, producerId: p.producerId } },
      create: { pricingRequestId: req.params.id, partId: p.partId, producerId: p.producerId, amount: p.amount, currency: p.currency, rateToIRR, rateAt: now },
      update: { amount: p.amount, currency: p.currency, rateToIRR, rateAt: now },
    });
  });

  await Promise.all(ops);
  res.json({ ok: true });
});

// Set delivery days for a producer in this request
router.patch('/:id/producers/:producerId', upload.single('proforma'), async (req: Request, res: Response) => {
  const { deliveryDays, proformaNote } = req.body;
  const data: any = {};
  if (deliveryDays) data.deliveryDays = Number(deliveryDays);

  // پارامتر مسیر «vendorId» است: می‌تواند id سازنده یا تامین‌کننده باشد
  const vid = req.params.producerId;
  const pp = await prisma.pricingProducer.findFirst({
    where: { pricingRequestId: req.params.id, OR: [{ producerId: vid }, { supplierId: vid }] },
    include: { producer: { select: { name: true } }, supplier: { select: { name: true } } },
  });
  if (!pp) throw new AppError(404, 'Vendor not in this pricing request');
  const vendorName = pp.producer?.name ?? pp.supplier?.name;
  const vendorCol = pp.supplierId ? { supplierId: pp.supplierId } : { producerId: pp.producerId };

  // نام‌گذاری استاندارد پرفرما (به‌جای نام خام آپلود): PRJ-{کدپروژه}_QT_from-{فروشنده}_RNN_{تاریخ}
  let proformaUrl: string | null = null;
  if (req.file) {
    const pr = await prisma.pricingRequest.findUnique({
      where: { id: req.params.id },
      select: { project: { select: { code: true } } },
    });
    const existing = await prisma.pricingProforma.count({
      where: { pricingRequestId: req.params.id, ...vendorCol },
    });
    const newName = generateFileName(
      {
        level: 'pricing',
        fileType: 'PROFORMA',
        projectCode: pr?.project?.code,
        vendorCode: vendorName,
        version: `R${String(existing + 1).padStart(2, '0')}`,
        originalExt: path.extname(req.file.originalname),
      },
      req.file.originalname,
    );
    fs.renameSync(req.file.path, path.join(path.dirname(req.file.path), newName));
    proformaUrl = `/uploads/${newName}`;
    data.proformaFileUrl = proformaUrl;
  }

  await prisma.pricingProducer.update({ where: { id: pp.id }, data });

  // آرشیو نسخه‌های پرفرما: با هر بازآپلود، نسخهٔ قبلی حفظ می‌شود (مذاکره مجدد با فروشنده)
  if (req.file) {
    await prisma.pricingProforma.create({
      data: {
        pricingRequestId: req.params.id,
        ...vendorCol,
        url: proformaUrl!,
        note: proformaNote || null,
        uploadedById: req.user!.id,
      },
    });
  } else if (proformaNote != null) {
    // ویرایش یادداشت آخرین پرفرما بدون فایل جدید
    const latest = await prisma.pricingProforma.findFirst({
      where: { pricingRequestId: req.params.id, ...vendorCol },
      orderBy: { createdAt: 'desc' },
    });
    if (latest) await prisma.pricingProforma.update({ where: { id: latest.id }, data: { note: proformaNote } });
  }

  res.json({ ok: true });
});

// تاریخچهٔ نسخه‌های پرفرمای یک فروشنده در این درخواست (پارامتر vendorId = سازنده یا تامین‌کننده)
router.get('/:id/producers/:producerId/proformas', async (req: Request, res: Response) => {
  const vid = req.params.producerId;
  const list = await prisma.pricingProforma.findMany({
    where: { pricingRequestId: req.params.id, OR: [{ producerId: vid }, { supplierId: vid }] },
    orderBy: { createdAt: 'desc' },
  });
  res.json(list);
});

// ویرایش یادداشت کلی درخواست قیمت (یادداشت زیر فرم)
router.patch('/:id', async (req: Request, res: Response) => {
  const { notes } = req.body;
  const pr = await prisma.pricingRequest.update({ where: { id: req.params.id }, data: { notes: notes ?? null } });
  res.json(pr);
});

// حذف (بایگانی) یک قطعه از مرحلهٔ قیمت‌گیری — طبق قاعده، قطعهٔ بایگانی‌شده دوباره قابل ارسال برای قیمت‌گیری است
router.post('/:id/parts/:partId/archive', async (req: Request, res: Response) => {
  const { reason } = req.body;
  const part = await prisma.part.findUnique({ where: { id: req.params.partId } });
  if (!part) throw new AppError(404, 'Part not found');
  await prisma.part.update({
    where: { id: req.params.partId },
    data: { archivedAt: new Date(), archivedReason: reason || 'حذف از قیمت‌گیری', milestone: 'CREATED' },
  });
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'Part', entityId: req.params.partId, projectId: part.projectId, changes: { archivedFromPricing: true, reason: reason || null } },
  });
  res.json({ ok: true });
});

// بازگردانی قطعهٔ بایگانی‌شده تا دوباره قابل انتخاب و ارسال برای قیمت‌گیری باشد (رفع باگ ۳.۳)
router.post('/parts/:partId/restore', async (req: Request, res: Response) => {
  const part = await prisma.part.findUnique({ where: { id: req.params.partId } });
  if (!part) throw new AppError(404, 'Part not found');
  await prisma.part.update({
    where: { id: req.params.partId },
    data: { archivedAt: null, archivedReason: null },
  });
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'Part', entityId: req.params.partId, projectId: part.projectId, changes: { restoredFromArchive: true } },
  });
  res.json({ ok: true });
});

// Add more producers to existing request — با تخصیص قطعات (اگر partIds ندهد، به همهٔ قطعاتِ فعلی درخواست تخصیص می‌یابد)
router.post('/:id/producers', async (req: Request, res: Response) => {
  const { partIds } = req.body;
  const vendors = readVendorList(req.body); // producerIds یا supplierIds
  const pr = await prisma.pricingRequest.findUnique({ where: { id: req.params.id }, select: { projectId: true } });
  if (!pr) throw new AppError(404, 'Pricing request not found');

  let targetPartIds: string[] = partIds;
  if (!targetPartIds?.length) {
    const existing = await prisma.pricingProducerPart.findMany({
      where: { pricingProducer: { pricingRequestId: req.params.id } },
      select: { partId: true }, distinct: ['partId'],
    });
    targetPartIds = existing.map((e) => e.partId);
  }
  targetPartIds = await expandWithGroupSiblings(pr.projectId, targetPartIds);

  for (const v of vendors) {
    const pp = await upsertPricingVendor(req.params.id, v);
    for (const partId of targetPartIds) {
      await prisma.pricingProducerPart.upsert({
        where: { pricingProducerId_partId: { pricingProducerId: pp.id, partId } },
        create: { pricingProducerId: pp.id, partId },
        update: {},
      });
    }
  }
  res.json({ ok: true });
});

// Add more parts to existing request
router.post('/:id/parts', async (req: Request, res: Response) => {
  const { partIds } = req.body;
  const pr = await prisma.pricingRequest.findUnique({ where: { id: req.params.id } });
  if (!pr) throw new AppError(404, 'Pricing request not found');

  // Mark parts as sent
  await prisma.part.updateMany({
    where: { id: { in: partIds } },
    data: { milestone: 'PRICED_AND_INVOICED' },
  });
  res.json({ ok: true });
});

// Finalize: select winners and move to invoicing
router.post('/:id/finalize', async (req: Request, res: Response) => {
  // selections: Array<{ partId, producerId?|supplierId? }>
  const { selections } = req.body;
  if (!selections?.length) throw new AppError(400, 'selections required');

  const rates = await getLiveRates();
  const now = new Date();

  const pr = await prisma.pricingRequest.findUnique({
    where: { id: req.params.id },
    include: { partPrices: true },
  });
  if (!pr) throw new AppError(404, 'Pricing request not found');

  // فقط انتخاب‌هایی که قیمت ثبت‌شده در DB دارند نهایی می‌شوند.
  // قطعاتی که فروشنده برایشان قیمت نداده یا کاربر صرف‌نظر کرده، رد می‌شوند و کل عملیات را متوقف نمی‌کنند.
  const selectedOps: any[] = [];
  const skippedParts: string[] = [];
  for (const sel of selections) {
    const priceRecord = pr.partPrices.find(
      (pp) => pp.partId === sel.partId && (sel.supplierId ? pp.supplierId === sel.supplierId : pp.producerId === sel.producerId),
    );
    if (!priceRecord) { skippedParts.push(sel.partId); continue; }
    const vendorCol = sel.supplierId ? { supplierId: sel.supplierId, producerId: null } : { producerId: sel.producerId, supplierId: null };
    selectedOps.push(prisma.selectedPrice.upsert({
      where: { partId: sel.partId },
      create: {
        partId: sel.partId,
        ...vendorCol,
        amount: priceRecord.amount,
        currency: priceRecord.currency,
        rateToIRR: priceRecord.rateToIRR,
        rateAt: priceRecord.rateAt,
      },
      update: {
        ...vendorCol,
        amount: priceRecord.amount,
        currency: priceRecord.currency,
        rateToIRR: priceRecord.rateToIRR,
      },
    }));
  }
  if (selectedOps.length === 0) {
    throw new AppError(400, 'هیچ قطعه‌ای با قیمت معتبر برای نهایی‌سازی نیست. ابتدا قیمت‌ها را ذخیره کنید و حداقل یک فروشندهٔ برنده انتخاب کنید.');
  }

  // ساخت و خرید کالا هر دو پس از نهایی‌شدن قیمت، آمادهٔ صدور پیش‌فاکتور برای مشتری می‌شوند.
  // سفارش نزد تامین‌کننده و پرداخت به او (خرید کالا) فقط پس از تأیید مشتری و دریافت پیش‌پرداخت ثبت می‌شود (در تأیید فاکتور).
  await prisma.$transaction([
    ...selectedOps,
    prisma.pricingRequest.update({
      where: { id: req.params.id },
      data: { status: 'COMPLETED' },
    }),
    prisma.project.update({ where: { id: pr.projectId }, data: { status: 'READY_FOR_INVOICE' } }),
  ]);

  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'UPDATE',
      entity: 'PricingRequest',
      entityId: req.params.id,
      projectId: pr.projectId,
      changes: { status: 'COMPLETED', finalized: selectedOps.length, skipped: skippedParts.length },
    },
  });

  res.json({
    ok: true,
    message: 'قیمت‌ها نهایی شد و آمادهٔ صدور پیش‌فاکتور برای مشتری است.',
    finalized: selectedOps.length, skipped: skippedParts.length,
  });
});

// ۳.۴ — بازگشایی درخواست قیمتِ نهایی‌شده برای «تغییر سازنده/برنده» — فقط تا پیش از تأیید فاکتور توسط مشتری
router.post('/:id/reopen', async (req: Request, res: Response) => {
  const pr = await prisma.pricingRequest.findUnique({ where: { id: req.params.id }, select: { id: true, projectId: true, status: true } });
  if (!pr) throw new AppError(404, 'Pricing request not found');

  // اگر فاکتور تأییدشده وجود دارد، سفارش تولید ثبت شده و تغییر سازنده دیگر ممکن نیست
  const approved = await prisma.invoice.findFirst({ where: { projectId: pr.projectId, status: 'APPROVED' } });
  if (approved) throw new AppError(400, 'فاکتور این پروژه تأیید شده و دیگر امکان تغییر سازنده نیست.');

  // فاکتورهای تأییدنشده (پیش‌نویس/ارسال‌شده) باطل می‌شوند تا با سازندهٔ جدید دوباره صادر شوند
  await prisma.invoice.updateMany({ where: { projectId: pr.projectId, status: { in: ['DRAFT', 'SENT'] } }, data: { status: 'SUPERSEDED' } });

  // بازگشت به «در جریان» تا کاربر دوباره قیمت/برندهٔ سازنده را انتخاب و نهایی کند
  await prisma.pricingRequest.update({ where: { id: pr.id }, data: { status: 'IN_PROGRESS' } });

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'PricingRequest', entityId: pr.id, projectId: pr.projectId, changes: { reopenedForProducerChange: true } },
  });
  res.json({ ok: true });
});

// Archive pricing request
router.post('/:id/archive', async (req: Request, res: Response) => {
  const { reason } = req.body;
  await prisma.pricingRequest.update({
    where: { id: req.params.id },
    data: { status: 'ARCHIVED', archivedAt: new Date(), archivedReason: reason },
  });
  res.json({ ok: true });
});

export default router;
