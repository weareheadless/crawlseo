-- Persist the exact DataForSEO locale mapping used for an article request.
ALTER TABLE "ArticleKeywordResearchRun"
  ADD COLUMN "providerLanguageCode" TEXT,
  ADD COLUMN "providerLocationCode" INTEGER;
