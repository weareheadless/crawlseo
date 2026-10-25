import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  site: { findUnique: vi.fn() },
  job: { findUnique: vi.fn() },
  crawl: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
}));
const mockSession = vi.hoisted(() => ({ getUserIdFromCookies: vi.fn() }));
const mockQueue = vi.hoisted(() => ({ enqueueJob: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/session-helper", () => mockSession);
vi.mock("@/lib/jobs/queue", () => mockQueue);
vi.mock("@prisma/client", () => ({
  JobKind: { CRAWL: "CRAWL" },
  JobStatus: { COMPLETED: "COMPLETED" },
}));

import { POST } from "@/app/api/sites/[siteId]/crawl/route";
import { GET as getCrawls } from "@/app/api/sites/[siteId]/crawl/route";
import { GET as getCrawlStatus } from "@/app/api/sites/[siteId]/crawl/[crawlId]/status/route";

describe("crawl route for dashboard-visible project sites", () => {
  beforeEach(() => vi.clearAllMocks());

  it("allows the signed-in dashboard operator to queue a project-owned site's crawl", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("operator-1");
    mockDb.site.findUnique.mockResolvedValue({ userId: null, projectId: "project-1" });
    mockDb.job.findUnique.mockResolvedValue(null);
    mockDb.crawl.findFirst.mockResolvedValue(null);
    mockDb.crawl.create.mockResolvedValue({ id: "crawl-1" });
    mockQueue.enqueueJob.mockResolvedValue({ id: "job-1", status: "PENDING" });

    const response = await POST(
      new Request("https://example.test/crawlseo/api/sites/project-site/crawl", {
        method: "POST",
      }),
      { params: Promise.resolve({ siteId: "project-site" }) },
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobId: "job-1",
      crawlId: "crawl-1",
      status: "PENDING",
    });
    expect(mockQueue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      siteId: "project-site",
      kind: "CRAWL",
      payload: expect.objectContaining({ userId: "operator-1", crawlId: "crawl-1" }),
    }));
  });

  it("still requires an authenticated session", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue(null);

    const response = await POST(
      new Request("https://example.test/crawlseo/api/sites/project-site/crawl", {
        method: "POST",
      }),
      { params: Promise.resolve({ siteId: "project-site" }) },
    );

    expect(response.status).toBe(401);
    expect(mockDb.site.findUnique).not.toHaveBeenCalled();
  });

  it("lists crawls for an authenticated project-owned site", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("operator-1");
    mockDb.site.findUnique.mockResolvedValue({ id: "project-site" });
    mockDb.crawl.findMany.mockResolvedValue([{ id: "crawl-1", siteId: "project-site" }]);

    const response = await getCrawls(
      new Request("https://example.test/crawlseo/api/sites/project-site/crawl"),
      { params: Promise.resolve({ siteId: "project-site" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([{ id: "crawl-1", siteId: "project-site" }]);
    expect(mockDb.crawl.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { siteId: "project-site" },
    }));
  });

  it("returns 404 when listing crawls for an unknown site", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("operator-1");
    mockDb.site.findUnique.mockResolvedValue(null);

    const response = await getCrawls(
      new Request("https://example.test/crawlseo/api/sites/missing/crawl"),
      { params: Promise.resolve({ siteId: "missing" }) },
    );

    expect(response.status).toBe(404);
    expect(mockDb.crawl.findMany).not.toHaveBeenCalled();
  });

  it("returns status for a crawl on an authenticated project-owned site", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("operator-1");
    mockDb.site.findUnique.mockResolvedValue({ id: "project-site" });
    mockDb.crawl.findUnique.mockResolvedValue({
      id: "crawl-1",
      siteId: "project-site",
      status: "COMPLETED",
      pagesFound: 136,
      issuesFound: 4,
      healthScore: 92,
      startedAt: null,
      finishedAt: null,
    });

    const response = await getCrawlStatus(
      new Request("https://example.test/crawlseo/api/sites/project-site/crawl/crawl-1/status"),
      { params: Promise.resolve({ siteId: "project-site", crawlId: "crawl-1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: "crawl-1", status: "COMPLETED" });
  });

  it("returns 404 for unknown sites and crawls belonging to another site", async () => {
    mockSession.getUserIdFromCookies.mockResolvedValue("operator-1");
    mockDb.site.findUnique.mockResolvedValue(null);
    const unknownSite = await getCrawlStatus(
      new Request("https://example.test/crawlseo/api/sites/missing/crawl/crawl-1/status"),
      { params: Promise.resolve({ siteId: "missing", crawlId: "crawl-1" }) },
    );
    expect(unknownSite.status).toBe(404);

    mockDb.site.findUnique.mockResolvedValue({ id: "project-site" });
    mockDb.crawl.findUnique.mockResolvedValue({ id: "crawl-1", siteId: "other-site" });
    const mismatchedCrawl = await getCrawlStatus(
      new Request("https://example.test/crawlseo/api/sites/project-site/crawl/crawl-1/status"),
      { params: Promise.resolve({ siteId: "project-site", crawlId: "crawl-1" }) },
    );
    expect(mismatchedCrawl.status).toBe(404);
  });
});
