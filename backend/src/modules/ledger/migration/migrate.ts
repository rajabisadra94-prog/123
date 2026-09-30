/**
 * فاز ۹ — مهاجرت از هستهٔ قدیمی به هستهٔ جدید.
 *
 * طرح در `docs/LEDGER_MIGRATION.md` است و روی دادهٔ واقعی `xfab.ir` سنجیده شده.
 *
 * **رکورد کپی نمی‌شود.** تاریخچهٔ اسناد قدیمی منتقل نمی‌شود؛ به‌جایش ماندهٔ بسته
 * در تاریخ برش محاسبه و در **یک سند افتتاحیه** ثبت می‌شود. جداول قدیمی
 * فقط‌خواندنی می‌مانند برای مراجعهٔ تاریخی.
 *
 * دو اصل که کل درستی مهاجرت به آن‌ها بند است:
 *
 * ۱) **ارزش دفتری منتقل می‌شود، نه ارزش روز.** نرخ هر موضع ارزی از خودِ دفتر
 *    قدیمی مشتق می‌شود (ارزش تومانی ثبت‌شده ÷ مبلغ ارزی). اگر نرخ روزِ برش
 *    استفاده شود، بهای تمام‌شدهٔ تاریخی پاک می‌شود و اولین تسویه بعد از مهاجرت
 *    یک سود/زیان تسعیر **جعلی** ثبت می‌کند.
 *
 * ۲) **اگر تراز بشکند، متوقف می‌شویم.** ردیف خودکارِ «مابه‌التفاوت» دقیقاً همان
 *    چیزی است که خطای واقعی را پنهان می‌کند.
 */
import { Prisma } from '@prisma/client';
import { post, DraftLine } from '../poster';
import { Minor, Rate, divRound, RATE_SCALE, rateFrom } from '../money';
import { ensureSubsidiary, REF_TYPE_KIND } from '../subsidiary';
import { integrityCheck } from '../integrity';

export class MigrationError extends Error {}

/** تومان → ریال. واحد پایه در هستهٔ جدید ریال است، در قدیمی تومان بود. */
const TOMAN_TO_RIAL = 10n;

/** نگاشت حساب کنترلی قدیمی به کد جدید — `docs/LEDGER_MIGRATION.md` بخش ۴ */
export const CONTROL_MAP: Record<string, string> = {
  OPENING: '3101',
  SALES: '4101',
  FREIGHT_INCOME: '4102',
  PURCHASE: '5101',
  FREIGHT: '5102',
  COMMISSION: '5103',
  EXPENSE: '6201',
  FEE: '7102',
  VAT_PAYABLE: '2107',
  FX_GAIN_REALIZED: '8101',
  FX_GAIN_UNREALIZED: '8102',
  FX_LOSS_REALIZED: '8201',
  FX_LOSS_UNREALIZED: '8202',
};

/** نگاشت نوع طرف‌حساب به معین مقصد و مدل کسب‌وکاری */
const OWNER_MAP: Record<string, { code: string; refType: string; kind: keyof typeof REF_TYPE_KIND extends never ? string : any }> = {
  CUSTOMER: { code: '1104', refType: 'Customer', kind: 'CUSTOMER' },
  PRODUCER: { code: '2101', refType: 'Producer', kind: 'PRODUCER' },
  SUPPLIER: { code: '2101', refType: 'Supplier', kind: 'SUPPLIER' },
  CARRIER: { code: '2101', refType: 'ShippingCompany', kind: 'CARRIER' },
  EXCHANGE: { code: '2101', refType: 'Exchange', kind: 'EXCHANGE' },
  COMMISSION_AGENT: { code: '2101', refType: 'CommissionAgent', kind: 'AGENT' },
};

const CASH_PARENT = '1101';

export interface LegacyPosition {
  legacyAccountId: string;
  name: string;
  ownerType: string | null;
  ownerId: string | null;
  controlKind: string | null;
  currency: string;
  /** مانده به ارز خودش، در واحد قدیمی (تومان برای IRR) */
  amount: Prisma.Decimal;
  /** ارزش دفتری به تومان */
  valueToman: Prisma.Decimal;
}

/**
 * ماندهٔ بستهٔ هر حساب قدیمی در تاریخ برش — **از دفتر**، نه از ستون `balance`.
 *
 * ستون `balance` در هستهٔ قدیمی جهش‌یابنده است و می‌تواند از دفتر منحرف شده باشد.
 * مبنای مهاجرت باید دفتر باشد.
 */
export async function collectLegacyPositions(
  tx: Prisma.TransactionClient,
  cutoff: Date,
): Promise<LegacyPosition[]> {
  return tx.$queryRaw<LegacyPosition[]>`
    SELECT a.id            AS "legacyAccountId",
           a.name          AS name,
           a."ownerType"   AS "ownerType",
           a."ownerId"     AS "ownerId",
           a."controlKind" AS "controlKind",
           a.currency::text AS currency,
           SUM(l.debit - l.credit)                          AS amount,
           SUM(l.debit * l."rateToIRR" - l.credit * l."rateToIRR") AS "valueToman"
    FROM "JournalLine" l
    JOIN "JournalEntry" e     ON e.id = l."entryId"
    JOIN "FinancialAccount" a ON a.id = l."accountId"
    WHERE e.date <= ${cutoff}
    GROUP BY a.id, a.name, a."ownerType", a."ownerId", a."controlKind", a.currency
    HAVING SUM(l.debit - l.credit) <> 0
        OR SUM(l.debit * l."rateToIRR" - l.credit * l."rateToIRR") <> 0
  `;
}

/** تومانِ اعشاری → ریالِ صحیح، با گرد کردن نیم‌به‌بالا */
function tomanToRial(v: Prisma.Decimal): Minor {
  const s = v.toString();
  const neg = s.startsWith('-');
  const [int, frac = ''] = (neg ? s.slice(1) : s).split('.');
  // یک رقم اعشار تومان = یک ریال
  const scaled = BigInt(int) * 10n + BigInt((frac[0] ?? '0'));
  const next = Number(frac[1] ?? '0');
  const rounded = next >= 5 ? scaled + 1n : scaled;
  return neg ? -rounded : rounded;
}

/** مبلغ ارزی → کوچک‌ترین واحد آن ارز */
function toMinor(v: Prisma.Decimal, decimals: number): Minor {
  const s = v.toString();
  const neg = s.startsWith('-');
  const [int, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const padded = (frac + '0'.repeat(decimals + 1)).slice(0, decimals + 1);
  const kept = padded.slice(0, decimals) || '0';
  const next = Number(padded[decimals] ?? '0');
  let out = BigInt(int) * 10n ** BigInt(decimals) + BigInt(kept);
  if (next >= 5) out += 1n;
  return neg ? -out : out;
}

export interface MigrationPlanLine {
  accountCode: string;
  subsidiaryId: string | null;
  subsidiaryName: string | null;
  currencyCode: string;
  amount: Minor;      // به ارز خودش، علامت‌دار (مثبت = بدهکار)
  base: Minor;        // به ریال، علامت‌دار
  rate: Rate;
  source: string;
}

/**
 * ساخت طرح مهاجرت — بدون نوشتن چیزی.
 *
 * جدا از اجرا است تا بشود اول دید چه می‌شود، بعد تصمیم گرفت.
 */
export async function buildMigrationPlan(
  tx: Prisma.TransactionClient,
  cutoff: Date,
): Promise<{ lines: MigrationPlanLine[]; unmapped: LegacyPosition[]; totalBase: Minor }> {
  const positions = await collectLegacyPositions(tx, cutoff);
  const allCurrencies = await tx.glCurrency.findMany();
  const currencies = new Map(allCurrencies.map((c) => [c.code, c.decimalPlaces]));
  const base_code = allCurrencies.find((c) => c.isBase)?.code;
  if (!base_code) throw new MigrationError('هیچ ارز پایه‌ای تعریف نشده است');

  const lines: MigrationPlanLine[] = [];
  const unmapped: LegacyPosition[] = [];
  const cashCodes = new Map<string, string>();   // legacyAccountId → کد جدید

  for (const p of positions) {
    const decimals = currencies.get(p.currency);
    if (decimals === undefined) {
      unmapped.push(p);
      continue;
    }

    /**
     * ⚠️ ارز پایه استثناست: در هستهٔ قدیمی مبلغ ریالی به **تومان** است و باید
     * مثل ارزش دفتری در ۱۰ ضرب شود. اگر مثل ارزهای دیگر رفتار شود، مبلغ
     * ده برابر کوچک می‌ماند و نرخ ۱۰ مشتق می‌شود — که ارزش پایه را درست
     * درمی‌آورد و برای همین **تریگر توازن هم نمی‌گیردش**.
     */
    const amount = p.currency === base_code ? tomanToRial(p.amount) : toMinor(p.amount, decimals);
    const base = tomanToRial(p.valueToman);
    if (amount === 0n && base === 0n) continue;

    // ── تعیین حساب مقصد و تفصیلی ──
    let accountCode: string | null = null;
    let subsidiaryId: string | null = null;
    let subsidiaryName: string | null = null;

    if (p.controlKind && CONTROL_MAP[p.controlKind]) {
      accountCode = CONTROL_MAP[p.controlKind];
    } else if (p.ownerType && p.ownerType !== 'COMPANY' && OWNER_MAP[p.ownerType]) {
      const m = OWNER_MAP[p.ownerType];
      accountCode = m.code;
      if (!p.ownerId) {
        unmapped.push(p);
        continue;
      }
      const sub = await ensureSubsidiary(tx, m.kind, m.refType, p.ownerId, p.name.replace(/\s*-\s*\w+$/, ''));
      subsidiaryId = sub.id;
      subsidiaryName = sub.name;
    } else if (p.ownerType === 'COMPANY') {
      // حساب نقد/بانک شرکت → برگ تازه زیر ۱۱۰۱
      accountCode = cashCodes.get(p.legacyAccountId) ?? (await ensureCashLeaf(tx, p));
      cashCodes.set(p.legacyAccountId, accountCode);
    }

    if (!accountCode) {
      unmapped.push(p);
      continue;
    }

    /**
     * نرخ از **خودِ دفتر قدیمی** مشتق می‌شود: ارزش تومانی ثبت‌شده ÷ مبلغ ارزی.
     * این دقیقاً همان ارزشی است که امروز در ترازنامه نشسته، پس مهاجرت ترازنامه
     * را عوض نمی‌کند. نرخ روزِ برش، بهای تمام‌شدهٔ تاریخی را پاک می‌کرد.
     */
    const rate: Rate =
      amount === 0n
        ? rateFrom(1)
        : { scaled: divRound(absOf(base) * RATE_SCALE * 10n ** BigInt(decimals), absOf(amount)) };

    lines.push({
      accountCode, subsidiaryId, subsidiaryName,
      currencyCode: p.currency, amount, base, rate,
      source: p.name,
    });
  }

  return {
    lines,
    unmapped,
    totalBase: lines.reduce((s, l) => s + l.base, 0n),
  };
}

const absOf = (v: bigint) => (v < 0n ? -v : v);

/** برگ تازه برای یک حساب نقدی شرکت، زیر «۱۱۰۱ موجودی نقد و بانک» */
async function ensureCashLeaf(tx: Prisma.TransactionClient, p: LegacyPosition): Promise<string> {
  const existing = await tx.glAccount.findFirst({
    where: { parent: { code: CASH_PARENT }, name: p.name },
  });
  if (existing) return existing.code;

  const parent = await tx.glAccount.findUniqueOrThrow({ where: { code: CASH_PARENT } });
  const siblings = await tx.glAccount.findMany({
    where: { parentId: parent.id }, orderBy: { code: 'desc' }, take: 1,
  });
  const next = siblings.length ? String(Number(siblings[0].code) + 1) : `${CASH_PARENT}01`;

  const created = await tx.glAccount.create({
    data: {
      code: next, name: p.name, level: parent.level + 1, parentId: parent.id,
      rootType: parent.rootType, normalSide: parent.normalSide, statement: parent.statement,
      isPostable: true, currencyMode: 'SINGLE', currencyCode: p.currency,
      sortIndex: parent.sortIndex, isSystem: false,
    },
  });
  return created.code;
}

/**
 * ثبت سند افتتاحیه.
 *
 * حساب‌های **موقت هم منتقل می‌شوند** (تصمیم قفل‌شده: برش وسط سال). اگر فقط
 * دائم‌ها منتقل شوند، صورت سود و زیان سال جاری صفر می‌شود.
 */
export async function postOpeningEntry(
  tx: Prisma.TransactionClient,
  input: { fiscalYearId: string; cutoff: Date; createdById?: string | null; allowRoundingPlug?: boolean },
) {
  const plan = await buildMigrationPlan(tx, input.cutoff);

  if (plan.unmapped.length) {
    const names = plan.unmapped.map((u) => `${u.name} (${u.currency})`).join('، ');
    throw new MigrationError(
      `این حساب‌های قدیمی نگاشت ندارند و مهاجرت متوقف شد: ${names}`,
    );
  }
  if (!plan.lines.length) throw new MigrationError('هیچ ماندهٔ باز‌ی برای انتقال نیست');

  const lines: DraftLine[] = plan.lines.map((l) => ({
    accountId: '',      // در ادامه پر می‌شود
    subsidiaryId: l.subsidiaryId,
    currencyCode: l.currencyCode,
    ...(l.base > 0n ? { debit: absOf(l.amount) } : { credit: absOf(l.amount) }),
    rate: l.rate,
    memo: `افتتاحیه — ${l.source}`,
  })) as DraftLine[];

  // شناسهٔ حساب‌ها
  for (const [i, l] of plan.lines.entries()) {
    const acc = await tx.glAccount.findUniqueOrThrow({ where: { code: l.accountCode } });
    lines[i].accountId = acc.id;
  }

  /**
   * تراز پس از گرد کردن.
   *
   * دفتر قدیمی به تومانِ اعشاری تراز است؛ پس از تبدیل به ریالِ صحیح ممکن است
   * چند ریال اختلاف بماند. اگر ماند، **متوقف می‌شویم** — استفاده از حساب
   * «اختلاف گرد کردن» فقط با تأیید صریح انسانی.
   */
  const diff = plan.lines.reduce((s, l) => s + l.base, 0n);
  if (diff !== 0n) {
    if (!input.allowRoundingPlug) {
      throw new MigrationError(
        `پس از تبدیل به ریال صحیح، ${diff} ریال اختلاف مانده است. ` +
        'پیش از ادامه بررسی کنید؛ برای ثبت با حساب «اختلاف گرد کردن» ' +
        'allowRoundingPlug را صریحاً فعال کنید.',
      );
    }
    const plug = await tx.glAccount.findUniqueOrThrow({ where: { code: '8203' } });
    lines.push({
      accountId: plug.id, currencyCode: 'IRR',
      ...(diff > 0n ? { credit: absOf(diff) } : { debit: absOf(diff) }),
      rate: rateFrom(1), memo: 'اختلاف گرد کردن در مهاجرت',
    } as DraftLine);
  }

  const entry = await post(tx, {
    fiscalYearId: input.fiscalYearId,
    date: input.cutoff,
    description: `سند افتتاحیه — انتقال مانده در برش سامانه (${input.cutoff.toISOString().slice(0, 10)})`,
    entryType: 'OPENING',
    sourceType: 'Migration',
    sourceId: input.cutoff.toISOString().slice(0, 10),
    createdById: input.createdById ?? null,
    lines,
  });

  return { entry, plan, roundingDiff: diff };
}

// ───────────────────────────────────────────────────────────────
// سنجه‌های پذیرش — `docs/LEDGER_MIGRATION.md` بخش ۶
// ───────────────────────────────────────────────────────────────

export interface VerificationReport {
  ok: boolean;
  /** ۱) اختلاف ارزش پایهٔ کل، به ریال */
  totalBaseDiff: bigint;
  /** ۲) موضع‌های ارزی که مبلغشان نخوانده */
  amountMismatches: { source: string; currency: string; legacy: string; migrated: string }[];
  /** ۳) موضع‌هایی که ارزش پایه‌شان بیش از ۱ ریال اختلاف دارد */
  valueMismatches: { source: string; currency: string; diff: string }[];
  /** ۴) سلامت دفتر جدید */
  integrity: Awaited<ReturnType<typeof integrityCheck>>;
}

/**
 * تطبیق هستهٔ جدید با هستهٔ قدیمی پس از مهاجرت.
 *
 * سنجهٔ ۲ عمداً جدا از ۱ است: ممکن است جمع ریالی درست دربیاید ولی موضع‌های
 * ارزی جابه‌جا شده باشند. هر دو باید سنجیده شوند.
 */
export async function verifyMigration(
  tx: Prisma.TransactionClient,
  cutoff: Date,
): Promise<VerificationReport> {
  const legacy = await collectLegacyPositions(tx, cutoff);
  const allCurrencies = await tx.glCurrency.findMany();
  const currencies = new Map(allCurrencies.map((c) => [c.code, c.decimalPlaces]));
  const baseCode = allCurrencies.find((c) => c.isBase)?.code;

  const legacyTotal = legacy.reduce((s, p) => s + tomanToRial(p.valueToman), 0n);

  const migratedRows = await tx.$queryRaw<{ base: bigint | null }[]>`
    SELECT (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS base
    FROM "GlLine" l JOIN "GlEntry" e ON e.id = l."entryId"
    WHERE e."sourceType" = 'Migration'
  `;
  const migratedTotal = BigInt(migratedRows[0]?.base ?? 0n);

  // ── مقایسهٔ موضع‌به‌موضع ──
  const amountMismatches: VerificationReport['amountMismatches'] = [];
  const valueMismatches: VerificationReport['valueMismatches'] = [];

  for (const p of legacy) {
    const decimals = currencies.get(p.currency);
    if (decimals === undefined) continue;

    const expectedAmount = p.currency === baseCode ? tomanToRial(p.amount) : toMinor(p.amount, decimals);
    const expectedBase = tomanToRial(p.valueToman);

    // همان موضع در هستهٔ جدید: با تفصیلی و ارز پیدا می‌شود
    const subFilter =
      p.ownerType && p.ownerType !== 'COMPANY' && p.ownerId
        ? Prisma.sql`AND s."refId" = ${p.ownerId}`
        : Prisma.sql`AND l."subsidiaryId" IS NULL`;

    const rows = await tx.$queryRaw<{ amount: bigint | null; base: bigint | null }[]>`
      SELECT (SUM(l.debit) - SUM(l.credit))::bigint             AS amount,
             (SUM(l."debitBase") - SUM(l."creditBase"))::bigint AS base
      FROM "GlLine" l
      JOIN "GlEntry" e ON e.id = l."entryId"
      LEFT JOIN "GlSubsidiary" s ON s.id = l."subsidiaryId"
      WHERE e."sourceType" = 'Migration'
        AND l."currencyCode" = ${p.currency}
        AND l.memo = ${`افتتاحیه — ${p.name}`}
        ${subFilter}
    `;
    const gotAmount = BigInt(rows[0]?.amount ?? 0n);
    const gotBase = BigInt(rows[0]?.base ?? 0n);

    if (gotAmount !== absOf(expectedAmount) && gotAmount !== expectedAmount) {
      amountMismatches.push({
        source: p.name, currency: p.currency,
        legacy: expectedAmount.toString(), migrated: gotAmount.toString(),
      });
    }
    const baseDiff = absOf(gotBase) - absOf(expectedBase);
    if (absOf(baseDiff) > 1n) {
      valueMismatches.push({ source: p.name, currency: p.currency, diff: baseDiff.toString() });
    }
  }

  const integrity = await integrityCheck(tx);
  const totalBaseDiff = migratedTotal - legacyTotal;

  return {
    ok: totalBaseDiff === 0n && !amountMismatches.length && !valueMismatches.length && integrity.ok,
    totalBaseDiff,
    amountMismatches,
    valueMismatches,
    integrity,
  };
}
