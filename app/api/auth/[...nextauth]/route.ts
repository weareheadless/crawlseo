import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { createLocalSession, signOutLocal } from "@/lib/local-auth";
import { getUserIdFromCookies } from "@/lib/session-helper";

export const runtime = "nodejs";

const GOOGLE_AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
];
const OAUTH_STATE_IDENTIFIER = "google-connect:";
const GOOGLE_LOGIN_IDENTIFIER = "google-login";
const OAUTH_STATE_COOKIE = "crawlseo.google-oauth-state";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function appBaseUrl(request: Request): URL {
  const configured = process.env.NEXTAUTH_URL?.trim();
  return new URL(configured || new URL(request.url).origin);
}

function redirectUrl(request: Request, path: string, params?: Record<string, string>): URL {
  const url = new URL(`/crawlseo${path}`, appBaseUrl(request));
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url;
}

function oauthRedirectUri(request: Request): string {
  return (
    process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() ||
    new URL("/api/auth/callback/google", appBaseUrl(request)).toString()
  );
}

function stateCookie(request: Request, value: string, maxAge: number): string {
  const secure = appBaseUrl(request).protocol === "https:";
  return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function redirectWithStateCleared(
  request: Request,
  path: string,
  params?: Record<string, string>
): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectUrl(request, path, params).toString(),
      "Set-Cookie": stateCookie(request, "", 0),
    },
  });
}

function requestState(request: Request): string {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)crawlseo\.google-oauth-state=([^;]*)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

async function startGoogleOAuth(request: Request, mode: "connect" | "login"): Promise<Response> {
  const userId = mode === "connect" ? await getUserIdFromCookies() : null;
  if (mode === "connect" && !userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) return Response.json({ error: "Google OAuth is not configured" }, { status: 503 });

  const user = userId
    ? await db.user.findUnique({ where: { id: userId }, select: { email: true } })
    : null;
  if (mode === "connect" && !user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const state = randomBytes(32).toString("base64url");
  const identifier = mode === "connect" ? `${OAUTH_STATE_IDENTIFIER}${userId}` : GOOGLE_LOGIN_IDENTIFIER;
  await db.verificationToken.deleteMany({ where: { identifier } });
  await db.verificationToken.create({
    data: {
      identifier,
      token: state,
      expires: new Date(Date.now() + OAUTH_STATE_TTL_MS),
    },
  });

  const authorization = new URL(GOOGLE_AUTHORIZATION_URL);
  authorization.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: oauthRedirectUri(request),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: `openid email profile ${GOOGLE_SCOPES.join(" ")}`,
    state,
    ...(user ? { login_hint: user.email } : {}),
  }).toString();
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorization.toString(),
      "Set-Cookie": stateCookie(request, state, OAUTH_STATE_TTL_MS / 1000),
    },
  });
}

async function finishGoogleConnection(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const state = requestUrl.searchParams.get("state") || "";
  const code = requestUrl.searchParams.get("code") || "";
  if (!state || !code || requestState(request) !== state) {
    return redirectWithStateCleared(request, "/login", { error: "google_state" });
  }

  const pending = await db.verificationToken.findUnique({ where: { token: state } });
  const isConnect = pending?.identifier.startsWith(OAUTH_STATE_IDENTIFIER) ?? false;
  const isLogin = pending?.identifier === GOOGLE_LOGIN_IDENTIFIER;
  if (!pending || pending.expires <= new Date() || (!isConnect && !isLogin)) {
    return redirectWithStateCleared(request, "/login", { error: "google_state" });
  }
  await db.verificationToken.delete({ where: { token: state } });
  const userId = isConnect ? pending.identifier.slice(OAUTH_STATE_IDENTIFIER.length) : null;
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return redirectWithStateCleared(request, "/login", { error: "google_config" });
  }

  try {
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: oauthRedirectUri(request),
      }),
    });
    if (!tokenResponse.ok) throw new Error("Google OAuth token exchange failed");
    const token = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };
    if (!token.access_token || !token.refresh_token || !token.expires_in) {
      throw new Error("Google did not return a refresh token");
    }

    const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!userInfoResponse.ok) throw new Error("Google user verification failed");
    const userInfo = (await userInfoResponse.json()) as { email?: string; email_verified?: boolean };
    const user = userId
      ? await db.user.findUnique({ where: { id: userId }, select: { id: true, email: true } })
      : userInfo.email
        ? await db.user.findUnique({
            where: { email: userInfo.email.toLowerCase() },
            select: { id: true, email: true },
          })
        : null;
    if (!user || !userInfo.email_verified || (userId && userInfo.email?.toLowerCase() !== user.email.toLowerCase())) {
      throw new Error("Google account does not match the CrawlSEO user");
    }

    await db.user.update({
      where: { id: user.id },
      data: {
        googleTokens: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: Date.now() + token.expires_in * 1000,
          tokenType: token.token_type,
          scope: token.scope,
        },
      },
    });
    if (isLogin) await createLocalSession(user.id);
    return redirectWithStateCleared(request, "/dashboard", { google: "connected" });
  } catch (error) {
    console.error("Google OAuth connection failed:", error instanceof Error ? error.message : "unknown");
    return redirectWithStateCleared(request, "/login", { error: "google" });
  }
}

export async function GET(request: Request) {
  const pathname = new URL(request.url).pathname;
  if (pathname.endsWith("/api/auth/google/start")) return startGoogleOAuth(request, "connect");
  if (pathname.endsWith("/api/auth/google/sign-in")) return startGoogleOAuth(request, "login");
  if (pathname.endsWith("/api/auth/callback/google")) return finishGoogleConnection(request);
  await signOutLocal();
}

export async function POST() {
  await signOutLocal();
}
