/**
 * بازسازی مرحلهٔ پیگیری از روی متنِ گزارش‌های تماس — یک‌بار مصرف.
 *
 * چرا لازم شد: وضعیت‌های ثبت‌شده قابل‌اعتماد نبودند. ۱۱۵ گزارش از ۱۵۱ گزارش
 * «نتیجهٔ تماس» نداشتند، پس قانونِ خودکارِ پیشرفت وضعیت هرگز اجرا نشد و
 * مخاطبی که گزارشش می‌گفت «شماره واتساپ ندارد» هنوز «تماس گرفته نشده» بود.
 * متنِ گزارش‌ها تنها منبع درست بود.
 *
 * اجرا:  npx tsx prisma/manual/2026-09-06-followup-backfill.ts [--apply]
 * بدون `--apply` فقط گزارش می‌دهد و چیزی نمی‌نویسد.
 */
import prisma from '../../src/shared/utils/prisma';

const P = {
  noWa:   /واتسا?ب?\s*(نداره|ندارد|ندارند|نداشت)|واتسا ندارد|واتساب  ندارد/,
  badNum: /شماره\s*(تماس\s*)?اشتباه|شماره\s*تماس\s*موجود\s*نیست|شماره\s*موجود\s*نیست/,
  irrel:  /محصولات? دیگر[ی]? فروش|تخصص این کار نبود|تخصص کارشون|محصول(ات)? موجود نبود|محصولات موجود نمیباشد|نیاز به تجهیزات ندارن|مصولات مورد نظر ما موجود نبود|محصولات دیگه ای برای فروش/,
  price:  /درخواست\s*قیمت|در\s*خواست\s*قیمت|منتظر\s*اعلام\s*قیمت|لیست\s*قیمت|تخفیف|قیمت\s*های\s*عمده/,
  priceDone: /قیمت (تمام )?محصولات (را )?داده شد|قیمت.{0,12}داده شد/,
  meet:   /نمایندگ|نمایشگاه/,
  wait:   /منتظر\s*سین|هنوز\s*سین\s*نکرد|سین\s*کردن|جوابگو\s*نبود|جواب\s*ندادن|پاسخگو\s*نبود|باسخگو\s*نبود|جواگو نبود|جوابکو نبود|در\s*دسترس\s*نبود|دردسترس\s*نبود|مشغول\s*بود|نت نداشتن|انترنت نداشتن/,
  review: /برسی|بررسی|خبر\s*میدن|خبروش/,
};

type Out = { status: string; archived: boolean; reason: string | null };

/** ترتیب شرط‌ها = اولویت. اولین تطابق برنده است. */
export function classify(text: string, hasPhone: boolean, hasPositive: boolean): Out {
  if (!hasPhone || P.badNum.test(text)) return { status: 'UNREACHABLE', archived: true, reason: 'شمارهٔ نامعتبر یا بدون شماره' };
  if (P.irrel.test(text))               return { status: 'NOT_INTERESTED', archived: true, reason: 'محصولات ما را نمی‌خواهد' };
  if (P.noWa.test(text))                return { status: 'PHONE_ONLY', archived: false, reason: null };
  // قیمتی که خواسته‌اند ولی هنوز نداده‌ایم = توپ در زمین ماست
  if (P.price.test(text) && !P.priceDone.test(text)) return { status: 'AWAITING_QUOTE', archived: false, reason: null };
  if (P.meet.test(text))                return { status: 'MEETING_SET', archived: false, reason: null };
  if (P.review.test(text) || hasPositive) return { status: 'NEEDS_RECALL', archived: false, reason: null };
  if (P.wait.test(text))                return { status: 'ATTEMPTED', archived: false, reason: null };
  return { status: 'NEW', archived: false, reason: null };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const contacts = await prisma.marketContact.findMany({
    include: { calls: { select: { summary: true } }, interests: { select: { level: true } } },
  });

  const tally: Record<string, number> = {};
  const changes: { id: string; code: string; from: string; to: Out }[] = [];

  for (const c of contacts) {
    const text = c.calls.map((k) => k.summary || '').join(' ');
    const hasPhone = !!(c.phone || c.phone2 || c.whatsapp);
    const hasPositive = c.interests.some((i) => i.level === 'POSITIVE');
    // مخاطبی که هیچ گزارشی ندارد یعنی هنوز سراغش نرفته‌ایم
    const out = c.calls.length === 0 && hasPhone
      ? { status: 'NEW', archived: false, reason: null }
      : classify(text, hasPhone, hasPositive);

    const key = out.archived ? `ARCHIVED (${out.reason})` : out.status;
    tally[key] = (tally[key] || 0) + 1;
    // مشتریِ واقعی دست نمی‌خورد — آن یکی از قیف بیرون رفته و برگرداندنش خطاست
    if (c.status === 'CUSTOMER' || c.customerId) continue;
    if (c.status !== out.status || c.archived !== out.archived) {
      changes.push({ id: c.id, code: c.code, from: c.status, to: out });
    }
  }

  console.log('— توزیع نهایی —');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  console.log(`\n${changes.length} مخاطب از ${contacts.length} تغییر می‌کند.`);

  if (!apply) { console.log('\n(آزمایشی — برای نوشتن با --apply اجرا کنید)'); return; }

  for (const ch of changes) {
    await prisma.marketContact.update({
      where: { id: ch.id },
      data: {
        status: ch.to.status as any,
        archived: ch.to.archived,
        archivedAt: ch.to.archived ? new Date() : null,
        archivedReason: ch.to.reason,
      },
    });
  }
  console.log(`✓ ${changes.length} مخاطب به‌روز شد.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
