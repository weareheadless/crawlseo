import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: { site: { findUnique: vi.fn() } },
  reassess: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/crawler/technical-actions", () => ({
  TechnicalActionError: class TechnicalActionError extends Error { constructor(message: string, readonly status = 409) { super(message); } },
  reassessTechnicalActionGroup: mocks.reassess,
}));

import { POST } from "@/app/api/internal/sites/[siteId]/technical-actions/reassess/route";

const priorToken = process.env.HELLOADA_PROVISIONING_TOKEN;
afterEach(() => {
  if (priorToken === undefined) delete process.env.HELLOADA_PROVISIONING_TOKEN;
  else process.env.HELLOADA_PROVISIONING_TOKEN = priorToken;
  vi.clearAllMocks();
});

const requestBody = {
  crawlId: "crawl-1", expectedBindingGeneration: 3, expectedContextRevision: "ctx-9",
  issueIds: ["issue-1"], operatorRequestId: "operator-request-1",
  reason: "Owner requested evidence reassessment",
};

describe("protected technical Action reassessment route", () => {
  it("requires the provisioning credential before database access", async () => {
    delete process.env.HELLOADA_PROVISIONING_TOKEN;
    const response = await POST(new Request("https://internal.test", { method: "POST", body: JSON.stringify(requestBody) }),
      { params: Promise.resolve({ siteId: "site-1" }) });
    expect(response.status).toBe(401);
    expect(mocks.db.site.findUnique).not.toHaveBeenCalled();
  });

  it("rejects ambiguous or duplicate issue references", async () => {
    process.env.HELLOADA_PROVISIONING_TOKEN = "provisioning-secret";
    const response = await POST(new Request("https://internal.test", { method: "POST",
      headers: { authorization: "Bearer provisioning-secret" },
      body: JSON.stringify({ ...requestBody, issueIds: ["issue-1", "issue-1"] }) }),
    { params: Promise.resolve({ siteId: "site-1" }) });
    expect(response.status).toBe(400);
    expect(mocks.reassess).not.toHaveBeenCalled();
  });

  it("scopes reassessment to the route site and returns only action identity", async () => {
    process.env.HELLOADA_PROVISIONING_TOKEN = "provisioning-secret";
    mocks.db.site.findUnique.mockResolvedValue({ projectId: "project-1" });
    mocks.reassess.mockResolvedValue({ action: { id: "action-1", revision: 2 }, reused: false });
    const response = await POST(new Request("https://internal.test", { method: "POST",
      headers: { authorization: "Bearer provisioning-secret" }, body: JSON.stringify(requestBody) }),
    { params: Promise.resolve({ siteId: "site-1" }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actionId: "action-1", revision: 2, reused: false });
    expect(mocks.reassess).toHaveBeenCalledWith({ ...requestBody, siteId: "site-1", projectId: "project-1" });
  });
});
