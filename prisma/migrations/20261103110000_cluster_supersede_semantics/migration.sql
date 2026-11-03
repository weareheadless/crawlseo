-- Retiring a cluster needs a marker distinct from "merged into a successor".
-- `supersededById` means "this cluster became that one"; `supersededAt` means
-- "this cluster is retired" (with or without a successor).

ALTER TABLE "DemandMapCluster" ADD COLUMN "supersededAt" TIMESTAMP(3);

-- Existing retired rows used a self-reference as the marker; convert them.
UPDATE "DemandMapCluster"
SET "supersededAt" = "updatedAt", "supersededById" = NULL
WHERE "supersededById" = "id";

CREATE INDEX "DemandMapCluster_supersededAt_idx" ON "DemandMapCluster"("supersededAt");
