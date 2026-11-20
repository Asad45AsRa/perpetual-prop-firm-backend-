-- Trading engine upgrade: order book fills, maker/taker fees, cross margin, one-way / hedge mode,
-- limit / stop / TP / SL orders, reserved margin and hourly funding.

-- CreateEnum
CREATE TYPE "TimeInForce" AS ENUM ('GTC', 'IOC');

-- CreateEnum
CREATE TYPE "PositionMode" AS ENUM ('ONE_WAY', 'HEDGE');

-- CreateEnum
CREATE TYPE "MarketType" AS ENUM ('CRYPTO', 'EQUITY', 'COMMODITY', 'INDEX', 'FX');

-- CreateEnum
CREATE TYPE "Liquidity" AS ENUM ('MAKER', 'TAKER');

-- AlterEnum
ALTER TYPE "OrderType" ADD VALUE 'STOP_MARKET';
ALTER TYPE "OrderType" ADD VALUE 'TAKE_PROFIT';
ALTER TYPE "OrderType" ADD VALUE 'STOP_LOSS';

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'PARTIALLY_FILLED';

-- AlterTable
ALTER TABLE "TradingAccount" ADD COLUMN "positionMode" "PositionMode" NOT NULL DEFAULT 'ONE_WAY';

-- AlterTable (Market). New NOT NULL columns without a constant default are added nullable,
-- back filled from existing rows, and then made NOT NULL.
ALTER TABLE "Market"
  ADD COLUMN "hlKey" TEXT,
  ADD COLUMN "marketType" "MarketType" NOT NULL DEFAULT 'CRYPTO',
  ADD COLUMN "priceTick" DECIMAL(28,10) NOT NULL DEFAULT 0,
  ADD COLUMN "sizeStep" DECIMAL(28,10) NOT NULL DEFAULT 0,
  ADD COLUMN "minNotionalUsd" DECIMAL(20,8) NOT NULL DEFAULT 10,
  ADD COLUMN "maxNotionalUsd" DECIMAL(20,8),
  ADD COLUMN "makerFeeRate" DECIMAL(12,8),
  ADD COLUMN "takerFeeRate" DECIMAL(12,8),
  ADD COLUMN "requireMarkConfirm" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "fundingSupported" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "riskTierVersion" TEXT NOT NULL DEFAULT 'v1',
  ADD COLUMN "isCloseOnly" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "delistedAt" TIMESTAMP(3);

UPDATE "Market"
SET "hlKey" = "symbol",
    "sizeStep" = "minSize",
    "priceTick" = power(10, -"pricePrecision")::DECIMAL(28,10);

ALTER TABLE "Market" ALTER COLUMN "hlKey" SET NOT NULL;

-- AlterTable (Order)
ALTER TABLE "Order"
  ADD COLUMN "positionSide" "PositionSide",
  ADD COLUMN "timeInForce" "TimeInForce" NOT NULL DEFAULT 'GTC',
  ADD COLUMN "postOnly" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "triggerPrice" DECIMAL(28,10),
  ADD COLUMN "closePosition" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "triggeredAt" TIMESTAMP(3),
  ADD COLUMN "maxSlippagePct" DECIMAL(10,4),
  ADD COLUMN "reservedMargin" DECIMAL(20,8) NOT NULL DEFAULT 0,
  ADD COLUMN "cancelReason" TEXT;

-- AlterTable (Fill)
ALTER TABLE "Fill"
  ADD COLUMN "liquidity" "Liquidity" NOT NULL DEFAULT 'TAKER',
  ADD COLUMN "feeRate" DECIMAL(12,8) NOT NULL DEFAULT 0,
  ADD COLUMN "positionSide" "PositionSide",
  ADD COLUMN "bookLevels" JSONB,
  ADD COLUMN "bookTime" TIMESTAMP(3),
  ADD COLUMN "rulesVersion" TEXT;

-- CreateTable
CREATE TABLE "FundingRate" (
    "id" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "hourStart" TIMESTAMP(3) NOT NULL,
    "rate" DECIMAL(20,12) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'hyperliquid',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingPayment" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "hourStart" TIMESTAMP(3) NOT NULL,
    "side" "PositionSide" NOT NULL,
    "size" DECIMAL(28,10) NOT NULL,
    "oraclePrice" DECIMAL(28,10),
    "rate" DECIMAL(20,12),
    "amount" DECIMAL(20,8),
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Market_hlKey_key" ON "Market"("hlKey");

-- CreateIndex
CREATE INDEX "Order_marketId_status_idx" ON "Order"("marketId", "status");

-- CreateIndex
CREATE INDEX "Order_accountId_status_idx" ON "Order"("accountId", "status");

-- Position uniqueness now includes the side (hedge mode keeps a long and a short row per market)
DROP INDEX "Position_accountId_marketId_key";

-- CreateIndex
CREATE UNIQUE INDEX "Position_accountId_marketId_side_key" ON "Position"("accountId", "marketId", "side");

-- CreateIndex
CREATE INDEX "Position_marketId_status_idx" ON "Position"("marketId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FundingRate_marketId_hourStart_key" ON "FundingRate"("marketId", "hourStart");

-- CreateIndex
CREATE UNIQUE INDEX "FundingPayment_positionId_hourStart_key" ON "FundingPayment"("positionId", "hourStart");

-- CreateIndex
CREATE INDEX "FundingPayment_appliedAt_idx" ON "FundingPayment"("appliedAt");

-- CreateIndex
CREATE INDEX "FundingPayment_accountId_hourStart_idx" ON "FundingPayment"("accountId", "hourStart");

-- AddForeignKey
ALTER TABLE "FundingRate" ADD CONSTRAINT "FundingRate_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingPayment" ADD CONSTRAINT "FundingPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingPayment" ADD CONSTRAINT "FundingPayment_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
