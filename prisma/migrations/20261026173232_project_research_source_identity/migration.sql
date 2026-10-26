-- AlterTable
ALTER TABLE "ResearchSource" ADD COLUMN     "identityId" TEXT;

-- CreateTable
CREATE TABLE "ResearchSourceIdentity" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "currentHash" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchSourceIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResearchSourceIdentity_projectId_provider_sourceId_idx" ON "ResearchSourceIdentity"("projectId", "provider", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "ResearchSourceIdentity_projectId_provider_normalizedUrl_key" ON "ResearchSourceIdentity"("projectId", "provider", "normalizedUrl");

-- AddForeignKey
ALTER TABLE "ResearchSourceIdentity" ADD CONSTRAINT "ResearchSourceIdentity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "ResearchSourceIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "ConnectorOperationReceipt_projectId_operation_idempotencyKey_ke" RENAME TO "ConnectorOperationReceipt_projectId_operation_idempotencyKe_key";

-- RenameIndex
ALTER INDEX "LegacyBudgetSourceFreezeReceipt_sourceProjectId_idempotencyKey_" RENAME TO "LegacyBudgetSourceFreezeReceipt_sourceProjectId_idempotency_key";

-- RenameIndex
ALTER INDEX "ProjectRegistrationReceipt_externalOrganizationId_operation_ide" RENAME TO "ProjectRegistrationReceipt_externalOrganizationId_operation_key";
