ALTER TABLE "ResearchRun" ADD COLUMN "scheduleKey" TEXT;

CREATE UNIQUE INDEX "ResearchRun_siteId_scheduleKey_key"
ON "ResearchRun"("siteId", "scheduleKey");
