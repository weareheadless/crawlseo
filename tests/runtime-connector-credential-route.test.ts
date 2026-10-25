import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockIssue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/service-credentials", () => ({
  createRuntimeConnectorCredential: mockIssue,
  RuntimeConnectorCredentialError: class RuntimeConnectorCredentialError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) { super(message); this.statusCode = statusCode; }
  },
}));

import { POST } from "@/app/api/internal/sites/[siteId]/runtime-connector-credentials/route";
import { DEFAULT_PROVISIONING_SERVICE_SCOPES } from "@/lib/projects/provision-project";

it("keeps legacy provisioning on its original five MCP scopes", () => {
  expect(DEFAULT_PROVISIONING_SERVICE_SCOPES).toEqual([
    "seo:read", "seo:research:request", "analytics:read", "crawl:read", "crawl:run",
  ]);
});

const body = {
  expectedGeneration: 7,
  activationPlanHash: "a".repeat(64),
  idempotencyKey: "activation-site-1-7",
};
function request(payload: unknown = body, token = "test-control-token") {
  return new Request("https://crawlseo.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("runtime connector credential route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("HELLOADA_PROVISIONING_TOKEN", "test-control-token");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires control-plane authentication before issuing a credential", async () => {
    const response = await POST(request(body, "wrong"), { params: Promise.resolve({ siteId: "site-1" }) });
    expect(response.status).toBe(401);
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it("issues only the fixed connector scopes and returns no token again on reuse", async () => {
    mockIssue.mockResolvedValue({ credentialId: "cred-1", servicePrincipalId: "principal-1", token: "cseo_once", reused: false });
    const first = await POST(request(), { params: Promise.resolve({ siteId: "site-1" }) });
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(await first.json()).toMatchObject({ scopes: ["connector:read", "connector:write"], token: "cseo_once", reused: false });
    expect(mockIssue).toHaveBeenCalledWith({ siteId: "site-1", ...body });

    mockIssue.mockResolvedValue({ credentialId: "cred-1", servicePrincipalId: "principal-1", token: null, reused: true });
    const retry = await POST(request(), { params: Promise.resolve({ siteId: "site-1" }) });
    expect(await retry.json()).toMatchObject({ scopes: ["connector:read", "connector:write"], token: null, reused: true });
  });

  it("rejects caller-selected scopes and malformed requests", async () => {
    const response = await POST(request({ ...body, scopes: ["connector:write"] }), { params: Promise.resolve({ siteId: "site-1" }) });
    expect(response.status).toBe(400);
    expect(mockIssue).not.toHaveBeenCalled();
  });

  it.each([
    ["idempotency key was already used for different request inputs", 409],
    ["Active HelloAda connector binding changed; refresh before issuing", 409],
    ["Project is not active", 403],
  ])("maps issuance rejection to HTTP %i", async (message, status) => {
    mockIssue.mockRejectedValue(new (await import("@/lib/auth/service-credentials")).RuntimeConnectorCredentialError(message, status as 403 | 409));
    const response = await POST(request(), { params: Promise.resolve({ siteId: "site-1" }) });
    expect(response.status).toBe(status);
  });
});
