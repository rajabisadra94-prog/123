import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate, requireRole } from '../../shared/middleware/auth';
import { AppError } from '../../shared/middleware/errorHandler';
import { upload } from '../../shared/middleware/upload';
import { provisionWallets, OwnerType } from '../accounting/accounting.service';
import { dwEnsureSubsidiary, pwEnsureSubsidiary, writeLegacy } from '../ledger/dual-write';

const router = Router();
router.use(authenticate);

/**
 * هر طرف حساب به‌محض تعریف باید هر سه کیف (تومان/دلار/یوآن) را داشته باشد تا
 * بی‌درنگ قابل واریز و برداشت باشد — نه اینکه تا اولین سند حسابداری نامرئی بماند.
 * شکست اینجا نباید ثبت خود طرف حساب را برگرداند.
 */
async function ensureWallets(ownerType: OwnerType, ownerId: string, ownerName: string) {
  try {
    await prisma.$transaction(async (tx) => {
      if (writeLegacy()) await provisionWallets(tx, ownerType, ownerId, ownerName);
      await pwEnsureSubsidiary(tx, ownerType, ownerId, ownerName);   // حالت 'new'
    });
  } catch (e) {
    console.error(`[wallets] ساخت کیف/تفصیلی ${ownerType}/${ownerId} ناموفق بود`, e);
  }
  await dwEnsureSubsidiary(ownerType, ownerId, ownerName);   // سایهٔ 'dual'
}

// ─── CUSTOMERS ───────────────────────────────

router.get('/customers', async (_req, res) => {
  const list = await prisma.customer.findMany({ orderBy: { name: 'asc' } });
  res.json(list);
});

router.post('/customers', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { name, shortCode, address, phone, email, notes, projectCounter } = req.body;
  if (!name || !shortCode) throw new AppError(400, 'name and shortCode required');
  if (shortCode.length !== 3) throw new AppError(400, 'shortCode must be exactly 3 characters');

  const customer = await prisma.customer.create({
    data: {
      name, shortCode: shortCode.toUpperCase(), address, phone, email, notes,
      // شمارهٔ شروع پروژه: اگر مشتری از قبل n پروژه داشته، از n شروع می‌شود (پروژهٔ بعدی n+1)
      projectCounter: projectCounter != null && projectCounter !== '' ? Number(projectCounter) : undefined,
    },
  });
  await ensureWallets('CUSTOMER', customer.id, customer.name);
  res.status(201).json(customer);
});

router.patch('/customers/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { name, address, phone, email, notes, isActive, projectCounter } = req.body;
  const customer = await prisma.customer.update({
    where: { id: req.params.id },
    data: {
      name, address, phone, email, notes, isActive,
      projectCounter: projectCounter != null && projectCounter !== '' ? Number(projectCounter) : undefined,
    },
  });
  res.json(customer);
});

// ─── PRODUCER CATEGORIES ─────────────────────

router.get('/producer-categories', async (_req, res) => {
  const list = await prisma.producerCategory.findMany({
    include: { parent: { select: { id: true, name: true } } },
    orderBy: { name: 'asc' },
  });
  res.json(list);
});

router.post('/producer-categories', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  const { name, parentId } = req.body;
  if (!name) throw new AppError(400, 'name required');
  const cat = await prisma.producerCategory.create({ data: { name, parentId: parentId || null } });
  res.status(201).json(cat);
});

router.patch('/producer-categories/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  const { name, parentId } = req.body;
  const cat = await prisma.producerCategory.update({ where: { id: req.params.id }, data: { name, parentId: parentId === undefined ? undefined : (parentId || null) } });
  res.json(cat);
});

router.delete('/producer-categories/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  await prisma.producerCategory.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// ─── PRODUCERS ───────────────────────────────

router.get('/producers', async (_req, res) => {
  const list = await prisma.producer.findMany({
    include: { categories: { include: { category: true } } },
    orderBy: { name: 'asc' },
  });
  res.json(list);
});

router.post('/producers', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { name, contactName, address, phone, email, notes, categoryIds, isDomestic } = req.body;
  if (!name) throw new AppError(400, 'name required');
  const producer = await prisma.producer.create({
    data: {
      name, contactName, address, phone, email, notes, isDomestic: !!isDomestic,
      categories: categoryIds?.length
        ? { create: categoryIds.map((id: string) => ({ categoryId: id })) }
        : undefined,
    },
    include: { categories: { include: { category: true } } },
  });
  await ensureWallets('PRODUCER', producer.id, producer.name);
  res.status(201).json(producer);
});

router.patch('/producers/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { name, contactName, address, phone, email, notes, isActive, categoryIds, isDomestic } = req.body;
  if (categoryIds !== undefined) {
    await prisma.producerOnCategory.deleteMany({ where: { producerId: req.params.id } });
    if (categoryIds.length > 0) {
      await prisma.producerOnCategory.createMany({
        data: categoryIds.map((id: string) => ({ producerId: req.params.id, categoryId: id })),
      });
    }
  }
  const producer = await prisma.producer.update({
    where: { id: req.params.id },
    data: { name, contactName, address, phone, email, notes, isActive, isDomestic },
    include: { categories: { include: { category: true } } },
  });
  res.json(producer);
});

// ─── SUPPLIERS (تامین‌کنندگان کالای آماده — جدا از سازندگان) ───────────────────────

router.get('/suppliers', async (_req, res) => {
  const list = await prisma.supplier.findMany({ orderBy: { name: 'asc' } });
  res.json(list);
});

router.post('/suppliers', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { name, contactName, wechat, address, phone, email, notes } = req.body;
  if (!name) throw new AppError(400, 'name required');
  const supplier = await prisma.supplier.create({
    data: { name, contactName, wechat, address, phone, email, notes },
  });
  await ensureWallets('SUPPLIER', supplier.id, supplier.name);
  res.status(201).json(supplier);
});

router.patch('/suppliers/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { name, contactName, wechat, address, phone, email, notes, isActive } = req.body;
  const supplier = await prisma.supplier.update({
    where: { id: req.params.id },
    data: { name, contactName, wechat, address, phone, email, notes, isActive },
  });
  res.json(supplier);
});

// ─── SHIPPING COMPANIES ───────────────────────

router.get('/shipping-companies', async (_req, res) => {
  const list = await prisma.shippingCompany.findMany({ orderBy: { name: 'asc' } });
  res.json(list);
});

router.post('/shipping-companies', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  const { name, contactName, address, phone, notes, types } = req.body;
  if (!name) throw new AppError(400, 'name required');
  const item = await prisma.shippingCompany.create({ data: { name, contactName, address, phone, notes, types: types || [] } });
  await ensureWallets('CARRIER', item.id, item.name);
  res.status(201).json(item);
});

router.patch('/shipping-companies/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  const item = await prisma.shippingCompany.update({ where: { id: req.params.id }, data: req.body });
  res.json(item);
});

// ─── EXCHANGES ────────────────────────────────

router.get('/exchanges', async (_req, res) => {
  res.json(await prisma.exchange.findMany({ orderBy: { name: 'asc' } }));
});

router.post('/exchanges', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  const { name, contactName, notes } = req.body;
  if (!name) throw new AppError(400, 'name required');
  const item = await prisma.exchange.create({ data: { name, contactName, notes } });
  await ensureWallets('EXCHANGE', item.id, item.name);
  res.status(201).json(item);
});

router.patch('/exchanges/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  const { name, contactName, notes } = req.body;
  res.json(await prisma.exchange.update({ where: { id: req.params.id }, data: { name, contactName, notes } }));
});

// ─── COMMISSION AGENTS ────────────────────────

router.get('/commission-agents', async (_req, res) => {
  res.json(await prisma.commissionAgent.findMany({ orderBy: { name: 'asc' } }));
});

router.post('/commission-agents', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  const { name, phone, email, notes } = req.body;
  if (!name) throw new AppError(400, 'name required');
  const item = await prisma.commissionAgent.create({ data: { name, phone, email, notes } });
  await ensureWallets('COMMISSION_AGENT', item.id, item.name);
  res.status(201).json(item);
});

router.patch('/commission-agents/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  const { name, phone, email, notes } = req.body;
  res.json(await prisma.commissionAgent.update({ where: { id: req.params.id }, data: { name, phone, email, notes } }));
});

// ─── MATERIALS & COATINGS ─────────────────────

router.get('/materials', async (_req, res) => res.json(await prisma.material.findMany({ orderBy: { name: 'asc' } })));
router.post('/materials', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  res.status(201).json(await prisma.material.create({ data: { name: req.body.name } }));
});
router.delete('/materials/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  await prisma.material.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// ─── GENERIC JSON CONFIGS (permissions, currency, rules, archive reasons) ──
const CONFIG_KEYS = ['ROLE_PERMISSIONS', 'CURRENCY_CONFIG', 'SYSTEM_RULES', 'ARCHIVE_REASONS', 'INVOICE_SETTINGS', 'DOC_TYPES'];

router.get('/config/:key', async (req: Request, res: Response) => {
  if (!CONFIG_KEYS.includes(req.params.key)) throw new AppError(400, 'Unknown config key');
  const row = await prisma.systemSetting.findUnique({ where: { key: req.params.key } });
  res.json(row ? JSON.parse(row.value) : null);
});

router.put('/config/:key', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  if (!CONFIG_KEYS.includes(req.params.key)) throw new AppError(400, 'Unknown config key');
  const value = JSON.stringify(req.body ?? {});
  await prisma.systemSetting.upsert({ where: { key: req.params.key }, create: { key: req.params.key, value }, update: { value } });
  res.json({ ok: true });
});

// ─── CURRENCY / FALLBACK RATES ────────────────
const CURRENCY_KEYS = ['BASE_CURRENCY', 'FALLBACK_USD_TO_IRR', 'FALLBACK_CNY_TO_IRR', 'EXCHANGE_API_NAME', 'EXCHANGE_API_KEY', 'RATE_MODE'];
router.get('/currency', async (_req, res) => {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: CURRENCY_KEYS } } });
  const obj: Record<string, string> = {};
  rows.forEach((r) => { obj[r.key] = r.value; });
  res.json(obj);
});

router.put('/currency', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const keys = CURRENCY_KEYS;
  const entries = Object.entries(req.body).filter(([k]) => keys.includes(k));
  await prisma.$transaction(entries.map(([key, value]) =>
    prisma.systemSetting.upsert({ where: { key }, create: { key, value: String(value ?? '') }, update: { value: String(value ?? '') } }),
  ));
  res.json({ ok: true });
});

// ─── COMPANY INFO (invoice letterhead) ────────
const COMPANY_KEYS = ['COMPANY_NAME', 'COMPANY_ADDRESS', 'COMPANY_PHONE', 'COMPANY_EMAIL', 'COMPANY_LOGO_URL', 'COMPANY_EXTRA', 'COMPANY_STAMP_URL'];

// آپلود تصویر (لوگو / مهر شرکت) → مسیر ذخیره‌شده برمی‌گردد تا در COMPANY_LOGO_URL/COMPANY_STAMP_URL ذخیره شود
router.post('/upload-image', requireRole('SUPER_ADMIN', 'MANAGER'), upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) throw new AppError(400, 'file required');
  res.json({ url: `/uploads/${req.file.filename}` });
});

router.get('/company-info', async (_req, res) => {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: COMPANY_KEYS } } });
  const obj: Record<string, string> = {};
  rows.forEach((r) => { obj[r.key] = r.value; });
  res.json(obj);
});

router.put('/company-info', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const entries = Object.entries(req.body).filter(([k]) => COMPANY_KEYS.includes(k));
  await prisma.$transaction(
    entries.map(([key, value]) =>
      prisma.systemSetting.upsert({
        where: { key },
        create: { key, value: String(value ?? '') },
        update: { value: String(value ?? '') },
      }),
    ),
  );
  res.json({ ok: true });
});

router.get('/coatings', async (_req, res) => res.json(await prisma.coating.findMany({ orderBy: { name: 'asc' } })));
router.post('/coatings', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  res.status(201).json(await prisma.coating.create({ data: { name: req.body.name } }));
});
router.delete('/coatings/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  await prisma.coating.delete({ where: { id: req.params.id } });
  res.status(204).send();
});

// ─── SYSTEM SETTINGS ─────────────────────────

router.get('/system', requireRole('SUPER_ADMIN', 'MANAGER'), async (_req, res) => {
  const settings = await prisma.systemSetting.findMany();
  const obj: Record<string, string> = {};
  settings.forEach((s) => (obj[s.key] = s.value));
  res.json(obj);
});

router.put('/system', requireRole('SUPER_ADMIN', 'MANAGER'), async (req, res) => {
  const entries = Object.entries(req.body) as [string, string][];
  await prisma.$transaction(
    entries.map(([key, value]) =>
      prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } }),
    ),
  );
  res.json({ ok: true });
});

// ─── EXCHANGE RATES (live) ────────────────────

router.get('/exchange-rates', async (_req, res) => {
  const { getLiveRates } = await import('../../shared/utils/money');
  const rates = await getLiveRates();
  res.json(rates);
});

export default router;
