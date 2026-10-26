import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";

const state = vi.hoisted(() => ({
  workspaces: new Map<string, { id: string; externalOrganizationId: string; name: string }>(),
  projects: new Map<string, { id: string; workspaceId: string; externalProjectId: string; name: string; status: string; registrationRequestHash?: string | null; registrationDomain?: string | null }>(),
  receipts: new Map<string, { requestHash: string; result: unknown }>(),
  credentials: new Map<string, string>(),
  authBinding: { workspaceId: "workspace-1", projectId: "project-1" },
  authScopes: ["project:read", "document:read", "document:write"],
  nextId: 0,
  lock: Promise.resolve(),
}));

vi.mock("@/lib/db", () => {
  const workspace = {
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = state.workspaces.get(where.externalOrganizationId);
      const row = existing
        ? (existing.name = update.name, existing)
        : { id: `workspace-${++state.nextId}`, ...create };
      state.workspaces.set(row.externalOrganizationId, row);
      return { id: row.id };
    }),
    findUnique: vi.fn(async ({ where }: any) => state.workspaces.get(where.externalOrganizationId) ?? null),
  };
  const project = {
    findUnique: vi.fn(async ({ where }: any) => {
      if (where.id) {
        const row = [...state.projects.values()].find((candidate) => candidate.id === where.id);
        if (!row) return null;
        const workspace = [...state.workspaces.values()].find((candidate) => candidate.id === row.workspaceId);
        return { ...row, workspace: { externalOrganizationId: workspace?.externalOrganizationId, name: workspace?.name } };
      }
      const key = `${where.workspaceId_externalProjectId.workspaceId}:${where.workspaceId_externalProjectId.externalProjectId}`;
      return state.projects.get(key) ?? null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const row = { id: `project-${++state.nextId}`, ...data, status: "ACTIVE" };
      state.projects.set(`${row.workspaceId}:${row.externalProjectId}`, row);
      return { id: row.id };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = [...state.projects.values()].find((candidate) => candidate.id === where.id)!;
      Object.assign(row, data);
      return { id: row.id };
    }),
  };
  const projectRegistrationReceipt = {
    findUnique: vi.fn(async ({ where }: any) => state.receipts.get(
      `${where.externalOrganizationId_operation_idempotencyKey.externalOrganizationId}:${where.externalOrganizationId_operation_idempotencyKey.operation}:${where.externalOrganizationId_operation_idempotencyKey.idempotencyKey}`,
    ) ?? null),
    create: vi.fn(async ({ data }: any) => {
      const key = `${data.externalOrganizationId}:${data.operation}:${data.idempotencyKey}`;
      if (state.receipts.has(key)) throw Object.assign(new Error("unique"), { code: "P2002" });
      state.receipts.set(key, { requestHash: data.requestHash, result: data.result });
    }),
  };
  const client = { workspace, project, projectRegistrationReceipt };
  const db = {
    ...client,
    $transaction: vi.fn(async (run: (tx: typeof client) => unknown) => {
      const previous = state.lock;
      let release!: () => void;
      state.lock = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await run(client); } finally { release(); }
    }),
  };
  return { db };
});
vi.mock("@/lib/auth/service-credentials", () => ({
  authenticateServiceToken: vi.fn(async (token: string) => ({
    credentialId: "credential-1", servicePrincipalId: "principal-1", ...state.authBinding,
    scopes: token === "read-token" ? state.authScopes : [],
  })),
  requireProjectScope: vi.fn((principal: { scopes: string[] }, scope: string) => {
    if (!principal.scopes.includes(scope)) throw new Error("Service credential lacks required scope");
  }),
  createServiceCredential: vi.fn(async (_projectId: string, _scopes: string[], options: { idempotencyKey: string }) => {
    const existing = state.credentials.get(options.idempotencyKey);
    if (existing) return { credentialId: "credential-1", servicePrincipalId: "principal-1", token: null, reused: true };
    const token = options.idempotencyKey.startsWith("project-registration-recovery:")
      ? `cseo_recovered_secret_${state.credentials.size + 1}` : "cseo_registration_secret";
    state.credentials.set(options.idempotencyKey, token);
    return { credentialId: "credential-1", servicePrincipalId: "principal-1", token, reused: false };
  }),
}));

import { registerProject, ProjectRegistrationError } from "@/lib/projects/register-project";
import { createProjectRegistrationProof, ProjectRegistrationProofError, verifyProjectRegistrationProof } from "@/lib/auth/project-registration-proof";
import { POST as registerPost } from "@/app/api/projects/register/route";
import { POST as recoverPost } from "@/app/api/projects/registration-credential/route";
import { GET as identityGet } from "@/app/api/projects/identity/route";

const input = {
  schemaVersion: "business-knowledge/1" as const,
  kind: "project_registration" as const,
  externalOrganizationId: "org-1",
  workspaceName: "Acme",
  externalProjectId: "helloada:record:42",
  displayName: "Prelaunch",
  origin: { system: "helloada", externalId: "record:42" },
  idempotencyKey: "request-1",
  requestedCredentialScope: { audience: "business-knowledge" as const,
    requestedPermissions: ["project:read", "document:read", "document:write"] },
};
const businessKnowledgeSchema = JSON.parse(readFileSync(resolve(process.cwd(), "contracts/business-knowledge-v1.schema.json"), "utf8"));
const validateBusinessKnowledge = new Ajv({ allErrors: true }).compile(businessKnowledgeSchema);

describe("domainless project registration", () => {
  beforeEach(() => {
    state.workspaces.clear();
    state.projects.clear();
    state.receipts.clear();
    state.credentials.clear();
    state.authBinding = { workspaceId: "workspace-1", projectId: "project-1" };
    state.authScopes = ["project:read", "document:read", "document:write"];
    state.nextId = 0;
    state.lock = Promise.resolve();
    vi.stubEnv("HELLOADA_PROVISIONING_TOKEN", "a-secret-used-only-by-the-existing-provisioning-path");
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", "a-separate-key-used-only-for-encrypted-project-tokens");
  });

  it("creates one project under concurrent identical registration and replays its original identity", async () => {
    const [first, concurrent] = await Promise.all([registerProject(input), registerProject(input)]);
    expect(first.identity).toEqual(concurrent.identity);
    expect([first.credentialToken, concurrent.credentialToken].filter(Boolean)).toHaveLength(1);
    expect(state.projects.size).toBe(1);
    expect(state.receipts.size).toBe(1);
    expect(first.identity.externalProjectId).toBe("helloada:record:42");
    expect(first.identity.credentialScope.permissions).toEqual(["document:read", "document:write", "project:read"]);
    expect(first.credentialToken).toBe("cseo_registration_secret");
    expect([...state.receipts.values()][0]!.result).not.toHaveProperty("credentialToken");
    await expect(registerProject(input)).resolves.toEqual({ identity: first.identity, credentialToken: null });
  });

  it("rejects reuse of an idempotency key with changed payload", async () => {
    await registerProject(input);
    await expect(registerProject({ ...input, displayName: "Changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("stores optional domain metadata without creating a Site and binds it to the origin payload", async () => {
    const result = await registerProject({ ...input, domain: "www.acme.example." });
    expect([...state.projects.values()][0]!.registrationDomain).toBe("www.acme.example");
    expect([...state.projects.values()][0]).not.toHaveProperty("siteId");
    await expect(registerProject({ ...input, domain: "other.example" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("limits non-HelloAda origin profiles to read permissions even when write is requested", async () => {
    const result = await registerProject({
      ...input,
      externalProjectId: "partner:record:42",
      origin: { system: "partner", externalId: "record:42" },
    });
    expect(result.identity.credentialScope.permissions).toEqual(["document:read", "project:read"]);
  });

  it("rejects a conflicting registration for an existing origin under a new key", async () => {
    await registerProject(input);
    await expect(registerProject({ ...input, idempotencyKey: "request-2", displayName: "Different project" }))
      .rejects.toMatchObject({ code: "ORIGIN_CONFLICT" });
  });

  it("rejects ambiguous origin namespaces and empty external IDs", async () => {
    await expect(registerProject({ ...input, externalProjectId: "helloada:tenant:x", origin: { system: "helloada:tenant", externalId: "x" } }))
      .rejects.toBeInstanceOf(ProjectRegistrationError);
    await expect(registerProject({ ...input, origin: { system: "helloada", externalId: " " } }))
      .rejects.toBeInstanceOf(ProjectRegistrationError);
  });

  it("returns schema-shaped registration JSON and sends the one-time credential out of band", async () => {
    const proof = createProjectRegistrationProof(input.externalOrganizationId);
    const response = await registerPost(new Request("https://example.test/api/projects/register", {
      method: "POST",
      headers: { authorization: `Bearer ${proof}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-crawlseo-service-credential")).toBe("cseo_registration_secret");
    const result = await response.json();
    expect(result).toMatchObject({ schemaVersion: "business-knowledge/1", kind: "project_registration_result" });
    expect(result).not.toHaveProperty("credentialToken");
    expect(validateBusinessKnowledge(result), JSON.stringify(validateBusinessKnowledge.errors)).toBe(true);

    const retry = await registerPost(new Request("https://example.test/api/projects/register", {
      method: "POST",
      headers: { authorization: `Bearer ${proof}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    expect(await retry.json()).toEqual(result);
    expect(retry.headers.get("x-crawlseo-service-credential")).toBeNull();
  });

  it("blocks a proof from another organization before creating a project", async () => {
    const proof = createProjectRegistrationProof("org-other");
    const response = await registerPost(new Request("https://example.test/api/projects/register", {
      method: "POST", headers: { authorization: `Bearer ${proof}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ schemaVersion: "business-knowledge/1", kind: "error", code: "FORBIDDEN", retryable: false });
    expect(state.projects.size).toBe(0);
  });

  it("rejects malformed credential-recovery JSON with the canonical validation envelope", async () => {
    const response = await recoverPost(new Request("https://example.test/api/projects/registration-credential", {
      method: "POST", headers: { "content-type": "application/json" }, body: "null",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      schemaVersion: "business-knowledge/1", kind: "error", code: "VALIDATION_FAILED", retryable: false,
    });
  });

  it("reads the canonical project identity under its project-scoped credential without requiring a Site", async () => {
    const registered = await registerProject(input);
    state.authBinding = { workspaceId: registered.identity.workspaceId, projectId: registered.identity.projectId };
    const response = await identityGet(new Request(`https://example.test/api/projects/identity?projectId=${registered.identity.projectId}`, {
      headers: { authorization: "Bearer read-token" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(registered.identity);
    const wrongProject = await identityGet(new Request("https://example.test/api/projects/identity?projectId=project-other", {
      headers: { authorization: "Bearer read-token" },
    }));
    expect(wrongProject.status).toBe(404);
  });

  it("recovers a lost credential only for the organization that owns the persisted project", async () => {
    const registered = await registerProject(input);
    const receipt = [...state.receipts.values()][0]!;
    const proof = createProjectRegistrationProof(input.externalOrganizationId);
    const body = { externalOrganizationId: input.externalOrganizationId,
      registrationIdempotencyKey: input.idempotencyKey, recoveryIdempotencyKey: "recover-credential-1" };
    const response = await recoverPost(new Request("https://example.test/api/projects/registration-credential", {
      method: "POST", headers: { authorization: `Bearer ${proof}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-crawlseo-service-credential")).toBe("cseo_recovered_secret_2");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(receipt.result).toMatchObject({ projectId: registered.identity.projectId });

    const retry = await recoverPost(new Request("https://example.test/api/projects/registration-credential", {
      method: "POST", headers: { authorization: `Bearer ${proof}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(await retry.json()).toEqual(await response.clone().json());
    expect(retry.headers.get("x-crawlseo-service-credential")).toBeNull();

    const freshRecovery = await recoverPost(new Request("https://example.test/api/projects/registration-credential", {
      method: "POST", headers: { authorization: `Bearer ${proof}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, recoveryIdempotencyKey: "recover-credential-2" }),
    }));
    expect(freshRecovery.headers.get("x-crawlseo-service-credential")).toBe("cseo_recovered_secret_3");

    const wrongOrgReceiptKey = `org-2:register_project_v1:${input.idempotencyKey}`;
    state.receipts.set(wrongOrgReceiptKey, receipt);
    const wrongOrgProof = createProjectRegistrationProof("org-2");
    const denied = await recoverPost(new Request("https://example.test/api/projects/registration-credential", {
      method: "POST", headers: { authorization: `Bearer ${wrongOrgProof}`, "content-type": "application/json" },
      body: JSON.stringify({ ...body, externalOrganizationId: "org-2" }),
    }));
    expect(denied.status).toBe(404);
  });
});

describe("project registration proof", () => {
  beforeEach(() => vi.stubEnv("HELLOADA_PROVISIONING_TOKEN", "a-secret-used-only-by-the-existing-provisioning-path"));

  it("binds a short-lived proof to organization, audience, and registration purpose", () => {
    const proof = createProjectRegistrationProof("org-1", { now: 1_000_000, ttlSeconds: 60 });
    expect(verifyProjectRegistrationProof(proof, "org-1", 1_030_000)).toBe("org-1");
    expect(() => verifyProjectRegistrationProof(proof, "org-2", 1_030_000)).toThrow(ProjectRegistrationProofError);
    expect(() => verifyProjectRegistrationProof(proof, "org-1", 1_060_000)).toThrow(ProjectRegistrationProofError);
    vi.stubEnv("HELLOADA_PROVISIONING_TOKEN", "a-different-existing-secret");
    expect(() => verifyProjectRegistrationProof(proof, "org-1", 1_030_000)).toThrow(ProjectRegistrationProofError);
  });

  it("rejects malformed and tampered proofs", () => {
    const proof = createProjectRegistrationProof("org-1");
    expect(() => verifyProjectRegistrationProof(`${proof}x`, "org-1")).toThrow(ProjectRegistrationProofError);
    expect(() => verifyProjectRegistrationProof("not-a-token", "org-1")).toThrow(ProjectRegistrationProofError);
  });

  it("rejects a validly signed proof issued for another purpose", () => {
    const claims = Buffer.from(JSON.stringify({
      iss: "helloada", aud: "crawlseo-project-registration", purpose: "project:admin",
      externalOrganizationId: "org-1", issuedAt: 1000, expiresAt: 1060,
    })).toString("base64url");
    const signature = createHmac("sha256", process.env.HELLOADA_PROVISIONING_TOKEN!).update(claims).digest("base64url");
    expect(() => verifyProjectRegistrationProof(`${claims}.${signature}`, "org-1", 1_010_000))
      .toThrow(ProjectRegistrationProofError);
  });
});
