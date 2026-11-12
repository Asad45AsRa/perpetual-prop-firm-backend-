-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN');

-- CreateEnum
CREATE TYPE "EmailTokenType" AS ENUM ('VERIFY_EMAIL', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "AccountStage" AS ENUM ('CHALLENGE', 'FUNDED');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'PASSED', 'BREACHED', 'DISABLED');

-- CreateEnum
CREATE TYPE "DailyLossMethod" AS ENUM ('BALANCE_BASED', 'EQUITY_BASED');

-- CreateEnum
CREATE TYPE "DrawdownType" AS ENUM ('STATIC', 'TRAILING');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'FILLED', 'CANCELED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PositionSide" AS ENUM ('LONG', 'SHORT');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "LedgerType" AS ENUM ('DEPOSIT', 'REALIZED_PNL', 'FEE', 'FUNDING', 'PAYOUT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "RiskEventType" AS ENUM ('DAILY_LOSS_BREACH', 'MAX_DRAWDOWN_BREACH', 'PROFIT_TARGET_REACHED', 'LIQUIDATION', 'STALE_PRICE_BLOCK', 'MANUAL_LOCK');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'SENT', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'REJECTED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isProtected" BOOLEAN NOT NULL DEFAULT false,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
    "mfaSecret" TEXT,
    "referralCode" TEXT NOT NULL,
    "referredById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPermission" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "section" TEXT NOT NULL,

    CONSTRAINT "StaffPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "EmailTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "mfaVerified" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "accountSize" DECIMAL(20,8) NOT NULL,
    "price" DECIMAL(20,8) NOT NULL,
    "profitTargetPct" DECIMAL(10,4) NOT NULL,
    "dailyLossPct" DECIMAL(10,4) NOT NULL,
    "maxDrawdownPct" DECIMAL(10,4) NOT NULL,
    "maxLeverage" INTEGER NOT NULL DEFAULT 20,
    "minTradingDays" INTEGER NOT NULL DEFAULT 0,
    "dailyLossMethod" "DailyLossMethod" NOT NULL DEFAULT 'BALANCE_BASED',
    "drawdownType" "DrawdownType" NOT NULL DEFAULT 'STATIC',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "plisioTxnId" TEXT,
    "plisioInvoiceUrl" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "purchaseId" UUID,
    "sourceAccountId" UUID,
    "stage" "AccountStage" NOT NULL DEFAULT 'CHALLENGE',
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "startingBalance" DECIMAL(20,8) NOT NULL,
    "balance" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "highWaterMark" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "dayStartEquity" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "dayStartBalance" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "lastDailyResetAt" TIMESTAMP(3),
    "statusReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Market" (
    "id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "baseAsset" TEXT NOT NULL,
    "szDecimals" INTEGER NOT NULL,
    "pricePrecision" INTEGER NOT NULL,
    "minSize" DECIMAL(28,10) NOT NULL,
    "maxLeverage" INTEGER NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isHalted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "clientOrderId" TEXT,
    "side" "OrderSide" NOT NULL,
    "type" "OrderType" NOT NULL DEFAULT 'MARKET',
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "size" DECIMAL(28,10) NOT NULL,
    "limitPrice" DECIMAL(28,10),
    "filledSize" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "avgFillPrice" DECIMAL(28,10),
    "leverage" INTEGER NOT NULL,
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fill" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "side" "OrderSide" NOT NULL,
    "price" DECIMAL(28,10) NOT NULL,
    "size" DECIMAL(28,10) NOT NULL,
    "fee" DECIMAL(20,8) NOT NULL,
    "realizedPnl" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Fill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "marketId" UUID NOT NULL,
    "side" "PositionSide" NOT NULL,
    "size" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "entryPrice" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "markPrice" DECIMAL(28,10) NOT NULL DEFAULT 0,
    "leverage" INTEGER NOT NULL DEFAULT 1,
    "margin" DECIMAL(20,8) NOT NULL DEFAULT 0,
    "liquidationPrice" DECIMAL(28,10),
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "type" "LedgerType" NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "balanceAfter" DECIMAL(20,8) NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "idempotencyKey" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskEvent" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "type" "RiskEventType" NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "asset" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'REQUESTED',
    "txHash" TEXT,
    "explorerUrl" TEXT,
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Commission" (
    "id" UUID NOT NULL,
    "affiliateUserId" UUID NOT NULL,
    "purchaseId" UUID NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentBlock" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT,
    "data" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "StaffPermission_userId_section_key" ON "StaffPermission"("userId", "section");

-- CreateIndex
CREATE UNIQUE INDEX "EmailToken_tokenHash_key" ON "EmailToken"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailToken_userId_type_idx" ON "EmailToken"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_plisioTxnId_key" ON "Purchase"("plisioTxnId");

-- CreateIndex
CREATE INDEX "Purchase_userId_idx" ON "Purchase"("userId");

-- CreateIndex
CREATE INDEX "Purchase_status_createdAt_idx" ON "Purchase"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradingAccount_purchaseId_key" ON "TradingAccount"("purchaseId");

-- CreateIndex
CREATE INDEX "TradingAccount_userId_idx" ON "TradingAccount"("userId");

-- CreateIndex
CREATE INDEX "TradingAccount_status_idx" ON "TradingAccount"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Market_symbol_key" ON "Market"("symbol");

-- CreateIndex
CREATE INDEX "Order_accountId_createdAt_idx" ON "Order"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_accountId_clientOrderId_key" ON "Order"("accountId", "clientOrderId");

-- CreateIndex
CREATE INDEX "Fill_accountId_createdAt_idx" ON "Fill"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "Position_status_idx" ON "Position"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Position_accountId_marketId_key" ON "Position"("accountId", "marketId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_createdAt_idx" ON "LedgerEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskEvent_accountId_createdAt_idx" ON "RiskEvent"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "RiskEvent_type_idx" ON "RiskEvent"("type");

-- CreateIndex
CREATE INDEX "Payout_status_createdAt_idx" ON "Payout"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Payout_userId_idx" ON "Payout"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Commission_purchaseId_key" ON "Commission"("purchaseId");

-- CreateIndex
CREATE INDEX "Commission_affiliateUserId_idx" ON "Commission"("affiliateUserId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentBlock_key_key" ON "ContentBlock"("key");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPermission" ADD CONSTRAINT "StaffPermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailToken" ADD CONSTRAINT "EmailToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingAccount" ADD CONSTRAINT "TradingAccount_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_marketId_fkey" FOREIGN KEY ("marketId") REFERENCES "Market"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskEvent" ADD CONSTRAINT "RiskEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_affiliateUserId_fkey" FOREIGN KEY ("affiliateUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
