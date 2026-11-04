-- Additive: persist how a finding's claim about the site was verified.
ALTER TABLE "ResearchFinding" ADD COLUMN "verification" JSONB;
