/**
 * صورت مغایرت بانکی (نسخهٔ پایه).
 *
 * دفتر شرکت و صورتحسابِ بانک هیچ‌وقت لحظه‌به‌لحظه یکی نیستند: چکِ صادرشده هنوز
 * نقد نشده، واریزیِ در راه، کارمزد و سودِ بانکی که فقط بانک ثبتش کرده. این گزارش
 * دو مانده را کنار هم می‌گذارد و اقلامِ مغایرت را کم/زیاد می‌کند تا به هم برسند.
 *
 * محاسبه است، نه ثبت — هیچ سندی نمی‌زند. اگر مغایرتی واقعی است (کارمزد ثبت‌نشده)،
 * کاربر با «ثبت هزینه» سندش را جدا می‌زند.
 */
import { Prisma } from '@prisma/client';
import { AppError } from '../../shared/middleware/errorHandler';

export interface ReconAdjustment {
  /** مثبت = به دفتر اضافه کن (واریزیِ در راه)، منفی = از دفتر کم کن (چکِ نقدنشده، کارمزد) */
  amount: bigint;
  note: string;
}

export interface BankReconInput {
  /** کد حساب بانکیِ برگ (زیر ۱۱۰۱) */
  accountCode: string;
  asOf: Date;
  /** ماندهٔ صورتحسابِ بانک در آن تاریخ، ریال — اگر ندهی فقط ماندهٔ دفتر برمی‌گردد */
  statementBalance?: bigint | null;
  /** اقلامِ مغایرتِ شناخته‌شده */
  adjustments?: ReconAdjustment[];
  /** پنجرهٔ نمایشِ گردش برای تیک‌زدن (روز، پیش‌فرض ۴۵) */
  windowDays?: number;
}

export async function bankReconciliation(tx: Prisma.TransactionClient, input: BankReconInput) {
  const acc = await tx.glAccount.findUnique({ where: { code: input.accountCode } });
  if (!acc) throw new AppError(404, `حساب ${input.accountCode} در چارت نیست`);
  if (!acc.code.startsWith('1101')) throw new AppError(400, 'صورت مغایرت فقط برای حساب‌های نقد و بانک (زیر ۱۱۰۱)');
  if (!acc.isPostable) throw new AppError(400, `حساب ${acc.code} سرگروه است`);

  // ماندهٔ دفتر تا asOf — بانک‌ها ریالی‌اند، پس پایه = مبلغ
  const bookRows = await tx.$queryRaw<{ bal: bigint | null }[]>`
    SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS bal
    FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE l."accountId" = ${acc.id} AND e.status <> 'DRAFT' AND e.date <= ${input.asOf}
  `;
  const bookBalance = BigInt(bookRows[0]?.bal ?? 0n);

  const adjustments = input.adjustments ?? [];
  const adjustmentsTotal = adjustments.reduce((s, a) => s + BigInt(a.amount), 0n);
  const adjustedBook = bookBalance + adjustmentsTotal;

  const statementBalance = input.statementBalance == null ? null : BigInt(input.statementBalance);
  const difference = statementBalance == null ? null : statementBalance - adjustedBook;

  // گردشِ اخیر برای تیک‌زدنِ دستی
  const windowDays = input.windowDays ?? 45;
  const from = new Date(input.asOf);
  from.setUTCDate(from.getUTCDate() - windowDays);
  const movements = await tx.$queryRaw<
    { date: Date; serial: number | null; description: string; memo: string | null; debit: bigint; credit: bigint }[]
  >`
    SELECT e.date, e.serial, e.description, l.memo,
           l."debitBase"::bigint AS debit, l."creditBase"::bigint AS credit
    FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE l."accountId" = ${acc.id} AND e.status <> 'DRAFT'
      AND e.date >= ${from} AND e.date <= ${input.asOf}
    ORDER BY e.date DESC, e.serial DESC, l."lineNo" DESC
  `;

  // راهنما: چک‌های صادرشده که هنوز نقد نشده‌اند (بانک هنوز کم نکرده) — تطبیقِ
  // نامِ بانک تقریبی است، پس صریحاً «حدس» برچسب می‌خورد.
  const unpresentedCheques = await tx.glCheque.findMany({
    where: {
      direction: 'ISSUED',
      status: 'ISSUED',                 // صادرشده ولی هنوز پاس نشده
      issueDate: { lte: input.asOf },
    },
    select: { number: true, bankName: true, amount: true, dueDate: true, subsidiary: { select: { name: true } } },
    orderBy: { dueDate: 'asc' },
    take: 50,
  });

  return {
    account: { code: acc.code, name: acc.name },
    asOf: input.asOf,
    bookBalance,
    adjustments: adjustments.map((a) => ({ amount: BigInt(a.amount), note: a.note })),
    adjustmentsTotal,
    adjustedBook,
    statementBalance,
    difference,
    reconciled: difference != null && difference === 0n,
    movements,
    unpresentedChequesGuess: unpresentedCheques.map((c) => ({
      number: c.number, bankName: c.bankName, amount: c.amount,
      dueDate: c.dueDate, party: c.subsidiary?.name ?? null,
    })),
  };
}
