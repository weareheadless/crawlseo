CREATE TABLE "LegacyBudgetImportReceipt" (
  "id" TEXT NOT NULL,
  "sourceProjectId" TEXT NOT NULL,
  "sourceSiteId" TEXT NOT NULL,
  "targetProjectId" TEXT NOT NULL,
  "targetSiteId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "sourceEvidenceHash" TEXT NOT NULL,
  "reservationIds" JSONB NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LegacyBudgetImportReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LegacyBudgetImportReceipt_sourceProjectId_fkey" FOREIGN KEY ("sourceProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LegacyBudgetImportReceipt_sourceSiteId_fkey" FOREIGN KEY ("sourceSiteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LegacyBudgetImportReceipt_targetProjectId_fkey" FOREIGN KEY ("targetProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LegacyBudgetImportReceipt_targetSiteId_fkey" FOREIGN KEY ("targetSiteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "LegacyBudgetImportReceipt_targetProjectId_idempotencyKey_key"
  ON "LegacyBudgetImportReceipt"("targetProjectId", "idempotencyKey");
CREATE INDEX "LegacyBudgetImportReceipt_sourceProjectId_createdAt_idx"
  ON "LegacyBudgetImportReceipt"("sourceProjectId", "createdAt");

CREATE TABLE "LegacyBudgetSourceFreezeReceipt" (
  "id" TEXT NOT NULL,
  "sourceProjectId" TEXT NOT NULL,
  "sourceSiteId" TEXT NOT NULL,
  "targetProjectId" TEXT NOT NULL,
  "targetSiteId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "sourcePolicyHash" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LegacyBudgetSourceFreezeReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LegacyBudgetSourceFreezeReceipt_sourceProjectId_fkey" FOREIGN KEY ("sourceProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LegacyBudgetSourceFreezeReceipt_sourceSiteId_fkey" FOREIGN KEY ("sourceSiteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LegacyBudgetSourceFreezeReceipt_targetProjectId_fkey" FOREIGN KEY ("targetProjectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "LegacyBudgetSourceFreezeReceipt_targetSiteId_fkey" FOREIGN KEY ("targetSiteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "LegacyBudgetSourceFreezeReceipt_sourceProjectId_idempotencyKey_key"
  ON "LegacyBudgetSourceFreezeReceipt"("sourceProjectId", "idempotencyKey");
CREATE INDEX "LegacyBudgetSourceFreezeReceipt_sourceProjectId_createdAt_idx"
  ON "LegacyBudgetSourceFreezeReceipt"("sourceProjectId", "createdAt");

CREATE FUNCTION reject_legacy_budget_receipt_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Legacy budget receipts are immutable';
END;
$$;
CREATE TRIGGER "LegacyBudgetImportReceipt_immutable"
  BEFORE UPDATE OR DELETE ON "LegacyBudgetImportReceipt"
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_budget_receipt_mutation();
CREATE TRIGGER "LegacyBudgetSourceFreezeReceipt_immutable"
  BEFORE UPDATE OR DELETE ON "LegacyBudgetSourceFreezeReceipt"
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_budget_receipt_mutation();

CREATE UNIQUE INDEX "ResearchBudgetReservation_legacy_source_reservation_unique"
  ON "ResearchBudgetReservation" (("detail"->>'sourceProjectId'), ("detail"->>'localReservationId'))
  WHERE "detail"->>'source' = 'site-agent-legacy-budget-import';
CREATE UNIQUE INDEX "ResearchBudgetReservation_legacy_source_task_unique"
  ON "ResearchBudgetReservation" (("detail"->>'sourceProjectId'), ("detail"->>'sourceTaskId'))
  WHERE "detail"->>'source' = 'site-agent-legacy-budget-import';
