/**
 * نگهداری چارت و دوره — فاز ۴ نقشهٔ پاریتی.
 *
 * ویرایشِ **ساختاری** (کد، والد، ماهیت، سطح) اینجا **ممکن نیست** — تغییرشان
 * درخت و گزارش‌ها را می‌شکند. فقط ویژگی‌های بی‌خطر: نام، فعال‌بودن، ترتیب،
 * الزام تفصیلی/مرکز هزینه، حالت ارز.
 */
import { Prisma, GlSubsidiaryKind } from '@prisma/client';
import { AppError } from '../../shared/middleware/errorHandler';

export interface AccountPatch {
  name?: string;
  isActive?: boolean;
  sortIndex?: number;
  requiresSubsidiary?: boolean;
  subsidiaryKinds?: GlSubsidiaryKind[];
  requiresCostCenter?: boolean;
  currencyMode?: 'SINGLE' | 'MULTI';
  currencyCode?: string | null;
}

const EDITABLE = new Set<keyof AccountPatch>([
  'name', 'isActive', 'sortIndex', 'requiresSubsidiary',
  'subsidiaryKinds', 'requiresCostCenter', 'currencyMode', 'currencyCode',
]);

export async function updateAccount(tx: Prisma.TransactionClient, id: string, patch: AccountPatch) {
  const acc = await tx.glAccount.findUnique({ where: { id }, include: { _count: { select: { lines: true } } } });
  if (!acc) throw new AppError(404, 'حساب یافت نشد');

  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (EDITABLE.has(k as keyof AccountPatch) && v !== undefined) data[k] = v;
  }
  if (typeof data.name === 'string' && !data.name.trim()) throw new AppError(400, 'نام نمی‌تواند خالی باشد');

  // گاردهای امنِ داده‌محور — فقط وقتی حساب گردش دارد
  if (acc._count.lines > 0) {
    if (data.currencyMode === 'SINGLE' && acc.currencyMode === 'MULTI') {
      const distinct = await tx.glLine.groupBy({ by: ['currencyCode'], where: { accountId: id } });
      if (distinct.length > 1 || (data.currencyCode && distinct.some((d) => d.currencyCode !== data.currencyCode))) {
        throw new AppError(400, 'این حساب گردش چندارزی دارد و نمی‌تواند تک‌ارزی شود');
      }
    }
    if (data.requiresSubsidiary === true && acc.requiresSubsidiary === false) {
      const missing = await tx.glLine.count({ where: { accountId: id, subsidiaryId: null } });
      if (missing > 0) throw new AppError(400, `${missing} ردیفِ بدون تفصیلی دارد — نمی‌توان تفصیلی را اجباری کرد`);
    }
    if (data.requiresCostCenter === true && acc.requiresCostCenter === false) {
      const missing = await tx.glLine.count({ where: { accountId: id, costCenterId: null } });
      if (missing > 0) throw new AppError(400, `${missing} ردیفِ بدون مرکز هزینه دارد`);
    }
    /*
      غیرفعال کردن، حسابِ ماندهدار را به بن‌بست می‌برد: تریگرِ دفتر هر سندی به
      آن را رد می‌کند (`gl_line_rules_trg`)، ولی ماندهاش همچنان در ترازنامه
      می‌نشیند — یعنی عددی که نه می‌شود صفرش کرد نه از گزارش بیرونش برد.
      ماندهٔ صفر مجاز است: تاریخچه می‌ماند و حساب فقط بسته می‌شود.
    */
    if (data.isActive === false && acc.isActive) {
      const [agg] = await tx.$queryRaw<{ bal: bigint | null }[]>`
        SELECT SUM("debitBase" - "creditBase") AS bal
        FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
        WHERE l."accountId" = ${id} AND e.status <> 'DRAFT'`;
      const bal = agg?.bal ?? 0n;
      if (BigInt(bal) !== 0n) {
        throw new AppError(400, `حساب «${acc.code} ${acc.name}» مانده دارد و غیرفعال نمی‌شود؛ اول مانده را صفر کنید`);
      }
    }
  }

  return tx.glAccount.update({ where: { id }, data });
}

/**
 * تمیزکاریِ نام‌های مهاجرت — برگِ نقدیِ شرکت که مهاجرت با پسوند « - IRR» /
 * « - USD» / … از نامِ هستهٔ قدیمی ساخته بود. فقط این الگو، فقط حساب‌های زیر ۱۱۰۱.
 */
export async function cleanupMigrationNames(tx: Prisma.TransactionClient) {
  const suspects = await tx.glAccount.findMany({
    where: { code: { startsWith: '1101' }, name: { contains: ' - ' } },
  });
  const cleaned: { code: string; from: string; to: string }[] = [];
  for (const a of suspects) {
    const to = a.name.replace(/\s*-\s*(IRR|USD|CNY|AED|تومان|ریال|دلار|یوآن|درهم)\s*$/i, '').trim();
    if (to && to !== a.name) {
      await tx.glAccount.update({ where: { id: a.id }, data: { name: to } });
      cleaned.push({ code: a.code, from: a.name, to });
    }
  }
  return { cleaned };
}

// ───────────────────────────────────────────────────────────────
// قفل دوره
// ───────────────────────────────────────────────────────────────

/** ماژول‌هایی که جداگانه قفل می‌شوند — با `GlEntry.sourceType` می‌خواند */
export const LOCK_MODULES = ['ALL', 'Invoice', 'Settlement', 'ProductionOrder', 'ForwardingCargo', 'Manual'] as const;

export async function setPeriodLock(
  tx: Prisma.TransactionClient,
  input: { module?: string; lockToDate: Date; reason: string },
) {
  // ⚠️ نامِ ماژول باید **دقیقاً** یکی از `LOCK_MODULES` باشد.
  //
  // تریگرِ `gl_entry_period_open` با `module IN ('ALL', NEW."sourceType")`
  // می‌سنجد — یک مقایسهٔ رشته‌ایِ حساس به حروف. پیش از این هر چیزی پذیرفته
  // می‌شد و همان‌طور ذخیره می‌شد، پس قفلی که با `'all'` ساخته شده بود هرگز
  // با تریگر نمی‌خواند و **بی‌صدا بی‌اثر** بود: API کد ۲۰۰ می‌داد، رابط قفل
  // را نشان می‌داد، و سند گذشته‌نگر همچنان ثبت می‌شد.
  //
  // قفلی که کار نکند از نبودِ قفل بدتر است، چون حسابدار خیالش راحت است.
  const raw = (input.module || 'ALL').trim();
  const module = LOCK_MODULES.find((m) => m.toLowerCase() === raw.toLowerCase());
  if (!module) {
    throw new AppError(
      400,
      `ماژول «${raw}» قابل قفل نیست. یکی از این‌ها را بدهید: ${LOCK_MODULES.join('، ')}`,
    );
  }
  if (!input.reason?.trim()) throw new AppError(400, 'دلیل قفل لازم است');
  // یک قفل فعال به‌ازای هر ماژول — به‌روزرسانی، نه انباشت
  const existing = await tx.glPeriodLock.findFirst({ where: { module } });
  if (existing) {
    return tx.glPeriodLock.update({
      where: { id: existing.id },
      data: { lockToDate: input.lockToDate, reason: input.reason.trim() },
    });
  }
  return tx.glPeriodLock.create({ data: { module, lockToDate: input.lockToDate, reason: input.reason.trim() } });
}

export async function removePeriodLock(tx: Prisma.TransactionClient, id: string) {
  await tx.glPeriodLock.delete({ where: { id } });
  return { ok: true };
}
