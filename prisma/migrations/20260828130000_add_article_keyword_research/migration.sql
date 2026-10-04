-- Ada's audience-led article research is one independently auditable task,
-- separate from the legacy closed-month five-seed research package.

CREATE TYPE "ArticleKeywordResearchStatus" AS ENUM (
  'REQUESTED',
  'ATTEMPTING',
  'COMPLETED',
  'FAILED',
  'UNCERTAIN'
);

ALTER TYPE "JobKind" ADD VALUE 'ARTICLE_KEYWORD_RESEARCH';

ALTER TABLE "SeoResearchPolicy"
  ADD COLUMN "articleResearchEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "articleTaskLimitPerMonth" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "articleMinIntervalDays" INTEGER NOT NULL DEFAULT 7;

CREATE TABLE "ArticleKeywordResearchRun" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "ideaKey" TEXT NOT NULL,
  "ideaSummary" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "seed" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "country" TEXT NOT NULL,
  "status" "ArticleKeywordResearchStatus" NOT NULL DEFAULT 'REQUESTED',
  "providerTaskId" TEXT,
  "costMicros" INTEGER,
  "result" JSONB,
  "errorCode" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attemptedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ArticleKeywordResearchRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArticleKeywordResearchRun_siteId_idempotencyKey_key"
  ON "ArticleKeywordResearchRun"("siteId", "idempotencyKey");
CREATE INDEX "ArticleKeywordResearchRun_projectId_createdAt_idx"
  ON "ArticleKeywordResearchRun"("projectId", "createdAt");
CREATE INDEX "ArticleKeywordResearchRun_siteId_ideaKey_idx"
  ON "ArticleKeywordResearchRun"("siteId", "ideaKey");
CREATE INDEX "ArticleKeywordResearchRun_siteId_requestedAt_idx"
  ON "ArticleKeywordResearchRun"("siteId", "requestedAt");

ALTER TABLE "ArticleKeywordResearchRun"
  ADD CONSTRAINT "ArticleKeywordResearchRun_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ArticleKeywordResearchRun"
  ADD CONSTRAINT "ArticleKeywordResearchRun_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
