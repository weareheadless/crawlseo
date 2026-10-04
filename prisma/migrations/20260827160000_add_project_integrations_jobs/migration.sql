-- Project-scoped tenancy, Google integrations, and durable sync jobs.

CREATE TYPE "WorkspaceStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETING');
CREATE TYPE "GoogleConnectionType" AS ENUM ('SERVICE_ACCOUNT', 'OAUTH', 'PLATFORM_MANAGED');
CREATE TYPE "GoogleConnectionStatus" AS ENUM ('ACTIVE', 'NEEDS_REAUTH', 'REVOKED', 'ERROR');
CREATE TYPE "IntegrationProvider" AS ENUM ('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS');
CREATE TYPE "IntegrationGrantStatus" AS ENUM ('ACTIVE', 'UNVERIFIED', 'ERROR', 'REVOKED');
CREATE TYPE "ServicePrincipalStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "AnalyticsSnapshotSource" AS ENUM ('GA4');
CREATE TYPE "JobKind" AS ENUM ('GSC_SYNC', 'GA4_SYNC', 'CRAWL', 'VITALS_SYNC');
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "SyncSource" AS ENUM ('GSC', 'GA4', 'CRAWL', 'VITALS');
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

ALTER TABLE "Site" ADD COLUMN "projectId" TEXT;
ALTER TABLE "Site" ADD COLUMN "domainVerificationMethod" TEXT;
ALTER TABLE "Site" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "Keyword" ALTER COLUMN "page" SET DEFAULT '';
ALTER TABLE "Keyword" ALTER COLUMN "device" SET DEFAULT '';
ALTER TABLE "Keyword" ALTER COLUMN "country" SET DEFAULT '';
UPDATE "Keyword" SET "page" = '' WHERE "page" IS NULL;
UPDATE "Keyword" SET "device" = '' WHERE "device" IS NULL;
UPDATE "Keyword" SET "country" = '' WHERE "country" IS NULL;
ALTER TABLE "Keyword" ALTER COLUMN "page" SET NOT NULL;
ALTER TABLE "Keyword" ALTER COLUMN "device" SET NOT NULL;
ALTER TABLE "Keyword" ALTER COLUMN "country" SET NOT NULL;
DROP INDEX "Keyword_siteId_query_date_key";
CREATE UNIQUE INDEX "Keyword_siteId_query_date_page_device_country_key"
  ON "Keyword"("siteId", "query", "date", "page", "device", "country");

CREATE TABLE "Workspace" (
  "id" TEXT NOT NULL,
  "externalOrganizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "WorkspaceStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Project" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "externalProjectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GoogleConnection" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "type" "GoogleConnectionType" NOT NULL,
  "status" "GoogleConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  "label" TEXT NOT NULL,
  "encryptedCredentials" TEXT NOT NULL,
  "scopes" JSONB NOT NULL,
  "metadata" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GoogleConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IntegrationGrant" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteId" TEXT,
  "provider" "IntegrationProvider" NOT NULL,
  "externalResourceId" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "status" "IntegrationGrantStatus" NOT NULL DEFAULT 'UNVERIFIED',
  "lastValidatedAt" TIMESTAMP(3),
  "lastSuccessfulAt" TIMESTAMP(3),
  "safeErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IntegrationGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ServicePrincipal" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "ServicePrincipalStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ServicePrincipal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ServiceCredential" (
  "id" TEXT NOT NULL,
  "servicePrincipalId" TEXT NOT NULL,
  "tokenPrefix" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "issuanceIdempotencyKey" TEXT NOT NULL,
  "scopes" JSONB NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "secretDeliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ServiceCredential_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalyticsSnapshot" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "source" "AnalyticsSnapshotSource" NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "data" JSONB NOT NULL,
  "syncRunId" TEXT,
  CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Job" (
  "id" TEXT NOT NULL,
  "projectId" TEXT,
  "siteId" TEXT NOT NULL,
  "kind" "JobKind" NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
  "payload" JSONB NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SyncRun" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "source" "SyncSource" NOT NULL,
  "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "attempt" INTEGER NOT NULL,
  "errorCode" TEXT,
  "errorText" TEXT,
  "metadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Workspace_externalOrganizationId_key"
  ON "Workspace"("externalOrganizationId");
CREATE UNIQUE INDEX "Project_workspaceId_externalProjectId_key"
  ON "Project"("workspaceId", "externalProjectId");
CREATE INDEX "Project_workspaceId_idx" ON "Project"("workspaceId");
CREATE UNIQUE INDEX "Site_projectId_domain_key" ON "Site"("projectId", "domain");
CREATE INDEX "Site_projectId_idx" ON "Site"("projectId");
CREATE UNIQUE INDEX "GoogleConnection_workspaceId_type_label_key"
  ON "GoogleConnection"("workspaceId", "type", "label");
CREATE INDEX "GoogleConnection_workspaceId_status_idx"
  ON "GoogleConnection"("workspaceId", "status");
CREATE UNIQUE INDEX "IntegrationGrant_connectionId_projectId_provider_externalResourceId_key"
  ON "IntegrationGrant"("connectionId", "projectId", "provider", "externalResourceId");
CREATE INDEX "IntegrationGrant_projectId_provider_status_idx"
  ON "IntegrationGrant"("projectId", "provider", "status");
CREATE UNIQUE INDEX "ServicePrincipal_projectId_name_key"
  ON "ServicePrincipal"("projectId", "name");
CREATE UNIQUE INDEX "ServiceCredential_tokenHash_key"
  ON "ServiceCredential"("tokenHash");
CREATE UNIQUE INDEX "ServiceCredential_issuanceIdempotencyKey_key"
  ON "ServiceCredential"("issuanceIdempotencyKey");
CREATE INDEX "ServiceCredential_servicePrincipalId_revokedAt_idx"
  ON "ServiceCredential"("servicePrincipalId", "revokedAt");
CREATE UNIQUE INDEX "AnalyticsSnapshot_siteId_source_periodStart_periodEnd_key"
  ON "AnalyticsSnapshot"("siteId", "source", "periodStart", "periodEnd");
CREATE INDEX "AnalyticsSnapshot_siteId_capturedAt_idx"
  ON "AnalyticsSnapshot"("siteId", "capturedAt");
CREATE UNIQUE INDEX "Job_siteId_kind_idempotencyKey_key"
  ON "Job"("siteId", "kind", "idempotencyKey");
CREATE INDEX "Job_projectId_status_nextAttemptAt_idx"
  ON "Job"("projectId", "status", "nextAttemptAt");
CREATE INDEX "Job_status_nextAttemptAt_idx" ON "Job"("status", "nextAttemptAt");
CREATE UNIQUE INDEX "SyncRun_jobId_attempt_key" ON "SyncRun"("jobId", "attempt");
CREATE INDEX "SyncRun_siteId_source_createdAt_idx"
  ON "SyncRun"("siteId", "source", "createdAt");

ALTER TABLE "Site" ADD CONSTRAINT "Site_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoogleConnection" ADD CONSTRAINT "GoogleConnection_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "GoogleConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IntegrationGrant" ADD CONSTRAINT "IntegrationGrant_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServicePrincipal" ADD CONSTRAINT "ServicePrincipal_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceCredential" ADD CONSTRAINT "ServiceCredential_servicePrincipalId_fkey"
  FOREIGN KEY ("servicePrincipalId") REFERENCES "ServicePrincipal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalyticsSnapshot" ADD CONSTRAINT "AnalyticsSnapshot_syncRunId_fkey"
  FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
