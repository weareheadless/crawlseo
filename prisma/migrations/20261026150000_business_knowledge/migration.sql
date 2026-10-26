CREATE TABLE "BusinessKnowledgeDocument" (
  "id" TEXT NOT NULL,
  "logicalId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "acceptedRevision" INTEGER,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BusinessKnowledgeDocument_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BusinessKnowledgeDocument_projectId_key" ON "BusinessKnowledgeDocument"("projectId");
CREATE UNIQUE INDEX "BusinessKnowledgeDocument_projectId_logicalId_key" ON "BusinessKnowledgeDocument"("projectId", "logicalId");
CREATE INDEX "BusinessKnowledgeDocument_projectId_revision_idx" ON "BusinessKnowledgeDocument"("projectId", "revision");
ALTER TABLE "BusinessKnowledgeDocument" ADD CONSTRAINT "BusinessKnowledgeDocument_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BusinessKnowledgeRevision" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "fields" JSONB NOT NULL,
  "reason" TEXT NOT NULL,
  "changedFields" JSONB NOT NULL,
  "affectedActionIds" JSONB NOT NULL,
  "affectedActionsHaveMore" BOOLEAN NOT NULL DEFAULT FALSE,
  "serviceCaller" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessKnowledgeRevision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BusinessKnowledgeRevision_documentId_revision_key" ON "BusinessKnowledgeRevision"("documentId", "revision");
CREATE INDEX "BusinessKnowledgeRevision_documentId_createdAt_idx" ON "BusinessKnowledgeRevision"("documentId", "createdAt");
ALTER TABLE "BusinessKnowledgeRevision" ADD CONSTRAINT "BusinessKnowledgeRevision_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "BusinessKnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BusinessKnowledgeAcceptance" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "serviceCaller" TEXT,
  "reason" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessKnowledgeAcceptance_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BusinessKnowledgeAcceptance_documentId_idempotencyKey_key" ON "BusinessKnowledgeAcceptance"("documentId", "idempotencyKey");
CREATE INDEX "BusinessKnowledgeAcceptance_documentId_revision_createdAt_idx" ON "BusinessKnowledgeAcceptance"("documentId", "revision", "createdAt");
ALTER TABLE "BusinessKnowledgeAcceptance" ADD CONSTRAINT "BusinessKnowledgeAcceptance_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "BusinessKnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "BusinessKnowledgeReceipt" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BusinessKnowledgeReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BusinessKnowledgeReceipt_projectId_operation_idempotencyKey_key" ON "BusinessKnowledgeReceipt"("projectId", "operation", "idempotencyKey");
CREATE INDEX "BusinessKnowledgeReceipt_projectId_createdAt_idx" ON "BusinessKnowledgeReceipt"("projectId", "createdAt");
ALTER TABLE "BusinessKnowledgeReceipt" ADD CONSTRAINT "BusinessKnowledgeReceipt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
