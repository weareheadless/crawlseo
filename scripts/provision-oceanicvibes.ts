import { chmod, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { provisionProject } from "@/lib/projects/provision-project";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function ensureCredentialEncryptionKey(): Promise<void> {
  if (process.env.CREDENTIAL_ENCRYPTION_KEY?.trim()) return;

  const envPath = process.env.CRAWLSEO_ENV_FILE?.trim() || ".env.local";
  const key = randomBytes(32).toString("hex");
  const existing = await readFile(envPath, "utf8").catch(() => "");
  const line = `CREDENTIAL_ENCRYPTION_KEY=${key}`;
  const updated = /^CREDENTIAL_ENCRYPTION_KEY=.*$/m.test(existing)
    ? existing.replace(/^CREDENTIAL_ENCRYPTION_KEY=.*$/m, line)
    : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`;
  await writeFile(envPath, updated, { mode: 0o600 });
  await chmod(envPath, 0o600);
  process.env.CREDENTIAL_ENCRYPTION_KEY = key;
  console.error(`Generated CREDENTIAL_ENCRYPTION_KEY in ${envPath}`);
}

async function storeServiceToken(token: string): Promise<boolean> {
  const tokenPath = process.env.CRAWLSEO_SERVICE_TOKEN_FILE?.trim();
  if (!tokenPath) return false;

  const existing = await readFile(tokenPath, "utf8").catch(() => "");
  const line = `CRAWLSEO_SERVICE_TOKEN=${token}`;
  const updated = /^CRAWLSEO_SERVICE_TOKEN=.*$/m.test(existing)
    ? existing.replace(/^CRAWLSEO_SERVICE_TOKEN=.*$/m, line)
    : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`;
  await writeFile(tokenPath, updated, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  console.error(`Stored CRAWLSEO_SERVICE_TOKEN in ${tokenPath}`);
  return true;
}

async function main(): Promise<void> {
  await ensureCredentialEncryptionKey();
  const credentialPath = process.env.CRAWLSEO_GOOGLE_SERVICE_ACCOUNT_FILE?.trim();
  const googleOAuthUserEmail = process.env.CRAWLSEO_GOOGLE_OAUTH_USER_EMAIL?.trim() || undefined;
  if (!credentialPath && !googleOAuthUserEmail) {
    throw new Error("Set CRAWLSEO_GOOGLE_OAUTH_USER_EMAIL or CRAWLSEO_GOOGLE_SERVICE_ACCOUNT_FILE");
  }
  const serviceAccountCredentials = credentialPath
    ? await readFile(credentialPath, "utf8")
    : undefined;
  const result = await provisionProject({
    externalOrganizationId: required("HELLOADA_ORGANIZATION_ID"),
    workspaceName: process.env.HELLOADA_WORKSPACE_NAME?.trim() || "HelloAda",
    externalProjectId: required("HELLOADA_PROJECT_ID"),
    projectName: process.env.HELLOADA_PROJECT_NAME?.trim() || "OceanicVibes",
    domain: required("CRAWLSEO_SITE_DOMAIN"),
    gscProperty: process.env.CRAWLSEO_GSC_PROPERTY?.trim() || "",
    ga4PropertyId: required("CRAWLSEO_GA4_PROPERTY_ID"),
    serviceAccountCredentials,
    serviceCredentialIdempotencyKey: required("CRAWLSEO_PROVISIONING_IDEMPOTENCY_KEY"),
    googleOAuthUserEmail,
    googleImpersonatedUserEmail: googleOAuthUserEmail
      ? undefined
      : required("CRAWLSEO_GOOGLE_IMPERSONATED_USER_EMAIL"),
    operatorUserEmail: process.env.CRAWLSEO_OPERATOR_USER_EMAIL?.trim() || undefined,
    requireDataForSeo: true,
    allowDomainVerificationOverride: process.env.CRAWLSEO_ALLOW_DOMAIN_OVERRIDE === "true",
    domainVerificationMethod: process.env.CRAWLSEO_DOMAIN_VERIFICATION_METHOD?.trim() || undefined,
  });

  console.log(JSON.stringify({
    workspaceId: result.workspaceId,
    projectId: result.projectId,
    siteId: result.siteId,
    servicePrincipalId: result.servicePrincipalId,
    credentialId: result.credentialId,
    credentialReused: result.credentialReused,
    dataforseoGrantSource: result.dataforseoGrantSource,
    jobs: result.jobs,
  }, null, 2));
  if (result.credentialToken) {
    if (!(await storeServiceToken(result.credentialToken))) {
      console.log("CRAWLSEO_SERVICE_TOKEN (save once; it will not be shown again):");
      console.log(result.credentialToken);
    }
  } else {
    console.log("Credential already issued for this idempotency key; no token was reprinted.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Provisioning failed");
  process.exitCode = 1;
});
