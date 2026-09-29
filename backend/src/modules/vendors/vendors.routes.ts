import { Router, Request, Response } from 'express';
import path from 'path';
import prisma from '../../shared/utils/prisma';
import { authenticate } from '../../shared/middleware/auth';
import { requireRole } from '../../shared/middleware/auth';
import { upload } from '../../shared/middleware/upload';
import { AppError } from '../../shared/middleware/errorHandler';
import { provisionWallets } from '../accounting/accounting.service';
import { dwEnsureSubsidiary, pwEnsureSubsidiary, writeLegacy } from '../ledger/dual-write';

const router = Router();
router.use(authenticate);

export const VENDOR_STATUSES = ['ACTIVE', 'TRIAL', 'BLACKLIST'];
type Kind = 'producer' | 'supplier';

function kindOf(req: Request): Kind {
  const k = (req.params.kind || req.query.kind) as string;
  if (k !== 'producer' && k !== 'supplier') throw new AppError(400, 'نوع باید producer یا supplier باشد');
  return k;
}

// فیلدهای متنی/عددی مشترک که مستقیم از بدنه پذیرفته می‌شوند
const STR_FIELDS = ['name', 'nameEn', 'contactName', 'address', 'phone', 'email', 'notes', 'country', 'city',
  'website', 'whatsapp', 'alibabaUrl', 'wechat', 'moq', 'paymentTerms', 'currency', 'incoterms', 'bankInfo',
  'riskNote', 'logoUrl', 'status'] as const;
const ARR_FIELDS = ['specialties', 'certifications', 'materials', 'brands'] as const;
const NUM_FIELDS = ['leadTimeDays', 'ratingQuality', 'ratingPrice', 'ratingDelivery', 'ratingComms'] as const;

/** بدنهٔ درخواست را به data معتبر پریزما تبدیل می‌کند (فیلدهای نامربوط به هر نوع نادیده گرفته می‌شوند) */
function buildData(body: any, kind: Kind) {
  const data: any = {};
  const producerOnly = ['materials', 'capacity', 'isDomestic'];
  const supplierOnly = ['brands'];
  for (const f of STR_FIELDS) {
    if (body[f] !== undefined) data[f] = body[f] || null;
  }
  if (kind === 'producer' && body.capacity !== undefined) data.capacity = body.capacity || null;
  if (body.isActive !== undefined) data.isActive = !!body.isActive;
  if (kind === 'producer' && body.isDomestic !== undefined) data.isDomestic = !!body.isDomestic;
  for (const f of ARR_FIELDS) {
    if (body[f] === undefined) continue;
    if (kind === 'producer' && supplierOnly.includes(f)) continue;
    if (kind === 'supplier' && producerOnly.includes(f)) continue;
    data[f] = Array.isArray(body[f]) ? body[f].filter(Boolean) : String(body[f]).split(',').map((s: string) => s.trim()).filter(Boolean);
  }
  for (const f of NUM_FIELDS) {
    if (body[f] === undefined) continue;
    data[f] = body[f] === '' || body[f] === null ? null : Number(body[f]);
  }
  if (data.status && !VENDOR_STATUSES.includes(data.status)) throw new AppError(400, 'وضعیت نامعتبر');
  return data;
}

const VENDOR_INCLUDE = {
  categories: { include: { category: true } },
  contacts: { orderBy: { isPrimary: 'desc' as const } },
  documents: { orderBy: { createdAt: 'desc' as const } },
};

/** میانگین امتیاز از چهار بعد (نال‌ها نادیده) */
function avgRating(v: any): number | null {
  const vals = [v.ratingQuality, v.ratingPrice, v.ratingDelivery, v.ratingComms].filter((x) => x != null) as number[];
  if (!vals.length) return null;
  return Math.round((vals.reduce((s, x) => s + x, 0) / vals.length) * 10) / 10;
}

// ─── دسته‌بندی درختی (چندسطحی، مشترک بین سازنده و تامین‌کننده) ───
/** درخت کامل با شمارش استفاده (خودِ دسته + همهٔ زیرشاخه‌ها) */
router.get('/categories/tree', async (_req: Request, res: Response) => {
  const cats = await prisma.producerCategory.findMany({
    include: { _count: { select: { producers: true, suppliers: true, children: true } } },
    orderBy: { name: 'asc' },
  });
  const byId = new Map(cats.map((c) => [c.id, { ...c, children: [] as any[] }]));
  const roots: any[] = [];
  for (const c of byId.values()) {
    if (c.parentId && byId.has(c.parentId)) byId.get(c.parentId)!.children.push(c);
    else roots.push(c);
  }
  // شمارش تجمعی: خودِ دسته + همهٔ نوادگان
  const rollup = (n: any): { p: number; s: number } => {
    let p = n._count.producers, s = n._count.suppliers;
    for (const ch of n.children) { const r = rollup(ch); p += r.p; s += r.s; }
    n.totalProducers = p; n.totalSuppliers = s;
    return { p, s };
  };
  roots.forEach(rollup);
  res.json(roots);
});

/** آیا candidateParent یکی از نوادگان id است؟ (جلوگیری از حلقه هنگام جابه‌جایی) */
async function isDescendant(id: string, candidateParent: string): Promise<boolean> {
  let cur: string | null = candidateParent;
  const seen = new Set<string>();
  while (cur) {
    if (cur === id) return true;
    if (seen.has(cur)) return false;
    seen.add(cur);
    const row: { parentId: string | null } | null = await prisma.producerCategory.findUnique({ where: { id: cur }, select: { parentId: true } });
    cur = row?.parentId ?? null;
  }
  return false;
}

router.post('/categories', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { name, parentId } = req.body;
  if (!name?.trim()) throw new AppError(400, 'نام دسته لازم است');
  const created = await prisma.producerCategory.create({ data: { name: name.trim(), parentId: parentId || null } });
  res.status(201).json(created);
});

router.patch('/categories/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const id = req.params.id;
  const { name, parentId } = req.body;
  const data: any = {};
  if (name !== undefined) {
    if (!name.trim()) throw new AppError(400, 'نام نمی‌تواند خالی باشد');
    data.name = name.trim();
  }
  if (parentId !== undefined) {
    const p = parentId || null;
    if (p === id) throw new AppError(400, 'یک دسته نمی‌تواند والد خودش باشد');
    if (p && await isDescendant(id, p)) throw new AppError(400, 'نمی‌توان دسته را زیر یکی از زیرشاخه‌های خودش برد');
    data.parentId = p;
  }
  res.json(await prisma.producerCategory.update({ where: { id }, data }));
});

router.delete('/categories/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const id = req.params.id;
  const [childCount, prodCount, supCount] = await Promise.all([
    prisma.producerCategory.count({ where: { parentId: id } }),
    prisma.producerOnCategory.count({ where: { categoryId: id } }),
    prisma.supplierOnCategory.count({ where: { categoryId: id } }),
  ]);
  if (childCount) throw new AppError(400, `این دسته ${childCount} زیرشاخه دارد — اول آن‌ها را جابه‌جا یا حذف کنید`);
  if (prodCount + supCount) throw new AppError(400, `${prodCount + supCount} طرف تأمین به این دسته وصل‌اند — اول آن‌ها را جدا کنید`);
  await prisma.producerCategory.delete({ where: { id } });
  res.json({ ok: true });
});

// ─── فهرست با جستجو و فیلتر ──────────────────────────
router.get('/:kind', async (req: Request, res: Response) => {
  const kind = kindOf(req);
  const {
    search, status, categoryId, specialty, country, minRating,
    city, currency, incoterms, material, certification,
    maxLeadTime, isDomestic, hasContacts, hasDocs, sort,
  } = req.query as Record<string, string>;

  const where: any = {};
  if (status) where.status = status;
  if (country) where.country = country;
  if (city) where.city = { contains: city, mode: 'insensitive' };
  if (currency) where.currency = currency;
  if (incoterms) where.incoterms = { contains: incoterms, mode: 'insensitive' };
  if (specialty) where.specialties = { has: specialty };
  if (certification) where.certifications = { has: certification };
  if (maxLeadTime) where.leadTimeDays = { lte: Number(maxLeadTime), not: null };
  if (hasContacts === '1') where.contacts = { some: {} };
  if (hasContacts === '0') where.contacts = { none: {} };
  if (hasDocs === '1') where.documents = { some: {} };
  if (hasDocs === '0') where.documents = { none: {} };
  // فقط سازنده این فیلدها را دارد
  if (kind === 'producer') {
    if (isDomestic === '1') where.isDomestic = true;
    if (isDomestic === '0') where.isDomestic = false;
    if (material) where.materials = { has: material };
  }

  // فیلتر دسته: شامل همهٔ زیرشاخه‌های آن دسته هم می‌شود (یک شاخه = کل درختش)
  if (categoryId) {
    const all = await prisma.producerCategory.findMany({ select: { id: true, parentId: true } });
    const ids = new Set([categoryId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of all) if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); grew = true; }
    }
    where.categories = { some: { categoryId: { in: [...ids] } } };
  }

  if (search) where.OR = [
    { name: { contains: search, mode: 'insensitive' } },
    { nameEn: { contains: search, mode: 'insensitive' } },
    { city: { contains: search, mode: 'insensitive' } },
    { phone: { contains: search } },
    { specialties: { has: search } },
    { contacts: { some: { OR: [{ name: { contains: search, mode: 'insensitive' } }, { phone: { contains: search } }] } } },
  ];

  const orderBy: any = sort === 'newest' ? { createdAt: 'desc' } : sort === 'oldest' ? { createdAt: 'asc' } : { name: 'asc' };
  const rows = kind === 'producer'
    ? await prisma.producer.findMany({ where, include: VENDOR_INCLUDE, orderBy })
    : await prisma.supplier.findMany({ where, include: VENDOR_INCLUDE, orderBy });

  let list = rows.map((v: any) => ({ ...v, avgRating: avgRating(v) }));
  if (minRating) list = list.filter((v: any) => (v.avgRating ?? 0) >= Number(minRating));
  if (sort === 'rating') list.sort((a: any, b: any) => (b.avgRating ?? -1) - (a.avgRating ?? -1));
  res.json(list);
});

// ─── خلاصهٔ آماری برای نوار بالای صفحه ───────────────
router.get('/:kind/summary', async (req: Request, res: Response) => {
  const kind = kindOf(req);
  const rows: any[] = kind === 'producer'
    ? await prisma.producer.findMany({ select: { status: true, country: true, isActive: true, ratingQuality: true, ratingPrice: true, ratingDelivery: true, ratingComms: true } })
    : await prisma.supplier.findMany({ select: { status: true, country: true, isActive: true, ratingQuality: true, ratingPrice: true, ratingDelivery: true, ratingComms: true } });
  const rated = rows.map(avgRating).filter((x): x is number => x != null);
  res.json({
    total: rows.length,
    active: rows.filter((r) => r.status === 'ACTIVE').length,
    trial: rows.filter((r) => r.status === 'TRIAL').length,
    blacklist: rows.filter((r) => r.status === 'BLACKLIST').length,
    avgRating: rated.length ? Math.round((rated.reduce((s, x) => s + x, 0) / rated.length) * 10) / 10 : null,
    countries: [...new Set(rows.map((r) => r.country).filter(Boolean))],
  });
});

/** گزینه‌های واقعیِ موجود برای دراپ‌داون فیلترها (فقط چیزی که در داده هست) */
router.get('/:kind/facets', async (req: Request, res: Response) => {
  const kind = kindOf(req);
  const sel = { country: true, city: true, currency: true, incoterms: true, specialties: true, certifications: true } as const;
  const rows: any[] = kind === 'producer'
    ? await prisma.producer.findMany({ select: { ...sel, materials: true } })
    : await prisma.supplier.findMany({ select: sel });
  const uniq = (arr: any[]) => [...new Set(arr.filter(Boolean))].sort();
  res.json({
    countries: uniq(rows.map((r) => r.country)),
    cities: uniq(rows.map((r) => r.city)),
    currencies: uniq(rows.map((r) => r.currency)),
    incoterms: uniq(rows.map((r) => r.incoterms)),
    specialties: uniq(rows.flatMap((r) => r.specialties || [])),
    certifications: uniq(rows.flatMap((r) => r.certifications || [])),
    materials: uniq(rows.flatMap((r) => r.materials || [])),
  });
});

// ─── پروفایل کامل + کارنامهٔ خودکار از دادهٔ واقعی سیستم ───
router.get('/:kind/:id', async (req: Request, res: Response) => {
  const kind = kindOf(req);
  const id = req.params.id;
  const vendor: any = kind === 'producer'
    ? await prisma.producer.findUnique({ where: { id }, include: VENDOR_INCLUDE })
    : await prisma.supplier.findUnique({ where: { id }, include: VENDOR_INCLUDE });
  if (!vendor) throw new AppError(404, 'یافت نشد');

  const orderWhere = kind === 'producer' ? { producerId: id } : { supplierId: id };
  const [orders, wallets, quotes] = await Promise.all([
    prisma.productionOrder.findMany({
      where: orderWhere,
      include: { project: { select: { id: true, code: true, customer: { select: { name: true } } } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.financialAccount.findMany({
      where: { ownerType: kind === 'producer' ? 'PRODUCER' : 'SUPPLIER', ownerId: id },
      select: { currency: true, balance: true },
    }),
    prisma.pricingProducer.count({ where: kind === 'producer' ? { producerId: id } : { supplierId: id } }),
  ]);

  const completed = orders.filter((o) => o.status === 'COMPLETED');
  const onTime = completed.filter((o) => !o.estimatedEndDate || !o.actualEndDate || o.actualEndDate <= o.estimatedEndDate);
  res.json({
    ...vendor,
    avgRating: avgRating(vendor),
    scorecard: {
      orderCount: orders.length,
      completedCount: completed.length,
      activeCount: orders.filter((o) => o.status !== 'COMPLETED').length,
      quoteCount: quotes,
      onTimeRate: completed.length ? Math.round((onTime.length / completed.length) * 100) : null,
      lastOrderAt: orders[0]?.createdAt ?? null,
      balances: wallets.map((w) => ({ currency: w.currency, balance: Number(w.balance) })),
    },
    orders: orders.slice(0, 20).map((o) => ({
      id: o.id, code: o.code, status: o.status, kind: o.kind, createdAt: o.createdAt,
      project: o.project?.code, customer: o.project?.customer?.name,
    })),
  });
});

// ─── ساخت / ویرایش / حذف ──────────────────────────────
router.post('/:kind', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const kind = kindOf(req);
  const data = buildData(req.body, kind);
  if (!data.name) throw new AppError(400, 'نام لازم است');
  const categoryIds: string[] = req.body.categoryIds || [];
  const created = kind === 'producer'
    ? await prisma.producer.create({
        data: { ...data, ...(categoryIds.length ? { categories: { create: categoryIds.map((categoryId) => ({ categoryId })) } } : {}) },
        include: VENDOR_INCLUDE,
      })
    : await prisma.supplier.create({
        data: { ...data, ...(categoryIds.length ? { categories: { create: categoryIds.map((categoryId) => ({ categoryId })) } } : {}) },
        include: VENDOR_INCLUDE,
      });
  // سه کیف پول (تومان/دلار/یوآن) بی‌درنگ فعال شود تا طرف تأمین بلافاصله قابل واریز/برداشت باشد
  const ownerType = kind === 'producer' ? 'PRODUCER' : 'SUPPLIER';
  try {
    await prisma.$transaction(async (tx) => {
      if (writeLegacy()) await provisionWallets(tx, ownerType, created.id, created.name);
      await pwEnsureSubsidiary(tx, ownerType, created.id, created.name);   // حالت 'new'
    });
  } catch (e) {
    console.error(`[wallets] ساخت کیف/تفصیلی ${kind}/${created.id} ناموفق بود`, e);
  }
  await dwEnsureSubsidiary(ownerType, created.id, created.name);   // سایهٔ 'dual'
  res.status(201).json(created);
});

router.patch('/:kind/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const kind = kindOf(req);
  const id = req.params.id;
  const data = buildData(req.body, kind);
  const categoryIds: string[] | undefined = req.body.categoryIds;

  if (categoryIds) {
    if (kind === 'producer') {
      await prisma.producerOnCategory.deleteMany({ where: { producerId: id } });
      if (categoryIds.length) await prisma.producerOnCategory.createMany({ data: categoryIds.map((categoryId) => ({ producerId: id, categoryId })) });
    } else {
      await prisma.supplierOnCategory.deleteMany({ where: { supplierId: id } });
      if (categoryIds.length) await prisma.supplierOnCategory.createMany({ data: categoryIds.map((categoryId) => ({ supplierId: id, categoryId })) });
    }
  }
  const updated = kind === 'producer'
    ? await prisma.producer.update({ where: { id }, data, include: VENDOR_INCLUDE })
    : await prisma.supplier.update({ where: { id }, data, include: VENDOR_INCLUDE });
  res.json(updated);
});

// ─── مخاطبان ─────────────────────────────────────────
router.post('/:kind/:id/contacts', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const kind = kindOf(req);
  const { name, role, phone, email, wechat, whatsapp, language, isPrimary, notes } = req.body;
  if (!name?.trim()) throw new AppError(400, 'نام مخاطب لازم است');
  const link = kind === 'producer' ? { producerId: req.params.id } : { supplierId: req.params.id };
  if (isPrimary) await prisma.vendorContact.updateMany({ where: link, data: { isPrimary: false } });
  const c = await prisma.vendorContact.create({
    data: { name: name.trim(), role, phone, email, wechat, whatsapp, language, isPrimary: !!isPrimary, notes, ...link },
  });
  res.status(201).json(c);
});

router.patch('/contacts/:contactId', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const b = req.body;
  const data: any = {};
  for (const k of ['name', 'role', 'phone', 'email', 'wechat', 'whatsapp', 'language', 'notes']) {
    if (b[k] !== undefined) data[k] = b[k] || null;
  }
  if (b.isPrimary !== undefined) {
    data.isPrimary = !!b.isPrimary;
    if (b.isPrimary) {
      const cur = await prisma.vendorContact.findUnique({ where: { id: req.params.contactId } });
      if (cur) {
        const link = cur.producerId ? { producerId: cur.producerId } : { supplierId: cur.supplierId };
        await prisma.vendorContact.updateMany({ where: link as any, data: { isPrimary: false } });
      }
    }
  }
  res.json(await prisma.vendorContact.update({ where: { id: req.params.contactId }, data }));
});

router.delete('/contacts/:contactId', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  await prisma.vendorContact.delete({ where: { id: req.params.contactId } });
  res.json({ ok: true });
});

// ─── اسناد ───────────────────────────────────────────
router.post('/:kind/:id/documents', requireRole('SUPER_ADMIN', 'MANAGER'), upload.single('file'), async (req: Request, res: Response) => {
  const kind = kindOf(req);
  if (!req.file) throw new AppError(400, 'فایل لازم است');
  const link = kind === 'producer' ? { producerId: req.params.id } : { supplierId: req.params.id };
  const doc = await prisma.vendorDocument.create({
    data: {
      title: req.body.title?.trim() || req.file.originalname,
      docType: req.body.docType || 'OTHER',
      url: `/uploads/${req.file.filename}`,
      storedName: req.file.filename,
      uploadedById: req.user!.id,
      ...link,
    },
  });
  res.status(201).json(doc);
});

router.delete('/documents/:docId', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  await prisma.vendorDocument.delete({ where: { id: req.params.docId } });
  res.json({ ok: true });
});

export default router;
