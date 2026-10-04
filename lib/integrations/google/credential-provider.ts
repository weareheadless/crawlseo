import { JWT } from "google-auth-library";
import { db } from "@/lib/db";

export interface GoogleCredentialProvider {
  getAccessToken(scopes: string[]): Promise<string>;
}

export class GoogleCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleCredentialError";
  }
}

function assertServiceAccount(value: unknown): asserts value is {
  client_email: string;
  private_key: string;
  project_id?: string;
  private_key_id?: string;
} {
  if (!value || typeof value !== "object") {
    throw new GoogleCredentialError("Google service-account credential is invalid");
  }
  const credential = value as Record<string, unknown>;
  if (
    typeof credential.client_email !== "string" ||
    typeof credential.private_key !== "string" ||
    !credential.client_email.includes("@") ||
    !credential.private_key.includes("BEGIN PRIVATE KEY")
  ) {
    throw new GoogleCredentialError("Google service-account credential is invalid");
  }
}

export class ServiceAccountCredentialProvider implements GoogleCredentialProvider {
  private readonly credentials: {
    client_email: string;
    private_key: string;
    project_id?: string;
    private_key_id?: string;
  };
  private readonly subject?: string;

  constructor(credentials: unknown, options: { subject?: string } = {}) {
    assertServiceAccount(credentials);
    this.credentials = credentials;
    this.subject = options.subject?.trim() || undefined;
  }

  async getAccessToken(scopes: string[]): Promise<string> {
    const normalizedScopes = [...new Set(scopes.filter(Boolean))];
    if (normalizedScopes.length === 0) {
      throw new GoogleCredentialError("At least one Google scope is required");
    }

    try {
      const auth = new JWT({
        email: this.credentials.client_email,
        key: this.credentials.private_key,
        keyId: this.credentials.private_key_id,
        scopes: normalizedScopes,
        subject: this.subject,
      });
      const response = await auth.getAccessToken();
      if (!response.token) {
        throw new GoogleCredentialError("Google did not return an access token");
      }
      return response.token;
    } catch (error) {
      if (error instanceof GoogleCredentialError) throw error;
      throw new GoogleCredentialError("Google service-account authentication failed");
    }
  }
}

type StoredGoogleTokens = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
};

async function refreshUserAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: number;
}> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    throw new GoogleCredentialError("Google OAuth token refresh failed");
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token || !data.expires_in) {
    throw new GoogleCredentialError("Google did not return a refreshed access token");
  }
  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/** Uses a real Google user's OAuth grant for APIs such as Search Console. */
export class UserOAuthCredentialProvider implements GoogleCredentialProvider {
  constructor(private readonly userId: string) {}

  async getAccessToken(scopes: string[]): Promise<string> {
    if (scopes.filter(Boolean).length === 0) {
      throw new GoogleCredentialError("At least one Google scope is required");
    }

    const user = await db.user.findUnique({
      where: { id: this.userId },
      select: { googleTokens: true },
    });
    const tokens = user?.googleTokens as StoredGoogleTokens | null;
    if (!tokens?.accessToken || !tokens.refreshToken) {
      throw new GoogleCredentialError("Google OAuth user has no usable tokens");
    }

    const requestedScopes = [...new Set(scopes.filter(Boolean))];
    const grantedScopes = new Set((tokens.scope ?? "").split(/\s+/).filter(Boolean));
    if (!tokens.scope || requestedScopes.some((scope) => !grantedScopes.has(scope))) {
      throw new GoogleCredentialError("Google OAuth grant lacks a required scope; reconnect Google");
    }

    if (tokens.expiresAt && tokens.expiresAt - Date.now() >= 5 * 60 * 1000) {
      return tokens.accessToken;
    }

    const refreshed = await refreshUserAccessToken(tokens.refreshToken);
    await db.user.update({
      where: { id: this.userId },
      data: { googleTokens: { ...tokens, ...refreshed } },
    });
    return refreshed.accessToken;
  }
}

export class OAuthCredentialProvider implements GoogleCredentialProvider {
  constructor(
    private readonly getToken: (scopes: string[]) => Promise<string>
  ) {}

  getAccessToken(scopes: string[]): Promise<string> {
    return this.getToken([...new Set(scopes.filter(Boolean))]);
  }
}
