ALTER TABLE "Project" ADD COLUMN "registrationRequestHash" TEXT;
ALTER TABLE "Project" ADD COLUMN "registrationDomain" TEXT;

CREATE TABLE "ProjectRegistrationReceipt" (
  "id" TEXT NOT NULL,
  "externalOrganizationId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ProjectRegistrationReceipt_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProjectRegistrationReceipt"
  ADD CONSTRAINT "ProjectRegistrationReceipt_externalOrganizationId_fkey"
  FOREIGN KEY ("externalOrganizationId") REFERENCES "Workspace"("externalOrganizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ProjectRegistrationReceipt_externalOrganizationId_operation_idempotencyKey_key"
  ON "ProjectRegistrationReceipt"("externalOrganizationId", "operation", "idempotencyKey");

CREATE INDEX "ProjectRegistrationReceipt_externalOrganizationId_createdAt_idx"
  ON "ProjectRegistrationReceipt"("externalOrganizationId", "createdAt");
