import { AccountType, Currency, Prisma } from '@prisma/client';

/**
 * چارت حساب‌های استاندارد فابریک — مرجع: docs/accounting-spec.md بخش ۱
 *
 * ساختار کدگذاری:
 *   ۱xxx دارایی · ۲xxx بدهی · ۳xxx سرمایه · ۴xxx درآمد · ۵xxx هزینه
 *
 * سه لایه:
 *   ۱) سرگروه (`isPostable=false`) — فقط تجمیع می‌کند، سند نمی‌گیرد. مثل «۱۰۰۰ دارایی‌ها»
 *   ۲) گروه ارزی (`isPostable=false`) — یک گره به ازای هر ارز، مثل «۱۲۱۰ مشتریان — تومان».
 *      کیف پول طرف‌حساب‌ها فرزند همین گره‌اند (دفتر معین). ماندهٔ این گره = جمع فرزندانش،
 *      پس هرگز از دفتر معین منحرف نمی‌شود (برخلاف حساب کنترلیِ جداگانه که باید تطبیق شود).
 *   ۳) برگ قابل ثبت (`isPostable=true`) — حساب‌های کنترلی شرکت و حساب‌های نقد/بانک
 */

export type ChartNode = {
  code: string;
  name: string;
  accountType: AccountType;
  /** سرگروه است یا برگ قابل ثبت */
  isPostable: boolean;
  /** اگر پر باشد، به ازای هر سه ارز یک فرزند ساخته می‌شود */
  perCurrency?: boolean;
  /** برگ‌های ارزیِ حساب‌های کنترلی شرکت با این نوع شناخته می‌شوند */
  controlKind?: string;
  /** گروه ارزی‌ای که کیف پول این نوع طرف‌حساب زیرش می‌نشیند */
  walletOwnerType?: string;
  children?: ChartNode[];
};

const A = AccountType;

export const CHART: ChartNode[] = [
  {
    code: '1000', name: 'دارایی‌ها', accountType: A.ASSET, isPostable: false,
    children: [
      // حساب‌های نقد و بانکِ شرکت زیر این گره ساخته می‌شوند (کد ندارند، کاربر خودش می‌سازد)
      { code: '1100', name: 'نقد و بانک', accountType: A.ASSET, isPostable: false },
      {
        code: '1200', name: 'دریافتنی از مشتریان', accountType: A.ASSET, isPostable: false,
        perCurrency: true, walletOwnerType: 'CUSTOMER',
      },
      // تعدیل تجدید ارزیابی: مبلغش همیشه تومانی است و فقط ارزش ریالیِ اقلام ارزی را
      // اصلاح می‌کند — ماندهٔ ارزی خودِ حساب‌ها دست‌نخورده می‌ماند. اول دورهٔ بعد برمی‌گردد.
      { code: '1900', name: 'تعدیل تسعیر دارایی‌های ارزی', accountType: A.ASSET, isPostable: true },
    ],
  },
  {
    code: '2000', name: 'بدهی‌ها', accountType: A.LIABILITY, isPostable: false,
    children: [
      { code: '2100', name: 'پرداختنی به سازندگان', accountType: A.LIABILITY, isPostable: false, perCurrency: true, walletOwnerType: 'PRODUCER' },
      { code: '2200', name: 'پرداختنی به تأمین‌کنندگان', accountType: A.LIABILITY, isPostable: false, perCurrency: true, walletOwnerType: 'SUPPLIER' },
      { code: '2300', name: 'پرداختنی به شرکت‌های حمل', accountType: A.LIABILITY, isPostable: false, perCurrency: true, walletOwnerType: 'CARRIER' },
      { code: '2400', name: 'پرداختنی به کمیسیون‌بگیرها', accountType: A.LIABILITY, isPostable: false, perCurrency: true, walletOwnerType: 'COMMISSION_AGENT' },
      { code: '2500', name: 'پرداختنی به صرافی‌ها', accountType: A.LIABILITY, isPostable: false, perCurrency: true, walletOwnerType: 'EXCHANGE' },
      { code: '2600', name: 'مالیات بر ارزش افزوده (پرداختنی)', accountType: A.LIABILITY, isPostable: false, perCurrency: true, controlKind: 'VAT_PAYABLE' },
      { code: '2900', name: 'تعدیل تسعیر بدهی‌های ارزی', accountType: A.LIABILITY, isPostable: true },
    ],
  },
  {
    code: '3000', name: 'سرمایه', accountType: A.EQUITY, isPostable: false,
    children: [
      { code: '3100', name: 'سرمایهٔ افتتاحیه', accountType: A.EQUITY, isPostable: false, perCurrency: true, controlKind: 'OPENING' },
    ],
  },
  {
    code: '4000', name: 'درآمد', accountType: A.INCOME, isPostable: false,
    children: [
      { code: '4100', name: 'درآمد فروش', accountType: A.INCOME, isPostable: false, perCurrency: true, controlKind: 'SALES' },
      { code: '4200', name: 'درآمد فورواردینگ', accountType: A.INCOME, isPostable: false, perCurrency: true, controlKind: 'FREIGHT_INCOME' },
      {
        code: '4900', name: 'سود تسعیر ارز', accountType: A.INCOME, isPostable: false,
        children: [
          // تفکیک محقق از تحقق‌نیافته — spec بخش ۴-۳
          { code: '4910', name: 'سود تسعیر محقق‌شده', accountType: A.INCOME, isPostable: false, perCurrency: true, controlKind: 'FX_GAIN_REALIZED' },
          { code: '4920', name: 'سود تسعیر تحقق‌نیافته', accountType: A.INCOME, isPostable: false, perCurrency: true, controlKind: 'FX_GAIN_UNREALIZED' },
        ],
      },
    ],
  },
  {
    code: '5000', name: 'هزینه', accountType: A.EXPENSE, isPostable: false,
    children: [
      { code: '5100', name: 'بهای تمام‌شدهٔ خرید', accountType: A.EXPENSE, isPostable: false, perCurrency: true, controlKind: 'PURCHASE' },
      { code: '5200', name: 'هزینهٔ حمل', accountType: A.EXPENSE, isPostable: false, perCurrency: true, controlKind: 'FREIGHT' },
      { code: '5300', name: 'هزینهٔ کمیسیون', accountType: A.EXPENSE, isPostable: false, perCurrency: true, controlKind: 'COMMISSION' },
      { code: '5400', name: 'کارمزد صرافی', accountType: A.EXPENSE, isPostable: false, perCurrency: true, controlKind: 'FEE' },
      { code: '5500', name: 'هزینه‌های عمومی (تنخواه)', accountType: A.EXPENSE, isPostable: false, perCurrency: true, controlKind: 'EXPENSE' },
      {
        code: '5900', name: 'زیان تسعیر ارز', accountType: A.EXPENSE, isPostable: false,
        children: [
          { code: '5910', name: 'زیان تسعیر محقق‌شده', accountType: A.EXPENSE, isPostable: false, perCurrency: true, controlKind: 'FX_LOSS_REALIZED' },
          { code: '5920', name: 'زیان تسعیر تحقق‌نیافته', accountType: A.EXPENSE, isPostable: false, perCurrency: true, controlKind: 'FX_LOSS_UNREALIZED' },
        ],
      },
    ],
  },
];

export const CURRENCIES: Currency[] = ['IRR', 'USD', 'CNY'];
const CUR_LABEL: Record<Currency, string> = { IRR: 'تومان', USD: 'دلار', CNY: 'یوآن' };
/** رقم آخر کد برگِ ارزی: ۱=تومان ۲=دلار ۳=یوآن */
const CUR_DIGIT: Record<Currency, string> = { IRR: '1', USD: '2', CNY: '3' };

/** کد برگِ ارزی از روی کد گروه: «۴۱۰۰» + USD ⇒ «۴۱۰۲» */
export function currencyLeafCode(groupCode: string, currency: Currency): string {
  return groupCode.slice(0, -1) + CUR_DIGIT[currency];
}

export function currencyLeafName(groupName: string, currency: Currency): string {
  return `${groupName} — ${CUR_LABEL[currency]}`;
}

/** ماهیت حساب از روی طبقه‌بندی — جایگزین حدس‌زدن از controlKind */
export function normalSideOf(accountType: AccountType): 'DEBIT' | 'CREDIT' {
  return accountType === 'ASSET' || accountType === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
}

/**
 * ساخت/به‌روزرسانی کل درخت چارت. idempotent است — با کد حساب upsert می‌کند،
 * پس اجرای دوباره چیزی را دو بار نمی‌سازد و ماندهٔ موجود را هم دست نمی‌زند.
 * برمی‌گرداند: نگاشت کد → شناسه
 */
export async function ensureChartOfAccounts(
  tx: Prisma.TransactionClient,
): Promise<Map<string, string>> {
  const byCode = new Map<string, string>();

  const walk = async (nodes: ChartNode[], parentId: string | null) => {
    for (const node of nodes) {
      const acc = await tx.financialAccount.upsert({
        where: { code: node.code },
        update: { name: node.name, accountType: node.accountType, isPostable: node.isPostable, parentId },
        create: {
          code: node.code,
          name: node.name,
          accountType: node.accountType,
          isPostable: node.isPostable,
          parentId,
          // ارزِ گره‌های سرگروه معنا ندارد؛ IRR به‌عنوان مقدار خنثی گذاشته می‌شود
          currency: 'IRR',
          type: 'GROUP',
          ownerType: 'COMPANY',
        },
      });
      byCode.set(node.code, acc.id);

      // برگ‌های ارزی: به ازای هر ارز یک حساب قابل ثبت
      if (node.perCurrency) {
        for (const cur of CURRENCIES) {
          const leafCode = currencyLeafCode(node.code, cur);
          const leaf = await tx.financialAccount.upsert({
            where: { code: leafCode },
            update: {
              name: currencyLeafName(node.name, cur),
              accountType: node.accountType,
              isPostable: true,
              parentId: acc.id,
              controlKind: node.controlKind ?? null,
            },
            create: {
              code: leafCode,
              name: currencyLeafName(node.name, cur),
              accountType: node.accountType,
              isPostable: true,
              parentId: acc.id,
              currency: cur,
              // گروه‌های ارزیِ طرف‌حساب فقط ظرفِ کیف پول‌اند و خودشان سند نمی‌گیرند
              type: node.walletOwnerType ? 'SUBLEDGER_GROUP' : 'CONTROL',
              ownerType: 'COMPANY',
              controlKind: node.controlKind ?? null,
            },
          });
          byCode.set(leafCode, leaf.id);

          // گروه ارزیِ طرف‌حساب: خودش سند نمی‌گیرد، فقط کیف پول‌ها زیرش می‌نشینند
          if (node.walletOwnerType) {
            await tx.financialAccount.update({ where: { id: leaf.id }, data: { isPostable: false } });
          }
        }
      }

      if (node.children?.length) await walk(node.children, acc.id);
    }
  };

  await walk(CHART, null);
  return byCode;
}

/** گروه ارزی‌ای که کیف پول یک طرف‌حساب باید زیرش بنشیند */
export function walletParentCode(ownerType: string, currency: Currency): string | null {
  const find = (nodes: ChartNode[]): ChartNode | null => {
    for (const n of nodes) {
      if (n.walletOwnerType === ownerType) return n;
      const hit = n.children ? find(n.children) : null;
      if (hit) return hit;
    }
    return null;
  };
  const node = find(CHART);
  return node ? currencyLeafCode(node.code, currency) : null;
}

/** حساب‌های نقد/بانک/تنخواه شرکت زیر «۱۱۰۰ نقد و بانک» می‌نشینند */
export const CASH_PARENT_CODE = '1100';

/** کد برگِ کنترلی از روی نوع و ارز — جایگزین جستجو با controlKind */
export function controlLeafCode(controlKind: string, currency: Currency): string | null {
  const find = (nodes: ChartNode[]): ChartNode | null => {
    for (const n of nodes) {
      if (n.controlKind === controlKind) return n;
      const hit = n.children ? find(n.children) : null;
      if (hit) return hit;
    }
    return null;
  };
  const node = find(CHART);
  return node ? currencyLeafCode(node.code, currency) : null;
}
