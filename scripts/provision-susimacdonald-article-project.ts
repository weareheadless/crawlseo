import { mkdir, readFile, chmod, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const SCOPE = ["seo:read", "seo:research:request"];
const DEFAULT_ORG = "helloada_test";
const DEFAULT_EXTERNAL_PROJECT = "susimacdonald";
const DEFAULT_PROJECT_NAME = "Susi MacDonald";
const DEFAULT_TOKEN_FILE = "/home/admin/.config/crawlseo/susimacdonald-weekly-blog.env";
const REAI_ENV_FILE = process.env.REAI_ENV_FILE?.trim() || "/REAIupdate/.env";

function normalizedDomain(value: string): string {
  const raw = value.trim().replace(/^\/\//, "");
  const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  return url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

async function getGa4PropertyId(userId: string, email: string): Promise<{ id: string; name: string }> {
  const { UserOAuthCredentialProvider } = await import("../lib/integrations/google/credential-provider");
  const { GA4_SCOPE } = await import("../lib/integrations/google/connections");
  const provider = new UserOAuthCredentialProvider(userId);
  const token = await provider.getAccessToken([GA4_SCOPE]);
  const response = await fetch(
    "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw new Error(`Google Analytics property lookup returned HTTP ${response.status}`);
  const body = await response.json() as {
    accountSummaries?: Array<{ propertySummaries?: Array<{ property?: string; displayName?: string }> }>;
  };
  const matches = (body.accountSummaries ?? []).flatMap((account) => account.propertySummaries ?? [])
    .filter((property) => property.displayName?.trim().toLowerCase() === "susi macdonald")
    .map((property) => ({
      id: String(property.property ?? "").replace(/^properties\//, ""),
      name: String(property.displayName ?? ""),
    }))
    .filter((property) => /^\d+$/.test(property.id));
  if (matches.length !== 1) {
    throw new Error(`Expected one GA4 property named Susi MacDonald for ${email}; found ${matches.length}`);
  }
  return matches[0];
}

async function setEnvValues(path: string, values: Record<string, string>): Promise<void> {
  const current = await readFile(path, "utf8").catch(() => "");
  let updated = current;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^(?:export\\s+)?${key}=.*$`, "m");
    updated = pattern.test(updated)
      ? updated.replace(pattern, line)
      : `${updated}${updated && !updated.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  await writeFile(path, updated, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function main(): Promise<void> {
  const { db } = await import("../lib/db");
  const { provisionProject } = await import("../lib/projects/provision-project");
  const { authenticateServiceToken } = await import("../lib/auth/service-credentials");

  const externalOrganizationId = process.env.CRAWLSEO_SUSI_ORGANIZATION_ID?.trim() || DEFAULT_ORG;
  const externalProjectId = process.env.CRAWLSEO_SUSI_PROJECT_ID?.trim() || DEFAULT_EXTERNAL_PROJECT;
  const projectName = process.env.CRAWLSEO_SUSI_PROJECT_NAME?.trim() || DEFAULT_PROJECT_NAME;
  const domain = "www.susimacdonald.com";
  const tokenFile = process.env.CRAWLSEO_SERVICE_TOKEN_FILE?.trim() || DEFAULT_TOKEN_FILE;

  try {
    const workspace = await db.workspace.findUnique({
      where: { externalOrganizationId },
      select: { id: true, name: true, status: true, connections: {
        where: { type: "OAUTH", label: "helloada-google-oauth", status: "ACTIVE" },
        select: { metadata: true },
      } },
    });
    if (!workspace || workspace.status !== "ACTIVE") {
      throw new Error(`CrawlSEO workspace ${externalOrganizationId} is missing or inactive`);
    }

    const candidates = await db.site.findMany({
      where: { domain: { contains: "susimacdonald" } },
      select: { id: true, domain: true, projectId: true, userId: true, gscProperty: true,
        user: { select: { id: true, email: true, googleTokens: true } } },
    });
    const exact = candidates.filter((site) => {
      try { return normalizedDomain(site.domain) === normalizedDomain(domain); }
      catch { return false; }
    });
    if (exact.length !== 1) throw new Error(`Expected one existing Susi site record; found ${exact.length}`);
    const site = exact[0];
    if (!site.userId || !site.user?.email || !site.user.googleTokens) {
      throw new Error("The existing Susi site has no connected Google OAuth user");
    }
    if (!site.gscProperty) throw new Error("The existing Susi site has no Search Console property");

    const matchingWorkspaceOAuth = workspace.connections.some((connection) => {
      const metadata = connection.metadata && typeof connection.metadata === "object"
        ? connection.metadata as Record<string, unknown> : {};
      return String(metadata.userEmail ?? "").toLowerCase() === site.user!.email.toLowerCase();
    });
    if (!matchingWorkspaceOAuth) {
      throw new Error("The selected CrawlSEO workspace is not connected to the Susi site's Google user");
    }

    const ga4 = await getGa4PropertyId(site.user.id, site.user.email);
    const existingProject = await db.project.findUnique({
      where: { workspaceId_externalProjectId: {
        workspaceId: workspace.id, externalProjectId,
      } },
      select: { id: true },
    });
    const existingTokenText = await readFile(tokenFile, "utf8").catch(() => "");
    const tokenMatch = /^(?:export\s+)?CRAWLSEO_SERVICE_TOKEN=(.*)$/m.exec(existingTokenText);
    const priorToken = tokenMatch?.[1]?.trim().replace(/^(['"])(.*)\1$/, "$2") || "";
    if (existingProject && priorToken) {
      try {
        const principal = await authenticateServiceToken(priorToken);
        if (principal.projectId === existingProject.id
            && SCOPE.every((scope) => principal.scopes.includes(scope))) {
          console.log(JSON.stringify({
            status: "already_configured", project_name: projectName, workspace: workspace.name,
            domain, ga4_property: ga4.name, required_scopes: SCOPE,
          }, null, 2));
          return;
        }
      } catch { /* Reissue a narrowly scoped credential below. */ }
    }

    const result = await provisionProject({
      externalOrganizationId,
      workspaceName: workspace.name,
      externalProjectId,
      projectName,
      domain,
      gscProperty: site.gscProperty,
      ga4PropertyId: ga4.id,
      googleOAuthUserEmail: site.user.email,
      serviceCredentialIdempotencyKey: "weekly-market-article-susimacdonald-v1",
      existingSiteId: site.id,
      serviceCredentialName: "weekly-market-article",
      serviceCredentialScopes: SCOPE,
      domainVerificationMethod: "verified_gsc",
      requireDataForSeo: true,
      reissueCredential: true,
    });
    if (!result.credentialToken) throw new Error("CrawlSEO did not issue a service token");

    const tokenDir = dirname(tokenFile);
    await mkdir(tokenDir, { recursive: true, mode: 0o700 });
    await chmod(tokenDir, 0o700);
    await writeFile(tokenFile, `CRAWLSEO_SERVICE_TOKEN=${result.credentialToken}\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    await setEnvValues(REAI_ENV_FILE, {
      CRAWLSEO_MCP_URL: process.env.CRAWLSEO_MCP_URL?.trim() || "http://127.0.0.1:3006/mcp",
      CRAWLSEO_SERVICE_TOKEN_FILE: tokenFile,
      CRAWLSEO_EXPECTED_DOMAIN: "susimacdonald.com",
    });

    const principal = await authenticateServiceToken(result.credentialToken);
    if (principal.projectId !== result.projectId || !SCOPE.every((scope) => principal.scopes.includes(scope))) {
      throw new Error("Issued CrawlSEO credential failed project/scope readback")
    }
    console.log(JSON.stringify({
      status: "provisioned",
      workspace: workspace.name,
      project_name: projectName,
      site_domain: domain,
      existing_site_linked: true,
      ga4_property: ga4.name,
      dataforseo_grant: result.dataforseoGrantSource,
      credential_id: result.credentialId,
      credential_scopes: SCOPE,
      token_stored_at: tokenFile,
      token_printed: false,
    }, null, 2));
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "CrawlSEO project provisioning failed");
  process.exitCode = 1;
});
