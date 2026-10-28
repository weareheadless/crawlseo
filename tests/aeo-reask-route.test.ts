import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userId: vi.fn(), ownsSite: vi.fn(), siteFind: vi.fn(), actionFind: vi.fn(), evaluate: vi.fn(),
}));
vi.mock("@/lib/session-helper", () => ({ getUserIdFromCookies: mocks.userId }));
vi.mock("@/lib/auth/research-action-access", () => ({ userOwnsSite: mocks.ownsSite }));
vi.mock("@/lib/db", () => ({ db: { site: { findUnique: mocks.siteFind }, researchAction: { findUnique: mocks.actionFind } } }));
vi.mock("@/lib/aeo/run", () => ({ runEvaluation: mocks.evaluate }));
import * as route from "@/app/api/sites/[siteId]/aeo/re-ask/route";

const req = (body: unknown) => new Request("http://localhost/api/sites/s/aeo/re-ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = { params: Promise.resolve({ siteId: "s" }) };
describe("POST /api/sites/[siteId]/aeo/re-ask", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.userId.mockResolvedValue("u"); mocks.ownsSite.mockResolvedValue(true);
    mocks.siteFind.mockResolvedValue({ id: "s", projectId: "p", project: { status: "ACTIVE" } });
    mocks.actionFind.mockResolvedValue({ id: "a", siteId: "s", primaryQuery: "Which service?", title: "Action title" });
    mocks.evaluate.mockResolvedValue({ asked: 2, observationIds: ["o"] });
  });
  it("authenticates before access and rejects unauthenticated callers", async () => {
    mocks.userId.mockResolvedValue(null);
    const response = await route.POST(req({ actionId: "a" }), ctx);
    expect(response.status).toBe(401); expect(mocks.ownsSite).not.toHaveBeenCalled(); expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("rejects cross-site actions and does not ask providers", async () => {
    mocks.actionFind.mockResolvedValue({ id: "a", siteId: "other", primaryQuery: "q", title: "t" });
    const response = await route.POST(req({ actionId: "a" }), ctx);
    expect(response.status).toBe(400); expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("returns 404 for unknown actions and 400 for malformed payloads", async () => {
    mocks.actionFind.mockResolvedValue(null);
    expect((await route.POST(req({ actionId: "missing" }), ctx)).status).toBe(404);
    expect((await route.POST(req({} ), ctx)).status).toBe(400);
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("uses one-call-per-provider cap and primary query", async () => {
    const response = await route.POST(req({ actionId: "a" }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.evaluate).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p", siteId: "s", actionId: "a", question: "Which service?", cap: 2 }));
    expect(await response.json()).toMatchObject({ asked: 2, observationIds: ["o"] });
  });
  it("has no GET evaluation side effect", async () => {
    expect(route).not.toHaveProperty("GET");
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("rejects missing project budget configuration", async () => {
    mocks.siteFind.mockResolvedValue({ id: "s", projectId: null });
    const response = await route.POST(req({ actionId: "a" }), ctx);
    expect(response.status).toBe(409); expect(mocks.evaluate).not.toHaveBeenCalled();
  });
});
