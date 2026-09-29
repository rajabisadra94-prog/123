/**
 * یادداشت‌های همراه صورت‌های مالی و فهرست مالیات حقوق — مرحلهٔ ۵ ب.
 *
 * ─── یادداشت‌ها ─────────────────────────────────────────────────
 *
 * صورت مالی بدون یادداشت، نصفِ صورت مالی است. «موجودی نقد ۳۰۷ میلیارد» یک
 * عدد است؛ یادداشت می‌گوید این عدد از چهار صندوق و دو بانک و سه ارز آمده.
 * حسابرس بدون یادداشت امضا نمی‌کند و بانک بدون آن تسهیلات نمی‌دهد.
 *
 * **یادداشت‌ها از دفتر ساخته می‌شوند، نه از متنِ دستی.** یادداشتی که کاربر
 * تایپ کند تا ماه بعد کهنه می‌شود و کسی هم نمی‌فهمد. آنچه اینجا تولید
 * می‌شود، ریزِ همان عددی است که در صورت مالی نشسته — پس همیشه با آن می‌خواند.
 *
 * جای متنِ توضیحیِ انسانی هم هست (`GlDisclosureNote`)، ولی **کنارِ** ریزِ
 * محاسبه‌شده، نه به‌جایش.
 *
 * ─── فهرست مالیات حقوق ─────────────────────────────────────────
 *
 * مالیات حقوق ماهانه به سازمان امور مالیاتی اظهار می‌شود و فهرستش کد ملیِ هر
 * کارمند را می‌خواهد. داده‌اش در `GlPayrollItem` بود ولی هیچ‌جا به این شکل
 * درنمی‌آمد.
 */
import { Prisma } from '@prisma/client';
import { nationalIdProblem } from '../national-id';

export class DisclosureError extends Error {}

export interface NoteBreakdownRow {
  code: string;
  name: string;
  /** به تفکیک ارز، وقتی حساب چندارزی باشد */
  byCurrency: { currencyCode: string; amount: string; base: string }[];
  amount: string;
}

export interface StatementNote {
  key: string;
  title: string;
  /** عددی که در صورت مالی نشسته — یادداشت باید با آن بخواند */
  total: string;
  rows: NoteBreakdownRow[];
  /** توضیح ثابتِ حسابداری، نه متنِ تولیدشده */
  policy?: string;
  /** یادداشت‌های انسانیِ چسبیده به همین بند */
  remarks?: { id: string; title: string; body: string }[];
}

/** یادداشتِ مستقل — چیزی که هیچ کوئری‌ای نمی‌داند */
export interface StandaloneNote {
  id: string; title: string; body: string;
}

/** یادداشت‌هایی که از ریزِ حساب‌ها ساخته می‌شوند */
const NOTE_SPECS: { key: string; title: string; prefixes: string[]; policy?: string }[] = [
  {
    key: 'cash', title: 'موجودی نقد و بانک',
    prefixes: ['1101', '1102'],
    policy: 'موجودی نقد شامل صندوق، تنخواه و حساب‌های بانکیِ قابل برداشت بدون محدودیت است. اقلام ارزی به نرخ پایان دوره تسعیر شده‌اند.',
  },
  {
    key: 'receivable', title: 'حساب‌های دریافتنی تجاری',
    prefixes: ['1104'],
    policy: 'مطالبات به بهای اسمی و پس از کسر ذخیرهٔ مطالبات مشکوک‌الوصول ارائه شده است.',
  },
  {
    key: 'other-receivable', title: 'سایر دریافتنی‌ها و پیش‌پرداخت‌ها',
    prefixes: ['1103', '1105', '1107', '1109'],
  },
  {
    key: 'inventory', title: 'موجودی کالا',
    prefixes: ['1106'],
  },
  {
    key: 'fixed-assets', title: 'دارایی‌های ثابت مشهود',
    prefixes: ['1201', '1202'],
    policy: 'دارایی‌های ثابت به بهای تمام‌شده پس از کسر استهلاک انباشته ارائه شده‌اند. استهلاک به روش خط مستقیم و بر مبنای عمر مفید برآوردی محاسبه می‌شود.',
  },
  {
    key: 'payable', title: 'حساب‌های پرداختنی',
    prefixes: ['2101', '2102', '2103'],
  },
  {
    key: 'payroll-liabilities', title: 'بدهی‌های پرسنلی و ذخایر',
    prefixes: ['2105', '2106', '2107', '2108', '2109', '2110', '2112'],
    policy: 'ذخایر عیدی، سنوات و مرخصی بر مبنای قانون کار و خدمتِ انجام‌شده تا پایان دوره محاسبه شده‌اند.',
  },
  {
    key: 'equity', title: 'حقوق صاحبان سهام',
    prefixes: ['31'],
  },
  {
    key: 'revenue', title: 'درآمد عملیاتی',
    prefixes: ['41'],
    policy: 'درآمد در زمان انتقال کنترل کالا یا ارائهٔ خدمت شناسایی می‌شود.',
  },
  {
    key: 'cogs', title: 'بهای تمام‌شدهٔ درآمد',
    prefixes: ['51'],
  },
  {
    key: 'personnel', title: 'هزینه‌های پرسنلی',
    prefixes: ['61'],
  },
  {
    key: 'general', title: 'هزینه‌های عمومی و اداری',
    prefixes: ['62'],
  },
];

/**
 * ریزِ یک یادداشت از دفتر.
 *
 * تفکیک ارز فقط وقتی برمی‌گردد که حساب واقعاً چندارزی باشد — ستونِ «USD: ۰»
 * برای صندوق ریالی، یادداشت را شلوغ می‌کند بی‌آنکه چیزی بگوید.
 */
export async function statementNotes(
  tx: Prisma.TransactionClient,
  input: { asOf: Date; from?: Date | null },
) {
  const notes: StatementNote[] = [];

  for (const spec of NOTE_SPECS) {
    const isPeriod = spec.prefixes.some((p) => ['4', '5', '6', '7', '8'].includes(p[0]));
    // اقلام سود و زیانی بازه‌ای‌اند، ترازنامه‌ای‌ها تجمعی — همان قاعده‌ای که
    // بقیهٔ گزارش‌ها دارند، وگرنه یادداشت با صورت مالی نمی‌خواند.
    const dateFilter = isPeriod && input.from
      ? Prisma.sql`AND e.date >= ${input.from} AND e.date <= ${input.asOf}`
      : Prisma.sql`AND e.date <= ${input.asOf}`;
    const closing = isPeriod
      ? Prisma.sql`AND e."sourceType" IS DISTINCT FROM 'YearClose'`
      : Prisma.empty;

    const rows = await tx.$queryRaw<{
      code: string; name: string; currencyCode: string;
      amount: bigint; base: bigint;
    }[]>`
      SELECT a.code, a.name, l."currencyCode",
             (SUM(l.debit) - SUM(l.credit))::bigint             AS amount,
             (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS base
      FROM "GlLine" l
      JOIN "GlEntry" e   ON e.id = l."entryId"
      JOIN "GlAccount" a ON a.id = l."accountId"
      WHERE e.status <> 'DRAFT'
        AND a."isPostable" = true
        AND (${Prisma.join(spec.prefixes.map((p) => Prisma.sql`a.code LIKE ${p + '%'}`), ' OR ')})
        ${dateFilter}
        ${closing}
      GROUP BY a.code, a.name, l."currencyCode"
      ORDER BY a.code
    `;
    if (!rows.length) continue;

    const byAccount = new Map<string, NoteBreakdownRow>();
    for (const r of rows) {
      const acc = byAccount.get(r.code) ?? {
        code: r.code, name: r.name, byCurrency: [], amount: '0',
      };
      byAccount.set(r.code, acc);
      acc.byCurrency.push({
        currencyCode: r.currencyCode,
        amount: BigInt(r.amount).toString(),
        base: BigInt(r.base).toString(),
      });
      acc.amount = (BigInt(acc.amount) + BigInt(r.base)).toString();
    }

    const list = [...byAccount.values()]
      // ستونِ ارزیِ تک‌عضوی چیزی نمی‌گوید؛ فقط چندارزی‌ها تفکیک می‌مانند
      .map((a) => ({ ...a, byCurrency: a.byCurrency.length > 1 ? a.byCurrency : [] }))
      .filter((a) => a.amount !== '0');
    if (!list.length) continue;

    // درآمد و حقوق صاحبان سهام ماهیتِ بستانکارند؛ در یادداشت مثبت نشان
    // داده می‌شوند چون «درآمدِ منفی ۳۱۸ میلیارد» جمله‌ای است که کسی نمی‌فهمد.
    const flip = ['revenue', 'equity', 'payable', 'payroll-liabilities'].includes(spec.key);
    const shaped = flip
      ? list.map((a) => ({
        ...a,
        amount: (-BigInt(a.amount)).toString(),
        byCurrency: a.byCurrency.map((c) => ({
          ...c, amount: (-BigInt(c.amount)).toString(), base: (-BigInt(c.base)).toString(),
        })),
      }))
      : list;

    notes.push({
      key: spec.key, title: spec.title,
      total: shaped.reduce((s, a) => s + BigInt(a.amount), 0n).toString(),
      rows: shaped,
      policy: spec.policy,
    });
  }

  // ── یادداشت‌های انسانی ──────────────────────────────────────
  const written = await tx.glDisclosureNote.findMany({
    where: {
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: input.asOf } }] },
        { OR: [{ validTo: null }, { validTo: { gte: input.asOf } }] },
      ],
    },
    orderBy: [{ sortIndex: 'asc' }, { createdAt: 'asc' }],
  });

  for (const n of notes) {
    const mine = written.filter((w) => w.noteKey === n.key);
    if (mine.length) n.remarks = mine.map((w) => ({ id: w.id, title: w.title, body: w.body }));
  }
  const standalone: StandaloneNote[] = written
    .filter((w) => !w.noteKey)
    .map((w) => ({ id: w.id, title: w.title, body: w.body }));

  return { asOf: input.asOf, from: input.from ?? null, notes, standalone };
}

// ───────────────────────────────────────────────────────────────
// فهرست مالیات حقوق
// ───────────────────────────────────────────────────────────────

export interface PayrollTaxRow {
  employeeCode: string;
  name: string;
  nationalId: string | null;
  insuranceNo: string | null;
  workedDays: number;
  grossPay: string;
  insuranceEmployee: string;
  /** معافیت ماهانهٔ همان دوره؛ `null` وقتی نرخِ آن دوره تعریف نشده */
  exemption: string | null;
  /** ناخالص منهای بیمه منهای معافیت؛ `null` وقتی معافیت معلوم نیست */
  taxable: string | null;
  tax: string;
  /** چرا این ردیف هنوز قابل ارسال نیست */
  problems: string[];
}

/**
 * فهرست ماهانهٔ مالیات حقوق.
 *
 * مثل ماده ۱۶۹، ردیفِ ناقص **حذف نمی‌شود** — با ستون وضعیت می‌آید. حسابداری
 * که جمعِ کمتری ببیند و نداند چرا، بدتر از حسابداری است که ببیند چه کم دارد.
 *
 * **مشمول در دیتابیس ذخیره نشده** — فقط ناخالص، بیمهٔ سهم کارمند و مالیات
 * هست. پس مشمول بازسازی می‌شود: `ناخالص − بیمهٔ کارمند − معافیت`. معافیت از
 * جدولِ **نسخه‌دارِ** نرخ‌ها برای همان دوره خوانده می‌شود، نه از نرخ امروز —
 * وگرنه فهرستِ فروردین با معافیتِ اسفند بازسازی می‌شد.
 *
 * اگر نرخِ آن دوره پیدا نشود، مشمول `null` برمی‌گردد و گزارش همین را می‌گوید.
 * حدس زدنش بدتر از نگفتنش است: عددی که به سازمان اظهار می‌شود نباید تقریبی
 * باشد.
 */
/**
 * تاریخ میلادیِ نمایندهٔ یک ماه شمسی — همان تقریبی که `payroll/run.ts` دارد،
 * تا فهرست و لیستِ حقوق یک نرخ ببینند.
 */
async function runPeriodDate(tx: Prisma.TransactionClient, year: number, month: number) {
  const fy = await tx.glFiscalYear.findFirst({
    where: { title: { contains: String(year) } },
  });
  const base = fy?.startDate ?? new Date(Date.UTC(year + 621, 2, 21));
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + (month - 1) * 30 + 15);
  return d;
}

export async function payrollTaxList(
  tx: Prisma.TransactionClient,
  input: { year: number; month: number },
) {
  const run = await tx.glPayrollRun.findFirst({
    where: { year: input.year, month: input.month },
    include: {
      items: {
        include: { employee: { select: { code: true, name: true, nationalId: true, insuranceNo: true } } },
        orderBy: { employee: { code: 'asc' } },
      },
    },
    orderBy: { id: 'desc' },
  });

  if (!run) {
    return {
      year: input.year, month: input.month, found: false as const,
      rows: [] as PayrollTaxRow[],
      totals: { grossPay: '0', taxable: '0', tax: '0' },
      notReady: 0, status: null as string | null,
    };
  }

  // معافیتِ **همان دوره**، از جدول نسخه‌دار. ماه شمسی با همان تقریبِ ۳۰ روزه‌ای
  // که `payroll/run.ts periodDate` دارد به میلادی می‌رود، تا هر دو یک نرخ را
  // ببینند.
  const periodDate = await runPeriodDate(tx, run.year, run.month);
  const exemptionRow = await tx.glPayrollRate.findFirst({
    where: {
      key: 'TAX_EXEMPTION_MONTHLY',
      validFrom: { lte: periodDate },
      OR: [{ validTo: null }, { validTo: { gte: periodDate } }],
    },
    orderBy: { validFrom: 'desc' },
  });
  const exemption = exemptionRow ? BigInt(exemptionRow.value.toFixed(0)) : null;

  const rows: PayrollTaxRow[] = run.items.map((i: any) => {
    const gross = BigInt(i.grossPay);
    const insurance = BigInt(i.insuranceEmployee ?? 0n);
    const tax = BigInt(i.incomeTax ?? 0n);
    const taxable = exemption == null
      ? null
      : (() => { const t = gross - insurance - exemption; return t > 0n ? t : 0n; })();

    const problems: string[] = [];
    if (!i.employee.nationalId) problems.push('کد ملی ثبت نشده');
    else {
      // رقمِ کنترل هم سنجیده می‌شود، نه فقط طول — سامانهٔ مالیاتی کدِ ده‌رقمیِ
      // بی‌معنی را برمی‌گرداند و برگشت‌خوردن آن‌جا هزینه دارد.
      const p = nationalIdProblem(i.employee.nationalId);
      if (p) problems.push(p);
    }
    if (!i.employee.insuranceNo) problems.push('شمارهٔ بیمه ثبت نشده');
    if (exemption == null) problems.push('معافیت مالیاتیِ این دوره تعریف نشده');

    return {
      employeeCode: i.employee.code,
      name: i.employee.name,
      nationalId: i.employee.nationalId,
      insuranceNo: i.employee.insuranceNo,
      workedDays: i.workedDays,
      grossPay: gross.toString(),
      insuranceEmployee: insurance.toString(),
      exemption: exemption?.toString() ?? null,
      taxable: taxable?.toString() ?? null,
      tax: tax.toString(),
      problems,
    };
  });

  const sum = (f: (r: PayrollTaxRow) => string | null) =>
    rows.reduce((s, r) => s + BigInt(f(r) ?? '0'), 0n).toString();

  return {
    year: input.year, month: input.month, found: true as const,
    status: run.status as string,
    exemption: exemption?.toString() ?? null,
    rows,
    totals: {
      grossPay: sum((r) => r.grossPay),
      taxable: sum((r) => r.taxable),
      tax: sum((r) => r.tax),
    },
    notReady: rows.filter((r) => r.problems.length > 0).length,
  };
}
