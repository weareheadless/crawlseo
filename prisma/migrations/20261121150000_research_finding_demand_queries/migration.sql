-- Demand forms a finding proposes for paid keyword research.
-- A list, not a table: the phrasing belongs to the finding that justified it, and
-- measurement of the phrase is already a keyword_metrics evidence row.
ALTER TABLE "ResearchFinding" ADD COLUMN "demandQueries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
