-- DS-02 prelaunch write switch: new requests point at the unified ResearchRun
-- (kind PRELAUNCH). The legacy column stays for the one historical row, so no
-- mapping is deleted.
ALTER TABLE "PrelaunchResearchRequest" ALTER COLUMN "researchRunId" DROP NOT NULL;
ALTER TABLE "PrelaunchResearchRequest" ADD COLUMN "researchRunRef" TEXT;
