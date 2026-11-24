-- One post per actioned opportunity, and the receipt Cicero returned.
--
-- Deliberately not a delivery pipeline: there is no queue here, no state
-- machine and no Meta id. `opportunityId` is unique because the human decision
-- that produces a post can only produce one; a retry reads this row.
CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'facebook_page',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "status" TEXT NOT NULL,
    "renderId" TEXT,
    "providerPostId" TEXT,
    "caption" TEXT NOT NULL DEFAULT '',
    "contentHash" TEXT NOT NULL DEFAULT '',
    "gateAttempts" INTEGER,
    "error" TEXT NOT NULL DEFAULT '',
    "decidedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialPost_opportunityId_key" ON "SocialPost"("opportunityId");
CREATE INDEX "SocialPost_projectId_publishedAt_idx" ON "SocialPost"("projectId", "publishedAt");
CREATE INDEX "SocialPost_projectId_status_idx" ON "SocialPost"("projectId", "status");

ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_opportunityId_fkey"
    FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
