-- CreateEnum
CREATE TYPE "GlDocumentKind" AS ENUM ('SALES_INVOICE', 'PURCHASE_INVOICE', 'SALES_RETURN', 'PURCHASE_RETURN', 'RECEIPT_VOUCHER', 'PAYMENT_VOUCHER', 'OTHER');

-- CreateEnum
CREATE TYPE "GlDocumentStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "GlAuditLog" ADD COLUMN     "entity" TEXT,
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "newValue" JSONB,
ADD COLUMN     "oldValue" JSONB;

-- AlterTable
ALTER TABLE "GlLine" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "GlDocument" (
    "id" TEXT NOT NULL,
    "kind" "GlDocumentKind" NOT NULL,
    "status" "GlDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "number" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "subsidiaryId" TEXT,
    "projectId" TEXT,
    "costCenterId" TEXT,
    "currencyCode" TEXT NOT NULL,
    "rate" DECIMAL(24,10) NOT NULL,
    "subtotal" BIGINT NOT NULL DEFAULT 0,
    "vatAmount" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL DEFAULT 0,
    "description" TEXT,
    "notes" TEXT,
    "reversesDocumentId" TEXT,
    "entryId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "postedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "GlDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlDocumentLine" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4),
    "unitPrice" BIGINT,
    "amount" BIGINT NOT NULL,
    "accountId" TEXT NOT NULL,
    "projectId" TEXT,
    "costCenterId" TEXT,

    CONSTRAINT "GlDocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlDocumentTransition" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "fromState" "GlDocumentStatus",
    "toState" "GlDocumentStatus" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "byId" TEXT,
    "byName" TEXT,
    "note" TEXT,

    CONSTRAINT "GlDocumentTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlAttachment" (
    "id" TEXT NOT NULL,
    "documentId" TEXT,
    "entryId" TEXT,
    "url" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "label" TEXT,
    "uploadedById" TEXT,
    "uploadedByName" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlDocument_reversesDocumentId_key" ON "GlDocument"("reversesDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "GlDocument_entryId_key" ON "GlDocument"("entryId");

-- CreateIndex
CREATE INDEX "GlDocument_status_idx" ON "GlDocument"("status");

-- CreateIndex
CREATE INDEX "GlDocument_subsidiaryId_idx" ON "GlDocument"("subsidiaryId");

-- CreateIndex
CREATE INDEX "GlDocument_projectId_idx" ON "GlDocument"("projectId");

-- CreateIndex
CREATE INDEX "GlDocument_date_idx" ON "GlDocument"("date");

-- CreateIndex
CREATE UNIQUE INDEX "GlDocument_kind_number_key" ON "GlDocument"("kind", "number");

-- CreateIndex
CREATE INDEX "GlDocumentLine_accountId_idx" ON "GlDocumentLine"("accountId");

-- CreateIndex
CREATE INDEX "GlDocumentLine_projectId_idx" ON "GlDocumentLine"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "GlDocumentLine_documentId_lineNo_key" ON "GlDocumentLine"("documentId", "lineNo");

-- CreateIndex
CREATE INDEX "GlDocumentTransition_documentId_idx" ON "GlDocumentTransition"("documentId");

-- CreateIndex
CREATE INDEX "GlAttachment_documentId_idx" ON "GlAttachment"("documentId");

-- CreateIndex
CREATE INDEX "GlAttachment_entryId_idx" ON "GlAttachment"("entryId");

-- CreateIndex
CREATE INDEX "GlAuditLog_entity_entityId_idx" ON "GlAuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "GlLine_projectId_idx" ON "GlLine"("projectId");

-- AddForeignKey
ALTER TABLE "GlLine" ADD CONSTRAINT "GlLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlDocument" ADD CONSTRAINT "GlDocument_subsidiaryId_fkey" FOREIGN KEY ("subsidiaryId") REFERENCES "GlSubsidiary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlDocument" ADD CONSTRAINT "GlDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlDocument" ADD CONSTRAINT "GlDocument_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "GlCostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlDocument" ADD CONSTRAINT "GlDocument_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "GlCurrency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlDocument" ADD CONSTRAINT "GlDocument_reversesDocumentId_fkey" FOREIGN KEY ("reversesDocumentId") REFERENCES "GlDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlDocument" ADD CONSTRAINT "GlDocument_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "GlEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlDocumentLine" ADD CONSTRAINT "GlDocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "GlDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlDocumentLine" ADD CONSTRAINT "GlDocumentLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "GlAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlDocumentLine" ADD CONSTRAINT "GlDocumentLine_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlDocumentLine" ADD CONSTRAINT "GlDocumentLine_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "GlCostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlDocumentTransition" ADD CONSTRAINT "GlDocumentTransition_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "GlDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlAttachment" ADD CONSTRAINT "GlAttachment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "GlDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlAttachment" ADD CONSTRAINT "GlAttachment_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "GlEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

