import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  servicePrincipal: { upsert: vi.fn() },
  serviceCredential: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));

import {
  authenticateServiceToken,
  createServiceCredential,
  hashServiceToken,
  requireProjectScope,
  type ServicePrincipalContext,
} from "@/lib/auth/service-credentials";

describe("service credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores only a hash and returns plaintext on first issuance", async () => {
    mockDb.servicePrincipal.upsert.mockResolvedValue({ id: "principal-1", status: "ACTIVE" });
    mockDb.serviceCredential.findUnique.mockResolvedValue(null);
    mockDb.serviceCredential.updateMany.mockResolvedValue({ count: 0 });

    let stored: Record<string, unknown> | undefined;
    mockDb.serviceCredential.create.mockImplementation(
      async (input: { data: Record<string, unknown> }) => {
        stored = input.data;
        return { id: "credential-1" };
      }
    );

    const result = await createServiceCredential(
      "project-1",
      ["seo:read", "crawl:run"],
      { idempotencyKey: "issue-1" }
    );

    expect(result.token).toMatch(/^cseo_/);
    expect(stored?.tokenHash).toBe(hashServiceToken(result.token as string));
    expect(JSON.stringify(stored)).not.toContain(result.token as string);
    expect(stored?.scopes).toEqual(["seo:read", "crawl:run"]);
  });

  it("does not issue a second plaintext token for an idempotent retry", async () => {
    mockDb.servicePrincipal.upsert.mockResolvedValue({ id: "principal-1", status: "ACTIVE" });
    mockDb.serviceCredential.findUnique.mockResolvedValue({
      id: "credential-1",
      servicePrincipalId: "principal-1",
    });

    const result = await createServiceCredential(
      "project-1",
      ["seo:read"],
      { idempotencyKey: "issue-1" }
    );

    expect(result).toEqual({
      credentialId: "credential-1",
      servicePrincipalId: "principal-1",
      token: null,
      reused: true,
    });
    expect(mockDb.serviceCredential.create).not.toHaveBeenCalled();
    expect(mockDb.serviceCredential.updateMany).not.toHaveBeenCalled();
  });

  it("can rotate a lost token only when recovery explicitly requests it", async () => {
    mockDb.servicePrincipal.upsert.mockResolvedValue({ id: "principal-1", status: "ACTIVE" });
    mockDb.serviceCredential.findUnique.mockResolvedValue({
      id: "credential-1",
      servicePrincipalId: "principal-1",
    });
    mockDb.serviceCredential.update.mockResolvedValue({ id: "credential-1" });

    const result = await createServiceCredential(
      "project-1",
      ["seo:read"],
      { idempotencyKey: "issue-1", reissueIfReused: true }
    );

    expect(result.token).toMatch(/^cseo_/);
    expect(result.reused).toBe(true);
    expect(mockDb.serviceCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "credential-1" },
        data: expect.objectContaining({ tokenHash: hashServiceToken(result.token as string) }),
      })
    );
  });

  it("resolves a valid token to its project and rejects unknown tokens", async () => {
    const token = "cseo_valid-token";
    mockDb.serviceCredential.findUnique.mockResolvedValue({
      id: "credential-1",
      tokenHash: hashServiceToken(token),
      scopes: ["seo:read"],
      expiresAt: null,
      revokedAt: null,
      servicePrincipal: {
        id: "principal-1",
        status: "ACTIVE",
        projectId: "project-1",
        project: {
          workspaceId: "workspace-1",
          status: "ACTIVE",
          workspace: { status: "ACTIVE" },
        },
      },
    });
    mockDb.serviceCredential.update.mockResolvedValue({});

    await expect(authenticateServiceToken(token)).resolves.toMatchObject({
      credentialId: "credential-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      scopes: ["seo:read"],
    });

    mockDb.serviceCredential.findUnique.mockResolvedValue(null);
    await expect(authenticateServiceToken("cseo_unknown")).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("enforces scopes at the project boundary", () => {
    const principal = { scopes: ["seo:read"] } as ServicePrincipalContext;
    expect(() => requireProjectScope(principal, "seo:read")).not.toThrow();
    expect(() => requireProjectScope(principal, "crawl:run")).toThrowError(
      "Service credential lacks required scope"
    );
  });
});
