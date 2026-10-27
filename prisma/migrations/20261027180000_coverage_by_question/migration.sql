-- DropForeignKey
ALTER TABLE "QuestionCoverage" DROP CONSTRAINT "QuestionCoverage_findingId_fkey";

-- DropIndex
DROP INDEX "QuestionCoverage_actionId_key";

-- DropIndex
DROP INDEX "QuestionCoverage_projectId_findingId_sectionIdentity_key";

-- AlterTable
ALTER TABLE "QuestionCoverage" ADD COLUMN     "question" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "findingId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "QuestionCoverage_projectId_question_sectionIdentity_key" ON "QuestionCoverage"("projectId", "question", "sectionIdentity");

-- AddForeignKey
ALTER TABLE "QuestionCoverage" ADD CONSTRAINT "QuestionCoverage_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "ResearchFinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

