import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const TOKEN_PREFIX = "cseo_";
const TOKEN_BYTES = 32;
const MAX_TOKEN_LENGTH = 512;

const KNOWN_SCOPES = new Set([
  "seo:read",
  "seo:research:request",
  "analytics:read",
  "crawl:read",
  "crawl:run",
  "connector:read",
  "connector:write",
]);

export type ServicePrincipalContext = {
  credentialId: string;
  servicePrincipalId: string;
  workspaceId: string;
  projectId: string;
  scopes: string[];
};

export class ServiceAuthError extends Error {
  readonly statusCode: 401 | 403;

  constructor(message: string, statusCode: 401 | 403 = 401) {
    super(message);
    this.name = "ServiceAuthError";
    this.statusCode = statusCode;
  }
}

export function hashServiceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeScopes(scopes: string[]): string[] {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  if (normalized.some((scope) => !KNOWN_SCOPES.has(scope))) {
    throw new Error("Unknown service credential scope");
  }
  return normalized;
}

function parseScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string")) {
    return [];
  }
  return value;
}

export async function createServiceCredential(
  projectId: string,
  scopes: string[],
  options: {
    idempotencyKey: string;
    principalName?: string;
    expiresAt?: Date;
    revokeExisting?: boolean;
    reissueIfReused?: boolean;
    requestHash?: string;
    transaction?: Prisma.TransactionClient;
  }
): Promise<{
  credentialId: string;
  servicePrincipalId: string;
  token: string | null;
  reused: boolean;
}> {
  const idempotencyKey = options.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > 240) {
    throw new Error("A non-empty credential idempotency key is required");
  }
  const normalizedScopes = normalizeScopes(scopes);
  const principalName = options.principalName?.trim() || "site-agent";
  const client = options.transaction ?? db;

  const principal = await client.servicePrincipal.upsert({
    where: { projectId_name: { projectId, name: principalName } },
    create: { projectId, name: principalName },
    update: {},
    select: { id: true, status: true },
  });

  if (principal.status !== "ACTIVE") {
    throw new ServiceAuthError("Service principal is revoked", 403);
  }

  const existing = await client.serviceCredential.findUnique({
    where: { issuanceIdempotencyKey: idempotencyKey },
    select: { id: true, servicePrincipalId: true, scopes: true, expiresAt: true, revokedAt: true, issuanceRequestHash: true },
  });
  if (existing) {
    if (existing.servicePrincipalId !== principal.id) {
      throw new Error("Credential idempotency key is already in use");
    }
    if (options.requestHash !== undefined && existing.issuanceRequestHash !== options.requestHash) {
      throw new Error("Credential idempotency key was already used for different request inputs");
    }
    if (options.reissueIfReused === true) {
      const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
      await client.serviceCredential.update({
        where: { id: existing.id },
        data: {
          tokenPrefix: token.slice(0, 12),
          tokenHash: hashServiceToken(token),
          scopes: normalizedScopes,
          expiresAt: options.expiresAt,
          revokedAt: null,
          secretDeliveredAt: new Date(),
        },
      });
      return {
        credentialId: existing.id,
        servicePrincipalId: principal.id,
        token,
        reused: true,
      };
    }
    const existingScopes = normalizeScopes(parseScopes(existing.scopes)).sort();
    const requestedScopes = [...normalizedScopes].sort();
    if (existingScopes.length !== requestedScopes.length
        || existingScopes.some((scope, index) => scope !== requestedScopes[index])) {
      throw new Error("Credential idempotency key was already used with different scopes");
    }
    if (existing.revokedAt || (existing.expiresAt && existing.expiresAt <= new Date())) {
      throw new ServiceAuthError("Service credential for this idempotency key is no longer active", 403);
    }
    return {
      credentialId: existing.id,
      servicePrincipalId: principal.id,
      token: null,
      reused: true,
    };
  }

  const token = `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  const now = new Date();

  if (options.revokeExisting !== false) {
    await client.serviceCredential.updateMany({
      where: { servicePrincipalId: principal.id, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  try {
    const credential = await client.serviceCredential.create({
      data: {
        servicePrincipalId: principal.id,
        tokenPrefix: token.slice(0, 12),
        tokenHash: hashServiceToken(token),
        issuanceIdempotencyKey: idempotencyKey,
        issuanceRequestHash: options.requestHash,
        scopes: normalizedScopes,
        expiresAt: options.expiresAt,
        secretDeliveredAt: now,
      },
      select: { id: true },
    });

    return {
      credentialId: credential.id,
      servicePrincipalId: principal.id,
      token,
      reused: false,
    };
  } catch (error) {
    // A concurrent retry may have won the unique idempotency key race.
    if ((error as { code?: string }).code === "P2002") {
      const winner = await client.serviceCredential.findUnique({
        where: { issuanceIdempotencyKey: idempotencyKey },
        select: { id: true, servicePrincipalId: true, scopes: true, expiresAt: true, revokedAt: true, issuanceRequestHash: true },
      });
      if (winner?.servicePrincipalId === principal.id) {
        if (options.requestHash !== undefined && winner.issuanceRequestHash !== options.requestHash) {
          throw new Error("Credential idempotency key was already used for different request inputs");
        }
        const winnerScopes = normalizeScopes(parseScopes(winner.scopes)).sort();
        const requestedScopes = [...normalizedScopes].sort();
        if (winnerScopes.length !== requestedScopes.length
            || winnerScopes.some((scope, index) => scope !== requestedScopes[index])) {
          throw new Error("Credential idempotency key was already used with different scopes");
        }
        if (winner.revokedAt || (winner.expiresAt && winner.expiresAt <= new Date())) {
          throw new ServiceAuthError("Service credential for this idempotency key is no longer active", 403);
        }
        return {
          credentialId: winner.id,
          servicePrincipalId: principal.id,
          token: null,
          reused: true,
        };
      }
    }
    throw error;
  }
}

/**
 * Issue an additive, read-only credential for capturing a migration inventory.
 * It uses its own principal and never revokes the tenant's existing MCP token.
 */
export async function createMigrationReadCredential(siteId: string, idempotencyKey: string) {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { projectId: true, project: { select: { id: true, status: true, workspace: { select: { status: true } } } } },
  });
  if (!site?.projectId || !site.project) throw new ServiceAuthError("Project site not found", 403);
  if (site.project.status !== "ACTIVE" || site.project.workspace.status !== "ACTIVE") {
    throw new ServiceAuthError("Project is not active", 403);
  }
  return createServiceCredential(site.projectId, ["connector:read"], {
    idempotencyKey,
    principalName: "helloada-migration-read",
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    revokeExisting: false,
  });
}

const RUNTIME_CONNECTOR_SCOPES = ["connector:read", "connector:write"] as const;

export class RuntimeConnectorCredentialError extends Error {
  constructor(message: string, readonly statusCode: 403 | 404 | 409) {
    super(message);
    this.name = "RuntimeConnectorCredentialError";
  }
}

export async function createRuntimeConnectorCredential(input: {
  siteId: string;
  expectedGeneration: number;
  activationPlanHash: string;
  idempotencyKey: string;
}) {
  const siteId = input.siteId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!siteId || !idempotencyKey || idempotencyKey.length > 200 || !Number.isSafeInteger(input.expectedGeneration)
      || input.expectedGeneration < 1 || !/^[a-f0-9]{64}$/i.test(input.activationPlanHash)) {
    throw new RuntimeConnectorCredentialError("Runtime connector credential request is invalid", 409);
  }
  const activationPlanHash = input.activationPlanHash.toLowerCase();
  const issuanceIdempotencyKey = `helloada-runtime:${idempotencyKey}`;
  const requestHash = createHash("sha256").update(JSON.stringify({
    siteId,
    expectedGeneration: input.expectedGeneration,
    activationPlanHash,
    scopes: RUNTIME_CONNECTOR_SCOPES,
  })).digest("hex");

  return db.$transaction(async (tx) => {
    // Serialize a repeated global key before looking up or creating its exact
    // request record. The binding row then fences against a concurrent transfer.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${issuanceIdempotencyKey}, 0))`;
    await tx.$queryRaw`SELECT "id" FROM "ConnectorBinding" WHERE "siteId" = ${siteId} FOR UPDATE`;
    const site = await tx.site.findUnique({
      where: { id: siteId },
      select: {
        id: true,
        projectId: true,
        project: { select: { status: true, workspace: { select: { status: true } } } },
      },
    });
    if (!site?.projectId || !site.project) throw new RuntimeConnectorCredentialError("Project site not found", 404);
    if (site.project.status !== "ACTIVE" || site.project.workspace.status !== "ACTIVE") {
      throw new RuntimeConnectorCredentialError("Project is not active", 403);
    }
    const binding = await tx.connectorBinding.findUnique({
      where: { siteId },
      select: { projectId: true, executor: true, generation: true, status: true },
    });
    if (!binding || binding.projectId !== site.projectId || binding.status !== "ACTIVE"
        || binding.executor !== "helloada" || binding.generation !== input.expectedGeneration) {
      throw new RuntimeConnectorCredentialError("Active HelloAda connector binding changed; refresh before issuing", 409);
    }
    return createServiceCredential(site.projectId, [...RUNTIME_CONNECTOR_SCOPES], {
      idempotencyKey: issuanceIdempotencyKey,
      principalName: "helloada-runtime",
      revokeExisting: false,
      requestHash,
      transaction: tx,
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function authenticateServiceToken(
  token: string | null | undefined
): Promise<ServicePrincipalContext> {
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    throw new ServiceAuthError("Invalid service credentials");
  }

  const tokenHash = hashServiceToken(token);
  const credential = await db.serviceCredential.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      scopes: true,
      expiresAt: true,
      revokedAt: true,
      servicePrincipal: {
        select: {
          id: true,
          status: true,
          projectId: true,
          project: {
            select: {
              workspaceId: true,
              status: true,
              workspace: { select: { status: true } },
            },
          },
        },
      },
    },
  });

  const expected = Buffer.from(credential?.tokenHash ?? "", "hex");
  const actual = Buffer.from(tokenHash, "hex");
  if (!credential || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new ServiceAuthError("Invalid service credentials");
  }
  if (
    credential.revokedAt ||
    (credential.expiresAt && credential.expiresAt <= new Date()) ||
    credential.servicePrincipal.status !== "ACTIVE"
  ) {
    throw new ServiceAuthError("Service credentials are no longer active", 401);
  }
  if (
    credential.servicePrincipal.project.status !== "ACTIVE" ||
    credential.servicePrincipal.project.workspace.status !== "ACTIVE"
  ) {
    throw new ServiceAuthError("Project is not active", 403);
  }

  void db.serviceCredential
    .update({ where: { id: credential.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    credentialId: credential.id,
    servicePrincipalId: credential.servicePrincipal.id,
    workspaceId: credential.servicePrincipal.project.workspaceId,
    projectId: credential.servicePrincipal.projectId,
    scopes: parseScopes(credential.scopes),
  };
}

export function requireProjectScope(
  principal: ServicePrincipalContext,
  scope: string
): void {
  if (!principal.scopes.includes(scope)) {
    throw new ServiceAuthError("Service credential lacks required scope", 403);
  }
}

export async function revokeServiceCredential(
  credentialId: string,
  projectId: string
): Promise<void> {
  await db.serviceCredential.updateMany({
    where: {
      id: credentialId,
      servicePrincipal: { projectId },
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
}
