-- Reversing means every mapping must point at a legacy run again. Fail loudly
-- rather than delete the ledger entries.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "PrelaunchResearchRequest" WHERE "researchRunId" IS NULL) THEN
    RAISE EXCEPTION 'cannot restore NOT NULL: mappings point at ResearchRun rows';
  END IF;
END $$;

ALTER TABLE "PrelaunchResearchRequest" DROP COLUMN "researchRunRef";
ALTER TABLE "PrelaunchResearchRequest" ALTER COLUMN "researchRunId" SET NOT NULL;
