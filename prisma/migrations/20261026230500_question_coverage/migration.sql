-- CreateEnum
CREATE TYPE "QuestionCoverageStatus" AS ENUM ('COVERED', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "QuestionCoverageReason" AS ENUM ('NO_EVIDENCE', 'DISPUTED_EVIDENCE', 'STALE_HASH');

-- CreateTable
CREATE TABLE "QuestionCoverage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "sectionIdentity" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" "QuestionCoverageStatus" NOT NULL,
    "documentId" TEXT,
    "fieldPath" TEXT,
    "evidenceRevision" INTEGER,
    "missingEvidence" TEXT,
    "reason" "QuestionCoverageReason",
    "requestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuestionCoverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuestionCoverage_projectId_status_updatedAt_idx" ON "QuestionCoverage"("projectId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "QuestionCoverage_documentId_evidenceRevision_idx" ON "QuestionCoverage"("documentId", "evidenceRevision");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionCoverage_projectId_findingId_service_audience_local_key" ON "QuestionCoverage"("projectId", "findingId", "service", "audience", "locale", "sectionIdentity");

-- AddForeignKey
ALTER TABLE "QuestionCoverage" ADD CONSTRAINT "QuestionCoverage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionCoverage" ADD CONSTRAINT "QuestionCoverage_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "ResearchFinding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionCoverage" ADD CONSTRAINT "QuestionCoverage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "BusinessKnowledgeDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

