-- CreateTable
CREATE TABLE "ResearchDispatchClaim" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchDispatchClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResearchDispatchClaim_leaseExpiresAt_idx" ON "ResearchDispatchClaim"("leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchDispatchClaim_projectId_provider_requestKey_key" ON "ResearchDispatchClaim"("projectId", "provider", "requestKey");

-- AddForeignKey
ALTER TABLE "ResearchDispatchClaim" ADD CONSTRAINT "ResearchDispatchClaim_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
