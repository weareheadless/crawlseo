-- Keep platform-managed provider credentials separate from user BYOK keys.

CREATE TYPE "ProviderCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');

CREATE TABLE "ProviderCredential" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "encryptedLogin" TEXT NOT NULL,
  "encryptedPassword" TEXT NOT NULL,
  "status" "ProviderCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProjectApiKeyGrant"
  ALTER COLUMN "apiKeyId" DROP NOT NULL;
ALTER TABLE "ProjectApiKeyGrant"
  ADD COLUMN "providerCredentialId" TEXT;

CREATE UNIQUE INDEX "ProviderCredential_provider_label_key"
  ON "ProviderCredential"("provider", "label");
CREATE INDEX "ProviderCredential_provider_status_idx"
  ON "ProviderCredential"("provider", "status");
CREATE INDEX "ProjectApiKeyGrant_providerCredentialId_status_idx"
  ON "ProjectApiKeyGrant"("providerCredentialId", "status");

ALTER TABLE "ProjectApiKeyGrant"
  ADD CONSTRAINT "ProjectApiKeyGrant_providerCredentialId_fkey"
  FOREIGN KEY ("providerCredentialId") REFERENCES "ProviderCredential"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A grant must resolve to exactly one credential source.
ALTER TABLE "ProjectApiKeyGrant"
  ADD CONSTRAINT "ProjectApiKeyGrant_one_credential_check"
  CHECK (("apiKeyId" IS NOT NULL) <> ("providerCredentialId" IS NOT NULL));
