-- Which kind of evidence a row's priority rests on, so the board can be ordered by it.
--
-- Why a column and not a read of `scoreInputs.assessment.kind`: the board is ordered by
-- evidence class first and score second, and Postgres cannot order by a JSON field
-- without an expression index. The value is denormalised on purpose and written wherever
-- `scoreValue` is written, which is one place in `computeScore` plus the re-score sweep.
--
-- Default is `hypothesis`, not `estimated`: a row that predates this migration has no
-- class recorded, and calling an unclassified row a projection would be a claim the
-- system cannot support. The backfill below then reads each row's stored assessment and
-- corrects it where the assessment already says something better-founded.

CREATE TYPE "EvidenceClass" AS ENUM ('measured', 'estimated', 'technical', 'hypothesis');

ALTER TABLE "Opportunity" ADD COLUMN "evidenceClass" "EvidenceClass" NOT NULL DEFAULT 'hypothesis';

-- Backfill from the stored assessment, which every scored row already carries. This is a
-- read of a recorded fact, not an inference.
UPDATE "Opportunity"
SET "evidenceClass" = CASE
  WHEN "scoreInputs"->'assessment'->>'kind' = 'measured'   THEN 'measured'::"EvidenceClass"
  WHEN "scoreInputs"->'assessment'->>'kind' = 'estimated'  THEN 'estimated'::"EvidenceClass"
  WHEN "scoreInputs"->'assessment'->>'kind' = 'technical'  THEN 'technical'::"EvidenceClass"
  WHEN "scoreInputs"->'assessment'->>'kind' = 'hypothesis' THEN 'hypothesis'::"EvidenceClass"
  ELSE 'hypothesis'::"EvidenceClass"
END
WHERE "scoreInputs" ? 'assessment';

-- The board reads (project, status, class) then score; this is the index that order wants.
DROP INDEX IF EXISTS "Opportunity_projectId_status_idx";
CREATE INDEX "Opportunity_projectId_status_evidenceClass_idx"
  ON "Opportunity" ("projectId", "status", "evidenceClass");

-- Reported so the migration is auditable rather than silent.
DO $$
DECLARE
  measured_count INT;
  estimated_count INT;
  technical_count INT;
  hypothesis_count INT;
BEGIN
  SELECT COUNT(*) INTO measured_count   FROM "Opportunity" WHERE "evidenceClass" = 'measured';
  SELECT COUNT(*) INTO estimated_count  FROM "Opportunity" WHERE "evidenceClass" = 'estimated';
  SELECT COUNT(*) INTO technical_count  FROM "Opportunity" WHERE "evidenceClass" = 'technical';
  SELECT COUNT(*) INTO hypothesis_count FROM "Opportunity" WHERE "evidenceClass" = 'hypothesis';
  RAISE NOTICE 'evidenceClass backfilled: measured=%, estimated=%, technical=%, hypothesis=%',
    measured_count, estimated_count, technical_count, hypothesis_count;
END $$;

-- The band guard stopped the readiness band claiming technical rows: the same defect
-- with the same inputs goes 23 -> 6. That changes what a score means, so it is an
-- assessment-version change (2 -> 3, in `lib/funnel/scoring.ts`).
--
-- A row carrying an older version is not a priority someone chose; it is a computation
-- against a model that no longer exists. Nothing rewrites them here — a score a person
-- accepted or is working must be re-derived deliberately, not by a migration that runs
-- once at deploy — but they are now identifiable, which they were not before.
--
-- Reported so this is auditable rather than a silent cohort.
DO $$
DECLARE
  stale_count INT;
BEGIN
  SELECT COUNT(*) INTO stale_count FROM "Opportunity" WHERE "assessmentVersion" < 3;
  RAISE NOTICE 'opportunities scored by an older assessment model: %', stale_count;
END $$;
