import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({ site: { findFirst: vi.fn(), findMany: vi.fn() } }));
const mockSession = vi.hoisted(() => ({ getUserIdFromCookies: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/session-helper", () => mockSession);

import { GET as getSites } from "@/app/api/sites/route";
import { GET as getSite } from "@/app/api/sites/[siteId]/route";

/**
 * Access is workspace-wide: the dashboard and the site routes render every site
 * in the workspace, so the API must return the same set for any signed-in
 * account. The old per-user filter made the two disagree.
 */
describe("workspace-wide site access", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists every site in the workspace for a signed-in user", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("user-1");
    mockDb.site.findMany.mockResolvedValue([]);
    const response = await getSites();
    expect(response.status).toBe(200);
    const call = mockDb.site.findMany.mock.calls[0][0] as Record<string, unknown>;
    expect(call).not.toHaveProperty("where");
  });

  it("returns a site by ID regardless of which account created it", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("user-2");
    mockDb.site.findFirst.mockResolvedValue({ id: "site-1", domain: "example.test", userId: "user-1", _count: {} });
    const response = await getSite(new Request("https://example.test"), { params: Promise.resolve({ siteId: "site-1" }) });
    expect(response.status).toBe(200);
    expect(mockDb.site.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "site-1" } }));
  });

  it("still refuses a request without a session", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue(null);
    const response = await getSites();
    expect(response.status).toBe(401);
  });
});
