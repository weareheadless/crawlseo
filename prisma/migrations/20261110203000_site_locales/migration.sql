-- A page is written once per published locale, from scratch in that language.
-- The locale list and its URL shape are site data, not code.
ALTER TABLE "SiteProfile" ADD COLUMN "locales" JSONB;
