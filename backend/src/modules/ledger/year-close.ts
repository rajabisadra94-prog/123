/**
 * بستن سال مالی — سند اختتامیه و انتقال سود به سود انباشته.
 *
 * ممیزی ب۲: `GlEntryType.CLOSING` و `closedAt` تعریف شده بودند ولی هیچ کدی
 * آن‌ها را نمی‌نوشت. بدون این، حساب‌های موقت (گروه ۴–۸) هرگز صفر نمی‌شوند و
 * سال بعد با ماندهٔ آلوده شروع می‌کند.
 *
 * اصول:
 *   • **اختتامیه فقط به ارز پایه.** حساب‌های موقت جریان دوره‌اند، نه موضع ارزی؛
 *     به ماندهٔ ریالی‌شان به «سود و زیان انباشته» (۳۱۰۲) بسته می‌شوند.
 *   • **حساب‌های دائمی دست نمی‌خورند.** توضیحش پایین‌تر.
 *   • **برگشت‌پذیر.** بستن پیش از رسیدگی مالیاتی همیشه اصلاح می‌خورد.
 *
 * ─────────────────────────────────────────────────────────────
 * ⚠️ چرا **سند افتتاحیهٔ سال بعد ثبت نمی‌شود** (ممیزی دوم — ن۱)
 *
 * نسخهٔ اول این ماژول، ماندهٔ حساب‌های دائمی را در سند `OPENING` سال بعد دوباره
 * ثبت می‌کرد. نتیجه‌اش **دو برابر شدن هر ماندهٔ دائمی** بود: ترازنامهٔ آخرین روز
 * ۱۴۰۵ دارایی ۷۷٬۳۵۸٬۴۸۲٬۰۳۸ می‌داد و اولین روز ۱۴۰۶ دقیقاً دو برابرش.
 *
 * دلیل ساختاری است، نه یک اشتباه محاسباتی: **این دفتر، دفترِ سالانه نیست.**
 * هیچ گزارشی در این سامانه به سال مالی محدود نمی‌شود — همه `e.date <= asOf` اند.
 * سند افتتاحیه در دفترداری کلاسیک وجود دارد چون دفترِ هر سال از صفر شروع می‌شود؛
 * این دفتر هرگز صفر نمی‌شود، پس ماندهٔ دائمی خودبه‌خود منتقل می‌شود و ثبت دوبارهٔ
 * آن، **تعریفاً** دوباره‌شماری است.
 *
 * خطر واقعی‌اش هم فقط ترازنامه نبود: `previewRevaluation`، `positionBalance`،
 * `aging`، `fundBalance` تنخواه و صورت مغایرت بانکی همگی تجمعی‌اند و همه دو برابر
 * می‌شدند — یعنی سود تسعیر ساختگی هم تولید می‌شد. و چون `permanentPositions`
 * خودش وضعیتِ تجمعی را می‌خواند، بستنِ سالِ بعد ۴ برابر می‌ساخت و همین‌طور تصاعدی.
 *
 * اگر روزی گزارش‌ها به سال مالی محدود شدند، سند افتتاحیه باید **همراه با**
 * صفرکردنِ حساب‌های دائمی در اختتامیه برگردد — نه به‌تنهایی.
 * ─────────────────────────────────────────────────────────────
 */
import { Prisma } from '@prisma/client';
import { post, reverse } from './poster';
import { baseCurrency } from './fx';

const RETAINED_EARNINGS = '3102';   // سود و زیان انباشته
export const YEAR_CLOSE_SOURCE = 'YearClose';
const SOURCE = YEAR_CLOSE_SOURCE;

/**
 * کنارگذاشتنِ **تمامِ** ماشینِ بستن سال از گزارش‌های دوره‌ای — سند اختتامیه، سند
 * افتتاحیهٔ به‌جامانده از نسخهٔ قدیمی، و سندهای برگشتیِ هر دو.
 *
 * چرا فقط `sourceType` و نه ترکیبش با `entryType` (ممیزی ن۱-ب، دور دوم):
 *
 * `reverse()` در `poster.ts` مقدار `sourceType` را از سند مبدأ **کپی** می‌کند
 * ولی `entryType` را `REVERSING` می‌گذارد. پس آینهٔ سند اختتامیه
 * `('REVERSING', 'YearClose')` است. فیلترِ اولِ این رفع فقط `('CLOSING','YearClose')`
 * را می‌گرفت، و نتیجه‌اش این بود: پس از **بازکردن** سال، سند اختتامیه کنار
 * گذاشته می‌شد ولی آینه‌اش نه — و چون آینه، نقیضِ نقیضِ فعالیت است، صورت سود و
 * زیان دقیقاً **دو برابر** می‌شد (درآمد ۶۰۰٬۰۰۰٬۰۰۰ ⟵ ۱٬۲۰۰٬۰۰۰٬۰۰۰).
 * دقیقاً همان خانوادهٔ باگی که این رفع برای درمانش نوشته شده بود.
 *
 * بازکردنِ سال حالتِ حاشیه‌ای نیست: تنها مسیرِ برنامه‌ای برای اصلاح سال‌هایی است
 * که با نسخهٔ باگ‌دار بسته شده‌اند، پس هر سایتی که ن۱ را درمان می‌کند از همین
 * حالت رد می‌شود.
 *
 * `sourceType` به‌تنهایی هم **جعل‌ناپذیرتر** است: کاربر می‌تواند `entryType` سند
 * دستی را تعیین کند، ولی `sourceType` در آن مسیر هاردکد `'Manual'` است.
 *
 * `IS DISTINCT FROM` عمدی است، نه `<>`: `sourceType` می‌تواند NULL باشد و
 * مقایسهٔ معمولی با NULL نتیجهٔ NULL می‌دهد که ردیف را بی‌صدا حذف می‌کند.
 *
 * ⚠️ فرضِ نامِ مستعار: پرس‌وجو باید جدول سند را `e` صدا بزند.
 */
export const EXCLUDE_YEAR_CLOSE = Prisma.sql`
  AND e."sourceType" IS DISTINCT FROM ${YEAR_CLOSE_SOURCE}`;

export class YearCloseError extends Error {}

/**
 * یک ردیفِ ماندهٔ موقت — به تفکیکِ **ابعادِ** ردیف، نه فقط حساب.
 *
 * چرا مرکز هزینه و تفصیلی هم در کلید گروه‌بندی‌اند: حساب‌هایی مثل
 * «۶۱۰۱ حقوق و دستمزد» مرکز هزینهٔ اجباری دارند و تریگر `gl_line_rules`
 * ردیفِ بدون مرکز را رد می‌کند. اگر اختتامیه فقط بر اساس حساب جمع بزند،
 * ردیف‌هایش بی‌مرکز می‌شوند و **کلِ بستن سال شکست می‌خورد** — روی هر دفتری
 * که حقوق دارد. (ممیزی دوم؛ با دادهٔ واقعی روی نسخهٔ آزمایشی مچ شد، نه با
 * تست واحد که فقط حساب‌های بی‌بُعد را می‌بست.)
 *
 * جانبیِ درست: بُعدِ مرکز هزینه در گذارِ سال حفظ می‌شود.
 */
interface TempRow {
  id: string; code: string; name: string;
  costCenterId: string | null; subsidiaryId: string | null;
  base: bigint;
}

async function loadFiscalYear(tx: Prisma.TransactionClient, id: string) {
  const fy = await tx.glFiscalYear.findUnique({ where: { id } });
  if (!fy) throw new YearCloseError('سال مالی یافت نشد');
  return fy;
}

/** ماندهٔ ریالیِ هر حساب موقتِ برگ در این سال مالی، به تفکیک ابعاد ردیف */
async function temporaryBalances(tx: Prisma.TransactionClient, fiscalYearId: string): Promise<TempRow[]> {
  return tx.$queryRaw<TempRow[]>`
    SELECT a.id, a.code, a.name,
           l."costCenterId", l."subsidiaryId",
           (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS base
    FROM "GlLine" l
    JOIN "GlEntry" e   ON e.id = l."entryId"
    JOIN "GlAccount" a ON a.id = l."accountId"
    WHERE e."fiscalYearId" = ${fiscalYearId}
      AND e.status <> 'DRAFT'
      AND a."isPostable" = true
      AND a."rootType"::text IN ('INCOME', 'EXPENSE')
      ${EXCLUDE_YEAR_CLOSE}
    GROUP BY a.id, a.code, a.name, l."costCenterId", l."subsidiaryId"
    HAVING SUM(l."debitBase") - SUM(l."creditBase") <> 0
    ORDER BY a.code
  `;
}

export interface YearClosePreview {
  fiscalYear: { id: string; title: string; startDate: Date; endDate: Date; closedAt: Date | null };
  temporaryAccounts: { code: string; name: string; base: string }[];
  totalIncome: string;
  totalExpense: string;
  netProfit: string;   // منفی = زیان
  alreadyClosed: boolean;
  /** کارهای باقی‌مانده پیش از بستن سال (ممیزی ب۸) */
  checklist: ChecklistItem[];
  /** هیچ کارِ ناتمامی نمانده */
  readyToClose: boolean;
}

export interface ChecklistItem {
  key: string;
  title: string;
  status: 'DONE' | 'TODO';
  detail: string;
  action: string | null;
}

const INCOME_TAX_EXPENSE = '8205';    // مالیات بر درآمد
const INCOME_TAX_PROVISION = '2112';  // ذخیرهٔ مالیات بر درآمد
const LEGAL_RESERVE = '3103';         // اندوختهٔ قانونی
const CAPITAL = '3101';               // سرمایه
/** نرخ مالیات اشخاص حقوقی — مادهٔ ۱۰۵ قانون مالیات‌های مستقیم */
const CORPORATE_TAX_PERCENT = 25n;

/**
 * چک‌لیست پیش از بستن سال — قرینهٔ چک‌لیست پایان ماه.
 *
 * ⚠️ ممیزی ب۸ — چرا لازم شد: بستن سال هیچ کنترلی نداشت. سودِ دوره مستقیم به
 * «سود و زیان انباشته» می‌رفت، بدون یک ریال ذخیرهٔ مالیات بر درآمد و بدون
 * اندوختهٔ قانونی — با اینکه هر دو حساب در چارت هستند و گزارش اندوختهٔ قانونی
 * هم عدد درست را می‌داد. حقوق صاحبان سهام به‌اندازهٔ کلِ مالیات بیش‌نمایی
 * می‌شد و صورت سود و زیان مالیات صفر گزارش می‌کرد.
 *
 * چک‌لیست پایان ماه هشت کنترل داشت و خوب کار می‌کرد؛ بستن سال هیچ.
 */
export async function closeChecklist(
  tx: Prisma.TransactionClient,
  fy: { id: string; startDate: Date; endDate: Date },
  netProfit: bigint,
): Promise<ChecklistItem[]> {
  const balanceOf = async (code: string): Promise<bigint> => {
    const rows = await tx.$queryRaw<{ bal: bigint | null }[]>`
      SELECT COALESCE(SUM(l."debitBase" - l."creditBase"), 0)::bigint AS bal
      FROM "GlLine" l
      JOIN "GlEntry" e   ON e.id = l."entryId"
      JOIN "GlAccount" a ON a.id = l."accountId"
      WHERE a.code = ${code} AND e.status <> 'DRAFT'
        AND e.date >= ${fy.startDate} AND e.date <= ${fy.endDate}
        ${EXCLUDE_YEAR_CLOSE}
    `;
    return rows[0]?.bal ?? 0n;
  };

  const drafts = await tx.glEntry.count({ where: { fiscalYearId: fy.id, status: 'DRAFT' } });

  const taxBooked = await balanceOf(INCOME_TAX_EXPENSE);
  const expectedTax = netProfit > 0n ? (netProfit * CORPORATE_TAX_PERCENT) / 100n : 0n;
  const taxDone = netProfit <= 0n || taxBooked > 0n;

  // اندوختهٔ قانونی: ۵٪ سود تا سقف ۱۰٪ سرمایه (مادهٔ ۲۳۸ قانون تجارت)
  const reserve = -(await balanceOf(LEGAL_RESERVE));
  const capital = -(await balanceOf(CAPITAL));
  const headroom = capital / 10n > reserve ? capital / 10n - reserve : 0n;
  const fivePercent = netProfit > 0n ? netProfit / 20n : 0n;
  const suggested = fivePercent < headroom ? fivePercent : headroom;

  return [
    {
      key: 'drafts',
      title: 'پیش‌نویس‌های نهایی‌نشده',
      status: drafts === 0 ? 'DONE' : 'TODO',
      detail: drafts === 0
        ? 'پیش‌نویسی در این سال نمانده'
        : `${drafts} پیش‌نویس باز است — پیش از بستن سال نهایی یا حذفشان کنید`,
      action: drafts === 0 ? null : 'اسناد ← پیش‌نویس‌ها',
    },
    {
      key: 'income-tax',
      title: 'ذخیرهٔ مالیات بر درآمد',
      status: taxDone ? 'DONE' : 'TODO',
      detail: netProfit <= 0n
        ? 'سود مشمولی نیست'
        : taxBooked > 0n
          ? `${taxBooked.toString()} ریال ثبت شده`
          : `چیزی ثبت نشده — با نرخ ${CORPORATE_TAX_PERCENT}٪ حدود ${expectedTax.toString()} ریال `
            + `(بدهکار ${INCOME_TAX_EXPENSE} / بستانکار ${INCOME_TAX_PROVISION}). `
            + 'بدون آن، سود انباشته به همین اندازه بیش‌نمایی می‌شود.',
      action: taxDone ? null : 'اسناد ← سند دستی',
    },
    {
      key: 'legal-reserve',
      title: 'اندوختهٔ قانونی',
      status: suggested === 0n ? 'DONE' : 'TODO',
      detail: suggested === 0n
        ? 'الزامی نیست — یا سودی نیست یا اندوخته به سقف ده درصد سرمایه رسیده'
        : `${suggested.toString()} ریال قابل انتقال به اندوخته (مادهٔ ۲۳۸ قانون تجارت)`,
      action: suggested === 0n ? null : 'پایان دوره ← اندوختهٔ قانونی',
    },
  ];
}

export async function previewYearClose(
  tx: Prisma.TransactionClient,
  fiscalYearId: string,
): Promise<YearClosePreview> {
  const fy = await loadFiscalYear(tx, fiscalYearId);
  const temps = await temporaryBalances(tx, fiscalYearId);

  // ردیف‌ها به تفکیک بُعد می‌آیند؛ برای نمایش، به تفکیک حساب جمع می‌شوند
  const byAccount = new Map<string, { code: string; name: string; base: bigint }>();
  for (const t of temps) {
    const cur = byAccount.get(t.code) ?? { code: t.code, name: t.name, base: 0n };
    cur.base += t.base;
    byAccount.set(t.code, cur);
  }

  let income = 0n, expense = 0n;
  for (const a of byAccount.values()) {
    if (a.base < 0n) income += -a.base;   // درآمد ماهیت بستانکار ⇒ base منفی
    else expense += a.base;
  }

  const checklist = await closeChecklist(tx, fy, income - expense);

  return {
    fiscalYear: { id: fy.id, title: fy.title, startDate: fy.startDate, endDate: fy.endDate, closedAt: fy.closedAt },
    temporaryAccounts: [...byAccount.values()]
      .filter((a) => a.base !== 0n)
      .sort((x, y) => x.code.localeCompare(y.code))
      .map((a) => ({ code: a.code, name: a.name, base: a.base.toString() })),
    totalIncome: income.toString(),
    totalExpense: expense.toString(),
    netProfit: (income - expense).toString(),
    alreadyClosed: fy.closedAt != null,
    checklist,
    readyToClose: checklist.every((c) => c.status === 'DONE'),
  };
}

export interface CloseInput {
  fiscalYearId: string;
  createdById?: string | null;
  /**
   * چک‌لیست پیش از بستن را آگاهانه بپذیر (ممیزی ب۸).
   *
   * بستن سال با کارِ ناتمام رد می‌شود مگر کاربر صریحاً تأیید کند — مثلاً
   * وقتی ذخیرهٔ مالیات را جای دیگری نگه می‌دارد. پیش‌فرض، رد کردن است.
   */
  acknowledgeChecklist?: boolean;
}

/**
 * سند اختتامیه: هر حساب موقت به ماندهٔ ریالی‌اش صفر می‌شود، خالص به ۳۱۰۲.
 *
 * حساب‌های دائمی دست نمی‌خورند و سند افتتاحیه‌ای هم ثبت نمی‌شود — دلیلش در
 * توضیح بالای همین پرونده است (ممیزی ن۱).
 */
export async function closeFiscalYear(tx: Prisma.TransactionClient, input: CloseInput) {
  const fy = await loadFiscalYear(tx, input.fiscalYearId);
  if (fy.closedAt) throw new YearCloseError(`سال مالی «${fy.title}» از قبل بسته شده است`);

  const base = await baseCurrency(tx);
  const temps = await temporaryBalances(tx, fy.id);
  if (!temps.length) throw new YearCloseError('هیچ حساب موقتی با مانده نیست — چیزی برای بستن وجود ندارد');

  const retained = await tx.glAccount.findUnique({ where: { code: RETAINED_EARNINGS } });
  if (!retained) throw new YearCloseError(`حساب «${RETAINED_EARNINGS} سود و زیان انباشته» در چارت نیست`);

  // ممیزی ب۸: کارِ ناتمامِ پایان سال، سال را نمی‌بندد مگر با پذیرش صریح
  if (!input.acknowledgeChecklist) {
    const profit = -temps.reduce((s, t) => s + t.base, 0n);   // base مثبت = هزینه
    const todo = (await closeChecklist(tx, fy, profit)).filter((c) => c.status === 'TODO');
    if (todo.length) {
      const list = todo.map((c) => `${c.title} (${c.detail})`).join('؛ ');
      throw new YearCloseError(
        `پیش از بستن سال ${todo.length} کار مانده — ${list}. `
        + 'اگر آگاهانه می‌خواهید بدون این‌ها ببندید، گزینهٔ پذیرش را فعال کنید.',
      );
    }
  }

  // ── سند اختتامیه (فقط ارز پایه) ──
  // هر ردیف، ابعادِ خودش را با خود می‌برد — وگرنه تریگرِ «مرکز هزینهٔ اجباری»
  // کلِ سند را رد می‌کند و سال هرگز بسته نمی‌شود.
  const closingLines: any[] = temps.map((t) => ({
    accountId: t.id,
    costCenterId: t.costCenterId,
    subsidiaryId: t.subsidiaryId,
    currencyCode: base.code,
    ...(t.base > 0n ? { credit: t.base } : { debit: -t.base }),
    memo: `بستن ${t.code} ${t.name}`,
  }));

  const net = temps.reduce((s, t) => s + t.base, 0n);   // خالص = هزینه − درآمد = −سود
  closingLines.push({
    accountId: retained.id,
    currencyCode: base.code,
    ...(net < 0n ? { credit: -net } : { debit: net }),
    memo: net < 0n ? 'سود دورهٔ منتقل‌شده' : 'زیان دورهٔ منتقل‌شده',
  });

  const closingEntry = await post(tx, {
    fiscalYearId: fy.id,
    date: fy.endDate,
    description: `سند اختتامیه ${fy.title}`,   // `title` خودش «سال مالی ۱۴۰۵» است
    entryType: 'CLOSING',
    sourceType: SOURCE,
    sourceId: fy.id,
    createdById: input.createdById ?? null,
    lines: closingLines,
  });

  const closed = await tx.glFiscalYear.update({
    where: { id: fy.id }, data: { closedAt: new Date() },
  });

  // `openingEntry` عمداً همیشه null است و در پاسخ می‌ماند تا کلاینت قدیمی نشکند
  return { fiscalYear: closed, closingEntry, openingEntry: null, netProfit: (-net).toString() };
}

/**
 * بازکردن سال مالیِ بسته — سند اختتامیه با سند برگشتی خنثی و `closedAt` پاک
 * می‌شود. ترتیب مهم است: اول `closedAt` را برمی‌داریم وگرنه تریگر، سند برگشتی
 * را در سالِ بسته رد می‌کند.
 *
 * ⚠️ **شاخهٔ `opening` عمداً می‌ماند — سازگاری با گذشته.** نسخهٔ جدید دیگر سند
 * افتتاحیه نمی‌سازد (ن۱)، ولی سال‌هایی که با نسخهٔ باگ‌دار بسته شده‌اند یکی
 * دارند و **این تنها مسیر برنامه‌ای برای خنثی‌کردن آن است**. اگر این شاخه حذف
 * شود، ماندهٔ دوبرابرشدهٔ آن سال‌ها از راه برنامه قابل اصلاح نخواهد بود.
 */
export async function reopenFiscalYear(
  tx: Prisma.TransactionClient,
  input: { fiscalYearId: string; reason?: string; createdById?: string | null },
) {
  const fy = await loadFiscalYear(tx, input.fiscalYearId);
  if (!fy.closedAt) throw new YearCloseError(`سال مالی «${fy.title}» بسته نیست`);

  const closing = await tx.glEntry.findFirst({
    where: { fiscalYearId: fy.id, entryType: 'CLOSING', sourceType: SOURCE, status: { not: 'REVERSED' } },
  });
  const opening = await tx.glEntry.findFirst({
    where: { entryType: 'OPENING', sourceType: SOURCE, sourceId: fy.id, status: { not: 'REVERSED' } },
  });

  if (opening) {
    const nextFy = await tx.glFiscalYear.findUnique({ where: { id: opening.fiscalYearId } });
    const others = await tx.glEntry.count({
      where: { fiscalYearId: opening.fiscalYearId, id: { not: opening.id }, status: { not: 'REVERSED' } },
    });
    if (others > 0) {
      throw new YearCloseError(
        `سال مالی «${nextFy?.title}» ${others} سند دیگر دارد — پیش از بازکردن، آن‌ها را بررسی کنید`,
      );
    }
  }

  await tx.glFiscalYear.update({ where: { id: fy.id }, data: { closedAt: null } });

  const reason = input.reason || 'بازکردن سال مالی';
  const reversedClosing = closing
    ? await reverse(tx, closing.id, { reason, createdById: input.createdById ?? null })
    : null;
  const reversedOpening = opening
    ? await reverse(tx, opening.id, { reason, createdById: input.createdById ?? null })
    : null;

  return { fiscalYear: { ...fy, closedAt: null }, reversedClosing, reversedOpening };
}
