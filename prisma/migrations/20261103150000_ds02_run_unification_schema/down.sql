-- Reversible: DS-02 step 1 adds columns and enum values only. Dropping them is
-- safe while nothing depends on them (steps 2+ have not run).
DROP INDEX IF EXISTS "ResearchRun_projectId_kind_idempotencyKey_key";
DROP INDEX IF EXISTS "ResearchRun_parentRunId_key";

ALTER TABLE "ResearchRun"
  DROP COLUMN IF EXISTS "attemptedAt",
  DROP COLUMN IF EXISTS "idempotencyKey",
  DROP COLUMN IF EXISTS "parentRunId",
  DROP COLUMN IF EXISTS "providerLanguageCode",
  DROP COLUMN IF EXISTS "providerLocationCode",
  DROP COLUMN IF EXISTS "providerTaskId",
  DROP COLUMN IF EXISTS "seed";

-- PostgreSQL cannot drop a single enum value; recreate the type without the new
-- members once no row uses them.
ALTER TYPE "ResearchRunKind" RENAME TO "ResearchRunKind_old";
CREATE TYPE "ResearchRunKind" AS ENUM ('MARKET', 'SEO', 'MIXED');
ALTER TABLE "ResearchRun" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "ResearchRun" ALTER COLUMN "kind" TYPE "ResearchRunKind" USING "kind"::text::"ResearchRunKind";
ALTER TABLE "ResearchRun" ALTER COLUMN "kind" SET DEFAULT 'MARKET';
DROP TYPE "ResearchRunKind_old";
