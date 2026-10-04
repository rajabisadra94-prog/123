-- ============================================================
-- مهاجرت جبرانی — هم‌ترازکردن مهاجرت‌ها با شمای واقعی
--
-- از ۰۷ خرداد به بعد تغییرات ساختاری با `prisma db push` اعمال شده
-- بود، که مستقیم روی دیتابیسِ توسعه می‌نویسد و هیچ فایل مهاجرتی
-- نمی‌سازد. نتیجه: پوشهٔ migrations از شما ۱۷ جدول عقب بود و
-- `migrate deploy` روی سرورِ تازه، دیتابیسی ناقص می‌ساخت.
--
-- این فایل با `prisma migrate diff` از اختلاف همان دو حالت ساخته شد.
-- روی دیتابیسِ توسعه با `migrate resolve --applied` علامت‌گذاری شده
-- (چون تغییراتش از قبل آنجا هست) و فقط روی دیتابیس‌های تازه اجرا می‌شود.
-- ============================================================

-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('BUG', 'FEATURE');

-- CreateEnum
CREATE TYPE "FeedbackStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'DONE', 'DISMISSED');

-- DropForeignKey
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_projectId_fkey";

-- DropForeignKey
ALTER TABLE "PartPrice" DROP CONSTRAINT "PartPrice_id_fkey";

-- DropForeignKey
ALTER TABLE "PricingProducer" DROP CONSTRAINT "PricingProducer_producerId_fkey";

-- DropForeignKey
ALTER TABLE "ProductionOrder" DROP CONSTRAINT "ProductionOrder_producerId_fkey";

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "isSystem" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taskId" TEXT,
ALTER COLUMN "projectId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "DomesticPackage" ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "FinancialAccount" ADD COLUMN     "controlKind" TEXT,
ADD COLUMN     "supplierId" TEXT;

-- AlterTable
ALTER TABLE "FreightInvoice" ADD COLUMN     "costBreakdown" JSONB;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "hasVat" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "prepDays" INTEGER,
ADD COLUMN     "prepNote" TEXT,
ADD COLUMN     "vatAmount" DECIMAL(65,30),
ADD COLUMN     "vatPercent" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "MainShipment" ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "brand" TEXT,
ADD COLUMN     "color" TEXT,
ADD COLUMN     "declaredCurrency" "Currency",
ADD COLUMN     "declaredValue" DECIMAL(65,30),
ADD COLUMN     "description" TEXT,
ADD COLUMN     "dimensions" TEXT,
ADD COLUMN     "hsCode" TEXT,
ADD COLUMN     "partModel" TEXT,
ADD COLUMN     "productLinks" JSONB,
ADD COLUMN     "unit" TEXT;

-- AlterTable
ALTER TABLE "PartPrice" ADD COLUMN     "supplierId" TEXT,
ALTER COLUMN "producerId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "PricingProducer" ADD COLUMN     "supplierId" TEXT,
ALTER COLUMN "producerId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Producer" ADD COLUMN     "isDomestic" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ProducerCategory" ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "ProductionOrder" ADD COLUMN     "delayNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "inspectionNote" TEXT,
ADD COLUMN     "inspectionStatus" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'PRODUCTION',
ADD COLUMN     "purchaseStage" TEXT,
ADD COLUMN     "supplierId" TEXT,
ALTER COLUMN "producerId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "estimatedWeightKg" DECIMAL(65,30),
ADD COLUMN     "specApprovalRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'MANUFACTURING';

-- AlterTable
ALTER TABLE "ProjectFile" ADD COLUMN     "description" TEXT,
ADD COLUMN     "reviewReason" TEXT,
ADD COLUMN     "reviewStatus" "TechnicalStatus",
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- AlterTable
ALTER TABLE "SelectedPrice" ADD COLUMN     "supplierId" TEXT,
ALTER COLUMN "producerId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "assigneeIds" TEXT[],
ADD COLUMN     "priority" TEXT NOT NULL DEFAULT 'NORMAL';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "projectAccessMode" TEXT NOT NULL DEFAULT 'ALL';

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#fff8c5',
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "attachmentName" TEXT,
    "attachmentMime" TEXT,
    "attachmentSize" INTEGER,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "readAt" TIMESTAMP(3),
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replyToId" TEXT,
    "convKey" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "wechat" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeRateSnapshot" (
    "id" TEXT NOT NULL,
    "usdToIrr" DECIMAL(65,30) NOT NULL,
    "cnyToIrr" DECIMAL(65,30) NOT NULL,
    "usdToCny" DECIMAL(65,30) NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DrawingReview" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "status" "TechnicalStatus" NOT NULL,
    "reason" TEXT,
    "fileUrl" TEXT,
    "fileName" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DrawingReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingProducerPart" (
    "id" TEXT NOT NULL,
    "pricingProducerId" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingProducerPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingProforma" (
    "id" TEXT NOT NULL,
    "pricingRequestId" TEXT NOT NULL,
    "producerId" TEXT,
    "supplierId" TEXT,
    "url" TEXT NOT NULL,
    "note" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingProforma_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForwardingCargo" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "weightKg" DECIMAL(65,30),
    "volumeCbm" DECIMAL(65,30),
    "packagesCount" INTEGER,
    "senderName" TEXT,
    "senderContact" TEXT,
    "goodsDescription" TEXT,
    "declaredValue" DECIMAL(65,30),
    "declaredCurrency" "Currency",
    "route" TEXT,
    "transit" TEXT,
    "freightMode" TEXT,
    "freightRate" DECIMAL(65,30),
    "flatAmount" DECIMAL(65,30),
    "quoteCurrency" "Currency" NOT NULL DEFAULT 'USD',
    "quotedAmount" DECIMAL(65,30),
    "quoteConfirmedAt" TIMESTAMP(3),
    "stage" TEXT NOT NULL DEFAULT 'AWAITING_CHINA',
    "shipmentId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ForwardingCargo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForwardingCargoFile" (
    "id" TEXT NOT NULL,
    "cargoId" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForwardingCargoFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "entryNo" SERIAL NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "description" TEXT,
    "eventType" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "projectId" TEXT,
    "attachmentUrls" TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "reversesId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversalReason" TEXT,
    "categoryId" TEXT,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntryRevision" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "reason" TEXT,
    "editedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntryRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalPeriod" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER,
    "closedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "note" TEXT,

    CONSTRAINT "FiscalPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLine" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debit" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "credit" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "currency" "Currency" NOT NULL,
    "rateToIRR" DECIMAL(65,30) NOT NULL DEFAULT 1,
    "memo" TEXT,

    CONSTRAINT "JournalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChecklistItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "assigneeIds" TEXT[],
    "isDone" BOOLEAN NOT NULL DEFAULT false,
    "doneById" TEXT,
    "doneAt" TIMESTAMP(3),
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedbackReport" (
    "id" TEXT NOT NULL,
    "type" "FeedbackType" NOT NULL DEFAULT 'BUG',
    "module" TEXT,
    "page" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "steps" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "status" "FeedbackStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedbackReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Message_convKey_createdAt_idx" ON "Message"("convKey", "createdAt");

-- CreateIndex
CREATE INDEX "Message_fromUserId_toUserId_createdAt_idx" ON "Message"("fromUserId", "toUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_toUserId_fromUserId_createdAt_idx" ON "Message"("toUserId", "fromUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_toUserId_isRead_idx" ON "Message"("toUserId", "isRead");

-- CreateIndex
CREATE INDEX "ExchangeRateSnapshot_createdAt_idx" ON "ExchangeRateSnapshot"("createdAt");

-- CreateIndex
CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_userId_key" ON "ProjectMember"("projectId", "userId");

-- CreateIndex
CREATE INDEX "DrawingReview_fileId_idx" ON "DrawingReview"("fileId");

-- CreateIndex
CREATE INDEX "DrawingReview_partId_idx" ON "DrawingReview"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "PricingProducerPart_pricingProducerId_partId_key" ON "PricingProducerPart"("pricingProducerId", "partId");

-- CreateIndex
CREATE INDEX "PricingProforma_pricingRequestId_producerId_idx" ON "PricingProforma"("pricingRequestId", "producerId");

-- CreateIndex
CREATE UNIQUE INDEX "ForwardingCargo_projectId_key" ON "ForwardingCargo"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_entryNo_key" ON "JournalEntry"("entryNo");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_reversesId_key" ON "JournalEntry"("reversesId");

-- CreateIndex
CREATE INDEX "JournalEntry_date_idx" ON "JournalEntry"("date");

-- CreateIndex
CREATE INDEX "JournalEntry_eventType_date_idx" ON "JournalEntry"("eventType", "date");

-- CreateIndex
CREATE INDEX "JournalEntry_categoryId_date_idx" ON "JournalEntry"("categoryId", "date");

-- CreateIndex
CREATE INDEX "JournalEntryRevision_entryId_createdAt_idx" ON "JournalEntryRevision"("entryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalPeriod_year_month_key" ON "FiscalPeriod"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_name_key" ON "ExpenseCategory"("name");

-- CreateIndex
CREATE INDEX "FeedbackReport_status_idx" ON "FeedbackReport"("status");

-- CreateIndex
CREATE UNIQUE INDEX "PricingProducer_pricingRequestId_supplierId_key" ON "PricingProducer"("pricingRequestId", "supplierId");

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProducerCategory" ADD CONSTRAINT "ProducerCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProducerCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingProducer" ADD CONSTRAINT "PricingProducer_producerId_fkey" FOREIGN KEY ("producerId") REFERENCES "Producer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingProducer" ADD CONSTRAINT "PricingProducer_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingProducerPart" ADD CONSTRAINT "PricingProducerPart_pricingProducerId_fkey" FOREIGN KEY ("pricingProducerId") REFERENCES "PricingProducer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingProducerPart" ADD CONSTRAINT "PricingProducerPart_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_producerId_fkey" FOREIGN KEY ("producerId") REFERENCES "Producer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOrder" ADD CONSTRAINT "ProductionOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForwardingCargo" ADD CONSTRAINT "ForwardingCargo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForwardingCargo" ADD CONSTRAINT "ForwardingCargo_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "MainShipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForwardingCargoFile" ADD CONSTRAINT "ForwardingCargoFile_cargoId_fkey" FOREIGN KEY ("cargoId") REFERENCES "ForwardingCargo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialAccount" ADD CONSTRAINT "FinancialAccount_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntryRevision" ADD CONSTRAINT "JournalEntryRevision_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FinancialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChecklistItem" ADD CONSTRAINT "ChecklistItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

