import { GoogleConnectionType, IntegrationProvider, JobKind } from "@prisma/client";
import { db } from "@/lib/db";
import { encryptCredential } from "@/lib/encryption";
import { assertPublicDomain } from "@/lib/crawler/engine";
import { enqueueJob } from "@/lib/jobs/queue";
import { createServiceCredential } from "@/lib/auth/service-credentials";
import {
  DATAFORSEO_PROVIDER,
  ensurePlatformDataForSeoCredential,
} from "@/lib/dataforseo/platform-credentials";

export type ProvisionProjectInput = {
  externalOrganizationId: string;
  workspaceName: string;
  externalProjectId: string;
  projectName: string;
  domain: string;
  gscProperty: string;
  ga4PropertyId: string;
  serviceAccountCredentials?: string | Record<string, unknown>;
  serviceCredentialIdempotencyKey: string;
  /** Link an existing legacy site row instead of creating a duplicate site. */
  existingSiteId?: string;
  /** Optional least-privilege service identity for a project-specific agent. */
  serviceCredentialName?: string;
  serviceCredentialScopes?: string[];
  connectorExecutor?: "helloada" | "crawlseo-agent" | "wix" | "webflow";
  googleOAuthUserEmail?: string;
  googleImpersonatedUserEmail?: string;
  operatorUserEmail?: string;
  requireDataForSeo?: boolean;
  reissueCredential?: boolean;
  allowDomainVerificationOverride?: boolean;
  domainVerificationMethod?: string;
};

type DomainVerificationMethod = "helloada_dns" | "verified_gsc" | "operator_override";

export const DEFAULT_PROVISIONING_SERVICE_SCOPES = [
  "seo:read",
  "seo:research:request",
  "analytics:read",
  "crawl:read",
  "crawl:run",
] as const;

const DOMAIN_VERIFICATION_METHODS = new Set<DomainVerificationMethod>([
  "helloada_dns",
  "verified_gsc",
  "operator_override",
]);

export type ProvisionProjectResult = {
  workspaceId: string;
  projectId: string;
  siteId: string;
  servicePrincipalId: string;
  credentialId: string;
  credentialToken: string | null;
  credentialReused: boolean;
  dataforseoGrantSource: "platform" | "operator" | null;
  jobs: { gsc: string; ga4: string };
};

function canonicalDomain(raw: string): string {
  const candidate = raw.trim();
  const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Site domain must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Site domain must be a hostname without credentials or a path");
  }
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function siteUrlFor(domain: string): string {
  return `https://${domain}/`;
}

function gscPropertyCoversDomain(property: string, domain: string): boolean {
  const normalized = property.trim().toLowerCase();
  if (normalized.startsWith("sc-domain:")) {
    const propertyDomain = normalized.slice("sc-domain:".length).replace(/\.$/, "");
    return domain === propertyDomain || domain.endsWith(`.${propertyDomain}`);
  }

  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const propertyDomain = url.hostname.replace(/\.$/, "");
    return domain === propertyDomain || domain.endsWith(`.${propertyDomain}`);
  } catch {
    return false;
  }
}

export function resolveVerificationMethod(
  input: Pick<ProvisionProjectInput, "domainVerificationMethod" | "allowDomainVerificationOverride">,
  externalProjectId: string,
  gscProperty: string,
  domain: string
): DomainVerificationMethod {
  if (
    input.domainVerificationMethod !== undefined &&
    typeof input.domainVerificationMethod !== "string"
  ) {
    throw new Error("Domain verification method is invalid");
  }
  const allowOverride = input.allowDomainVerificationOverride === true;
  const requested = input.domainVerificationMethod?.trim().toLowerCase();
  const method = requested || (allowOverride ? "operator_override" : "");
  if (!DOMAIN_VERIFICATION_METHODS.has(method as DomainVerificationMethod)) {
    throw new Error("Domain ownership evidence is required");
  }

  const resolved = method as DomainVerificationMethod;
  if (resolved === "operator_override") {
    if (!allowOverride || externalProjectId !== "oceanicvibes") {
      throw new Error("Operator domain verification override is restricted to OceanicVibes");
    }
  }
  if (resolved === "verified_gsc" && !gscPropertyCoversDomain(gscProperty, domain)) {
    throw new Error("Verified GSC property must match the site domain");
  }
  return resolved;
}

function parseCredentials(value: string | Record<string, unknown>): Record<string, unknown> {
  const credentials = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !credentials ||
    typeof credentials !== "object" ||
    typeof credentials.client_email !== "string" ||
    typeof credentials.private_key !== "string" ||
    !credentials.client_email.includes("@") ||
    !credentials.private_key.includes("BEGIN PRIVATE KEY")
  ) {
    throw new Error("A valid Google service-account JSON document is required");
  }
  return credentials;
}

function safeCredentialMetadata(
  credentials: Record<string, unknown>,
  impersonatedUserEmail: string
) {
  return {
    clientEmail: String(credentials.client_email),
    googleProjectId: typeof credentials.project_id === "string" ? credentials.project_id : null,
    impersonatedUserEmail,
  };
}

function normalizedGoogleUserEmail(
  value: string | undefined,
  errorMessage = "A valid delegated Google Workspace user email is required"
): string {
  const email = value?.trim().toLowerCase() || "";
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new Error(errorMessage);
  }
  return email;
}

function optionalGoogleUserEmail(value: string | undefined): string {
  if (!value?.trim()) return "";
  return normalizedGoogleUserEmail(value, "A valid GSC OAuth user email is required");
}

export async function provisionProject(
  input: ProvisionProjectInput
): Promise<ProvisionProjectResult> {
  const externalOrganizationId = input.externalOrganizationId.trim();
  const externalProjectId = input.externalProjectId.trim();
  const domain = canonicalDomain(input.domain);
  if (!externalOrganizationId || !externalProjectId) {
    throw new Error("External organization and project IDs are required");
  }
  const connectorExecutor = input.connectorExecutor ?? "helloada";
  if (!["helloada", "crawlseo-agent", "wix", "webflow"].includes(connectorExecutor)) {
    throw new Error("Connector executor is invalid");
  }
  if (connectorExecutor !== "helloada" && connectorExecutor !== "crawlseo-agent") {
    throw new Error(`The ${connectorExecutor} execution adapter is not implemented and cannot be provisioned`);
  }

  // Always apply the crawler's existing DNS/SSRF guard before provisioning a
  // site. The explicit override only covers ownership evidence for the pilot.
  await assertPublicDomain(domain);
  const credentials = input.serviceAccountCredentials
    ? parseCredentials(input.serviceAccountCredentials)
    : null;
  const encryptedCredentials = credentials
    ? encryptCredential(JSON.stringify(credentials))
    : null;
  const googleOAuthUserEmail = optionalGoogleUserEmail(input.googleOAuthUserEmail);
  if (!credentials && !googleOAuthUserEmail) {
    throw new Error("A Google service account or OAuth user is required");
  }
  // Platform-managed mode: the service account verifies domain ownership
  // through the Site Verification API and is then a Search Console owner
  // itself, so impersonation is optional. It stays required only for callers
  // that explicitly rely on Workspace domain-wide delegation.
  const googleImpersonatedUserEmail = googleOAuthUserEmail
    ? ""
    : input.googleImpersonatedUserEmail?.trim()
      ? normalizedGoogleUserEmail(input.googleImpersonatedUserEmail)
      : "";
  const gscProperty = input.gscProperty.trim() || siteUrlFor(domain);
  const domainVerificationMethod = resolveVerificationMethod(
    input,
    externalProjectId,
    gscProperty,
    domain
  );
  const ga4PropertyId = input.ga4PropertyId.trim().replace(/^properties\//, "");
  if (!/^\d+$/.test(ga4PropertyId)) throw new Error("GA4 property ID is invalid");

  const records = await db.$transaction(async (tx) => {
    const workspace = await tx.workspace.upsert({
      where: { externalOrganizationId },
      create: {
        externalOrganizationId,
        name: input.workspaceName.trim() || externalOrganizationId,
      },
      update: { name: input.workspaceName.trim() || externalOrganizationId },
      select: { id: true },
    });

    const project = await tx.project.upsert({
      where: {
        workspaceId_externalProjectId: {
          workspaceId: workspace.id,
          externalProjectId,
        },
      },
      create: {
        workspaceId: workspace.id,
        externalProjectId,
        name: input.projectName.trim() || externalProjectId,
      },
      update: {
        name: input.projectName.trim() || externalProjectId,
        status: "ACTIVE",
      },
      select: { id: true },
    });

    const operator = input.operatorUserEmail
      ? await tx.user.findUnique({
          where: { email: input.operatorUserEmail.trim().toLowerCase() },
          select: { id: true },
        })
      : null;
    if (input.operatorUserEmail && !operator) {
      throw new Error("Configured operator user does not exist");
    }

    let site: { id: string };
    if (input.existingSiteId?.trim()) {
      const existingSite = await tx.site.findUnique({
        where: { id: input.existingSiteId.trim() },
        select: { id: true, domain: true, projectId: true, userId: true },
      });
      if (!existingSite) throw new Error("Existing site record was not found");
      if (canonicalDomain(existingSite.domain) !== domain) {
        throw new Error("Existing site record does not match the requested domain");
      }
      if (existingSite.projectId && existingSite.projectId !== project.id) {
        throw new Error("Existing site record already belongs to a different project");
      }
      const duplicateProjectSite = await tx.site.findUnique({
        where: { projectId_domain: { projectId: project.id, domain } },
        select: { id: true },
      });
      if (duplicateProjectSite && duplicateProjectSite.id !== existingSite.id) {
        throw new Error("Project already contains a different site record for this domain");
      }
      if (existingSite.userId) {
        const duplicateUserSite = await tx.site.findUnique({
          where: { userId_domain: { userId: existingSite.userId, domain } },
          select: { id: true },
        });
        if (duplicateUserSite && duplicateUserSite.id !== existingSite.id) {
          throw new Error("A duplicate user-owned site record already exists for this domain");
        }
      }
      site = await tx.site.update({
        where: { id: existingSite.id },
        data: {
          projectId: project.id,
          domain,
          gscProperty,
          domainVerificationMethod,
          ...(operator ? { userId: operator.id } : {}),
        },
        select: { id: true },
      });
    } else {
      site = await tx.site.upsert({
        where: { projectId_domain: { projectId: project.id, domain } },
        create: {
          projectId: project.id,
          userId: operator?.id,
          domain,
          gscProperty,
          domainVerificationMethod,
        },
        update: {
          ...(operator ? { userId: operator.id } : {}),
          gscProperty,
          domainVerificationMethod,
        },
        select: { id: true },
      });
    }

    // A tenant begins with one declared executor. Repeated provisioning never
    // silently transfers work or increments the fencing generation.
    await tx.connectorBinding.upsert({
      where: { siteId: site.id },
      create: { projectId: project.id, siteId: site.id, executor: connectorExecutor, generation: 1, status: "ACTIVE" },
      update: {},
    });

    let serviceConnectionId: string | null = null;
    if (credentials && encryptedCredentials) {
      const connection = await tx.googleConnection.upsert({
        where: {
          workspaceId_type_label: {
            workspaceId: workspace.id,
            type: GoogleConnectionType.SERVICE_ACCOUNT,
            label: "helloada-google-service-account",
          },
        },
        create: {
          workspaceId: workspace.id,
          type: GoogleConnectionType.SERVICE_ACCOUNT,
          label: "helloada-google-service-account",
          encryptedCredentials,
          scopes: [
            "https://www.googleapis.com/auth/webmasters.readonly",
            "https://www.googleapis.com/auth/analytics.readonly",
          ],
          metadata: safeCredentialMetadata(credentials, googleImpersonatedUserEmail),
        },
        update: {
          encryptedCredentials,
          status: "ACTIVE",
          scopes: [
            "https://www.googleapis.com/auth/webmasters.readonly",
            "https://www.googleapis.com/auth/analytics.readonly",
          ],
          metadata: safeCredentialMetadata(credentials, googleImpersonatedUserEmail),
        },
        select: { id: true },
      });
      serviceConnectionId = connection.id;
    }

    let oauthConnectionId: string | null = null;
    if (googleOAuthUserEmail) {
      const oauthUser = await tx.user.findUnique({
        where: { email: googleOAuthUserEmail },
        select: { id: true, email: true, googleTokens: true },
      });
      if (!oauthUser) throw new Error("Configured Google OAuth user does not exist");
      if (!oauthUser.googleTokens) {
        throw new Error("Configured Google OAuth user has no Google OAuth tokens");
      }

      const oauthConnection = await tx.googleConnection.upsert({
        where: {
          workspaceId_type_label: {
            workspaceId: workspace.id,
            type: GoogleConnectionType.OAUTH,
            label: "helloada-google-oauth",
          },
        },
        create: {
          workspaceId: workspace.id,
          type: GoogleConnectionType.OAUTH,
          label: "helloada-google-oauth",
          encryptedCredentials: encryptCredential(JSON.stringify({ userId: oauthUser.id })),
          scopes: [
            "https://www.googleapis.com/auth/webmasters.readonly",
            "https://www.googleapis.com/auth/analytics.readonly",
          ],
          metadata: { userId: oauthUser.id, userEmail: oauthUser.email },
        },
        update: {
          encryptedCredentials: encryptCredential(JSON.stringify({ userId: oauthUser.id })),
          status: "ACTIVE",
          scopes: [
            "https://www.googleapis.com/auth/webmasters.readonly",
            "https://www.googleapis.com/auth/analytics.readonly",
          ],
          metadata: { userId: oauthUser.id, userEmail: oauthUser.email },
        },
        select: { id: true },
      });
      oauthConnectionId = oauthConnection.id;
    }

    const gscConnectionId = oauthConnectionId ?? serviceConnectionId;
    const ga4ConnectionId = serviceConnectionId ?? oauthConnectionId;
    if (!gscConnectionId || !ga4ConnectionId) {
      throw new Error("A Google connection is required for GSC and GA4");
    }

    if (oauthConnectionId) {
      // Prevent a previous service-account GSC grant from being selected during
      // the transition to the user OAuth connection.
      await tx.integrationGrant.updateMany({
        where: {
          projectId: project.id,
          siteId: site.id,
          provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
          connectionId: { not: oauthConnectionId },
          status: { in: ["ACTIVE", "UNVERIFIED"] },
        },
        data: { status: "REVOKED", safeErrorCode: "REPLACED_BY_OAUTH" },
      });
    }
    if (!serviceConnectionId && oauthConnectionId) {
      // The OAuth user is also the GA4 identity when no service account was
      // supplied for the test project.
      await tx.integrationGrant.updateMany({
        where: {
          projectId: project.id,
          siteId: site.id,
          provider: IntegrationProvider.GOOGLE_ANALYTICS,
          connectionId: { not: oauthConnectionId },
          status: { in: ["ACTIVE", "UNVERIFIED"] },
        },
        data: { status: "REVOKED", safeErrorCode: "REPLACED_BY_OAUTH" },
      });
    }

    const existingGscGrant = await tx.integrationGrant.findFirst({
      where: {
        connectionId: gscConnectionId,
        projectId: project.id,
        siteId: site.id,
        provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
        externalResourceId: gscProperty,
      },
      select: { id: true },
    });
    if (existingGscGrant) {
      await tx.integrationGrant.update({
        where: { id: existingGscGrant.id },
        data: {
          status: "UNVERIFIED",
          safeErrorCode: null,
          metadata: { propertyType: "siteUrl" },
        },
      });
    } else {
      await tx.integrationGrant.create({
        data: {
          connectionId: gscConnectionId,
          projectId: project.id,
          siteId: site.id,
          provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
          externalResourceId: gscProperty,
          metadata: { propertyType: "siteUrl" },
          status: "UNVERIFIED",
        },
      });
    }

    const existingGa4Grant = await tx.integrationGrant.findFirst({
      where: {
        connectionId: ga4ConnectionId,
        projectId: project.id,
        siteId: site.id,
        provider: IntegrationProvider.GOOGLE_ANALYTICS,
        externalResourceId: ga4PropertyId,
      },
      select: { id: true },
    });
    if (existingGa4Grant) {
      await tx.integrationGrant.update({
        where: { id: existingGa4Grant.id },
        data: {
          status: "UNVERIFIED",
          safeErrorCode: null,
          metadata: { propertyType: "propertyId" },
        },
      });
    } else {
      await tx.integrationGrant.create({
        data: {
          connectionId: ga4ConnectionId,
          projectId: project.id,
          siteId: site.id,
          provider: IntegrationProvider.GOOGLE_ANALYTICS,
          externalResourceId: ga4PropertyId,
          metadata: { propertyType: "propertyId" },
          status: "UNVERIFIED",
        },
      });
    }

    await tx.seoResearchPolicy.upsert({
      where: { siteId: site.id },
      create: {
        projectId: project.id,
        siteId: site.id,
        monthlyTaskLimit: 9,
        keywordSeedLimit: 5,
        competitorLimit: 1,
        packageVersion: "standard-v1",
      },
      update: {},
    });

    const serviceCredentialName = input.serviceCredentialName?.trim() || "site-agent";
    const principal = await tx.servicePrincipal.upsert({
      where: { projectId_name: { projectId: project.id, name: serviceCredentialName } },
      create: { projectId: project.id, name: serviceCredentialName },
      update: { status: "ACTIVE" },
      select: { id: true },
    });

    const platformCredentialId = await ensurePlatformDataForSeoCredential(tx);
    let dataforseoGrantSource: ProvisionProjectResult["dataforseoGrantSource"] = null;
    if (platformCredentialId) {
      await tx.projectApiKeyGrant.upsert({
        where: { projectId_provider: { projectId: project.id, provider: DATAFORSEO_PROVIDER } },
        create: {
          projectId: project.id,
          providerCredentialId: platformCredentialId,
          provider: DATAFORSEO_PROVIDER,
          status: "ACTIVE",
        },
        update: {
          apiKeyId: null,
          providerCredentialId: platformCredentialId,
          status: "ACTIVE",
        },
      });
      dataforseoGrantSource = "platform";
    } else if (operator) {
      const dataforseoKey = await tx.apiKey.findUnique({
        where: { userId_provider: { userId: operator.id, provider: DATAFORSEO_PROVIDER } },
        select: { id: true },
      });
      if (dataforseoKey) {
        await tx.projectApiKeyGrant.upsert({
          where: { projectId_provider: { projectId: project.id, provider: DATAFORSEO_PROVIDER } },
          create: {
            projectId: project.id,
            apiKeyId: dataforseoKey.id,
            provider: DATAFORSEO_PROVIDER,
            status: "ACTIVE",
          },
          update: {
            apiKeyId: dataforseoKey.id,
            providerCredentialId: null,
            status: "ACTIVE",
          },
        });
        dataforseoGrantSource = "operator";
      }
    }
    if (input.requireDataForSeo && !dataforseoGrantSource) {
      throw new Error("DataForSEO platform credentials are required for automatic provisioning");
    }
    return {
      workspaceId: workspace.id,
      projectId: project.id,
      siteId: site.id,
      principalId: principal.id,
      dataforseoGrantSource,
    };
  });

  const credential = await createServiceCredential(records.projectId, [
    ...(input.serviceCredentialScopes ?? DEFAULT_PROVISIONING_SERVICE_SCOPES),
  ], {
    idempotencyKey: input.serviceCredentialIdempotencyKey,
    principalName: input.serviceCredentialName?.trim() || "site-agent",
    reissueIfReused: input.reissueCredential === true,
  });

  const gscJob = await enqueueJob({
    projectId: records.projectId,
    siteId: records.siteId,
    kind: JobKind.GSC_SYNC,
    payload: { daysBack: 28 },
    idempotencyKey: `provision:${input.serviceCredentialIdempotencyKey}:gsc`,
  });
  const ga4Job = await enqueueJob({
    projectId: records.projectId,
    siteId: records.siteId,
    kind: JobKind.GA4_SYNC,
    payload: {},
    idempotencyKey: `provision:${input.serviceCredentialIdempotencyKey}:ga4`,
  });

  return {
    workspaceId: records.workspaceId,
    projectId: records.projectId,
    siteId: records.siteId,
    servicePrincipalId: credential.servicePrincipalId,
    credentialId: credential.credentialId,
    credentialToken: credential.token,
    credentialReused: credential.reused,
    dataforseoGrantSource: records.dataforseoGrantSource,
    jobs: { gsc: gscJob.id, ga4: ga4Job.id },
  };
}
