import { createHmac, timingSafeEqual } from "node:crypto";

const ISSUER = "helloada";
const AUDIENCE = "crawlseo-project-registration";
const PURPOSE = "project:register";
const MAX_TTL_SECONDS = 5 * 60;

type ProofPayload = {
  iss: typeof ISSUER;
  aud: typeof AUDIENCE;
  purpose: typeof PURPOSE;
  externalOrganizationId: string;
  issuedAt: number;
  expiresAt: number;
};

export class ProjectRegistrationProofError extends Error {
  constructor(message = "Invalid project registration proof", readonly statusCode: 401 | 403 = 401) {
    super(message);
    this.name = "ProjectRegistrationProofError";
  }
}

function signingKey(): string {
  const secret = process.env.HELLOADA_PROVISIONING_TOKEN;
  if (!secret) throw new ProjectRegistrationProofError("Project registration issuer is not configured");
  return secret;
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

/**
 * Sign this same compact payload in the trusted HelloAda/Site-Agent server
 * after owner authentication, using HELLOADA_PROVISIONING_TOKEN.
 */
export function createProjectRegistrationProof(
  externalOrganizationId: string,
  options: { now?: number; ttlSeconds?: number } = {},
): string {
  const org = externalOrganizationId.trim();
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const ttl = options.ttlSeconds ?? MAX_TTL_SECONDS;
  if (!org || org.length > 200 || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
    throw new ProjectRegistrationProofError("Invalid project registration proof claims");
  }
  const payload: ProofPayload = {
    iss: ISSUER,
    aud: AUDIENCE,
    purpose: PURPOSE,
    externalOrganizationId: org,
    issuedAt: now,
    expiresAt: now + ttl,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${signature(encodedPayload, signingKey()).toString("base64url")}`;
}

export function verifyProjectRegistrationProof(
  token: string | null | undefined,
  expectedExternalOrganizationId: string,
  now = Date.now(),
): string {
  if (!token || token.length > 2048) throw new ProjectRegistrationProofError();
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) throw new ProjectRegistrationProofError();
  const expected = signature(encodedPayload, signingKey());
  let actual: Buffer;
  try {
    actual = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new ProjectRegistrationProofError();
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ProjectRegistrationProofError();
  }
  let payload: Partial<ProofPayload>;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<ProofPayload>;
  } catch {
    throw new ProjectRegistrationProofError();
  }
  const currentTime = Math.floor(now / 1000);
  if (
    payload.iss !== ISSUER || payload.aud !== AUDIENCE || payload.purpose !== PURPOSE ||
    typeof payload.externalOrganizationId !== "string" ||
    !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) ||
    payload.issuedAt! > currentTime || payload.expiresAt! <= currentTime ||
    payload.expiresAt! - payload.issuedAt! > MAX_TTL_SECONDS
  ) {
    throw new ProjectRegistrationProofError();
  }
  if (payload.externalOrganizationId !== expectedExternalOrganizationId.trim()) {
    throw new ProjectRegistrationProofError("Registration proof organization does not match request", 403);
  }
  return payload.externalOrganizationId;
}
