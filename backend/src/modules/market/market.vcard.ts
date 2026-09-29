import { Router, Request, Response } from 'express';
import prisma from '../../shared/utils/prisma';
import { toneOf } from './market.labels';

/**
 * خروجی دفترچه‌تلفن (vCard 3.0) از مخاطبین بازار.
 *
 * هدف: به‌جای وارد کردن دستیِ ۱۰۰ شماره در گوشی، یک فایل `.vcf` که iOS و
 * اندروید هر دو یکجا وارد می‌کنند. همان فیلترهای جدول اعمال می‌شود، پس
 * می‌شود مثلاً فقط مخاطبین بغداد را روی گوشیِ تماس‌گیرندهٔ بغداد ریخت.
 *
 * نسخهٔ ۳.۰ عمداً انتخاب شده نه ۴.۰: iOS با ۳.۰ بی‌دردسر کار می‌کند و
 * اندرویدهای قدیمی‌تر هم می‌خوانندش.
 */

/** کاراکترهای معنادار در vCard باید فرار داده شوند وگرنه فیلد وسطش می‌شکند */
function esc(v: string | null | undefined): string {
  if (!v) return '';
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

/**
 * تاکردن خطوط بلند طبق RFC 2426.
 *
 * روی مرزِ **کاراکتر** تا می‌کند نه بایت — نام‌های عربی و فارسی چندبایتی‌اند و
 * بریدن وسط یک کاراکتر UTF-8 فایل را برای دستگاه خراب می‌کند.
 */
function fold(line: string): string {
  const LIMIT = 72; // بایت، با حاشیهٔ امن نسبت به ۷۵ـِ استاندارد
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > LIMIT) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

const CRLF = '\r\n';

export function registerVCardRoutes(router: Router) {
  router.get('/export.vcf', async (req: Request, res: Response) => {
    // import چرخه‌ای: buildContactWhere در routes است و routes این فایل را صدا می‌زند
    const { buildContactWhere } = await import('./market.routes');
    const where = buildContactWhere(req.query as Record<string, string>);

    const contacts = await prisma.marketContact.findMany({
      where,
      include: { city: true },
      orderBy: [{ city: { name: 'asc' } }, { name: 'asc' }],
    });

    const lines: string[] = [];
    let written = 0;
    let skipped = 0;

    for (const c of contacts) {
      // مخاطبِ بدون شماره در دفترچه‌تلفن بی‌فایده است — هدفِ این فایل شماره است
      const phones = (c.phoneNorm?.length ? c.phoneNorm : [c.phone, c.phone2, c.whatsapp]
        .map((p) => (p || '').replace(/\D/g, '')).filter(Boolean));
      if (!phones.length) { skipped++; continue; }

      const cityLabel = c.city ? `${c.city.governorate} / ${c.city.name}` : '';
      // یادداشت گوشی: چیزهایی که موقع زنگ‌خوردن به درد می‌خورند
      const note = [
        c.code,
        cityLabel,
        toneOf('type', c.type),
        toneOf('status', c.status),
        c.ownerName ? `مسئول: ${c.ownerName}` : '',
        c.notes || '',
      ].filter(Boolean).join(' · ');

      lines.push('BEGIN:VCARD');
      lines.push('VERSION:3.0');
      // N اجباری است؛ کل نام در فیلد نام‌خانوادگی می‌رود تا دستگاه تکه‌اش نکند
      lines.push(fold(`N:${esc(c.name)};;;;`));
      lines.push(fold(`FN:${esc(c.name)}`));
      // ORG باعث می‌شود در جستجوی گوشی «بازار عراق» همهٔ این‌ها یکجا پیدا شوند
      lines.push(fold(`ORG:${esc('بازار عراق' + (cityLabel ? ' — ' + cityLabel : ''))}`));
      if (c.nameAr) lines.push(fold(`NICKNAME:${esc(c.nameAr)}`));

      phones.forEach((p, i) => {
        const type = i === 0 ? 'CELL' : 'WORK';
        lines.push(fold(`TEL;TYPE=${type},VOICE:+${p}`));
      });
      if (c.email) lines.push(fold(`EMAIL;TYPE=INTERNET:${esc(c.email)}`));
      if (c.address) lines.push(fold(`ADR;TYPE=WORK:;;${esc(c.address)};${esc(c.city?.name || '')};;;${esc('Iraq')}`));
      if (c.website) lines.push(fold(`URL:${esc(c.website)}`));
      if (c.mapUrl) lines.push(fold(`URL;TYPE=MAP:${esc(c.mapUrl)}`));
      if (note) lines.push(fold(`NOTE:${esc(note)}`));
      lines.push(fold('CATEGORIES:بازار عراق'));
      lines.push('END:VCARD');
      written++;
    }

    // BOM ندارد: iOS با UTF-8 خام درست می‌خواند و BOM بعضی دستگاه‌ها را گیج می‌کند
    const body = lines.join(CRLF) + CRLF;
    res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="iraq-contacts-${new Date().toISOString().slice(0, 10)}.vcf"`);
    res.setHeader('X-Contacts-Written', String(written));
    res.setHeader('X-Contacts-Skipped', String(skipped));
    res.send(Buffer.from(body, 'utf8'));
  });
}
