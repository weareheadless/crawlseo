-- Brand identity and representation belong to the site profile.
--
-- They were kept in two places: this profile, and Cicero's
-- brands/<id>/brand.json. The file drifted from the profile — its logo_path was
-- empty while the real logo existed — and four posts shipped without a logo.
-- One record now answers "what does this brand look like" and "what may it
-- promote", and a renderer keeps at most a cache of it.
ALTER TABLE "SiteProfile" ADD COLUMN "brand" JSONB;
ALTER TABLE "SiteProfile" ADD COLUMN "representation" JSONB;
