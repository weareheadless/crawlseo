-- CreateIndex
CREATE UNIQUE INDEX "Job_projectId_kind_idempotencyKey_key" ON "Job"("projectId", "kind", "idempotencyKey");
