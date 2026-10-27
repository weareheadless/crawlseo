ALTER TABLE "QuestionCoverage" ADD COLUMN "actionId" TEXT;
CREATE UNIQUE INDEX "QuestionCoverage_actionId_key" ON "QuestionCoverage"("actionId");
ALTER TABLE "QuestionCoverage" ADD CONSTRAINT "QuestionCoverage_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "ResearchAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
