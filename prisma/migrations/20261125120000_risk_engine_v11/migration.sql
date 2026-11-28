-- CreateEnum
CREATE TYPE "AbuseFlagType" AS ENUM ('CROSS_ACCOUNT_HEDGE', 'COPY_TRADING', 'LATENCY_ABUSE');

-- CreateEnum
CREATE TYPE "AbuseFlagStatus" AS ENUM ('OPEN', 'CONFIRMED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "BreachReviewStatus" AS ENUM ('OPEN', 'APPROVED', 'REJECTED');

-- AlterTable: every existing plan row is version 1
ALTER TABLE "Plan" ADD COLUMN "ruleVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "supersedesId" UUID;

-- CreateTable
CREATE TABLE "DailyRiskSnapshot" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "tradingDate" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "startingBalance" DECIMAL(20,8) NOT NULL,
    "dayStartBalance" DECIMAL(20,8) NOT NULL,
    "dayStartEquity" DECIMAL(20,8) NOT NULL,
    "dailyAllowance" DECIMAL(20,8) NOT NULL,
    "dailyFloor" DECIMAL(20,8) NOT NULL,
    "staticFloor" DECIMAL(20,8) NOT NULL,
    "payoutId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyRiskSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AbuseFlag" (
    "id" UUID NOT NULL,
    "type" "AbuseFlagType" NOT NULL,
    "status" "AbuseFlagStatus" NOT NULL DEFAULT 'OPEN',
    "accountId" UUID NOT NULL,
    "relatedAccountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbuseFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreachReview" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "riskEventId" UUID NOT NULL,
    "requestedById" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB,
    "status" "BreachReviewStatus" NOT NULL DEFAULT 'OPEN',
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,

    CONSTRAINT "BreachReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyRiskSnapshot_accountId_createdAt_idx" ON "DailyRiskSnapshot"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DailyRiskSnapshot_accountId_tradingDate_kind_key" ON "DailyRiskSnapshot"("accountId", "tradingDate", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "AbuseFlag_dedupeKey_key" ON "AbuseFlag"("dedupeKey");

-- CreateIndex
CREATE INDEX "AbuseFlag_status_createdAt_idx" ON "AbuseFlag"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AbuseFlag_accountId_idx" ON "AbuseFlag"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "BreachReview_riskEventId_key" ON "BreachReview"("riskEventId");

-- CreateIndex
CREATE INDEX "BreachReview_status_requestedAt_idx" ON "BreachReview"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "BreachReview_accountId_idx" ON "BreachReview"("accountId");

-- AddForeignKey
ALTER TABLE "DailyRiskSnapshot" ADD CONSTRAINT "DailyRiskSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AbuseFlag" ADD CONSTRAINT "AbuseFlag_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreachReview" ADD CONSTRAINT "BreachReview_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;