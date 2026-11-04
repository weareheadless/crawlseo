-- Additive: identifies which assessment model produced scoreValue.
-- Existing rows keep the default, so nothing is rewritten and the column is
-- readable before any row is re-scored (expand, then migrate).
ALTER TABLE "Opportunity" ADD COLUMN "assessmentVersion" INTEGER NOT NULL DEFAULT 1;
