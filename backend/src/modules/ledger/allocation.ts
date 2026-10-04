/**
 * تخصیص پرداخت به فاکتور — مرحلهٔ ۴ ج.
 *
 * ─── چرا ───────────────────────────────────────────────────────
 *
 * سن‌بندی تا امروز FIFO **حدس** می‌زد: هر دریافت، قدیمی‌ترین بدهیِ باز را
 * می‌بست. برای شرکتی که مشتری‌اش فاکتور مشخصی را پرداخت می‌کند این غلط است —
 * مشتری فاکتور خرداد را می‌دهد، سیستم فاکتور فروردین را می‌بندد، و بعد
 * «قدیمی‌ترین بدهی ۹۰ روز» می‌گوید درحالی‌که آن فاکتور اصلاً پرداخت شده.
 *
 * FIFO حذف نمی‌شود؛ **پس‌افتِ** حالتی می‌شود که تخصیص صریح وجود ندارد. اکثر
 * دریافت‌ها هیچ‌وقت دستی تخصیص نمی‌خورند و برای آن‌ها FIFO بهترین حدسِ ممکن
 * است. کاری که این ماژول می‌کند این است که وقتی **می‌دانیم**، دیگر حدس نزنیم.
 *
 * ─── چهار قاعده‌ای که تخصیص را قابل اعتماد می‌کند ───────────────
 *
 * ۱) هر دو ردیف روی **یک معین و یک تفصیلی** باشند — وگرنه پرداختِ مشتری الف
 *    می‌تواند فاکتور مشتری ب را ببندد.
 * ۲) **یک ارز.** تخصیص یک واقعیتِ قراردادی است؛ بستنِ فاکتور دلاری با ریال
 *    یعنی تبدیل ارز، که سند خودش را می‌خواهد نه یک ردیف تخصیص.
 * ۳) **جهتِ مخالف.** تعهد بدهکار ⇒ تسویه بستانکار (و برعکس برای پرداختنی).
 * ۴) **هیچ‌کدام بیش از خودش تخصیص نخورد.** مجموع تخصیص‌های یک فاکتور از مبلغ
 *    خودش بیشتر نمی‌شود، و همین‌طور برای پرداخت.
 *
 * قاعدهٔ چهارم با قفلِ ردیف در همان تراکنش اجرا می‌شود، نه با خواندن و بعد
 * نوشتن — وگرنه دو درخواستِ هم‌زمان هر دو «جا هست» می‌بینند.
 */
import { Prisma } from '@prisma/client';

export class AllocationError extends Error {}

/** معین‌های کنترلی‌ای که تخصیص روی آن‌ها معنا دارد */
export const ALLOCATABLE_CODES = ['1104', '2101'];

export interface LineFacts {
  id: string;
  entryId: string;
  serial: number | null;
  date: Date;
  description: string;
  accountCode: string;
  subsidiaryId: string | null;
  currencyCode: string;
  debit: bigint;
  credit: bigint;
  /** مبلغِ خودِ ردیف، بدونِ علامت */
  amount: bigint;
  /** `DEBIT` یا `CREDIT` — جهتِ ردیف */
  side: 'DEBIT' | 'CREDIT';
  /** چقدرش تا امروز تخصیص خورده */
  allocated: bigint;
  /** چقدرش باز است */
  open: bigint;
}

const LINE_SELECT = Prisma.sql`
  SELECT l.id, l."entryId", e.serial, e.date, e.description,
         a.code AS "accountCode", l."subsidiaryId", l."currencyCode",
         l.debit, l.credit,
         COALESCE(o.sum_amount, 0)::bigint AS "allocObligation",
         COALESCE(s.sum_amount, 0)::bigint AS "allocSettlement"
  FROM "GlLine" l
  JOIN "GlEntry" e   ON e.id = l."entryId"
  JOIN "GlAccount" a ON a.id = l."accountId"
  LEFT JOIN (
    SELECT "obligationLineId" AS lid, SUM(amount) AS sum_amount
    FROM "GlAllocation" GROUP BY 1
  ) o ON o.lid = l.id
  LEFT JOIN (
    SELECT "settlementLineId" AS lid, SUM(amount) AS sum_amount
    FROM "GlAllocation" GROUP BY 1
  ) s ON s.lid = l.id`;

type RawLine = {
  id: string; entryId: string; serial: number | null; date: Date; description: string;
  accountCode: string; subsidiaryId: string | null; currencyCode: string;
  debit: bigint; credit: bigint; allocObligation: bigint; allocSettlement: bigint;
};

function shape(r: RawLine): LineFacts {
  const debit = BigInt(r.debit), credit = BigInt(r.credit);
  const side: 'DEBIT' | 'CREDIT' = debit > 0n ? 'DEBIT' : 'CREDIT';
  const amount = debit > 0n ? debit : credit;
  // یک ردیف یا تعهد است یا تسویه، هرگز هر دو — پس جمعِ دو ستون بی‌خطر است
  const allocated = BigInt(r.allocObligation) + BigInt(r.allocSettlement);
  return {
    id: r.id, entryId: r.entryId, serial: r.serial, date: r.date,
    description: r.description, accountCode: r.accountCode,
    subsidiaryId: r.subsidiaryId, currencyCode: r.currencyCode,
    debit, credit, amount, side, allocated,
    open: amount - allocated,
  };
}

async function loadLine(tx: Prisma.TransactionClient, id: string): Promise<LineFacts> {
  const rows = await tx.$queryRaw<RawLine[]>`${LINE_SELECT} WHERE l.id = ${id}`;
  if (!rows.length) throw new AllocationError('ردیف سند یافت نشد');
  return shape(rows[0]);
}

/**
 * ثبت یک تخصیص.
 *
 * `amount` اختیاری است؛ نبودنش یعنی «هرچه از هر دو باز است، کمترش» — که
 * حالتِ رایج است و کاربر را از حساب کردنِ دستی خلاص می‌کند.
 */
export async function allocate(
  tx: Prisma.TransactionClient,
  input: {
    obligationLineId: string;
    settlementLineId: string;
    amount?: bigint | null;
    note?: string | null;
    createdById?: string | null;
  },
) {
  if (input.obligationLineId === input.settlementLineId) {
    throw new AllocationError('یک ردیف را نمی‌توان به خودش تخصیص داد');
  }

  // ⚠️ قفلِ هر دو ردیف پیش از خواندنِ مانده. بدون این، دو درخواستِ هم‌زمان
  // هر دو «۱۰۰ باز است» می‌بینند و در مجموع ۲۰۰ تخصیص می‌دهند.
  await tx.$queryRaw`
    SELECT id FROM "GlLine"
    WHERE id IN (${input.obligationLineId}, ${input.settlementLineId})
    ORDER BY id
    FOR UPDATE`;

  const ob = await loadLine(tx, input.obligationLineId);
  const st = await loadLine(tx, input.settlementLineId);

  // قاعدهٔ ۱ — یک معین و یک تفصیلی
  if (!ALLOCATABLE_CODES.includes(ob.accountCode) || !ALLOCATABLE_CODES.includes(st.accountCode)) {
    throw new AllocationError(
      `تخصیص فقط روی معین‌های ${ALLOCATABLE_CODES.join(' و ')} معنا دارد`);
  }
  if (ob.accountCode !== st.accountCode) {
    throw new AllocationError('تعهد و تسویه باید روی یک معین باشند');
  }
  if (!ob.subsidiaryId || ob.subsidiaryId !== st.subsidiaryId) {
    throw new AllocationError('تعهد و تسویه باید متعلق به یک طرف‌حساب باشند');
  }
  // قاعدهٔ ۲ — یک ارز
  if (ob.currencyCode !== st.currencyCode) {
    throw new AllocationError(
      `ارزها یکی نیستند (${ob.currencyCode} و ${st.currencyCode}) — بستنِ فاکتور با ارز دیگر، سند تبدیل ارز می‌خواهد`);
  }
  // قاعدهٔ ۳ — جهتِ مخالف
  if (ob.side === st.side) {
    throw new AllocationError('تعهد و تسویه باید در دو جهت مخالف باشند');
  }

  if (ob.open <= 0n) throw new AllocationError('این تعهد کاملاً تسویه شده است');
  if (st.open <= 0n) throw new AllocationError('این تسویه کاملاً تخصیص یافته است');

  const cap = ob.open < st.open ? ob.open : st.open;
  const amount = input.amount ?? cap;
  if (amount <= 0n) throw new AllocationError('مبلغ تخصیص باید مثبت باشد');
  // قاعدهٔ ۴
  if (amount > ob.open) {
    throw new AllocationError(`بیش از ماندهٔ باز تعهد است (باز: ${ob.open})`);
  }
  if (amount > st.open) {
    throw new AllocationError(`بیش از ماندهٔ باز تسویه است (باز: ${st.open})`);
  }

  const existing = await tx.glAllocation.findUnique({
    where: {
      obligationLineId_settlementLineId: {
        obligationLineId: input.obligationLineId,
        settlementLineId: input.settlementLineId,
      },
    },
  });
  if (existing) {
    throw new AllocationError(
      'این تسویه قبلاً به همین تعهد تخصیص خورده — برای تغییر مبلغ، تخصیص قبلی را حذف کنید');
  }

  return tx.glAllocation.create({
    data: {
      obligationLineId: input.obligationLineId,
      settlementLineId: input.settlementLineId,
      amount, currencyCode: ob.currencyCode,
      note: input.note ?? null, createdById: input.createdById ?? null,
    },
  });
}

export async function unallocate(tx: Prisma.TransactionClient, id: string) {
  const row = await tx.glAllocation.findUnique({ where: { id } });
  if (!row) throw new AllocationError('تخصیص یافت نشد');
  await tx.glAllocation.delete({ where: { id } });
  return { ok: true, amount: row.amount.toString() };
}

/**
 * مواضعِ باز یک طرف‌حساب: تعهدها و تسویه‌های تخصیص‌نیافته.
 *
 * این همان چیزی است که صفحهٔ تخصیص نشان می‌دهد — دو ستون، و کاربر از هر
 * ستون یکی برمی‌دارد.
 */
export async function openItems(
  tx: Prisma.TransactionClient,
  input: { subsidiaryId: string; accountCode?: string; includeSettled?: boolean },
) {
  const codes = input.accountCode ? [input.accountCode] : ALLOCATABLE_CODES;
  const rows = await tx.$queryRaw<RawLine[]>`
    ${LINE_SELECT}
    WHERE l."subsidiaryId" = ${input.subsidiaryId}
      AND a.code IN (${Prisma.join(codes)})
      AND e.status <> 'DRAFT'
    ORDER BY e.date, e.serial`;

  const all = rows.map(shape);
  const keep = input.includeSettled ? all : all.filter((l) => l.open > 0n);

  // «تعهد» جهتِ عادیِ همان معین است: دریافتنی بدهکار، پرداختنی بستانکار.
  // پس نقشِ هر ردیف از معینِ **خودش** خوانده می‌شود، نه از فیلترِ ورودی —
  // وگرنه در حالت بدون فیلتر، ردیف‌های ۲۱۰۱ برعکس دسته‌بندی می‌شدند.
  const isObligation = (l: LineFacts) =>
    l.accountCode === '2101' ? l.side === 'CREDIT' : l.side === 'DEBIT';

  return {
    obligations: keep.filter(isObligation),
    settlements: keep.filter((l) => !isObligation(l)),
  };
}

/** تخصیص‌های ثبت‌شدهٔ یک ردیف — برای نمایش «این فاکتور با چه چیزهایی بسته شد» */
export async function allocationsOf(tx: Prisma.TransactionClient, lineId: string) {
  const rows = await tx.glAllocation.findMany({
    where: { OR: [{ obligationLineId: lineId }, { settlementLineId: lineId }] },
    orderBy: { createdAt: 'asc' },
  });
  const otherIds = rows.map((r) => (r.obligationLineId === lineId ? r.settlementLineId : r.obligationLineId));
  const others = otherIds.length
    ? await tx.$queryRaw<RawLine[]>`${LINE_SELECT} WHERE l.id IN (${Prisma.join(otherIds)})`
    : [];
  const byId = new Map(others.map((o) => [o.id, shape(o)]));

  return rows.map((r) => {
    const otherId = r.obligationLineId === lineId ? r.settlementLineId : r.obligationLineId;
    const o = byId.get(otherId);
    return {
      id: r.id,
      amount: r.amount.toString(),
      currencyCode: r.currencyCode,
      note: r.note,
      role: r.obligationLineId === lineId ? 'OBLIGATION' : 'SETTLEMENT',
      counterpart: o ? {
        lineId: o.id, serial: o.serial, date: o.date,
        description: o.description, amount: o.amount.toString(),
      } : null,
    };
  });
}

/**
 * نقشهٔ تخصیصِ یک معین برای مصرفِ سن‌بندی: به‌ازای هر ردیفِ تعهد، چقدرش با
 * تخصیصِ **صریح** بسته شده.
 *
 * سن‌بندی این را به‌جای بستنِ FIFO می‌گذارد و مابقی را همچنان FIFO می‌بندد.
 */
export async function explicitAllocations(
  tx: Prisma.TransactionClient, accountCode: string, asOf: Date,
): Promise<{ byObligation: Map<string, bigint>; bySettlement: Map<string, bigint> }> {
  // ⚠️ **هر دو سر** باید تا تاریخ گزارش رخ داده باشند.
  //
  // این را دادهٔ زندهٔ staging گرفت: یک تخصیص به دریافتی با تاریخ ۱۴۰۶ ثبت شد و
  // ماندهٔ باز **امروز** ۵۷٬۶۷۲٬۰۰۰ کم شد — پرداختی که هنوز نشده. سن‌بندی
  // «در تاریخ X» است، پس تخصیصی که یک سرش بعد از X است در آن تاریخ وجود
  // ندارد. تقارن هم لازم است: اگر فقط سرِ تسویه را فیلتر کنیم، تخصیص به
  // فاکتورِ آینده تسویهٔ امروز را از FIFO می‌دزدد و مانده بیشتر می‌شود.
  const rows = await tx.$queryRaw<{ obligationLineId: string; settlementLineId: string; amount: bigint }[]>`
    SELECT al."obligationLineId", al."settlementLineId", al.amount
    FROM "GlAllocation" al
    JOIN "GlLine" ol    ON ol.id = al."obligationLineId"
    JOIN "GlEntry" oe   ON oe.id = ol."entryId"
    JOIN "GlAccount" a  ON a.id = ol."accountId"
    JOIN "GlLine" sl    ON sl.id = al."settlementLineId"
    JOIN "GlEntry" se   ON se.id = sl."entryId"
    WHERE a.code = ${accountCode}
      AND oe.date <= ${asOf}
      AND se.date <= ${asOf}`;

  const byObligation = new Map<string, bigint>();
  const bySettlement = new Map<string, bigint>();
  for (const r of rows) {
    byObligation.set(r.obligationLineId,
      (byObligation.get(r.obligationLineId) ?? 0n) + BigInt(r.amount));
    bySettlement.set(r.settlementLineId,
      (bySettlement.get(r.settlementLineId) ?? 0n) + BigInt(r.amount));
  }
  return { byObligation, bySettlement };
}
