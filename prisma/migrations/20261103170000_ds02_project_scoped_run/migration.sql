-- DS-02 prelaunch cutover: the prelaunch research family is project-scoped (no
-- site), so the unified run table has to accept a run without one. Additive and
-- reversible; nothing is dropped.
ALTER TABLE "ResearchRun" ALTER COLUMN "siteId" DROP NOT NULL;
