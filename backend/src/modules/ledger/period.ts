/**
 * سال مالی و قفل دوره.
 *
 * هر ثبت باید به یک سال مالیِ **باز** بند شود، وگرنه تریگر بازهٔ سال مالی و
 * تریگر قفل دوره در دیتابیس ردش می‌کنند.
 */
import { Prisma } from '@prisma/client';

export class NoFiscalYearError extends Error {}

/**
 * سال مالیِ بازی که تاریخ `at` داخلش می‌افتد. اگر نبود خطای صریح می‌دهد —
 * چون «نزدیک‌ترین سال مالی» انتخاب‌کردن یعنی سند در دورهٔ اشتباه بنشیند.
 */
export async function resolveOpenFiscalYear(tx: Prisma.TransactionClient, at: Date) {
  const fy = await tx.glFiscalYear.findFirst({
    where: { startDate: { lte: at }, endDate: { gte: at }, closedAt: null },
  });
  if (!fy) {
    throw new NoFiscalYearError(
      `سال مالی باز برای تاریخ ${at.toISOString().slice(0, 10)} تعریف نشده است`,
    );
  }
  return fy;
}
