-- Additive: extracted page text, so coverage and absence claims can be checked
-- against content rather than a URL pattern.
ALTER TABLE "AuditPage" ADD COLUMN "contentText" TEXT;
