-- Reverting an enum addition needs a type rebuild, and it must refuse when rows
-- already use the values rather than silently corrupt them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ResearchFinding" WHERE "type" IN ('POSITIONING_GAP', 'COMPETITOR_GAP')) THEN
    RAISE EXCEPTION 'cannot remove enum values: ResearchFinding rows use them';
  END IF;
END $$;

ALTER TYPE "ResearchFindingType" RENAME TO "ResearchFindingType_old";
CREATE TYPE "ResearchFindingType" AS ENUM ('THEME', 'QUESTION', 'CONCERN', 'OBJECTION', 'TREND', 'MISCONCEPTION', 'CONTENT_GAP');
ALTER TABLE "ResearchFinding" ALTER COLUMN "type" TYPE "ResearchFindingType" USING "type"::text::"ResearchFindingType";
DROP TYPE "ResearchFindingType_old";
