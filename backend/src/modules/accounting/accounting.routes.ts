import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate, requireRole } from '../../shared/middleware/auth';
import { upload } from '../../shared/middleware/upload';
import { AppError } from '../../shared/middleware/errorHandler';
import { Currency } from '@prisma/client';
import { getRates } from '../../shared/utils/rates';
import {
  postJournal, getOrCreateWallet, getOrCreateControl, getOrCreateDefaultCash,
  rateFor, normalSide, OwnerType, postInvoiceObligations, rebuildLedger, postSettlement,
  assertPeriodOpen, canEditEntry, reverseJournal, editJournal, toJalaliYM, JournalLineInput,
  postConversion, provisionWallets, walletAvgBookedRate,
} from './accounting.service';
import { ensureChartOfAccounts, CASH_PARENT_CODE } from './chartOfAccounts';
import { previewRevaluation, postRevaluation } from './revaluation';
import { trialBalance, balanceSheet, incomeStatement, integrityCheck, aging } from './reports';
import { storeReceipt } from '../../shared/utils/receipts';
import { toCsv, sendCsv } from '../../shared/utils/csv';
import {
  dwFreightInvoice, dwSettlement, pwFreightInvoice, pwSettlement, writeLegacy,
} from '../ledger/dual-write';

const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN', 'MANAGER', 'ACCOUNTANT'));

const CUR_LABEL: Record<string, string> = { IRR: 'تومان', USD: 'دلار', CNY: 'یوآن' };

const PAYABLE_TYPES: OwnerType[] = ['PRODUCER', 'SUPPLIER', 'CARRIER', 'EXCHANGE', 'COMMISSION_AGENT'];

// ════════════════════════════════════════════════
// نرخ‌های زنده ارز
// ════════════════════════════════════════════════
router.get('/rates', async (_req, res) => {
  res.json(await getRates());
});

router.post('/rates/refresh', async (_req, res) => {
  res.json(await getRates(true));
});

// ════════════════════════════════════════════════
// نمای کلی (داشبورد حسابداری)
// ════════════════════════════════════════════════
router.get('/overview', async (_req: Request, res: Response) => {
  const rates = await getRates();
  const irrOf = (c: string) => (c === 'IRR' ? 1 : c === 'USD' ? rates.USD_TO_IRR : rates.CNY_TO_IRR);

  const accounts = await prisma.financialAccount.findMany({ where: { isActive: true } });

  const cash = { IRR: 0, USD: 0, CNY: 0 };
  const receivable = { IRR: 0, USD: 0, CNY: 0 };
  const payable = { IRR: 0, USD: 0, CNY: 0 };
  const negativeCompanyAccounts: { id: string; name: string; balance: number; currency: string }[] = [];
  const customersWeOwe: { ownerId: string; currency: string; amount: number }[] = [];

  for (const a of accounts) {
    const bal = Number(a.balance);
    if (a.ownerType === 'COMPANY' && !a.controlKind) {
      cash[a.currency] += bal;
      if (bal < 0) negativeCompanyAccounts.push({ id: a.id, name: a.name, balance: bal, currency: a.currency });
    } else if (a.ownerType === 'CUSTOMER') {
      receivable[a.currency] += bal; // ماهیت بدهکار: مثبت = طلب ما
      if (bal < 0) customersWeOwe.push({ ownerId: a.ownerId || '', currency: a.currency, amount: -bal });
    } else if (PAYABLE_TYPES.includes(a.ownerType as OwnerType)) {
      payable[a.currency] += -bal; // ماهیت بستانکار: مثبت = بدهی ما
    }
  }

  const sumIRR = (o: { IRR: number; USD: number; CNY: number }) =>
    Math.round(o.IRR + o.USD * irrOf('USD') + o.CNY * irrOf('CNY'));

  const [recentEntries, shipmentsAwaiting] = await Promise.all([
    prisma.journalEntry.findMany({
      include: {
        project: { select: { code: true } },
        lines: { include: { account: { select: { name: true } } } },
      },
      orderBy: { date: 'desc' },
      take: 8,
    }),
    prisma.mainShipment.findMany({
      where: { status: 'ARRIVED', freightInvoiceRegistered: false },
      select: { id: true, code: true, shippingCompany: { select: { name: true } } },
    }),
  ]);

  res.json({
    rates,
    cash: { ...cash, totalIRR: sumIRR(cash) },
    receivable: { ...receivable, totalIRR: sumIRR(receivable) },
    payable: { ...payable, totalIRR: sumIRR(payable) },
    netPositionIRR: sumIRR(cash) + sumIRR(receivable) - sumIRR(payable),
    alerts: {
      ratesStale: rates.isStale,
      negativeCompanyAccounts,
      customersWeOwe,
      shipmentsAwaitingFreight: shipmentsAwaiting.map((s) => ({ id: s.id, code: s.code, carrier: s.shippingCompany.name })),
    },
    recentEntries,
  });
});

// ════════════════════════════════════════════════
// حساب‌های شرکت
// ════════════════════════════════════════════════
router.get('/accounts', async (_req, res) => {
  const accounts = await prisma.financialAccount.findMany({
    where: { ownerType: 'COMPANY', controlKind: null, isActive: true },
    orderBy: { name: 'asc' },
  });
  res.json(accounts);
});

// ایجاد حساب — موجودی اولیه با «سند افتتاحیه» ثبت می‌شود نه دستکاری مستقیم مانده
router.post('/accounts', async (req: Request, res: Response) => {
  const { name, type, currency, openingBalance } = req.body;
  if (!name || !type || !currency) throw new AppError(400, 'نام، نوع و ارز حساب الزامی است');
  const opening = Number(openingBalance || 0);

  const account = await prisma.$transaction(async (tx) => {
    // حساب‌های نقد/بانک/تنخواه زیر «۱۱۰۰ نقد و بانک» در چارت می‌نشینند
    let cashParent = await tx.financialAccount.findUnique({ where: { code: CASH_PARENT_CODE }, select: { id: true } });
    if (!cashParent) {
      await ensureChartOfAccounts(tx);
      cashParent = await tx.financialAccount.findUnique({ where: { code: CASH_PARENT_CODE }, select: { id: true } });
    }
    const acc = await tx.financialAccount.create({
      data: {
        name, type, currency, ownerType: 'COMPANY', balance: 0,
        accountType: 'ASSET', parentId: cashParent?.id ?? null, isPostable: true,
      },
    });
    if (opening !== 0) {
      const rate = await rateFor(currency as Currency);
      const openingCtrl = await getOrCreateControl(tx, 'OPENING', currency as Currency);
      await postJournal(tx, {
        description: `سند افتتاحیه حساب «${name}»`,
        eventType: 'OPENING_BALANCE', sourceType: 'Account', sourceId: acc.id, createdById: req.user!.id,
        lines: opening > 0
          ? [
              { accountId: acc.id, debit: opening, currency: currency as Currency, rateToIRR: rate },
              { accountId: openingCtrl.id, credit: opening, currency: currency as Currency, rateToIRR: rate },
            ]
          : [
              { accountId: openingCtrl.id, debit: -opening, currency: currency as Currency, rateToIRR: rate },
              { accountId: acc.id, credit: -opening, currency: currency as Currency, rateToIRR: rate },
            ],
      });
    }
    return acc;
  });
  res.status(201).json(account);
});

router.patch('/accounts/:id', async (req: Request, res: Response) => {
  const acc = await prisma.financialAccount.findUnique({ where: { id: req.params.id } });
  if (!acc || acc.ownerType !== 'COMPANY' || acc.controlKind) throw new AppError(404, 'حساب شرکت یافت نشد');
  const { name, isActive } = req.body;
  const updated = await prisma.financialAccount.update({
    where: { id: acc.id },
    data: { name: name ?? undefined, isActive: typeof isActive === 'boolean' ? isActive : undefined },
  });
  res.json(updated);
});

// صورتحساب یک حساب با مانده تراز سطر به سطر
router.get('/accounts/:id/statement', async (req: Request, res: Response) => {
  const acc = await prisma.financialAccount.findUnique({ where: { id: req.params.id } });
  if (!acc) throw new AppError(404, 'حساب یافت نشد');

  const lines = await prisma.journalLine.findMany({
    where: { accountId: acc.id },
    include: { entry: { include: { project: { select: { code: true } } } } },
    orderBy: { entry: { date: 'asc' } },
  });

  let running = 0;
  const side = normalSide(acc);
  const rows = lines.map((l) => {
    running += Number(l.debit) - Number(l.credit);
    return {
      id: l.id,
      entryId: l.entryId,
      date: l.entry.date,
      entryNo: (l.entry as any).entryNo,
      description: l.entry.description,
      eventType: l.entry.eventType,
      project: l.entry.project?.code || null,
      debit: Number(l.debit),
      credit: Number(l.credit),
      rateToIRR: Number(l.rateToIRR),
      memo: l.memo,
      attachmentUrls: l.entry.attachmentUrls || [],  // پیوست سند در همان ردیف دیده شود
      running: side === 'DEBIT' ? running : -running, // نمایش با علامت طبیعی حساب
    };
  }).reverse();

  res.json({
    account: { id: acc.id, name: acc.name, type: acc.type, currency: acc.currency, balance: Number(acc.balance), normalSide: side },
    rows,
  });
});

// ════════════════════════════════════════════════
// چارت حساب‌ها
// ════════════════════════════════════════════════

/**
 * درخت چارت با ماندهٔ تجمیعی.
 *
 * هر گره سه عدد برمی‌گرداند:
 *  - `own`      ماندهٔ خودِ حساب به ارز خودش (سرگروه‌ها همیشه صفر)
 *  - `byCur`    جمع خود + همهٔ نوادگان، به تفکیک ارز
 *  - `totalIRR` معادل ریالی همان جمع — تنها عددی که برای گره‌های چندارزی معنا دارد
 *
 * همه با **علامت طبیعی** حساب برمی‌گردند: بدهی ۵ میلیون ⇒ +۵٬۰۰۰٬۰۰۰
 */
router.get('/chart', async (_req: Request, res: Response) => {
  const rows = await prisma.financialAccount.findMany({
    where: {
      OR: [
        { code: { not: null } },                  // گره‌های چارت
        { ownerType: { not: 'COMPANY' } },        // کیف پول طرف‌حساب‌ها (دفتر معین)
        { parentId: { not: null } },              // حساب‌های نقد/بانک وصل‌شده به چارت
      ],
    },
    select: {
      id: true, code: true, name: true, accountType: true, currency: true,
      isPostable: true, parentId: true, balance: true, type: true,
      ownerType: true, ownerId: true, isActive: true, controlKind: true,
    },
    orderBy: [{ code: 'asc' }, { name: 'asc' }],
  });

  const rates = await getRates();
  const toIRR = (amount: number, cur: string) =>
    cur === 'IRR' ? amount : amount * (cur === 'USD' ? rates.USD_TO_IRR : rates.CNY_TO_IRR);

  type Node = (typeof rows)[number] & {
    own: number; byCur: Record<string, number>; totalIRR: number; children: Node[];
  };

  const byId = new Map<string, Node>();
  for (const r of rows) {
    const sign = normalSide(r) === 'DEBIT' ? 1 : -1;
    const own = Number(r.balance) * sign;   // با علامت طبیعی
    byId.set(r.id, { ...r, own, byCur: {}, totalIRR: 0, children: [] });
  }

  const roots: Node[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (parent) parent.children.push(node); else roots.push(node);
  }

  // تجمیع از برگ به ریشه
  const rollUp = (node: Node): void => {
    node.byCur = {};
    if (node.own !== 0) node.byCur[node.currency] = node.own;
    for (const child of node.children) {
      rollUp(child);
      for (const [cur, amt] of Object.entries(child.byCur)) {
        node.byCur[cur] = (node.byCur[cur] || 0) + amt;
      }
    }
    node.totalIRR = Object.entries(node.byCur).reduce((s, [cur, amt]) => s + toIRR(amt, cur), 0);
  };
  roots.forEach(rollUp);

  res.json(roots);
});

// ساخت/تکمیل چارت استاندارد — idempotent
router.post('/chart/ensure', requireRole('SUPER_ADMIN'), async (_req: Request, res: Response) => {
  const map = await prisma.$transaction(async (tx) => ensureChartOfAccounts(tx), { timeout: 60000 });
  res.json({ ok: true, nodes: map.size });
});

/**
 * ⚠️ ریست کامل حسابداری (فقط مدیر کل).
 * همهٔ اسناد، ردیف‌ها و حساب‌ها پاک می‌شوند و چارت استاندارد از نو ساخته می‌شود.
 * اسناد «مشتق» (فاکتور/حمل/کرایه) بعدش با rebuild-ledger خودکار بازتولید می‌شوند؛
 * اسناد دستی (افتتاحیه/تسویه/تبدیل/هزینه) باید دستی دوباره وارد شوند.
 * برای جلوگیری از اجرای تصادفی، بدنه باید دقیقاً { confirm: 'RESET-ACCOUNTING' } باشد.
 */
router.post('/reset', requireRole('SUPER_ADMIN'), async (req: Request, res: Response) => {
  if (req.body?.confirm !== 'RESET-ACCOUNTING') {
    throw new AppError(400, 'برای ریست باید confirm=RESET-ACCOUNTING فرستاده شود');
  }
  const before = {
    accounts: await prisma.financialAccount.count(),
    entries: await prisma.journalEntry.count(),
    lines: await prisma.journalLine.count(),
  };

  const result = await prisma.$transaction(async (tx) => {
    await tx.journalLine.deleteMany({});
    await tx.journalEntryRevision.deleteMany({});
    await tx.journalEntry.deleteMany({});
    await tx.financialAccount.deleteMany({});
    const map = await ensureChartOfAccounts(tx);
    return { chartNodes: map.size };
  }, { timeout: 120000 });

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'DELETE', entity: 'FinancialAccount', changes: { reset: before, ...result } as any },
  });
  res.json({ ok: true, حذف‌شده: before, ...result });
});

// ════════════════════════════════════════════════
// صورت‌های مالی (spec ۵-۴)
// همه از دفتر ساخته می‌شوند، با نرخِ خودِ هر ردیف — نه نرخ امروز
// ════════════════════════════════════════════════

const parseDate = (v: string | undefined, fallback: Date): Date => {
  if (!v) return fallback;
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new AppError(400, 'تاریخ نامعتبر است');
  return d;
};
const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };

router.get('/reports/trial-balance', async (req: Request, res: Response) => {
  const asOf = endOfDay(parseDate((req.query.asOf as string), new Date()));
  res.json(await trialBalance(prisma as any, asOf));
});

router.get('/reports/balance-sheet', async (req: Request, res: Response) => {
  const asOf = endOfDay(parseDate((req.query.asOf as string), new Date()));
  res.json(await balanceSheet(prisma as any, asOf));
});

// سن‌بندی مطالبات (RECEIVABLE) یا بدهی‌ها (PAYABLE)
router.get('/reports/aging/:side', async (req: Request, res: Response) => {
  const side = req.params.side.toUpperCase();
  if (side !== 'RECEIVABLE' && side !== 'PAYABLE') throw new AppError(400, 'side باید RECEIVABLE یا PAYABLE باشد');
  const asOf = endOfDay(parseDate(req.query.asOf as string, new Date()));
  res.json(await aging(prisma as any, side, asOf));
});

// بررسی سلامت دفاتر: انحراف ماندهٔ مادی‌شده، حساب طبقه‌بندی‌نشده، سند ناتراز
router.get('/reports/integrity', async (_req: Request, res: Response) => {
  res.json(await integrityCheck(prisma as any));
});

router.get('/reports/income-statement', async (req: Request, res: Response) => {
  const to = endOfDay(parseDate(req.query.to as string, new Date()));
  // پیش‌فرض: از ابتدای همان سال میلادیِ تاریخ پایان
  const from = parseDate(req.query.from as string, new Date(to.getFullYear(), 0, 1));
  if (from > to) throw new AppError(400, 'تاریخ شروع نمی‌تواند بعد از پایان باشد');
  res.json(await incomeStatement(prisma as any, from, to));
});

// ════════════════════════════════════════════════
// تجدید ارزیابی ارزی پایان دوره (spec ۴-۴)
// ════════════════════════════════════════════════

// پیش‌نمایش — چیزی ثبت نمی‌کند
router.get('/revaluation/preview', async (req: Request, res: Response) => {
  const { asOf, usd, cny } = req.query as Record<string, string>;
  const date = asOf ? new Date(asOf) : new Date();
  if (isNaN(date.getTime())) throw new AppError(400, 'تاریخ نامعتبر است');
  const override: Partial<Record<Currency, number>> = {};
  if (usd && Number(usd) > 0) override.USD = Number(usd);
  if (cny && Number(cny) > 0) override.CNY = Number(cny);

  const preview = await previewRevaluation(prisma as any, date, override);
  res.json(preview);
});

// ثبت سند تعدیل + سند برگشتِ اول دورهٔ بعد (هر دو با هم)
router.post('/revaluation', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { asOf, usd, cny, force } = req.body || {};
  const date = asOf ? new Date(asOf) : new Date();
  if (isNaN(date.getTime())) throw new AppError(400, 'تاریخ نامعتبر است');
  const override: Partial<Record<Currency, number>> = {};
  if (usd && Number(usd) > 0) override.USD = Number(usd);
  if (cny && Number(cny) > 0) override.CNY = Number(cny);

  try {
    const result = await prisma.$transaction(async (tx) => {
      await assertPeriodOpen(tx, date);
      return postRevaluation(tx, { asOf: date, overrideRates: override, createdById: req.user!.id, force: !!force });
    }, { timeout: 60000 });

    if (result.posted) {
      await prisma.auditLog.create({
        data: {
          userId: req.user!.id, action: 'CREATE', entity: 'JournalEntry',
          changes: { revaluation: result.preview.period, netIRR: result.netIRR, entryNo: result.entryNo } as any,
        },
      });
    }
    res.json(result);
  } catch (e: any) {
    throw e instanceof AppError ? e : new AppError(400, e.message || 'ثبت تجدید ارزیابی ناموفق بود');
  }
});

// بازسازی کامل دفاتر — پاک‌سازی دفتر روزنامه و ساخت مجدد از منابع معتبر (فقط مدیر کل)
router.post('/rebuild-ledger', requireRole('SUPER_ADMIN'), async (req: Request, res: Response) => {
  const result = await rebuildLedger(prisma as any, req.user!.id);
  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'JournalEntry', changes: { rebuild: result } as any },
  });
  res.json({ ok: true, ...result });
});

// بازسازی اسناد فاکتورهای تأییدشده قدیمی که سند ندارند
router.post('/backfill-invoices', async (req: Request, res: Response) => {
  const approved = await prisma.invoice.findMany({ where: { status: 'APPROVED' }, select: { id: true } });
  let created = 0;
  for (const inv of approved) {
    await prisma.$transaction(async (tx) => {
      const did = await postInvoiceObligations(tx, inv.id, req.user!.id);
      if (did) created += 1;
    }, { timeout: 20000 });
  }
  res.json({ ok: true, scanned: approved.length, created });
});

// همه حساب‌های قابل انتخاب در فرم‌ها
// ?includeControl=1 → حساب‌های کنترلی (فروش/خرید/هزینه/تسعیر/…) هم برگردانده می‌شوند.
// سند دستی به آن‌ها نیاز دارد (مثلاً هزینهٔ اجاره بدهکار، بانک بستانکار).
router.get('/all-accounts', async (req, res) => {
  const includeControl = req.query.includeControl === '1';
  const accounts = await prisma.financialAccount.findMany({
    where: { isActive: true, ...(includeControl ? {} : { controlKind: null }) },
    include: {
      customer: { select: { name: true } }, producer: { select: { name: true } }, supplier: { select: { name: true } },
      shippingCompany: { select: { name: true } }, exchange: { select: { name: true } }, commissionAgent: { select: { name: true } },
    },
    orderBy: [{ ownerType: 'asc' }, { name: 'asc' }],
  });
  res.json(accounts.map((a) => ({
    id: a.id, name: a.name, currency: a.currency, ownerType: a.ownerType, ownerId: a.ownerId, type: a.type,
    controlKind: a.controlKind,
    balance: Number(a.balance),
    ownerName: a.customer?.name || a.producer?.name || a.supplier?.name || a.shippingCompany?.name || a.exchange?.name || a.commissionAgent?.name || null,
  })));
});

// ساخت سه کیف پول طرف حساب (تا قبل از هر فاکتوری در فرم‌ها دیده شود)
router.post('/provision-wallets', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { ownerType, ownerId, ownerName } = req.body;
  if (!ownerType || !ownerId) throw new AppError(400, 'ownerType و ownerId الزامی است');
  await prisma.$transaction(async (tx) => {
    await provisionWallets(tx, ownerType as OwnerType, ownerId, ownerName);
  });
  res.json({ ok: true });
});

// تکمیل کیف پولِ طرف‌حساب‌های موجود (یک‌بار برای دادهٔ قدیمی) — هر طرف باید هر سه ارز را داشته باشد
router.post('/provision-wallets/all', requireRole('SUPER_ADMIN', 'MANAGER'), async (_req: Request, res: Response) => {
  const groups: { type: OwnerType; rows: { id: string; name: string }[] }[] = [
    { type: 'CUSTOMER', rows: await prisma.customer.findMany({ select: { id: true, name: true } }) },
    { type: 'PRODUCER', rows: await prisma.producer.findMany({ select: { id: true, name: true } }) },
    { type: 'SUPPLIER', rows: await prisma.supplier.findMany({ select: { id: true, name: true } }) },
    { type: 'CARRIER', rows: await prisma.shippingCompany.findMany({ select: { id: true, name: true } }) },
    { type: 'EXCHANGE', rows: await prisma.exchange.findMany({ select: { id: true, name: true } }) },
    { type: 'COMMISSION_AGENT', rows: await prisma.commissionAgent.findMany({ select: { id: true, name: true } }) },
  ];
  let parties = 0;
  for (const g of groups) {
    for (const row of g.rows) {
      await prisma.$transaction(async (tx) => { await provisionWallets(tx, g.type, row.id, row.name); });
      parties++;
    }
  }
  res.json({ ok: true, parties });
});

// ════════════════════════════════════════════════
// پنجره I — انتقال وجه (دوطرفه، هم‌ارز)
// ════════════════════════════════════════════════
router.post('/transfers', upload.single('receipt'), async (req: Request, res: Response) => {
  const { fromAccountId, toAccountId, amount, projectId, description, eventType } = req.body;
  if (!fromAccountId || !toAccountId || !amount) throw new AppError(400, 'حساب مبدأ، مقصد و مبلغ الزامی است');
  if (fromAccountId === toAccountId) throw new AppError(400, 'حساب مبدأ و مقصد نمی‌تواند یکسان باشد');
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) throw new AppError(400, 'مبلغ باید بزرگ‌تر از صفر باشد');

  const fromAcc = await prisma.financialAccount.findUnique({ where: { id: fromAccountId } });
  const toAcc = await prisma.financialAccount.findUnique({ where: { id: toAccountId } });
  if (!fromAcc || !toAcc) throw new AppError(404, 'حساب یافت نشد');
  if (!fromAcc.isActive || !toAcc.isActive) throw new AppError(400, 'حساب غیرفعال است');
  if (fromAcc.currency !== toAcc.currency) {
    throw new AppError(400, 'واحد پولی مبدأ و مقصد باید یکسان باشد — برای تبدیل ارز از «عملیات ارزی» استفاده کنید');
  }
  // اصل چند‌ارزی: تسویه با طرف حساب (مشتری/سازنده/تامین‌کننده/...) باید از «دریافت/پرداخت» برود
  // تا تعهد به ارز خودش بسته شود و تسعیر محقق سند بخورد. انتقال فقط بین حساب‌های شرکت.
  if (fromAcc.ownerType !== 'COMPANY' || toAcc.ownerType !== 'COMPANY') {
    throw new AppError(400, 'انتقال وجه فقط بین حساب‌های شرکت مجاز است — برای دریافت از مشتری یا پرداخت به طرف حساب از «💰 دریافت / پرداخت» استفاده کنید');
  }

  const currency = fromAcc.currency;
  const rate = await rateFor(currency);
  const attachmentUrls = req.file ? [storeReceipt(req.file, 'TRANSFER', { currencyCode: currency })] : [];

  await prisma.$transaction(async (tx) => {
    await postJournal(tx, {
      description: description || 'انتقال وجه',
      eventType: eventType || 'TRANSFER',
      sourceType: 'Manual',
      projectId: projectId || undefined,
      createdById: req.user!.id,
      attachmentUrls,
      lines: [
        { accountId: toAccountId, debit: amt, currency, rateToIRR: rate },
        { accountId: fromAccountId, credit: amt, currency, rateToIRR: rate },
      ],
    });
  });

  if (projectId) {
    await prisma.auditLog.create({
      data: { userId: req.user!.id, action: 'CREATE', entity: 'JournalEntry', projectId, changes: { type: eventType || 'TRANSFER', amount: amt, currency, description } },
    });
  }
  res.json({ ok: true });
});

// ════════════════════════════════════════════════
// دریافت / پرداخت (تسویهٔ چند‌ارزی با طرف حساب)
// تعهد به ارز خودش بسته می‌شود (نرخ میانگین ثبت)، نقد به ارز حساب شرکت و نرخ روز،
// اختلاف ریالی = سود/زیان تسعیر «محقق‌شده» → FX_DIFF.
// مثال: فاکتور دلاری، مشتری تومان می‌دهد → کیف دلاری مشتری واقعاً صفر می‌شود.
// ════════════════════════════════════════════════
router.post('/settlements', upload.single('receipt'), async (req: Request, res: Response) => {
  const { direction, ownerType, ownerId, obligationCurrency, settledAmount, companyAccountId, projectId, description } = req.body;
  if (!direction || !['RECEIPT', 'PAYMENT'].includes(direction)) throw new AppError(400, 'نوع تسویه (دریافت/پرداخت) الزامی است');
  if (!ownerType || !ownerId) throw new AppError(400, 'طرف حساب الزامی است');
  if (!obligationCurrency) throw new AppError(400, 'ارز تعهد الزامی است');
  if (!companyAccountId) throw new AppError(400, 'حساب شرکت الزامی است');
  const settled = Number(settledAmount);
  if (!isFinite(settled) || settled <= 0) throw new AppError(400, 'مبلغ تسویه باید بزرگ‌تر از صفر باشد');

  // دریافت/پرداخت فقط هم‌ارز: پول با هر ارزی که جابه‌جا می‌شود باید به حسابِ همان ارز برود.
  // تبدیل واحد فقط از «عملیات ارزی» انجام می‌شود تا نرخ و تسعیر یک‌جا و شفاف ثبت شود.
  const companyAcc = await prisma.financialAccount.findUnique({ where: { id: companyAccountId } });
  if (!companyAcc) throw new AppError(404, 'حساب شرکت یافت نشد');
  if (companyAcc.currency !== obligationCurrency) {
    throw new AppError(400,
      `ارز حساب شرکت (${CUR_LABEL[companyAcc.currency]}) با ارز تعهد (${CUR_LABEL[obligationCurrency]}) یکی نیست — ` +
      'دریافت/پرداخت فقط هم‌ارز است. برای تبدیل واحد ابتدا از «عملیات ارزی» استفاده کنید.');
  }
  // هم‌ارز ⇒ مبلغ نقدی همان مبلغ تسویه است
  const cash = settled;

  const attachmentUrls = req.file ? [storeReceipt(req.file, direction === 'RECEIPT' ? 'RECEIPT' : 'PAYMENT', { currencyCode: obligationCurrency })] : [];

  const settlementDate = new Date();
  let legacyEntryId: string | undefined;
  try {
    await prisma.$transaction(async (tx) => {
      if (writeLegacy()) {
        const entry = await postSettlement(tx, {
          direction, ownerType: ownerType as OwnerType, ownerId,
          obligationCurrency: obligationCurrency as Currency,
          settledAmount: settled, companyAccountId, cashAmount: cash,
          projectId: projectId || undefined, description: description || undefined,
          createdById: req.user!.id, attachmentUrls,
        });
        legacyEntryId = (entry as any)?.id;
      }
      // هم‌ارز تضمین‌شده (بالاتر چک شد) — pwSettlement هم فقط هم‌ارز می‌پذیرد
      await pwSettlement(tx, {
        direction, ownerType, ownerId, currency: obligationCurrency, amount: settled,
        companyAccountName: companyAcc.name, date: settlementDate, userId: req.user!.id,
      });
    }, { timeout: 20000 });
  } catch (e: any) {
    throw new AppError(400, e.message || 'خطا در ثبت تسویه');
  }

  if (legacyEntryId) {
    await dwSettlement({   // سایهٔ 'dual' (در حالت 'new' اجرا نمی‌شود — legacyEntryId خالی است)
      legacyEntryId, direction, ownerType, ownerId,
      currency: obligationCurrency, amount: settled,
      legacyCashAccountName: companyAcc.name, date: settlementDate, userId: req.user!.id,
    });
  }

  if (projectId) {
    await prisma.auditLog.create({
      data: { userId: req.user!.id, action: 'CREATE', entity: 'JournalEntry', projectId, changes: { type: 'SETTLEMENT', direction, settled, obligationCurrency, cash } },
    });
  }
  res.json({ ok: true });
});

// پیش‌نمایش تسویه: نرخ میانگین ثبتِ تعهد + ماندهٔ کیف — برای نمایش تسعیر قبل از ثبت
router.get('/settlements/preview', async (req: Request, res: Response) => {
  const { ownerType, ownerId, currency } = req.query as Record<string, string>;
  if (!ownerType || !ownerId || !currency) throw new AppError(400, 'ownerType/ownerId/currency لازم است');
  const wallet = await prisma.financialAccount.findFirst({
    where: { ownerType, ownerId, currency: currency as Currency, controlKind: null },
  });
  if (!wallet) return res.json({ balance: 0, bookedRate: await rateFor(currency as Currency), liveRate: await rateFor(currency as Currency) });
  const side = normalSide(wallet);
  const bookedRate = await walletAvgBookedRate(prisma as any, wallet.id, side, currency as Currency);
  // نرخ‌ها بدون گرد کردن برمی‌گردند — گرد کردن نرخ ارز خطای مبلغ می‌سازد
  res.json({
    balance: side === 'DEBIT' ? Number(wallet.balance) : -Number(wallet.balance), // با علامت طبیعی (مثبت = طلب/بدهی باز)
    bookedRate,
    liveRate: await rateFor(currency as Currency),
  });
});

// ════════════════════════════════════════════════
// ثبت هزینه (تنخواه) — بدهکار «هزینه‌های عمومی» / بستانکار حساب تنخواه یا بانک شرکت
// دفترداری دوطرفهٔ استاندارد؛ دسته‌بندی هزینه در memo/شرح ذخیره می‌شود
// ════════════════════════════════════════════════
router.post('/expenses', upload.single('receipt'), async (req: Request, res: Response) => {
  const { fromAccountId, amount, category, description, projectId, date } = req.body;
  if (!fromAccountId || !amount) throw new AppError(400, 'حساب و مبلغ الزامی است');
  const amt = Number(amount);
  if (!isFinite(amt) || amt <= 0) throw new AppError(400, 'مبلغ باید بزرگ‌تر از صفر باشد');

  const acc = await prisma.financialAccount.findUnique({ where: { id: fromAccountId } });
  if (!acc) throw new AppError(404, 'حساب یافت نشد');
  if (acc.ownerType !== 'COMPANY' || acc.controlKind) throw new AppError(400, 'هزینه باید از حساب شرکت/تنخواه پرداخت شود');

  const currency = acc.currency;
  const rate = await rateFor(currency);
  const attachmentUrls = req.file ? [storeReceipt(req.file, 'EXPENSE', { currencyCode: currency })] : [];
  const label = [category, description].filter(Boolean).join(' — ') || 'هزینه';

  await prisma.$transaction(async (tx) => {
    const expenseCtrl = await getOrCreateControl(tx, 'EXPENSE', currency);
    await postJournal(tx, {
      description: `هزینه: ${label}`,
      eventType: 'EXPENSE',
      sourceType: 'Manual',
      projectId: projectId || undefined,
      createdById: req.user!.id,
      attachmentUrls,
      date: date ? new Date(date) : undefined,
      lines: [
        { accountId: expenseCtrl.id, debit: amt, currency, rateToIRR: rate, memo: category || 'هزینه' },
        { accountId: acc.id, credit: amt, currency, rateToIRR: rate, memo: 'پرداخت از تنخواه/بانک' },
      ],
    });
  });

  res.json({ ok: true });
});

// ════════════════════════════════════════════════
// پنجره H — عملیات ارزی (تبدیل بین دو ارز یک طرف حساب)
// اسپرد ریالی دو سمت → «سود و زیان تسعیر ارز»
// کارمزد → سند اتمی: هزینه کارمزد + گردش کامل در دفتر صراف + تسویه از حساب شرکت
// ════════════════════════════════════════════════
router.post('/conversions', upload.single('receipt'), async (req: Request, res: Response) => {
  const { fromAccountId, toAccountId, fromAmount, toAmount, feeAmount, feeCurrency, feeAccountId, exchangeId, description, projectId } = req.body;
  if (!fromAccountId || !toAccountId || !fromAmount || !toAmount) {
    throw new AppError(400, 'حساب مبدأ/مقصد و مبلغ هر دو سمت الزامی است');
  }
  const fAmt = Number(fromAmount), tAmt = Number(toAmount);
  if (!isFinite(fAmt) || fAmt <= 0 || !isFinite(tAmt) || tAmt <= 0) throw new AppError(400, 'مبالغ باید بزرگ‌تر از صفر باشند');

  const fromAcc = await prisma.financialAccount.findUnique({ where: { id: fromAccountId } });
  const toAcc = await prisma.financialAccount.findUnique({ where: { id: toAccountId } });
  if (!fromAcc || !toAcc) throw new AppError(404, 'حساب یافت نشد');
  if (fromAcc.currency === toAcc.currency) throw new AppError(400, 'واحد پولی مبدأ و مقصد باید متفاوت باشد');

  // هر دو حساب باید متعلق به یک طرف باشند (شرکت یا یک طرف حساب مشخص)
  const sameCompany = fromAcc.ownerType === 'COMPANY' && toAcc.ownerType === 'COMPANY';
  const sameParty = fromAcc.ownerType === toAcc.ownerType && fromAcc.ownerId && fromAcc.ownerId === toAcc.ownerId;
  if (!sameCompany && !sameParty) {
    throw new AppError(400, 'تبدیل ارز فقط بین دو حساب یک طرف حساب مجاز است — ابتدا شخص را انتخاب کنید');
  }

  const effRate = tAmt / fAmt;
  const attachmentUrls = req.file ? [storeReceipt(req.file, 'CONVERSION', { currencyPair: `${fromAcc.currency}-${toAcc.currency}` })] : [];

  await prisma.$transaction(async (tx) => {
    await postConversion(tx, {
      fromAccountId, toAccountId, fromAmount: fAmt, toAmount: tAmt,
      description: description ||
        `تبدیل ارز ${CUR_LABEL[fromAcc.currency]}→${CUR_LABEL[toAcc.currency]} (نرخ مؤثر ${effRate.toLocaleString('en-US', { maximumFractionDigits: 10 })})`,
      projectId: projectId || undefined,
      createdById: req.user!.id,
      attachmentUrls,
    });

    // کارمزد صرافی — یک سند اتمی، با گردش کامل در دفتر صراف
    const fee = Number(feeAmount || 0);
    if (fee > 0) {
      if (!feeAccountId) throw new AppError(400, 'حساب پرداخت کارمزد را انتخاب کنید');
      const feeAcc = await tx.financialAccount.findUnique({ where: { id: feeAccountId } });
      if (!feeAcc) throw new AppError(404, 'حساب کارمزد یافت نشد');
      if (feeAcc.ownerType !== 'COMPANY') throw new AppError(400, 'کارمزد باید از حساب شرکت پرداخت شود');
      // ارز کارمزد صریح است؛ حساب پرداخت‌کننده باید هم‌ارز باشد تا تبدیل ضمنی رخ ندهد
      const feeCur = (feeCurrency || feeAcc.currency) as Currency;
      if (feeAcc.currency !== feeCur) {
        throw new AppError(400, `کارمزد به ${CUR_LABEL[feeCur]} است — حساب پرداخت‌کننده هم باید ${CUR_LABEL[feeCur]} باشد`);
      }

      const feeRate = await rateFor(feeCur);
      const feeCtrl = await getOrCreateControl(tx, 'FEE', feeCur);
      const feeLines: any[] = [
        { accountId: feeCtrl.id, debit: fee, currency: feeCur, rateToIRR: feeRate, memo: 'هزینه کارمزد صرافی' },
      ];
      if (exchangeId) {
        const exWallet = await getOrCreateWallet(tx, 'EXCHANGE', exchangeId, feeCur);
        // ایجاد بدهی به صراف و تسویه آنی — گردش در دفتر صراف ثبت می‌شود
        feeLines.push({ accountId: exWallet.id, credit: fee, currency: feeCur, rateToIRR: feeRate, memo: 'کارمزد صراف' });
        feeLines.push({ accountId: exWallet.id, debit: fee, currency: feeCur, rateToIRR: feeRate, memo: 'تسویه کارمزد' });
      }
      feeLines.push({ accountId: feeAcc.id, credit: fee, currency: feeCur, rateToIRR: feeRate, memo: 'پرداخت کارمزد' });

      await postJournal(tx, {
        description: `کارمزد عملیات ارزی (${CUR_LABEL[feeCur]})`,
        eventType: 'CONVERSION_FEE', sourceType: 'Manual', projectId: projectId || undefined, createdById: req.user!.id,
        lines: feeLines,
      });
    }
  });

  res.json({ ok: true });
});

// ════════════════════════════════════════════════
// پروژه‌های یک طرف حساب — در فرم‌های مالی فقط پروژه‌های همان شخص انتخاب‌شدنی باشد
// ════════════════════════════════════════════════
router.get('/party-projects', async (req: Request, res: Response) => {
  const { ownerType, ownerId } = req.query as Record<string, string>;
  if (!ownerType || !ownerId) throw new AppError(400, 'ownerType و ownerId لازم است');

  let where: any;
  switch (ownerType as OwnerType) {
    case 'CUSTOMER':
      where = { customerId: ownerId };
      break;
    case 'PRODUCER':
      where = { parts: { some: { selectedPrice: { producerId: ownerId } } } };
      break;
    case 'SUPPLIER':
      where = { parts: { some: { selectedPrice: { supplierId: ownerId } } } };
      break;
    case 'COMMISSION_AGENT':
      where = { commissions: { some: { agentId: ownerId } } };
      break;
    case 'CARRIER': {
      // پروژه‌های حاضر در محموله‌های این شرکت حمل: هم بستهٔ داخلی، هم بار فورواردینگ
      const shipments = await prisma.mainShipment.findMany({
        where: { shippingCompanyId: ownerId },
        select: {
          forwardingCargos: { select: { projectId: true } },
          packages: { select: { package: { select: { items: { select: { order: { select: { projectId: true } } } } } } } },
        },
      });
      const ids = new Set<string>();
      for (const s of shipments) {
        for (const c of s.forwardingCargos) ids.add(c.projectId);
        for (const sp of s.packages) for (const it of sp.package.items) ids.add(it.order.projectId);
      }
      where = { id: { in: [...ids] } };
      break;
    }
    default:
      // صراف به پروژه گره نمی‌خورد — همهٔ پروژه‌ها قابل انتخاب می‌مانند
      where = {};
  }

  const projects = await prisma.project.findMany({
    where,
    select: { id: true, code: true, description: true, customer: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json(projects);
});

// ════════════════════════════════════════════════
// دفاتر تفصیلی (پنجره J)
// ════════════════════════════════════════════════
async function listEntities(ownerType: string): Promise<{ id: string; name: string }[]> {
  switch (ownerType) {
    case 'CUSTOMER': return prisma.customer.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    case 'PRODUCER': return prisma.producer.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    case 'SUPPLIER': return prisma.supplier.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    case 'CARRIER': return prisma.shippingCompany.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    case 'EXCHANGE': return prisma.exchange.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    case 'COMMISSION_AGENT': return prisma.commissionAgent.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    default: return [];
  }
}

router.get('/ledger/:ownerType', async (req: Request, res: Response) => {
  const ownerType = req.params.ownerType as OwnerType;
  const entities = await listEntities(ownerType);

  const wallets = await prisma.financialAccount.findMany({ where: { ownerType, controlKind: null } });
  const balByOwner: Record<string, { IRR: number; USD: number; CNY: number }> = {};
  for (const acc of wallets) {
    const key = acc.ownerId || 'unknown';
    if (!balByOwner[key]) balByOwner[key] = { IRR: 0, USD: 0, CNY: 0 };
    const side = normalSide(acc);
    balByOwner[key][acc.currency] = side === 'DEBIT' ? Number(acc.balance) : -Number(acc.balance);
  }

  const rates = await getRates();
  const rows = entities.map((e) => {
    const b = balByOwner[e.id] || { IRR: 0, USD: 0, CNY: 0 };
    return { id: e.id, name: e.name, ...b, totalIRR: Math.round(b.IRR + b.USD * rates.USD_TO_IRR + b.CNY * rates.CNY_TO_IRR) };
  });
  res.json(rows);
});

router.get('/ledger/:ownerType/:ownerId/detail', async (req: Request, res: Response) => {
  const { ownerType, ownerId } = req.params;
  const accounts = await prisma.financialAccount.findMany({ where: { ownerType, ownerId } });
  const accountIds = accounts.map((a) => a.id);

  const balances: Record<string, number> = { IRR: 0, USD: 0, CNY: 0 };
  accounts.forEach((a) => {
    const side = normalSide(a);
    balances[a.currency] = side === 'DEBIT' ? Number(a.balance) : -Number(a.balance);
  });

  // مانده تجمعی باید از ابتدای تاریخ حساب شود، وگرنه با بریدنِ ۵۰۰ ردیف عدد غلط می‌شود.
  // پس کل ردیف‌ها را به ترتیب صعودی می‌گیریم، مانده را جلو می‌بریم، بعد آخرین ۵۰۰ تا را برمی‌گردانیم.
  const allLines = await prisma.journalLine.findMany({
    where: { accountId: { in: accountIds } },
    include: {
      account: { select: { id: true, currency: true, ownerType: true, controlKind: true, accountType: true } },
      entry: { include: { project: { select: { id: true, code: true } } } },
    },
    orderBy: [{ entry: { date: 'asc' } }, { entry: { entryNo: 'asc' } }],
  });

  // مانده جداگانه برای هر ارز — طرف حساب می‌تواند همزمان کیف تومانی و دلاری و یوآنی داشته باشد
  const runningByCur: Record<string, number> = { IRR: 0, USD: 0, CNY: 0 };
  const withRunning = allLines.map((l) => {
    const side = normalSide(l.account);
    runningByCur[l.currency] += (Number(l.debit) - Number(l.credit)) * (side === 'DEBIT' ? 1 : -1);
    return { ...l, running: runningByCur[l.currency] };
  });
  const lines = withRunning.slice(-500).reverse();

  // تفکیک پروژه (با علامت طبیعی: مشتری=طلب مثبت، بقیه=بدهی مثبت)
  const sign = ownerType === 'CUSTOMER' ? 1 : -1;
  const byProject: Record<string, any> = {};
  for (const l of withRunning) {   // روی همهٔ ردیف‌ها، نه فقط ۵۰۰ تای آخر
    const proj = l.entry.project;
    if (!proj) continue;
    if (!byProject[proj.id]) byProject[proj.id] = { id: proj.id, code: proj.code, IRR: 0, USD: 0, CNY: 0 };
    byProject[proj.id][l.currency] += (Number(l.debit) - Number(l.credit)) * sign;
  }

  res.json({ balances, accounts, projects: Object.values(byProject), history: lines });
});

// مانده مشتری برای یک پروژه (+ مانده کل مشتری) — استفاده در هشدار تحویل
router.get('/project-balance/:projectId', async (req: Request, res: Response) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.projectId }, select: { customerId: true } });
  if (!project) throw new AppError(404, 'پروژه یافت نشد');

  const custAccounts = await prisma.financialAccount.findMany({ where: { ownerType: 'CUSTOMER', ownerId: project.customerId } });
  const ids = custAccounts.map((a) => a.id);

  const projLines = await prisma.journalLine.findMany({ where: { accountId: { in: ids }, entry: { projectId: req.params.projectId } } });
  let projectIRR = 0;
  for (const l of projLines) projectIRR += (Number(l.debit) - Number(l.credit)) * Number(l.rateToIRR);

  const rates = await getRates();
  let customerTotalIRR = 0;
  for (const a of custAccounts) {
    const r = a.currency === 'IRR' ? 1 : a.currency === 'USD' ? rates.USD_TO_IRR : rates.CNY_TO_IRR;
    customerTotalIRR += Number(a.balance) * r;
  }

  res.json({ balance: Math.round(projectIRR), customerTotalIRR: Math.round(customerTotalIRR), currency: 'IRR' });
});

// ════════════════════════════════════════════════
// دفتر روزنامه (با فیلتر)
// ════════════════════════════════════════════════
router.get('/journal', async (req: Request, res: Response) => {
  const { eventType, projectId, q, from, to } = req.query as Record<string, string>;
  const where: any = {};
  if (eventType) where.eventType = eventType;
  if (projectId) where.projectId = projectId;
  if (q) where.description = { contains: q, mode: 'insensitive' };
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = new Date(from);
    if (to) { const t = new Date(to); t.setHours(23, 59, 59, 999); where.date.lte = t; }
  }

  const entries = await prisma.journalEntry.findMany({
    where,
    include: {
      project: { select: { id: true, code: true } },
      lines: { include: { account: { select: { id: true, name: true, ownerType: true, controlKind: true, accountType: true } } } },
    },
    orderBy: { date: 'desc' },
    take: 300,
  });
  res.json(entries);
});

// ════════════════════════════════════════════════
// سند دستی — ثبت، مشاهده، ویرایش، ابطال
// ════════════════════════════════════════════════

/** ردیف‌های ورودی کاربر را اعتبارسنجی و به JournalLineInput تبدیل می‌کند */
async function normalizeLines(raw: any): Promise<JournalLineInput[]> {
  if (!Array.isArray(raw) || raw.length < 2) throw new AppError(400, 'سند حداقل به دو ردیف نیاز دارد');
  const accIds = [...new Set(raw.map((l: any) => l.accountId).filter(Boolean))] as string[];
  const accounts = await prisma.financialAccount.findMany({ where: { id: { in: accIds } } });
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const out: JournalLineInput[] = [];
  for (const l of raw) {
    const acc = byId.get(l.accountId);
    if (!acc) throw new AppError(400, 'حساب انتخاب‌شده در یکی از ردیف‌ها معتبر نیست');
    if (!acc.isActive) throw new AppError(400, `حساب «${acc.name}» غیرفعال است`);
    // سرگروه‌های چارت فقط تجمیع می‌کنند؛ سند باید روی برگ بخورد
    if (!acc.isPostable) {
      throw new AppError(400, `حساب «${acc.code ? acc.code + ' ' : ''}${acc.name}» سرگروه است و سند نمی‌گیرد — یکی از زیرحساب‌هایش را انتخاب کنید`);
    }
    const debit = Number(l.debit) || 0;
    const credit = Number(l.credit) || 0;
    if (debit < 0 || credit < 0) throw new AppError(400, 'مبلغ نمی‌تواند منفی باشد');
    if (debit > 0 && credit > 0) throw new AppError(400, 'یک ردیف نمی‌تواند همزمان بدهکار و بستانکار باشد');
    if (debit === 0 && credit === 0) continue;
    // نرخ: اگر کاربر نرخ دستی داده همان، وگرنه نرخ روزِ ارزِ حساب
    const rate = Number(l.rateToIRR) > 0 ? Number(l.rateToIRR) : await rateFor(acc.currency);
    out.push({ accountId: acc.id, debit, credit, currency: acc.currency, rateToIRR: rate, memo: l.memo || undefined });
  }
  if (out.length < 2) throw new AppError(400, 'سند حداقل به دو ردیف غیرصفر نیاز دارد');
  return out;
}

// ثبت سند دستی
router.post('/journal', upload.array('attachments', 5), async (req: Request, res: Response) => {
  const body = req.body.payload ? JSON.parse(req.body.payload) : req.body;
  const { description, date, projectId, categoryId, lines } = body;
  if (!description?.trim()) throw new AppError(400, 'شرح سند الزامی است');

  const entryDate = date ? new Date(date) : new Date();
  if (isNaN(entryDate.getTime())) throw new AppError(400, 'تاریخ سند نامعتبر است');

  const normalized = await normalizeLines(lines);
  const files = (req.files as Express.Multer.File[]) || [];
  const attachmentUrls = files.map((f) => storeReceipt(f, 'MANUAL', {}));

  // ناترازی اینجا خطای ورودی کاربر است، نه خطای سرور ⇒ باید ۴۰۰ برگردد
  let entry;
  try {
    entry = await prisma.$transaction(async (tx) => {
      await assertPeriodOpen(tx, entryDate);
      return postJournal(tx, {
        description: description.trim(),
        eventType: 'MANUAL',
        sourceType: 'Manual',
        date: entryDate,
        projectId: projectId || undefined,
        createdById: req.user!.id,
        attachmentUrls,
        lines: normalized,
      });
    });
  } catch (e: any) {
    throw e instanceof AppError ? e : new AppError(400, e.message || 'ثبت سند ناموفق بود');
  }

  if (categoryId) {
    await prisma.journalEntry.update({ where: { id: entry.id }, data: { categoryId } });
  }
  await prisma.auditLog.create({
    data: {
      userId: req.user!.id, action: 'CREATE', entity: 'JournalEntry',
      projectId: projectId || undefined,
      changes: { entryNo: entry.entryNo, description, lines: normalized.length },
    },
  });
  res.json({ ok: true, id: entry.id, entryNo: entry.entryNo });
});

// جزئیات یک سند + تاریخچهٔ ویرایش + امکان ویرایش
router.get('/journal/:id', async (req: Request, res: Response) => {
  const entry = await prisma.journalEntry.findUnique({
    where: { id: req.params.id },
    include: {
      project: { select: { id: true, code: true } },
      category: { select: { id: true, name: true, kind: true } },
      lines: { include: { account: { select: { id: true, name: true, currency: true, ownerType: true, controlKind: true, accountType: true } } } },
      revisions: { orderBy: { createdAt: 'desc' } },
      reverses: { select: { id: true, entryNo: true } },
      reversedBy: { select: { id: true, entryNo: true } },
    },
  });
  if (!entry) throw new AppError(404, 'سند یافت نشد');
  const gate = await canEditEntry(prisma, entry);
  res.json({ ...entry, editable: gate.ok, notEditableReason: gate.reason || null });
});

// ویرایش سند (فقط تا وقتی دوره باز است — بعد از آن باید ابطال شود)
router.patch('/journal/:id', async (_req: Request, _res: Response) => {
  // ممیزی (بخش د): ویرایش سند ثبت‌شده نقض تغییرناپذیری است — همان چیزی که کل
  // بازنویسیِ هسته برای رفعش بود. این مسیر پیش از برشِ نهایی هم غیرفعال شد؛
  // اصلاح فقط با «ابطال + سند جدید».
  throw new AppError(410, 'ویرایش سند ثبت‌شده دیگر مجاز نیست. برای اصلاح، سند را ابطال و سند درست را دوباره ثبت کنید.');
});

// ابطال سند با سند برگشتی (سند اصلی دست‌نخورده می‌ماند)
router.post('/journal/:id/reverse', async (req: Request, res: Response) => {
  const { reason } = req.body;
  if (!reason?.trim()) throw new AppError(400, 'دلیل ابطال الزامی است');

  const reversal = await prisma.$transaction((tx) =>
    reverseJournal(tx, req.params.id, { reason: reason.trim(), createdById: req.user!.id }),
  );

  await prisma.auditLog.create({
    data: { userId: req.user!.id, action: 'UPDATE', entity: 'JournalEntry', changes: { action: 'REVERSE', reversalNo: reversal.entryNo, reason } },
  });
  res.json({ ok: true, entryNo: reversal.entryNo });
});

// ════════════════════════════════════════════════
// دوره‌های مالی (قفل)
// ════════════════════════════════════════════════
router.get('/periods', async (_req, res) => {
  const periods = await prisma.fiscalPeriod.findMany({ orderBy: [{ year: 'desc' }, { month: 'desc' }] });
  res.json({ periods, current: toJalaliYM(new Date()) });
});

router.post('/periods/close', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const year = Number(req.body.year);
  const month = req.body.month == null || req.body.month === '' ? null : Number(req.body.month);
  if (!year || year < 1300 || year > 1500) throw new AppError(400, 'سال نامعتبر است');
  if (month !== null && (month < 1 || month > 12)) throw new AppError(400, 'ماه نامعتبر است');

  const period = await prisma.fiscalPeriod.upsert({
    where: { year_month: { year, month: month as any } },
    create: { year, month, closedAt: new Date(), closedById: req.user!.id, note: req.body.note || null },
    update: { closedAt: new Date(), closedById: req.user!.id, note: req.body.note || null },
  });
  res.json({ ok: true, period });
});

router.post('/periods/open', requireRole('SUPER_ADMIN'), async (req: Request, res: Response) => {
  const year = Number(req.body.year);
  const month = req.body.month == null || req.body.month === '' ? null : Number(req.body.month);
  const period = await prisma.fiscalPeriod.update({
    where: { year_month: { year, month: month as any } },
    data: { closedAt: null, closedById: null },
  });
  res.json({ ok: true, period });
});

// ════════════════════════════════════════════════
// سرفصل‌های هزینه/درآمد عمومی
// ════════════════════════════════════════════════
router.get('/categories', async (_req, res) => {
  res.json(await prisma.expenseCategory.findMany({ orderBy: [{ kind: 'asc' }, { name: 'asc' }] }));
});

router.post('/categories', async (req: Request, res: Response) => {
  const name = String(req.body.name || '').trim();
  const kind = req.body.kind === 'INCOME' ? 'INCOME' : 'EXPENSE';
  if (!name) throw new AppError(400, 'نام سرفصل الزامی است');
  const existing = await prisma.expenseCategory.findUnique({ where: { name } });
  if (existing) throw new AppError(400, 'سرفصلی با این نام وجود دارد');
  res.json(await prisma.expenseCategory.create({ data: { name, kind } }));
});

router.patch('/categories/:id', async (req: Request, res: Response) => {
  const data: any = {};
  if (req.body.name !== undefined) data.name = String(req.body.name).trim();
  if (req.body.isActive !== undefined) data.isActive = !!req.body.isActive;
  res.json(await prisma.expenseCategory.update({ where: { id: req.params.id }, data }));
});

// گزارش هزینه/درآمد عمومی به تفکیک سرفصل
router.get('/reports/categories', async (req: Request, res: Response) => {
  const { from, to } = req.query as Record<string, string>;
  const where: any = { categoryId: { not: null }, status: { not: 'REVERSED' } };
  if (from || to) {
    where.date = {};
    if (from) where.date.gte = new Date(from);
    if (to) { const t = new Date(to); t.setHours(23, 59, 59, 999); where.date.lte = t; }
  }
  const entries = await prisma.journalEntry.findMany({
    where,
    include: { category: true, lines: true },
  });

  const byCat: Record<string, { id: string; name: string; kind: string; totalIRR: number; count: number }> = {};
  for (const e of entries) {
    if (!e.category) continue;
    if (!byCat[e.category.id]) {
      byCat[e.category.id] = { id: e.category.id, name: e.category.name, kind: e.category.kind, totalIRR: 0, count: 0 };
    }
    // اندازهٔ سند = مجموع سمت بدهکار به تومان (هر سند تراز است پس یک سمت کافی است)
    const sizeIRR = e.lines.reduce((s, l) => s + Number(l.debit) * Number(l.rateToIRR), 0);
    byCat[e.category.id].totalIRR += sizeIRR;
    byCat[e.category.id].count += 1;
  }
  res.json(Object.values(byCat).sort((a, b) => b.totalIRR - a.totalIRR));
});

// ════════════════════════════════════════════════
// گزارش ریسک ارزی — نرخ زمان تعهد vs تسویه vs لحظه‌ای
// ════════════════════════════════════════════════
router.get('/reports/fx-risk', async (_req: Request, res: Response) => {
  const rates = await getRates();
  const lines = await prisma.journalLine.findMany({
    where: {
      currency: { in: ['USD', 'CNY'] },
      account: { ownerType: { in: ['CUSTOMER', 'PRODUCER'] }, controlKind: null },
      entry: { projectId: { not: null } },
    },
    include: {
      account: { select: { ownerType: true } },
      entry: { select: { projectId: true, eventType: true, project: { select: { code: true, customer: { select: { name: true } } } } } },
    },
  });

  type Agg = { booked: number; bookedIRR: number; settled: number; settledIRR: number };
  const map: Record<string, { code: string; customer: string; side: string; currency: string } & Agg> = {};

  for (const l of lines) {
    const side = l.account.ownerType as 'CUSTOMER' | 'PRODUCER';
    const key = `${l.entry.projectId}_${side}_${l.currency}`;
    if (!map[key]) {
      map[key] = {
        code: l.entry.project?.code || '', customer: l.entry.project?.customer?.name || '',
        side, currency: l.currency, booked: 0, bookedIRR: 0, settled: 0, settledIRR: 0,
      };
    }
    const d = Number(l.debit), c = Number(l.credit), r = Number(l.rateToIRR);
    if (side === 'CUSTOMER') {
      // بدهکار = ایجاد طلب (تعهد) — بستانکار = دریافت (تسویه)
      map[key].booked += d; map[key].bookedIRR += d * r;
      map[key].settled += c; map[key].settledIRR += c * r;
    } else {
      // بستانکار = ایجاد بدهی (تعهد) — بدهکار = پرداخت (تسویه)
      map[key].booked += c; map[key].bookedIRR += c * r;
      map[key].settled += d; map[key].settledIRR += d * r;
    }
  }

  const rows = Object.values(map).map((m) => {
    const bookedAvg = m.booked ? m.bookedIRR / m.booked : 0;
    const settledAvg = m.settled ? m.settledIRR / m.settled : 0;
    const matched = Math.min(m.booked, m.settled);
    const open = Math.max(0, m.booked - m.settled);
    const current = m.currency === 'USD' ? rates.USD_TO_IRR : rates.CNY_TO_IRR;
    // اثر بر سود (تومان): مشتری دیرتر و گران‌تر بدهد = سود؛ سازنده دیرتر و گران‌تر بگیرد = زیان
    const dir = m.side === 'CUSTOMER' ? 1 : -1;
    const realizedIRR = Math.round(matched * (settledAvg - bookedAvg) * dir);
    const unrealizedIRR = Math.round(open * (current - bookedAvg) * dir);
    return {
      code: m.code, customer: m.customer, side: m.side, currency: m.currency,
      booked: m.booked, bookedAvgRate: Math.round(bookedAvg),
      settled: m.settled, settledAvgRate: Math.round(settledAvg),
      open, currentRate: Math.round(current),
      realizedIRR, unrealizedIRR,
    };
  }).filter((r) => r.booked > 0 || r.settled > 0);

  rows.sort((a, b) => a.code.localeCompare(b.code));
  res.json({ rates, rows });
});

// ════════════════════════════════════════════════
// پنجره K — فاکتور حمل (سرشکن وزنی + اعتبارسنجی جمع)
// ════════════════════════════════════════════════
router.get('/freight-invoices/:shipmentId/preview', async (req: Request, res: Response) => {
  const shipment = await prisma.mainShipment.findUnique({
    where: { id: req.params.shipmentId },
    include: {
      packages: { include: { package: { include: { items: { include: { order: { include: { project: { include: { customer: true } } } } } } } } } },
      forwardingCargos: { include: { project: { include: { customer: true } } } },
    },
  });
  if (!shipment) throw new AppError(404, 'محموله یافت نشد');

  const projMap: Record<string, { id: string; code: string; customer: string; weight: number }> = {};
  for (const sp of shipment.packages) {
    for (const it of sp.package.items) {
      const proj = it.order.project;
      if (!projMap[proj.id]) projMap[proj.id] = { id: proj.id, code: proj.code, customer: proj.customer.name, weight: 0 };
      const parts = await prisma.part.findMany({
        where: { projectId: proj.id, selectedPrice: it.order.supplierId ? { supplierId: it.order.supplierId } : { producerId: it.order.producerId } },
        select: { quantity: true, weightGrams: true },
      });
      projMap[proj.id].weight += parts.reduce((s, p) => s + (p.quantity || 0) * (Number(p.weightGrams) || 0), 0);
    }
  }
  // بارهای فورواردینگ روی این محموله (وزن kg → گرم برای هم‌مقیاسی با قطعات)
  for (const cargo of shipment.forwardingCargos) {
    const proj = cargo.project;
    if (!projMap[proj.id]) projMap[proj.id] = { id: proj.id, code: proj.code, customer: proj.customer.name, weight: 0 };
    projMap[proj.id].weight += (Number(cargo.weightKg) || 0) * 1000;
  }
  res.json(Object.values(projMap));
});

// ثبت فاکتور حمل — ریز‌هزینه‌های دو‌ارزی (تومان + دلار) + نرخ تبدیل + تسهیم دستی درصدی بین پروژه‌ها (۶.۷/۶.۸)
router.post('/freight-invoices', async (req: Request, res: Response) => {
  const { shipmentId, title, invoiceNo, referenceNo, invoiceDate, exchangeRate, totalWeightKg, notes, costRows, allocations } = req.body;
  if (!shipmentId) throw new AppError(400, 'محموله الزامی است');

  const shipment = await prisma.mainShipment.findUnique({ where: { id: shipmentId } });
  if (!shipment) throw new AppError(404, 'محموله یافت نشد');
  const existing = await prisma.freightInvoice.findUnique({ where: { shipmentId } });
  if (existing) throw new AppError(400, 'برای این محموله قبلاً فاکتور حمل ثبت شده است');

  // ریز‌هزینه‌ها: هر ردیف { description, amountToman, amountUSD }
  const rows = (costRows || [])
    .map((r: any) => ({ description: r.description || '', amountToman: Number(r.amountToman) || 0, amountUSD: Number(r.amountUSD) || 0 }))
    .filter((r: any) => r.amountToman > 0 || r.amountUSD > 0);
  if (!rows.length) throw new AppError(400, 'حداقل یک ردیف هزینه (تومان یا دلار) لازم است');

  const totalToman = rows.reduce((s: number, r: any) => s + r.amountToman, 0);
  const totalUSD = rows.reduce((s: number, r: any) => s + r.amountUSD, 0);
  const rate = Number(exchangeRate) > 0 ? Number(exchangeRate) : await rateFor('USD' as Currency);

  // وزن هر پروژه در این محموله (سرشکن بر اساس وزن)
  const shipmentFull = await prisma.mainShipment.findUnique({
    where: { id: shipmentId },
    include: {
      packages: { include: { package: { include: { items: { include: { order: true } } } } } },
      forwardingCargos: true,
    },
  });
  const projWeight: Record<string, number> = {};
  for (const sp of shipmentFull!.packages) {
    for (const it of sp.package.items) {
      const parts = await prisma.part.findMany({
        where: { projectId: it.order.projectId, selectedPrice: it.order.supplierId ? { supplierId: it.order.supplierId } : { producerId: it.order.producerId } },
        select: { quantity: true, weightGrams: true },
      });
      const w = parts.reduce((s, p) => s + (p.quantity || 0) * (Number(p.weightGrams) || 0), 0);
      projWeight[it.order.projectId] = (projWeight[it.order.projectId] || 0) + w;
    }
  }
  // بارهای فورواردینگ روی این محموله (وزن kg → گرم)
  for (const cargo of shipmentFull!.forwardingCargos) {
    projWeight[cargo.projectId] = (projWeight[cargo.projectId] || 0) + (Number(cargo.weightKg) || 0) * 1000;
  }
  const projIds = Object.keys(projWeight);
  if (!projIds.length) throw new AppError(400, 'پروژه‌ای در این محموله یافت نشد');
  const totalWeight = Object.values(projWeight).reduce((s, w) => s + w, 0);
  const grandTomanEquiv = Math.round(totalToman + totalUSD * rate);

  // ۶.۸ — تسهیم دستی درصدی؛ اگر allocations داده نشود، پیش‌فرض بر اساس وزن
  const projShare: Record<string, number> = {};
  if (Array.isArray(allocations) && allocations.length) {
    const totalPct = allocations.reduce((s: number, a: any) => s + (Number(a.percentage) || 0), 0);
    if (Math.abs(totalPct - 100) > 0.5) throw new AppError(400, `مجموع درصدهای تسهیم باید ۱۰۰ باشد (اکنون ${Math.round(totalPct)}٪)`);
    for (const a of allocations) if (a.projectId) projShare[a.projectId] = (Number(a.percentage) || 0) / 100;
    for (const pid of projIds) if (projShare[pid] === undefined) projShare[pid] = 0;
  } else {
    for (const pid of projIds) projShare[pid] = totalWeight > 0 ? projWeight[pid] / totalWeight : 1 / projIds.length;
  }

  await prisma.$transaction(async (tx) => {
    await tx.freightInvoice.create({
      data: {
        shipmentId, invoiceNo, invoiceDate: invoiceDate ? new Date(invoiceDate) : undefined,
        totalAmount: grandTomanEquiv, totalCurrency: 'IRR', totalRateToIRR: 1, totalRateAt: new Date(),
        costBreakdown: { title: title || null, referenceNo: referenceNo || null, totalWeightKg: Number(totalWeightKg) || null, notes: notes || null, exchangeRate: rate, costs: rows, totalToman, totalUSD, allocations: allocations || null } as any,
        registeredById: req.user!.id,
      },
    });

    // کیف پول و کنترل به تفکیک ارز
    if (writeLegacy()) {
      const carrierIRR = await getOrCreateWallet(tx, 'CARRIER', shipment.shippingCompanyId, 'IRR');
      const carrierUSD = await getOrCreateWallet(tx, 'CARRIER', shipment.shippingCompanyId, 'USD');
      const freightIRR = await getOrCreateControl(tx, 'FREIGHT', 'IRR');
      const freightUSD = await getOrCreateControl(tx, 'FREIGHT', 'USD');

      for (const pid of projIds) {
        const prop = projShare[pid] || 0;
        if (prop <= 0) continue;
        const shareToman = Math.round(prop * totalToman);
        const shareUSD = Math.round(prop * totalUSD * 100) / 100;
        const lines: any[] = [];
        if (shareToman > 0) {
          lines.push({ accountId: freightIRR.id, debit: shareToman, currency: 'IRR', rateToIRR: 1, memo: 'هزینه حمل (تومان)' });
          lines.push({ accountId: carrierIRR.id, credit: shareToman, currency: 'IRR', rateToIRR: 1, memo: 'بدهی حمل (تومان)' });
        }
        if (shareUSD > 0) {
          lines.push({ accountId: freightUSD.id, debit: shareUSD, currency: 'USD', rateToIRR: rate, memo: 'هزینه حمل (دلار)' });
          lines.push({ accountId: carrierUSD.id, credit: shareUSD, currency: 'USD', rateToIRR: rate, memo: 'بدهی حمل (دلار)' });
        }
        if (lines.length >= 2) {
          await postJournal(tx, {
            description: `فاکتور حمل ${invoiceNo || shipment.code} — سهم پروژه`,
            eventType: 'FREIGHT_INVOICE', sourceType: 'Shipment', sourceId: shipmentId, projectId: pid, createdById: req.user!.id,
            lines,
          });
        }
      }
    }

    await pwFreightInvoice(tx, shipmentId, req.user!.id);   // حالت 'new': داخل همین تراکنش
    await tx.mainShipment.update({ where: { id: shipmentId }, data: { freightInvoiceRegistered: true } });
  });

  // سایهٔ 'dual' (در حالت 'new' بی‌اثر)
  await dwFreightInvoice(shipmentId, req.user!.id);

  res.json({ ok: true });
});

// ════════════════════════════════════════════════
// خروجی‌های اکسل (CSV با BOM برای نمایش صحیح فارسی)
// ════════════════════════════════════════════════
const csv = toCsv;

router.get('/export/ledger/:ownerType', async (req: Request, res: Response) => {
  const ownerType = req.params.ownerType;
  const accounts = await prisma.financialAccount.findMany({
    where: { ownerType, controlKind: null },
    include: { customer: true, producer: true, shippingCompany: true, exchange: true, commissionAgent: true },
  });
  const grouped: Record<string, any> = {};
  for (const acc of accounts) {
    const owner = acc.customer || acc.producer || acc.shippingCompany || acc.exchange || acc.commissionAgent;
    const key = acc.ownerId || 'unknown';
    if (!grouped[key]) grouped[key] = { name: (owner as any)?.name || '—', IRR: 0, USD: 0, CNY: 0 };
    const side = normalSide(acc);
    grouped[key][acc.currency] = side === 'DEBIT' ? Number(acc.balance) : -Number(acc.balance);
  }
  const rows: (string | number)[][] = [['نام طرف حساب', 'مانده تومان', 'مانده دلار', 'مانده یوآن']];
  Object.values(grouped).forEach((g: any) => rows.push([g.name, g.IRR, g.USD, g.CNY]));
  sendCsv(res, `ledger-${ownerType}.csv`, csv(rows));
});

router.get('/export/ledger/:ownerType/:ownerId', async (req: Request, res: Response) => {
  const { ownerType, ownerId } = req.params;
  const accounts = await prisma.financialAccount.findMany({ where: { ownerType, ownerId } });
  const ids = accounts.map((a) => a.id);
  const lines = await prisma.journalLine.findMany({
    where: { accountId: { in: ids } },
    include: { entry: { include: { project: { select: { code: true } } } } },
    orderBy: { entry: { date: 'desc' } },
  });
  const rows: (string | number)[][] = [['تاریخ', 'شماره سند', 'شرح', 'پروژه', 'بدهکار', 'بستانکار', 'ارز']];
  lines.forEach((l) => rows.push([
    new Date(l.entry.date).toLocaleDateString('fa-IR'),
    (l.entry as any).entryNo ?? '',
    l.entry.description || '',
    l.entry.project?.code || '',
    Number(l.debit), Number(l.credit), CUR_LABEL[l.currency] || l.currency,
  ]));
  sendCsv(res, `ledger-${ownerType}-${ownerId}.csv`, csv(rows));
});

router.get('/export/statement/:accountId', async (req: Request, res: Response) => {
  const acc = await prisma.financialAccount.findUnique({ where: { id: req.params.accountId } });
  if (!acc) throw new AppError(404, 'حساب یافت نشد');
  const lines = await prisma.journalLine.findMany({
    where: { accountId: acc.id },
    include: { entry: { include: { project: { select: { code: true } } } } },
    orderBy: { entry: { date: 'asc' } },
  });
  let running = 0;
  const side = normalSide(acc);
  const rows: (string | number)[][] = [['تاریخ', 'شماره سند', 'شرح', 'پروژه', 'بدهکار', 'بستانکار', 'مانده']];
  for (const l of lines) {
    running += Number(l.debit) - Number(l.credit);
    rows.push([
      new Date(l.entry.date).toLocaleDateString('fa-IR'),
      (l.entry as any).entryNo ?? '',
      l.entry.description || '',
      l.entry.project?.code || '',
      Number(l.debit), Number(l.credit),
      side === 'DEBIT' ? running : -running,
    ]);
  }
  sendCsv(res, `statement-${acc.name}.csv`, csv(rows));
});

router.get('/export/journal', async (_req: Request, res: Response) => {
  const entries = await prisma.journalEntry.findMany({
    include: { project: { select: { code: true } }, lines: { include: { account: { select: { name: true } } } } },
    orderBy: { date: 'desc' }, take: 2000,
  });
  const rows: (string | number)[][] = [['تاریخ', 'شماره سند', 'شرح', 'رویداد', 'پروژه', 'حساب', 'بدهکار', 'بستانکار', 'ارز']];
  for (const e of entries) {
    for (const l of e.lines) {
      rows.push([
        new Date(e.date).toLocaleDateString('fa-IR'), (e as any).entryNo ?? '', e.description || '', e.eventType || '',
        e.project?.code || '', l.account.name, Number(l.debit), Number(l.credit), CUR_LABEL[l.currency] || l.currency,
      ]);
    }
  }
  sendCsv(res, 'journal.csv', csv(rows));
});

export default router;
