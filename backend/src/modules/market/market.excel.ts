import { Router, Request, Response } from 'express';
import ExcelJS from 'exceljs';
import prisma from '../../shared/utils/prisma';
import { requirePermission } from '../../shared/middleware/permissions';
import { upload } from '../../shared/middleware/upload';
import { AppError } from '../../shared/middleware/errorHandler';
import { buildPhoneNorm, normalizeIraqPhone, nextContactCode } from './market.service';
import { STATUS_FA, LEVEL_FA, PRICE_FA, PROMISE_FA } from './market.labels';

/**
 * ورود و خروجی اکسل مخاطبین.
 *
 * ورود دو مرحله‌ای است (preview → commit) چون فایلی که کاربر دارد معمولاً
 * دست‌ساز است: ستون‌ها جای عجیب‌اند، شماره‌ها ده جور نوشته شده‌اند و
 * ردیف‌های تکراری دارد. اگر مستقیم import کنیم، کاربر تازه بعدِ خراب‌شدن
 * دیتابیس می‌فهمد چه شد. پس اول نشان می‌دهیم چه چیزی قرار است وارد شود.
 */

/** ستون‌های فایل نمونه — کلید داخلی ← عنوان‌های فارسی/انگلیسیِ قابل‌قبول */
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ['نام', 'نام مغازه', 'مغازه', 'نام شرکت', 'شرکت', 'name', 'shop', 'company'],
  ownerName: ['صاحب', 'مسئول', 'نام صاحب', 'نام مسئول', 'owner', 'contact', 'contact name'],
  governorate: ['استان', 'محافظه', 'governorate', 'province'],
  city: ['شهر', 'مدینه', 'city'],
  phone: ['تلفن', 'شماره', 'موبایل', 'شماره تماس', 'phone', 'mobile', 'tel'],
  phone2: ['تلفن ۲', 'تلفن 2', 'شماره دوم', 'phone2'],
  whatsapp: ['واتساپ', 'واتس اپ', 'whatsapp', 'wa'],
  telegram: ['تلگرام', 'telegram'],
  instagram: ['اینستاگرام', 'اینستا', 'instagram'],
  email: ['ایمیل', 'email', 'mail'],
  website: ['وبسایت', 'وب سایت', 'سایت', 'website', 'site'],
  address: ['آدرس', 'نشانی', 'address'],
  type: ['نوع', 'type'],
  source: ['منبع', 'source'],
  notes: ['یادداشت', 'توضیحات', 'notes', 'note', 'description'],
  tags: ['برچسب', 'برچسب‌ها', 'tags', 'tag'],
};

const TYPE_ALIASES: Record<string, string> = {
  'مغازه': 'SHOP', 'فروشگاه': 'SHOP', 'shop': 'SHOP',
  'پخش': 'DISTRIBUTOR', 'شرکت پخش': 'DISTRIBUTOR', 'distributor': 'DISTRIBUTOR',
  'کلینیک': 'CLINIC', 'مطب': 'CLINIC', 'clinic': 'CLINIC',
  'لابراتوار': 'LAB', 'لابراتور': 'LAB', 'lab': 'LAB',
  'واردکننده': 'IMPORTER', 'importer': 'IMPORTER',
};

/** عنوان ستون را به کلید داخلی نگاشت می‌کند (بی‌توجه به فاصله و بزرگی حروف) */
function matchColumn(header: string): string | null {
  const h = header.toString().trim().toLowerCase().replace(/[‌\s_-]+/g, ' ');
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    if (aliases.some((a) => a.toLowerCase() === h)) return key;
  }
  return null;
}

function cellText(v: any): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    // ExcelJS برای فرمول/هایپرلینک/متن غنی آبجکت می‌دهد نه رشته
    if ('text' in v) return String(v.text).trim();
    if ('result' in v) return String(v.result ?? '').trim();
    if ('richText' in v) return v.richText.map((r: any) => r.text).join('').trim();
    if ('hyperlink' in v) return String(v.hyperlink).trim();
  }
  return String(v).trim();
}

/** فایل آپلودشده را به ردیف‌های خام تبدیل می‌کند */
async function parseWorkbook(buffer: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const ws = wb.worksheets[0];
  if (!ws) throw new AppError(400, 'فایل هیچ برگه‌ای ندارد');

  const headerRow = ws.getRow(1);
  const mapping: Record<number, string> = {};
  const unmapped: string[] = [];
  headerRow.eachCell((cell, col) => {
    const text = cellText(cell.value);
    if (!text) return;
    const key = matchColumn(text);
    if (key) mapping[col] = key;
    else unmapped.push(text);
  });
  if (!Object.values(mapping).includes('name')) {
    throw new AppError(400, 'ستون «نام» پیدا نشد. سرستون‌ها باید در ردیف اول باشند — فایل نمونه را دانلود کنید.');
  }

  const rows: Record<string, string>[] = [];
  ws.eachRow((row, idx) => {
    if (idx === 1) return;
    const obj: Record<string, string> = {};
    for (const [col, key] of Object.entries(mapping)) {
      const v = cellText(row.getCell(Number(col)).value);
      if (v) obj[key] = v;
    }
    if (Object.keys(obj).length) rows.push({ ...obj, __row: String(idx) });
  });
  return { rows, unmapped };
}

export function registerExcelRoutes(router: Router) {
  /** فایل نمونه با سرستون‌های درست — تا کاربر مجبور نباشد حدس بزند */
  router.get('/import/template.xlsx', async (_req: Request, res: Response) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('مخاطبین');
    ws.views = [{ rightToLeft: true }];
    ws.columns = [
      { header: 'نام مغازه', key: 'name', width: 28 },
      { header: 'نام صاحب', key: 'ownerName', width: 20 },
      { header: 'استان', key: 'governorate', width: 14 },
      { header: 'شهر', key: 'city', width: 14 },
      { header: 'تلفن', key: 'phone', width: 18 },
      { header: 'واتساپ', key: 'whatsapp', width: 18 },
      { header: 'اینستاگرام', key: 'instagram', width: 18 },
      { header: 'آدرس', key: 'address', width: 30 },
      { header: 'نوع', key: 'type', width: 12 },
      { header: 'منبع', key: 'source', width: 14 },
      { header: 'یادداشت', key: 'notes', width: 30 },
    ];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F1F1' } };
    ws.addRow({
      name: 'مثال: مركز الرافدين لطب الأسنان', ownerName: 'ابو أحمد', governorate: 'بغداد', city: 'بغداد',
      phone: '07701234567', whatsapp: '+964 770 123 4567', instagram: '@example',
      address: 'شارع السعدون', type: 'مغازه', source: 'اینستاگرام', notes: 'نمونه — این ردیف را پاک کنید',
    });

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="market-import-template.xlsx"');
    res.send(Buffer.from(buf));
  });

  /**
   * پیش‌نمایش ورود: چه چیزی وارد می‌شود، چه چیزی تکراری است، چه چیزی مشکل دارد.
   * هیچ چیزی نوشته نمی‌شود.
   */
  router.post('/import/preview', requirePermission('market', 'create'), upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) throw new AppError(400, 'فایلی ارسال نشد');
    const fs = await import('fs');
    const buffer = fs.readFileSync(req.file.path);
    const { rows, unmapped } = await parseWorkbook(buffer);
    fs.unlinkSync(req.file.path); // فایل موقت لازم نیست بماند

    const [cities, existing] = await Promise.all([
      prisma.marketCity.findMany({ select: { id: true, name: true, nameAr: true, governorate: true } }),
      prisma.marketContact.findMany({ select: { id: true, code: true, name: true, phoneNorm: true } }),
    ]);

    // نگاشت شهر: هم با نام فارسی، هم عربی، هم بدون توجه به استان
    const cityByName = new Map<string, { id: string; name: string; governorate: string }>();
    for (const c of cities) {
      cityByName.set(c.name.trim(), c);
      if (c.nameAr) cityByName.set(c.nameAr.trim(), c);
      cityByName.set(`${c.governorate}|${c.name}`.trim(), c);
    }

    const existingPhones = new Map<string, { id: string; code: string; name: string }>();
    for (const e of existing) for (const p of e.phoneNorm) existingPhones.set(p, e);

    const seenInFile = new Map<string, number>(); // شمارهٔ یکدست → شمارهٔ ردیف
    const items = rows.map((r) => {
      const norms = buildPhoneNorm(r.phone, r.phone2, r.whatsapp);
      const issues: string[] = [];
      let status: 'NEW' | 'DUPLICATE_DB' | 'DUPLICATE_FILE' | 'INVALID' = 'NEW';
      let duplicateOf: { id: string; code: string; name: string } | null = null;

      if (!r.name) { status = 'INVALID'; issues.push('نام ندارد'); }
      if (!norms.length) issues.push('شمارهٔ معتبری ندارد');
      if ((r.phone || r.whatsapp) && !norms.length) issues.push(`شماره «${r.phone || r.whatsapp}» قابل تشخیص نبود`);

      for (const n of norms) {
        if (existingPhones.has(n)) { status = 'DUPLICATE_DB'; duplicateOf = existingPhones.get(n)!; break; }
        if (seenInFile.has(n)) { status = 'DUPLICATE_FILE'; issues.push(`تکراری با ردیف ${seenInFile.get(n)}`); break; }
      }
      if (status === 'NEW') for (const n of norms) seenInFile.set(n, Number(r.__row));

      const cityKey = r.city ? (cityByName.get(`${r.governorate || ''}|${r.city}`.trim()) || cityByName.get(r.city.trim())) : null;
      if (r.city && !cityKey) issues.push(`شهر «${r.city}» در فهرست نیست — بدون شهر وارد می‌شود`);

      return {
        row: Number(r.__row),
        status, issues, duplicateOf,
        data: {
          name: r.name || '',
          ownerName: r.ownerName || null,
          cityId: cityKey?.id || null,
          cityLabel: cityKey ? `${cityKey.governorate} / ${cityKey.name}` : (r.city || null),
          phone: r.phone || null,
          phone2: r.phone2 || null,
          whatsapp: r.whatsapp || null,
          telegram: r.telegram || null,
          instagram: r.instagram || null,
          email: r.email || null,
          website: r.website || null,
          address: r.address || null,
          type: TYPE_ALIASES[(r.type || '').toLowerCase()] || 'SHOP',
          source: r.source || null,
          notes: r.notes || null,
          tags: r.tags ? r.tags.split(/[,،]/).map((s) => s.trim()).filter(Boolean) : [],
        },
      };
    });

    res.json({
      unmappedColumns: unmapped,
      total: items.length,
      counts: {
        new: items.filter((i) => i.status === 'NEW').length,
        duplicateDb: items.filter((i) => i.status === 'DUPLICATE_DB').length,
        duplicateFile: items.filter((i) => i.status === 'DUPLICATE_FILE').length,
        invalid: items.filter((i) => i.status === 'INVALID').length,
      },
      items,
    });
  });

  /** ثبت نهایی — فقط ردیف‌هایی که فرانت تأیید کرده */
  router.post('/import/commit', requirePermission('market', 'create'), async (req: Request, res: Response) => {
    const { items, defaultCityId, defaultSource } = req.body as {
      items: any[]; defaultCityId?: string; defaultSource?: string;
    };
    if (!Array.isArray(items) || !items.length) throw new AppError(400, 'ردیفی برای ثبت نیست');

    // کد یکتا یک‌بار گرفته و در حافظه شمرده می‌شود — nextContactCode داخل حلقه
    // برای هر ردیف یک کوئری می‌زند و روی ۵۰۰ ردیف کند و مستعد تکرار است.
    const firstCode = await nextContactCode();
    let counter = Number(firstCode.slice(3));

    const created: string[] = [];
    const failed: { name: string; error: string }[] = [];
    const CHUNK = 50;
    for (let i = 0; i < items.length; i += CHUNK) {
      const chunk = items.slice(i, i + CHUNK);
      const data = chunk.map((it) => {
        const d = it.data || it;
        return {
          code: 'MK-' + String(counter++).padStart(5, '0'),
          name: String(d.name || '').trim(),
          ownerName: d.ownerName || null,
          cityId: d.cityId || defaultCityId || null,
          phone: d.phone || null,
          phone2: d.phone2 || null,
          whatsapp: d.whatsapp || null,
          telegram: d.telegram || null,
          instagram: d.instagram || null,
          email: d.email || null,
          website: d.website || null,
          address: d.address || null,
          type: d.type || 'SHOP',
          source: d.source || defaultSource || null,
          notes: d.notes || null,
          tags: Array.isArray(d.tags) ? d.tags : [],
          phoneNorm: buildPhoneNorm(d.phone, d.phone2, d.whatsapp),
          createdById: req.user!.id,
        };
      }).filter((d) => d.name);

      try {
        const r = await prisma.marketContact.createMany({ data, skipDuplicates: true });
        created.push(...Array(r.count).fill(''));
      } catch (e) {
        // یک دستهٔ خراب نباید کل ورود را بسوزاند — تک‌تک امتحان کن تا بقیه وارد شوند
        for (const d of data) {
          try { await prisma.marketContact.create({ data: d }); created.push(''); }
          catch (err) { failed.push({ name: d.name, error: (err as Error).message.split('\n')[0] }); }
        }
      }
    }
    res.json({ ok: true, created: created.length, failed });
  });

  /** خروجی اکسل با همان فیلترهای جدول — «چیزی که می‌بینی همان است که می‌گیری» */
  router.get('/export.xlsx', async (req: Request, res: Response) => {
    // import چرخه‌ای: buildContactWhere در routes است و routes این فایل را صدا می‌زند
    const { buildContactWhere } = await import('./market.routes');
    const where = buildContactWhere(req.query as Record<string, string>);

    const [products, contacts] = await Promise.all([
      prisma.marketProduct.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }),
      prisma.marketContact.findMany({
        where,
        include: {
          city: true,
          assignedTo: { select: { name: true } },
          interests: true,
          promises: { where: { status: 'PENDING' }, select: { kind: true, description: true } },
          calls: { orderBy: { occurredAt: 'desc' }, take: 1, select: { summary: true, occurredAt: true } },
        },
        orderBy: [{ score: 'desc' }, { name: 'asc' }],
      }),
    ]);


    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('مخاطبین');
    ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];

    const cols: Partial<ExcelJS.Column>[] = [
      { header: 'کد', key: 'code', width: 11 },
      { header: 'نام', key: 'name', width: 30 },
      { header: 'صاحب', key: 'ownerName', width: 18 },
      { header: 'استان', key: 'governorate', width: 13 },
      { header: 'شهر', key: 'city', width: 13 },
      { header: 'تلفن', key: 'phone', width: 16 },
      { header: 'واتساپ', key: 'whatsapp', width: 16 },
      { header: 'وضعیت', key: 'status', width: 16 },
      { header: 'رتبه', key: 'rating', width: 7 },
      { header: 'امتیاز', key: 'score', width: 8 },
      { header: 'نمایشگاه', key: 'exhibition', width: 11 },
      { header: 'نمایندگی', key: 'agency', width: 11 },
    ];
    // دو ستون به‌ازای هر محصول: نظر و نظر قیمت
    for (const p of products) {
      cols.push({ header: p.name, key: `p_${p.id}`, width: 12 });
      cols.push({ header: `قیمت ${p.name}`, key: `pp_${p.id}`, width: 13 });
    }
    cols.push(
      { header: 'پیگیری بعدی', key: 'followUp', width: 13 },
      { header: 'تعهد ارسال', key: 'promises', width: 24 },
      { header: 'آخرین صحبت', key: 'lastCall', width: 45 },
      { header: 'مسئول', key: 'assignee', width: 14 },
      { header: 'منبع', key: 'source', width: 13 },
      { header: 'آدرس', key: 'address', width: 30 },
      { header: 'یادداشت', key: 'notes', width: 30 },
    );
    ws.columns = cols as ExcelJS.Column[];
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F1F1' } };

    const fmtDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
    // خانهٔ خالی یعنی «نپرسیده‌ایم» — همان تفاوتی که در دیتابیس هم NULL نگه می‌دارد
    const TRI_FA = (v: boolean | null) => (v == null ? '' : v ? 'بله' : 'خیر');

    for (const c of contacts) {
      const row: any = {
        code: c.code, name: c.name, ownerName: c.ownerName || '',
        governorate: c.city?.governorate || '', city: c.city?.name || '',
        phone: c.phone || '', whatsapp: c.whatsapp || '',
        status: STATUS_FA[c.status] || c.status,
        rating: c.rating ?? '', score: c.score,
        exhibition: TRI_FA(c.attendsExhibition), agency: TRI_FA(c.wantsAgency),
        followUp: fmtDate(c.nextFollowUpAt),
        promises: c.promises.map((p) => p.description?.trim() || PROMISE_FA[p.kind] || p.kind).join(' / '),
        lastCall: c.calls[0]?.summary || '',
        assignee: c.assignedTo?.name || '', source: c.source || '',
        address: c.address || '', notes: c.notes || '',
      };
      for (const p of products) {
        const it = c.interests.find((i) => i.productId === p.id);
        row[`p_${p.id}`] = it ? LEVEL_FA[it.level] : '';
        row[`pp_${p.id}`] = it ? PRICE_FA[it.priceOpinion] : '';
      }
      ws.addRow(row);
    }
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="market-contacts-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(Buffer.from(buf));
  });
}

export { normalizeIraqPhone };
