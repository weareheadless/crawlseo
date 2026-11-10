-- A stored design reference lets a page task reuse the site's own palette,
-- fonts and patterns instead of inferring a look from the live page.
ALTER TABLE "SiteProfile" ADD COLUMN "design" JSONB;

-- The connected source repository the page agent reads for design tokens.
ALTER TABLE "SiteDeliveryConfig" ADD COLUMN "repoPath" TEXT;
