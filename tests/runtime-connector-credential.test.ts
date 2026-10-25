import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));

import { createRuntimeConnectorCredential, RuntimeConnectorCredentialError } from "@/lib/auth/service-credentials";

function makeHarness() {
  let credential: Record<string, any> | null = null;
  const sqlCalls: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      sqlCalls.push(parts.join("?"));
      return [];
    }),
    site: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      projectId: where.id === "site-other" ? "project-other" : "project-1",
      project: { status: "ACTIVE", workspace: { status: "ACTIVE" } },
    })) },
    connectorBinding: { findUnique: vi.fn(async ({ where }: { where: { siteId: string } }) => ({
      projectId: where.siteId === "site-other" ? "project-other" : "project-1",
      executor: "helloada",
      generation: 7,
      status: "ACTIVE",
    })) },
    servicePrincipal: { upsert: vi.fn(async ({ where }: { where: { projectId_name: { projectId: string; name: string } } }) => ({
      id: `principal-${where.projectId_name.projectId}`,
      status: "ACTIVE",
    })) },
    serviceCredential: {
      findUnique: vi.fn(async () => credential),
      create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
        credential = { ...data, id: "credential-1", servicePrincipalId: data.servicePrincipalId, expiresAt: null, revokedAt: null };
        return { id: "credential-1" };
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(),
    },
  };
  mockDb.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => callback(tx));
  return { tx, sqlCalls, getCredential: () => credential };
}

const request = {
  siteId: "site-1",
  expectedGeneration: 7,
  activationPlanHash: "a".repeat(64),
  idempotencyKey: "activation-stable-key",
};

describe("runtime connector credential helper", () => {
  beforeEach(() => vi.clearAllMocks());

  it("issues only connector scopes additively and locks the request and binding", async () => {
    const h = makeHarness();
    const issued = await createRuntimeConnectorCredential(request);
    expect(issued.token).toMatch(/^cseo_/);
    expect(h.getCredential()?.scopes).toEqual(["connector:read", "connector:write"]);
    expect(h.getCredential()?.issuanceRequestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(h.tx.servicePrincipal.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId_name: { projectId: "project-1", name: "helloada-runtime" } },
    }));
    expect(h.tx.serviceCredential.updateMany).not.toHaveBeenCalled();
    expect(h.sqlCalls[0]).toContain("pg_advisory_xact_lock");
    expect(h.sqlCalls[1]).toContain('"ConnectorBinding"');
    expect(h.sqlCalls[1]).toContain("FOR UPDATE");
  });

  it.each([
    ["siteId", "site-other"],
    ["expectedGeneration", 8],
    ["activationPlanHash", "b".repeat(64)],
  ])("rejects reuse of the same key with altered %s", async (field, value) => {
    const h = makeHarness();
    await createRuntimeConnectorCredential(request);
    const changed = { ...request, [field]: value };
    await expect(createRuntimeConnectorCredential(changed)).rejects.toThrow(/idempotency key|different request inputs|binding changed/i);
    expect(h.tx.serviceCredential.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale binding generation before issuing", async () => {
    const h = makeHarness();
    h.tx.connectorBinding.findUnique.mockResolvedValueOnce({
      projectId: "project-1", executor: "helloada", generation: 8, status: "ACTIVE",
    } as never);
    await expect(createRuntimeConnectorCredential(request)).rejects.toMatchObject({
      name: "RuntimeConnectorCredentialError", statusCode: 409,
    });
    expect(h.tx.serviceCredential.create).not.toHaveBeenCalled();
  });

  it("rejects inactive projects and non-HelloAda bindings", async () => {
    const inactive = makeHarness();
    inactive.tx.site.findUnique.mockResolvedValueOnce({
      id: "site-1", projectId: "project-1", project: { status: "INACTIVE", workspace: { status: "ACTIVE" } },
    } as never);
    await expect(createRuntimeConnectorCredential(request)).rejects.toMatchObject({ statusCode: 403 });
    expect(inactive.tx.servicePrincipal.upsert).not.toHaveBeenCalled();

    const wrongExecutor = makeHarness();
    wrongExecutor.tx.connectorBinding.findUnique.mockResolvedValueOnce({
      projectId: "project-1", executor: "other", generation: 7, status: "ACTIVE",
    } as never);
    await expect(createRuntimeConnectorCredential(request)).rejects.toBeInstanceOf(RuntimeConnectorCredentialError);
    expect(wrongExecutor.tx.serviceCredential.create).not.toHaveBeenCalled();
  });
});
