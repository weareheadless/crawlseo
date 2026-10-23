-- Durable, reviewable drafts produced by the Content Studio.
-- Drafts are never published by this module; provider delivery is a separate step.

CREATE TYPE "ContentDraftStatus" AS ENUM ('READY', 'ARCHIVED');

CREATE TABLE "ContentDraft" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "opportunityKey" TEXT NOT NULL,
    "actionKind" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "primaryQuery" TEXT NOT NULL DEFAULT '',
    "targetUrl" TEXT,
    "intent" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "metaTitle" TEXT NOT NULL,
    "metaDescription" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "markdown" TEXT NOT NULL,
    "outline" JSONB,
    "brief" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "ContentDraftStatus" NOT NULL DEFAULT 'READY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContentDraft_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContentDraft_siteId_createdAt_idx" ON "ContentDraft"("siteId", "createdAt");
CREATE INDEX "ContentDraft_siteId_opportunityKey_idx" ON "ContentDraft"("siteId", "opportunityKey");
CREATE INDEX "ContentDraft_siteId_status_idx" ON "ContentDraft"("siteId", "status");

ALTER TABLE "ContentDraft"
  ADD CONSTRAINT "ContentDraft_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
