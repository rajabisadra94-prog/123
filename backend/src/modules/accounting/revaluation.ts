import { Currency, Prisma } from '@prisma/client';
import { getRates } from '../../shared/utils/rates';
import {
  JournalLineInput, postJournal, normalSide, toJalaliYM, getOrCreateControl,
} from './accounting.service';

/**
 * تجدید ارزیابی پایان دوره — docs/accounting-spec.md بخش ۴-۴
 *
 * مسئله: یک طلب ۱۰٬۰۰۰ دلاری که با نرخ ۱۹۰٬۰۰۰ ثبت شده، در دفتر ۱.۹ میلیارد تومان
 * ارزش دارد. اگر نرخ امروز ۱۹۳٬۷۰۰ باشد ارزش واقعی ۱.۹۳۷ میلیارد است. این
 * ۳۷ میلیون «سود تحقق‌نیافته» است: هیچ پولی جابه‌جا نشده، فقط نرخ تکان خورده.
 *
 * سه نکتهٔ کلیدی در پیاده‌سازی:
 *
 * ۱) **فقط اقلام پولی.** دارایی و بدهی ارزی تجدید ارزیابی می‌شوند. درآمد، هزینه و
 *    سرمایه اقلام غیرپولی‌اند و به بهای تاریخی می‌مانند — تجدید ارزیابی‌شان یعنی
 *    دوباره‌شماری سودی که قبلاً شناسایی شده.
 *
 * ۲) **ماندهٔ ارزی دست نمی‌خورد.** تعدیل فقط ارزش ریالی است، پس در حساب‌های
 *    «تعدیل تسعیر» (۱۹۰۰ و ۲۹۰۰) به تومان می‌نشیند نه روی خود حساب ارزی.
 *    وگرنه ماندهٔ دلاری مشتری با یک عدد تومانی آلوده می‌شد.
 *
 * ۳) **برگشت اجباری در اول دورهٔ بعد.** بدون برگشت، وقتی همان تعهد بعداً واقعاً
 *    تسویه شود `postSettlement` دوباره تسعیر محقق را حساب می‌کند و سود دوبار
 *    شمرده می‌شود. برای همین سند برگشت **در همان لحظه** ساخته می‌شود، نه بعداً.
 */

export type RevaluationLine = {
  accountId: string;
  accountName: string;
  code: string | null;
  currency: Currency;
  /** ماندهٔ ارزی با علامت طبیعی */
  balance: number;
  /** ارزش ریالی دفتری (از روی نرخ‌های ثبت‌شدهٔ سندها) */
  carryingIRR: number;
  /** نرخ پایان دوره */
  rate: number;
  /** ارزش ریالی به نرخ پایان دوره */
  currentIRR: number;
  /** currentIRR − carryingIRR ؛ مثبت = سود تحقق‌نیافته */
  deltaIRR: number;
};

export type RevaluationPreview = {
  asOf: Date;
  period: { year: number; month: number };
  rates: Record<string, number>;
  lines: RevaluationLine[];
  totalGain: number;
  totalLoss: number;
  netIRR: number;
  alreadyPosted: boolean;
};

/** اقلام پولی باز: دارایی/بدهی ارزی با ماندهٔ غیرصفر */
async function collectMonetaryPositions(
  tx: Prisma.TransactionClient,
  rates: Record<string, number>,
): Promise<RevaluationLine[]> {
  const accounts = await tx.financialAccount.findMany({
    where: {
      currency: { not: 'IRR' },
      accountType: { in: ['ASSET', 'LIABILITY'] },
      isPostable: true,
      isActive: true,
      // خود حساب‌های تعدیل تجدید ارزیابی نمی‌شوند.
      // ⚠️ شرط باید NULL را صریح اجازه دهد: در SQL نتیجهٔ `NULL NOT IN (...)`
      // «نامعلوم» است نه true، و کیف پول طرف‌حساب‌ها (که code ندارند) حذف می‌شدند.
      OR: [{ code: null }, { code: { notIn: ['1900', '2900'] } }],
    },
    select: {
      id: true, name: true, code: true, currency: true, balance: true,
      ownerType: true, controlKind: true, accountType: true,
    },
  });

  // ارزش ریالی دفتری = Σ((بدهکار − بستانکار) × نرخِ همان ردیف).
  // groupBy نمی‌تواند حاصل‌ضرب ستون‌ها را جمع بزند، پس ردیف‌ها خوانده و در حافظه جمع می‌شوند.
  const lines = await tx.journalLine.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) } },
    select: { accountId: true, debit: true, credit: true, rateToIRR: true },
  });
  const carryingByAccount = new Map<string, number>();
  for (const l of lines) {
    const v = (Number(l.debit) - Number(l.credit)) * Number(l.rateToIRR);
    carryingByAccount.set(l.accountId, (carryingByAccount.get(l.accountId) || 0) + v);
  }

  const out: RevaluationLine[] = [];
  for (const acc of accounts) {
    const rawBalance = Number(acc.balance);          // بدهکار − بستانکار
    if (Math.abs(rawBalance) < 1e-9) continue;

    const rate = rates[acc.currency];
    if (!rate) throw new Error(`نرخ ${acc.currency} برای تاریخ تجدید ارزیابی داده نشده است`);

    const carryingIRR = carryingByAccount.get(acc.id) || 0;
    const currentIRR = rawBalance * rate;
    const deltaIRR = currentIRR - carryingIRR;
    if (Math.abs(deltaIRR) < 0.01) continue;

    const sign = normalSide(acc) === 'DEBIT' ? 1 : -1;
    out.push({
      accountId: acc.id,
      accountName: acc.name,
      code: acc.code,
      currency: acc.currency,
      balance: rawBalance * sign,
      carryingIRR,
      rate,
      currentIRR,
      deltaIRR,
    });
  }
  return out;
}

/** آیا برای این دوره قبلاً تجدید ارزیابی ثبت شده؟ */
async function findExisting(tx: Prisma.TransactionClient, asOf: Date) {
  const { year, month } = toJalaliYM(asOf);
  return tx.journalEntry.findFirst({
    where: { eventType: 'FX_REVALUATION', sourceType: 'Revaluation', sourceId: `${year}-${String(month).padStart(2, '0')}` },
  });
}

/** پیش‌نمایش بدون ثبت سند — برای اینکه کاربر قبل از تأیید عدد را ببیند */
export async function previewRevaluation(
  tx: Prisma.TransactionClient,
  asOf: Date,
  overrideRates?: Partial<Record<Currency, number>>,
): Promise<RevaluationPreview> {
  const live = await getRates();
  const rates: Record<string, number> = {
    IRR: 1,
    USD: overrideRates?.USD ?? live.USD_TO_IRR,
    CNY: overrideRates?.CNY ?? live.CNY_TO_IRR,
  };
  const lines = await collectMonetaryPositions(tx, rates);
  const totalGain = lines.filter((l) => l.deltaIRR > 0).reduce((s, l) => s + l.deltaIRR, 0);
  const totalLoss = lines.filter((l) => l.deltaIRR < 0).reduce((s, l) => s + -l.deltaIRR, 0);
  const existing = await findExisting(tx, asOf);

  return {
    asOf,
    period: toJalaliYM(asOf),
    rates,
    lines,
    totalGain,
    totalLoss,
    netIRR: totalGain - totalLoss,
    alreadyPosted: !!existing,
  };
}

/**
 * ثبت تجدید ارزیابی + سند برگشت اول دورهٔ بعد.
 * هر دو سند با هم ساخته می‌شوند تا برگشت هرگز فراموش نشود.
 */
export async function postRevaluation(
  tx: Prisma.TransactionClient,
  params: {
    asOf: Date;
    overrideRates?: Partial<Record<Currency, number>>;
    createdById?: string;
    force?: boolean;
  },
) {
  const preview = await previewRevaluation(tx, params.asOf, params.overrideRates);
  if (preview.alreadyPosted && !params.force) {
    throw new Error(`برای دورهٔ ${preview.period.year}/${String(preview.period.month).padStart(2, '0')} قبلاً تجدید ارزیابی ثبت شده است`);
  }
  if (!preview.lines.length) {
    return { posted: false, reason: 'هیچ قلم ارزی بازی با اختلاف ارزش وجود ندارد', preview };
  }

  const adjAsset = await tx.financialAccount.findUnique({ where: { code: '1900' } });
  const adjLiab = await tx.financialAccount.findUnique({ where: { code: '2900' } });
  if (!adjAsset || !adjLiab) throw new Error('حساب‌های تعدیل تسعیر (۱۹۰۰/۲۹۰۰) در چارت نیستند — ابتدا چارت را تکمیل کنید');

  const gainAcc = await getOrCreateControl(tx, 'FX_GAIN_UNREALIZED', 'IRR');
  const lossAcc = await getOrCreateControl(tx, 'FX_LOSS_UNREALIZED', 'IRR');

  // اثر تعدیل روی دارایی و بدهی جدا نگه داشته می‌شود تا در ترازنامه سر جای خودش بنشیند
  const accTypes = await tx.financialAccount.findMany({
    where: { id: { in: preview.lines.map((l) => l.accountId) } },
    select: { id: true, accountType: true },
  });
  const typeById = new Map(accTypes.map((a) => [a.id, a.accountType]));

  let assetDelta = 0;
  let liabDelta = 0;
  for (const l of preview.lines) {
    if (typeById.get(l.accountId) === 'ASSET') assetDelta += l.deltaIRR;
    else liabDelta += l.deltaIRR;
  }

  // deltaIRR روی مانده خام (بدهکار−بستانکار) حساب شده:
  //  دارایی: مثبت ⇒ ارزش دارایی بالا رفته ⇒ سود
  //  بدهی  : مانده خام منفی است؛ delta مثبت یعنی بدهی (به عدد مطلق) کوچک‌تر شده ⇒ سود
  const netIRR = assetDelta + liabDelta;

  const buildLines = (reverse: boolean): JournalLineInput[] => {
    const s = reverse ? -1 : 1;
    const out: JournalLineInput[] = [];
    const push = (accountId: string, amount: number, memo: string) => {
      if (Math.abs(amount) < 0.005) return;
      if (amount > 0) out.push({ accountId, debit: amount, currency: 'IRR', rateToIRR: 1, memo });
      else out.push({ accountId, credit: -amount, currency: 'IRR', rateToIRR: 1, memo });
    };
    push(adjAsset.id, assetDelta * s, 'تعدیل ارزش ریالی دارایی‌های ارزی');
    push(adjLiab.id, liabDelta * s, 'تعدیل ارزش ریالی بدهی‌های ارزی');

    // طرف مقابل: سود یا زیان تحقق‌نیافته.
    // ⚠️ انتخاب حساب باید از netIRR اصلی باشد نه از مقدارِ معکوس‌شده. اگر بر اساس
    // علامتِ معکوس انتخاب شود، سند برگشت به حساب مقابل می‌خورد: تعدیل «سود» را
    // بستانکار می‌کند و برگشت «زیان» را بدهکار. خالص درست درمی‌آید ولی صورت سود
    // و زیان با دو قلم قرینهٔ جعلی آلوده می‌شود. برگشت باید همان حساب را
    // با سمت مخالف بزند.
    const fxAcc = netIRR > 0 ? gainAcc : lossAcc;
    push(fxAcc.id, -netIRR * s, netIRR > 0 ? 'سود تسعیر تحقق‌نیافته' : 'زیان تسعیر تحقق‌نیافته');
    return out;
  };

  const periodKey = `${preview.period.year}-${String(preview.period.month).padStart(2, '0')}`;
  const label = `تجدید ارزیابی ارزی پایان دورهٔ ${periodKey}`;

  const adjustment = await postJournal(tx, {
    description: label,
    eventType: 'FX_REVALUATION',
    sourceType: 'Revaluation',
    sourceId: periodKey,
    createdById: params.createdById,
    date: params.asOf,
    lines: buildLines(false),
  });

  // برگشت در اولین لحظهٔ دورهٔ بعد
  const reversalDate = new Date(params.asOf);
  reversalDate.setDate(reversalDate.getDate() + 1);
  reversalDate.setHours(0, 0, 0, 0);

  const reversal = await postJournal(tx, {
    description: `برگشت ${label}`,
    eventType: 'FX_REVALUATION_REVERSAL',
    sourceType: 'Revaluation',
    sourceId: periodKey,
    createdById: params.createdById,
    date: reversalDate,
    lines: buildLines(true),
  });

  return {
    posted: true,
    preview,
    entryNo: adjustment.entryNo,
    reversalEntryNo: reversal.entryNo,
    assetDelta,
    liabDelta,
    netIRR,
  };
}
