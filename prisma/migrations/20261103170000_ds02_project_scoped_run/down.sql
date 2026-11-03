-- Restoring NOT NULL is only safe when no project-scoped rows exist. Fail loudly
-- instead of deleting research history.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ResearchRun" WHERE "siteId" IS NULL) THEN
    RAISE EXCEPTION 'cannot restore NOT NULL: project-scoped ResearchRun rows exist';
  END IF;
END $$;

ALTER TABLE "ResearchRun" ALTER COLUMN "siteId" SET NOT NULL;
