/**
 * چارت حساب‌های استاندارد — docs/ACCOUNTING_SPEC.md بخش ۳-۱ و بخش ۴
 *
 * هشت سرفصل ریشه، با ترتیب نقدشوندگی **در خود کد**:
 *   ۱ دارایی (۱۱ جاری پیش از ۱۲ غیرجاری) · ۲ بدهی (۲۱ جاری پیش از ۲۲ بلندمدت)
 *   ۳ حقوق صاحبان سهام · ۴ فروش · ۵ هزینهٔ تولید · ۶ اداری و عمومی
 *   ۷ هزینهٔ مالی · ۸ غیرعملیاتی (۸۱ درآمد، ۸۲ هزینه)
 *
 * بند ۴ سند مرجع: حساب‌های ماژول‌هایی که هنوز ساخته نشده‌اند (چک، حقوق، انبار)
 * **از همین حالا** رزرو می‌شوند. افزودن ماژول بعداً ارزان است؛ بازسازی کدینگ گران.
 */
import { Prisma, GlRootType, GlSide, GlStatement, GlCurrencyMode, GlSubsidiaryKind } from '@prisma/client';

export type ChartNode = {
  code: string;
  name: string;
  rootType?: GlRootType;
  /** برگ قابل ثبت؟ پیش‌فرض: گره‌های بدون فرزند برگ‌اند */
  postable?: boolean;
  currencyMode?: GlCurrencyMode;
  currencyCode?: string;
  requiresSubsidiary?: boolean;
  subsidiaryKinds?: GlSubsidiaryKind[];
  requiresCostCenter?: boolean;
  /**
   * حساب **کاهنده** — ماهیتش عکس طبقه‌بندی‌اش است (ممیزی ن۴).
   *
   * استهلاک انباشته دارایی است ولی ماندهٔ بستانکار دارد؛ برگشت از فروش درآمد
   * است ولی ماندهٔ بدهکار. بدون این پرچم، `normalSideOf` که جهت را فقط از
   * `rootType` می‌سازد، هیچ‌وقت نمی‌تواند جهتِ درست را بدهد.
   *
   * گزارش‌ها امروز از `rootType` و علامتِ مانده استفاده می‌کنند و درست کار
   * می‌کنند، ولی `normalSide` در محاسبهٔ موضع ارزی (`fx.ts`) و صورتحساب
   * طرف‌حساب واقعاً خوانده می‌شود؛ اگر روزی حساب کاهندهٔ ارزی یا
   * طرف‌حساب‌داری اضافه شود، علامت وارونه می‌شد.
   */
  contra?: boolean;
  children?: ChartNode[];
};

const K = GlSubsidiaryKind;

/** طرف‌حساب‌های بستانکاری که همه زیر «پرداختنی تجاری» می‌نشینند */
const PAYABLE_KINDS = [K.PRODUCER, K.SUPPLIER, K.CARRIER, K.EXCHANGE, K.AGENT];

export const CHART: ChartNode[] = [
  {
    code: '1', name: 'دارایی‌ها', rootType: 'ASSET',
    children: [
      {
        code: '11', name: 'دارایی‌های جاری',
        children: [
          {
            code: '1101', name: 'موجودی نقد و بانک',
            children: [
              { code: '110101', name: 'صندوق' },
              // حساب‌های بانکی واقعی اینجا اضافه می‌شوند؛ هرکدام تک‌ارزی
            ],
          },
          { code: '1102', name: 'تنخواه‌گردان', requiresSubsidiary: true, subsidiaryKinds: [K.PETTY_CASH_HOLDER, K.EMPLOYEE] },
          {
            code: '1103', name: 'اسناد دریافتنی',
            children: [
              { code: '110301', name: 'چک نزد صندوق', requiresSubsidiary: true, subsidiaryKinds: [K.CUSTOMER, K.OTHER] },
              { code: '110302', name: 'چک در جریان وصول', requiresSubsidiary: true, subsidiaryKinds: [K.CUSTOMER, K.OTHER] },
              { code: '110303', name: 'چک نزد بانک به‌عنوان وثیقه', requiresSubsidiary: true, subsidiaryKinds: [K.CUSTOMER, K.OTHER] },
              { code: '110304', name: 'چک خرج‌شده', requiresSubsidiary: true, subsidiaryKinds: [K.CUSTOMER, K.OTHER] },
              { code: '110305', name: 'چک برگشتی', requiresSubsidiary: true, subsidiaryKinds: [K.CUSTOMER, K.OTHER] },
            ],
          },
          { code: '1104', name: 'حساب‌های دریافتنی تجاری', requiresSubsidiary: true, subsidiaryKinds: [K.CUSTOMER] },
          { code: '1105', name: 'پیش‌پرداخت‌ها', requiresSubsidiary: true, subsidiaryKinds: PAYABLE_KINDS },
          { code: '1106', name: 'موجودی کالا' },
          { code: '1107', name: 'وام و مساعدهٔ کارکنان', requiresSubsidiary: true, subsidiaryKinds: [K.EMPLOYEE] },
          // تعدیل تجدید ارزیابی: مبلغش همیشه به ارز پایه است و فقط ارزش ریالیِ اقلام
          // ارزی را اصلاح می‌کند. اگر روی خود حساب ارزی می‌نشست، ماندهٔ ارزی طرف‌حساب
          // با یک عدد ریالی آلوده می‌شد. اول دورهٔ بعد برمی‌گردد.
          { code: '1108', name: 'تعدیل تسعیر دارایی‌های ارزی', currencyMode: 'SINGLE', currencyCode: 'IRR' },
          // ممیزی ج۶: اعتبار مالیاتیِ خرید — طرفِ دارایی‌ایِ مالیات ارزش افزوده،
          // تا مالیات خالص (فروش منهای خرید) و اظهارنامهٔ فصلی از سیستم دربیاید.
          { code: '1109', name: 'مالیات بر ارزش افزودهٔ خرید (اعتبار مالیاتی)' },
          // مرحلهٔ ۴ د: ذخیرهٔ مطالبات مشکوک‌الوصول — حسابِ کاهندهٔ دارایی.
          // مثل «۱۲۰۲ استهلاک انباشته» زیر دارایی می‌نشیند ولی ماندهٔ بستانکار
          // دارد، پس در ترازنامه از دریافتنی کم می‌شود. **جدا از ۱۱۰۴** است تا
          // طلبِ حقوقیِ ما از مشتری دست‌نخورده بماند؛ ذخیره یک برآورد است، نه
          // بخشش طلب.
          { code: '1110', name: 'ذخیرهٔ مطالبات مشکوک‌الوصول', currencyMode: 'SINGLE', currencyCode: 'IRR', contra: true },
        ],
      },
      {
        code: '12', name: 'دارایی‌های غیرجاری',
        children: [
          { code: '1201', name: 'دارایی‌های ثابت مشهود' },
          { code: '1202', name: 'استهلاک انباشته', contra: true },
        ],
      },
    ],
  },
  {
    code: '2', name: 'بدهی‌ها', rootType: 'LIABILITY',
    children: [
      {
        code: '21', name: 'بدهی‌های جاری',
        children: [
          { code: '2101', name: 'حساب‌های پرداختنی تجاری', requiresSubsidiary: true, subsidiaryKinds: PAYABLE_KINDS },
          { code: '2102', name: 'اسناد پرداختنی', requiresSubsidiary: true, subsidiaryKinds: PAYABLE_KINDS },
          { code: '2103', name: 'پیش‌دریافت‌ها', requiresSubsidiary: true, subsidiaryKinds: [K.CUSTOMER] },
          { code: '2104', name: 'حقوق پرداختنی', requiresSubsidiary: true, subsidiaryKinds: [K.EMPLOYEE] },
          { code: '2105', name: 'بیمهٔ پرداختنی' },
          { code: '2106', name: 'مالیات حقوق پرداختنی' },
          { code: '2107', name: 'مالیات بر ارزش افزودهٔ پرداختنی' },
          { code: '2108', name: 'ذخیرهٔ عیدی' },
          { code: '2109', name: 'ذخیرهٔ سنوات' },
          { code: '2110', name: 'ذخیرهٔ مرخصی' },
          { code: '2111', name: 'تعدیل تسعیر بدهی‌های ارزی', currencyMode: 'SINGLE', currencyCode: 'IRR' },
          { code: '2112', name: 'ذخیرهٔ مالیات بر درآمد' },      // ممیزی ج۳
          { code: '2113', name: 'سود سهام پرداختنی' },           // ممیزی ج۷
        ],
      },
      {
        code: '22', name: 'بدهی‌های بلندمدت',
        children: [{ code: '2201', name: 'تسهیلات بلندمدت' }],
      },
    ],
  },
  {
    code: '3', name: 'حقوق صاحبان سهام', rootType: 'EQUITY',
    children: [
      {
        code: '31', name: 'سرمایه و اندوخته',
        children: [
          { code: '3101', name: 'سرمایه' },
          { code: '3102', name: 'سود و زیان انباشته' },
          { code: '3103', name: 'اندوختهٔ قانونی' },                                       // ممیزی ج۴ (مادهٔ ۱۴۰ ق.ت)
          { code: '3104', name: 'جاری شرکا', requiresSubsidiary: true, subsidiaryKinds: [K.OTHER] }, // ممیزی ج۷
        ],
      },
    ],
  },
  {
    code: '4', name: 'فروش', rootType: 'INCOME',
    children: [
      {
        code: '41', name: 'درآمد عملیاتی',
        children: [
          { code: '4101', name: 'فروش کالا' },
          { code: '4102', name: 'فروش خدمات (فورواردینگ)' },
          { code: '4103', name: 'برگشت از فروش', contra: true },
          { code: '4104', name: 'تخفیفات فروش', contra: true },
        ],
      },
    ],
  },
  {
    code: '5', name: 'هزینه‌های تولید', rootType: 'EXPENSE',
    children: [
      {
        code: '51', name: 'بهای تمام‌شده',
        children: [
          { code: '5101', name: 'بهای تمام‌شدهٔ کالای فروش‌رفته' },
          { code: '5102', name: 'هزینهٔ حمل (مستقیم)' },
          { code: '5103', name: 'هزینهٔ کمیسیون (مستقیم)' },
          { code: '5104', name: 'برگشت از خرید', contra: true },      // ممیزی ج۵ (کاهندهٔ بهای تمام‌شده)
          { code: '5105', name: 'تخفیفات خرید', contra: true },       // ممیزی ج۵
        ],
      },
    ],
  },
  {
    code: '6', name: 'هزینه‌های اداری و عمومی', rootType: 'EXPENSE',
    children: [
      {
        code: '61', name: 'هزینه‌های پرسنلی',
        children: [
          { code: '6101', name: 'حقوق و دستمزد', requiresCostCenter: true },
          { code: '6102', name: 'بیمهٔ سهم کارفرما', requiresCostCenter: true },
          { code: '6103', name: 'عیدی', requiresCostCenter: true },
          { code: '6104', name: 'سنوات', requiresCostCenter: true },
          { code: '6105', name: 'مرخصی استفاده‌نشده', requiresCostCenter: true },
        ],
      },
      {
        code: '62', name: 'هزینه‌های عمومی',
        children: [
          { code: '6201', name: 'هزینه‌های عمومی (تنخواه)' },
          { code: '6202', name: 'اجاره' },
          { code: '6203', name: 'حمل‌ونقل و سفر' },
          { code: '6204', name: 'هزینهٔ مطالبات مشکوک‌الوصول' },   // ممیزی ب۱۰ (سوخت چک/طلب)
          { code: '6205', name: 'هزینهٔ استهلاک' },                // ممیزی ج۲ (طرفِ هزینهٔ ۱۲۰۲)

          // ممیزی سوم (بخش الف): «دسته‌بندی هزینه»ی هستهٔ قدیمی — ده دستهٔ ثابت
          // که در `AccountingPage` هاردکد بود — همان چیزی است که در دفترداری
          // استاندارد **حساب معین** نام دارد، نه یک بُعد جداگانه. هستهٔ جدید همه
          // را در ۶۲۰۱ می‌ریخت و تفکیک را از دست می‌داد.
          //
          // مرکز هزینه بُعدِ عمود می‌ماند («کدام واحد») و اینها می‌گویند «چه نوع
          // هزینه‌ای» — دو سؤال متفاوت، دو مکانیزم متفاوت.
          { code: '6206', name: 'ملزومات اداری' },
          { code: '6207', name: 'پذیرایی' },
          { code: '6208', name: 'پست و پیک' },
          { code: '6209', name: 'تعمیر و نگهداری' },
          { code: '6210', name: 'قبوض (آب، برق، تلفن، اینترنت)' },
          { code: '6211', name: 'بازاریابی و تبلیغات' },
          { code: '6212', name: 'خدمات حرفه‌ای (حسابرسی، مشاوره، وکالت)' },
          { code: '6213', name: 'سایر هزینه‌های اداری' },
        ],
      },
    ],
  },
  {
    code: '7', name: 'هزینه‌های مالی', rootType: 'EXPENSE',
    children: [
      {
        code: '71', name: 'هزینه‌های مالی',
        children: [
          { code: '7101', name: 'کارمزد بانکی' },
          { code: '7102', name: 'کارمزد صرافی' },
          { code: '7103', name: 'سود تسهیلات' },
        ],
      },
    ],
  },
  {
    // تنها سرفصلی که دو ماهیت زیرش دارد: ۸۱ درآمد و ۸۲ هزینه.
    // `rootType` اینجا فقط **برچسب نمایشی** است و در هیچ محاسبه‌ای وارد نمی‌شود،
    // چون گزارش‌ها از برگ‌ها تجمیع می‌کنند و برگ‌ها طبقه‌بندی خودشان را دارند.
    code: '8', name: 'درآمدها و هزینه‌های غیرعملیاتی', rootType: 'INCOME',
    children: [
      {
        code: '81', name: 'درآمدهای غیرعملیاتی', rootType: 'INCOME',
        children: [
          { code: '8101', name: 'سود تسعیر ارز محقق‌شده' },
          { code: '8102', name: 'سود تسعیر ارز تحقق‌نیافته' },
          { code: '8103', name: 'سایر درآمدهای غیرعملیاتی' },
        ],
      },
      {
        code: '82', name: 'هزینه‌های غیرعملیاتی', rootType: 'EXPENSE',
        children: [
          { code: '8201', name: 'زیان تسعیر ارز محقق‌شده' },
          { code: '8202', name: 'زیان تسعیر ارز تحقق‌نیافته' },
          { code: '8203', name: 'اختلاف گرد کردن' },
          { code: '8204', name: 'سایر هزینه‌های غیرعملیاتی' },
          // ممیزی ج۳: مالیات بر درآمد پس از سود عملیاتی می‌آید؛ صورت سود و زیان
          // آن را جدا از «سایر» نشان می‌دهد (سود قبل از مالیات ← مالیات ← سود خالص).
          { code: '8205', name: 'مالیات بر درآمد' },
        ],
      },
    ],
  },
];

/** طول کد هر سطح — پیش‌فرض؛ در جدول GlCodeLevel قابل تغییر است */
export const DEFAULT_CODE_LEVELS = [
  { level: 1, name: 'گروه', digits: 1 },
  { level: 2, name: 'کل', digits: 1 },
  { level: 3, name: 'معین', digits: 2 },
  { level: 4, name: 'تفصیلی', digits: 2 },
];

export const DEFAULT_CURRENCIES = [
  { code: 'IRR', name: 'ریال', symbol: 'ریال', decimalPlaces: 0, isBase: true, sortIndex: 0 },
  { code: 'USD', name: 'دلار آمریکا', symbol: '$', decimalPlaces: 2, isBase: false, sortIndex: 1 },
  { code: 'CNY', name: 'یوآن چین', symbol: '¥', decimalPlaces: 2, isBase: false, sortIndex: 2 },
  { code: 'AED', name: 'درهم امارات', symbol: 'د.إ', decimalPlaces: 2, isBase: false, sortIndex: 3 },
];

/**
 * ماهیت حساب از روی طبقه‌بندی — حدس زده نمی‌شود.
 *
 * `contra` جهت را برمی‌گرداند: حساب کاهنده در همان طبقه می‌ماند (تا در
 * ترازنامه زیر همان سرفصل و با علامت منفی بنشیند) ولی ماندهٔ طبیعی‌اش
 * عکس است. ممیزی ن۴.
 */
export function normalSideOf(root: GlRootType, contra = false): GlSide {
  const natural: GlSide = root === 'ASSET' || root === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
  if (!contra) return natural;
  return natural === 'DEBIT' ? 'CREDIT' : 'DEBIT';
}

export function statementOf(root: GlRootType): GlStatement {
  return root === 'ASSET' || root === 'LIABILITY' || root === 'EQUITY'
    ? 'BALANCE_SHEET'
    : 'INCOME_STATEMENT';
}

/**
 * ساخت/به‌روزرسانی چارت — idempotent.
 * برگ‌بودن از **نداشتن فرزند** مشتق می‌شود، نه از یک پرچم دستی که می‌تواند با
 * ساختار ناسازگار شود.
 */
export async function ensureChart(tx: Prisma.TransactionClient): Promise<Map<string, string>> {
  for (const lvl of DEFAULT_CODE_LEVELS) {
    await tx.glCodeLevel.upsert({ where: { level: lvl.level }, update: lvl, create: lvl });
  }
  for (const c of DEFAULT_CURRENCIES) {
    await tx.glCurrency.upsert({ where: { code: c.code }, update: c, create: c });
  }

  const byCode = new Map<string, string>();
  let sortIndex = 0;

  const walk = async (nodes: ChartNode[], parentId: string | null, level: number, inherited?: GlRootType) => {
    for (const node of nodes) {
      const root = node.rootType ?? inherited;
      if (!root) throw new Error(`گره ${node.code} طبقه‌بندی (rootType) ندارد`);

      const isLeaf = !node.children?.length;
      const postable = node.postable ?? isLeaf;

      const data = {
        name: node.name,
        level,
        parentId,
        rootType: root,
        normalSide: normalSideOf(root, node.contra),
        statement: statementOf(root),
        isPostable: postable,
        currencyMode: node.currencyMode ?? GlCurrencyMode.MULTI,
        currencyCode: node.currencyCode ?? null,
        requiresSubsidiary: node.requiresSubsidiary ?? false,
        subsidiaryKinds: node.subsidiaryKinds ?? [],
        requiresCostCenter: node.requiresCostCenter ?? false,
        sortIndex: sortIndex++,
        isSystem: true,
        // ⚠️ `isActive` عمداً این‌جا نیست. غیرفعال کردنِ یک حساب، تصمیمِ همان
        // شرکت است — مثلاً «۱۱۰۶ موجودی کالا» برای شرکتی که خدماتی است — و
        // هم‌گام‌سازیِ چارت در هر دیپلوی نباید آن را برگرداند.
      };

      const acc = await tx.glAccount.upsert({
        where: { code: node.code },
        update: data,
        create: { code: node.code, ...data },
      });
      byCode.set(node.code, acc.id);

      if (node.children?.length) await walk(node.children, acc.id, level + 1, root);
    }
  };

  await walk(CHART, null, 1);
  return byCode;
}
