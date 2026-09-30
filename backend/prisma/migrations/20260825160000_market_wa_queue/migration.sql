-- CreateEnum
CREATE TYPE "MarketWaJobStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "MarketWaJob" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "imageUrl" TEXT,
    "imageName" TEXT,
    "status" "MarketWaJobStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "MarketWaJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketWaJob_status_createdAt_idx" ON "MarketWaJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketWaJob_contactId_idx" ON "MarketWaJob"("contactId");

-- AddForeignKey
ALTER TABLE "MarketWaJob" ADD CONSTRAINT "MarketWaJob_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "MarketContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

