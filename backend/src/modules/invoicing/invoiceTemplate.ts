// Generates a print-ready, RTL Persian invoice HTML page (A4).
// Opened in a browser tab; the user prints to PDF (Ctrl+P → Save as PDF).
// طراحی: فاکتور برند فابریک (وارد شده از Claude Design) — با دیتای واقعی سیستم وصل شده.

const FA_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

// ۴.۴ — مبالغ دقیق (بدون گرد کردن به بالا) + ارقام و جداکنندهٔ فارسی مطابق طراحی
function fmt(n: number): string {
  const s = (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return s.replace(/[0-9]/g, (d) => FA_DIGITS[+d]).replace(/,/g, '٬');
}

// تبدیل عدد صحیح به حروف فارسی (برای «مبلغ به حروف» — فقط فاکتور تومانی استفاده می‌شود)
function toPersianWords(input: number): string {
  let num = Math.floor(Math.abs(Number(input) || 0));
  if (num === 0) return 'صفر';
  const yekan = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
  const dahYade = ['ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
  const dahgan = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
  const sadgan = ['', 'یکصد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
  const scales = ['', ' هزار', ' میلیون', ' میلیارد', ' بیلیون'];

  const threeDigits = (n: number): string => {
    const parts: string[] = [];
    const s = Math.floor(n / 100);
    const rest = n % 100;
    if (s) parts.push(sadgan[s]);
    if (rest >= 10 && rest <= 19) {
      parts.push(dahYade[rest - 10]);
    } else {
      const d = Math.floor(rest / 10);
      const y = rest % 10;
      if (d) parts.push(dahgan[d]);
      if (y) parts.push(yekan[y]);
    }
    return parts.join(' و ');
  };

  const groups: number[] = [];
  while (num > 0) {
    groups.push(num % 1000);
    num = Math.floor(num / 1000);
  }
  const out: string[] = [];
  for (let g = groups.length - 1; g >= 0; g--) {
    if (groups[g] === 0) continue;
    out.push(threeDigits(groups[g]) + (scales[g] || ''));
  }
  return out.join(' و ');
}

/** آدرس فایل برای درجِ داخل HTML فاکتور.
 *  این HTML از خودِ بک‌اند سرو می‌شود (‎/api/invoicing/:id/print‎) و در مرورگرِ
 *  کاربر باز می‌شود، پس مسیرِ نسبی را خودِ مرورگر نسبت به همان دامنه حل می‌کند.
 *  قبلاً این‌جا 'http://localhost:3001' هاردکد بود که روی سرور یعنی لوگو و مهرِ
 *  شرکت در فاکتورِ مشتری خراب نمایش داده می‌شد. */
const fileSrc = (url: string) => (/^https?:\/\//i.test(url) ? url : url.startsWith('/') ? url : `/${url}`);

// جملات پیش‌فرض فاکتور (از طراحی Claude Design) — در تنظیمات قابل تغییرند
const DEFAULT_NOTES = 'کلیه قطعات مطابق نقشه و استاندارد سفارش مشتری تولید و کنترل کیفی می‌شوند.';
const DEFAULT_TERMS = 'اعتبار این پیش‌فاکتور ۷ روز کاری است.\nشروع تولید منوط به واریز پیش‌پرداخت است.\nهزینه حمل بر عهده خریدار می‌باشد.';
const DEFAULT_FOOTER = 'ما را با سخت‌ترین قطعه‌ی خود بیازمایید.';

// نشان برند فابریک (fallback وقتی لوگوی شرکت آپلود نشده)
const BRAND_MARK = `<svg viewBox="0 0 118 74" xmlns="http://www.w3.org/2000/svg" style="width:66px;height:auto">
  <polygon points="22,8 118,8 106,30 10,30" fill="#e52329"/>
  <polygon points="58,42 118,42 106,64 46,64" fill="#e52329"/>
</svg>`;

export function renderInvoiceHtml(inv: any, company: Record<string, string>, curLabel: Record<string, string>, invoiceSettings: Record<string, string> = {}): string {
  const customer = inv.project.customer;
  const cur = curLabel[inv.currency] || inv.currency;
  // فاکتور خرید کالا (TRADING): ستون‌های «واحد/رنگ» به‌جای «جنس/پوشش»
  const isTrading = inv.project?.type === 'TRADING';
  const col2Label = isTrading ? 'واحد' : 'جنس';
  const col3Label = isTrading ? 'رنگ' : 'پوشش';
  const descLabel = isTrading ? 'شرح کالا' : 'شرح قطعه';

  const companyName = company.COMPANY_NAME || 'نام شرکت شما';
  const logo = company.COMPANY_LOGO_URL
    ? `<img src="${fileSrc(company.COMPANY_LOGO_URL)}" style="max-height:66px;width:auto" />`
    : BRAND_MARK;

  // مهر شرکت — اگر در تنظیمات آپلود شده باشد، همیشه روی کادر امضای فروشنده می‌نشیند
  const stampSrc = company.COMPANY_STAMP_URL
    ? fileSrc(company.COMPANY_STAMP_URL)
    : '';
  const stampImg = stampSrc ? `<img class="stamp" src="${stampSrc}" alt="مهر شرکت" />` : '';

  // خط تماس شرکت (آدرس · تلفن · ایمیل) — فقط موارد موجود
  const contactBits: string[] = [];
  if (company.COMPANY_PHONE) contactBits.push(`تلفن: ${company.COMPANY_PHONE}`);
  if (company.COMPANY_EMAIL) contactBits.push(company.COMPANY_EMAIL);

  const rows = inv.items
    .map((it: any, i: number) => {
      const qty = Number(it.part?.quantity) || 1;
      const unit = Number(it.saleAmount) || 0;
      const lineTotal = unit * qty;
      const unitLabel = curLabel[it.saleCurrency] || it.saleCurrency;
      return `
      <tr>
        <td class="row-idx">${fmt(i + 1)}</td>
        <td class="desc">${it.part?.name || '-'}</td>
        <td>${(isTrading ? it.part?.unit : it.part?.material?.name) || '-'}</td>
        <td>${(isTrading ? it.part?.color : it.part?.coating?.name) || '-'}</td>
        <td class="num">${fmt(qty)}</td>
        <td class="num">${fmt(unit)}<span class="cur">${unitLabel}</span></td>
        <td class="num">${fmt(lineTotal)}<span class="cur">${unitLabel}</span></td>
      </tr>`;
    })
    .join('');

  // تفکیک ارزی اقلام (از دیتای واقعی) — هر ارز جداگانه جمع می‌شود
  const byCurrency: Record<string, number> = {};
  inv.items.forEach((it: any) => {
    const qty = Number(it.part?.quantity) || 1;
    const unit = Number(it.saleAmount) || 0;
    const c = it.saleCurrency || inv.currency;
    byCurrency[c] = (byCurrency[c] || 0) + unit * qty;
  });
  const itemRows = Object.entries(byCurrency)
    .map(([c, sum]) => `
        <div class="brow"><span>جمع اقلام (${curLabel[c] || c})</span><span class="bnum">${fmt(sum)}<i>${curLabel[c] || c}</i></span></div>`)
    .join('');
  // مالیات بر ارزش افزوده — فقط اگر فاکتور شامل آن باشد
  const vatAmt = Number(inv.vatAmount) || 0;
  const vatPct = Number(inv.vatPercent) || 0;
  const vatRow = inv.hasVat
    ? `
        <div class="brow"><span>مالیات بر ارزش افزوده (${fmt(vatPct)}٪)</span><span class="bnum" style="color:var(--red)">${fmt(vatAmt)}<i>${cur}</i></span></div>`
    : '';
  const breakdownRows = itemRows + vatRow;
  // آیا اقلامی به ارزی غیر از ارز فاکتور وجود دارد؟ (برای یادداشت تبدیل نرخ)
  const hasForeign = Object.keys(byCurrency).some((c) => c !== inv.currency);

  const issueDate = new Date(inv.createdAt).toLocaleDateString('fa-IR');

  // پس از تأیید مشتری، سند «فاکتور فروش» است؛ پیش از آن «پیش‌فاکتور»
  const isSales = inv.status === 'APPROVED';
  const docTitle = isSales ? 'فاکتور فروش' : 'پیش‌فاکتور';
  const prepText = inv.prepDays
    ? `${fmt(inv.prepDays)} روز کاری پس از واریز پیش‌پرداخت${inv.prepNote ? ' — ' + inv.prepNote : ''}`
    : (inv.prepNote || '');

  // مبلغ به حروف — فقط برای فاکتور تومانی (IRR) و مقدار صحیح معنا دارد
  const amountWords = inv.currency === 'IRR' ? toPersianWords(inv.totalAmount) + ' تومان' : '';

  // جملات ثابت — از تنظیمات، وگرنه پیش‌فرض طراحی. یادداشت توافقیِ خودِ فاکتور (inv.notes) اولویت دارد.
  const notesText = inv.notes || invoiceSettings.defaultNotes || DEFAULT_NOTES;
  const termsText = invoiceSettings.terms || DEFAULT_TERMS;
  const footerText = invoiceSettings.footer || DEFAULT_FOOTER;

  // بلوک شرایط و قوانین: چند خطی → لیست، تک‌خطی → پاراگراف
  const termsHtml = termsText.includes('\n')
    ? `<ol class="terms">${termsText.split('\n').filter((l) => l.trim()).map((l) => `<li>${l.trim()}</li>`).join('')}</ol>`
    : `<p>${termsText}</p>`;

  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${inv.versionCode} - ${inv.project.code}</title>
<style>
  :root{
    --petrol:#0f5569;
    --petrol-dark:#0b3f4f;
    --red:#e52329;
    --mint:#bfe2e0;
    --mint-soft:#eaf6f5;
    --ink:#182a30;
    --muted:#5c6f74;
    --line:#d6e0e0;
    --paper:#ffffff;
  }
  *{ box-sizing:border-box; margin:0; padding:0; }
  html,body{
    font-family:"Vazirmatn","Vazir",Tahoma,"IRANSans","Segoe UI",sans-serif;
    color:var(--ink);
    background:#e9edee;
    line-height:1.7;
    -webkit-font-smoothing:antialiased;
  }

  /* ===== Toolbar (چاپ) — در پرینت پنهان ===== */
  .toolbar{ text-align:center; padding:16px; }
  .toolbar button{ padding:10px 24px; background:var(--petrol); color:#fff; border:none; border-radius:8px; font-size:15px; cursor:pointer; font-family:inherit; }

  /* ===== Sheet ===== */
  .sheet{
    width:210mm;
    min-height:297mm;
    margin:0 auto 24px;
    background:var(--paper);
    padding:14mm 13mm 12mm;
    box-shadow:0 10px 40px rgba(15,85,105,.18);
    display:flex;
    flex-direction:column;
  }

  /* ===== Header ===== */
  .header{ display:flex; justify-content:space-between; align-items:flex-start; gap:24px; padding-bottom:16px; border-bottom:3px solid var(--petrol); }
  .brand{ display:flex; gap:14px; align-items:center; }
  .logo{ flex-shrink:0; display:flex; align-items:center; justify-content:center; }
  .brand-text .name{ font-size:21px; font-weight:800; color:var(--petrol); letter-spacing:-.2px; }
  .brand-text .meta{ font-size:11.5px; color:var(--muted); margin-top:5px; }
  .brand-text .meta .row{ display:flex; gap:14px; flex-wrap:wrap; }

  .doc-title{ text-align:left; min-width:210px; }
  .doc-title .kicker{ display:inline-block; background:var(--red); color:#fff; font-size:15px; font-weight:800; padding:7px 18px; border-radius:6px; letter-spacing:.3px; }
  .doc-title .fields{ margin-top:12px; font-size:12px; }
  .doc-title .fields .f{ display:flex; justify-content:space-between; gap:10px; padding:4px 0; border-bottom:1px dashed var(--line); }
  .doc-title .fields .f:last-child{ border-bottom:none; }
  .doc-title .fields .lbl{ color:var(--muted); }
  .doc-title .fields .val{ font-weight:700; color:var(--petrol); font-variant-numeric:tabular-nums; }

  /* ===== Parties ===== */
  .parties{ display:grid; grid-template-columns:1fr 1fr .7fr; gap:8px; margin-top:14px; }
  .party{ border:1px solid var(--line); border-radius:6px; display:flex; align-items:baseline; gap:8px; padding:7px 11px; }
  .party .head{ color:var(--red); font-size:10px; font-weight:800; letter-spacing:.3px; white-space:nowrap; flex-shrink:0; border-inline-end:1px solid var(--line); padding-inline-end:9px; }
  .party .body{ font-size:10.5px; color:var(--muted); line-height:1.55; min-width:0; }
  .party .body .n{ font-weight:700; font-size:11.5px; color:var(--ink); }
  .party .body .l{ display:block; }
  .party.project{ align-items:center; }
  .party.project .code{ font-size:15px; font-weight:800; color:var(--petrol); letter-spacing:.5px; font-variant-numeric:tabular-nums; }

  /* ===== Items table ===== */
  .items{ margin-top:16px; }
  table{ width:100%; border-collapse:collapse; font-size:12px; }
  thead th{ background:var(--petrol); color:#fff; font-weight:700; padding:9px 8px; text-align:center; white-space:nowrap; }
  thead th:first-child{ border-start-start-radius:8px; }
  thead th:last-child{ border-start-end-radius:8px; }
  tbody td{ padding:9px 8px; text-align:center; border-bottom:1px solid var(--line); vertical-align:middle; }
  tbody tr:nth-child(even){ background:var(--mint-soft); }
  tbody td.desc{ text-align:right; font-weight:700; }
  tbody td.num{ font-variant-numeric:tabular-nums; white-space:nowrap; }
  .cur{ color:var(--muted); font-size:10.5px; margin-inline-start:3px; }
  .row-idx{ color:var(--petrol); font-weight:800; }

  /* ===== Summary ===== */
  .prep-bar{ margin-top:14px; border:1px solid var(--line); border-radius:6px; padding:8px 13px; display:flex; align-items:center; gap:9px; }
  .prep-bar .lbl{ font-size:10px; font-weight:800; color:var(--red); letter-spacing:.3px; white-space:nowrap; border-inline-end:1px solid var(--line); padding-inline-end:9px; }
  .prep-bar .val{ font-size:12px; font-weight:700; color:var(--petrol); }

  .total-wrap{ margin-top:9px; display:flex; align-items:stretch; gap:12px; }
  .breakdown{ flex:1; border:1px solid var(--line); border-radius:6px; padding:4px 14px; display:flex; flex-direction:column; justify-content:center; }
  .brow{ display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:6px 0; border-bottom:1px dashed var(--line); }
  .brow:last-child{ border-bottom:none; }
  .brow > span:first-child{ color:var(--muted); }
  .brow .bnum{ font-weight:700; color:var(--ink); font-variant-numeric:tabular-nums; white-space:nowrap; }
  .brow .bnum i{ font-style:normal; color:var(--muted); font-size:10.5px; font-weight:600; margin-inline-start:2px; }
  .total{ background:var(--petrol); color:#fff; border-radius:6px; padding:11px 22px; min-width:330px; display:flex; flex-direction:column; align-items:flex-start; justify-content:center; text-align:right; position:relative; overflow:hidden; }
  .total::before{ content:""; position:absolute; inset-inline-end:0; top:0; bottom:0; width:6px; background:var(--red); }
  .total .lbl{ font-size:11.5px; opacity:.9; white-space:nowrap; }
  .total .amount{ font-size:26px; font-weight:800; font-variant-numeric:tabular-nums; margin-top:1px; line-height:1.15; }
  .total .amount .u{ font-size:14px; font-weight:600; margin-inline-start:6px; opacity:.9; }
  .total .words{ font-size:11px; font-weight:600; color:var(--mint); margin-top:5px; line-height:1.5; }
  .total .note{ font-size:10px; opacity:.72; margin-top:3px; }

  /* ===== Info blocks ===== */
  .info-grid{ margin-top:16px; display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .block{ border:1px solid var(--line); border-radius:8px; padding:11px 13px; }
  .block h4{ font-size:12px; color:var(--petrol); font-weight:800; margin-bottom:6px; display:flex; align-items:center; gap:6px; }
  .block h4::before{ content:""; width:4px; height:14px; background:var(--red); border-radius:2px; }
  .block p{ font-size:11.5px; color:var(--muted); line-height:1.9; }
  .block.full{ grid-column:1 / -1; }
  ol.terms{ margin-inline-start:16px; font-size:11px; color:var(--muted); line-height:1.9; }

  /* ===== Signatures ===== */
  .signs{ margin-top:auto; padding-top:18px; display:grid; grid-template-columns:1fr 1fr; gap:40px; }
  .sign{ text-align:center; }
  .sign .box{ position:relative; height:88px; border:1px dashed var(--petrol); border-radius:8px; background:var(--mint-soft); margin-bottom:8px; overflow:visible; }
  .sign .stamp{ position:absolute; top:50%; left:50%; width:210px; height:auto; transform:translate(-50%,-52%); opacity:.9; mix-blend-mode:multiply; pointer-events:none; }
  .sign .cap{ font-size:12px; font-weight:700; color:var(--petrol); }

  .footer{ margin-top:14px; padding-top:10px; border-top:1px solid var(--line); display:flex; justify-content:space-between; font-size:10.5px; color:var(--muted); }
  .footer .slogan{ color:var(--red); font-weight:700; }

  /* ===== Print ===== */
  @page{ size:A4; margin:0; }
  @media print{
    html,body{ background:#fff; }
    .toolbar{ display:none; }
    .sheet{ margin:0; box-shadow:none; width:210mm; min-height:297mm; }
    *{ -webkit-print-color-adjust:exact !important; print-color-adjust:exact !important; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <button onclick="window.print()">🖨 چاپ / ذخیره به‌صورت PDF</button>
  </div>

  <div class="sheet">

    <!-- Header -->
    <header class="header">
      <div class="brand">
        <div class="logo">${logo}</div>
        <div class="brand-text">
          <div class="name">${companyName}</div>
          <div class="meta">
            ${company.COMPANY_ADDRESS ? `<div class="row"><span>${company.COMPANY_ADDRESS}</span></div>` : ''}
            ${contactBits.length ? `<div class="row">${contactBits.map((b) => `<span>${b}</span>`).join('')}</div>` : ''}
            ${company.COMPANY_EXTRA ? `<div class="row"><span>${company.COMPANY_EXTRA}</span></div>` : ''}
          </div>
        </div>
      </div>

      <div class="doc-title">
        <span class="kicker">${docTitle}</span>
        <div class="fields">
          <div class="f"><span class="lbl">شماره فاکتور</span><span class="val">${inv.versionCode}</span></div>
          <div class="f"><span class="lbl">تاریخ صدور</span><span class="val">${issueDate}</span></div>
        </div>
      </div>
    </header>

    <!-- Parties -->
    <section class="parties">
      <div class="party">
        <div class="head">فروشنده</div>
        <div class="body">
          <span class="n">${companyName}</span>
          ${company.COMPANY_ADDRESS ? `<span class="l">${company.COMPANY_ADDRESS}</span>` : ''}
          ${contactBits.length ? `<span class="l">${contactBits.join(' · ')}</span>` : ''}
        </div>
      </div>
      <div class="party">
        <div class="head">خریدار</div>
        <div class="body">
          <span class="n">${customer.name}</span>
          ${customer.address ? `<span class="l">${customer.address}</span>` : ''}
          ${customer.phone ? `<span class="l">تلفن: ${customer.phone}</span>` : ''}
        </div>
      </div>
      <div class="party project">
        <div class="head">پروژه</div>
        <div class="body"><span class="code">${inv.project.code}</span></div>
      </div>
    </section>

    <!-- Items -->
    <section class="items">
      <table>
        <thead>
          <tr>
            <th style="width:36px;">ردیف</th>
            <th>${descLabel}</th>
            <th style="width:90px;">${col2Label}</th>
            <th style="width:80px;">${col3Label}</th>
            <th style="width:52px;">تعداد</th>
            <th style="width:120px;">قیمت واحد</th>
            <th style="width:130px;">قیمت کل</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>

    <!-- Summary -->
    ${prepText ? `<section class="prep-bar"><span class="lbl">زمان آماده‌سازی</span><span class="val">${prepText}</span></section>` : ''}
    <section class="total-wrap">
      <div class="breakdown">${breakdownRows}</div>
      <div class="total">
        <span class="lbl">مبلغ کل قابل پرداخت</span>
        <span class="amount">${fmt(inv.totalAmount)}<span class="u">${cur}</span></span>
        ${amountWords ? `<span class="words">${amountWords}</span>` : ''}
        ${hasForeign ? `<span class="note">مبالغ ارزی به نرخ روز تبدیل و در مبلغ کل لحاظ شده‌اند.</span>` : ''}
      </div>
    </section>

    <!-- Info -->
    <section class="info-grid">
      <div class="block full"><h4>توضیحات</h4><p>${notesText}</p></div>
      ${invoiceSettings.paymentInfo ? `<div class="block"><h4>اطلاعات پرداخت</h4><p>${(invoiceSettings.paymentInfo || '').replace(/\n/g, '<br/>')}</p></div>` : ''}
      <div class="block"><h4>شرایط و قوانین</h4>${termsHtml}</div>
    </section>

    <!-- Signatures -->
    <section class="signs">
      <div class="sign"><div class="box">${stampImg}</div><div class="cap">مهر و امضای فروشنده</div></div>
      <div class="sign"><div class="box"></div><div class="cap">مهر و امضای خریدار</div></div>
    </section>

    <footer class="footer">
      <span>${companyName}</span>
      <span class="slogan">${footerText}</span>
    </footer>

  </div>
</body>
</html>`;
}
