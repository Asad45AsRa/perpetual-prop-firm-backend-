-- AlterTable
ALTER TABLE "Plan" ADD COLUMN "grossExposureMultiple" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Order_status_expiresAt_idx" ON "Order"("status", "expiresAt");