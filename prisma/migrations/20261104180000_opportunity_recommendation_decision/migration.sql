-- Additive: the complete validated recommendation decision and its provenance.
ALTER TABLE "Opportunity"
  ADD COLUMN "recommendationDecision" JSONB,
  ADD COLUMN "recommendationVersion" TEXT,
  ADD COLUMN "recommendationFingerprint" TEXT,
  ADD COLUMN "recommendationEvidenceId" TEXT;
CREATE INDEX "Opportunity_projectId_recommendationFingerprint_idx"
  ON "Opportunity"("projectId", "recommendationFingerprint");
