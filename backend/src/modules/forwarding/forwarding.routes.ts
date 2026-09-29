import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { upload } from '../../shared/middleware/upload';
import { AppError } from '../../shared/middleware/errorHandler';
import { projectAccessWhere } from '../../shared/utils/projectAccess';
import { generateFileName } from '../../shared/utils/fileNaming';
import { getOrCreateWallet, getOrCreateControl, postJournal, rateFor } from '../accounting/accounting.service';
import { dwForwardingIncome, pwForwardingIncome, writeLegacy } from '../ledger/dual-write';
import { Currency } from '@prisma/client';
import path from 'path';
import fs from 'fs';

const router = Router();
router.use(authenticate);

export const CARGO_STAGES = ['AWAITING_CHINA', 'RECEIVED_CHINA', 'IN_TRANSIT', 'ARRIVED', 'DELIVERED'] as const;

// محاسبهٔ کرایه بر اساس روش (نرخ×وزن / نرخ×حجم / مقطوع)
function computeQuote(c: { freightMode?: string | null; freightRate?: any; flatAmount?: any; weightKg?: any; volumeCbm?: any }): number | null {
  if (c.freightMode === 'FLAT') return c.flatAmount != null ? Number(c.flatAmount) : null;
  if (c.freightMode === 'BY_WEIGHT') return c.freightRate != null && c.weightKg != null ? Number(c.freightRate) * Number(c.weightKg) : null;
  if (c.freightMode === 'BY_VOLUME') return c.freightRate != null && c.volumeCbm != null ? Number(c.freightRate) * Number(c.volumeCbm) : null;
  return null;
}

const CARGO_INCLUDE = {
  project: { include: { customer: { select: { id: true, name: true } } } },
  shipment: { select: { id: true, code: true, status: true } },
  files: true,
};

// لیست بارهای فورواردینگ
router.get('/', async (req: Request, res: Response) => {
  const where: any = {};
  Object.assign(where, await projectAccessWhere(req.user!.id, req.user!.role, 'projectId'));
  const cargos = await prisma.forwardingCargo.findMany({ where, include: CARGO_INCLUDE, orderBy: { createdAt: 'desc' } });
  res.json(cargos);
});

// پروژه‌های FORWARDING که هنوز بار ثبت نکرده‌اند (برای ساخت بار)
router.get('/pending-projects', async (req: Request, res: Response) => {
  const where: any = { type: 'FORWARDING', status: { notIn: ['ARCHIVED'] }, forwardingCargo: { is: null } };
  Object.assign(where, await projectAccessWhere(req.user!.id, req.user!.role, 'id'));
  const projects = await prisma.project.findMany({ where, include: { customer: { select: { id: true, name: true } } }, orderBy: { createdAt: 'desc' } });
  res.json(projects);
});

router.get('/:id', async (req: Request, res: Response) => {
  const cargo = await prisma.forwardingCargo.findUnique({ where: { id: req.params.id }, include: CARGO_INCLUDE });
  if (!cargo) throw new AppError(404, 'بار یافت نشد');
  res.json(cargo);
});

// ساخت بار برای یک پروژهٔ FORWARDING (1:1)
router.post('/', async (req: Request, res: Response) => {
  const { projectId, ...body } = req.body;
  if (!projectId) throw new AppError(400, 'projectId لازم است');
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { forwardingCargo: true } });
  if (!project) throw new AppError(404, 'پروژه یافت نشد');
  if (project.type !== 'FORWARDING') throw new AppError(400, 'ثبت بار فقط برای پروژهٔ فورواردینگ است');
  if (project.forwardingCargo) throw new AppError(400, 'این پروژه از قبل بار دارد');

  const data: any = pickCargoFields(body);
  data.quotedAmount = computeQuote({ ...data });
  const cargo = await prisma.forwardingCargo.create({ data: { projectId, ...data }, include: CARGO_INCLUDE });
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: 'CREATE', entity: 'ForwardingCargo', entityId: cargo.id, projectId } });
  res.status(201).json(cargo);
});

router.patch('/:id', async (req: Request, res: Response) => {
  const existing = await prisma.forwardingCargo.findUnique({ where: { id: req.params.id } });
  if (!existing) throw new AppError(404, 'بار یافت نشد');
  const data: any = pickCargoFields(req.body);
  // بازمحاسبهٔ کرایه با مقادیر جدید (ادغام با موجود)
  const merged = { ...existing, ...data };
  data.quotedAmount = computeQuote(merged);
  const cargo = await prisma.forwardingCargo.update({ where: { id: req.params.id }, data, include: CARGO_INCLUDE });
  res.json(cargo);
});

// تأیید کرایه → ثبت درآمد فورواردینگ (بدهکار کیف مشتری / بستانکار کنترل درآمد فورواردینگ)
router.post('/:id/confirm-quote', async (req: Request, res: Response) => {
  const cargo = await prisma.forwardingCargo.findUnique({ where: { id: req.params.id }, include: { project: { include: { customer: { select: { id: true, name: true } } } } } });
  if (!cargo) throw new AppError(404, 'بار یافت نشد');
  if (cargo.quoteConfirmedAt) throw new AppError(400, 'کرایه از قبل تأیید و ثبت شده است');
  const amount = computeQuote(cargo);
  if (!amount || amount <= 0) throw new AppError(400, 'کرایه معتبر نیست — روش و مبلغ/نرخ را کامل کنید');

  const cur = cargo.quoteCurrency as Currency;
  await prisma.$transaction(async (tx) => {
    if (writeLegacy()) {
      const r = await rateFor(cur);
      const custWallet = await getOrCreateWallet(tx, 'CUSTOMER', cargo.project.customerId, cur, cargo.project.customer.name);
      const incomeCtrl = await getOrCreateControl(tx, 'FREIGHT_INCOME', cur);
      await postJournal(tx, {
        description: `درآمد فورواردینگ — پروژهٔ ${cargo.project.code}`,
        eventType: 'FORWARDING_INCOME', sourceType: 'ForwardingCargo', sourceId: cargo.id, projectId: cargo.projectId, createdById: req.user!.id,
        lines: [
          { accountId: custWallet.id, debit: amount, currency: cur, rateToIRR: r },
          { accountId: incomeCtrl.id, credit: amount, currency: cur, rateToIRR: r },
        ],
      });
    }
    // set‌کردن مبلغ پیش از آداپتور: `postForwardingIncome` از `quotedAmount` می‌خواند
    await tx.forwardingCargo.update({ where: { id: cargo.id }, data: { quotedAmount: amount, quoteConfirmedAt: new Date() } });
    await pwForwardingIncome(tx, cargo.id, req.user!.id);   // حالت 'new': داخل همین تراکنش
  }, { timeout: 20000 });

  // سایهٔ 'dual' (در حالت 'new' بی‌اثر)
  await dwForwardingIncome(cargo.id, req.user!.id);

  await prisma.auditLog.create({ data: { userId: req.user!.id, action: 'UPDATE', entity: 'ForwardingCargo', entityId: cargo.id, projectId: cargo.projectId, changes: { event: 'FORWARDING_INCOME', amount, currency: cur } } });
  res.json({ ok: true });
});

router.patch('/:id/stage', async (req: Request, res: Response) => {
  const { stage, notes } = req.body;
  if (!CARGO_STAGES.includes(stage)) throw new AppError(400, 'مرحلهٔ نامعتبر');
  const cargo = await prisma.forwardingCargo.findUnique({ where: { id: req.params.id } });
  if (!cargo) throw new AppError(404, 'بار یافت نشد');
  await prisma.forwardingCargo.update({ where: { id: cargo.id }, data: { stage } });

  // تحویل نهایی بار به مشتری → پروژهٔ فورواردینگ تکمیل می‌شود (هم‌راستا با «تحویل مشتری» در ماژول حمل)
  if (stage === 'DELIVERED') {
    await prisma.customerDelivery.upsert({
      where: { projectId: cargo.projectId },
      create: { projectId: cargo.projectId, packagingOk: true, notes: notes || null, deliveredById: req.user!.id },
      update: { notes: notes || undefined, deliveredAt: new Date() },
    });
    await prisma.project.update({ where: { id: cargo.projectId }, data: { status: 'COMPLETED' } });
    await prisma.auditLog.create({ data: { userId: req.user!.id, action: 'UPDATE', entity: 'Project', entityId: cargo.projectId, projectId: cargo.projectId, changes: { event: 'CUSTOMER_DELIVERY', status: 'COMPLETED', stage: 'DELIVERED', kind: 'FORWARDING', notes: notes || null } } });
  } else {
    await prisma.auditLog.create({ data: { userId: req.user!.id, action: 'UPDATE', entity: 'ForwardingCargo', entityId: cargo.id, projectId: cargo.projectId, changes: { stage } } });
  }
  res.json({ ok: true });
});

// اتصال بار به یک محمولهٔ اصلی موجود (کانتینر مشترک) → وارد زنجیرهٔ حمل
router.post('/:id/attach-shipment', async (req: Request, res: Response) => {
  const { shipmentId } = req.body;
  if (!shipmentId) throw new AppError(400, 'shipmentId لازم است');
  const cargo = await prisma.forwardingCargo.findUnique({ where: { id: req.params.id } });
  if (!cargo) throw new AppError(404, 'بار یافت نشد');
  const shipment = await prisma.mainShipment.findUnique({ where: { id: shipmentId }, select: { id: true, code: true } });
  if (!shipment) throw new AppError(404, 'محموله یافت نشد');
  await prisma.forwardingCargo.update({ where: { id: cargo.id }, data: { shipmentId, stage: 'IN_TRANSIT' } });
  await prisma.auditLog.create({ data: { userId: req.user!.id, action: 'UPDATE', entity: 'ForwardingCargo', entityId: cargo.id, projectId: cargo.projectId, changes: { event: 'CARGO_ATTACHED', shipmentCode: shipment.code } } });
  res.json({ ok: true });
});

router.post('/:id/files', upload.array('files', 10), async (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[];
  if (!files?.length) throw new AppError(400, 'فایل لازم است');
  const cargo = await prisma.forwardingCargo.findUnique({ where: { id: req.params.id }, include: { project: { select: { code: true } } } });
  if (!cargo) throw new AppError(404, 'بار یافت نشد');
  const type = req.body.fileType || 'CARGO_DOC';
  const existing = await prisma.forwardingCargoFile.count({ where: { cargoId: cargo.id, fileType: type } });
  const records = files.map((f, i) => {
    const newName = generateFileName({ level: 'project', fileType: type, projectCode: cargo.project.code, version: `R${String(existing + i + 1).padStart(2, '0')}`, originalExt: path.extname(f.originalname) }, f.originalname);
    fs.renameSync(f.path, path.join(path.dirname(f.path), newName));
    return { cargoId: cargo.id, fileType: type, storedName: newName, url: `/uploads/${newName}`, sizeBytes: f.size, uploadedById: req.user!.id };
  });
  await prisma.forwardingCargoFile.createMany({ data: records });
  res.status(201).json({ ok: true, count: files.length });
});

function pickCargoFields(b: any) {
  const out: any = {};
  const numFields = ['weightKg', 'volumeCbm', 'freightRate', 'flatAmount', 'declaredValue'];
  const strFields = ['senderName', 'senderContact', 'goodsDescription', 'route', 'transit', 'freightMode', 'notes'];
  for (const f of numFields) if (b[f] !== undefined) out[f] = b[f] === '' || b[f] === null ? null : Number(b[f]);
  for (const f of strFields) if (b[f] !== undefined) out[f] = b[f] || null;
  if (b.packagesCount !== undefined) out.packagesCount = b.packagesCount === '' ? null : Number(b.packagesCount);
  if (b.declaredCurrency !== undefined) out.declaredCurrency = b.declaredCurrency || null;
  if (b.quoteCurrency !== undefined && b.quoteCurrency) out.quoteCurrency = b.quoteCurrency;
  return out;
}

export default router;
