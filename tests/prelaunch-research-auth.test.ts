import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ scopes: ["seo:research:request"] as string[], called: false, AuthError: class extends Error { constructor(readonly statusCode: number, message: string) { super(message); } } }));

vi.mock("@/lib/auth/service-credentials", () => ({
  ServiceAuthError: state.AuthError,
  authenticateServiceToken: vi.fn(async () => ({ credentialId: "credential", servicePrincipalId: "principal", workspaceId: "workspace", projectId: "project-1", scopes: state.scopes })),
  requireProjectScope: vi.fn((principal: { scopes: string[] }, scope: string) => {
    if (!principal.scopes.includes(scope)) throw new state.AuthError(403, "Service credential lacks required scope");
  }),
}));
vi.mock("@/lib/dataforseo/prelaunch", () => ({ requestPrelaunchResearch: vi.fn(async () => { state.called = true; return { status: "accepted" }; }) }));
vi.mock("@/lib/dataforseo/research", () => ({
  getResearchReport: vi.fn(),
  ResearchValidationError: class ResearchValidationError extends Error {},
  ResearchNotFoundError: class ResearchNotFoundError extends Error {},
}));

import { POST } from "@/app/api/projects/[projectId]/prelaunch-research/route";

describe("prelaunch research service scope", () => {
  beforeEach(() => { state.scopes = ["seo:research:request"]; state.called = false; });
  const call = () => POST(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer project-token", "content-type": "application/json" }, body: JSON.stringify({ brief: {}, idempotency_key: "request-1" }) }), { params: Promise.resolve({ projectId: "project-1" }) });

  it("allows a newly provisioned request scope through authorization", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(state.called).toBe(true);
  });

  it("rejects a credential without request scope", async () => {
    state.scopes = ["seo:read"];
    expect((await call()).status).toBe(403);
    expect(state.called).toBe(false);
  });
});
