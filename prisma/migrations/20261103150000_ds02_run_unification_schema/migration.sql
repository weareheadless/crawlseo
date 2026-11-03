-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ResearchRunKind" ADD VALUE 'ARTICLE_KEYWORD';
ALTER TYPE "ResearchRunKind" ADD VALUE 'PRELAUNCH';

-- AlterTable
ALTER TABLE "ResearchRun" ADD COLUMN     "attemptedAt" TIMESTAMP(3),
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "parentRunId" TEXT,
ADD COLUMN     "providerLanguageCode" TEXT,
ADD COLUMN     "providerLocationCode" INTEGER,
ADD COLUMN     "providerTaskId" TEXT,
ADD COLUMN     "seed" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ResearchRun_projectId_kind_idempotencyKey_key" ON "ResearchRun"("projectId", "kind", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchRun_parentRunId_key" ON "ResearchRun"("parentRunId");

