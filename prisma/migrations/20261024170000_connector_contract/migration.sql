CREATE TYPE "PreparationStatus" AS ENUM ('NONE', 'ELIGIBLE', 'QUEUED', 'READY', 'BLOCKED', 'CANCELLED');

ALTER TABLE "ResearchAction"
  ADD COLUMN "projectId" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "priorityRationale" TEXT,
  ADD COLUMN "requiredCapabilities" JSONB,
  ADD COLUMN "acceptanceCriteria" JSONB,
  ADD COLUMN "dependencies" JSONB,
  ADD COLUMN "reassessmentConditions" JSONB,
  ADD COLUMN "preparationStatus" "PreparationStatus" NOT NULL DEFAULT 'NONE';

UPDATE "ResearchAction" AS action
SET "projectId" = site."projectId"
FROM "Site" AS site
WHERE action."siteId" = site.id AND site."projectId" IS NOT NULL;

ALTER TABLE "ResearchAction" ADD CONSTRAINT "ResearchAction_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ResearchAction_projectId_status_priority_idx"
  ON "ResearchAction"("projectId", status, priority);

CREATE TYPE "ConnectorBindingStatus" AS ENUM ('ACTIVE', 'PAUSED', 'TRANSFERRING');
CREATE TABLE "ConnectorBinding" (
  id TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  executor TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  status "ConnectorBindingStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectorBinding_pkey" PRIMARY KEY (id),
  CONSTRAINT "ConnectorBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConnectorBinding_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConnectorBinding_siteId_key" ON "ConnectorBinding"("siteId");
CREATE INDEX "ConnectorBinding_projectId_status_idx" ON "ConnectorBinding"("projectId", status);

CREATE TABLE "ConnectorBindingTransfer" (
  id TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "fromExecutor" TEXT NOT NULL,
  "toExecutor" TEXT NOT NULL,
  "fromGeneration" INTEGER NOT NULL,
  "toGeneration" INTEGER NOT NULL,
  reason TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorBindingTransfer_pkey" PRIMARY KEY (id),
  CONSTRAINT "ConnectorBindingTransfer_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConnectorBindingTransfer_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConnectorBindingTransfer_projectId_idempotencyKey_key"
  ON "ConnectorBindingTransfer"("projectId", "idempotencyKey");
CREATE INDEX "ConnectorBindingTransfer_projectId_siteId_createdAt_idx"
  ON "ConnectorBindingTransfer"("projectId", "siteId", "createdAt");

CREATE TABLE "ConnectorContextSnapshot" (
  id TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  revision TEXT NOT NULL,
  "websiteInventory" JSONB NOT NULL,
  "businessFacts" JSONB NOT NULL,
  capabilities JSONB NOT NULL,
  "canonicalOrigin" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorContextSnapshot_pkey" PRIMARY KEY (id),
  CONSTRAINT "ConnectorContextSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConnectorContextSnapshot_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConnectorContextSnapshot_siteId_key" ON "ConnectorContextSnapshot"("siteId");
CREATE INDEX "ConnectorContextSnapshot_projectId_idx" ON "ConnectorContextSnapshot"("projectId");

CREATE TABLE "ConnectorEventCounter" (
  "projectId" TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ConnectorEventCounter_pkey" PRIMARY KEY ("projectId"),
  CONSTRAINT "ConnectorEventCounter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ConnectorEvent" (
  id TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  "actionId" TEXT,
  "actionRevision" INTEGER,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt" TIMESTAMP(3),
  attempts INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorEvent_pkey" PRIMARY KEY (id),
  CONSTRAINT "ConnectorEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConnectorEvent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConnectorEvent_projectId_sequence_key" ON "ConnectorEvent"("projectId", sequence);
CREATE INDEX "ConnectorEvent_projectId_acknowledgedAt_sequence_idx" ON "ConnectorEvent"("projectId", "acknowledgedAt", sequence);
CREATE INDEX "ConnectorEvent_siteId_actionId_actionRevision_idx" ON "ConnectorEvent"("siteId", "actionId", "actionRevision");

-- Make pre-connector Actions visible through the same at-least-once event path
-- as newly created Actions. The event payload is a locator; consumers fetch
-- the current versioned Action before applying any local effect.
WITH grouped AS (
  SELECT "projectId", COUNT(*)::INTEGER AS event_count
  FROM "ResearchAction"
  WHERE "projectId" IS NOT NULL
  GROUP BY "projectId"
), allocated AS (
  INSERT INTO "ConnectorEventCounter" ("projectId", sequence)
  SELECT "projectId", event_count FROM grouped
  ON CONFLICT ("projectId") DO UPDATE
    SET sequence = "ConnectorEventCounter".sequence + EXCLUDED.sequence
  RETURNING "projectId", sequence
), ranked AS (
  SELECT action."projectId", action."siteId", action.id, action."revision",
         action.status, action.priority,
         ROW_NUMBER() OVER (PARTITION BY action."projectId" ORDER BY action."createdAt", action.id)::INTEGER AS row_num
  FROM "ResearchAction" AS action
  WHERE action."projectId" IS NOT NULL
)
INSERT INTO "ConnectorEvent" (
  id, "projectId", "siteId", sequence, "actionId", "actionRevision", type, payload,
  "occurredAt", "nextAttemptAt", "createdAt"
)
SELECT MD5('connector-action-backfill-v1:' || ranked."projectId" || ':' || ranked.id),
       ranked."projectId", ranked."siteId", allocated.sequence - grouped.event_count + ranked.row_num,
       ranked.id, ranked."revision", 'action.created',
       JSONB_BUILD_OBJECT('actionId', ranked.id, 'revision', ranked."revision",
         'status', LOWER(ranked.status::TEXT), 'priority', ranked.priority),
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM ranked
JOIN grouped USING ("projectId")
JOIN allocated USING ("projectId");

CREATE TABLE "ConnectorOperationReceipt" (
  id TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "actionId" TEXT NOT NULL,
  "actionRevision" INTEGER NOT NULL,
  operation TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  result JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorOperationReceipt_pkey" PRIMARY KEY (id),
  CONSTRAINT "ConnectorOperationReceipt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConnectorOperationReceipt_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConnectorOperationReceipt_projectId_operation_idempotencyKey_key"
  ON "ConnectorOperationReceipt"("projectId", operation, "idempotencyKey");
CREATE INDEX "ConnectorOperationReceipt_projectId_actionId_actionRevision_idx"
  ON "ConnectorOperationReceipt"("projectId", "actionId", "actionRevision");

CREATE TABLE "ConnectorExecutionState" (
  id TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "actionId" TEXT NOT NULL,
  "actionRevision" INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  "candidateRef" TEXT,
  "reviewUrl" TEXT,
  "ownerDecision" TEXT,
  "publicationReceipt" JSONB,
  "verifiedAt" TIMESTAMP(3),
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectorExecutionState_pkey" PRIMARY KEY (id),
  CONSTRAINT "ConnectorExecutionState_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ConnectorExecutionState_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ConnectorExecutionState_actionId_actionRevision_key"
  ON "ConnectorExecutionState"("actionId", "actionRevision");
CREATE INDEX "ConnectorExecutionState_projectId_siteId_observedAt_idx"
  ON "ConnectorExecutionState"("projectId", "siteId", "observedAt");

ALTER TABLE "Project"
  ADD COLUMN "monthlyResearchAllowanceMicros" BIGINT,
  ADD COLUMN "maxResearchOperationMicros" BIGINT,
  ADD COLUMN "researchBudgetCurrency" TEXT NOT NULL DEFAULT 'USD',
  ADD COLUMN "researchBudgetTimeZone" TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN "researchBudgetRevision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "ResearchPolicy" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ResearchPolicy" ADD COLUMN "goals" JSONB;
ALTER TABLE "ResearchPolicy" ADD COLUMN "exclusions" JSONB;
ALTER TABLE "ResearchPolicy" ADD COLUMN "recencyDays" INTEGER NOT NULL DEFAULT 90;

CREATE TYPE "ResearchBudgetReservationStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED', 'UNCERTAIN');
CREATE TABLE "ResearchBudgetReservation" (
  id TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  period TEXT NOT NULL,
  "timeZone" TEXT NOT NULL,
  "policyRevision" INTEGER NOT NULL,
  "amountMicros" BIGINT NOT NULL CHECK ("amountMicros" >= 0),
  "actualCostMicros" BIGINT CHECK ("actualCostMicros" IS NULL OR "actualCostMicros" >= 0),
  currency TEXT NOT NULL,
  operation TEXT NOT NULL,
  status "ResearchBudgetReservationStatus" NOT NULL DEFAULT 'RESERVED',
  "providerTaskId" TEXT,
  detail JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "ResearchBudgetReservation_pkey" PRIMARY KEY (id),
  CONSTRAINT "ResearchBudgetReservation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ResearchBudgetReservation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"(id) ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ResearchBudgetReservation_projectId_idempotencyKey_key"
  ON "ResearchBudgetReservation"("projectId", "idempotencyKey");
CREATE INDEX "ResearchBudgetReservation_projectId_period_status_idx"
  ON "ResearchBudgetReservation"("projectId", period, status);
CREATE INDEX "ResearchBudgetReservation_siteId_createdAt_idx"
  ON "ResearchBudgetReservation"("siteId", "createdAt");

ALTER TABLE "AgentTask"
  ADD COLUMN "actionRevision" INTEGER,
  ADD COLUMN "connectorGeneration" INTEGER;
CREATE UNIQUE INDEX "AgentTask_actionId_actionRevision_key"
  ON "AgentTask"("actionId", "actionRevision");
