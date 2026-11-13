-- CreateEnum
CREATE TYPE "Portal" AS ENUM ('TRADER', 'AFFILIATE');

-- CreateEnum
CREATE TYPE "AccessLevel" AS ENUM ('VIEW', 'MANAGE');

-- AlterTable
ALTER TABLE "StaffPermission" ADD COLUMN     "level" "AccessLevel" NOT NULL DEFAULT 'VIEW';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "portals" "Portal"[] DEFAULT ARRAY['TRADER']::"Portal"[];

-- CreateTable
CREATE TABLE "StaffRight" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "right" TEXT NOT NULL,

    CONSTRAINT "StaffRight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffRight_userId_right_key" ON "StaffRight"("userId", "right");

-- AddForeignKey
ALTER TABLE "StaffRight" ADD CONSTRAINT "StaffRight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------
-- Data migration (hand-written): carry existing access over to the new model.
-- ---------------------------------------------------------------------

-- Staff are not customers: no trader/affiliate portals.
UPDATE "User" SET "portals" = ARRAY[]::"Portal"[] WHERE "role" <> 'USER';

-- Customers who already earned commissions keep their affiliate dashboard.
UPDATE "User" u SET "portals" = array_append(u."portals", 'AFFILIATE')
WHERE u."role" = 'USER'
  AND NOT ('AFFILIATE' = ANY(u."portals"))
  AND EXISTS (SELECT 1 FROM "Commission" c WHERE c."affiliateUserId" = u."id");

-- Old section keys -> frontend page keys. Old grants meant full access, so they become MANAGE.
UPDATE "StaffPermission" SET "section" = CASE "section"
  WHEN 'users' THEN 'traders'
  WHEN 'orders' THEN 'activity'
  WHEN 'content' THEN 'cms'
  WHEN 'email' THEN 'emails'
  WHEN 'audit' THEN 'audit-logs'
  WHEN 'system-health' THEN 'health'
  ELSE "section" END,
  "level" = 'MANAGE';

-- "staff" can never be granted (super admin only).
DELETE FROM "StaffPermission" WHERE "section" = 'staff';

-- Old full-section access also covered these sensitive actions; keep them as explicit rights.
INSERT INTO "StaffRight" ("id", "userId", "right")
SELECT gen_random_uuid(), p."userId", r."right"
FROM "StaffPermission" p
JOIN (VALUES
  ('traders', 'traders.suspend'),
  ('payouts', 'payout.approve'),
  ('affiliates', 'payout.approve'),
  ('markets', 'market.sync'),
  ('accounts', 'account.override'),
  ('settings', 'settings.edit')
) AS r("section", "right") ON r."section" = p."section"
ON CONFLICT ("userId", "right") DO NOTHING;
