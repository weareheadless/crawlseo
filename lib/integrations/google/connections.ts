import { IntegrationProvider } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptCredential } from "@/lib/encryption";
import {
  GoogleCredentialError,
  ServiceAccountCredentialProvider,
  UserOAuthCredentialProvider,
  type GoogleCredentialProvider,
} from "./credential-provider";

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const GA4_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

export class GoogleIntegrationError extends Error {
  readonly safeCode: string;

  constructor(message: string, safeCode = "GOOGLE_INTEGRATION_ERROR") {
    super(message);
    this.name = "GoogleIntegrationError";
    this.safeCode = safeCode;
  }
}

export type ActiveGoogleGrant = {
  id: string;
  provider: IntegrationProvider;
  externalResourceId: string;
  projectId: string;
  siteId: string | null;
  connectionId: string;
  metadata: unknown;
  connection: {
    id: string;
    type: string;
    status: string;
    encryptedCredentials: string;
    metadata: unknown;
  };
};

export async function getGoogleGrant(
  projectId: string,
  provider: IntegrationProvider,
  options: { siteId?: string; externalResourceId?: string } = {}
): Promise<ActiveGoogleGrant> {
  const grant = await db.integrationGrant.findFirst({
    where: {
      projectId,
      provider,
      siteId: options.siteId,
      externalResourceId: options.externalResourceId,
      status: { in: ["ACTIVE", "UNVERIFIED"] },
      project: {
        status: "ACTIVE",
        workspace: { status: "ACTIVE" },
      },
      connection: { status: "ACTIVE" },
    },
    select: {
      id: true,
      provider: true,
      externalResourceId: true,
      projectId: true,
      siteId: true,
      connectionId: true,
      metadata: true,
      connection: {
        select: {
          id: true,
          type: true,
          status: true,
          encryptedCredentials: true,
          metadata: true,
        },
      },
    },
  });

  if (!grant) {
    throw new GoogleIntegrationError(
      provider === "GOOGLE_SEARCH_CONSOLE"
        ? "Search Console is not connected for this project"
        : "Google Analytics is not connected for this project",
      "GOOGLE_GRANT_UNAVAILABLE"
    );
  }
  return grant;
}

export async function credentialProviderForGrant(
  grant: ActiveGoogleGrant
): Promise<GoogleCredentialProvider> {
  if (grant.connection.type === "OAUTH") {
    try {
      const credentials = JSON.parse(decryptCredential(grant.connection.encryptedCredentials)) as {
        userId?: unknown;
      };
      if (typeof credentials.userId !== "string" || !credentials.userId.trim()) {
        throw new GoogleIntegrationError(
          "Stored Google OAuth user reference is invalid",
          "GOOGLE_CREDENTIALS_INVALID"
        );
      }
      return new UserOAuthCredentialProvider(credentials.userId);
    } catch (error) {
      if (error instanceof GoogleIntegrationError) throw error;
      throw new GoogleIntegrationError(
        "Stored Google credentials could not be loaded",
        "GOOGLE_CREDENTIALS_INVALID"
      );
    }
  }

  if (grant.connection.type !== "SERVICE_ACCOUNT" && grant.connection.type !== "PLATFORM_MANAGED") {
    throw new GoogleIntegrationError(
      "This Google connection type is not enabled yet",
      "GOOGLE_CONNECTION_TYPE_UNSUPPORTED"
    );
  }

  const metadata =
    grant.connection.metadata && typeof grant.connection.metadata === "object"
      ? grant.connection.metadata as Record<string, unknown>
      : {};
  const impersonatedUserEmail =
    typeof metadata.impersonatedUserEmail === "string"
      ? metadata.impersonatedUserEmail.trim()
      : "";

  // Platform-managed service accounts can own Search Console properties
  // directly (verified through the Site Verification API), so a delegated
  // Workspace user is no longer mandatory. When one is present it is still
  // used as the impersonation subject for legacy connections.

  try {
    const credentials = JSON.parse(decryptCredential(grant.connection.encryptedCredentials));
    return new ServiceAccountCredentialProvider(credentials, {
      subject:
        grant.provider === IntegrationProvider.GOOGLE_SEARCH_CONSOLE
          ? impersonatedUserEmail || undefined
          : undefined,
    });
  } catch (error) {
    if (error instanceof GoogleCredentialError) throw error;
    throw new GoogleIntegrationError(
      "Stored Google credentials could not be loaded",
      "GOOGLE_CREDENTIALS_INVALID"
    );
  }
}

export async function getProjectGoogleProvider(
  projectId: string,
  provider: IntegrationProvider,
  options: { siteId?: string; externalResourceId?: string } = {}
): Promise<{ grant: ActiveGoogleGrant; provider: GoogleCredentialProvider }> {
  const grant = await getGoogleGrant(projectId, provider, options);
  return { grant, provider: await credentialProviderForGrant(grant) };
}

export async function markGrantFailure(
  grantId: string,
  safeErrorCode: string
): Promise<void> {
  await db.integrationGrant.update({
    where: { id: grantId },
    data: {
      status: "ERROR",
      safeErrorCode: safeErrorCode.slice(0, 120),
      lastValidatedAt: new Date(),
    },
  });
}

export async function markGrantSuccess(grantId: string): Promise<void> {
  await db.integrationGrant.update({
    where: { id: grantId },
    data: {
      status: "ACTIVE",
      safeErrorCode: null,
      lastValidatedAt: new Date(),
      lastSuccessfulAt: new Date(),
    },
  });
}
