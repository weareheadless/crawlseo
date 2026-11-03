-- Cluster identity (docs/demand-map-cluster-discovery.md §3).
-- Identity is derived from members, never from the display name. Existing rows
-- (none in production, possible in a dev database) are backfilled from their
-- slug so the NOT NULL constraint can be added without a manual step.

-- AlterTable (nullable first)
ALTER TABLE "DemandMapCluster" ADD COLUMN "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN "identityKey" TEXT,
ADD COLUMN "proposedBy" TEXT NOT NULL DEFAULT 'manual',
ADD COLUMN "supersededById" TEXT;

-- Backfill: a pre-identity cluster keeps its slug as a legacy identity.
UPDATE "DemandMapCluster" SET "identityKey" = 'legacy:' || "slug" WHERE "identityKey" IS NULL;

ALTER TABLE "DemandMapCluster" ALTER COLUMN "identityKey" SET NOT NULL;

-- CreateIndex
CREATE INDEX "DemandMapCluster_supersededById_idx" ON "DemandMapCluster"("supersededById");

-- CreateIndex
CREATE UNIQUE INDEX "DemandMapCluster_projectId_identityKey_key" ON "DemandMapCluster"("projectId", "identityKey");

-- AddForeignKey
ALTER TABLE "DemandMapCluster" ADD CONSTRAINT "DemandMapCluster_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "DemandMapCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;
