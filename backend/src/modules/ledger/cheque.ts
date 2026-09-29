/**
 * چک — docs/ACCOUNTING_SPEC.md بند ۳-۵
 *
 * Bigcapital چک ندارد؛ این ماژول از صفر طراحی شده.
 *
 * اصل: چک یک **دارایی یا بدهی مستقل** است، نه یادداشتی کنار طلب. وقتی مشتری
 * چک می‌دهد، طلبِ تجاری بسته می‌شود و به‌جایش «اسناد دریافتنی» باز می‌شود.
 * هر انتقال وضعیت، جابه‌جایی بین همین حساب‌هاست — و **هر کدام سند می‌زند**.
 * اجباری‌بودن `GlChequeTransition.entryId` این قاعده را در schema می‌بندد.
 */
import { Prisma, GlChequeDirection, GlChequeStatus } from '@prisma/client';
import { post, DraftLine } from './poster';
import { Minor, Rate, rateFrom } from './money';
import { resolveRate } from './fx';

export const CHEQUE_CODES = {
  inHand: '110301',        // چک نزد صندوق
  inCollection: '110302',  // چک در جریان وصول
  pledged: '110303',       // چک نزد بانک به‌عنوان وثیقه
  endorsed: '110304',      // چک خرج‌شده
  bounced: '110305',       // چک برگشتی
  receivable: '1104',      // حساب‌های دریافتنی تجاری
  payable: '2101',         // حساب‌های پرداختنی تجاری
  notesPayable: '2102',    // اسناد پرداختنی
} as const;

export class ChequeError extends Error {}

/**
 * گذارهای مجاز.
 *
 * صریح و داده‌ای است، نه پراکنده در if/else — چون چرخهٔ چک همان چیزی است که
 * سند مرجع دقیق تعریف کرده و هر انحراف از آن باید فوراً دیده شود.
 */
export const ALLOWED: Record<GlChequeDirection, Partial<Record<GlChequeStatus, GlChequeStatus[]>>> = {
  RECEIVED: {
    IN_HAND: ['IN_COLLECTION', 'ENDORSED', 'PLEDGED', 'BOUNCED'],
    IN_COLLECTION: ['COLLECTED', 'BOUNCED'],
    PLEDGED: ['IN_HAND', 'IN_COLLECTION'],
    /**
     * ممیزی دور چهارم (ن۹): «خرج‌شده» دیگر پایانی نیست.
     *
     * ظهرنویس تا وصولِ چک مسئول می‌ماند (قانون تجارت). اگر چکِ خرج‌شده
     * برگردد، طلبکار سراغ **ما** می‌آید — و در مدل قبلی چک از دفتر خارج
     * شده بود و هیچ ردی نمی‌ماند که آن برگشت را به آن ببندیم.
     *   → COLLECTED  چک نزد طرف سوم وصول شد؛ هر دو تعهد بسته می‌شود
     *   → BOUNCED    برگشت خورد؛ چک به ما و بدهی به طرف سوم برمی‌گردد
     */
    ENDORSED: ['COLLECTED', 'BOUNCED'],
    // ممیزی ب۱۰: چک برگشتی بن‌بست نیست —
    //   → IN_HAND   وصول مجدد یا چک جایگزین
    //   → RETURNED  کاغذ به مشتری پس داده شد و بدهی به دریافتنی برگشت
    BOUNCED: ['IN_HAND', 'RETURNED'],
    // COLLECTED / ENDORSED / RETURNED پایانی‌اند
  },
  ISSUED: {
    ISSUED: ['CLEARED', 'BOUNCED', 'VOIDED'],
    BOUNCED: ['CLEARED', 'VOIDED'],
  },
};

/** حسابی که چک در هر وضعیت روی آن می‌نشیند */
const STATE_ACCOUNT: Partial<Record<GlChequeStatus, string>> = {
  IN_HAND: CHEQUE_CODES.inHand,
  IN_COLLECTION: CHEQUE_CODES.inCollection,
  PLEDGED: CHEQUE_CODES.pledged,
  BOUNCED: CHEQUE_CODES.bounced,
  ENDORSED: CHEQUE_CODES.endorsed,
  ISSUED: CHEQUE_CODES.notesPayable,
};

const accountByCode = (tx: Prisma.TransactionClient, code: string) =>
  tx.glAccount.findUniqueOrThrow({ where: { code } });

/**
 * تفصیلیِ طرفی که چک به او ظهرنویسی شد.
 *
 * از ردیفِ «اسناد پرداختنی» در سندِ ظهرنویسیِ همین چک خوانده می‌شود. اگر
 * پیدا نشد یعنی چک با نسخهٔ قدیمیِ ماژول خرج شده (که ۲۱۰۲ نمی‌زد) و باید
 * طرف‌حساب را صریح بدهیم.
 */
async function endorseeOf(tx: Prisma.TransactionClient, chequeId: string): Promise<string> {
  const line = await tx.glLine.findFirst({
    where: {
      account: { code: CHEQUE_CODES.notesPayable },
      subsidiaryId: { not: null },
      entry: { sourceType: 'Cheque', sourceId: chequeId, status: { not: 'REVERSED' } },
    },
    orderBy: { entry: { date: 'desc' } },
    select: { subsidiaryId: true },
  });
  if (!line?.subsidiaryId) {
    throw new ChequeError(
      'طرف‌حسابی که چک به او خرج شده پیدا نشد — آن را صریح بفرستید (endorseToSubsidiaryId)',
    );
  }
  return line.subsidiaryId;
}

async function rateFor(tx: Prisma.TransactionClient, currencyCode: string, date: Date): Promise<Rate> {
  return currencyCode === 'IRR' ? rateFrom(1) : resolveRate(tx, currencyCode, date);
}

export interface ChequeContext {
  fiscalYearId: string;
  date: Date;
  createdById?: string | null;
}

// ───────────────────────────────────────────────────────────────
// دریافت چک
// ───────────────────────────────────────────────────────────────

export interface ReceiveChequeInput extends ChequeContext {
  number: string;
  bankName: string;
  sayadId?: string | null;
  amount: Minor;
  currencyCode: string;
  issueDate: Date;
  dueDate: Date;
  /** مشتری‌ای که چک را داده */
  subsidiaryId: string;
  note?: string | null;
}

/**
 * دریافت چک از مشتری: طلب تجاری بسته می‌شود، اسناد دریافتنی باز می‌شود.
 *
 * این **تسویه** نیست — پول هنوز نیامده. فقط شکل طلب عوض شده.
 */
export async function receiveCheque(tx: Prisma.TransactionClient, input: ReceiveChequeInput) {
  if (input.amount <= 0n) throw new ChequeError('مبلغ چک باید بزرگ‌تر از صفر باشد');
  if (input.dueDate < input.issueDate) throw new ChequeError('سررسید نمی‌تواند پیش از تاریخ صدور باشد');

  const rate = await rateFor(tx, input.currencyCode, input.date);
  const inHand = await accountByCode(tx, CHEQUE_CODES.inHand);
  const ar = await accountByCode(tx, CHEQUE_CODES.receivable);

  const entry = await post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.date,
    description: `دریافت چک ${input.number} — ${input.bankName}`,
    entryType: 'NORMAL',
    sourceType: 'Cheque',
    createdById: input.createdById ?? null,
    lines: [
      {
        accountId: inHand.id, subsidiaryId: input.subsidiaryId,
        currencyCode: input.currencyCode, debit: input.amount, rate,
        memo: `چک ${input.number} سررسید ${input.dueDate.toISOString().slice(0, 10)}`,
      },
      {
        accountId: ar.id, subsidiaryId: input.subsidiaryId,
        currencyCode: input.currencyCode, credit: input.amount, rate,
        memo: 'بستن طلب در ازای چک',
      },
    ],
  });

  const cheque = await tx.glCheque.create({
    data: {
      direction: 'RECEIVED',
      number: input.number, bankName: input.bankName, sayadId: input.sayadId ?? null,
      amount: input.amount, currencyCode: input.currencyCode,
      issueDate: input.issueDate, dueDate: input.dueDate,
      subsidiaryId: input.subsidiaryId, status: 'IN_HAND', note: input.note ?? null,
    },
  });

  await tx.glChequeTransition.create({
    data: { chequeId: cheque.id, fromState: null, toState: 'IN_HAND', entryId: entry.id, byId: input.createdById ?? null },
  });

  return { cheque, entry };
}

// ───────────────────────────────────────────────────────────────
// صدور چک
// ───────────────────────────────────────────────────────────────

export interface IssueChequeInput extends ReceiveChequeInput {}

/** صدور چک به فروشنده: بدهی تجاری به اسناد پرداختنی تبدیل می‌شود */
export async function issueCheque(tx: Prisma.TransactionClient, input: IssueChequeInput) {
  if (input.amount <= 0n) throw new ChequeError('مبلغ چک باید بزرگ‌تر از صفر باشد');
  if (input.dueDate < input.issueDate) throw new ChequeError('سررسید نمی‌تواند پیش از تاریخ صدور باشد');

  const rate = await rateFor(tx, input.currencyCode, input.date);
  const payable = await accountByCode(tx, CHEQUE_CODES.payable);
  const notes = await accountByCode(tx, CHEQUE_CODES.notesPayable);

  const entry = await post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.date,
    description: `صدور چک ${input.number} — ${input.bankName}`,
    entryType: 'NORMAL',
    sourceType: 'Cheque',
    createdById: input.createdById ?? null,
    lines: [
      {
        accountId: payable.id, subsidiaryId: input.subsidiaryId,
        currencyCode: input.currencyCode, debit: input.amount, rate,
        memo: 'بستن بدهی در ازای چک',
      },
      {
        accountId: notes.id, subsidiaryId: input.subsidiaryId,
        currencyCode: input.currencyCode, credit: input.amount, rate,
        memo: `چک ${input.number} سررسید ${input.dueDate.toISOString().slice(0, 10)}`,
      },
    ],
  });

  const cheque = await tx.glCheque.create({
    data: {
      direction: 'ISSUED',
      number: input.number, bankName: input.bankName, sayadId: input.sayadId ?? null,
      amount: input.amount, currencyCode: input.currencyCode,
      issueDate: input.issueDate, dueDate: input.dueDate,
      subsidiaryId: input.subsidiaryId, status: 'ISSUED', note: input.note ?? null,
    },
  });

  await tx.glChequeTransition.create({
    data: { chequeId: cheque.id, fromState: null, toState: 'ISSUED', entryId: entry.id, byId: input.createdById ?? null },
  });

  return { cheque, entry };
}

// ───────────────────────────────────────────────────────────────
// انتقال وضعیت
// ───────────────────────────────────────────────────────────────

export interface TransitionInput extends ChequeContext {
  chequeId: string;
  to: GlChequeStatus;
  /** برای وصول یا پاس‌شدن: حساب نقدی شرکت */
  cashAccountCode?: string;
  /** برای خرج‌کردن چک: تفصیلی طرفی که چک به او داده می‌شود */
  endorseToSubsidiaryId?: string;
}

/**
 * انتقال وضعیت چک — هر انتقال یک سند می‌زند.
 *
 * سند هر گذار، چک را از حساب وضعیت قبلی به حساب وضعیت جدید منتقل می‌کند.
 * سه گذار استثنا هستند چون طرف مقابلشان حساب وضعیت نیست:
 *   • وصول  → طرف مقابل نقد است
 *   • پاس‌شدن → طرف مقابل نقد است
 *   • خرج‌کردن → طرف مقابل بدهی به شخص ثالث است
 */
export async function transitionCheque(tx: Prisma.TransactionClient, input: TransitionInput) {
  const cheque = await tx.glCheque.findUnique({ where: { id: input.chequeId } });
  if (!cheque) throw new ChequeError('چک یافت نشد');

  const allowed = ALLOWED[cheque.direction][cheque.status] ?? [];
  if (!allowed.includes(input.to)) {
    throw new ChequeError(
      `گذار «${cheque.status}» ← «${input.to}» برای چک ${cheque.direction} مجاز نیست. ` +
      `گذارهای ممکن: ${allowed.length ? allowed.join('، ') : 'هیچ (وضعیت پایانی)'}`,
    );
  }

  const rate = await rateFor(tx, cheque.currencyCode, input.date);
  const amount = cheque.amount;
  const lines: DraftLine[] = [];
  const fromAccount = await accountByCode(tx, STATE_ACCOUNT[cheque.status]!);

  /**
   * طرفی که چک به او ظهرنویسی شده — از خودِ سندِ ظهرنویسی خوانده می‌شود.
   *
   * روی رکورد چک ذخیره نمی‌شود تا مهاجرت دیتابیس لازم نشود؛ سندِ گذار
   * `sourceId = chequeId` دارد و تفصیلیِ ردیفِ «اسناد پرداختنی» همان طرف است.
   * ورودی صریح، اگر داده شود، اولویت دارد.
   */
  const endorsee = cheque.status === 'ENDORSED'
    ? (input.endorseToSubsidiaryId ?? await endorseeOf(tx, cheque.id))
    : (input.endorseToSubsidiaryId ?? null);

  const label = `چک ${cheque.number}`;

  if (cheque.direction === 'RECEIVED') {
    if (input.to === 'COLLECTED' && cheque.status === 'ENDORSED') {
      /**
       * چکِ خرج‌شده نزد طرف سوم وصول شد — هر دو تعهد بسته می‌شود:
       * «اسناد پرداختنیِ» ما به او، و «چک خرج‌شده»ای که هنوز دارایی ما بود.
       * نقدی جابه‌جا نمی‌شود؛ پول از جیب صادرکنندهٔ چک رفت، نه ما.
       */
      const notesPayable = await accountByCode(tx, CHEQUE_CODES.notesPayable);
      lines.push(
        { accountId: notesPayable.id, subsidiaryId: endorsee, currencyCode: cheque.currencyCode, debit: amount, rate, memo: `وصول ${label} نزد طرف سوم` },
        { accountId: fromAccount.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, credit: amount, rate, memo: label },
      );
    } else if (input.to === 'BOUNCED' && cheque.status === 'ENDORSED') {
      /**
       * چکِ خرج‌شده برگشت خورد. طلبکار سراغ ما می‌آید (مسئولیت ظهرنویس):
       * بدهی به او از «اسناد پرداختنی» به «پرداختنی تجاری» برمی‌گردد، و چک
       * از «خرج‌شده» به «برگشتی» می‌رود — همچنان به نام صادرکننده، چون طلبِ
       * ما از **او**ست.
       */
      const notesPayable = await accountByCode(tx, CHEQUE_CODES.notesPayable);
      const payable = await accountByCode(tx, CHEQUE_CODES.payable);
      const bounced = await accountByCode(tx, CHEQUE_CODES.bounced);
      lines.push(
        { accountId: notesPayable.id, subsidiaryId: endorsee, currencyCode: cheque.currencyCode, debit: amount, rate, memo: `برگشتِ ${label} خرج‌شده` },
        { accountId: payable.id, subsidiaryId: endorsee, currencyCode: cheque.currencyCode, credit: amount, rate, memo: 'بازگشت بدهی — مسئولیت ظهرنویس' },
        { accountId: bounced.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, debit: amount, rate, memo: `${label} برگشتی` },
        { accountId: fromAccount.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, credit: amount, rate, memo: label },
      );
    } else if (input.to === 'COLLECTED') {
      if (!input.cashAccountCode) throw new ChequeError('برای وصول چک، حساب نقدی لازم است');
      const cash = await accountByCode(tx, input.cashAccountCode);
      lines.push(
        { accountId: cash.id, currencyCode: cheque.currencyCode, debit: amount, rate, memo: `وصول ${label}` },
        { accountId: fromAccount.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, credit: amount, rate, memo: label },
      );
    } else if (input.to === 'ENDORSED') {
      if (!input.endorseToSubsidiaryId) throw new ChequeError('برای خرج‌کردن چک، طرف‌حساب مقصد لازم است');
      /**
       * ⚠️ ممیزی دور چهارم (ن۹) — ظهرنویسی، چک را از دفتر خارج نمی‌کند.
       *
       * مدل قبلی «بد ۲۱۰۱ / بس ۱۱۰۳۰۱» می‌زد: بدهی تسویه و چک ناپدید.
       * ساده بود ولی دو چیز را گم می‌کرد. اول اینکه طبق قانون تجارت
       * ظهرنویس تا وصول مسئول می‌ماند، پس تعهد ما واقعاً تمام نشده. دوم
       * اینکه حساب «۱۱۰۳۰۴ چک خرج‌شده» در چارت رزرو شده بود و
       * `CHEQUE_CODES.endorsed` هم به آن اشاره می‌کرد، ولی هیچ کدی
       * نمی‌خواندش — یعنی طراحی همین را می‌خواست و پیاده‌سازی جا مانده بود.
       *
       * مدل تازه دقیقاً **قرینهٔ چک صادرهٔ خودمان** است: بدهی از «پرداختنی
       * تجاری» به «اسناد پرداختنی» می‌رود و چک از «نزد صندوق» به
       * «خرج‌شده». هر دو سمت تا وصولِ واقعی باز می‌مانند.
       */
      const notesPayable = await accountByCode(tx, CHEQUE_CODES.notesPayable);
      const payable = await accountByCode(tx, CHEQUE_CODES.payable);
      const spent = await accountByCode(tx, CHEQUE_CODES.endorsed);
      lines.push(
        { accountId: payable.id, subsidiaryId: input.endorseToSubsidiaryId, currencyCode: cheque.currencyCode, debit: amount, rate, memo: `تسویه با خرج‌کردن ${label}` },
        { accountId: notesPayable.id, subsidiaryId: input.endorseToSubsidiaryId, currencyCode: cheque.currencyCode, credit: amount, rate, memo: `تعهد تا وصول ${label}` },
        { accountId: spent.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, debit: amount, rate, memo: `${label} خرج‌شده` },
        { accountId: fromAccount.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, credit: amount, rate, memo: label },
      );
    } else if (input.to === 'RETURNED') {
      // ممیزی ب۱۰: کاغذ به مشتری پس داده شد ⇒ بدهی به حساب دریافتنی برمی‌گردد
      const ar = await accountByCode(tx, CHEQUE_CODES.receivable);
      lines.push(
        { accountId: ar.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, debit: amount, rate, memo: `بازگشت بدهی — ${label} برگشتی` },
        { accountId: fromAccount.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, credit: amount, rate, memo: label },
      );
    } else {
      // جابه‌جایی ساده بین حساب‌های وضعیت
      const toAccount = await accountByCode(tx, STATE_ACCOUNT[input.to]!);
      lines.push(
        { accountId: toAccount.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, debit: amount, rate, memo: label },
        { accountId: fromAccount.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, credit: amount, rate, memo: label },
      );
    }
  } else {
    // چک پرداختی
    if (input.to === 'CLEARED') {
      if (!input.cashAccountCode) throw new ChequeError('برای پاس‌شدن چک، حساب نقدی لازم است');
      const cash = await accountByCode(tx, input.cashAccountCode);
      lines.push(
        { accountId: fromAccount.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, debit: amount, rate, memo: `پاس‌شدن ${label}` },
        { accountId: cash.id, currencyCode: cheque.currencyCode, credit: amount, rate, memo: label },
      );
    } else {
      /**
       * برگشت یا ابطال چک پرداختی: بدهی به شکل اولش (حساب پرداختنی تجاری)
       * برمی‌گردد. چک از بین رفته ولی **بدهی از بین نرفته**.
       */
      const payable = await accountByCode(tx, CHEQUE_CODES.payable);
      lines.push(
        { accountId: fromAccount.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, debit: amount, rate, memo: label },
        { accountId: payable.id, subsidiaryId: cheque.subsidiaryId, currencyCode: cheque.currencyCode, credit: amount, rate, memo: `بازگشت بدهی — ${label}` },
      );
    }
  }

  const entry = await post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.date,
    description: `${label}: ${cheque.status} ← ${input.to}`,
    entryType: 'NORMAL',
    sourceType: 'Cheque',
    sourceId: cheque.id,
    createdById: input.createdById ?? null,
    lines,
  });

  await tx.glChequeTransition.create({
    data: {
      chequeId: cheque.id, fromState: cheque.status, toState: input.to,
      entryId: entry.id, byId: input.createdById ?? null,
    },
  });

  const updated = await tx.glCheque.update({
    where: { id: cheque.id }, data: { status: input.to },
  });

  return { cheque: updated, entry };
}

/**
 * چک‌هایی که تعیین تکلیف نشده‌اند: سررسیدشده‌های در جریان، **و** هر چکِ برگشتی
 * (بی‌توجه به سررسید — برگشتی یعنی فوری باید کاری بشود). ممیزی ب۱۰.
 */
export async function overdueCheques(tx: Prisma.TransactionClient, asOf: Date) {
  return tx.glCheque.findMany({
    where: {
      OR: [
        { dueDate: { lte: asOf }, status: { in: ['IN_HAND', 'IN_COLLECTION', 'PLEDGED', 'ISSUED'] } },
        { status: 'BOUNCED' },
      ],
    },
    include: { subsidiary: true },
    orderBy: { dueDate: 'asc' },
  });
}
