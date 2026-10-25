import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({ site: { findUnique: vi.fn() } }));
const mockSession = vi.hoisted(() => ({ getUserIdFromCookies: vi.fn() }));
const mockTraffic = vi.hoisted(() => ({ getDailyTraffic: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/session-helper", () => mockSession);
vi.mock("@/lib/seo-metrics", () => mockTraffic);

import { GET } from "@/app/api/sites/[siteId]/traffic/route";

describe("site traffic route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns traffic for an authenticated project-provisioned site", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("operator-1");
    // Project provisioned sites have a null userId but are visible to the
    // authenticated single operator in the dashboard.
    mockDb.site.findUnique.mockResolvedValue({ id: "project-site" });
    mockTraffic.getDailyTraffic.mockResolvedValue([
      { date: "2026-10-24", clicks: 3, impressions: 20 },
    ]);

    const response = await GET(
      new Request("https://example.test/crawlseo/api/sites/project-site/traffic?days=28"),
      { params: Promise.resolve({ siteId: "project-site" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { date: "2026-10-24", clicks: 3, impressions: 20 },
    ]);
    expect(mockDb.site.findUnique).toHaveBeenCalledWith({
      where: { id: "project-site" },
      select: { id: true },
    });
    expect(mockTraffic.getDailyTraffic).toHaveBeenCalledWith("project-site", 28);
  });

  it("continues to return traffic for an authenticated user-owned site", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("operator-1");
    mockDb.site.findUnique.mockResolvedValue({ id: "user-site" });
    mockTraffic.getDailyTraffic.mockResolvedValue([]);

    const response = await GET(
      new Request("https://example.test/crawlseo/api/sites/user-site/traffic?days=90"),
      { params: Promise.resolve({ siteId: "user-site" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([]);
    expect(mockTraffic.getDailyTraffic).toHaveBeenCalledWith("user-site", 90);
  });

  it("rejects unauthenticated requests", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue(null);

    const response = await GET(
      new Request("https://example.test/crawlseo/api/sites/project-site/traffic"),
      { params: Promise.resolve({ siteId: "project-site" }) },
    );

    expect(response.status).toBe(401);
    expect(mockDb.site.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown site", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("operator-1");
    mockDb.site.findUnique.mockResolvedValue(null);

    const response = await GET(
      new Request("https://example.test/crawlseo/api/sites/missing/traffic"),
      { params: Promise.resolve({ siteId: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(mockTraffic.getDailyTraffic).not.toHaveBeenCalled();
  });

  it("returns a server error when traffic aggregation fails", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("operator-1");
    mockDb.site.findUnique.mockResolvedValue({ id: "user-site" });
    mockTraffic.getDailyTraffic.mockRejectedValue(new Error("database unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(
      new Request("https://example.test/crawlseo/api/sites/user-site/traffic?days=90"),
      { params: Promise.resolve({ siteId: "user-site" }) },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to load traffic" });
    errorSpy.mockRestore();
  });
});
