/**
 * مسیرهای HTTP هستهٔ جدید دفترداری.
 *
 * جدا از `accounting.routes.ts` است و با آن تداخل ندارد — هستهٔ قدیمی تا پایان
 * مهاجرت سر جایش کار می‌کند.
 *
 * ⚠️ **سریال‌سازی BigInt:** همهٔ مبالغ هسته `BigInt` اند و `JSON.stringify` روی
 * BigInt خطا می‌دهد. `send()` این پرونده هر BigInt را به **رشته** تبدیل می‌کند،
 * نه به `Number` — چون مبالغ ریالی از محدودهٔ امن `Number` بیرون می‌زنند و
 * تبدیل به عدد، دقیقاً همان گم‌شدن ریالی است که کل این بازنویسی برای رفعش بود.
 */
import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { authenticate, requireRole } from '../../shared/middleware/auth';
import { AppError } from '../../shared/middleware/errorHandler';
import { upload } from '../../shared/middleware/upload';
import { registerDocumentRoutes } from './document.routes';
import { storeReceipt } from '../../shared/utils/receipts';
import { getRates } from '../../shared/utils/rates';
import { Prisma } from '@prisma/client';

import { post, reverse, createDraft, updateDraft, discardDraft, postDraft, LedgerError } from './poster';
import { parseAmount, formatAmount, rateFrom } from './money';
import { ensureChart } from './chart';
import { createAccount, loadLevels } from './codes';
import {
  ensureSubsidiary, createStandalone, backfillSubsidiaries,
  subsidiaryPositions, subsidiaryLedger, SubsidiaryError,
} from './subsidiary';
import {
  receiveCheque, issueCheque, transitionCheque, overdueCheques, ChequeError, ALLOWED,
} from './cheque';
import {
  createFund, fundBalance, allocate, recordExpense, replenish, settle, PettyCashError,
} from './pettycash';
import { setRate, setTaxBrackets, RATE_KEYS, OPTIONAL_RATE_KEYS, PayrollRateError } from './payroll/rates';
import { buildRun, finalizeRun, PayrollError, PayrollInputRow } from './payroll/run';
import { createEmployee, updateEmployee, reviseRun, ratesSnapshot } from './payroll/admin';
import { payProvision, provisionBalances, ProvisionKind } from './payroll/provisions';
import {
  ensureDefaultCostCenters, createCostCenter, ensureProjectCostCenter, costCenterTotals,
} from './costcenter';
import { integrityCheck } from './integrity';
import { journal, accountLedger, trialBalance, ReportScope } from './reports/ledgers';
import { balanceSheet, incomeStatement, cashFlow, aging, projectProfitability, financialRatios } from './reports/statements';
import { bankReconciliation } from './bank-recon';
import { overview } from './reports/overview';
import { monthlyTrend } from './reports/trend';
import { article169, vatReturn, QUARTERS, PERSON_TYPE_FA, readinessProblems } from './reports/tax';
import { equityStatement, legalReserveSuggestion } from './reports/equity';
// `allocate` تنخواه از قبل هست؛ این یکی صریح نام‌گذاری می‌شود
import {
  allocate as allocatePayment, unallocate, openItems, allocationsOf,
} from './allocation';
// `getRates` حقوق و دستمزد از قبل هست؛ این‌ها صریح نام‌گذاری می‌شوند
import {
  computeProvision, postProvision,
  getRates as getProvisionRates, setRates as setProvisionRates,
} from './provision';
import {
  upsertAsset, disposeAsset, listAssets, schedule, postDepreciation,
} from './depreciation';
import { monthEndChecklist } from './reports/monthend';
import { cutoverPreflight } from './preflight';
import { journalBook, generalLedgerBook, partyStatement } from './reports/statutory';
import { statementNotes, payrollTaxList } from './reports/disclosure';
import { shamsiRange } from './shamsi';
import { compareCores } from './diff';
import { streak } from './diff-history';
import { syncGlRates, backfillGlRatesFromSnapshots } from './fx-sync';
import { previewYearClose, closeFiscalYear, reopenFiscalYear, YearCloseError } from './year-close';
import {
  updateAccount, cleanupMigrationNames, setPeriodLock, removePeriodLock, LOCK_MODULES,
} from './admin';
import { toCsv, sendCsv } from '../../shared/utils/csv';
import { previewRevaluation, postRevaluation, resolveRate, checkRateOutlier, FxError } from './fx';
import {
  doSettlement, doConversion, doTransfer, doExpense, settlementPreview,
} from './ops';
import { buildMigrationPlan, postOpeningEntry, verifyMigration } from './migration/migrate';
import { upsertBudget, deleteBudget, listBudgets, budgetVsActual, MONTHS_IN_YEAR } from './budget';
import { recordGlAudit, readGlAudit, assertChecker, MakerCheckerError, GlAuditAction } from './audit-log';

const router = Router();
router.use(authenticate, requireRole('SUPER_ADMIN', 'MANAGER', 'ACCOUNTANT'));

/** هر BigInt به رشته تبدیل می‌شود — نه Number (بخش بالای فایل را ببینید) */
function toJson(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (Array.isArray(value)) return value.map(toJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  }
  return value;
}
const send = (res: Response, data: unknown) => res.json(toJson(data));

/** ثبتِ ردِ پای عملیات (ممیزی ج۱۶) — بعد از موفقیت، بی‌صدا شکست می‌خورد */
const audit = (
  req: Request,
  action: GlAuditAction,
  summary: string,
  extra: { entryId?: string | null; entrySerial?: number | null; meta?: unknown } = {},
) => recordGlAudit(prisma, {
  actorId: req.user?.id ?? null, actorName: req.user?.name ?? req.user?.username ?? null,
  action, summary, ...extra,
});

const asDate = (v: unknown, fallback?: Date): Date | undefined => {
  if (!v) return fallback;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? fallback : d;
};

/**
 * تاریخِ اجباری — تاریخِ خراب اینجا با خطای فارسی می‌شکند، نه در Prisma.
 *
 * ⚠️ ممیزی دور چهارم (ن۶): مسیر ثبت سند مستقیم `new Date(body.date)` می‌زد.
 * ورودی «not-a-date» به `Invalid Date` تبدیل و تا Prisma می‌رفت، و کاربر
 * یک **۵۰۰ با dump انگلیسیِ خام** می‌گرفت — همان دسته‌ای که ممیزی ن۸ قرار
 * بود حذفش کند.
 */
function requireDate(v: unknown, field = 'تاریخ'): Date {
  const d = asDate(v);
  if (!d) throw new AppError(400, `${field} نامعتبر است — قالب درست: YYYY-MM-DD`);
  return d;
}

/**
 * پرچم بولی از بدنه یا query — **سخت‌گیر** (ممیزی ن۵).
 *
 * پیش از این شرطِ پیش‌نویس `req.query.draft === 'true'` بود، یعنی رشتهٔ دقیق.
 * `?draft=1` بی‌صدا از کنارش رد می‌شد و سند **قطعی** ثبت می‌شد — و چون هسته
 * تغییرناپذیر است، آن سند دیگر پس گرفته نمی‌شد مگر با سند برگشتی.
 *
 * حالا هر شکل متعارفِ «بله» پذیرفته است و مقدارِ ناشناخته **خطا** می‌دهد، نه
 * سکوت. سکوت بدترین گزینه است وقتی نتیجه‌اش سندِ برگشت‌ناپذیر باشد.
 */
const TRUEISH = new Set(['true', '1', 'yes', 'on', '']);
const FALSEISH = new Set(['false', '0', 'no', 'off']);
function asFlag(v: unknown, field: string): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  const t = String(v).trim().toLowerCase();
  if (TRUEISH.has(t)) return true;
  if (FALSEISH.has(t)) return false;
  throw new AppError(400, `مقدار «${v}» برای «${field}» نامعتبر است — true یا false بفرستید`);
}

/** بازهٔ گزارش از query string */
function scopeOf(req: Request): ReportScope {
  const cc = req.query.costCenterIds;
  const pr = req.query.projectIds;
  return {
    from: asDate(req.query.from),
    to: asDate(req.query.to),
    currencyCode: req.query.currencyCode ? String(req.query.currencyCode) : undefined,
    costCenterIds: cc ? String(cc).split(',').filter(Boolean) : undefined,
    // بند ۲۸ ALIP — پروژه بُعد مستقلی است و فیلتر خودش را دارد
    projectIds: pr ? String(pr).split(',').filter(Boolean) : undefined,
  };
}

/** ابتدای سال مالیِ شاملِ یک تاریخ — پیش‌فرضِ بازهٔ صورت‌های مالی */
async function fiscalYearStart(at: Date): Promise<Date> {
  const fy = await prisma.glFiscalYear.findFirst({
    where: { startDate: { lte: at }, endDate: { gte: at } },
  });
  if (fy) return fy.startDate;
  // بیرون از هر سال مالی: از ابتدای تازه‌ترین سالی که شروع شده
  const last = await prisma.glFiscalYear.findFirst({
    where: { startDate: { lte: at } }, orderBy: { startDate: 'desc' },
  });
  if (!last) throw new AppError(404, 'سال مالی تعریف نشده است');
  return last.startDate;
}

/** سال مالی فعال — اگر نبود، خطای روشن */
async function activeFiscalYear(dateHint?: Date) {
  const at = dateHint ?? new Date();
  const fy = await prisma.glFiscalYear.findFirst({
    where: { startDate: { lte: at }, endDate: { gte: at }, closedAt: null },
  });
  if (!fy) {
    throw new AppError(400, `برای تاریخ ${at.toISOString().slice(0, 10)} سال مالی باز تعریف نشده است`);
  }
  return fy;
}

// ═══════════════════════════════════════════════════════════════
// راه‌اندازی
// ═══════════════════════════════════════════════════════════════

/** وضعیت هسته — صفحهٔ UI با همین تصمیم می‌گیرد چه نشان دهد */
router.get('/status', async (_req: Request, res: Response) => {
  const [accounts, entries, fiscalYears, currencies, subsidiaries] = await Promise.all([
    prisma.glAccount.count(),
    prisma.glEntry.count(),
    prisma.glFiscalYear.findMany({ orderBy: { startDate: 'desc' } }),
    prisma.glCurrency.findMany({ orderBy: { sortIndex: 'asc' } }),
    prisma.glSubsidiary.count(),
  ]);
  send(res, {
    ready: accounts > 0 && fiscalYears.length > 0,
    accounts, entries, subsidiaries, currencies, fiscalYears,
  });
});

/** ساخت چارت و مراکز هزینهٔ پیش‌فرض — idempotent */
router.post('/setup', async (_req: Request, res: Response) => {
  await prisma.$transaction(async (tx) => {
    await ensureChart(tx);
    await ensureDefaultCostCenters(tx);
  }, { timeout: 120_000 });
  send(res, { ok: true });
});

router.get('/fiscal-years', async (_req: Request, res: Response) => {
  const years = await prisma.glFiscalYear.findMany({
    orderBy: { startDate: 'desc' },
    include: { _count: { select: { entries: true } }, counter: { select: { next: true } } },
  });
  send(res, years.map((y) => ({
    id: y.id, title: y.title, startDate: y.startDate, endDate: y.endDate, closedAt: y.closedAt,
    entryCount: y._count.entries, nextSerial: y.counter?.next ?? 1,
  })));
});

router.post('/fiscal-years', async (req: Request, res: Response) => {
  const { title, startDate, endDate } = req.body;
  if (!title || !startDate || !endDate) throw new AppError(400, 'عنوان و بازهٔ سال مالی لازم است');
  const fy = await prisma.$transaction(async (tx) => {
    const created = await tx.glFiscalYear.create({
      data: { title, startDate: new Date(startDate), endDate: new Date(endDate) },
    });
    await tx.glSerialCounter.create({ data: { fiscalYearId: created.id, next: 1 } });
    return created;
  });
  send(res, fy);
});

// ── بستن سال مالی (ممیزی ب۲) ──
async function runYearClose<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e instanceof YearCloseError || e instanceof LedgerError) throw new AppError(400, e.message);
    throw e;
  }
}

router.get('/fiscal-years/:id/close/preview', async (req: Request, res: Response) => {
  send(res, await runYearClose(() => previewYearClose(prisma, req.params.id)));
});

router.post('/fiscal-years/:id/close', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  // ممیزی ن۱: سند افتتاحیهٔ سال بعد دیگر ثبت نمی‌شود (دلیلش در year-close.ts).
  // درخواستی که هنوز `nextFiscalYearId` می‌فرستد صریحاً رد می‌شود، نه بی‌صدا
  // نادیده گرفته — وگرنه فراخوان ۲۰۰ می‌گیرد و فکر می‌کند افتتاحیه ساخته شده.
  if (req.body?.nextFiscalYearId) {
    throw new AppError(400,
      'سند افتتاحیهٔ سال بعد دیگر ثبت نمی‌شود؛ ماندهٔ حساب‌های دائمی خودبه‌خود ' +
      'منتقل می‌شود. درخواست را بدون «nextFiscalYearId» بفرستید.');
  }
  const result = await runYearClose(() => prisma.$transaction(
    (tx) => closeFiscalYear(tx, {
      fiscalYearId: req.params.id,
      // ممیزی ب۸: بستن با کارِ ناتمام فقط با تأیید صریح کاربر
      acknowledgeChecklist: asFlag(req.body?.acknowledgeChecklist, 'acknowledgeChecklist'),
      createdById: req.user!.id,
    }),
    { timeout: 120_000 },
  ));
  await audit(req, 'YEAR_CLOSE', `بستنِ سال مالی`, { meta: { fiscalYearId: req.params.id } });
  send(res, result);
});

router.post('/fiscal-years/:id/reopen', requireRole('SUPER_ADMIN'), async (req: Request, res: Response) => {
  const result = await runYearClose(() => prisma.$transaction(
    (tx) => reopenFiscalYear(tx, {
      fiscalYearId: req.params.id, reason: req.body?.reason, createdById: req.user!.id,
    }),
    { timeout: 120_000 },
  ));
  await audit(req, 'YEAR_REOPEN', `بازگشاییِ سال مالی: ${req.body?.reason || '—'}`,
    { meta: { fiscalYearId: req.params.id } });
  send(res, result);
});

/** ردِ پای عملیاتِ دفترداری (ممیزی ج۱۶) */
router.get('/audit', async (req: Request, res: Response) => {
  send(res, await readGlAudit(prisma, {
    action: req.query.action ? String(req.query.action) : undefined,
    entryId: req.query.entryId ? String(req.query.entryId) : undefined,
    actorId: req.query.actorId ? String(req.query.actorId) : undefined,
    from: asDate(req.query.from), to: asDate(req.query.to),
    take: req.query.take ? Number(req.query.take) : undefined,
    skip: req.query.skip ? Number(req.query.skip) : undefined,
  }));
});

// ── قفل دوره ──
router.get('/period-locks', async (_req: Request, res: Response) => {
  send(res, {
    locks: await prisma.glPeriodLock.findMany({ orderBy: { module: 'asc' } }),
    modules: LOCK_MODULES,
  });
});

router.post('/period-locks', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const lockToDate = asDate(req.body?.lockToDate);
  if (!lockToDate) throw new AppError(400, 'تاریخ قفل لازم است');
  const lock = await prisma.$transaction((tx) => setPeriodLock(tx, {
    module: req.body?.module, lockToDate, reason: req.body?.reason,
  }));
  await audit(req, 'PERIOD_LOCK', `قفل دوره تا ${lockToDate.toISOString().slice(0, 10)} (${req.body?.module || 'همه'})`,
    { meta: { module: req.body?.module ?? null, lockToDate: lockToDate.toISOString().slice(0, 10) } });
  send(res, lock);
});

router.delete('/period-locks/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const r = await prisma.$transaction((tx) => removePeriodLock(tx, req.params.id));
  await audit(req, 'PERIOD_UNLOCK', 'حذف قفل دوره', { meta: { lockId: req.params.id } });
  send(res, r);
});

router.post('/subsidiaries/backfill', async (_req: Request, res: Response) => {
  const result = await prisma.$transaction((tx) => backfillSubsidiaries(tx), { timeout: 120_000 });
  send(res, result);
});

// ═══════════════════════════════════════════════════════════════
// چارت حساب‌ها
// ═══════════════════════════════════════════════════════════════

router.get('/accounts', async (_req: Request, res: Response) => {
  const [accounts, levels] = await Promise.all([
    prisma.glAccount.findMany({ orderBy: { code: 'asc' } }),
    prisma.glCodeLevel.findMany({ orderBy: { level: 'asc' } }),
  ]);
  send(res, { accounts, levels });
});

router.post('/accounts', async (req: Request, res: Response) => {
  const created = await prisma.$transaction((tx) => createAccount(tx, req.body));
  send(res, created);
});

router.patch('/accounts/:id', async (req: Request, res: Response) => {
  const updated = await prisma.$transaction((tx) => updateAccount(tx, req.params.id, req.body));
  send(res, updated);
});

router.post('/accounts/cleanup-names', requireRole('SUPER_ADMIN', 'MANAGER'), async (_req: Request, res: Response) => {
  send(res, await prisma.$transaction((tx) => cleanupMigrationNames(tx)));
});

// ═══════════════════════════════════════════════════════════════
// تفصیلی و مراکز هزینه
// ═══════════════════════════════════════════════════════════════

router.get('/subsidiaries', async (req: Request, res: Response) => {
  const kind = req.query.kind ? String(req.query.kind) : undefined;
  const rows = await prisma.glSubsidiary.findMany({
    where: { isActive: true, ...(kind ? { kind: kind as any } : {}) },
    orderBy: { code: 'asc' },
  });
  send(res, rows);
});

router.post('/subsidiaries', async (req: Request, res: Response) => {
  const { kind, name } = req.body;
  if (!kind || !name) throw new AppError(400, 'نوع و نام تفصیلی لازم است');
  const created = await prisma.$transaction((tx) => createStandalone(tx, kind, name));
  send(res, created);
});

/** پروندهٔ طرف‌حساب با آدرس مستقیم باز می‌شود، پس باید از روی id هم قابل خواندن باشد (ج۱) */
router.get('/subsidiaries/:id', async (req: Request, res: Response) => {
  const row = await prisma.glSubsidiary.findUnique({ where: { id: req.params.id } });
  if (!row) throw new AppError(404, 'طرف‌حساب یافت نشد');
  send(res, row);
});

/**
 * هویت مالیاتی طرف‌حساب (ماده ۱۶۹).
 *
 * رشتهٔ خالی به `null` تبدیل می‌شود نه ذخیره: `''` در پایگاه داده یعنی
 * «ثبت شده ولی خالی» و گزارشِ آمادگی را فریب می‌دهد.
 */
router.patch('/subsidiaries/:id/tax', async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const str = (v: unknown) => {
    const t = typeof v === 'string' ? v.trim() : '';
    return t === '' ? null : t;
  };
  const TYPES = Object.keys(PERSON_TYPE_FA);
  const personType = str(b.taxPersonType);
  if (personType && !TYPES.includes(personType)) {
    throw new AppError(400, `نوع شخص نامعتبر است — یکی از: ${TYPES.join('، ')}`);
  }
  // ارقام فارسی/عربی به لاتین، تا کاربر مجبور نباشد صفحه‌کلید عوض کند
  const digits = (v: string | null) =>
    v == null ? null : v.replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
                        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
                        .replace(/[^0-9]/g, '');

  const nationalId = digits(str(b.nationalId));
  const economicCode = digits(str(b.economicCode));

  const updated = await prisma.glSubsidiary.update({
    where: { id: req.params.id },
    data: {
      taxPersonType: (personType as any) ?? null,
      nationalId: nationalId || null,
      economicCode: economicCode || null,
      taxAddress: str(b.taxAddress),
      postalCode: digits(str(b.postalCode)),
    },
  });
  await audit(req, 'TAX_IDENTITY_SET',
    `هویت مالیاتی «${updated.name}» ثبت شد`,
    { meta: { subsidiaryId: updated.id, taxPersonType: updated.taxPersonType } });
  send(res, { ...updated, problems: readinessProblems(updated) });
});

router.get('/subsidiaries/:id/positions', async (req: Request, res: Response) => {
  send(res, await subsidiaryPositions(prisma, req.params.id, asDate(req.query.asOf)));
});

router.get('/subsidiary-ledger/:code', async (req: Request, res: Response) => {
  send(res, await subsidiaryLedger(prisma, req.params.code, asDate(req.query.asOf)));
});

router.get('/cost-centers', async (_req: Request, res: Response) => {
  send(res, await prisma.glCostCenter.findMany({ orderBy: { code: 'asc' } }));
});

router.post('/cost-centers', async (req: Request, res: Response) => {
  const created = await prisma.$transaction((tx) => createCostCenter(tx, req.body));
  send(res, created);
});

router.post('/cost-centers/for-project/:projectId', async (req: Request, res: Response) => {
  const cc = await prisma.$transaction((tx) => ensureProjectCostCenter(tx, req.params.projectId));
  send(res, cc);
});

// ═══════════════════════════════════════════════════════════════
// اسناد
// ═══════════════════════════════════════════════════════════════

/** دفتر روزنامه با صفحه‌بندی و فیلتر (ممیزی ب۱۲) */
router.get('/entries', async (req: Request, res: Response) => {
  const take = Math.min(Number(req.query.take) || 50, 200);
  const skip = Number(req.query.skip) || 0;
  const q = req.query.q ? String(req.query.q).trim() : '';
  const serial = req.query.serial ? Number(req.query.serial) : undefined;
  const accountCode = req.query.accountCode ? String(req.query.accountCode) : undefined;
  const subsidiaryId = req.query.subsidiaryId ? String(req.query.subsidiaryId) : undefined;
  const status = req.query.status ? String(req.query.status) : undefined;

  // مرتب‌سازی (ممیزی سوم — ج۲). سرور مرتب می‌کند نه مرورگر، چون فهرست
  // صفحه‌بندی‌شده است: مرتب‌کردنِ ۵۰ ردیفِ همین صفحه، «بزرگ‌ترین سند» را
  // نمی‌دهد، بزرگ‌ترینِ همین صفحه را می‌دهد.
  const dir: Prisma.SortOrder = req.query.dir === 'asc' ? 'asc' : 'desc';
  const SORTS: Record<string, Prisma.GlEntryOrderByWithRelationInput[]> = {
    date:    [{ date: dir }, { serial: dir }, { createdAt: dir }],
    serial:  [{ serial: dir }, { createdAt: dir }],
    created: [{ createdAt: dir }],
  };
  const orderBy = SORTS[String(req.query.sort ?? 'date')] ?? SORTS.date;

  const where: Prisma.GlEntryWhereInput = {
    ...(req.query.from || req.query.to
      ? { date: { ...(req.query.from ? { gte: asDate(req.query.from) } : {}), ...(req.query.to ? { lte: asDate(req.query.to) } : {}) } }
      : {}),
    ...(serial && !Number.isNaN(serial) ? { serial } : {}),
    ...(status ? { status: status as any } : {}),
    ...(q ? { description: { contains: q, mode: 'insensitive' } } : {}),
    ...(accountCode || subsidiaryId
      ? { lines: { some: {
          ...(accountCode ? { account: { code: { startsWith: accountCode } } } : {}),
          ...(subsidiaryId ? { subsidiaryId } : {}),
        } } }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.glEntry.findMany({
      where,
      include: {
        lines: {
          include: {
            account: { select: { code: true, name: true } },
            subsidiary: { select: { code: true, name: true } },
            costCenter: { select: { code: true, name: true } },
          },
          orderBy: { lineNo: 'asc' },
        },
        fiscalYear: { select: { title: true } },
      },
      orderBy,
      take, skip,
    }),
    prisma.glEntry.count({ where }),
  ]);
  send(res, { rows, total, take, skip });
});

/**
 * ثبت سند دستی.
 *
 * مبالغ از فرم به‌صورت **رشته** می‌آیند و با `parseAmount` به کوچک‌ترین واحد
 * تبدیل می‌شوند — نه با `Number()`، که برای مبالغ بزرگ ریالی دقت را می‌بازد.
 */
/** ردیف‌های فرم → DraftLine — مبلغ رشته‌ای، نرخ اختیاری (پیش‌نویس نرخِ ناموجود را تحمل می‌کند) */
async function draftLinesFromBody(
  tx: any, lines: any[], at: Date, currencies: Map<string, number>, tolerateMissingRate: boolean,
) {
  /**
   * ⚠️ ممیزی دور چهارم (ن۶) — شناسهٔ حساب پیش از رسیدن به Prisma سنجیده می‌شود.
   *
   * پیش از این، `accountId` نامعتبر تا درج در دیتابیس می‌رفت و آنجا با نقض
   * کلید خارجی می‌شکست؛ کاربر یک **۵۰۰ با dump انگلیسیِ Prisma** می‌گرفت.
   * یک کوئری برای همهٔ ردیف‌ها، نه یکی به‌ازای هر ردیف.
   */
  const ids = [...new Set(lines.map((l: any) => l?.accountId).filter(Boolean))];
  const known = new Set(
    (await tx.glAccount.findMany({ where: { id: { in: ids } }, select: { id: true } }))
      .map((a: { id: string }) => a.id),
  );

  const out = [];
  for (const [i, l] of lines.entries()) {
    if (!l?.accountId) throw new AppError(400, `ردیف ${i + 1}: حساب انتخاب نشده است`);
    if (!known.has(l.accountId)) throw new AppError(400, `ردیف ${i + 1}: حساب یافت نشد`);
    const decimals = currencies.get(l.currencyCode);
    if (decimals === undefined) throw new AppError(400, `ردیف ${i + 1}: ارز نامعتبر`);
    let rate = l.rate ? rateFrom(String(l.rate)) : undefined;
    // نرخِ نامثبت، سندی می‌سازد که پیام خطایش «سند تراز نیست» است — یعنی
    // کاربر دنبال اشتباهی می‌گردد که نکرده. علت را همین‌جا می‌گوییم.
    if (rate && rate.scaled <= 0n) {
      throw new AppError(400, `ردیف ${i + 1}: نرخ ارز باید بزرگ‌تر از صفر باشد`);
    }
    if (!rate && l.currencyCode !== 'IRR') {
      try { rate = await resolveRate(tx, l.currencyCode, at); }
      catch (e) { if (!tolerateMissingRate) throw e; }
    }
    out.push({
      accountId: l.accountId,
      subsidiaryId: l.subsidiaryId || null,
      costCenterId: l.costCenterId || null,
      currencyCode: l.currencyCode,
      debit: l.debit ? parseAmount(String(l.debit), decimals) : 0n,
      credit: l.credit ? parseAmount(String(l.credit), decimals) : 0n,
      rate,
      memo: l.memo || null,
    });
  }
  return out;
}

router.post('/entries', async (req: Request, res: Response) => {
  const { date, description, lines } = req.body;
  const isDraft = asFlag(req.body?.draft, 'draft') || asFlag(req.query?.draft, 'draft');
  if (!date || !description) throw new AppError(400, 'تاریخ و شرح سند لازم است');
  if (!Array.isArray(lines) || (!isDraft && lines.length < 2)) throw new AppError(400, 'سند حداقل دو ردیف لازم دارد');

  const at = requireDate(date, 'تاریخ سند');
  const fy = await activeFiscalYear(at);
  const currencies = new Map((await prisma.glCurrency.findMany()).map((c) => [c.code, c.decimalPlaces]));

  const entry = await runOp(() => prisma.$transaction(async (tx) => {
    const draft = await draftLinesFromBody(tx, lines, at, currencies, isDraft);
    const args = {
      fiscalYearId: fy.id, date: at, description,
      entryType: req.body.entryType || 'NORMAL',
      sourceType: 'Manual' as const, createdById: req.user!.id, lines: draft,
    };
    return isDraft ? createDraft(tx, args) : post(tx, args);
  }, { timeout: 60_000 }));
  await audit(req, isDraft ? 'DRAFT_CREATE' : 'POST',
    `${isDraft ? 'پیش‌نویس' : 'سند'} دستی: ${description}`,
    { entryId: entry.id, entrySerial: entry.serial, meta: { lineCount: entry.lines.length } });
  send(res, entry);
});

/** ویرایش پیش‌نویس — جایگزینی کامل ردیف‌ها */
router.patch('/entries/:id', async (req: Request, res: Response) => {
  const { date, description, lines } = req.body;
  if (!date || !description || !Array.isArray(lines)) throw new AppError(400, 'تاریخ، شرح و ردیف‌ها لازم است');
  const at = requireDate(date, 'تاریخ سند');
  const currencies = new Map((await prisma.glCurrency.findMany()).map((c) => [c.code, c.decimalPlaces]));
  const entry = await runOp(() => prisma.$transaction(async (tx) => {
    const draft = await draftLinesFromBody(tx, lines, at, currencies, true);
    return updateDraft(tx, req.params.id, { date: at, description, entryType: req.body.entryType, lines: draft });
  }, { timeout: 60_000 }));
  await audit(req, 'DRAFT_UPDATE', `ویرایش پیش‌نویس: ${description}`, { entryId: entry.id });
  send(res, entry);
});

/** نهایی‌کردن پیش‌نویس — با تفکیک وظایف اختیاری (ممیزی ج۱۶) */
router.post('/entries/:id/post', async (req: Request, res: Response) => {
  const draft = await prisma.glEntry.findUnique({ where: { id: req.params.id }, select: { createdById: true } });
  try {
    assertChecker(draft?.createdById, req.user!.id);
  } catch (e) {
    if (e instanceof MakerCheckerError) throw new AppError(403, e.message);
    throw e;
  }
  const entry = await runOp(() => prisma.$transaction(
    (tx) => postDraft(tx, req.params.id, { createdById: req.user!.id }), { timeout: 60_000 },
  ));
  await audit(req, 'DRAFT_POST', `نهایی‌کردن پیش‌نویس: ${entry.description}`,
    { entryId: entry.id, entrySerial: entry.serial });
  send(res, entry);
});

/** حذف پیش‌نویس */
router.delete('/entries/:id', async (req: Request, res: Response) => {
  const r = await runOp(() => prisma.$transaction((tx) => discardDraft(tx, req.params.id), { timeout: 30_000 }));
  await audit(req, 'DRAFT_DISCARD', 'حذف پیش‌نویس', { entryId: req.params.id });
  send(res, r);
});

router.post('/entries/:id/reverse', async (req: Request, res: Response) => {
  const reason = req.body?.reason || 'ابطال';
  const entry = await runOp(() => prisma.$transaction(
    (tx) => reverse(tx, req.params.id, { reason, createdById: req.user!.id }),
    { timeout: 60_000 },
  ));
  await audit(req, 'REVERSE', `ابطال سند: ${reason}`,
    { entryId: entry.id, entrySerial: entry.serial, meta: { reversesId: req.params.id } });
  send(res, entry);
});

// ═══════════════════════════════════════════════════════════════
// دفاتر و گزارش‌ها
// ═══════════════════════════════════════════════════════════════

router.get('/overview', async (_req: Request, res: Response) => {
  send(res, await overview(prisma));
});

const journalFilterOf = (req: Request) => ({
  ...scopeOf(req),
  q: req.query.q ? String(req.query.q).trim() : undefined,
  serial: req.query.serial ? Number(req.query.serial) : undefined,
  accountCode: req.query.accountCode ? String(req.query.accountCode) : undefined,
});

/** روند ماهانهٔ داشبورد — پیش‌فرض روی سال مالیِ باز (ب۱۵) */
router.get('/reports/trend', async (req: Request, res: Response) => {
  const fyId = req.query.fiscalYearId ? String(req.query.fiscalYearId) : null;
  const now = new Date();
  // سالی که **امروز داخلش است**، نه تازه‌ترین سالِ باز.
  //
  // نسخهٔ اول `orderBy: startDate desc` بود و روی staging سال ۱۴۰۶ را انتخاب
  // کرد — سالی که هنوز شروع نشده و صفر سند دارد — درحالی‌که امروز وسط ۱۴۰۵
  // است. داشبورد خالی نشان می‌داد. سال آینده معمولاً از قبل تعریف می‌شود، پس
  // این حالت استثنا نیست، قاعده است.
  const fy = fyId
    ? await prisma.glFiscalYear.findUnique({ where: { id: fyId } })
    : await prisma.glFiscalYear.findFirst({
        where: { startDate: { lte: now }, endDate: { gte: now }, closedAt: null },
      })
      // امروز در هیچ سال بازی نیست (پیش از اولین سال یا پس از آخرین) ⇒
      // تازه‌ترین سالی که واقعاً شروع شده
      ?? await prisma.glFiscalYear.findFirst({
        where: { startDate: { lte: now } }, orderBy: { startDate: 'desc' },
      })
      ?? await prisma.glFiscalYear.findFirst({ orderBy: { startDate: 'asc' } });
  if (!fy) throw new AppError(404, 'سال مالی تعریف نشده است');
  send(res, await monthlyTrend(prisma, fy.id));
});

/** صورت تغییرات حقوق صاحبان سهام — چهارمین صورت مالیِ اساسی (مرحلهٔ ۴ ب) */
router.get('/reports/equity', async (req: Request, res: Response) => {
  const to = asDate(req.query.to, new Date())!;
  const from = asDate(req.query.from) ?? (await fiscalYearStart(to));
  send(res, await equityStatement(prisma, { from, to }));
});

/** پیشنهاد اندوختهٔ قانونی — مادهٔ ۱۴۰ ق.ت. فقط محاسبه، بدون سند */
router.get('/reports/legal-reserve', async (req: Request, res: Response) => {
  const to = asDate(req.query.to, new Date())!;
  const from = asDate(req.query.from) ?? (await fiscalYearStart(to));
  send(res, await legalReserveSuggestion(prisma, { from, to }));
});

// ═══════════════════════════════════════════════════════════════
// یادداشت‌های صورت‌های مالی و فهرست مالیات حقوق (مرحلهٔ ۵ ب)
// ═══════════════════════════════════════════════════════════════

router.get('/notes', async (req: Request, res: Response) => {
  const asOf = asDate(req.query.asOf, new Date())!;
  const from = asDate(req.query.from) ?? (await fiscalYearStart(asOf));
  send(res, await statementNotes(prisma, { asOf, from }));
});

router.get('/notes/written', async (_req: Request, res: Response) => {
  send(res, await prisma.glDisclosureNote.findMany({
    orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
  }));
});

router.post('/notes/written', async (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.title || !b.body) throw new AppError(400, 'عنوان و متن یادداشت لازم است');
  const data = {
    noteKey: b.noteKey ? String(b.noteKey) : null,
    title: String(b.title).trim(),
    body: String(b.body).trim(),
    sortIndex: Number.isFinite(Number(b.sortIndex)) ? Number(b.sortIndex) : 0,
    validFrom: asDate(b.validFrom) ?? null,
    validTo: asDate(b.validTo) ?? null,
    createdById: req.user?.id ?? null,
  };
  const saved = b.id
    ? await prisma.glDisclosureNote.update({ where: { id: String(b.id) }, data })
    : await prisma.glDisclosureNote.create({ data });
  await audit(req, 'NOTE_SET', `یادداشت «${saved.title}»`, { meta: { id: saved.id } });
  send(res, saved);
});

router.delete('/notes/written/:id', async (req: Request, res: Response) => {
  const row = await prisma.glDisclosureNote.delete({ where: { id: req.params.id } });
  await audit(req, 'NOTE_DELETE', `حذف یادداشت «${row.title}»`, { meta: { id: row.id } });
  send(res, { ok: true });
});

router.get('/payroll-tax-list', async (req: Request, res: Response) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new AppError(400, 'سال و ماه شمسی لازم است (ماه بین ۱ تا ۱۲)');
  }
  send(res, await payrollTaxList(prisma, { year, month }));
});

/**
 * خروجی فهرست مالیات حقوق.
 *
 * ردیفِ ناقص حذف نمی‌شود — با ستون وضعیت می‌آید، وگرنه حسابدار جمعِ کمتری
 * می‌بیند و نمی‌فهمد چرا.
 */
router.get('/export/payroll-tax-list', async (req: Request, res: Response) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  const d = await payrollTaxList(prisma, { year, month });
  const out: (string | number)[][] = csvTitle(`فهرست مالیات حقوق ${year}/${month}`);
  out.push(['کد', 'نام', 'کد ملی', 'شمارهٔ بیمه', 'روز کارکرد',
    'ناخالص', 'بیمهٔ سهم کارمند', 'معافیت', 'مشمول', 'مالیات', 'وضعیت']);
  for (const r of d.rows) {
    out.push([
      r.employeeCode, r.name, r.nationalId ?? '', r.insuranceNo ?? '', r.workedDays,
      rial(r.grossPay), rial(r.insuranceEmployee),
      r.exemption ? rial(r.exemption) : '—',
      r.taxable ? rial(r.taxable) : '—',
      rial(r.tax),
      r.problems.length ? r.problems.join(' · ') : 'آمادهٔ ارسال',
    ]);
  }
  out.push(['', `جمع (${d.rows.length} نفر)`, '', '', '',
    rial(d.totals.grossPay), '', '', rial(d.totals.taxable), rial(d.totals.tax),
    d.notReady ? `${d.notReady} ردیف ناقص` : 'همه آماده']);
  sendCsv(res, `payroll-tax-${year}-${month}.csv`, toCsv(out));
});

router.get('/export/notes', async (req: Request, res: Response) => {
  const asOf = asDate(req.query.asOf, new Date())!;
  const from = asDate(req.query.from) ?? (await fiscalYearStart(asOf));
  const d = await statementNotes(prisma, { asOf, from });
  const out: (string | number)[][] = csvTitle('یادداشت‌های همراه صورت‌های مالی', from, asOf);
  for (const nt of d.notes) {
    out.push([]);
    out.push([nt.title, '', rial(nt.total)]);
    out.push(['کد', 'شرح', 'مبلغ (ریال)']);
    for (const r of nt.rows) out.push([r.code, r.name, rial(r.amount)]);
    if (nt.policy) out.push(['', nt.policy]);
    for (const rm of nt.remarks ?? []) out.push(['', `${rm.title}: ${rm.body}`]);
  }
  for (const st of d.standalone) {
    out.push([]);
    out.push([st.title]);
    out.push(['', st.body]);
  }
  sendCsv(res, `notes-${Date.now()}.csv`, toCsv(out));
});

// ═══════════════════════════════════════════════════════════════
// دفاتر قانونی و صورتحساب طرف‌حساب (مرحلهٔ ۵ الف)
// ═══════════════════════════════════════════════════════════════

/** بازهٔ پیش‌فرضِ دفاتر: کلِ سال مالیِ شاملِ `to` */
async function bookPeriod(req: Request) {
  const to = asDate(req.query.to, new Date())!;
  const from = asDate(req.query.from) ?? (await fiscalYearStart(to));
  return { from, to };
}

router.get('/books/journal', async (req: Request, res: Response) => {
  const { from, to } = await bookPeriod(req);
  const rows = Number(req.query.rowsPerPage);
  send(res, await journalBook(prisma, {
    from, to,
    rowsPerPage: Number.isFinite(rows) && rows >= 5 && rows <= 100 ? rows : undefined,
  }));
});

router.get('/books/general', async (req: Request, res: Response) => {
  const { from, to } = await bookPeriod(req);
  send(res, await generalLedgerBook(prisma, { from, to }));
});

router.get('/party-statement/:subsidiaryId', async (req: Request, res: Response) => {
  const { from, to } = await bookPeriod(req);
  send(res, await partyStatement(prisma, {
    subsidiaryId: req.params.subsidiaryId, from, to,
    accountCode: req.query.accountCode ? String(req.query.accountCode) : undefined,
  }));
});

/**
 * خروجی دفتر روزنامهٔ قانونی.
 *
 * سطرهای «نقل از صفحهٔ قبل» و «نقل به صفحهٔ بعد» هم می‌آیند — بدون آن‌ها فایل
 * دیگر دفتر نیست، فقط فهرست است.
 */
router.get('/export/books/journal', async (req: Request, res: Response) => {
  const { from, to } = await bookPeriod(req);
  const d = await journalBook(prisma, { from, to });
  const out: (string | number)[][] = csvTitle('دفتر روزنامه', from, to);
  out.push(['صفحه', 'تاریخ', 'سند', 'شرح', 'کد حساب', 'نام حساب', 'تفصیلی', 'بدهکار', 'بستانکار']);
  for (const pg of d.pages) {
    out.push([pg.pageNo, '', '', 'نقل از صفحهٔ قبل', '', '', '',
      rial(pg.broughtForward.debit), rial(pg.broughtForward.credit)]);
    for (const l of pg.lines) {
      out.push([
        pg.pageNo, l.date.toISOString().slice(0, 10), l.serial ?? '',
        l.status === 'REVERSED' ? `${l.description} (باطل‌شده)` : l.description,
        l.accountCode, l.accountName, l.subsidiaryName ?? '',
        rial(l.debit), rial(l.credit),
      ]);
    }
    out.push([pg.pageNo, '', '', 'جمع صفحه', '', '', '',
      rial(pg.pageTotal.debit), rial(pg.pageTotal.credit)]);
    out.push([pg.pageNo, '', '', 'نقل به صفحهٔ بعد', '', '', '',
      rial(pg.carriedForward.debit), rial(pg.carriedForward.credit)]);
  }
  sendCsv(res, `journal-book-${Date.now()}.csv`, toCsv(out));
});

router.get('/export/books/general', async (req: Request, res: Response) => {
  const { from, to } = await bookPeriod(req);
  const d = await generalLedgerBook(prisma, { from, to });
  const out: (string | number)[][] = csvTitle('دفتر کل', from, to);
  out.push(['کد', 'حساب', 'ماه', 'بدهکار', 'بستانکار', 'مانده']);
  for (const sec of d.sections) {
    out.push([sec.code, sec.name, 'مانده ابتدای دوره', '', '', rial(sec.opening)]);
    for (const r of sec.rows) {
      out.push([sec.code, sec.name, r.month.toISOString().slice(0, 7),
        rial(r.debit), rial(r.credit), rial(r.running)]);
    }
    out.push([sec.code, sec.name, 'جمع', rial(sec.totalDebit), rial(sec.totalCredit), rial(sec.closing)]);
  }
  out.push(['', 'جمع کل', '', rial(d.total.debit), rial(d.total.credit), '']);
  sendCsv(res, `general-ledger-${Date.now()}.csv`, toCsv(out));
});

router.get('/export/party-statement/:subsidiaryId', async (req: Request, res: Response) => {
  const { from, to } = await bookPeriod(req);
  const d = await partyStatement(prisma, {
    subsidiaryId: req.params.subsidiaryId, from, to,
    accountCode: req.query.accountCode ? String(req.query.accountCode) : undefined,
  });
  const out: (string | number)[][] = csvTitle(`صورتحساب ${d.party.name}`, from, to);
  for (const c of d.currencies) {
    out.push([]);
    out.push([`ارز: ${c.currencyCode}`]);
    out.push(['تاریخ', 'شرح', 'بدهکار', 'بستانکار', 'مانده']);
    out.push(['', 'مانده ابتدای دوره', '', '', rial(c.opening)]);
    for (const l of c.lines) {
      out.push([l.date.toISOString().slice(0, 10),
        l.memo ? `${l.description} — ${l.memo}` : l.description,
        rial(l.debit), rial(l.credit), rial(l.running)]);
    }
    out.push(['', 'جمع دوره', rial(c.totalDebit), rial(c.totalCredit), '']);
    out.push(['', `مانده پایان دوره — ${c.verdict}`, '', '', rial(c.closing)]);
  }
  sendCsv(res, `statement-${d.party.code}-${Date.now()}.csv`, toCsv(out));
});

// ═══════════════════════════════════════════════════════════════
// دارایی ثابت و استهلاک (مرحلهٔ ۴ ه)
// ═══════════════════════════════════════════════════════════════

router.get('/fixed-assets', async (_req: Request, res: Response) => {
  send(res, await listAssets(prisma));
});

router.get('/fixed-assets/:code/schedule', async (req: Request, res: Response) => {
  send(res, await schedule(prisma, req.params.code));
});

router.post('/fixed-assets', async (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.code || !b.name) throw new AppError(400, 'کد و نام دارایی لازم است');
  if (!b.inServiceAt) throw new AppError(400, 'تاریخ شروع بهره‌برداری لازم است');

  const saved = await prisma.$transaction((tx) => upsertAsset(tx, {
    code: String(b.code).trim(),
    name: String(b.name).trim(),
    // مثل بقیهٔ هسته رشته می‌آید و با `parseAmount` تبدیل می‌شود، نه `Number()`
    cost: parseAmount(String(b.cost ?? '0'), 0),
    salvage: parseAmount(String(b.salvage ?? '0'), 0),
    usefulLifeMonths: Number(b.usefulLifeMonths),
    inServiceAt: asDate(b.inServiceAt)!,
    costCenterCode: b.costCenterCode ? String(b.costCenterCode) : null,
    note: b.note ? String(b.note) : null,
  }));
  await audit(req, 'ASSET_SET', `دارایی «${saved.name}» ثبت شد`,
    { meta: { code: saved.code, cost: saved.cost.toString() } });
  send(res, saved);
});

router.post('/fixed-assets/:code/dispose', async (req: Request, res: Response) => {
  const at = asDate(req.body?.disposedAt, new Date())!;
  const out = await prisma.$transaction((tx) => disposeAsset(tx, req.params.code, at));
  await audit(req, 'ASSET_DISPOSE', `کنارگذاری «${out.name}»`,
    { meta: { code: out.code, disposedAt: at.toISOString() } });
  send(res, out);
});

/**
 * ثبت استهلاکِ سررسیدشده تا یک تاریخ.
 *
 * همهٔ دوره‌های عقب‌افتاده در **یک سند** جمع می‌شوند، ولی هر دوره ردیفِ خودش
 * را می‌گیرد تا دوباره ثبت نشود.
 */
router.post('/fixed-assets/post-depreciation', async (req: Request, res: Response) => {
  const asOf = asDate(req.body?.asOf, new Date())!;
  const fiscalYearId = req.body?.fiscalYearId
    ? String(req.body.fiscalYearId)
    : (await activeFiscalYear(asOf)).id;

  const out = await prisma.$transaction((tx) => postDepreciation(tx, {
    fiscalYearId, asOf,
    assetCode: req.body?.assetCode ? String(req.body.assetCode) : null,
    createdById: req.user?.id ?? null,
  }), { timeout: 60_000 });

  if (out.posted) {
    await audit(req, 'DEPRECIATION_POST',
      `استهلاک ${out.periods} دوره — ${out.total}`,
      { entryId: out.entry.id, entrySerial: out.entry.serial,
        meta: { periods: out.periods, total: out.total } });
  }
  send(res, out);
});

// ═══════════════════════════════════════════════════════════════
// چک‌لیست پایان ماه (مرحلهٔ ۴ ه)
// ═══════════════════════════════════════════════════════════════

router.get('/month-end', async (req: Request, res: Response) => {
  const now = new Date();
  const fy = req.query.fiscalYearId
    ? await prisma.glFiscalYear.findUnique({ where: { id: String(req.query.fiscalYearId) } })
    : await prisma.glFiscalYear.findFirst({
        where: { startDate: { lte: now }, endDate: { gte: now } },
      }) ?? await prisma.glFiscalYear.findFirst({
        where: { startDate: { lte: now } }, orderBy: { startDate: 'desc' },
      });
  if (!fy) throw new AppError(404, 'سال مالی تعریف نشده است');

  const month = Number(req.query.month);
  send(res, await monthEndChecklist(prisma, {
    fiscalYearId: fy.id,
    month: Number.isFinite(month) && month >= 1 ? month : 1,
  }));
});

// ═══════════════════════════════════════════════════════════════
// ذخیرهٔ مطالبات مشکوک‌الوصول (مرحلهٔ ۴ د)
// ═══════════════════════════════════════════════════════════════

/** برآورد ذخیره — بدون ثبت سند */
router.get('/provision', async (req: Request, res: Response) => {
  send(res, await computeProvision(
    prisma,
    asDate(req.query.asOf, new Date())!,
    req.query.accountCode ? String(req.query.accountCode) : '1104',
  ));
});

router.get('/provision/rates', async (_req: Request, res: Response) => {
  send(res, await getProvisionRates(prisma));
});

router.put('/provision/rates', async (req: Request, res: Response) => {
  const saved = await prisma.$transaction((tx) => setProvisionRates(tx, req.body ?? {}));
  await audit(req, 'PROVISION_RATES', 'تغییر درصدهای ذخیرهٔ مطالبات', { meta: saved });
  send(res, saved);
});

/**
 * ثبت سند تعدیل ذخیره.
 *
 * فقط **تفاوت** با ذخیرهٔ موجود ثبت می‌شود؛ اگر صفر باشد سندی زده نمی‌شود و
 * ممیزی هم چیزی ثبت نمی‌کند (درسِ ن۶: ردِ پای عملیاتِ انجام‌نشده).
 */
router.post('/provision/post', async (req: Request, res: Response) => {
  const asOf = asDate(req.body?.asOf, new Date())!;
  const fiscalYearId = req.body?.fiscalYearId
    ? String(req.body.fiscalYearId)
    : (await activeFiscalYear(asOf)).id;

  const out = await prisma.$transaction((tx) => postProvision(tx, {
    fiscalYearId, asOf,
    accountCode: req.body?.accountCode ? String(req.body.accountCode) : undefined,
    createdById: req.user?.id ?? null,
  }), { timeout: 60_000 });

  if (out.posted) {
    await audit(req, 'PROVISION_POST',
      `ذخیرهٔ مطالبات به ${out.calc.required} رسید`,
      { entryId: out.entry.id, entrySerial: out.entry.serial,
        meta: { delta: out.calc.delta, required: out.calc.required } });
  }
  send(res, out);
});

// ═══════════════════════════════════════════════════════════════
// تخصیص پرداخت به فاکتور (مرحلهٔ ۴ ج)
// ═══════════════════════════════════════════════════════════════

/** مواضع باز یک طرف‌حساب — دو ستونِ صفحهٔ تخصیص */
router.get('/allocations/open/:subsidiaryId', async (req: Request, res: Response) => {
  send(res, await openItems(prisma, {
    subsidiaryId: req.params.subsidiaryId,
    accountCode: req.query.accountCode ? String(req.query.accountCode) : undefined,
    includeSettled: asFlag(req.query.includeSettled, 'includeSettled'),
  }));
});

/** تخصیص‌های یک ردیف — «این فاکتور با چه چیزهایی بسته شد» */
router.get('/allocations/line/:lineId', async (req: Request, res: Response) => {
  send(res, await allocationsOf(prisma, req.params.lineId));
});

router.post('/allocations', async (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.obligationLineId || !b.settlementLineId) {
    throw new AppError(400, 'ردیف تعهد و ردیف تسویه هر دو لازم‌اند');
  }
  // مبلغ مثل بقیهٔ هسته رشته می‌آید و با `parseAmount` تبدیل می‌شود، نه `Number()`
  const amount = b.amount == null || b.amount === ''
    ? null
    : parseAmount(String(b.amount), 0);

  const created = await prisma.$transaction((tx) => allocatePayment(tx, {
    obligationLineId: String(b.obligationLineId),
    settlementLineId: String(b.settlementLineId),
    amount,
    note: b.note ? String(b.note) : null,
    createdById: req.user?.id ?? null,
  }));
  await audit(req, 'ALLOCATE',
    `تخصیص ${created.amount} ${created.currencyCode}`,
    { meta: { allocationId: created.id, obligationLineId: created.obligationLineId,
              settlementLineId: created.settlementLineId } });
  send(res, created);
});

router.delete('/allocations/:id', async (req: Request, res: Response) => {
  const out = await prisma.$transaction((tx) => unallocate(tx, req.params.id));
  await audit(req, 'UNALLOCATE', `حذف تخصیص ${out.amount}`,
    { meta: { allocationId: req.params.id } });
  send(res, out);
});

// ═══════════════════════════════════════════════════════════════
// گزارش‌های قانونی (مرحلهٔ ۴)
// ═══════════════════════════════════════════════════════════════

/**
 * بازهٔ گزارش: یا `from`/`to` صریح، یا `fiscalYearId` + `quarter`.
 *
 * فصل از مرزهای واقعیِ ماه شمسی می‌آید، نه از تقسیمِ سال به چهار — همان
 * `shamsiMonths` که بودجه و روند استفاده می‌کنند، وگرنه «بهار» در سه گزارش
 * سه معنای متفاوت پیدا می‌کرد.
 */
async function taxPeriod(req: Request) {
  const from = asDate(req.query.from);
  const to = asDate(req.query.to);
  if (from && to) return { from, to, label: null as string | null };

  const q = Number(req.query.quarter);
  const spec = QUARTERS.find((x) => x.key === q);
  if (!spec) throw new AppError(400, 'فصل باید عددی بین ۱ (بهار) تا ۴ (زمستان) باشد');

  const now = new Date();
  const fy = req.query.fiscalYearId
    ? await prisma.glFiscalYear.findUnique({ where: { id: String(req.query.fiscalYearId) } })
    // همان انتخابی که داشبورد می‌کند: سالی که امروز داخلش است، نه تازه‌ترین
    : await prisma.glFiscalYear.findFirst({
        where: { startDate: { lte: now }, endDate: { gte: now } },
      }) ?? await prisma.glFiscalYear.findFirst({
        where: { startDate: { lte: now } }, orderBy: { startDate: 'desc' },
      });
  if (!fy) throw new AppError(404, 'سال مالی یافت نشد');

  const r = shamsiRange(fy, spec.months[0], spec.months[1]);
  return { ...r, label: `${spec.label} ${fy.title}` };
}

router.get('/reports/article-169', async (req: Request, res: Response) => {
  const p = await taxPeriod(req);
  send(res, { ...(await article169(prisma, p)), label: p.label });
});

router.get('/reports/vat-return', async (req: Request, res: Response) => {
  const p = await taxPeriod(req);
  send(res, { ...(await vatReturn(prisma, p)), label: p.label });
});

router.get('/reports/journal', async (req: Request, res: Response) => {
  send(res, await journal(prisma, journalFilterOf(req)));
});

router.get('/reports/account-ledger/:code', async (req: Request, res: Response) => {
  send(res, await accountLedger(prisma, req.params.code, scopeOf(req), {
    subsidiaryId: req.query.subsidiaryId ? String(req.query.subsidiaryId) : undefined,
  }));
});

router.get('/reports/trial-balance', async (req: Request, res: Response) => {
  const columns = Number(req.query.columns) as 2 | 4 | 6 | 8;
  const level = req.query.level ? Number(req.query.level) : undefined;
  send(res, await trialBalance(prisma, { ...scopeOf(req), level },
    [2, 4, 6, 8].includes(columns) ? columns : 4));
});

router.get('/reports/balance-sheet', async (req: Request, res: Response) => {
  // ممیزی ب۱۲: ستون دورهٔ قبل پیش‌فرض روشن است؛ `compare=false` خاموشش می‌کند
  send(res, await balanceSheet(prisma, asDate(req.query.asOf, new Date())!, {
    compare: String(req.query.compare ?? '') !== 'false',
    compareAsOf: asDate(req.query.compareAsOf) ?? null,
  }));
});

// ═══════════════════════════════════════════════════════════════
// بودجه (ممیزی ب۲)
// ═══════════════════════════════════════════════════════════════

router.get('/budgets', async (req: Request, res: Response) => {
  const fy = req.query.fiscalYearId
    ? String(req.query.fiscalYearId)
    : (await activeFiscalYear()).id;
  send(res, { fiscalYearId: fy, rows: await listBudgets(prisma, fy) });
});

router.post('/budgets', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.accountCode) throw new AppError(400, 'کد حساب لازم است');
  if (!Array.isArray(b.months) || b.months.length !== MONTHS_IN_YEAR) {
    throw new AppError(400, `بودجه باید دقیقاً ${MONTHS_IN_YEAR} عدد ماهانه داشته باشد`);
  }
  const fiscalYearId = b.fiscalYearId || (await activeFiscalYear()).id;
  const months = b.months.map((m: unknown) => parseAmount(String(m ?? '0'), 0));

  const out = await runOp(() => prisma.$transaction((tx) => upsertBudget(tx, {
    fiscalYearId,
    accountCode: String(b.accountCode),
    costCenterCode: b.costCenterCode ? String(b.costCenterCode) : null,
    months,
    note: b.note ? String(b.note) : null,
  })));
  await audit(req, 'BUDGET_SET', `بودجهٔ حساب ${b.accountCode}`,
    { meta: { fiscalYearId, accountCode: b.accountCode, costCenterCode: b.costCenterCode ?? null } });
  send(res, out);
});

router.delete('/budgets/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const out = await runOp(() => prisma.$transaction((tx) => deleteBudget(tx, req.params.id)));
  await audit(req, 'BUDGET_DELETE', 'حذف ردیف بودجه', { meta: { id: req.params.id } });
  send(res, out);
});

/** بودجه در برابر عملکرد — ستون انحراف با علامتِ «مطلوب/نامطلوب» */
router.get('/reports/budget-variance', async (req: Request, res: Response) => {
  const fiscalYearId = req.query.fiscalYearId
    ? String(req.query.fiscalYearId)
    : (await activeFiscalYear()).id;
  send(res, await runOp(() => budgetVsActual(prisma, {
    fiscalYearId,
    fromMonth: req.query.fromMonth ? Number(req.query.fromMonth) : undefined,
    toMonth: req.query.toMonth ? Number(req.query.toMonth) : undefined,
  })));
});

router.get('/export/budget-variance', async (req: Request, res: Response) => {
  const fiscalYearId = req.query.fiscalYearId
    ? String(req.query.fiscalYearId)
    : (await activeFiscalYear()).id;
  const d = await budgetVsActual(prisma, {
    fiscalYearId,
    fromMonth: req.query.fromMonth ? Number(req.query.fromMonth) : undefined,
    toMonth: req.query.toMonth ? Number(req.query.toMonth) : undefined,
  });
  const out: (string | number)[][] = [['بودجه در برابر عملکرد'], [], [
    'کد حساب', 'نام حساب', 'مرکز هزینه', 'بودجه (ریال)', 'عملکرد (ریال)',
    'انحراف (ریال)', 'انحراف٪', 'وضعیت',
  ]];
  for (const r of d.rows) {
    out.push([
      r.accountCode, r.accountName, r.costCenterName ?? '—',
      r.budget, r.actual, r.variance,
      r.variancePct === null ? '—' : (Number(r.variancePct) * 100).toFixed(1),
      r.favorable ? 'مطلوب' : 'نامطلوب',
    ]);
  }
  out.push(['', 'جمع', '', d.totals.budget, d.totals.actual, d.totals.variance, '', '']);
  sendCsv(res, `budget-variance-${Date.now()}.csv`, toCsv(out));
});

/** نسبت‌های مالی (ممیزی ب۱۱) — دادهٔ همه از قبل بود، فقط محاسبه نشده بود */
router.get('/reports/ratios', async (req: Request, res: Response) => {
  const s = scopeOf(req);
  send(res, await financialRatios(prisma, { from: s.from, to: s.to }));
});

router.get('/reports/income-statement', async (req: Request, res: Response) => {
  send(res, await incomeStatement(prisma, {
    ...scopeOf(req),
    byCostCenter: req.query.byCostCenter === 'true',
    byAccount: req.query.byAccount === 'true',
    compareFrom: asDate(req.query.compareFrom),
    compareTo: asDate(req.query.compareTo),
  }));
});

router.get('/reports/cash-flow', async (req: Request, res: Response) => {
  const from = asDate(req.query.from);
  const to = asDate(req.query.to, new Date())!;
  if (!from) throw new AppError(400, 'بازهٔ تاریخی لازم است');
  send(res, await cashFlow(prisma, { from, to }));
});

router.get('/reports/project-profitability', async (req: Request, res: Response) => {
  const pr = req.query.projectIds;
  send(res, await projectProfitability(prisma, {
    from: asDate(req.query.from), to: asDate(req.query.to),
    projectIds: pr ? String(pr).split(',').filter(Boolean) : undefined,
  }));
});

router.get('/reports/aging/:code', async (req: Request, res: Response) => {
  send(res, await aging(prisma, req.params.code, asDate(req.query.asOf, new Date())!, {
    subsidiaryId: typeof req.query.subsidiaryId === 'string' ? req.query.subsidiaryId : null,
  }));
});

/** صورت مغایرت بانکی (ممیزی مرحلهٔ ۶) — محاسبه، نه ثبت */
router.get('/reports/bank-reconciliation/:code', async (req: Request, res: Response) => {
  let adjustments: { amount: bigint; note: string }[] = [];
  if (req.query.adjustments) {
    try {
      const raw = JSON.parse(String(req.query.adjustments));
      if (Array.isArray(raw)) {
        adjustments = raw.map((a: any) => ({ amount: BigInt(String(a.amount ?? '0')), note: String(a.note ?? '') }));
      }
    } catch { throw new AppError(400, 'اقلامِ مغایرت باید JSON معتبر باشد'); }
  }
  send(res, await bankReconciliation(prisma, {
    accountCode: req.params.code,
    asOf: asDate(req.query.asOf, new Date())!,
    statementBalance: req.query.statementBalance != null && req.query.statementBalance !== ''
      ? BigInt(String(req.query.statementBalance)) : null,
    adjustments,
    windowDays: req.query.windowDays ? Number(req.query.windowDays) : undefined,
  }));
});

router.get('/reports/cost-centers', async (req: Request, res: Response) => {
  send(res, await costCenterTotals(prisma, { from: asDate(req.query.from), to: asDate(req.query.to) }));
});

router.get('/reports/integrity', async (_req: Request, res: Response) => {
  send(res, await integrityCheck(prisma));
});

/** هارنس مقایسهٔ دو هسته — دورهٔ دونویسی (فاز ۳) */
router.get('/diff', async (_req: Request, res: Response) => {
  send(res, await compareCores());
});

/** سیاههٔ مقایسه در طول زمان + رشتهٔ روزهای پاک — دروازهٔ برش prod (فاز ۶) */
router.get('/diff/history', async (_req: Request, res: Response) => {
  send(res, streak());
});

// ── خروجی اکسل (CSV با BOM) ──
const rial = (v: bigint | string | number) => String(v ?? '');

router.get('/export/journal', async (req: Request, res: Response) => {
  const rows = await journal(prisma, journalFilterOf(req));
  const out: (string | number)[][] = [['تاریخ', 'سند', 'شرح', 'حساب', 'تفصیلی', 'مرکز هزینه', 'ارز', 'بدهکار', 'بستانکار', 'بدهکار (ریال)', 'بستانکار (ریال)', 'یادداشت']];
  for (const r of rows as any[]) {
    out.push([
      new Date(r.date).toISOString().slice(0, 10), r.serial ?? '', r.description,
      `${r.accountCode} ${r.accountName}`, r.subsidiaryName ?? '', r.costCenterCode ?? '',
      r.currencyCode, rial(r.debit), rial(r.credit), rial(r.debitBase), rial(r.creditBase), r.memo ?? '',
    ]);
  }
  sendCsv(res, `journal-${Date.now()}.csv`, toCsv(out));
});

const TB_COL_FA: Record<string, string> = {
  openingDebit: 'مانده ابتدا (بد)', openingCredit: 'مانده ابتدا (بس)',
  periodDebit: 'گردش دوره (بد)', periodCredit: 'گردش دوره (بس)',
  cumulativeDebit: 'گردش تجمعی (بد)', cumulativeCredit: 'گردش تجمعی (بس)',
  closingDebit: 'مانده پایان (بد)', closingCredit: 'مانده پایان (بس)',
};
router.get('/export/trial-balance', async (req: Request, res: Response) => {
  const columns = Number(req.query.columns) as 2 | 4 | 6 | 8;
  const level = req.query.level ? Number(req.query.level) : undefined;
  const data = await trialBalance(prisma, { ...scopeOf(req), level }, [2, 4, 6, 8].includes(columns) ? columns : 4);
  const out: (string | number)[][] = [['کد', 'نام', ...data.valueColumns.map((c: string) => TB_COL_FA[c] ?? c)]];
  for (const r of data.rows as any[]) out.push([r.code, r.name, ...data.valueColumns.map((c: string) => rial(r[c]))]);
  out.push(['', 'جمع', ...data.valueColumns.map((c: string) => rial((data.totals as any)[c]))]);
  sendCsv(res, `trial-balance-${Date.now()}.csv`, toCsv(out));
});

router.get('/export/account-ledger/:code', async (req: Request, res: Response) => {
  const data = await accountLedger(prisma, req.params.code, scopeOf(req), {
    subsidiaryId: req.query.subsidiaryId ? String(req.query.subsidiaryId) : undefined,
  });
  const out: (string | number)[][] = [
    ['', '', `مانده ابتدا`, rial(data.openingBalance)],
    ['تاریخ', 'سند', 'شرح', 'تفصیلی', 'ارز', 'بدهکار', 'بستانکار', 'مانده'],
  ];
  for (const r of data.rows as any[]) {
    out.push([
      new Date(r.date).toISOString().slice(0, 10), r.serial ?? '', r.description,
      r.subsidiaryName ?? '', r.currencyCode, rial(r.debit), rial(r.credit), rial(r.running),
    ]);
  }
  out.push(['', '', 'مانده پایان', '', '', '', '', rial(data.closingBalance)]);
  sendCsv(res, `account-${req.params.code}-${Date.now()}.csv`, toCsv(out));
});

router.get('/export/subsidiary-ledger/:code', async (req: Request, res: Response) => {
  const rows = await subsidiaryLedger(prisma, req.params.code, asDate(req.query.asOf));
  const out: (string | number)[][] = [['کد تفصیلی', 'نام', 'نوع', 'ارز', 'مانده', 'معادل ریال']];
  for (const r of rows as any[]) {
    out.push([r.code, r.name, r.kind, r.currencyCode, rial(r.balance), rial(r.balanceBase)]);
  }
  sendCsv(res, `subsidiary-${req.params.code}-${Date.now()}.csv`, toCsv(out));
});

// ── خروجی صورت‌های مالی (ممیزی ب۱) ──
//
// پیش از این تنها گزارش‌هایی که **هیچ** راه خروجی نداشتند، دقیقاً همان‌هایی
// بودند که به بانک و حسابرس و سهامدار داده می‌شوند. چهار مسیر زیر آن را می‌بندند.
// شکلِ خروجی عمداً «آمادهٔ چاپ» است، نه dump خام: سرستون فارسی، جمع‌ها در جای
// خودشان، و یک سطر عنوان که بازهٔ گزارش را می‌گوید.

/** سطر عنوانِ گزارش — بدون آن، فایل اکسل معلوم نیست مال چه بازه‌ای است */
const csvTitle = (title: string, from?: Date, to?: Date): (string | number)[][] => {
  const d = (x?: Date) => (x ? x.toISOString().slice(0, 10) : '—');
  // ترازنامه «در تاریخ» است و بقیه «از … تا …» — تشخیص با وجودِ `from`
  return [[title], [from ? `از ${d(from)} تا ${d(to)}` : `در تاریخ ${d(to)}`], []];
};

router.get('/export/balance-sheet', async (req: Request, res: Response) => {
  const asOf = asDate(req.query.asOf, new Date())!;
  const d: any = await balanceSheet(prisma, asOf);
  const out: (string | number)[][] = csvTitle('ترازنامه', undefined, asOf);
  out.push(['کد', 'عنوان', 'مبلغ (ریال)']);

  const section = (label: string, rows: any[]) => {
    out.push(['', label, '']);
    for (const r of rows) out.push([r.code, r.name, rial(r.amount)]);
  };
  section('دارایی‌ها', d.assets);
  out.push(['', 'جمع دارایی‌های جاری', rial(d.totals.currentAssets)]);
  out.push(['', 'جمع دارایی‌های غیرجاری', rial(d.totals.nonCurrentAssets)]);
  out.push(['', 'جمع دارایی‌ها', rial(d.totals.assets)]);
  out.push([]);
  section('بدهی‌ها', d.liabilities);
  out.push(['', 'جمع بدهی‌های جاری', rial(d.totals.currentLiabilities)]);
  out.push(['', 'جمع بدهی‌های بلندمدت', rial(d.totals.longTermLiabilities)]);
  out.push(['', 'جمع بدهی‌ها', rial(d.totals.liabilities)]);
  out.push([]);
  section('حقوق صاحبان سهام', d.equity);
  out.push(['', 'سود (زیان) دورهٔ بسته‌نشده', rial(d.totals.retainedEarnings)]);
  out.push(['', 'جمع حقوق صاحبان سهام', rial(d.totals.totalEquity)]);
  out.push([]);
  out.push(['', 'جمع بدهی و حقوق صاحبان سهام', rial(d.totals.totalLiabilitiesAndEquity)]);
  out.push(['', 'سرمایه در گردش', rial(d.totals.workingCapital)]);
  out.push(['', d.balanced ? 'معادلهٔ حسابداری برقرار است' : `اختلاف: ${d.difference}`, '']);
  sendCsv(res, `balance-sheet-${Date.now()}.csv`, toCsv(out));
});

router.get('/export/income-statement', async (req: Request, res: Response) => {
  const s = scopeOf(req);
  const d: any = await incomeStatement(prisma, {
    ...s,
    byAccount: true,
    compareFrom: asDate(req.query.compareFrom),
    compareTo: asDate(req.query.compareTo),
  });
  const cmp = d.comparison;
  const out: (string | number)[][] = csvTitle('صورت سود و زیان', s.from, s.to);
  out.push(cmp ? ['عنوان', 'مبلغ (ریال)', 'دورهٔ قبل (ریال)'] : ['عنوان', 'مبلغ (ریال)']);

  const line = (label: string, key: string) =>
    out.push(cmp
      ? [label, rial(d.totals[key]), rial(cmp.totals[key])]
      : [label, rial(d.totals[key])]);

  line('فروش خالص', 'revenue');
  line('بهای تمام‌شده', 'cogs');
  line('سود ناخالص', 'grossProfit');
  line('هزینه‌های اداری و عمومی', 'admin');
  line('هزینه‌های مالی', 'financial');
  line('سود عملیاتی', 'operatingProfit');
  line('درآمد (هزینهٔ) غیرعملیاتی', 'nonOperating');
  line('سود قبل از مالیات', 'profitBeforeTax');
  line('مالیات بر درآمد', 'taxExpense');
  line('سود خالص', 'netProfit');

  if (d.accounts?.length) {
    out.push([], ['تفکیک به سطح معین'], ['کد', 'نام', 'مبلغ (ریال)']);
    for (const a of d.accounts) out.push([a.code, a.name, rial(a.amount)]);
  }
  if (d.unallocated) {
    out.push([], ['تخصیص‌نیافته به مرکز هزینه'], ['عنوان', 'مبلغ (ریال)']);
    for (const [k, fa] of [['revenue', 'فروش'], ['cogs', 'بهای تمام‌شده'], ['admin', 'اداری و عمومی'], ['financial', 'مالی'], ['nonOperating', 'غیرعملیاتی']] as const) {
      out.push([fa, rial(d.unallocated[k])]);
    }
  }
  sendCsv(res, `income-statement-${Date.now()}.csv`, toCsv(out));
});

router.get('/export/cash-flow', async (req: Request, res: Response) => {
  const s = scopeOf(req);
  const from = s.from ?? new Date(0);
  const to = s.to ?? new Date();
  const d: any = await cashFlow(prisma, { from, to });
  const out: (string | number)[][] = csvTitle('صورت جریان وجوه نقد', from, to);
  out.push(['عنوان', 'مبلغ (ریال)']);
  out.push(['موجودی نقد ابتدای دوره', rial(d.openingCash)]);
  out.push(['جریان نقد عملیاتی', rial(d.operating)]);
  out.push(['جریان نقد سرمایه‌گذاری', rial(d.investing)]);
  out.push(['جریان نقد تأمین مالی', rial(d.financing)]);
  out.push(['خالص تغییر وجه نقد', rial(d.netChange)]);
  out.push(['موجودی نقد پایان دوره', rial(d.closingCash)]);
  out.push(['تطبیق (باید صفر باشد)', rial(d.reconciliation)]);
  out.push([], ['تفکیک بر اساس حساب طرف مقابل'], ['کد حساب', 'دسته', 'مبلغ (ریال)']);
  const CAT_FA: Record<string, string> = { OPERATING: 'عملیاتی', INVESTING: 'سرمایه‌گذاری', FINANCING: 'تأمین مالی' };
  for (const r of d.detail ?? []) out.push([r.counterCode, CAT_FA[r.category] ?? r.category, rial(r.amount)]);
  sendCsv(res, `cash-flow-${Date.now()}.csv`, toCsv(out));
});

/**
 * خروجی گزارش فصلی ماده ۱۶۹.
 *
 * ستون‌ها عمداً همان ترتیبِ فرم سازمان‌اند تا کپی‌کردن دستی کمترین جابه‌جایی
 * را بخواهد. ردیف‌های ناقص حذف نمی‌شوند — با ستون «وضعیت» می‌آیند، وگرنه
 * حسابدار جمعِ کمتری می‌بیند و نمی‌فهمد چرا.
 */
/**
 * خروجی صورت تغییرات حقوق صاحبان سهام.
 *
 * ماتریس است نه فهرست: ستون‌ها حساب‌های حقوق صاحبان سهام و سطرها حرکت‌ها.
 * سطر «سود (زیان) خالص دوره» فقط وقتی جدا می‌آید که هنوز با سند اختتامیه
 * منتقل نشده باشد — وگرنه در گردشِ انباشته شمرده شده و دو بار می‌آمد.
 */
router.get('/export/equity', async (req: Request, res: Response) => {
  const to = asDate(req.query.to, new Date())!;
  const from = asDate(req.query.from) ?? (await fiscalYearStart(to));
  const d = await equityStatement(prisma, { from, to });
  const codes = d.columns.map((c) => c.code);

  const out: (string | number)[][] = csvTitle('صورت تغییرات حقوق صاحبان سهام', from, to);
  out.push(['شرح', ...d.columns.map((c) => `${c.code} ${c.name}`), 'جمع']);

  const line = (label: string, get: (code: string) => string) => {
    const vals = codes.map(get);
    const total = vals.reduce((s2, v) => s2 + BigInt(v || '0'), 0n);
    out.push([label, ...vals.map(rial), rial(total.toString())]);
  };

  line('ماندهٔ ابتدای دوره', (c) => d.columns.find((x) => x.code === c)!.opening);
  for (const m of d.movements) {
    line(`${m.serial ? `#${m.serial} ` : ''}${m.description}`, (c) => m.byAccount[c] ?? '0');
  }
  if (!d.profitPosted) {
    line('سود (زیان) خالص دوره', (c) => (c === '3102' ? d.profit : '0'));
  }
  line('ماندهٔ پایان دوره', (c) => d.columns.find((x) => x.code === c)!.closingEconomic);

  if (d.profitPosted) {
    out.push([]);
    out.push(['سود دوره با سند اختتامیه به سود و زیان انباشته منتقل شده است.']);
  }
  sendCsv(res, `equity-${Date.now()}.csv`, toCsv(out));
});

router.get('/export/article-169', async (req: Request, res: Response) => {
  const p = await taxPeriod(req);
  const d = await article169(prisma, p);
  const out: (string | number)[][] = csvTitle(
    `گزارش فصلی ماده ۱۶۹${p.label ? ` — ${p.label}` : ''}`, p.from, p.to);
  out.push([
    'کد', 'طرف‌حساب', 'نوع شخص', 'شناسهٔ ملی / کد ملی', 'کد اقتصادی',
    'تعداد فروش', 'مبلغ فروش', 'ارزش افزودهٔ فروش',
    'تعداد خرید', 'مبلغ خرید', 'ارزش افزودهٔ خرید', 'وضعیت',
  ]);
  for (const r of d.rows) {
    out.push([
      r.code, r.name, r.taxPersonType ? PERSON_TYPE_FA[r.taxPersonType] : '—',
      r.nationalId ?? '', r.economicCode ?? '',
      r.salesCount, rial(r.sales), rial(r.salesVat),
      r.purchasesCount, rial(r.purchases), rial(r.purchasesVat),
      r.problems.length ? r.problems.join(' · ') : 'آمادهٔ ارسال',
    ]);
  }
  out.push([
    '', `جمع (${d.rows.length} طرف‌حساب)`, '', '', '',
    '', rial(d.totals.sales), rial(d.totals.salesVat),
    '', rial(d.totals.purchases), rial(d.totals.purchasesVat),
    d.notReady ? `${d.notReady} ردیف ناقص` : 'همه آماده',
  ]);

  if (d.unattributed.length) {
    out.push([]);
    out.push([`اسنادی که به یک طرف‌حساب منتسب نشدند (${d.unattributed.length})`]);
    out.push(['سند', 'تاریخ', 'شرح', 'مبلغ', 'دلیل']);
    for (const u of d.unattributed) {
      out.push([u.serial ?? '—', u.date.toISOString().slice(0, 10), u.description,
        rial(u.amount), u.reason]);
    }
  }
  sendCsv(res, `article-169-${Date.now()}.csv`, toCsv(out));
});

router.get('/export/vat-return', async (req: Request, res: Response) => {
  const p = await taxPeriod(req);
  const d = await vatReturn(prisma, p);
  const POS_FA: Record<string, string> = {
    PAYABLE: 'بدهی به سازمان امور مالیاتی',
    CREDIT: 'اعتبارِ قابل انتقال به دورهٔ بعد',
    NIL: 'صفر',
  };
  const out: (string | number)[][] = csvTitle(
    `اظهارنامهٔ ارزش افزوده${p.label ? ` — ${p.label}` : ''}`, p.from, p.to);
  out.push(['شرح', 'مبلغ (ریال)']);
  out.push(['فروشِ مشمول', rial(d.taxableSales)]);
  out.push(['مالیات و عوارض فروش', rial(d.outputVat)]);
  out.push(['خریدِ مشمول', rial(d.taxablePurchases)]);
  out.push(['اعتبار مالیاتی خرید', rial(d.inputVat)]);
  out.push([POS_FA[d.position], rial(d.amount)]);
  sendCsv(res, `vat-return-${Date.now()}.csv`, toCsv(out));
});

router.get('/export/aging/:code', async (req: Request, res: Response) => {
  const asOf = asDate(req.query.asOf, new Date())!;
  const d: any = await aging(prisma, req.params.code, asOf);
  const buckets = ['0-30', '31-60', '61-90', '90+'];
  const BUCKET_FA: Record<string, string> = {
    '0-30': 'تا ۳۰ روز', '31-60': '۳۱ تا ۶۰ روز', '61-90': '۶۱ تا ۹۰ روز', '90+': 'بیش از ۹۰ روز',
  };
  const out: (string | number)[][] = csvTitle(`سن‌بندی حساب ${req.params.code}`, undefined, asOf);
  out.push([
    'کد', 'طرف‌حساب', 'ارز', 'ماندهٔ باز',
    ...buckets.map((b) => `${BUCKET_FA[b]} (ریال)`),
    'قدیمی‌ترین (روز)', 'معادل ریال',
  ]);
  for (const r of d.rows as any[]) {
    // ردیفِ طرف‌حساب: سطل‌ها به ارز پایه‌اند، پس «ماندهٔ باز» به ارز خام برای
    // طرف‌حسابِ چندارزی معنا ندارد و خالی می‌ماند (ممیزی سوم — ج۴).
    out.push([
      r.code, r.name, r.singleCurrency ?? 'چندارزی',
      r.singleCurrency ? rial(r.currencies[0].balance) : '',
      ...buckets.map((b) => rial(r.buckets[b])),
      r.oldestDays, rial(r.totalBase),
    ]);
    if (r.singleCurrency) continue;
    for (const c of r.currencies as any[]) {
      out.push([
        '', `↳ ${r.name}`, c.currencyCode, rial(c.balance),
        ...buckets.map((b) => rial(c.buckets[b])),
        c.oldestDays, rial(c.totalBase),
      ]);
    }
  }
  out.push([
    '', `جمع (${d.rows.length} طرف‌حساب)`, '', '',
    ...buckets.map((b) => rial(d.bucketTotals[b])),
    '', rial(d.grandTotalBase),
  ]);
  sendCsv(res, `aging-${req.params.code}-${Date.now()}.csv`, toCsv(out));
});

router.get('/export/cost-centers', async (req: Request, res: Response) => {
  const s = scopeOf(req);
  const rows = await costCenterTotals(prisma, { from: s.from, to: s.to });
  const out: (string | number)[][] = csvTitle('گزارش مراکز هزینه', s.from, s.to);
  out.push(['کد', 'مرکز هزینه', 'نوع', 'مبلغ (ریال)']);
  const ROOT_FA: Record<string, string> = { INCOME: 'درآمد', EXPENSE: 'هزینه' };
  for (const r of rows as any[]) {
    out.push([r.code ?? '—', r.name ?? 'تخصیص‌نیافته', ROOT_FA[r.rootType] ?? r.rootType, rial(r.totalBase)]);
  }
  sendCsv(res, `cost-centers-${Date.now()}.csv`, toCsv(out));
});

// ═══════════════════════════════════════════════════════════════
// تسعیر ارز
// ═══════════════════════════════════════════════════════════════

router.get('/fx/rates', async (_req: Request, res: Response) => {
  const [rows, base, currencies] = await Promise.all([
    prisma.glExchangeRate.findMany({ orderBy: [{ date: 'desc' }], take: 100 }),
    prisma.glCurrency.findFirst({ where: { isBase: true } }),
    prisma.glCurrency.findMany({ where: { isActive: true, isBase: false } }),
  ]);
  // تازه‌ترین نرخِ هر ارز (هر منبعی) — تا UI بفهمد کدام ارز نرخ روز ندارد
  const freshness: Record<string, { date: string; rate: string; source: string; ageDays: number } | null> = {};
  const today = Date.now();
  for (const c of currencies) {
    const latest = rows.find((r) => r.from === c.code && r.to === base?.code);
    freshness[c.code] = latest
      ? {
          date: latest.date.toISOString().slice(0, 10),
          rate: latest.rate.toString(),
          source: latest.source,
          ageDays: Math.floor((today - latest.date.getTime()) / 86_400_000),
        }
      : null;
  }
  send(res, { rows, freshness });
});

router.post('/fx/rates', async (req: Request, res: Response) => {
  const { from, to, rate, date } = req.body;
  if (!from || !to || !rate || !date) throw new AppError(400, 'ارز مبدأ و مقصد و نرخ و تاریخ لازم است');

  const at = asDate(date);
  if (!at) throw new AppError(400, 'تاریخ نرخ نامعتبر است');

  // ممیزی ج۱۵ + ن۲ + ن۳: نرخِ نامثبت خطاست (پرتاب می‌شود، تأییدپذیر نیست)، و
  // مرجعِ سنجشِ انحراف، نرخِ مؤثرِ **همان تاریخ** است نه تازه‌ترین ردیفِ جدول.
  const check = await checkRateOutlier(prisma, from, to, rate, at);
  if (!check.ok && !asFlag(req.body?.confirmOutlier, 'confirmOutlier')) {
    const msg = check.reason === 'FIRST_RATE'
      ? `این نخستین نرخِ ${from} در دفتر است و مرجعی برای مقایسه ندارد؛ ` +
        `همهٔ نرخ‌های بعدی با آن سنجیده می‌شوند. اگر ${Number(rate).toLocaleString('en-US')} درست است، ` +
        'دوباره با تأیید ثبت کن.'
      : `نرخ واردشده ${Math.round(check.deviation * 100)}٪ با نرخِ مؤثرِ این تاریخ ` +
        `(${Number(check.last!.rate).toLocaleString('en-US')} در ${check.last!.date}) فرق دارد. ` +
        'اگر مطمئنی درست است، دوباره با تأیید ثبت کن.';
    // پاسخِ ساختاریافته: فرانت به‌جای تطبیقِ شکنندهٔ متن، روی `needsConfirm` تصمیم می‌گیرد
    return res.status(400).json({ message: msg, needsConfirm: true, reason: check.reason });
  }

  const created = await prisma.glExchangeRate.upsert({
    where: { from_to_date_source: { from, to, date: at, source: 'MANUAL' } },
    update: { rate: new Prisma.Decimal(String(rate)) },
    create: { from, to, date: at, rate: new Prisma.Decimal(String(rate)), source: 'MANUAL' },
  });
  send(res, created);
});

/** گرفتن نرخ زنده و نوشتنش در GlExchangeRate (source=AUTO) — دستی یا از cron */
router.post('/fx/rates/refresh', async (_req: Request, res: Response) => {
  send(res, await syncGlRates({ force: true }));
});

/** پُرکردن یک‌بارهٔ تاریخچه از snapshotهای هستهٔ قدیمی (source=BACKFILL) */
router.post('/fx/rates/backfill', requireRole('SUPER_ADMIN', 'MANAGER'), async (_req: Request, res: Response) => {
  send(res, await backfillGlRatesFromSnapshots());
});

router.get('/fx/revaluation/preview', async (req: Request, res: Response) => {
  const asOf = asDate(req.query.asOf, new Date())!;
  send(res, await previewRevaluation(prisma, asOf));
});

router.post('/fx/revaluation', async (req: Request, res: Response) => {
  const asOf = asDate(req.body?.asOf, new Date())!;
  const mode = req.body?.mode === 'permanent' ? 'permanent' as const : 'temporary' as const;
  const fy = await activeFiscalYear(asOf);
  const result = await runOp(() => prisma.$transaction(
    (tx) => postRevaluation(tx, { fiscalYearId: fy.id, asOf, mode, createdById: req.user!.id }),
    { timeout: 120_000 },
  ));
  // ممیزی ن۶: اگر موضعی برای تعدیل نبود، `posted:false` برمی‌گردد و هیچ سندی
  // ساخته نمی‌شود. ثبتِ آن در سیاهه یعنی ردِ پا کاری را گزارش کند که رخ نداده.
  if ((result as any)?.posted) {
    await audit(req, 'POST', `تجدید ارزیابی ارزی ${asOf.toISOString().slice(0, 10)} (${mode === 'permanent' ? 'دائمی' : 'موقت'})`,
      { entryId: (result as any).adjustment?.id, entrySerial: (result as any).adjustment?.serial, meta: { mode } });
  }
  send(res, result);
});

/** نرخ روزِ ارز به **ریال** — کمکِ فرم عملیات (هسته خودش هرگز نرخ زنده نمی‌گیرد) */
router.get('/fx/today', async (req: Request, res: Response) => {
  const currency = String(req.query.currency || '').toUpperCase();
  const live = await getRates();
  // getRates نرخ را به تومان می‌دهد؛ هسته ریال است ⇒ ×۱۰
  const tomanPerUnit =
    currency === 'USD' ? live.USD_TO_IRR : currency === 'CNY' ? live.CNY_TO_IRR : null;
  if (tomanPerUnit == null) {
    throw new AppError(400, `نرخ زندهٔ ${currency || 'این ارز'} در دسترس نیست — دستی وارد کنید`);
  }
  send(res, {
    currency,
    rate: String(Math.round(tomanPerUnit * 10)),
    source: live.source,
    fetchedAt: live.fetchedAt,
    isStale: live.isStale,
  });
});

// ═══════════════════════════════════════════════════════════════
// عملیات روزمره — دریافت/پرداخت، تبدیل ارز، انتقال، هزینه
// ═══════════════════════════════════════════════════════════════

/** خطاهای موتور (قاعده‌ای، نه سیستمی) خطای ورودی‌اند ⇒ ۴۰۰ با پیام فارسی */
async function runOp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (
      e instanceof LedgerError || e instanceof FxError ||
      e instanceof ChequeError || e instanceof PettyCashError ||
      e instanceof PayrollError || e instanceof PayrollRateError ||
      e instanceof SubsidiaryError
    ) {
      throw new AppError(400, e.message);
    }
    throw e;
  }
}

/** رشتهٔ مبلغ از فرم ⇒ کوچک‌ترین واحدِ ارز (نه Number؛ برای مبالغ بزرگ ریالی دقت می‌بازد) */
async function toMinor(amount: unknown, currencyCode: string): Promise<bigint> {
  const c = await prisma.glCurrency.findUnique({ where: { code: currencyCode } });
  if (!c) throw new AppError(400, `ارز ${currencyCode} تعریف نشده است`);
  try {
    return parseAmount(String(amount ?? ''), c.decimalPlaces);
  } catch {
    throw new AppError(400, `مبلغ نامعتبر: ${amount}`);
  }
}

/** ردیف‌های لیست حقوق از فرم ⇒ ورودیِ موتور (ساعت‌ها عدد، کسورات به ریال) */
function parsePayrollRows(rows: unknown): PayrollInputRow[] {
  if (!Array.isArray(rows) || !rows.length) throw new AppError(400, 'حداقل یک کارمند لازم است');
  return rows.map((r: any, i: number) => {
    if (!r?.employeeId) throw new AppError(400, `ردیف ${i + 1}: کارمند مشخص نیست`);
    const num = (v: unknown, d = 0) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : d;
    };
    const money = (v: unknown) => (v ? parseAmount(String(v), 0) : undefined);
    return {
      employeeId: String(r.employeeId),
      workedDays: Math.round(num(r.workedDays, 30)),
      overtimeHours: num(r.overtimeHours),
      nightHours: num(r.nightHours),
      holidayHours: num(r.holidayHours),
      loanDeduction: money(r.loanDeduction),
      advanceDeduction: money(r.advanceDeduction),
      otherDeduction: money(r.otherDeduction),
    };
  });
}

const receiptUrls = (req: Request, kind: string, extra: Record<string, unknown> = {}) =>
  req.file ? [storeReceipt(req.file, kind, extra as any)] : [];

router.get('/ops/settlement/preview', async (req: Request, res: Response) => {
  const { subsidiaryId, currency } = req.query as Record<string, string>;
  if (!subsidiaryId || !currency) throw new AppError(400, 'تفصیلی و ارز لازم است');
  send(res, await settlementPreview(prisma, subsidiaryId, currency, asDate(req.query.asOf, new Date())!));
});

router.post('/ops/settlement', upload.single('receipt'), async (req: Request, res: Response) => {
  const { direction, subsidiaryId, currency, amount, cashAccountCode, obligationAccountCode, dayRate, description } = req.body;
  if (!['RECEIPT', 'PAYMENT'].includes(direction)) throw new AppError(400, 'نوع تسویه (دریافت/پرداخت) لازم است');
  if (!subsidiaryId || !currency || !amount || !cashAccountCode) {
    throw new AppError(400, 'طرف‌حساب، ارز، مبلغ و حساب شرکت لازم است');
  }
  const date = asDate(req.body.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const entry = await runOp(() => prisma.$transaction((tx) => doSettlement(tx, {
    fiscalYearId: fy.id, date, direction, subsidiaryId, currency, amount: String(amount),
    cashAccountCode, obligationAccountCode: obligationAccountCode || undefined,
    dayRate: dayRate ? String(dayRate) : undefined,
    cashCurrency: req.body.cashCurrency || undefined,
    cashAmount: req.body.cashAmount ? String(req.body.cashAmount) : undefined,
    description: description || undefined,
    allowPrepayment: req.body.allowPrepayment === 'true' || req.body.allowPrepayment === true,
    attachmentUrls: receiptUrls(req, direction === 'RECEIPT' ? 'RECEIPT' : 'PAYMENT', { currencyCode: currency }),
    createdById: req.user!.id,
  }), { timeout: 30_000 }));
  send(res, entry);
});

router.post('/ops/conversion', upload.single('receipt'), async (req: Request, res: Response) => {
  const b = req.body;
  if (!b.fromAccountCode || !b.toAccountCode || !b.fromCurrency || !b.toCurrency || !b.fromAmount || !b.toAmount) {
    throw new AppError(400, 'حساب و ارز و مبلغ هر دو سمت لازم است');
  }
  const date = asDate(b.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const fee = b.feeAmount
    ? {
        amount: String(b.feeAmount),
        currency: String(b.feeCurrency || b.fromCurrency),
        accountCode: String(b.feeAccountCode || ''),
        exchangeSubsidiaryId: b.feeExchangeSubsidiaryId || undefined,
      }
    : undefined;
  const result = await runOp(() => prisma.$transaction((tx) => doConversion(tx, {
    fiscalYearId: fy.id, date,
    fromAccountCode: String(b.fromAccountCode), fromCurrency: String(b.fromCurrency), fromAmount: String(b.fromAmount),
    toAccountCode: String(b.toAccountCode), toCurrency: String(b.toCurrency), toAmount: String(b.toAmount),
    fee,
    description: b.description || undefined,
    attachmentUrls: receiptUrls(req, 'CONVERSION', { currencyPair: `${b.fromCurrency}-${b.toCurrency}` }),
    createdById: req.user!.id,
  }), { timeout: 30_000 }));
  send(res, result);
});

router.post('/ops/transfer', upload.single('receipt'), async (req: Request, res: Response) => {
  const { fromAccountCode, toAccountCode, currency, amount, dayRate, description } = req.body;
  if (!fromAccountCode || !toAccountCode || !currency || !amount) {
    throw new AppError(400, 'حساب مبدأ و مقصد و ارز و مبلغ لازم است');
  }
  const date = asDate(req.body.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const entry = await runOp(() => prisma.$transaction((tx) => doTransfer(tx, {
    fiscalYearId: fy.id, date,
    fromAccountCode: String(fromAccountCode), toAccountCode: String(toAccountCode),
    currency: String(currency), amount: String(amount),
    dayRate: dayRate ? String(dayRate) : undefined,
    description: description || undefined,
    attachmentUrls: receiptUrls(req, 'TRANSFER', { currencyCode: currency }),
    createdById: req.user!.id,
  }), { timeout: 30_000 }));
  send(res, entry);
});

router.post('/ops/expense', upload.single('receipt'), async (req: Request, res: Response) => {
  const { fromAccountCode, expenseAccountCode, costCenterId, currency, amount, dayRate, description } = req.body;
  if (!fromAccountCode || !currency || !amount) throw new AppError(400, 'حساب پرداخت، ارز و مبلغ لازم است');
  const date = asDate(req.body.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const entry = await runOp(() => prisma.$transaction((tx) => doExpense(tx, {
    fiscalYearId: fy.id, date,
    fromAccountCode: String(fromAccountCode),
    expenseAccountCode: expenseAccountCode || undefined,
    costCenterId: costCenterId || undefined,
    currency: String(currency), amount: String(amount),
    dayRate: dayRate ? String(dayRate) : undefined,
    description: description || undefined,
    attachmentUrls: receiptUrls(req, 'EXPENSE', { currencyCode: currency }),
    createdById: req.user!.id,
  }), { timeout: 30_000 }));
  send(res, entry);
});

// ═══════════════════════════════════════════════════════════════
// مهاجرت
// ═══════════════════════════════════════════════════════════════

/** بررسیِ پیش‌پروازِ برش — فقط‌خواندنی، هیچ چیزی نمی‌نویسد */
router.get('/migration/preflight', async (req: Request, res: Response) => {
  send(res, await cutoverPreflight(prisma, { cutoff: asDate(req.query.cutoff) ?? null }));
});

router.get('/migration/plan', async (req: Request, res: Response) => {
  const cutoff = asDate(req.query.cutoff, new Date())!;
  send(res, await prisma.$transaction((tx) => buildMigrationPlan(tx, cutoff), { timeout: 120_000 }));
});

router.get('/migration/verify', async (req: Request, res: Response) => {
  const cutoff = asDate(req.query.cutoff, new Date())!;
  send(res, await prisma.$transaction((tx) => verifyMigration(tx, cutoff), { timeout: 180_000 }));
});

/** اجرای مهاجرت — فقط مدیر ارشد */
router.post('/migration/run', requireRole('SUPER_ADMIN'), async (req: Request, res: Response) => {
  const cutoff = asDate(req.body?.cutoff, new Date())!;
  const fy = await activeFiscalYear(cutoff);
  const result = await prisma.$transaction(
    (tx) => postOpeningEntry(tx, {
      fiscalYearId: fy.id, cutoff, createdById: req.user!.id,
      allowRoundingPlug: req.body?.allowRoundingPlug === true,
    }),
    { timeout: 180_000 },
  );
  send(res, result);
});

// ═══════════════════════════════════════════════════════════════
// چک  (docs/ACCOUNTING_SPEC.md بند ۳-۵)
// ═══════════════════════════════════════════════════════════════

/** چک یک دارایی/بدهی مستقل است؛ لیست با فیلترِ جهت/وضعیت/طرف‌حساب */
router.get('/cheques', async (req: Request, res: Response) => {
  const { direction, status, subsidiaryId } = req.query as Record<string, string>;
  const rows = await prisma.glCheque.findMany({
    where: {
      ...(direction ? { direction: direction as any } : {}),
      ...(status ? { status: status as any } : {}),
      ...(subsidiaryId ? { subsidiaryId } : {}),
    },
    include: {
      subsidiary: { select: { code: true, name: true, kind: true } },
      _count: { select: { transitions: true } },
    },
    orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
  });
  send(res, rows);
});

/** چک‌های سررسیدشده و تعیین‌تکلیف‌نشده — باید پیش از `/cheques/:id` بیاید */
router.get('/cheques/overdue', async (req: Request, res: Response) => {
  send(res, await overdueCheques(prisma, asDate(req.query.asOf, new Date())!));
});

router.get('/cheques/:id', async (req: Request, res: Response) => {
  const cheque = await prisma.glCheque.findUnique({
    where: { id: req.params.id },
    include: {
      subsidiary: { select: { code: true, name: true, kind: true } },
      transitions: {
        include: { entry: { select: { serial: true, date: true } } },
        orderBy: { at: 'asc' },
      },
    },
  });
  if (!cheque) throw new AppError(404, 'چک یافت نشد');
  send(res, { ...cheque, nextStates: ALLOWED[cheque.direction][cheque.status] ?? [] });
});

/** دریافت چک از مشتری — طلب تجاری بسته، اسناد دریافتنی باز می‌شود (تسویه نیست) */
router.post('/cheques/receive', async (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.number || !b.bankName || !b.currencyCode || !b.issueDate || !b.dueDate || !b.subsidiaryId || !b.amount) {
    throw new AppError(400, 'شماره، بانک، مبلغ، ارز، تاریخ صدور و سررسید و طرف‌حساب لازم است');
  }
  const date = asDate(b.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const amount = await toMinor(b.amount, String(b.currencyCode));
  const out = await runOp(() => prisma.$transaction((tx) => receiveCheque(tx, {
    fiscalYearId: fy.id, date, createdById: req.user!.id,
    number: String(b.number).trim(), bankName: String(b.bankName).trim(),
    sayadId: b.sayadId ? String(b.sayadId).trim() : null,
    amount, currencyCode: String(b.currencyCode),
    issueDate: asDate(b.issueDate)!, dueDate: asDate(b.dueDate)!,
    subsidiaryId: String(b.subsidiaryId), note: b.note ? String(b.note) : null,
  }), { timeout: 30_000 }));
  send(res, out);
});

/** صدور چک به فروشنده — بدهی تجاری به اسناد پرداختنی تبدیل می‌شود */
router.post('/cheques/issue', async (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.number || !b.bankName || !b.currencyCode || !b.issueDate || !b.dueDate || !b.subsidiaryId || !b.amount) {
    throw new AppError(400, 'شماره، بانک، مبلغ، ارز، تاریخ صدور و سررسید و طرف‌حساب لازم است');
  }
  const date = asDate(b.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const amount = await toMinor(b.amount, String(b.currencyCode));
  const out = await runOp(() => prisma.$transaction((tx) => issueCheque(tx, {
    fiscalYearId: fy.id, date, createdById: req.user!.id,
    number: String(b.number).trim(), bankName: String(b.bankName).trim(),
    sayadId: b.sayadId ? String(b.sayadId).trim() : null,
    amount, currencyCode: String(b.currencyCode),
    issueDate: asDate(b.issueDate)!, dueDate: asDate(b.dueDate)!,
    subsidiaryId: String(b.subsidiaryId), note: b.note ? String(b.note) : null,
  }), { timeout: 30_000 }));
  send(res, out);
});

/** انتقال وضعیت — هر گذار یک سند می‌زند (اجباری‌بودن entryId در schema) */
router.post('/cheques/:id/transition', async (req: Request, res: Response) => {
  const { to, cashAccountCode, endorseToSubsidiaryId } = req.body ?? {};
  if (!to) throw new AppError(400, 'وضعیت مقصد لازم است');
  const date = asDate(req.body?.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const out = await runOp(() => prisma.$transaction((tx) => transitionCheque(tx, {
    fiscalYearId: fy.id, date, createdById: req.user!.id,
    chequeId: req.params.id, to,
    cashAccountCode: cashAccountCode || undefined,
    endorseToSubsidiaryId: endorseToSubsidiaryId || undefined,
  }), { timeout: 30_000 }));
  send(res, out);
});

// ═══════════════════════════════════════════════════════════════
// تنخواه‌گردان — مدل imprest (سقف ثابت؛ شارژ = سقف − مانده)
// ═══════════════════════════════════════════════════════════════

router.get('/petty-cash', async (_req: Request, res: Response) => {
  const funds = await prisma.glPettyCashFund.findMany({
    include: { subsidiary: { select: { code: true, name: true } } },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
  });
  const withBalance = await Promise.all(
    funds.map(async (f) => ({ ...f, balance: (await fundBalance(prisma, f.id)).toString() })),
  );
  send(res, withBalance);
});

router.post('/petty-cash', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { name, subsidiaryId, currencyCode, floatAmount } = req.body ?? {};
  if (!name || !subsidiaryId || !currencyCode || !floatAmount) {
    throw new AppError(400, 'نام، تنخواه‌دار، ارز و سقف صندوق لازم است');
  }
  const amount = await toMinor(floatAmount, String(currencyCode));
  const out = await runOp(() => prisma.$transaction((tx) => createFund(tx, {
    name: String(name).trim(), subsidiaryId: String(subsidiaryId),
    currencyCode: String(currencyCode), floatAmount: amount,
  })));
  send(res, out);
});

/** تخصیص / هزینه / شارژ / تسویه — همه fyِ تاریخ خودشان را می‌گیرند */
async function loadFund(id: string) {
  const fund = await prisma.glPettyCashFund.findUnique({ where: { id } });
  if (!fund) throw new AppError(404, 'صندوق تنخواه یافت نشد');
  return fund;
}

router.post('/petty-cash/:id/allocate', async (req: Request, res: Response) => {
  const fund = await loadFund(req.params.id);
  if (!req.body?.cashAccountCode || !req.body?.amount) throw new AppError(400, 'حساب نقدی و مبلغ لازم است');
  const date = asDate(req.body.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const amount = await toMinor(req.body.amount, fund.currencyCode);
  const out = await runOp(() => prisma.$transaction((tx) => allocate(tx, {
    fiscalYearId: fy.id, date, createdById: req.user!.id,
    fundId: fund.id, cashAccountCode: String(req.body.cashAccountCode), amount,
  }), { timeout: 30_000 }));
  send(res, out);
});

router.post('/petty-cash/:id/expense', async (req: Request, res: Response) => {
  const fund = await loadFund(req.params.id);
  if (!req.body?.amount) throw new AppError(400, 'مبلغ هزینه لازم است');
  const date = asDate(req.body.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const amount = await toMinor(req.body.amount, fund.currencyCode);
  const out = await runOp(() => prisma.$transaction((tx) => recordExpense(tx, {
    fiscalYearId: fy.id, date, createdById: req.user!.id, fundId: fund.id, amount,
    expenseAccountCode: req.body.expenseAccountCode || undefined,
    costCenterId: req.body.costCenterId || null,
    memo: req.body.memo ? String(req.body.memo) : undefined,
  }), { timeout: 30_000 }));
  send(res, out);
});

router.post('/petty-cash/:id/replenish', async (req: Request, res: Response) => {
  const fund = await loadFund(req.params.id);
  if (!req.body?.cashAccountCode) throw new AppError(400, 'حساب نقدی لازم است');
  const date = asDate(req.body.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const out = await runOp(() => prisma.$transaction((tx) => replenish(tx, {
    fiscalYearId: fy.id, date, createdById: req.user!.id,
    fundId: fund.id, cashAccountCode: String(req.body.cashAccountCode),
  }), { timeout: 30_000 }));
  send(res, out);
});

router.post('/petty-cash/:id/settle', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const fund = await loadFund(req.params.id);
  if (!req.body?.cashAccountCode) throw new AppError(400, 'حساب نقدی لازم است');
  const date = asDate(req.body.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const out = await runOp(() => prisma.$transaction((tx) => settle(tx, {
    fiscalYearId: fy.id, date, createdById: req.user!.id,
    fundId: fund.id, cashAccountCode: String(req.body.cashAccountCode),
  }), { timeout: 30_000 }));
  send(res, out);
});

// ═══════════════════════════════════════════════════════════════
// حقوق و دستمزد  (docs/ACCOUNTING_SPEC.md بند ۳-۶)
//
// قاعدهٔ حاکم: هیچ نرخ قانونی در کد نیست. نرخ‌های نسخه‌دار پیش از اولین لیست
// باید وارد شوند، وگرنه `buildRun` با PayrollRateError رد می‌شود.
// ═══════════════════════════════════════════════════════════════

router.get('/payroll/rates', async (req: Request, res: Response) => {
  send(res, await ratesSnapshot(prisma, asDate(req.query.at, new Date())!));
});

router.post('/payroll/rates', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { key, value, validFrom, validTo, note } = req.body ?? {};
  if (!key || value == null || value === '' || !validFrom) {
    throw new AppError(400, 'کلید نرخ، مقدار و تاریخ شروع اعتبار لازم است');
  }
  const validKeys = [...Object.values(RATE_KEYS), ...Object.values(OPTIONAL_RATE_KEYS)] as string[];
  if (!validKeys.includes(String(key))) {
    throw new AppError(400, `کلید نرخ ناشناخته: ${key}`);
  }
  const out = await runOp(() => prisma.$transaction((tx) => setRate(tx, {
    key: key as any, value: String(value),
    validFrom: asDate(validFrom)!, validTo: asDate(validTo) ?? null,
    note: note ? String(note) : undefined,
  })));
  await audit(req, 'RATE_SET', `نرخ حقوق «${key}» = ${value} از ${String(validFrom).slice(0, 10)}`,
    { meta: { key, value: String(value), validFrom, note: note ?? null } });
  send(res, out);
});

router.post('/payroll/tax-brackets', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const { validFrom, validTo, brackets } = req.body ?? {};
  if (!validFrom || !Array.isArray(brackets) || !brackets.length) {
    throw new AppError(400, 'تاریخ شروع اعتبار و حداقل یک پله لازم است');
  }
  const parsed = brackets.map((b: any, i: number) => {
    const rate = Number(b.rate);
    if (!(rate >= 0 && rate <= 1)) {
      throw new AppError(400, `پلهٔ ${i + 1}: نرخ باید بین ۰ و ۱ باشد (۰٫۱ یعنی ۱۰٪)`);
    }
    return {
      from: parseAmount(String(b.from ?? '0'), 0),
      to: b.to === null || b.to === undefined || b.to === '' ? null : parseAmount(String(b.to), 0),
      rate,
    };
  });
  await runOp(() => prisma.$transaction((tx) =>
    setTaxBrackets(tx, asDate(validFrom)!, parsed, asDate(validTo) ?? null)));
  send(res, { ok: true, count: parsed.length });
});

// ── کارکنان — هر کدام یک تفصیلی شناور EMPLOYEE ──
router.get('/payroll/employees', async (_req: Request, res: Response) => {
  const rows = await prisma.glEmployee.findMany({
    include: {
      subsidiary: { select: { code: true } },
      costCenter: { select: { code: true, name: true } },
      _count: { select: { items: true } },
    },
    orderBy: [{ isActive: 'desc' }, { code: 'asc' }],
  });
  send(res, rows);
});

router.post('/payroll/employees', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.code || !b.name || !b.hireDate || !b.baseSalary) {
    throw new AppError(400, 'کد، نام، تاریخ استخدام و حقوق پایه لازم است');
  }
  const out = await runOp(() => prisma.$transaction((tx) => createEmployee(tx, {
    code: String(b.code), name: String(b.name),
    nationalId: b.nationalId ? String(b.nationalId) : null,
    insuranceNo: b.insuranceNo ? String(b.insuranceNo) : null,
    hireDate: asDate(b.hireDate)!, endDate: asDate(b.endDate) ?? null,
    baseSalary: parseAmount(String(b.baseSalary), 0),
    childrenCount: Number(b.childrenCount) || 0,
    isMarried: b.isMarried === true || b.isMarried === 'true',
    costCenterId: b.costCenterId || null,
  })));
  send(res, out);
});

router.patch('/payroll/employees/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if ('name' in b) patch.name = String(b.name);
  if ('nationalId' in b) patch.nationalId = b.nationalId ? String(b.nationalId) : null;
  if ('insuranceNo' in b) patch.insuranceNo = b.insuranceNo ? String(b.insuranceNo) : null;
  if ('hireDate' in b) patch.hireDate = asDate(b.hireDate);
  if ('endDate' in b) patch.endDate = asDate(b.endDate) ?? null;
  if ('baseSalary' in b) patch.baseSalary = parseAmount(String(b.baseSalary), 0);
  if ('childrenCount' in b) patch.childrenCount = Number(b.childrenCount) || 0;
  if ('isMarried' in b) patch.isMarried = b.isMarried === true || b.isMarried === 'true';
  if ('costCenterId' in b) patch.costCenterId = b.costCenterId || null;
  if ('isActive' in b) patch.isActive = b.isActive === true || b.isActive === 'true';
  const out = await runOp(() => prisma.$transaction((tx) => updateEmployee(tx, req.params.id, patch)));
  send(res, out);
});

// ── لیست‌های حقوق ──
router.get('/payroll/runs', async (_req: Request, res: Response) => {
  const runs = await prisma.glPayrollRun.findMany({
    include: { _count: { select: { items: true } }, entry: { select: { serial: true } } },
    orderBy: [{ year: 'desc' }, { month: 'desc' }, { createdAt: 'desc' }],
  });
  const sums = await prisma.glPayrollItem.groupBy({
    by: ['runId'],
    _sum: { grossPay: true, netPay: true, incomeTax: true, insuranceEmployee: true },
  });
  const byRun = new Map(sums.map((s) => [s.runId, s._sum]));
  send(res, runs.map((r) => ({ ...r, totals: byRun.get(r.id) ?? null })));
});

router.get('/payroll/runs/:id', async (req: Request, res: Response) => {
  const run = await prisma.glPayrollRun.findUnique({
    where: { id: req.params.id },
    include: {
      items: { include: { employee: { select: { code: true, name: true } } } },
      entry: { select: { serial: true, date: true, status: true } },
      amends: { select: { id: true, year: true, month: true } },
      amendedBy: { select: { id: true } },
    },
  });
  if (!run) throw new AppError(404, 'لیست حقوق یافت نشد');
  run.items.sort((a, b) => a.employee.code.localeCompare(b.employee.code, 'fa'));
  send(res, run);
});

/** ساخت لیست پیش‌نویس — نرخ‌های همان دوره حل می‌شوند، نه امروز */
router.post('/payroll/runs', async (req: Request, res: Response) => {
  const { year, month, note } = req.body ?? {};
  if (!year || !month) throw new AppError(400, 'سال و ماه شمسی لازم است');
  /**
   * ⚠️ ممیزی دور چهارم (ن۷) — ماه باید ۱ تا ۱۲ باشد.
   *
   * پیش از این هر عددی می‌گذشت. `month: 13` یک لیست حقوق واقعی با شرح
   * «لیست حقوق ۱۴۰۵/۱۳» می‌ساخت و چون تاریخِ آن ماه محاسبه‌شدنی نبود، سند
   * روی **تاریخ امروز** می‌نشست — یعنی یک اشتباه تایپی، حقوق را در ماه غلط
   * ثبت می‌کرد. ماه منفی هم تاریخی در سال مالی قبل می‌ساخت.
   */
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > MONTHS_IN_YEAR) {
    throw new AppError(400, `ماه شمسی باید عددی بین ۱ تا ۱۲ باشد، نه «${month}»`);
  }
  const y = Number(year);
  if (!Number.isInteger(y) || y < 1300 || y > 1500) {
    throw new AppError(400, `سال شمسی نامعتبر است: «${year}»`);
  }
  const rows = parsePayrollRows(req.body?.rows);
  const out = await runOp(() => prisma.$transaction((tx) => buildRun(tx, {
    year: Number(year), month: Number(month), rows, note: note ? String(note) : undefined,
  }), { timeout: 60_000 }));
  send(res, out);
});

router.delete('/payroll/runs/:id', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const run = await prisma.glPayrollRun.findUnique({ where: { id: req.params.id } });
  if (!run) throw new AppError(404, 'لیست حقوق یافت نشد');
  if (run.status !== 'DRAFT') throw new AppError(400, 'فقط لیست پیش‌نویس حذف می‌شود؛ لیست نهایی اصلاحیه می‌گیرد');
  await prisma.glPayrollRun.delete({ where: { id: run.id } });
  send(res, { ok: true });
});

/** نهایی‌کردن — سند از ردیف‌های ذخیره‌شده ساخته می‌شود، نه محاسبهٔ دوباره */
router.post('/payroll/runs/:id/finalize', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const date = asDate(req.body?.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const out = await runOp(() => prisma.$transaction((tx) => finalizeRun(tx, {
    runId: req.params.id, fiscalYearId: fy.id, date, createdById: req.user!.id,
  }), { timeout: 60_000 }));
  send(res, out);
});

/** اصلاح لیست نهایی — سند قبلی برگشت می‌خورد و اصلاحیهٔ پیش‌نویس ساخته می‌شود */
router.post('/payroll/runs/:id/revise', requireRole('SUPER_ADMIN', 'MANAGER'), async (req: Request, res: Response) => {
  const rows = parsePayrollRows(req.body?.rows);
  const out = await runOp(() => prisma.$transaction((tx) => reviseRun(tx, {
    runId: req.params.id, rows,
    note: req.body?.note ? String(req.body.note) : undefined,
    reason: req.body?.reason ? String(req.body.reason) : undefined,
    createdById: req.user!.id,
  }), { timeout: 60_000 }));
  send(res, out);
});

// ── پرداختِ ذخیره‌ها: عیدی / سنوات / مرخصی / تسویه‌حساب (ممیزی ج۱۰) ──
const PROVISION_KINDS: ProvisionKind[] = ['BONUS', 'SEVERANCE', 'LEAVE'];

router.get('/payroll/provisions', async (_req: Request, res: Response) => {
  send(res, await provisionBalances(prisma));
});

router.post('/payroll/provisions/pay', requireRole('SUPER_ADMIN', 'MANAGER'), upload.single('receipt'), async (req: Request, res: Response) => {
  const { kind, amount, cashAccountCode, forWhom, trueUp, description } = req.body ?? {};
  if (!PROVISION_KINDS.includes(String(kind) as ProvisionKind)) {
    throw new AppError(400, 'نوع ذخیره باید BONUS یا SEVERANCE یا LEAVE باشد');
  }
  if (!amount || !cashAccountCode) throw new AppError(400, 'مبلغ و حساب نقدی لازم است');
  const date = asDate(req.body?.date, new Date())!;
  const fy = await activeFiscalYear(date);
  const out = await runOp(() => prisma.$transaction((tx) => payProvision(tx, {
    fiscalYearId: fy.id, date,
    kind: String(kind) as ProvisionKind,
    amount: String(amount),
    cashAccountCode: String(cashAccountCode),
    forWhom: forWhom ? String(forWhom) : undefined,
    trueUp: trueUp === 'true' || trueUp === true,
    description: description ? String(description) : undefined,
    attachmentUrls: receiptUrls(req, 'PROVISION_PAYMENT', { kind: String(kind) }),
    createdById: req.user!.id,
  }), { timeout: 30_000 }));
  await audit(req, 'PROVISION_PAY', `پرداخت ذخیرهٔ ${kind}${forWhom ? ` — ${forWhom}` : ''}`,
    { entryId: (out as any).id, entrySerial: (out as any).serial, meta: { kind, amount: String(amount), trueUp: trueUp === 'true' || trueUp === true } });
  send(res, out);
});

// مدرک، پیوست و مانده افتتاحیه — انطباق با ALIP CORE SPEC (بند ۱۱، ۱۸، ۲۵-۲۷، ۳۰)
registerDocumentRoutes(router, { send, runOp, asDate, requireDate, activeFiscalYear });

export default router;
