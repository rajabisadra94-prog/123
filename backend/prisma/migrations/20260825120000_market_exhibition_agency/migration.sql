-- دو صفت واجد شرایط بودنِ مخاطب که در تماس پرسیده می‌شود.
-- عمداً nullable: NULL یعنی «هنوز نپرسیده‌ایم» و با FALSE («پرسیدیم، گفت نه») یکی نیست.
ALTER TABLE "MarketContact" ADD COLUMN     "attendsExhibition" BOOLEAN,
ADD COLUMN     "wantsAgency" BOOLEAN;
