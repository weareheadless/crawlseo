-- CreateEnum
CREATE TYPE "AgentMessageRole" AS ENUM ('HUMAN', 'AGENT', 'SYSTEM');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AgentTaskStatus" ADD VALUE 'AWAITING_REVIEW';
ALTER TYPE "AgentTaskStatus" ADD VALUE 'CHANGES_REQUESTED';
ALTER TYPE "AgentTaskStatus" ADD VALUE 'APPROVED';
ALTER TYPE "AgentTaskStatus" ADD VALUE 'COMMITTED';
ALTER TYPE "AgentTaskStatus" ADD VALUE 'PUBLISHING';
ALTER TYPE "AgentTaskStatus" ADD VALUE 'PUBLISHED';
ALTER TYPE "AgentTaskStatus" ADD VALUE 'CLOSED';

-- AlterTable
ALTER TABLE "AgentTask" ADD COLUMN     "bridgeReceiptId" TEXT,
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "commitSha" TEXT,
ADD COLUMN     "opencodeSessionId" TEXT,
ADD COLUMN     "publishedUrl" TEXT;

-- CreateTable
CREATE TABLE "ResearchPolicy" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cadence" TEXT NOT NULL DEFAULT 'weekly',
    "providers" JSONB,
    "maxSources" INTEGER NOT NULL DEFAULT 30,
    "monthlyBudget" INTEGER NOT NULL DEFAULT 9,
    "autoDraft" BOOLEAN NOT NULL DEFAULT false,
    "autoAgent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteDeliveryConfig" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "bridgeAlias" TEXT NOT NULL,
    "adapters" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteDeliveryConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTaskMessage" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "role" "AgentMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTaskMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTaskArtifact" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTaskArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResearchPolicy_siteId_key" ON "ResearchPolicy"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteDeliveryConfig_siteId_key" ON "SiteDeliveryConfig"("siteId");

-- CreateIndex
CREATE INDEX "AgentTaskMessage_taskId_createdAt_idx" ON "AgentTaskMessage"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTaskArtifact_taskId_kind_idx" ON "AgentTaskArtifact"("taskId", "kind");

-- AddForeignKey
ALTER TABLE "ResearchPolicy" ADD CONSTRAINT "ResearchPolicy_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteDeliveryConfig" ADD CONSTRAINT "SiteDeliveryConfig_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTaskMessage" ADD CONSTRAINT "AgentTaskMessage_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTaskArtifact" ADD CONSTRAINT "AgentTaskArtifact_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AgentTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
