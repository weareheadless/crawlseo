-- CreateEnum
CREATE TYPE "ResearchRunKind" AS ENUM ('MARKET', 'SEO', 'MIXED');

-- CreateEnum
CREATE TYPE "ResearchTrigger" AS ENUM ('MANUAL', 'SCHEDULED', 'API');

-- CreateEnum
CREATE TYPE "ResearchRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ResearchFindingType" AS ENUM ('THEME', 'QUESTION', 'CONCERN', 'OBJECTION', 'TREND', 'MISCONCEPTION', 'CONTENT_GAP');

-- CreateEnum
CREATE TYPE "ResearchActionStatus" AS ENUM ('PROPOSED', 'APPROVED', 'DISMISSED', 'DRAFTING', 'DRAFT_READY', 'DELIVERY_APPROVED', 'DELIVERING', 'DELIVERED', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "AutomationMode" AS ENUM ('MANUAL', 'ASSISTED', 'AUTOMATIC');

-- AlterTable
ALTER TABLE "ContentDraft" ADD COLUMN     "actionId" TEXT;

-- CreateTable
CREATE TABLE "SiteProfile" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "projectId" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "country" TEXT,
    "audience" JSONB,
    "topics" JSONB,
    "services" JSONB,
    "competitors" JSONB,
    "brandVoice" TEXT,
    "constraints" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchRun" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "projectId" TEXT,
    "kind" "ResearchRunKind" NOT NULL DEFAULT 'MARKET',
    "trigger" "ResearchTrigger" NOT NULL DEFAULT 'MANUAL',
    "status" "ResearchRunStatus" NOT NULL DEFAULT 'QUEUED',
    "title" TEXT NOT NULL,
    "brief" JSONB NOT NULL,
    "topics" JSONB,
    "recencyDays" INTEGER NOT NULL DEFAULT 90,
    "providerSet" JSONB,
    "promptVersion" TEXT NOT NULL DEFAULT 'research-v1',
    "model" TEXT,
    "report" JSONB,
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "findingCount" INTEGER NOT NULL DEFAULT 0,
    "actionCount" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "requestedBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchSource" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "author" TEXT,
    "community" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retrievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "excerpt" TEXT,
    "contentHash" TEXT,
    "language" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchFinding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" "ResearchFindingType" NOT NULL,
    "theme" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 50,
    "sentiment" TEXT,
    "urgency" TEXT,
    "evidenceSourceIds" JSONB,
    "suggestedActionKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchAction" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "runId" TEXT,
    "findingId" TEXT,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "format" TEXT,
    "title" TEXT NOT NULL,
    "primaryQuery" TEXT,
    "targetUrl" TEXT,
    "recommendation" TEXT NOT NULL,
    "evidence" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 50,
    "status" "ResearchActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "automationMode" "AutomationMode" NOT NULL DEFAULT 'MANUAL',
    "dedupeKey" TEXT NOT NULL,
    "owner" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "draftId" TEXT,
    "platform" TEXT NOT NULL,
    "externalId" TEXT,
    "status" TEXT NOT NULL,
    "payload" JSONB,
    "diff" JSONB,
    "errorCode" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteProfile_siteId_key" ON "SiteProfile"("siteId");

-- CreateIndex
CREATE INDEX "SiteProfile_projectId_idx" ON "SiteProfile"("projectId");

-- CreateIndex
CREATE INDEX "ResearchRun_siteId_createdAt_idx" ON "ResearchRun"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchRun_siteId_status_idx" ON "ResearchRun"("siteId", "status");

-- CreateIndex
CREATE INDEX "ResearchRun_projectId_createdAt_idx" ON "ResearchRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchSource_runId_provider_idx" ON "ResearchSource"("runId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchSource_runId_contentHash_key" ON "ResearchSource"("runId", "contentHash");

-- CreateIndex
CREATE INDEX "ResearchFinding_runId_type_idx" ON "ResearchFinding"("runId", "type");

-- CreateIndex
CREATE INDEX "ResearchAction_siteId_status_priority_idx" ON "ResearchAction"("siteId", "status", "priority");

-- CreateIndex
CREATE INDEX "ResearchAction_siteId_createdAt_idx" ON "ResearchAction"("siteId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchAction_siteId_dedupeKey_key" ON "ResearchAction"("siteId", "dedupeKey");

-- CreateIndex
CREATE INDEX "Delivery_actionId_createdAt_idx" ON "Delivery"("actionId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentDraft_actionId_idx" ON "ContentDraft"("actionId");

-- AddForeignKey
ALTER TABLE "ContentDraft" ADD CONSTRAINT "ContentDraft_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "ResearchAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteProfile" ADD CONSTRAINT "SiteProfile_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteProfile" ADD CONSTRAINT "SiteProfile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchRun" ADD CONSTRAINT "ResearchRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchFinding" ADD CONSTRAINT "ResearchFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchAction" ADD CONSTRAINT "ResearchAction_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchAction" ADD CONSTRAINT "ResearchAction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ResearchRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchAction" ADD CONSTRAINT "ResearchAction_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "ResearchFinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "ResearchAction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ContentDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
