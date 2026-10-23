-- CreateEnum
CREATE TYPE "AgentTaskStatus" AS ENUM ('READY', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AgentTask" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "actionId" TEXT,
    "draftId" TEXT,
    "kind" TEXT NOT NULL,
    "status" "AgentTaskStatus" NOT NULL DEFAULT 'READY',
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "repoPath" TEXT NOT NULL,
    "route" TEXT,
    "branch" TEXT,
    "worktreePath" TEXT,
    "agent" TEXT NOT NULL DEFAULT 'opencode',
    "result" JSONB,
    "errorCode" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentTask_siteId_createdAt_idx" ON "AgentTask"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTask_actionId_idx" ON "AgentTask"("actionId");

-- CreateIndex
CREATE INDEX "AgentTask_status_createdAt_idx" ON "AgentTask"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "ResearchAction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ContentDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
