import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { AppError } from '../../shared/middleware/errorHandler';
import { upload } from '../../shared/middleware/upload';
import { generateFileName } from '../../shared/utils/fileNaming';
import path from 'path';
import fs from 'fs';

const router = Router();
router.use(authenticate);

// ثبت رویداد حمل در ردپای همهٔ پروژه‌های مرتبط (یک محموله می‌تواند چند پروژه داشته باشد)
async function logToProjects(projectIds: string[], userId: string, entity: string, entityId: string, changes: any) {
  const unique = [...new Set(projectIds.filter(Boolean))];
  if (!unique.length) return;
  await prisma.auditLog.createMany({
    data: unique.map((pid) => ({ userId, action: 'CREATE', entity, entityId, projectId: pid, changes })),
  });
}

// پروژه‌های مرتبط با یک محموله (محموله→بسته→سفارش→پروژه) — یک محموله می‌تواند چند پروژه داشته باشد
async function shipmentProjectIds(shipmentId: string): Promise<string[]> {
  const full = await prisma.mainShipment.findUnique({
    where: { id: shipmentId },
    include: { packages: { include: { package: { include: { items: { include: { order: { select: { projectId: true } } } } } } } } },
  });
  if (!full) return [];
  return full.packages.flatMap((sp) => sp.package.items.map((it) => it.order.projectId));
}

// Stage 1: Ready to ship (completed orders)
router.get('/ready', async (_req, res) => {
  const orders = await prisma.productionOrder.findMany({
    where: {
      status: 'COMPLETED',
      domesticItems: { none: {} },
    },
    include: {
      project: { include: { customer: { select: { id: true, name: true } } } },
      producer: { select: { id: true, name: true } },
      supplier: { select: { id: true, name: true } }, // سفارش خرید کالا تامین‌کننده دارد، نه سازنده
    },
  });
  res.json(orders);
});

// Stage 2: Domestic packages
router.get('/domestic', async (_req, res) => {
  const packages = await prisma.domesticPackage.findMany({
    include: {
      shippingCompany: true,
      items: { include: { order: { include: { project: { include: { customer: true } }, producer: true, supplier: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(packages);
});

router.post('/domestic', async (req: Request, res: Response) => {
  const { orderIds, shippingCompanyId, referenceNo, notes } = req.body;
  if (!orderIds?.length || !shippingCompanyId) throw new AppError(400, 'orderIds and shippingCompanyId required');

  // ۶.۱۴ — همهٔ سفارش‌های یک بسته باید هم‌نوع باشند (همه سازندهٔ داخلی یا همه خارجی)
  const ordersForCheck = await prisma.productionOrder.findMany({ where: { id: { in: orderIds } }, include: { producer: { select: { isDomestic: true } } } });
  const domesticFlags = new Set(ordersForCheck.map((o) => !!o.producer?.isDomestic));
  if (domesticFlags.size > 1) throw new AppError(400, 'نمی‌توان سفارشِ سازندهٔ داخلی و خارجی را در یک بستهٔ حمل داخلی ترکیب کرد — برای هر گروه بستهٔ جدا بسازید.');

  const count = await prisma.domesticPackage.count();
  const code = `PKG-${String(count + 1).padStart(5, '0')}`;

  const pkg = await prisma.domesticPackage.create({
    data: {
      code,
      shippingCompanyId,
      referenceNo,
      notes,
      items: {
        create: orderIds.map((oid: string) => ({ orderId: oid })),
      },
    },
    include: { items: true },
  });

  // Update part milestones
  const projectIds: string[] = [];
  for (const oid of orderIds) {
    const order = await prisma.productionOrder.findUnique({ where: { id: oid } });
    if (order) {
      projectIds.push(order.projectId);
      await prisma.part.updateMany({
        where: { projectId: order.projectId, selectedPrice: order.supplierId ? { supplierId: order.supplierId } : { producerId: order.producerId } },
        data: { milestone: 'IN_TRANSIT' },
      });
    }
  }

  // ثبت کد بسته و شماره رفرنس در ردپای پروژه‌های مرتبط
  const company = await prisma.shippingCompany.findUnique({ where: { id: shippingCompanyId }, select: { name: true } });
  await logToProjects(projectIds, req.user!.id, 'DomesticPackage', pkg.id, { event: 'DOMESTIC_PACKAGE', code: pkg.code, referenceNo: referenceNo || null, carrier: company?.name || null, notes: notes || null });

  res.status(201).json(pkg);
});

router.patch('/domestic/:id/item/:itemId', async (req: Request, res: Response) => {
  const { trackingNo, isDelivered } = req.body;
  const data: any = {};
  if (trackingNo !== undefined) data.trackingNo = trackingNo;
  if (isDelivered !== undefined) {
    data.isDelivered = isDelivered;
    if (isDelivered) data.deliveredAt = new Date();
  }

  await prisma.domesticPackageItem.update({ where: { id: req.params.itemId }, data });

  // ثبت شماره رهگیری در ردپای پروژهٔ مربوطه
  if (trackingNo) {
    const item = await prisma.domesticPackageItem.findUnique({ where: { id: req.params.itemId }, include: { order: { select: { projectId: true, code: true } } } });
    if (item?.order) await logToProjects([item.order.projectId], req.user!.id, 'DomesticPackage', req.params.id, { event: 'TRACKING_NO', trackingNo, order: item.order.code });
  }

  // Check if all items in package are delivered
  const pkg = await prisma.domesticPackage.findUnique({
    where: { id: req.params.id },
    include: { items: true },
  });
  if (pkg && pkg.items.every((i) => i.isDelivered)) {
    await prisma.domesticPackage.update({
      where: { id: req.params.id },
      data: { status: 'DELIVERED_TO_FORWARDER' },
    });
  }

  res.json({ ok: true });
});

// Stage 3: Main shipments
router.get('/shipments', async (_req, res) => {
  const shipments = await prisma.mainShipment.findMany({
    include: {
      shippingCompany: true,
      packages: { include: { package: { include: { items: { include: { order: { include: { project: { include: { customer: true } } } } } } } } } },
      freightInvoice: true,
      files: { orderBy: { createdAt: 'desc' } },
    },
    orderBy: { createdAt: 'desc' },
  });
  res.json(shipments);
});

router.post('/shipments', async (req: Request, res: Response) => {
  const { packageIds, cargoIds, shippingCompanyId, type, forwarderRef, notes } = req.body;
  // محموله می‌تواند از بسته‌های داخلی و/یا بارهای فورواردینگ تشکیل شود (کانتینر مشترک)
  if ((!packageIds?.length && !cargoIds?.length) || !shippingCompanyId || !type) throw new AppError(400, '(packageIds یا cargoIds) و shippingCompanyId و type لازم است');

  const count = await prisma.mainShipment.count();
  const code = `SHP-${String(count + 1).padStart(5, '0')}`;

  const shipment = await prisma.mainShipment.create({
    data: {
      code,
      shippingCompanyId,
      type,
      forwarderRef,
      notes,
      packages: {
        create: (packageIds || []).map((pid: string) => ({ packageId: pid })),
      },
    },
  });

  // اتصال بارهای فورواردینگ به این محموله
  if (cargoIds?.length) {
    await prisma.forwardingCargo.updateMany({ where: { id: { in: cargoIds } }, data: { shipmentId: shipment.id, stage: 'IN_TRANSIT' } });
  }

  // ثبت کد مرجع فورواردر در ردپای پروژه‌های مرتبط (از طریق بسته→سفارش→پروژه)
  const pkgs = await prisma.domesticPackage.findMany({
    where: { id: { in: packageIds } },
    include: { items: { include: { order: { select: { projectId: true } } } } },
  });
  const shipProjectIds = pkgs.flatMap((p) => p.items.map((it) => it.order.projectId));
  const shipCompany = await prisma.shippingCompany.findUnique({ where: { id: shippingCompanyId }, select: { name: true } });
  await logToProjects(shipProjectIds, req.user!.id, 'MainShipment', shipment.id, { event: 'MAIN_SHIPMENT', code: shipment.code, forwarderRef: forwarderRef || null, type, carrier: shipCompany?.name || null, notes: notes || null });

  res.status(201).json(shipment);
});

router.patch('/shipments/:id/status', async (req: Request, res: Response) => {
  const { status } = req.body;

  if (status === 'DELIVERED_TO_US') {
    const shipment = await prisma.mainShipment.findUnique({
      where: { id: req.params.id },
      include: { freightInvoice: true },
    });
    if (!shipment?.freightInvoice) {
      throw new AppError(400, 'Cannot mark as delivered: freight invoice not yet registered in accounting');
    }
  }

  const shipment = await prisma.mainShipment.update({
    where: { id: req.params.id },
    data: {
      status,
      arrivedAt: status === 'ARRIVED' ? new Date() : undefined,
      deliveredToUsAt: status === 'DELIVERED_TO_US' ? new Date() : undefined,
    },
  });

  // همگام‌سازی وضعیت بار امانی (فورواردینگ) با محموله — وگرنه روی IN_TRANSIT گیر می‌کند
  if (status === 'ARRIVED' || status === 'DELIVERED_TO_US') {
    await prisma.forwardingCargo.updateMany({
      where: { shipmentId: req.params.id },
      data: { stage: 'ARRIVED' },
    });
  }

  res.json(shipment);
});

// اسناد محموله (فاکتور حمل، بارنامه، ترخیص...) — فایل در سطح محموله ذخیره می‌شود چون یک فاکتور حمل می‌تواند چند پروژه را پوشش دهد
const SHIPMENT_FILE_TYPES = ['FREIGHT_INVOICE', 'BILL_OF_LADING', 'CUSTOMS', 'FORWARDER_RECEIPT', 'LOADING_PHOTO'];

router.post('/shipments/:id/files', upload.array('files', 10), async (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[];
  if (!files?.length) throw new AppError(400, 'فایل الزامی است');
  const type = SHIPMENT_FILE_TYPES.includes(req.body.fileType) ? req.body.fileType : 'FREIGHT_INVOICE';

  const shipment = await prisma.mainShipment.findUnique({
    where: { id: req.params.id },
    include: { shippingCompany: { select: { name: true } } },
  });
  if (!shipment) throw new AppError(404, 'محموله یافت نشد');

  // نام‌گذاری استاندارد سطح محموله: SHP-{کد}_INV_from-CARRIER-{کریر}_{تاریخ}
  const records = files.map((f) => {
    const newName = generateFileName(
      { level: 'shipment', fileType: type, shipmentCode: shipment.code, carrierCode: shipment.shippingCompany?.name, originalExt: path.extname(f.originalname) },
      f.originalname,
    );
    fs.renameSync(f.path, path.join(path.dirname(f.path), newName));
    return { shipmentId: shipment.id, fileType: type, storedName: newName, url: `/uploads/${newName}` };
  });
  await prisma.shipmentFile.createMany({ data: records });

  // ثبت در ردپای همهٔ پروژه‌های این محموله (دید چندپروژه‌ای)
  const projectIds = await shipmentProjectIds(shipment.id);
  await logToProjects(projectIds, req.user!.id, 'MainShipment', shipment.id, { event: 'SHIPMENT_FILE', fileType: type, code: shipment.code, count: files.length });

  res.status(201).json({ ok: true, count: records.length });
});

router.delete('/shipments/files/:fileId', async (req: Request, res: Response) => {
  const file = await prisma.shipmentFile.findUnique({ where: { id: req.params.fileId } });
  if (!file) throw new AppError(404, 'فایل یافت نشد');
  try {
    fs.unlinkSync(path.join(process.cwd(), process.env.UPLOAD_DIR || 'uploads', file.storedName));
  } catch { /* فایل فیزیکی موجود نبود — رکورد را حذف می‌کنیم */ }
  await prisma.shipmentFile.delete({ where: { id: req.params.fileId } });
  res.json({ ok: true });
});

// Stage 4: Customer delivery — فهرست تخت پروژه‌های آمادهٔ تحویل از دو منبع
const PROJECT_INC = { include: { customer: true, parts: { select: { id: true, milestone: true } } } };
router.get('/delivery', async (_req, res) => {
  const projMap: Record<string, any> = {};

  // منبع ۱: محموله‌های بین‌المللی که «تحویل به ما» شده‌اند
  const intl = await prisma.mainShipment.findMany({
    where: { status: 'DELIVERED_TO_US' },
    include: {
      packages: { include: { package: { include: { items: { include: { order: { include: { project: PROJECT_INC } } } } } } } },
      // بار امانی (فورواردینگ) مستقیم به محموله وصل است، نه از طریق بسته/سفارش
      forwardingCargos: { include: { project: PROJECT_INC } },
    },
  });
  for (const s of intl) {
    for (const sp of s.packages)
      for (const it of sp.package.items)
        projMap[(it.order.project as any).id] = it.order.project;
    // فورواردینگ: پروژهٔ بار امانیِ همین محموله هم آمادهٔ تحویل نهایی است
    for (const cargo of s.forwardingCargos)
      if (cargo.project) projMap[(cargo.project as any).id] = cargo.project;
  }

  // منبع ۲: ساخت داخل ایران — بستهٔ داخلیِ تحویل‌شده از سازندهٔ داخلی (بدون محمولهٔ بین‌المللی)
  const domPkgs = await prisma.domesticPackage.findMany({
    where: { status: 'DELIVERED_TO_FORWARDER' },
    include: { items: { include: { order: { include: { producer: { select: { isDomestic: true } }, project: PROJECT_INC } } } } },
  });
  for (const pkg of domPkgs)
    for (const it of pkg.items)
      if (it.order.producer?.isDomestic) projMap[(it.order.project as any).id] = it.order.project;

  res.json(Object.values(projMap));
});

router.post('/delivery/:projectId', async (req: Request, res: Response) => {
  const { packagingOk, notes, overrideReason } = req.body;

  await prisma.customerDelivery.upsert({
    where: { projectId: req.params.projectId },
    create: {
      projectId: req.params.projectId,
      packagingOk: packagingOk ?? true,
      notes,
      overrideReason,
      deliveredById: req.user!.id,
    },
    update: { packagingOk, notes, overrideReason, deliveredAt: new Date() },
  });

  await prisma.part.updateMany({
    where: { projectId: req.params.projectId, archivedAt: null },
    data: { milestone: 'DELIVERED' },
  });

  // پروژهٔ فورواردینگ: بار امانی هم تحویل‌شدهٔ نهایی علامت می‌خورد
  await prisma.forwardingCargo.updateMany({
    where: { projectId: req.params.projectId },
    data: { stage: 'DELIVERED' },
  });

  await prisma.project.update({
    where: { id: req.params.projectId },
    data: { status: 'COMPLETED' },
  });

  await prisma.auditLog.create({
    data: {
      userId: req.user!.id,
      action: 'UPDATE',
      entity: 'Project',
      entityId: req.params.projectId,
      projectId: req.params.projectId,
      // ۶.۲/۶.۳ — توضیحات بسته‌بندی و دلیل «ادامه با مسئولیت خودتان» در ردپای پروژه ثبت می‌شود تا بعداً قابل‌مشاهده باشد
      changes: { event: 'CUSTOMER_DELIVERY', status: 'COMPLETED', milestone: 'DELIVERED', packagingOk: packagingOk ?? true, notes: notes || null, overrideReason: overrideReason || null },
    },
  });

  res.json({ ok: true });
});

export default router;
