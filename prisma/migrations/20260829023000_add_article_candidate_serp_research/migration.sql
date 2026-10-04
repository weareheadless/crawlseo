CREATE TYPE "ArticleKeywordResearchKind" AS ENUM (
  'RELATED_KEYWORDS',
  'KEYWORD_OVERVIEW',
  'ORGANIC_SERP'
);

ALTER TABLE "ArticleKeywordResearchRun"
  ADD COLUMN "queries" JSONB,
  ADD COLUMN "kind" "ArticleKeywordResearchKind" NOT NULL DEFAULT 'RELATED_KEYWORDS',
  ADD COLUMN "parentRunId" TEXT;

CREATE UNIQUE INDEX "ArticleKeywordResearchRun_parentRunId_key"
  ON "ArticleKeywordResearchRun"("parentRunId");

ALTER TABLE "ArticleKeywordResearchRun"
  ADD CONSTRAINT "ArticleKeywordResearchRun_parentRunId_fkey"
  FOREIGN KEY ("parentRunId") REFERENCES "ArticleKeywordResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
