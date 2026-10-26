import { createHmac, timingSafeEqual } from "node:crypto";

const ISSUER = "helloada";
const AUDIENCE = "crawlseo-business-knowledge-acceptance";
const MAX_TTL_SECONDS = 5 * 60;

type OwnerProof = {
  iss: typeof ISSUER;
  aud: typeof AUDIENCE;
  externalOrganizationId: string;
  projectId: string;
  documentId: string;
  revision: number;
  actorId: string;
  issuedAt: number;
  expiresAt: number;
};

export class BusinessKnowledgeOwnerProofError extends Error {
  constructor(message = "Valid HelloAda owner proof is required", readonly statusCode: 401 | 403 = 401) {
    super(message);
    this.name = "BusinessKnowledgeOwnerProofError";
  }
}

function sign(payload: string): Buffer {
  const secret = process.env.HELLOADA_PROVISIONING_TOKEN;
  if (!secret) throw new BusinessKnowledgeOwnerProofError("HelloAda owner proof issuer is not configured");
  return createHmac("sha256", secret).update(payload).digest();
}

/** Called by the trusted HelloAda server after authenticating the owner. */
export function createBusinessKnowledgeOwnerProof(
  externalOrganizationId: string,
  projectId: string,
  documentId: string,
  revision: number,
  actorId: string,
  options: { now?: number; ttlSeconds?: number } = {},
): string {
  const organization = externalOrganizationId.trim();
  const project = projectId.trim();
  const actor = actorId.trim();
  const document = documentId.trim();
  const now = Math.floor((options.now ?? Date.now()) / 1000);
  const ttl = options.ttlSeconds ?? MAX_TTL_SECONDS;
  if (!organization || !project || !document || !Number.isSafeInteger(revision) || revision < 1 || !actor || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_TTL_SECONDS) {
    throw new BusinessKnowledgeOwnerProofError("Invalid HelloAda owner proof claims");
  }
  const encoded = Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, externalOrganizationId: organization,
    projectId: project, documentId: document, revision, actorId: actor, issuedAt: now, expiresAt: now + ttl } satisfies OwnerProof)).toString("base64url");
  return `${encoded}.${sign(encoded).toString("base64url")}`;
}

export function verifyBusinessKnowledgeOwnerProof(
  token: string | null | undefined,
  expected: { externalOrganizationId: string; projectId: string; documentId: string; revision: number },
  now = Date.now(),
): { actorId: string } {
  if (!token || token.length > 2048) throw new BusinessKnowledgeOwnerProofError();
  const [encoded, provided, extra] = token.split(".");
  if (!encoded || !provided || extra !== undefined) throw new BusinessKnowledgeOwnerProofError();
  const actual = Buffer.from(provided, "base64url");
  const expectedSignature = sign(encoded);
  if (actual.length !== expectedSignature.length || !timingSafeEqual(actual, expectedSignature)) throw new BusinessKnowledgeOwnerProofError();
  let payload: Partial<OwnerProof>;
  try { payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<OwnerProof>; }
  catch { throw new BusinessKnowledgeOwnerProofError(); }
  const current = Math.floor(now / 1000);
  if (payload.iss !== ISSUER || payload.aud !== AUDIENCE || !payload.actorId ||
      !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) ||
      payload.issuedAt! > current || payload.expiresAt! <= current ||
      payload.expiresAt! - payload.issuedAt! > MAX_TTL_SECONDS) throw new BusinessKnowledgeOwnerProofError();
  if (payload.externalOrganizationId !== expected.externalOrganizationId || payload.projectId !== expected.projectId ||
      payload.documentId !== expected.documentId || payload.revision !== expected.revision) {
    throw new BusinessKnowledgeOwnerProofError("HelloAda owner proof does not match this project", 403);
  }
  if (payload.externalOrganizationId !== `${ISSUER}:${payload.actorId}`) {
    throw new BusinessKnowledgeOwnerProofError("HelloAda owner proof is not bound to the canonical owner organization", 403);
  }
  return { actorId: payload.actorId };
}
