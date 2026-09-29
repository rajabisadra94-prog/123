-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('NEW', 'ATTEMPTED', 'CONTACTED', 'INTERESTED', 'NEGOTIATING', 'SAMPLE_SENT', 'CUSTOMER', 'NOT_INTERESTED', 'UNREACHABLE', 'BLACKLIST');

-- CreateEnum
CREATE TYPE "MarketInterestLevel" AS ENUM ('NOT_DISCUSSED', 'POSITIVE', 'NEUTRAL', 'NEGATIVE');

-- CreateEnum
CREATE TYPE "MarketPriceOpinion" AS ENUM ('NOT_DISCUSSED', 'GOOD', 'ACCEPTABLE', 'EXPENSIVE');

-- CreateEnum
CREATE TYPE "MarketChannel" AS ENUM ('CALL', 'WHATSAPP', 'TELEGRAM', 'VIBER', 'INSTAGRAM', 'EMAIL', 'VISIT', 'OTHER');

-- CreateEnum
CREATE TYPE "MarketCallResult" AS ENUM ('ANSWERED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'CALLBACK', 'REJECTED');

-- CreateEnum
CREATE TYPE "MarketPromiseKind" AS ENUM ('SAMPLE', 'CATALOG', 'PRICE_LIST', 'QUOTE', 'VIDEO', 'CERTIFICATE', 'OTHER');

-- CreateEnum
CREATE TYPE "MarketPromiseStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MarketContactType" AS ENUM ('SHOP', 'DISTRIBUTOR', 'CLINIC', 'LAB', 'IMPORTER', 'OTHER');

-- CreateTable
CREATE TABLE "MarketCity" (
    "id" TEXT NOT NULL,
    "governorate" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MarketCity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketProduct" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "nameEn" TEXT,
    "code" TEXT,
    "unit" TEXT,
    "listPriceUsd" DOUBLE PRECISION,
    "moq" TEXT,
    "description" TEXT,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketContact" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "ownerName" TEXT,
    "type" "MarketContactType" NOT NULL DEFAULT 'SHOP',
    "cityId" TEXT,
    "address" TEXT,
    "mapUrl" TEXT,
    "phone" TEXT,
    "phone2" TEXT,
    "whatsapp" TEXT,
    "telegram" TEXT,
    "instagram" TEXT,
    "email" TEXT,
    "website" TEXT,
    "phoneNorm" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "language" TEXT,
    "source" TEXT,
    "status" "MarketStatus" NOT NULL DEFAULT 'NEW',
    "rating" INTEGER,
    "score" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "assignedToId" TEXT,
    "nextFollowUpAt" TIMESTAMP(3),
    "followUpReason" TEXT,
    "followUpNotifiedAt" TIMESTAMP(3),
    "lastContactAt" TIMESTAMP(3),
    "firstContactAt" TIMESTAMP(3),
    "contactAttempts" INTEGER NOT NULL DEFAULT 0,
    "doNotCall" BOOLEAN NOT NULL DEFAULT false,
    "customerId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketInterest" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "level" "MarketInterestLevel" NOT NULL DEFAULT 'NOT_DISCUSSED',
    "priceOpinion" "MarketPriceOpinion" NOT NULL DEFAULT 'NOT_DISCUSSED',
    "quotedPriceUsd" DOUBLE PRECISION,
    "targetPriceUsd" DOUBLE PRECISION,
    "currentSupplier" TEXT,
    "competitorPriceUsd" DOUBLE PRECISION,
    "monthlyQty" INTEGER,
    "sampleRequested" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketInterest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketCall" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "MarketChannel" NOT NULL DEFAULT 'CALL',
    "direction" TEXT NOT NULL DEFAULT 'OUT',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMin" INTEGER,
    "result" "MarketCallResult",
    "spokeWith" TEXT,
    "summary" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketPromise" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "productId" TEXT,
    "kind" "MarketPromiseKind" NOT NULL DEFAULT 'SAMPLE',
    "description" TEXT,
    "qty" INTEGER,
    "promisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "status" "MarketPromiseStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3),
    "carrier" TEXT,
    "trackingNo" TEXT,
    "costUsd" DOUBLE PRECISION,
    "assignedToId" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketPromise_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketFile" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "size" INTEGER,
    "kind" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketTemplate" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'AR',
    "channel" "MarketChannel" NOT NULL DEFAULT 'WHATSAPP',
    "body" TEXT NOT NULL,
    "productId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketCity_governorate_idx" ON "MarketCity"("governorate");

-- CreateIndex
CREATE UNIQUE INDEX "MarketCity_governorate_name_key" ON "MarketCity"("governorate", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MarketProduct_name_key" ON "MarketProduct"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MarketProduct_code_key" ON "MarketProduct"("code");

-- CreateIndex
CREATE UNIQUE INDEX "MarketContact_code_key" ON "MarketContact"("code");

-- CreateIndex
CREATE INDEX "MarketContact_cityId_idx" ON "MarketContact"("cityId");

-- CreateIndex
CREATE INDEX "MarketContact_status_idx" ON "MarketContact"("status");

-- CreateIndex
CREATE INDEX "MarketContact_nextFollowUpAt_idx" ON "MarketContact"("nextFollowUpAt");

-- CreateIndex
CREATE INDEX "MarketContact_assignedToId_idx" ON "MarketContact"("assignedToId");

-- CreateIndex
CREATE INDEX "MarketContact_phoneNorm_idx" ON "MarketContact"("phoneNorm");

-- CreateIndex
CREATE INDEX "MarketInterest_productId_level_idx" ON "MarketInterest"("productId", "level");

-- CreateIndex
CREATE INDEX "MarketInterest_productId_priceOpinion_idx" ON "MarketInterest"("productId", "priceOpinion");

-- CreateIndex
CREATE UNIQUE INDEX "MarketInterest_contactId_productId_key" ON "MarketInterest"("contactId", "productId");

-- CreateIndex
CREATE INDEX "MarketCall_contactId_occurredAt_idx" ON "MarketCall"("contactId", "occurredAt");

-- CreateIndex
CREATE INDEX "MarketCall_createdById_idx" ON "MarketCall"("createdById");

-- CreateIndex
CREATE INDEX "MarketPromise_contactId_idx" ON "MarketPromise"("contactId");

-- CreateIndex
CREATE INDEX "MarketPromise_status_dueAt_idx" ON "MarketPromise"("status", "dueAt");

-- CreateIndex
CREATE INDEX "MarketFile_contactId_idx" ON "MarketFile"("contactId");

-- AddForeignKey
ALTER TABLE "MarketContact" ADD CONSTRAINT "MarketContact_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "MarketCity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketContact" ADD CONSTRAINT "MarketContact_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketContact" ADD CONSTRAINT "MarketContact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInterest" ADD CONSTRAINT "MarketInterest_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MarketContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketInterest" ADD CONSTRAINT "MarketInterest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "MarketProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketCall" ADD CONSTRAINT "MarketCall_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MarketContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPromise" ADD CONSTRAINT "MarketPromise_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MarketContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPromise" ADD CONSTRAINT "MarketPromise_productId_fkey" FOREIGN KEY ("productId") REFERENCES "MarketProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketPromise" ADD CONSTRAINT "MarketPromise_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketFile" ADD CONSTRAINT "MarketFile_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MarketContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketTemplate" ADD CONSTRAINT "MarketTemplate_productId_fkey" FOREIGN KEY ("productId") REFERENCES "MarketProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

