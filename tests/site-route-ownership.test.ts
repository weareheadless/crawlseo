import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({ site: { findFirst: vi.fn(), findMany: vi.fn() } }));
const mockSession = vi.hoisted(() => ({ getUserIdFromCookies: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/session-helper", () => mockSession);

import { GET as getSites } from "@/app/api/sites/route";
import { GET as getSite } from "@/app/api/sites/[siteId]/route";

describe("cookie-authenticated site ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists only sites owned by the signed-in user", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("user-1");
    mockDb.site.findMany.mockResolvedValue([]);
    const response = await getSites();
    expect(response.status).toBe(200);
    expect(mockDb.site.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1" } }));
  });

  it("does not return another user's site by ID", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("user-2");
    mockDb.site.findFirst.mockResolvedValue(null);
    const response = await getSite(new Request("https://example.test"), { params: Promise.resolve({ siteId: "site-1" }) });
    expect(response.status).toBe(404);
    expect(mockDb.site.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "site-1", userId: "user-2" } }));
  });
});
