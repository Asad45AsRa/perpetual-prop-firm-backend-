-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "ip" TEXT,
ADD COLUMN     "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "userAgent" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatar" TEXT,
ADD COLUMN     "createdByEmail" TEXT,
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "googleSub" TEXT,
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "leaderboardPublic" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "portalsManagedByAdmin" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "signupHandle" TEXT,
ADD COLUMN     "signupPlatform" TEXT,
ADD COLUMN     "tokensValidAfter" TIMESTAMP(3),
ADD COLUMN     "username" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "passwordHash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "LoginCode" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "meta" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoginCode_email_createdAt_idx" ON "LoginCode"("email", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");


-- Data: staff need a display name for the Staff & Permissions page; start from the email's name part.
UPDATE "User" SET "displayName" = split_part("email", '@', 1) WHERE "role" <> 'USER' AND "displayName" IS NULL;
