/**
 * موتور ثبت — docs/LEDGER_SCHEMA.md بخش ۵ تا ۷
 *
 *   ماژول کسب‌وکار → DraftLine[] → LedgerPoster.post()
 *
 * مسئولیت‌ها، به همین ترتیب:
 *   ۱) گرفتن شمارهٔ سریال قفل‌دار — **اولین** کار تراکنش (ترتیب یکسان ⇒ بدون بن‌بست)
 *   ۲) محاسبهٔ مبلغ پایه از نرخ، در عدد صحیح
 *   ۳) درج سربرگ و ردیف‌ها
 *   ۴) وادار کردن تریگر توازن به قضاوت، همین‌جا داخل تراکنش
 *
 * موتور **هیچ ماندهٔ ذخیره‌شده‌ای را جهش نمی‌دهد** (قاعدهٔ ۳) و هیچ سندی را
 * ویرایش یا حذف نمی‌کند (قاعدهٔ ۴).
 */
import { Prisma, GlEntryType } from '@prisma/client';
import { Minor, Rate, rateFrom, toBase } from './money';

/**
 * هر دو تریگر معوقِ توازن:
 *  - `gl_entry_must_balance`      روی درج/تغییر ردیف
 *  - `gl_entry_balance_on_post`   روی گذار پیش‌نویس → ثبت‌شده
 * هر دو باید با هم شلیک شوند، وگرنه مسیر پیش‌نویس همان حفرهٔ بلعیده‌شدن خطا را دارد.
 */
export const BALANCE_TRIGGERS = ['gl_entry_must_balance', 'gl_entry_balance_on_post'] as const;

export interface DraftLine {
  accountId: string;
  subsidiaryId?: string | null;
  costCenterId?: string | null;
  /// بُعد پروژه — مستقل از مرکز هزینه (بند ۱۰ و ۲۸ ALIP)
  projectId?: string | null;
  currencyCode: string;
  /** دقیقاً یکی از این دو باید مثبت باشد */
  debit?: Minor;
  credit?: Minor;
  /** نرخ به ارز پایه؛ برای خود ارز پایه اختیاری است (۱ فرض می‌شود) */
  rate?: Rate | string | number;
  memo?: string | null;
}

export interface PostInput {
  fiscalYearId: string;
  date: Date;
  description: string;
  entryType?: GlEntryType;
  sourceType?: string | null;
  sourceId?: string | null;
  createdById?: string | null;
  attachmentUrls?: string[];
  lines: DraftLine[];
}

export class LedgerError extends Error {}

/**
 * شمارهٔ سریال بعدی، تراکنشی و بدون شکاف.
 *
 * چرا `FOR UPDATE` روی یک ردیف و نه `SEQUENCE`: sequence غیرتراکنشی است و
 * rollback شماره را برنمی‌گرداند ⇒ شکاف. اینجا افزایش، بخشی از همان تراکنش است.
 *
 * چرا اولین کار: همهٔ ثبت‌ها قفل را به یک ترتیب می‌گیرند، پس بن‌بست ممکن نیست.
 */
export async function nextSerial(tx: Prisma.TransactionClient, fiscalYearId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ next: number }[]>`
    SELECT next FROM "GlSerialCounter" WHERE "fiscalYearId" = ${fiscalYearId} FOR UPDATE
  `;
  if (!rows.length) {
    throw new LedgerError(`شمارندهٔ سریال برای سال مالی ${fiscalYearId} وجود ندارد`);
  }
  const serial = rows[0].next;
  await tx.$executeRaw`
    UPDATE "GlSerialCounter" SET next = next + 1 WHERE "fiscalYearId" = ${fiscalYearId}
  `;
  return serial;
}

/**
 * تریگر توازن را همین‌جا شلیک می‌کند و دوباره معوقش می‌کند.
 *
 * چرا لازم است: تریگر معوق در COMMIT اجرا می‌شود و **Prisma خطای COMMIT را
 * بی‌صدا می‌بلعد** — تراکنش برمی‌گردد ولی فراخوان فکر می‌کند موفق بوده.
 *
 * چرا بلافاصله DEFERRED: حالت IMMEDIATE تا پایان تراکنش می‌ماند؛ بدون بازگردانی،
 * سند **دومِ** همان تراکنش بعد از ردیف اولش ناتراز دیده می‌شود و می‌شکند.
 */
export async function flushBalance(tx: Prisma.TransactionClient): Promise<void> {
  const names = BALANCE_TRIGGERS.map((n) => `"${n}"`).join(', ');
  await tx.$executeRawUnsafe(`SET CONSTRAINTS ${names} IMMEDIATE`);
  await tx.$executeRawUnsafe(`SET CONSTRAINTS ${names} DEFERRED`);
}

interface CurrencyInfo { decimalPlaces: number; isBase: boolean }

async function loadCurrencies(tx: Prisma.TransactionClient) {
  const rows = await tx.glCurrency.findMany({ where: { isActive: true } });
  const map = new Map<string, CurrencyInfo>(
    rows.map((r) => [r.code, { decimalPlaces: r.decimalPlaces, isBase: r.isBase }]),
  );
  const base = rows.find((r) => r.isBase);
  if (!base) throw new LedgerError('هیچ ارز پایه‌ای تعریف نشده است');
  return { map, baseCode: base.code, baseDecimals: base.decimalPlaces };
}

function normalizeRate(raw: DraftLine['rate'], isBaseCurrency: boolean): Rate {
  if (raw === undefined || raw === null) {
    if (!isBaseCurrency) throw new LedgerError('برای ارز غیرپایه، نرخ الزامی است');
    return rateFrom(1);
  }
  return typeof raw === 'object' && 'scaled' in raw ? raw : rateFrom(raw as string | number);
}

/**
 * ثبت یک سند تراز.
 *
 * سند مستقیماً `POSTED` ساخته می‌شود؛ مسیر پیش‌نویس جداست (`createDraft`).
 */
/** ردیف‌ها را برای درج آماده می‌کند (مبلغ پایه، نرخ). گاردهای شکلی هم اینجاست. */
async function prepareLines(tx: Prisma.TransactionClient, rawLines: DraftLine[], opts: { requireBalanced: boolean }) {
  const lines = rawLines.filter((l) => (l.debit ?? 0n) !== 0n || (l.credit ?? 0n) !== 0n);
  if (opts.requireBalanced && lines.length < 2) {
    throw new LedgerError('سند حسابداری حداقل به دو ردیف غیرصفر نیاز دارد');
  }
  for (const [i, l] of lines.entries()) {
    const d = l.debit ?? 0n;
    const c = l.credit ?? 0n;
    if (d < 0n || c < 0n) throw new LedgerError(`ردیف ${i + 1}: مبلغ منفی مجاز نیست`);
    if (d > 0n && c > 0n) throw new LedgerError(`ردیف ${i + 1}: یک ردیف نمی‌تواند همزمان بدهکار و بستانکار باشد`);
  }

  const { map, baseDecimals } = await loadCurrencies(tx);
  const prepared = lines.map((l, i) => {
    const cur = map.get(l.currencyCode);
    if (!cur) throw new LedgerError(`ردیف ${i + 1}: ارز «${l.currencyCode}» تعریف نشده یا غیرفعال است`);
    const rate = normalizeRate(l.rate, cur.isBase);
    const debit = l.debit ?? 0n;
    const credit = l.credit ?? 0n;
    return {
      lineNo: i + 1,
      accountId: l.accountId,
      subsidiaryId: l.subsidiaryId ?? null,
      costCenterId: l.costCenterId ?? null,
      projectId: l.projectId ?? null,
      currencyCode: l.currencyCode,
      debit,
      credit,
      rate: new Prisma.Decimal(rateToDecimalString(rate)),
      debitBase: debit > 0n ? toBase(debit, rate, cur.decimalPlaces, baseDecimals) : 0n,
      creditBase: credit > 0n ? toBase(credit, rate, cur.decimalPlaces, baseDecimals) : 0n,
      memo: l.memo ?? null,
    };
  });

  const diff = prepared.reduce((s, l) => s + l.debitBase - l.creditBase, 0n);
  if (opts.requireBalanced && diff !== 0n) {
    throw new LedgerError(`سند تراز نیست: اختلاف ${diff} (کوچک‌ترین واحد ارز پایه)`);
  }
  return { prepared, diff };
}

export async function post(tx: Prisma.TransactionClient, input: PostInput) {
  // ① قفل سریال — اولین کار
  const serial = await nextSerial(tx, input.fiscalYearId);
  // ② آماده‌سازی و توازن
  const { prepared } = await prepareLines(tx, input.lines, { requireBalanced: true });

  // ③ درج
  const entry = await tx.glEntry.create({
    data: {
      fiscalYearId: input.fiscalYearId,
      serial,
      date: input.date,
      description: input.description,
      entryType: input.entryType ?? 'NORMAL',
      status: 'POSTED',
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      createdById: input.createdById ?? null,
      postedById: input.createdById ?? null,
      postedAt: new Date(),
      attachmentUrls: input.attachmentUrls ?? [],
      lines: { create: prepared },
    },
    include: { lines: true },
  });

  // ④ تریگر باید همین‌جا قضاوت کند، نه در COMMIT
  await flushBalance(tx);
  return entry;
}

// ───────────────────────────────────────────────────────────────
// گردش پیش‌نویس (ممیزی ج۸)
//
// پیش‌نویس سریال نمی‌گیرد و لازم نیست تراز باشد؛ آزادانه ویرایش/حذف می‌شود.
// «نهایی‌کردن» سریال قفل‌دار می‌گیرد، توازن را می‌سنجد و به POSTED می‌برد.
// ───────────────────────────────────────────────────────────────

/** ساخت سند پیش‌نویس — بدون سریال، بدون الزام توازن */
export async function createDraft(tx: Prisma.TransactionClient, input: PostInput) {
  const { prepared } = await prepareLines(tx, input.lines, { requireBalanced: false });
  return tx.glEntry.create({
    data: {
      fiscalYearId: input.fiscalYearId,
      serial: null,
      date: input.date,
      description: input.description,
      entryType: input.entryType ?? 'NORMAL',
      status: 'DRAFT',
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      createdById: input.createdById ?? null,
      attachmentUrls: input.attachmentUrls ?? [],
      lines: { create: prepared },
    },
    include: { lines: true },
  });
}

/** جایگزینی کامل ردیف‌ها و سربرگِ یک پیش‌نویس */
export async function updateDraft(
  tx: Prisma.TransactionClient,
  entryId: string,
  input: Pick<PostInput, 'date' | 'description' | 'lines'> & { entryType?: GlEntryType },
) {
  const src = await tx.glEntry.findUnique({ where: { id: entryId } });
  if (!src) throw new LedgerError('سند یافت نشد');
  if (src.status !== 'DRAFT') throw new LedgerError('فقط پیش‌نویس ویرایش می‌شود');

  const { prepared } = await prepareLines(tx, input.lines, { requireBalanced: false });
  await tx.glLine.deleteMany({ where: { entryId } });
  return tx.glEntry.update({
    where: { id: entryId },
    data: {
      date: input.date, description: input.description,
      ...(input.entryType ? { entryType: input.entryType } : {}),
      lines: { create: prepared },
    },
    include: { lines: true },
  });
}

/** حذف پیش‌نویس */
export async function discardDraft(tx: Prisma.TransactionClient, entryId: string) {
  const src = await tx.glEntry.findUnique({ where: { id: entryId } });
  if (!src) throw new LedgerError('سند یافت نشد');
  if (src.status !== 'DRAFT') throw new LedgerError('فقط پیش‌نویس حذف می‌شود');
  await tx.glLine.deleteMany({ where: { entryId } });
  await tx.glEntry.delete({ where: { id: entryId } });
  return { deleted: entryId };
}

/** نهایی‌کردن پیش‌نویس: سریال + توازن + گذار به POSTED */
export async function postDraft(
  tx: Prisma.TransactionClient,
  entryId: string,
  opts: { createdById?: string | null } = {},
) {
  const src = await tx.glEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
  if (!src) throw new LedgerError('سند یافت نشد');
  if (src.status !== 'DRAFT') throw new LedgerError('این سند پیش‌نویس نیست');
  if (src.lines.length < 2) throw new LedgerError('سند حسابداری حداقل به دو ردیف نیاز دارد');

  const diff = src.lines.reduce((s, l) => s + l.debitBase - l.creditBase, 0n);
  if (diff !== 0n) throw new LedgerError(`سند تراز نیست: اختلاف ${diff} (کوچک‌ترین واحد ارز پایه)`);

  const serial = await nextSerial(tx, src.fiscalYearId);
  const entry = await tx.glEntry.update({
    where: { id: entryId },
    data: {
      status: 'POSTED', serial,
      postedById: opts.createdById ?? src.createdById ?? null,
      postedAt: new Date(),
    },
    include: { lines: true },
  });
  await flushBalance(tx);
  return entry;
}

/**
 * ابطال سند با **سند برگشتی** — تنها راه اصلاح (قاعدهٔ ۴).
 * سند اصلی حذف یا ویرایش نمی‌شود؛ فقط وضعیتش به REVERSED می‌رود.
 */
export async function reverse(
  tx: Prisma.TransactionClient,
  entryId: string,
  opts: { reason: string; date?: Date; createdById?: string | null } = { reason: '' },
) {
  const src = await tx.glEntry.findUnique({ where: { id: entryId }, include: { lines: true } });
  if (!src) throw new LedgerError('سند یافت نشد');
  if (src.status === 'DRAFT') throw new LedgerError('پیش‌نویس سند برگشتی نمی‌خواهد — حذفش کنید');
  if (src.status === 'REVERSED') throw new LedgerError('این سند قبلاً باطل شده است');
  // ممیزی ب۹: سند برگشتی خودش برگشت نمی‌خورد — وگرنه دفتر می‌گوید باطل ولی اعداد برقرارند
  if (src.entryType === 'REVERSING') {
    throw new LedgerError('سند برگشتی را نمی‌توان دوباره برگشت زد؛ برای اصلاح، سند جدید ثبت کنید');
  }

  const serial = await nextSerial(tx, src.fiscalYearId);

  const reversal = await tx.glEntry.create({
    data: {
      fiscalYearId: src.fiscalYearId,
      serial,
      date: opts.date ?? src.date,
      description: `برگشت سند ${src.serial}: ${src.description}`,
      entryType: 'REVERSING',
      status: 'POSTED',
      sourceType: src.sourceType,
      sourceId: src.sourceId,
      reversesId: src.id,
      reversalReason: opts.reason || null,
      createdById: opts.createdById ?? null,
      postedById: opts.createdById ?? null,
      postedAt: new Date(),
      lines: {
        // جای بدهکار و بستانکار عوض می‌شود؛ نرخ عیناً حفظ می‌شود تا خنثی‌سازی دقیق باشد
        create: src.lines.map((l, i) => ({
          lineNo: i + 1,
          accountId: l.accountId,
          subsidiaryId: l.subsidiaryId,
          costCenterId: l.costCenterId,
          projectId: l.projectId,
          currencyCode: l.currencyCode,
          debit: l.credit,
          credit: l.debit,
          rate: l.rate,
          debitBase: l.creditBase,
          creditBase: l.debitBase,
          memo: l.memo,
        })),
      },
    },
    include: { lines: true },
  });

  await tx.glEntry.update({ where: { id: src.id }, data: { status: 'REVERSED' } });
  await flushBalance(tx);

  return reversal;
}

/** نرخ مقیاس‌دار → رشتهٔ اعشاری برای ستون Decimal(24,10) */
function rateToDecimalString(rate: Rate): string {
  const neg = rate.scaled < 0n;
  const abs = neg ? -rate.scaled : rate.scaled;
  const p = 10n ** 10n;
  const s = `${abs / p}.${(abs % p).toString().padStart(10, '0')}`;
  return neg ? `-${s}` : s;
}
