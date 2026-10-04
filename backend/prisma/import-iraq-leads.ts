/**
 * ورود یک‌بارهٔ لیدهای واقعی عراق از چهار فایل اکسل.
 *
 * چرا اسکریپت جدا و نه ویزارد ورود اکسلِ خود برنامه: آن ویزارد برای یک فایل
 * با ساختار مشخص است، ولی این چهار فایل چهار قالب متفاوت دارند، بینشان
 * هم‌پوشانی سنگین هست، بعضی سلول‌ها چند شماره دارند، و ستون «توضیحات تماس‌ها»
 * در واقع گفت‌وگوی انجام‌شده است نه یادداشت — که باید به رکورد تماس تبدیل شود.
 *
 *   npx tsx prisma/import-iraq-leads.ts <raw.json> --dry     ← فقط گزارش
 *   npx tsx prisma/import-iraq-leads.ts <raw.json> --wipe    ← پاک‌کردن و ورود
 */
import { PrismaClient } from '@prisma/client';
import fs from 'fs';

const prisma = new PrismaClient();

// ─── کمک‌کارها ────────────────────────────────────────

/** همان منطق `market.service.ts` — این‌جا تکرار شده تا اسکریپت مستقل بماند */
function normalizeIraqPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const latin = String(raw)
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  let digits = latin.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00964')) digits = digits.slice(5);
  else if (digits.startsWith('0964')) digits = digits.slice(4);
  else if (digits.startsWith('964')) digits = digits.slice(3);
  digits = digits.replace(/^0+/, '');
  if (digits.length < 8 || digits.length > 10) return null;
  return '964' + digits;
}

/**
 * یک سلول ممکن است چند شماره داشته باشد: «۰۷۷۰… / ۰۹۶۴…» یا با خط تیره و
 * خط جدید. اگر کل سلول را یک شماره فرض کنیم، هر دو از دست می‌روند.
 */
function splitPhones(cell: string | undefined): string[] {
  if (!cell) return [];
  const parts = String(cell).split(/[\/،,;\n]|(?:\s+-\s+)/).map((p) => p.trim()).filter(Boolean);
  const out = parts.map(normalizeIraqPhone).filter((x): x is string => !!x);
  // اگر تکه‌تکه‌کردن چیزی نداد، شاید خودِ سلول یک شمارهٔ سالم باشد
  if (!out.length) { const one = normalizeIraqPhone(cell); if (one) return [one]; }
  return [...new Set(out)];
}

const clean = (s: any) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);
const first = (r: any, keys: string[]) => { for (const k of keys) if (r[k]) return clean(r[k]); return null; };

const NAME_COLS = ['نام فروشگاه/شرکت', 'نام آزمایشگاه/لابراتوار', 'اسم مغازه', 'نام نمایشی', 'نام شرکت'];
const PHONE_COLS = ['شماره تماس', 'شماره', 'تلفن همراه', 'تلفن'];
const NOTE_COLS = ['توضیحات تماس ها', 'توضیحات'];

/**
 * نوع مخاطب.
 *
 * عمداً از روی نام حدس زده نمی‌شود. نسخهٔ اول با الگوی نام، «شرکت» را
 * پخش‌کننده و «مختبر» را لابراتوار می‌گرفت — ۲۸ رکورد این‌طور برچسب خوردند
 * که فایل دربارهٔ هیچ‌کدامشان چنین چیزی نگفته بود. تنها چیزی که فایل واقعاً
 * اعلام می‌کند این است که یک برگهٔ کامل «آزمایشگاه‌های دندانسازی» نام دارد؛
 * پس فقط همان‌ها لابراتوارند و بقیه مغازه.
 */
function typeOf(sheet: string): string {
  return /آزمایشگاه|لابراتوار/.test(sheet) ? 'LAB' : 'SHOP';
}

type Rec = {
  name: string; phones: string[]; city: string | null; type: string;
  address: string | null; mapUrl: string | null; website: string | null;
  email: string | null; instagram: string | null; ownerName: string | null;
  notes: string[]; callNotes: string[]; sources: string[];
};

// ─── خواندن و یکدست‌کردن ─────────────────────────────

function parse(rawPath: string): Rec[] {
  const sheets = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const out: Rec[] = [];

  for (const s of sheets) {
    const folder: string = s.file.split('/')[0];
    // شهر اگر ستون نداشت، از نام فایل می‌آید (بغداد.xlsx / اربیل.xlsx)
    const fileCity = /بغداد/.test(s.file) ? 'بغداد' : /اربیل/.test(s.file) ? 'اربیل' : null;

    for (const r of s.rows) {
      const name = first(r, NAME_COLS);
      // ردیف سرگروهِ فایل اربیل («اربیل (19)») نه نام نمایشی دارد نه شماره
      if (!name) continue;
      if (/^\S+\s*\(\d+\)$/.test(name) && !PHONE_COLS.some((k) => r[k])) continue;

      const phones = PHONE_COLS.flatMap((k) => splitPhones(r[k]));
      const notes: string[] = [];
      if (r['تایم کاری']) notes.push('ساعت کاری: ' + clean(r['تایم کاری']));
      // امتیاز گوگل عمداً به فیلد «رتبه» نمی‌رود: رتبهٔ ما یعنی «چقدر برای ما
      // مشتری خوبی است»، نه نظر عمومِ گوگل. قاطی‌کردنشان معنی هر دو را خراب می‌کند.
      if (r['امتیاز گوگل'] && r['امتیاز گوگل'] !== '-') notes.push('امتیاز گوگل: ' + clean(r['امتیاز گوگل']));
      if (r['موقعیت شغلی']) notes.push('سمت: ' + clean(r['موقعیت شغلی']));
      if (r['فیسبوک']) notes.push('فیسبوک: ' + clean(r['فیسبوک']));

      const callNote = first(r, NOTE_COLS);

      out.push({
        name,
        phones,
        city: clean(r['شهر']) || fileCity,
        type: typeOf(s.sheet),
        address: clean(r['آدرس']),
        mapUrl: first(r, ['لینک گوگل مپ', 'مپ']),
        website: clean(r['سایت']),
        email: clean(r['ایمیل']),
        instagram: clean(r['اینستاگرام یا تلگرام']),
        ownerName: clean(r['نام تماس']),
        notes,
        callNotes: callNote ? [callNote] : [],
        sources: [folder],
      });
    }
  }
  return out;
}

/** نام را برای مقایسه ساده می‌کند (فاصله، کشیده، پرانتز، حروف بزرگ) */
const nameKey = (n: string) =>
  n.toLowerCase().replace(/[‌ً-ْ]/g, '').replace(/[()\[\]]/g, ' ')
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/\s+/g, ' ').trim();

/**
 * ادغام تکراری‌ها.
 * کلید اول شماره است (مطمئن‌ترین)، و اگر رکوردی شماره نداشت نامش.
 * دو رکورد که یک شماره مشترک دارند یکی‌اند، حتی اگر نامشان فرق کند —
 * در این فایل‌ها یک مغازه با سه املای مختلف تکرار شده بود.
 */
function merge(recs: Rec[]): Rec[] {
  const byPhone = new Map<string, Rec>();
  const byName = new Map<string, Rec>();
  const all: Rec[] = [];

  const absorb = (into: Rec, from: Rec) => {
    for (const p of from.phones) if (!into.phones.includes(p)) into.phones.push(p);
    into.city ||= from.city;
    into.address ||= from.address;
    into.mapUrl ||= from.mapUrl;
    into.website ||= from.website;
    into.email ||= from.email;
    into.instagram ||= from.instagram;
    into.ownerName ||= from.ownerName;
    // اگر یک رکورد در برگهٔ لابراتوار بوده، همان برنده است
    if (from.type === 'LAB') into.type = 'LAB';
    for (const n of from.notes) if (!into.notes.includes(n)) into.notes.push(n);
    for (const c of from.callNotes) if (!into.callNotes.includes(c)) into.callNotes.push(c);
    for (const s of from.sources) if (!into.sources.includes(s)) into.sources.push(s);
    // نام بلندتر معمولاً کامل‌تر است (فارسی + لاتین داخل پرانتز)
    if (from.name.length > into.name.length) into.name = from.name;
  };

  for (const r of recs) {
    const hit = r.phones.map((p) => byPhone.get(p)).find(Boolean)
      || (r.phones.length ? undefined : byName.get(nameKey(r.name)));
    if (hit) { absorb(hit, r); for (const p of hit.phones) byPhone.set(p, hit); continue; }
    all.push(r);
    for (const p of r.phones) byPhone.set(p, r);
    if (!byName.has(nameKey(r.name))) byName.set(nameKey(r.name), r);
  }
  return all;
}

// ─── اجرا ────────────────────────────────────────────

async function main() {
  const rawPath = process.argv[2];
  const wipe = process.argv.includes('--wipe');
  if (!rawPath) throw new Error('مسیر raw.json را بدهید');

  const parsed = parse(rawPath);
  const merged = merge(parsed);

  const withPhone = merged.filter((r) => r.phones.length);
  const withCall = merged.filter((r) => r.callNotes.length);
  console.log(`ردیف خام: ${parsed.length} → پس از ادغام: ${merged.length} (${parsed.length - merged.length} تکراری حذف شد)`);
  console.log(`دارای شماره: ${withPhone.length} · بدون شماره: ${merged.length - withPhone.length}`);
  console.log(`دارای گفت‌وگوی ثبت‌شده: ${withCall.length} (مجموع ${merged.reduce((n, r) => n + r.callNotes.length, 0)} گفت‌وگو)`);

  const byCity: Record<string, number> = {};
  for (const r of merged) byCity[r.city || '(بدون شهر)'] = (byCity[r.city || '(بدون شهر)'] || 0) + 1;
  console.log('شهرها: ' + Object.entries(byCity).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));

  const byType: Record<string, number> = {};
  for (const r of merged) byType[r.type] = (byType[r.type] || 0) + 1;
  console.log('نوع: ' + Object.entries(byType).map(([k, v]) => `${k}:${v}`).join('  '));

  if (!wipe) {
    fs.writeFileSync(rawPath.replace(/\.json$/, '.merged.json'), JSON.stringify(merged, null, 1));
    console.log('\n(حالت گزارش — چیزی در دیتابیس نوشته نشد)');
    return;
  }

  // ─── پاک‌کردن دادهٔ قبلی ───
  const before = await prisma.marketContact.count();
  await prisma.$transaction([
    prisma.marketCall.deleteMany({}),
    prisma.marketPromise.deleteMany({}),
    prisma.marketInterest.deleteMany({}),
    prisma.marketFile.deleteMany({}),
    prisma.marketContact.deleteMany({}),
  ]);
  console.log(`\n${before} مخاطب قبلی و همهٔ وابسته‌هایشان حذف شد`);

  // ─── نگاشت شهر ───
  const cities = await prisma.marketCity.findMany();
  const cityId = (n: string | null) => {
    if (!n) return null;
    const k = nameKey(n);
    return cities.find((c) => nameKey(c.name) === k || (c.nameAr && nameKey(c.nameAr) === k))?.id || null;
  };
  const unmatched = [...new Set(merged.map((r) => r.city).filter((c): c is string => !!c && !cityId(c)))];
  if (unmatched.length) console.log('⚠ شهرهای ناشناخته (بدون شهر وارد می‌شوند): ' + unmatched.join('، '));

  // ─── ورود ───
  let n = 0, calls = 0, extraPhones = 0;
  for (const r of merged) {
    const code = 'MK-' + String(++n).padStart(5, '0');
    // فقط دو فیلد شماره داریم؛ شمارهٔ سوم به بعد در جستجو پیدا می‌شود
    // (phoneNorm) ولی دیده نمی‌شد، پس در یادداشت هم ثبت می‌شود تا گم نشود.
    const notes = [...r.notes];
    if (r.phones.length > 2) {
      notes.push('شماره‌های دیگر: ' + r.phones.slice(2).map((p) => '+' + p).join(' ، '));
      extraPhones++;
    }
    const contact = await prisma.marketContact.create({
      data: {
        code,
        name: r.name,
        type: r.type as any,
        cityId: cityId(r.city),
        address: r.address,
        mapUrl: r.mapUrl,
        website: r.website,
        email: r.email,
        instagram: r.instagram,
        ownerName: r.ownerName,
        phone: r.phones[0] ? '+' + r.phones[0] : null,
        phone2: r.phones[1] ? '+' + r.phones[1] : null,
        whatsapp: r.phones[0] ? '+' + r.phones[0] : null,
        phoneNorm: r.phones,
        notes: notes.length ? notes.join('\n') : null,
        source: r.sources.join(' + '),
        // اگر گفت‌وگویی ثبت شده، یعنی واقعاً تماس گرفته‌ایم — نه «تماس نگرفته»
        status: r.callNotes.length ? 'CONTACTED' : 'NEW',
        lastContactAt: r.callNotes.length ? new Date() : null,
        contactAttempts: r.callNotes.length,
      },
    });

    for (const note of r.callNotes) {
      // `result` عمداً خالی می‌ماند: نتیجه و ساعت واقعی این تماس‌ها را نمی‌دانیم،
      // و گذاشتن مقدار ساختگی آمار «بهترین ساعت تماس» را خراب می‌کرد.
      await prisma.marketCall.create({
        data: { contactId: contact.id, channel: 'CALL', direction: 'OUT', summary: note },
      });
      calls++;
    }
  }
  console.log(`${n} مخاطب و ${calls} گفت‌وگو وارد شد` + (extraPhones ? ` (${extraPhones} مخاطب شمارهٔ سوم داشتند — در یادداشت ثبت شد)` : ''));

  // ─── غیرفعال‌کردن شهرهای بی‌داده ───
  const used = new Set((await prisma.marketContact.findMany({ where: { cityId: { not: null } }, select: { cityId: true } })).map((c) => c.cityId!));
  const off = await prisma.marketCity.updateMany({ where: { id: { notIn: [...used] } }, data: { isActive: false } });
  const on = await prisma.marketCity.updateMany({ where: { id: { in: [...used] } }, data: { isActive: true } });
  console.log(`شهرها: ${on.count} فعال (دارای مخاطب) · ${off.count} غیرفعال`);

  const activeCities = await prisma.marketCity.findMany({ where: { isActive: true }, orderBy: [{ governorate: 'asc' }] });
  console.log('فعال: ' + activeCities.map((c) => `${c.governorate}/${c.name}`).join('، '));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
