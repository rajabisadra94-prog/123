-- AlterEnum
BEGIN;
CREATE TYPE "MarketChannel_new" AS ENUM ('CALL', 'WHATSAPP', 'TELEGRAM', 'INSTAGRAM', 'EMAIL', 'VISIT', 'OTHER');
ALTER TABLE "MarketCall" ALTER COLUMN "channel" DROP DEFAULT;
ALTER TABLE "MarketTemplate" ALTER COLUMN "channel" DROP DEFAULT;
ALTER TABLE "MarketCall" ALTER COLUMN "channel" TYPE "MarketChannel_new" USING ("channel"::text::"MarketChannel_new");
ALTER TABLE "MarketTemplate" ALTER COLUMN "channel" TYPE "MarketChannel_new" USING ("channel"::text::"MarketChannel_new");
ALTER TYPE "MarketChannel" RENAME TO "MarketChannel_old";
ALTER TYPE "MarketChannel_new" RENAME TO "MarketChannel";
DROP TYPE "MarketChannel_old";
ALTER TABLE "MarketCall" ALTER COLUMN "channel" SET DEFAULT 'CALL';
ALTER TABLE "MarketTemplate" ALTER COLUMN "channel" SET DEFAULT 'WHATSAPP';
COMMIT;

-- CreateTable
CREATE TABLE "MarketTemplateFile" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "size" INTEGER,
    "mime" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketTemplateFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketTemplateFile_templateId_idx" ON "MarketTemplateFile"("templateId");

-- AddForeignKey
ALTER TABLE "MarketTemplateFile" ADD CONSTRAINT "MarketTemplateFile_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MarketTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

