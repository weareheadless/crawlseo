-- An external executor can deliver work, and its claim is recorded rather than assumed.
--
-- The funnel plan reserves *execution and publication* for a human confirmation, and
-- `Task.humanConfirmedBy` is what records it. That invariant stays true: nothing here
-- writes a human confirmation. What changes is that a delivery by an external agent is now
-- representable at all, in its own record, with its own attribution.
--
-- The alternative was to write the agent's name into `humanConfirmedBy`, which would have
-- made "a person confirmed this" indistinguishable from "an agent reported this" — the one
-- question an auditor asks first.

CREATE TABLE "OpportunityExecution" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "executorKind" TEXT NOT NULL,
    "executorId" TEXT NOT NULL,
    "workKind" TEXT NOT NULL,
    "commitSha" TEXT,
    "pullRequestUrl" TEXT,
    "deployedUrl" TEXT,
    "note" TEXT NOT NULL,
    "resultingStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityExecution_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OpportunityExecution_opportunityId_createdAt_idx"
  ON "OpportunityExecution" ("opportunityId", "createdAt");
CREATE INDEX "OpportunityExecution_projectId_createdAt_idx"
  ON "OpportunityExecution" ("projectId", "createdAt");
CREATE INDEX "OpportunityExecution_siteId_createdAt_idx"
  ON "OpportunityExecution" ("siteId", "createdAt");

ALTER TABLE "OpportunityExecution"
  ADD CONSTRAINT "OpportunityExecution_opportunityId_fkey"
  FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityExecution"
  ADD CONSTRAINT "OpportunityExecution_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityExecution"
  ADD CONSTRAINT "OpportunityExecution_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The delivery config gains the facts an external executor needs to reach the repository.
--
-- `repoPath` already existed and is a path on whichever machine the built-in agent runs on.
-- An MCP client cannot use it: it cannot `cd` into this host. These three columns are the
-- cloneable identity of the same repository, plus the site's own deployment document.
--
-- All nullable and unset by default. A site with no external executor configured keeps
-- behaving exactly as before: an absent `repoUrl` means "no external executor is configured
-- for this site", which the tools report rather than guess around.

ALTER TABLE "SiteDeliveryConfig" ADD COLUMN "repoUrl" TEXT;
ALTER TABLE "SiteDeliveryConfig" ADD COLUMN "defaultBranch" TEXT;
ALTER TABLE "SiteDeliveryConfig" ADD COLUMN "deployDocPath" TEXT;

-- Reported so this migration is auditable rather than silent.
DO $$
DECLARE
  configured_count INT;
  total_count INT;
BEGIN
  SELECT COUNT(*) INTO configured_count FROM "SiteDeliveryConfig" WHERE "repoPath" IS NOT NULL;
  SELECT COUNT(*) INTO total_count FROM "SiteDeliveryConfig";
  RAISE NOTICE 'delivery configs=% with a local repoPath=%; none has a cloneable repoUrl yet, so external execution reports as unconfigured until one is set',
    total_count, configured_count;
END $$;
