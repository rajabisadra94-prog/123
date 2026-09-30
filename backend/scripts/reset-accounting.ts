/**
 * صفر کردنِ حسابداری در **هر دو هسته** — فقط برای محیط آزمون.
 *
 * ─── چه چیزی پاک می‌شود ────────────────────────────────────────
 *
 * همهٔ **اعداد** و همهٔ **سندهای کسب‌وکاری که اثر حسابداری دارند**، تا بشود
 * جریان را از صفر دوباره اجرا کرد و دید هر دو هسته یکسان پر می‌شوند.
 *
 * ─── چه چیزی می‌ماند ───────────────────────────────────────────
 *
 * چارت حساب‌ها (هر دو هسته)، مشتری، پروژه، محموله، کارمند، نرخ ارز، سال مالی،
 * و کاربران. یعنی دادهٔ **پایه** می‌ماند و دادهٔ **جریان** پاک می‌شود.
 *
 * ─── سه قاعده ──────────────────────────────────────────────────
 *
 * ۱) **فقط با تأیید صریح.** بدون `--yes` هیچ چیزی پاک نمی‌شود؛ فقط گزارش
 *    می‌دهد که چه چیزی پاک **می‌شد**. اسکریپتی که با یک اجرای اشتباهی دفتر
 *    را خالی کند، نباید وجود داشته باشد.
 *
 * ۲) **سه قفل، نه یکی.** `--yes` + نامِ دیتابیس در `--db=` که باید با
 *    دیتابیسِ متصل **دقیقاً** بخواند + ردِ هر نامی که `prod` دارد.
 *
 *    ⚠️ نسخهٔ اول `NODE_ENV=production` را نشانهٔ پروداکشن گرفت و staging را
 *    رد کرد — staging هم قانوناً با بیلد پروداکشن اجرا می‌شود. سیگنالِ درست
 *    **نام دیتابیس** است (`factory_staging` در برابر `factory_prod`)، و
 *    واداشتنِ اپراتور به تایپِ همان نام، اجرای اشتباهی روی ماشین دیگر را
 *    عملاً ناممکن می‌کند.
 *
 * ۳) **هر حذف شمرده و چاپ می‌شود.** پاک‌سازیِ بی‌صدا بدترین نوعش است.
 *
 * ─── و چرا تریگرها موقتاً خاموش می‌شوند ─────────────────────────
 *
 * هستهٔ جدید یک تریگرِ تغییرناپذیری دارد: «ردیف سند ثبت‌شده تغییر نمی‌کند.
 * اصلاح فقط با سند برگشتی.» این تضمین **درست** است و نباید ضعیف شود — پس
 * به‌جای دست بردن در خودِ تریگر، این اسکریپت فقط برای مدتِ حذف، تریگرهای
 * دو جدولِ `GlLine` و `GlEntry` را نقطه‌ای خاموش و بلافاصله روشن می‌کند.
 *
 * یعنی در استفادهٔ عادی حتی سوپرادمین هم نمی‌تواند سند را دستکاری کند؛ فقط
 * این اسکریپتِ محیطِ آزمون، با سه قفلی که بالا آمد.
 */
import prisma from '../src/shared/utils/prisma';

const YES = process.argv.includes('--yes');

/** ترتیب مهم است: فرزندان پیش از والدین، وگرنه کلید خارجی می‌شکند */
const STEPS: { label: string; run: () => Promise<number> }[] = [
  // ── هستهٔ جدید: مشتقات پیش از سند ──
  { label: 'تخصیص پرداخت به فاکتور', run: async () => (await prisma.glAllocation.deleteMany({})).count },
  { label: 'دوره‌های استهلاک', run: async () => (await prisma.glDepreciationRun.deleteMany({})).count },
  { label: 'دارایی‌های ثابت', run: async () => (await prisma.glFixedAsset.deleteMany({})).count },
  { label: 'بودجه', run: async () => (await prisma.glBudget.deleteMany({})).count },
  { label: 'گذارهای چک', run: async () => (await prisma.glChequeTransition.deleteMany({})).count },
  { label: 'چک‌ها', run: async () => (await prisma.glCheque.deleteMany({})).count },
  { label: 'تنخواه‌گردان', run: async () => (await prisma.glPettyCashFund.deleteMany({})).count },
  { label: 'اقلام لیست حقوق', run: async () => (await prisma.glPayrollItem.deleteMany({})).count },
  { label: 'لیست‌های حقوق', run: async () => (await prisma.glPayrollRun.deleteMany({})).count },
  { label: 'یادداشت‌های افشا', run: async () => (await prisma.glDisclosureNote.deleteMany({})).count },
  { label: 'قفل دوره', run: async () => (await prisma.glPeriodLock.deleteMany({})).count },

  // ── هستهٔ جدید: خودِ دفتر ──
  { label: 'ردیف‌های سند (جدید)', run: async () => (await prisma.glLine.deleteMany({})).count },
  { label: 'اسناد (جدید)', run: async () => (await prisma.glEntry.deleteMany({})).count },
  { label: 'ردِ پای دفترداری', run: async () => (await prisma.glAuditLog.deleteMany({})).count },
  {
    // شمارندهٔ سریال باید صفر شود، وگرنه سند بعدی از ۴۴۵ شروع می‌شود و
    // «شکافِ سریال» در سلامت دفتر قرمز می‌شود.
    label: 'صفر کردن شمارندهٔ سریال',
    run: async () => (await prisma.glSerialCounter.updateMany({ data: { next: 1 } })).count,
  },

  // ── هستهٔ قدیمی: دفتر ──
  { label: 'ردیف‌های سند (قدیمی)', run: async () => (await prisma.journalLine.deleteMany({})).count },
  { label: 'اسناد (قدیمی)', run: async () => (await prisma.journalEntry.deleteMany({})).count },
  {
    // ماندهٔ حساب‌ها در هستهٔ قدیمی **ذخیره‌شده** است، نه محاسبه‌شده. حذف سند
    // آن را صفر نمی‌کند؛ باید صریح صفر شود وگرنه چارت عددِ شبح نگه می‌دارد.
    label: 'صفر کردن ماندهٔ حساب‌های قدیمی',
    run: async () => (await prisma.financialAccount.updateMany({ data: { balance: 0 } })).count,
  },

  // ── سندهای کسب‌وکاری که اثر حسابداری دارند ──
  { label: 'فاکتورهای حمل', run: async () => (await prisma.freightInvoice.deleteMany({})).count },
  {
    label: 'بازگرداندن فاکتورهای فروش به پیش‌نویس',
    run: async () => (await prisma.invoice.updateMany({
      where: { status: { not: 'DRAFT' } }, data: { status: 'DRAFT' },
    })).count,
  },
  {
    label: 'لغو تأیید کرایهٔ فورواردینگ',
    run: async () => (await prisma.forwardingCargo.updateMany({
      where: { quoteConfirmedAt: { not: null } }, data: { quoteConfirmedAt: null },
    })).count,
  },
];

async function snapshot() {
  const [glE, glL, jE, jL, glAcc, fAcc, inv, fi] = await Promise.all([
    prisma.glEntry.count(), prisma.glLine.count(),
    prisma.journalEntry.count(), prisma.journalLine.count(),
    prisma.glAccount.count(), prisma.financialAccount.count(),
    prisma.invoice.count({ where: { status: { not: 'DRAFT' } } }),
    prisma.freightInvoice.count(),
  ]);
  return { glE, glL, jE, jL, glAcc, fAcc, inv, fi };
}

/** نام دیتابیس از رشتهٔ اتصال */
function dbName(): string {
  const url = process.env.DATABASE_URL ?? '';
  const m = url.match(/\/([^/?]+)(\?|$)/);
  return m ? m[1] : '';
}

function guard() {
  const db = dbName();
  if (!db) throw new Error('نام دیتابیس از DATABASE_URL خوانده نشد.');

  if (/prod/i.test(db)) {
    throw new Error(`دیتابیس «${db}» نامِ پروداکشن دارد — این اسکریپت رویش اجرا نمی‌شود.`);
  }

  const arg = process.argv.find((a) => a.startsWith('--db='));
  const given = arg ? arg.slice(5) : '';
  if (given !== db) {
    throw new Error(
      `برای اطمینان، نام دیتابیس را صریح بدهید:  --db=${db}`
      + `  (متصل به «${db}»${given ? `، ولی «${given}» داده شد` : ''})`,
    );
  }
  return db;
}

async function main() {
  const db = guard();

  const before = await snapshot();
  console.log(`
  دیتابیس: ${db}`);
  console.log('\n  وضعیت پیش از پاک‌سازی');
  console.log(`    هستهٔ جدید : ${before.glE} سند / ${before.glL} ردیف   (چارت ${before.glAcc} حساب — می‌ماند)`);
  console.log(`    هستهٔ قدیمی: ${before.jE} سند / ${before.jL} ردیف   (چارت ${before.fAcc} حساب — می‌ماند)`);
  console.log(`    فاکتور فروشِ غیرپیش‌نویس: ${before.inv}   ·   فاکتور حمل: ${before.fi}`);

  if (!YES) {
    console.log('\n  ⚠️  اجرای آزمایشی — هیچ چیزی پاک نشد.');
    console.log('     برای اجرای واقعی: npm run reset:accounting -- --yes\n');
    return;
  }

  console.log('\n  پاک‌سازی…');
  // فقط تریگرهای **همین دو جدول** خاموش می‌شوند، نه کلِ نشست.
  //
  // `session_replication_role = replica` هم کار می‌کرد ولی دو اشکال داشت:
  // کاربر برنامه اجازه‌اش را ندارد (سوپریوزر می‌خواهد)، و کلیدهای خارجی را
  // هم با خودش خاموش می‌کند — یعنی اگر ترتیب حذف اشتباه بود، به‌جای خطا
  // بی‌صدا یتیم می‌ساخت. این روش نقطه‌ای است و FK سرِ جایش می‌ماند.
  const guarded = ['GlLine', 'GlEntry'];
  for (const t of guarded) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" DISABLE TRIGGER USER`);
  }
  try {
    for (const s of STEPS) {
      const n = await s.run();
      console.log(`    ${String(n).padStart(6)}  ${s.label}`);
    }
  } finally {
    // `finally` تضمین می‌کند تریگرها حتی با خطای وسط کار برگردند — دفتری که
    // بدون تغییرناپذیری بماند، بدتر از دفترِ پاک‌نشده است.
    for (const t of guarded) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE TRIGGER USER`);
    }
  }

  const after = await snapshot();
  console.log('\n  وضعیت پس از پاک‌سازی');
  console.log(`    هستهٔ جدید : ${after.glE} سند / ${after.glL} ردیف   (چارت ${after.glAcc} حساب)`);
  console.log(`    هستهٔ قدیمی: ${after.jE} سند / ${after.jL} ردیف   (چارت ${after.fAcc} حساب)`);
  console.log(`    فاکتور فروشِ غیرپیش‌نویس: ${after.inv}   ·   فاکتور حمل: ${after.fi}`);

  const clean = after.glE === 0 && after.glL === 0 && after.jE === 0 && after.jL === 0;
  console.log(clean
    ? '\n  ✓ هر دو هسته صفر شدند و یکسان‌اند.\n'
    : '\n  ✗ چیزی باقی مانده — بررسی کنید.\n');
}

main()
  .catch((e) => { console.error('\n  شکست:', e.message, '\n'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
