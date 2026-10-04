-- Ada-triggered, strictly bounded SEO research runs and project DataForSEO grants.

CREATE TYPE "ProjectApiKeyGrantStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');
CREATE TYPE "SeoResearchRunStatus" AS ENUM (
  'REQUESTED',
  'WAITING_FOR_SOURCES',
  'RUNNING_PAID_RESEARCH',
  'COMPLETED',
  'PARTIAL',
  'FAILED'
);
CREATE TYPE "SeoResearchTaskKind" AS ENUM (
  'DOMAIN_OVERVIEW',
  'BACKLINKS_OVERVIEW',
  'KEYWORD_SEED'
);
CREATE TYPE "SeoResearchTaskStatus" AS ENUM (
  'RESERVED',
  'ATTEMPTING',
  'COMPLETED',
  'FAILED',
  'UNCERTAIN'
);

ALTER TYPE "SyncSource" ADD VALUE 'DATAFORSEO';
ALTER TYPE "JobKind" ADD VALUE 'SEO_RESEARCH';

CREATE TABLE "ProjectApiKeyGrant" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "apiKeyId" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'dataforseo',
  "status" "ProjectApiKeyGrantStatus" NOT NULL DEFAULT 'ACTIVE',
  "lastValidatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectApiKeyGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SeoResearchPolicy" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "monthlyTaskLimit" INTEGER NOT NULL DEFAULT 9,
  "keywordSeedLimit" INTEGER NOT NULL DEFAULT 5,
  "competitorLimit" INTEGER NOT NULL DEFAULT 1,
  "packageVersion" TEXT NOT NULL DEFAULT 'standard-v1',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SeoResearchPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SeoResearchRun" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "brief" JSONB NOT NULL,
  "briefHash" TEXT NOT NULL,
  "packageVersion" TEXT NOT NULL,
  "reportSchemaVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "SeoResearchRunStatus" NOT NULL DEFAULT 'REQUESTED',
  "taskLimit" INTEGER NOT NULL,
  "taskCount" INTEGER NOT NULL DEFAULT 0,
  "attemptedCount" INTEGER NOT NULL DEFAULT 0,
  "actualCostMicros" INTEGER NOT NULL DEFAULT 0,
  "report" JSONB,
  "sourceManifest" JSONB,
  "errorCode" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SeoResearchRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SeoResearchTask" (
  "id" TEXT NOT NULL,
  "researchRunId" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "kind" "SeoResearchTaskKind" NOT NULL,
  "ordinal" INTEGER,
  "input" JSONB NOT NULL,
  "requestHash" TEXT NOT NULL,
  "status" "SeoResearchTaskStatus" NOT NULL DEFAULT 'RESERVED',
  "providerTaskId" TEXT,
  "costMicros" INTEGER,
  "result" JSONB,
  "errorCode" TEXT,
  "attemptedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SeoResearchTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectApiKeyGrant_projectId_provider_key"
  ON "ProjectApiKeyGrant"("projectId", "provider");
CREATE INDEX "ProjectApiKeyGrant_apiKeyId_status_idx"
  ON "ProjectApiKeyGrant"("apiKeyId", "status");
CREATE UNIQUE INDEX "SeoResearchPolicy_siteId_key"
  ON "SeoResearchPolicy"("siteId");
CREATE INDEX "SeoResearchPolicy_projectId_enabled_idx"
  ON "SeoResearchPolicy"("projectId", "enabled");
CREATE UNIQUE INDEX "SeoResearchRun_siteId_periodStart_packageVersion_key"
  ON "SeoResearchRun"("siteId", "periodStart", "packageVersion");
CREATE UNIQUE INDEX "SeoResearchRun_siteId_idempotencyKey_key"
  ON "SeoResearchRun"("siteId", "idempotencyKey");
CREATE INDEX "SeoResearchRun_projectId_status_periodStart_idx"
  ON "SeoResearchRun"("projectId", "status", "periodStart");
CREATE UNIQUE INDEX "SeoResearchTask_researchRunId_operationKey_key"
  ON "SeoResearchTask"("researchRunId", "operationKey");
CREATE INDEX "SeoResearchTask_researchRunId_status_idx"
  ON "SeoResearchTask"("researchRunId", "status");

-- Existing provisioned projects should receive the same explicit boundaries as
-- newly provisioned projects without requiring a manual backfill step.
INSERT INTO "SeoResearchPolicy" ("id", "projectId", "siteId", "updatedAt")
SELECT md5('seo-policy:' || site."id"), site."projectId", site."id", CURRENT_TIMESTAMP
FROM "Site" AS site
WHERE site."projectId" IS NOT NULL
ON CONFLICT ("siteId") DO NOTHING;

INSERT INTO "ProjectApiKeyGrant" ("id", "projectId", "apiKeyId", "provider", "status", "updatedAt")
SELECT DISTINCT md5('dataforseo-grant:' || site."projectId"), site."projectId", api."id", 'dataforseo', 'ACTIVE'::"ProjectApiKeyGrantStatus", CURRENT_TIMESTAMP
FROM "Site" AS site
JOIN "ApiKey" AS api ON api."userId" = site."userId" AND api."provider" = 'dataforseo'
WHERE site."projectId" IS NOT NULL
ON CONFLICT ("projectId", "provider") DO NOTHING;

ALTER TABLE "ProjectApiKeyGrant" ADD CONSTRAINT "ProjectApiKeyGrant_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectApiKeyGrant" ADD CONSTRAINT "ProjectApiKeyGrant_apiKeyId_fkey"
  FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeoResearchPolicy" ADD CONSTRAINT "SeoResearchPolicy_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeoResearchPolicy" ADD CONSTRAINT "SeoResearchPolicy_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeoResearchRun" ADD CONSTRAINT "SeoResearchRun_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeoResearchRun" ADD CONSTRAINT "SeoResearchRun_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeoResearchTask" ADD CONSTRAINT "SeoResearchTask_researchRunId_fkey"
  FOREIGN KEY ("researchRunId") REFERENCES "SeoResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
