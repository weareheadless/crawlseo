-- AlterTable
ALTER TABLE "Job" ALTER COLUMN "siteId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ResearchBudgetReservation" ALTER COLUMN "siteId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SeoResearchRun" ALTER COLUMN "siteId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PrelaunchResearchRequest" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "researchRunId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrelaunchResearchRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrelaunchResearchRequest_researchRunId_idx" ON "PrelaunchResearchRequest"("researchRunId");

-- CreateIndex
CREATE UNIQUE INDEX "PrelaunchResearchRequest_projectId_idempotencyKey_key" ON "PrelaunchResearchRequest"("projectId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchBudgetReservation_siteId_idempotencyKey_key" ON "ResearchBudgetReservation"("siteId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "SeoResearchRun_projectId_periodStart_packageVersion_key" ON "SeoResearchRun"("projectId", "periodStart", "packageVersion");

-- CreateIndex
CREATE UNIQUE INDEX "SeoResearchRun_projectId_idempotencyKey_key" ON "SeoResearchRun"("projectId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "PrelaunchResearchRequest" ADD CONSTRAINT "PrelaunchResearchRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrelaunchResearchRequest" ADD CONSTRAINT "PrelaunchResearchRequest_researchRunId_fkey" FOREIGN KEY ("researchRunId") REFERENCES "SeoResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
