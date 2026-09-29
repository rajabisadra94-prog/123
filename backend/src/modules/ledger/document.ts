/**
 * مدرک — فاکتور دستی، برگشت، و هر ورقهٔ کسب‌وکاری دیگر.
 *
 * انطباق با ALIP CORE SPEC: بند ۱۱ (مدرک) · ۲۶ و ۲۷ (فاکتور خرید و فروش) ·
 * ۲۵ (برگشت از خرید و فروش) · ۳-۷ (چرخهٔ وضعیت) · ۳۰ (پیوست).
 *
 * ─── چرا این ماژول، در کنارِ «صدور فاکتور» و نه به‌جایش ───────────────
 *
 * `Invoice` موجود **الزاماً** به پروژه و قطعه بند است: `projectId` اجباری
 * و هر خطش یک `partId` دارد. یعنی ساخته شده برای فاکتورِ پروژه‌های ساخت.
 * اما شرکت خدمات دیگری هم می‌فروشد که نه پروژه دارند نه قطعه — و آن‌ها
 * امروز فقط با سند دستی ثبت می‌شوند: بدون مدرک، بدون شماره، بدون پیوست،
 * بدون گردش تأیید.
 *
 * پس ماژول «صدور فاکتور» دست‌نخورده می‌ماند و این مسیرِ **دوم** است.
 *
 * ─── چرا خط مدرک `partId` ندارد ───────────────────────────────────────
 *
 * شرکت خدماتی است. اجبار به انتخاب «کالا» برای فروشِ خدمت، کاربر را وادار
 * می‌کند کالای قلابی بسازد — و همان کالای قلابی بعداً در هر گزارشی ظاهر
 * می‌شود. خط مدرک «شرح» دارد و بس.
 */
import { Prisma, GlDocumentKind, GlDocumentStatus } from '@prisma/client';
import { post, DraftLine } from './poster';
import { Minor, parseAmount, rateFrom, Rate } from './money';
import { resolveRate } from './fx';
import { resolveOpenFiscalYear } from './period';

export class DocumentError extends Error {}

/** حساب معینِ کنترلیِ هر جهت — همان‌هایی که تسویه هم می‌شناسد */
const RECEIVABLE = '1104';
const PAYABLE = '2101';
const VAT_OUTPUT = '2107';
const VAT_INPUT = '1109';

/**
 * جهتِ مالیِ هر نوع مدرک.
 *
 * برگشت‌ها دقیقاً وارونهٔ اصلشان‌اند — و همین یعنی لازم نیست منطق جدا
 * بنویسیم؛ فقط علامت عوض می‌شود.
 */
const DIRECTION: Record<GlDocumentKind, 'SALE' | 'PURCHASE' | null> = {
  SALES_INVOICE: 'SALE',
  SALES_RETURN: 'SALE',
  PURCHASE_INVOICE: 'PURCHASE',
  PURCHASE_RETURN: 'PURCHASE',
  RECEIPT_VOUCHER: null,
  PAYMENT_VOUCHER: null,
  OTHER: null,
};

/** برگشت، اثرش وارونهٔ فاکتور است */
const IS_RETURN: Partial<Record<GlDocumentKind, boolean>> = {
  SALES_RETURN: true,
  PURCHASE_RETURN: true,
};

export const KIND_FA: Record<GlDocumentKind, string> = {
  SALES_INVOICE: 'فاکتور فروش',
  PURCHASE_INVOICE: 'فاکتور خرید',
  SALES_RETURN: 'برگشت از فروش',
  PURCHASE_RETURN: 'برگشت از خرید',
  RECEIPT_VOUCHER: 'رسید دریافت',
  PAYMENT_VOUCHER: 'رسید پرداخت',
  OTHER: 'سایر مدارک',
};

export const STATUS_FA: Record<GlDocumentStatus, string> = {
  DRAFT: 'پیش‌نویس',
  SUBMITTED: 'ارسال‌شده',
  APPROVED: 'تأییدشده',
  POSTED: 'ثبت‌شده در دفتر',
  CANCELLED: 'ابطال‌شده',
};

/**
 * گذارهای مجاز — صریح و داده‌ای، مثل چرخهٔ چک.
 *
 * `POSTED` پایانی است: مدرکی که سند خورده دیگر عوض نمی‌شود؛ اصلاحش با
 * برگشتِ سند انجام می‌شود نه با تغییر وضعیت (قاعدهٔ ۳-۲).
 */
export const ALLOWED_TRANSITIONS: Record<GlDocumentStatus, GlDocumentStatus[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['POSTED', 'SUBMITTED', 'CANCELLED'],
  POSTED: [],
  CANCELLED: [],
};

// ───────────────────────────────────────────────────────────────
// شمارهٔ مدرک
// ───────────────────────────────────────────────────────────────

const PREFIX: Record<GlDocumentKind, string> = {
  SALES_INVOICE: 'SI', PURCHASE_INVOICE: 'PI',
  SALES_RETURN: 'SR', PURCHASE_RETURN: 'PR',
  RECEIPT_VOUCHER: 'RV', PAYMENT_VOUCHER: 'PV', OTHER: 'DOC',
};

/**
 * شمارهٔ بعدی برای یک نوع مدرک در یک سال شمسی.
 *
 * قفلِ ردیفی مثل شمارندهٔ سند لازم نیست چون شکاف در شمارهٔ **مدرک** تخلف
 * قانونی نیست (برخلاف شمارهٔ سند حسابداری). یکتایی را قید یکتای
 * `(kind, number)` تضمین می‌کند و در برخورد، دوباره تلاش می‌شود.
 */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient, kind: GlDocumentKind, date: Date,
): Promise<string> {
  const year = date.getUTCFullYear();
  const prefix = `${PREFIX[kind]}-${year}-`;
  const last = await tx.glDocument.findFirst({
    where: { kind, number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  const n = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return prefix + String(n).padStart(4, '0');
}

// ───────────────────────────────────────────────────────────────
// ساخت و ویرایش
// ───────────────────────────────────────────────────────────────

export interface DocumentLineInput {
  description: string;
  quantity?: string | null;
  unitPrice?: string | null;
  amount: string;
  accountCode: string;
  projectId?: string | null;
  costCenterId?: string | null;
}

export interface DocumentInput {
  kind: GlDocumentKind;
  date: Date;
  dueDate?: Date | null;
  subsidiaryId?: string | null;
  projectId?: string | null;
  costCenterId?: string | null;
  currencyCode: string;
  rate?: string | null;
  vatPercent?: number | null;
  description?: string | null;
  notes?: string | null;
  lines: DocumentLineInput[];
  createdById?: string | null;
  /** برای برگشت: مدرکی که این یکی برگشتش است */
  reversesDocumentId?: string | null;
}

async function decimalsOf(tx: Prisma.TransactionClient, code: string): Promise<number> {
  const c = await tx.glCurrency.findUnique({ where: { code } });
  if (!c) throw new DocumentError(`ارز «${code}» تعریف نشده است`);
  return c.decimalPlaces;
}

async function accountByCode(tx: Prisma.TransactionClient, code: string) {
  const a = await tx.glAccount.findUnique({ where: { code } });
  if (!a) throw new DocumentError(`حساب ${code} در چارت نیست`);
  if (!a.isPostable) throw new DocumentError(`حساب ${code} سرگروه است و سند نمی‌گیرد`);
  if (!a.isActive) throw new DocumentError(`حساب ${code} غیرفعال است`);
  return a;
}

export async function createDocument(tx: Prisma.TransactionClient, input: DocumentInput) {
  if (!input.lines.length) throw new DocumentError('مدرک دست‌کم یک خط لازم دارد');

  const fd = await decimalsOf(tx, input.currencyCode);
  const needsParty = DIRECTION[input.kind] !== null;
  if (needsParty && !input.subsidiaryId) {
    throw new DocumentError(`${KIND_FA[input.kind]} بدون طرف‌حساب معنی ندارد`);
  }

  const lines = [];
  let subtotal = 0n;
  for (const [i, l] of input.lines.entries()) {
    if (!l.description?.trim()) throw new DocumentError(`خط ${i + 1}: شرح لازم است`);
    const acc = await accountByCode(tx, l.accountCode);
    const amount = parseAmount(l.amount, fd);
    if (amount <= 0n) throw new DocumentError(`خط ${i + 1}: مبلغ باید بزرگ‌تر از صفر باشد`);
    subtotal += amount;
    lines.push({
      lineNo: i + 1,
      description: l.description.trim(),
      quantity: l.quantity ? new Prisma.Decimal(l.quantity) : null,
      unitPrice: l.unitPrice ? parseAmount(l.unitPrice, fd) : null,
      amount,
      accountId: acc.id,
      projectId: l.projectId || input.projectId || null,
      costCenterId: l.costCenterId || input.costCenterId || null,
    });
  }

  const vatPercent = input.vatPercent ?? 0;
  const vatAmount = vatPercent > 0 ? (subtotal * BigInt(Math.round(vatPercent * 100))) / 10_000n : 0n;

  const rate: Rate = input.rate
    ? rateFrom(input.rate)
    : await resolveRate(tx, input.currencyCode, input.date);

  const number = await nextDocumentNumber(tx, input.kind, input.date);

  const doc = await tx.glDocument.create({
    data: {
      kind: input.kind, status: 'DRAFT', number, date: input.date,
      dueDate: input.dueDate ?? null,
      subsidiaryId: input.subsidiaryId ?? null,
      projectId: input.projectId ?? null,
      costCenterId: input.costCenterId ?? null,
      currencyCode: input.currencyCode,
      rate: new Prisma.Decimal(rateToDecimalString(rate)),
      subtotal, vatAmount, total: subtotal + vatAmount,
      description: input.description ?? null,
      notes: input.notes ?? null,
      reversesDocumentId: input.reversesDocumentId ?? null,
      createdById: input.createdById ?? null,
      lines: { create: lines },
      transitions: { create: [{ toState: 'DRAFT', byId: input.createdById ?? null }] },
    },
    include: { lines: true },
  });
  return doc;
}

/** نرخ مقیاس‌دار → رشتهٔ اعشاری برای ستون Decimal(24,10) */
function rateToDecimalString(r: Rate): string {
  const neg = r.scaled < 0n;
  const abs = neg ? -r.scaled : r.scaled;
  const int = abs / 10_000_000_000n;
  const frac = (abs % 10_000_000_000n).toString().padStart(10, '0');
  return `${neg ? '-' : ''}${int}.${frac}`;
}

// ───────────────────────────────────────────────────────────────
// گذار وضعیت
// ───────────────────────────────────────────────────────────────

export interface TransitionInput {
  documentId: string;
  to: GlDocumentStatus;
  byId?: string | null;
  byName?: string | null;
  note?: string | null;
  /** فقط برای POSTED */
  fiscalYearId?: string;
  postDate?: Date;
}

export async function transitionDocument(tx: Prisma.TransactionClient, input: TransitionInput) {
  const doc = await tx.glDocument.findUnique({
    where: { id: input.documentId },
    include: { lines: { orderBy: { lineNo: 'asc' } } },
  });
  if (!doc) throw new DocumentError('مدرک یافت نشد');

  const allowed = ALLOWED_TRANSITIONS[doc.status];
  if (!allowed.includes(input.to)) {
    throw new DocumentError(
      `گذار «${STATUS_FA[doc.status]}» ← «${STATUS_FA[input.to]}» مجاز نیست. ` +
      (allowed.length
        ? `گذارهای ممکن: ${allowed.map((s) => STATUS_FA[s]).join('، ')}`
        : 'این وضعیت پایانی است'),
    );
  }

  let entryId: string | null = doc.entryId;
  if (input.to === 'POSTED') {
    const entry = await postDocument(tx, doc, input);
    entryId = entry.id;
  }

  const now = new Date();
  const updated = await tx.glDocument.update({
    where: { id: doc.id },
    data: {
      status: input.to,
      entryId,
      ...(input.to === 'SUBMITTED' ? { submittedAt: now } : {}),
      ...(input.to === 'APPROVED' ? { approvedAt: now, approvedById: input.byId ?? null } : {}),
      ...(input.to === 'POSTED' ? { postedAt: now } : {}),
      ...(input.to === 'CANCELLED' ? { cancelledAt: now, cancelReason: input.note ?? null } : {}),
      transitions: {
        create: [{
          fromState: doc.status, toState: input.to,
          byId: input.byId ?? null, byName: input.byName ?? null, note: input.note ?? null,
        }],
      },
    },
    include: { lines: true, transitions: { orderBy: { at: 'desc' } } },
  });
  return updated;
}

/**
 * ثبت مدرک در دفتر کل.
 *
 * فاکتور فروش:   بد ۱۱۰۴ دریافتنی (کل با مالیات) / بس درآمدها + بس ۲۱۰۷
 * فاکتور خرید:   بد هزینه‌ها + بد ۱۱۰۹ / بس ۲۱۰۱ پرداختنی
 * برگشت‌ها:      دقیقاً وارونه
 *
 * ابعاد (پروژه و مرکز هزینه) از خطِ مدرک به ردیف سند منتقل می‌شوند —
 * همان چیزی که تا امروز ممکن نبود.
 */
async function postDocument(
  tx: Prisma.TransactionClient,
  doc: Prisma.GlDocumentGetPayload<{ include: { lines: true } }>,
  input: TransitionInput,
) {
  const dir = DIRECTION[doc.kind];
  if (!dir) throw new DocumentError(`${KIND_FA[doc.kind]} سند حسابداری نمی‌سازد`);
  if (!doc.subsidiaryId) throw new DocumentError('طرف‌حساب مدرک خالی است');

  const date = input.postDate ?? doc.date;
  const fy = input.fiscalYearId
    ? { id: input.fiscalYearId }
    : await resolveOpenFiscalYear(tx, date);

  const isSale = dir === 'SALE';
  const isReturn = IS_RETURN[doc.kind] === true;
  /** فاکتور و برگشتش وارونهٔ هم‌اند */
  const flip = isReturn;

  const control = await accountByCode(tx, isSale ? RECEIVABLE : PAYABLE);
  const vatAcc = await accountByCode(tx, isSale ? VAT_OUTPUT : VAT_INPUT);
  const rate = rateFrom(doc.rate.toString());

  const lines: DraftLine[] = [];

  /** سمت طرف‌حساب — کل مبلغ با مالیات */
  const controlOnDebit = isSale !== flip;
  lines.push({
    accountId: control.id,
    subsidiaryId: doc.subsidiaryId,
    currencyCode: doc.currencyCode,
    ...(controlOnDebit ? { debit: doc.total } : { credit: doc.total }),
    rate,
    memo: `${KIND_FA[doc.kind]} ${doc.number}`,
  });

  /** خطوط درآمد/هزینه — هر کدام با ابعاد خودش */
  for (const l of doc.lines) {
    const lineOnDebit = !isSale !== flip;
    lines.push({
      accountId: l.accountId,
      costCenterId: l.costCenterId,
      projectId: l.projectId,
      currencyCode: doc.currencyCode,
      ...(lineOnDebit ? { debit: l.amount } : { credit: l.amount }),
      rate,
      memo: l.description,
    });
  }

  if (doc.vatAmount > 0n) {
    const vatOnDebit = !isSale !== flip;
    lines.push({
      accountId: vatAcc.id,
      currencyCode: doc.currencyCode,
      ...(vatOnDebit ? { debit: doc.vatAmount } : { credit: doc.vatAmount }),
      rate,
      memo: 'مالیات بر ارزش افزوده',
    });
  }

  return post(tx, {
    fiscalYearId: fy.id,
    date,
    description: doc.description || `${KIND_FA[doc.kind]} ${doc.number}`,
    entryType: 'NORMAL',
    sourceType: 'Document',
    sourceId: doc.id,
    createdById: input.byId ?? null,
    lines,
  });
}

// ───────────────────────────────────────────────────────────────
// برگشت
// ───────────────────────────────────────────────────────────────

const RETURN_OF: Partial<Record<GlDocumentKind, GlDocumentKind>> = {
  SALES_INVOICE: 'SALES_RETURN',
  PURCHASE_INVOICE: 'PURCHASE_RETURN',
};

/**
 * ساخت مدرکِ برگشت از روی فاکتور اصلی.
 *
 * خطوط کپی می‌شوند تا کاربر بتواند مبلغ را کم کند (برگشت جزئی رایج است).
 * برگشت، فاکتور اصلی را دست نمی‌زند — همان قاعدهٔ «سند ثبت‌شده حذف نمی‌شود».
 */
export async function createReturn(
  tx: Prisma.TransactionClient,
  sourceDocumentId: string,
  input: { date: Date; lines?: DocumentLineInput[]; description?: string | null; createdById?: string | null },
) {
  const src = await tx.glDocument.findUnique({
    where: { id: sourceDocumentId },
    include: { lines: { orderBy: { lineNo: 'asc' }, include: { account: true } }, returnDocument: true },
  });
  if (!src) throw new DocumentError('فاکتور اصلی یافت نشد');

  const kind = RETURN_OF[src.kind];
  if (!kind) throw new DocumentError(`${KIND_FA[src.kind]} برگشت‌پذیر نیست`);
  if (src.status !== 'POSTED') throw new DocumentError('فقط فاکتورِ ثبت‌شده برگشت می‌خورد');
  if (src.returnDocument) throw new DocumentError(`این فاکتور قبلاً برگشت خورده (${src.returnDocument.number})`);

  const lines: DocumentLineInput[] = input.lines?.length
    ? input.lines
    : src.lines.map((l) => ({
        description: l.description,
        amount: l.amount.toString(),
        accountCode: l.account.code,
        projectId: l.projectId,
        costCenterId: l.costCenterId,
      }));

  const vatPercent = src.subtotal > 0n
    ? Number((src.vatAmount * 10_000n) / src.subtotal) / 100
    : 0;

  return createDocument(tx, {
    kind, date: input.date,
    subsidiaryId: src.subsidiaryId,
    projectId: src.projectId,
    costCenterId: src.costCenterId,
    currencyCode: src.currencyCode,
    rate: src.rate.toString(),
    vatPercent,
    description: input.description ?? `برگشت ${KIND_FA[src.kind]} ${src.number}`,
    lines,
    createdById: input.createdById,
    reversesDocumentId: src.id,
  });
}

// ───────────────────────────────────────────────────────────────
// مانده افتتاحیه — بند ۱۸
// ───────────────────────────────────────────────────────────────

export interface OpeningLineInput {
  accountCode: string;
  subsidiaryId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
  currencyCode: string;
  debit?: string | null;
  credit?: string | null;
  rate?: string | null;
  memo?: string | null;
}

/**
 * ثبت مانده افتتاحیه.
 *
 * ⚠️ بند ۱۸ spec: «مانده افتتاحیه باید مثل بقیهٔ ثبت‌ها وارد دفتر کل شود؛
 * سازوکار موازی ساخته نشود.» پیش از این، نوع سند `OPENING` تعریف شده بود
 * ولی **فقط ابزار مهاجرت** آن را می‌ساخت و کاربر هیچ مسیری نداشت.
 *
 * تنها تفاوتش با سند دستی، `entryType` است — که باعث می‌شود گزارش‌های
 * دوره‌ای بتوانند کنارش بگذارند.
 */
export async function postOpeningBalance(
  tx: Prisma.TransactionClient,
  input: {
    fiscalYearId: string; date: Date; description?: string | null;
    lines: OpeningLineInput[]; createdById?: string | null;
  },
) {
  if (input.lines.length < 2) throw new DocumentError('مانده افتتاحیه دست‌کم دو ردیف لازم دارد');

  const existing = await tx.glEntry.findFirst({
    where: { fiscalYearId: input.fiscalYearId, entryType: 'OPENING', status: { not: 'REVERSED' } },
    select: { serial: true },
  });
  if (existing) {
    throw new DocumentError(
      `این سال مالی از قبل سند افتتاحیه دارد (سند ${existing.serial}). ` +
      'برای اصلاح، آن را باطل کنید و دوباره ثبت کنید.',
    );
  }

  const currencies = new Map(
    (await tx.glCurrency.findMany()).map((c) => [c.code, c.decimalPlaces] as const),
  );

  const lines: DraftLine[] = [];
  for (const [i, l] of input.lines.entries()) {
    const fd = currencies.get(l.currencyCode);
    if (fd === undefined) throw new DocumentError(`ردیف ${i + 1}: ارز نامعتبر`);
    const acc = await accountByCode(tx, l.accountCode);
    const debit = l.debit ? parseAmount(l.debit, fd) : 0n;
    const credit = l.credit ? parseAmount(l.credit, fd) : 0n;
    if (debit > 0n === credit > 0n) {
      throw new DocumentError(`ردیف ${i + 1}: دقیقاً یکی از بدهکار یا بستانکار باید مبلغ داشته باشد`);
    }
    lines.push({
      accountId: acc.id,
      subsidiaryId: l.subsidiaryId ?? null,
      costCenterId: l.costCenterId ?? null,
      projectId: l.projectId ?? null,
      currencyCode: l.currencyCode,
      ...(debit > 0n ? { debit } : { credit }),
      rate: l.rate ? rateFrom(l.rate) : (l.currencyCode === 'IRR' ? undefined : await resolveRate(tx, l.currencyCode, input.date)),
      memo: l.memo ?? null,
    });
  }

  return post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.date,
    description: input.description || 'مانده افتتاحیه',
    entryType: 'OPENING',
    sourceType: 'OpeningBalance',
    createdById: input.createdById ?? null,
    lines,
  });
}

export type { Minor };
