import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/crawler/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/crawler/engine")>()),
  assertPublicDomain: vi.fn(async () => undefined),
}));
vi.mock("@/lib/dataforseo/platform-credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dataforseo/platform-credentials")>()),
  ensurePlatformDataForSeoCredential: vi.fn(async () => null),
}));

import { JobKind } from "@prisma/client";
import { db } from "@/lib/db";
import { authenticateServiceToken } from "@/lib/auth/service-credentials";
import { provisionProject } from "@/lib/projects/provision-project";
import { registerProject, ProjectRegistrationError, type RegisterProjectInput } from "@/lib/projects/register-project";
import { assertPublicDomain } from "@/lib/crawler/engine";
import { ensurePlatformDataForSeoCredential } from "@/lib/dataforseo/platform-credentials";

const enabled = process.env.RUN_PROJECT_REGISTRATION_DB_TESTS === "1";
const fixtureDatabase = (() => {
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    return url.protocol.startsWith("postgres") && new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname) &&
      url.username === "codex" && url.pathname === "/unified_intelligence_validation";
  } catch {
    return false;
  }
})();
if (enabled && !fixtureDatabase) {
  throw new Error("RUN_PROJECT_REGISTRATION_DB_TESTS requires the disposable PostgreSQL fixture DATABASE_URL");
}

const dbDescribe = enabled ? describe : describe.skip;
const ownedOrganizationIds = new Set<string>();

function newRegistration(overrides: Partial<RegisterProjectInput> = {}): RegisterProjectInput {
  const unique = randomUUID().replaceAll("-", "");
  const externalOrganizationId = `ui002-db-${unique}`;
  ownedOrganizationIds.add(externalOrganizationId);
  return {
    schemaVersion: "business-knowledge/1",
    kind: "project_registration",
    externalOrganizationId,
    workspaceName: `UI-002 integration ${unique}`,
    externalProjectId: `helloada:${unique}`,
    displayName: `Prelaunch ${unique}`,
    domain: null,
    origin: { system: "helloada", externalId: unique },
    idempotencyKey: `register-${unique}`,
    requestedCredentialScope: {
      audience: "business-knowledge",
      requestedPermissions: ["project:read", "document:read", "document:write"],
    },
    ...overrides,
  };
}

function provisionInput(registration: RegisterProjectInput, domain: string, existingSiteId?: string) {
  return {
    externalOrganizationId: registration.externalOrganizationId,
    workspaceName: registration.workspaceName,
    externalProjectId: registration.externalProjectId,
    projectName: registration.displayName,
    domain,
    gscProperty: `sc-domain:${domain}`,
    ga4PropertyId: "12345678",
    serviceAccountCredentials: {
      client_email: "ui002-fixture@example.invalid",
      private_key: "-----BEGIN PRIVATE KEY-----fixture-only-----END PRIVATE KEY-----",
      project_id: "ui002-fixture",
    },
    serviceCredentialIdempotencyKey: `provision-${registration.idempotencyKey}`,
    domainVerificationMethod: "verified_gsc",
    ...(existingSiteId ? { existingSiteId } : {}),
  };
}

dbDescribe("domainless registration on disposable PostgreSQL", () => {
  beforeAll(async () => {
    await db.$connect();
  });

  afterEach(async () => {
    if (ownedOrganizationIds.size) {
      await db.workspace.deleteMany({ where: { externalOrganizationId: { in: [...ownedOrganizationIds] } } });
      ownedOrganizationIds.clear();
    }
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("is race-safe, replays without rotating credentials, and leaves site/provider tables empty", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", "ui002-postgres-integration-only-encryption-key");
    const input = newRegistration();
    const results = await Promise.all([
      registerProject(input),
      registerProject(input),
      registerProject(input),
    ]);
    const projectIds = new Set(results.map(({ identity }) => identity.projectId));
    expect(projectIds.size).toBe(1);
    const projectId = results[0]!.identity.projectId;
    const workspaceId = results[0]!.identity.workspaceId;
    const initialToken = results.map(({ credentialToken }) => credentialToken).find((token) => token !== null);
    expect(initialToken).toBeTruthy();
    expect(results.filter(({ credentialToken }) => credentialToken).length).toBe(1);

    const replay = await registerProject(input);
    expect(replay.identity).toEqual(results[0]!.identity);
    expect(replay.credentialToken).toBeNull();
    await expect(authenticateServiceToken(initialToken)).resolves.toMatchObject({ projectId, workspaceId });
    expect(await db.project.count({ where: { id: projectId } })).toBe(1);
    expect(await db.projectRegistrationReceipt.count({ where: { externalOrganizationId: input.externalOrganizationId } })).toBe(1);
    expect(await db.servicePrincipal.count({ where: { projectId, name: "business-knowledge" } })).toBe(1);
    expect(await db.serviceCredential.count({ where: { servicePrincipal: { projectId, name: "business-knowledge" } } })).toBe(1);
    expect(await db.site.count({ where: { projectId } })).toBe(0);
    expect(await db.googleConnection.count({ where: { workspaceId } })).toBe(0);
    expect(await db.job.count({ where: { projectId } })).toBe(0);
  }, 60_000);

  it("rejects changed requests while allowing the same external origin in another organization", async () => {
    const original = newRegistration();
    const first = await registerProject(original);
    await expect(registerProject({ ...original, domain: "changed.example" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(registerProject({ ...original, idempotencyKey: `different-${randomUUID()}`, displayName: "Changed origin data" }))
      .rejects.toMatchObject({ code: "ORIGIN_CONFLICT" });

    const otherOrganization = newRegistration({
      externalProjectId: original.externalProjectId,
      origin: original.origin,
    });
    const second = await registerProject(otherOrganization);
    expect(second.identity.projectId).not.toBe(first.identity.projectId);
    expect(second.identity.workspaceId).not.toBe(first.identity.workspaceId);
    expect(await db.project.count({ where: { externalProjectId: original.externalProjectId } })).toBe(2);
  });

  it("attaches a real site to the registered project and refuses to reparent another project's site", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", "ui002-postgres-integration-only-encryption-key");
    const unique = randomUUID().replaceAll("-", "");
    const domain = `site-${unique}.example.test`;
    const registration = newRegistration({ domain });
    const registered = await registerProject(registration);
    const beforeHash = await db.project.findUniqueOrThrow({
      where: { id: registered.identity.projectId }, select: { registrationRequestHash: true },
    });
    expect(await db.site.count({ where: { projectId: registered.identity.projectId } })).toBe(0);
    expect(await db.googleConnection.count({ where: { workspaceId: registered.identity.workspaceId } })).toBe(0);

    const provisioned = await provisionProject(provisionInput(registration, domain));
    expect(provisioned.projectId).toBe(registered.identity.projectId);
    expect(await db.site.count({ where: { projectId: registered.identity.projectId, domain } })).toBe(1);
    expect(await db.project.findUniqueOrThrow({
      where: { id: registered.identity.projectId }, select: { registrationRequestHash: true },
    })).toEqual(beforeHash);
    expect(await db.projectRegistrationReceipt.count({ where: { externalOrganizationId: registration.externalOrganizationId } })).toBe(1);
    expect(await db.job.count({ where: { projectId: registered.identity.projectId, kind: { in: [JobKind.GSC_SYNC, JobKind.GA4_SYNC] } } })).toBe(2);
    expect(vi.mocked(assertPublicDomain)).toHaveBeenCalledWith(domain);
    expect(vi.mocked(ensurePlatformDataForSeoCredential)).toHaveBeenCalled();

    const other = newRegistration();
    const otherWorkspace = await db.workspace.create({ data: {
      externalOrganizationId: other.externalOrganizationId,
      name: other.workspaceName,
    } });
    const otherProject = await db.project.create({ data: {
      workspaceId: otherWorkspace.id,
      externalProjectId: other.externalProjectId,
      name: other.displayName,
    } });
    const foreignSite = await db.site.create({ data: { projectId: otherProject.id, domain } });
    await expect(provisionProject(provisionInput(registration, domain, foreignSite.id))).rejects.toThrow(
      "Existing site record already belongs to a different project",
    );
    await expect(db.site.findUniqueOrThrow({ where: { id: foreignSite.id }, select: { projectId: true } }))
      .resolves.toEqual({ projectId: otherProject.id });
  }, 60_000);
});
