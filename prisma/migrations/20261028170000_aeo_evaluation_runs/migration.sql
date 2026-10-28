CREATE TABLE "AeoEvaluationRun" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "actionId" TEXT,
    "questionSetVersion" TEXT NOT NULL,
    "providers" JSONB NOT NULL,
    "cap" INTEGER NOT NULL,
    "asked" INTEGER NOT NULL DEFAULT 0,
    "stored" INTEGER NOT NULL DEFAULT 0,
    "answerAbsent" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skippedByCap" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AeoEvaluationRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AeoEvaluationRun_projectId_runId_key" ON "AeoEvaluationRun"("projectId", "runId");
CREATE INDEX "AeoEvaluationRun_siteId_startedAt_idx" ON "AeoEvaluationRun"("siteId", "startedAt");
ALTER TABLE "AeoEvaluationRun" ADD CONSTRAINT "AeoEvaluationRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AeoEvaluationRun" ADD CONSTRAINT "AeoEvaluationRun_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
