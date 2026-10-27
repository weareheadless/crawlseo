-- DropIndex
DROP INDEX "QuestionCoverage_projectId_findingId_service_audience_local_key";

-- CreateIndex
CREATE UNIQUE INDEX "QuestionCoverage_projectId_findingId_sectionIdentity_key" ON "QuestionCoverage"("projectId", "findingId", "sectionIdentity");

