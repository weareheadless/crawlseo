import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/service-credentials", () => ({
  createMigrationReadCredential: mockIssue,
  ServiceAuthError: class ServiceAuthError extends Error {
    statusCode: number;
    constructor(message: string, statusCode = 403) { super(message); this.statusCode = statusCode; }
  },
}));

import { POST } from "@/app/api/internal/sites/[siteId]/connector-credentials/route";

describe("additive migration credential route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HELLOADA_PROVISIONING_TOKEN", "test-control-token");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("requires control-plane authentication before issuing a credential", async () => {
    const response = await POST(new Request("https://crawlseo.test", { method: "POST", body: "{}" }), {
      params: Promise.resolve({ siteId: "site-1" }),
    });
    expect(response.status).toBe(401);
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("only returns the fixed read scope and does not support caller-selected scopes", async () => {
    mockIssue.mockResolvedValue({
      credentialId: "credential-1", servicePrincipalId: "principal-1", token: "cseo_once",
      reused: false,
    });
    const response = await POST(new Request("https://crawlseo.test", {
      method: "POST",
      headers: { Authorization: "Bearer test-control-token", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "inventory-1", scopes: ["connector:write"] }),
    }), { params: Promise.resolve({ siteId: "site-1" }) });
    expect(response.status).toBe(400);
    expect(mockIssue).not.toHaveBeenCalled();

    const valid = await POST(new Request("https://crawlseo.test", {
      method: "POST",
      headers: { Authorization: "Bearer test-control-token", "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "inventory-1" }),
    }), { params: Promise.resolve({ siteId: "site-1" }) });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ scopes: ["connector:read"], token: "cseo_once", reused: false });
    expect(mockIssue).toHaveBeenCalledWith("site-1", "inventory-1");
  });
});
