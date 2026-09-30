/**
 * پاک‌سازی دادهٔ کسب‌وکاری — **تنها تعریف**، مشترک بین هر دو هسته.
 *
 * چرا یک‌جا: هر فایل تست نسخهٔ خودش را داشت. وقتی فایلی جدولی را از قلم می‌انداخت،
 * تستِ **فایل دیگری** می‌شکست — آن هم فقط در اجرای کامل و فقط با ترتیب خاصی از
 * فایل‌ها. یعنی یک شکست ناپایدار که ردیابی‌اش وقت می‌برد و ربطی به خود آن تست نداشت.
 *
 * ترتیب اهمیت دارد: هر جدول باید پیش از جدولی که به آن ارجاع می‌دهد پاک شود،
 * وگرنه کلید خارجی جلوی حذف را می‌گیرد.
 */

/** حداقلِ لازم از کلاینت — تا هم `gl` و هم `db` بتوانند بدهند */
type DeleteMany = { deleteMany: (args?: any) => Promise<unknown> };
export interface BusinessTables {
  invoiceItem: DeleteMany;
  invoice: DeleteMany;
  freightInvoice: DeleteMany;
  forwardingCargo: DeleteMany;
  productionOrder: DeleteMany;
  mainShipment: DeleteMany;
  projectCommission: DeleteMany;
  selectedPrice: DeleteMany;
  part: DeleteMany;
  project: DeleteMany;
  customer: DeleteMany;
  producer: DeleteMany;
  supplier: DeleteMany;
  shippingCompany: DeleteMany;
  exchange: DeleteMany;
  commissionAgent: DeleteMany;
}

/** از وابسته‌ترین به مستقل‌ترین */
const ORDER: (keyof BusinessTables)[] = [
  'invoiceItem',
  'invoice',
  'freightInvoice',
  'forwardingCargo',
  'productionOrder',
  'mainShipment',
  'projectCommission',
  'selectedPrice',
  'part',
  'project',
  'customer',
  'producer',
  'supplier',
  'shippingCompany',
  'exchange',
  'commissionAgent',
];

export async function resetBusinessData(client: BusinessTables) {
  for (const table of ORDER) {
    await client[table].deleteMany({});
  }
}
