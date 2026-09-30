import path from 'path';

type FileLevel = 'project' | 'part' | 'order' | 'invoice' | 'shipment' | 'transaction' | 'pricing';

interface FileContext {
  level: FileLevel;
  fileType: string;
  projectCode?: string;
  partCode?: string;
  partName?: string;
  orderCode?: string;
  invoiceCode?: string;
  shipmentCode?: string;
  transactionCode?: string;
  vendorCode?: string;
  carrierCode?: string;
  exchangeCode?: string;
  partyCode?: string;
  currencyPair?: string;
  direction?: string;
  currencyCode?: string;
  version?: string;
  shortDesc?: string;
  originalExt?: string;
}

const TYPE_CODES: Record<string, string> = {
  // project
  CONTRACT: 'CON',
  CORRESPONDENCE: 'LTR',
  ADVANCE_RECEIPT: 'RCPT',
  POD: 'POD',
  GENERAL: 'GEN',
  // part
  DRAWING_CUSTOMER: 'DRW',
  DRAWING_ENGINEERING: 'DRW',
  RENDER: 'IMG',
  // order
  PROFORMA: 'QT',
  VENDOR_INVOICE: 'INV_from-VEND',
  QC_REPORT: 'QC',
  PACKING_LIST: 'PL',
  MATERIAL_CERT: 'CERT',
  PRODUCTION_PHOTO: 'IMG_Production-Line',
  PACKAGED_PHOTO: 'IMG_Packaged',
  // invoice
  SIGNED_INVOICE: 'QT_signed-by-CUST',
  INVOICE_CONTRACT: 'CON',
  // shipment
  FORWARDER_RECEIPT: 'RCPT_from-CARRIER',
  BILL_OF_LADING: 'BOL',
  FREIGHT_INVOICE: 'INV_from-CARRIER',
  CUSTOMS: 'GEN_Customs-Clearance',
  LOADING_PHOTO: 'IMG_Loading-Process',
  // transaction
  PAYMENT_RECEIPT: 'RCPT',
  EXCHANGE_STMT: 'STMT_from-EXCH',
};

function formatDate(d = new Date()): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ۱۰.۳ — پاک‌سازی نام قطعه برای استفاده در نام فایل (حذف کاراکترهای غیرمجاز، محدودیت طول)
function sanitizePartName(name?: string): string {
  return (name || '').trim().replace(/[\s\\/:*?"<>|._]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
}

export function generateFileName(ctx: FileContext, originalName: string): string {
  const ext = ctx.originalExt || path.extname(originalName);
  const date = formatDate();
  const v = ctx.version || 'R01';
  const typeCode = TYPE_CODES[ctx.fileType] || ctx.fileType;

  let base = '';

  switch (ctx.level) {
    case 'project':
      base = `PRJ-${ctx.projectCode}_${typeCode}`;
      if (ctx.shortDesc) base += `_${ctx.shortDesc}`;
      base += `_${date}`;
      break;
    case 'part': {
      // نقشه‌ها: نسخهٔ صریح v_cust_NN / v_eng_NN (تمایز مشتری از مهندسی طبق استاندارد)
      let ver = v;
      if (ctx.fileType === 'DRAWING_CUSTOMER' || ctx.fileType === 'DRAWING_ENGINEERING') {
        const num = (v.match(/\d+/)?.[0] || '01').padStart(2, '0');
        ver = (ctx.fileType === 'DRAWING_CUSTOMER' ? 'v_cust_' : 'v_eng_') + num;
      }
      // ۱۰.۳ — نام قطعه (اگر موجود) در نام فایل قرار می‌گیرد، به‌همراه کد کوتاه برای یکتایی
      const nameSeg = sanitizePartName(ctx.partName);
      const partSeg = nameSeg ? `${nameSeg}-${ctx.partCode}` : ctx.partCode;
      base = `PRJ-${ctx.projectCode}_${typeCode}_part-${partSeg}_${ver}_${date}`;
      break;
    }
    case 'order':
      base = `ORD-${ctx.orderCode}_${typeCode}`;
      if (ctx.vendorCode) base += `-VEND-${ctx.vendorCode}`;
      if (ctx.partCode) base += `_part-${ctx.partCode}`;
      base += `_${v}_${date}`;
      break;
    case 'pricing': {
      // پرفرمای سازنده در مرحلهٔ قیمت‌گیری: به پروژه و سازندهٔ مشخص وصل است
      // نمونه: PRJ-MHM-0008_QT_from-صنایع-فلز_R01_20260710.pdf
      const vendor = sanitizePartName(ctx.vendorCode);
      base = `PRJ-${ctx.projectCode}_${typeCode}`;
      if (vendor) base += `_from-${vendor}`;
      base += `_${v}_${date}`;
      break;
    }
    case 'invoice':
      base = `INV-${ctx.invoiceCode}_${typeCode}_${date}`;
      break;
    case 'shipment': {
      // کد محموله معمولاً خودش با SHP- شروع می‌شود؛ از تکرار پیشوند جلوگیری می‌کنیم
      const shp = (ctx.shipmentCode || '').replace(/^SHP-/, '');
      base = `SHP-${shp}_${typeCode}`;
      if (ctx.carrierCode) base += `-${sanitizePartName(ctx.carrierCode)}`;
      base += `_${date}`;
      break;
    }
    case 'transaction':
      base = `TRN-${ctx.transactionCode}_${typeCode}`;
      if (ctx.direction && ctx.partyCode) base += `_${ctx.direction}-${ctx.partyCode}`;
      if (ctx.currencyCode) base += `_cur-${ctx.currencyCode}`;
      if (ctx.currencyPair) base += `_${ctx.currencyPair}`;
      if (ctx.exchangeCode) base += `-EXCH-${ctx.exchangeCode}`;
      base += `_${date}`;
      break;
  }

  return base + ext;
}
