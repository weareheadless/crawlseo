import { describe, expect, it, vi } from "vitest";

import {
  COMPETITOR_CACHE_DAYS,
  competitorPageGap,
  competitorReferences,
  readCompetitorPage,
} from "@/lib/funnel/competitor-page-gap";

/**
 * CMP-006's fetching rules.
 *
 * The boundaries are what this file protects, because each one is a way a well-meant
 * crawler becomes a problem for somebody else:
 *  - only URLs we actually saw ranking above us (from CMP-003's rows),
 *  - a page read once is not read again for 30 days,
 *  - a failure is recorded as unreadable, not thrown, so the other two still compare,
 *  - a page that is not HTML, or is not a 2xx, is not parsed as one.
 */

const NOW = new Date("2026-11-24T00:00:00Z");

type Row = { id: string; observedAt: Date; dimensions: Record<string, unknown>; metrics: Record<string, unknown> };

function mockDb(input: { competitorRanks?: Row[]; onpage?: Row[] }) {
  return {
    evidenceRecord: {
      findMany: vi.fn(async (args: { where: { kind: string; observedAt?: { gte: Date } } }) => {
        if (args.where.kind === "competitor_rank") return input.competitorRanks ?? [];
        const rows = input.onpage ?? [];
        // Honour the cache window the way Prisma does, so a stale profile is really
        // invisible to the reader rather than still returned by a lazy mock.
        const cutoff = args.where.observedAt?.gte;
        return cutoff ? rows.filter((row) => row.observedAt >= cutoff) : rows;
      }),
    },
    rawProviderResponse: { findUnique: vi.fn() },
  };
}

const rankRow = (query: string, domain: string, url: string | null, position: number, projectId = "p1"): Row => ({
  id: `${query}-${domain}`,
  observedAt: NOW,
  dimensions: { query, domain, url, rankAbsolute: position },
  metrics: { "provider:position": { value: position } },
});

describe("CMP-006 only fetch what we saw ranking above us", () => {
  it("reads competitor URLs from the ranking rows for the query", async () => {
    const db = mockDb({
      competitorRanks: [
        rankRow("kit lampe", "a.com", "https://a.com/x", 1),
        rankRow("kit lampe", "b.com", "https://b.com/y", 2),
        rankRow("other query", "c.com", "https://c.com/z", 1),
      ],
    });
    const refs = await competitorReferences(db as never, { projectId: "p1", query: "kit lampe" });
    expect(refs.map((row) => row.domain)).toEqual(["a.com", "b.com"]);
  });

  it("orders by position so the top results are read first", async () => {
    const db = mockDb({
      competitorRanks: [
        rankRow("q", "late.com", "https://late.com/", 18),
        rankRow("q", "first.com", "https://first.com/", 2),
      ],
    });
    const refs = await competitorReferences(db as never, { projectId: "p1", query: "q" });
    expect(refs.map((row) => row.domain)).toEqual(["first.com", "late.com"]);
  });

  it("caps at three competitors per query", async () => {
    const db = mockDb({
      competitorRanks: [1, 2, 3, 4, 5].map((position) => rankRow("q", `c${position}.com`, `https://c${position}.com/`, position)),
    });
    const refs = await competitorReferences(db as never, { projectId: "p1", query: "q" });
    expect(refs).toHaveLength(3);
  });

  it("skips a row whose breadcrumb was truncated, because there is no page to read", async () => {
    const db = mockDb({
      competitorRanks: [rankRow("q", "known.com", null, 1), rankRow("q", "readable.com", "https://readable.com/", 2)],
    });
    const refs = await competitorReferences(db as never, { projectId: "p1", query: "q" });
    expect(refs.map((row) => row.domain)).toEqual(["readable.com"]);
  });
});

describe("CMP-006 a competitor page is read once", () => {
  const html = "<html><head><title>A</title></head><body><h1>Hi</h1><p>" + "word ".repeat(300) + "</p></body></html>";
  const fetchOk = vi.fn(async () => ({ statusCode: 200, html, finalUrl: "https://a.com/", bytes: html.length, contentType: "text/html", truncated: false }));

  it("fetches and profiles a readable page", async () => {
    const profile = await readCompetitorPage({
      url: "https://a.com/",
      domain: "a.com",
      position: 2,
      now: NOW,
      fetch: fetchOk as never,
    });
    expect(profile.unreadable).toBeUndefined();
    expect(profile.wordCount).toBeGreaterThan(300);
    expect(profile.h1Count).toBe(1);
    expect(profile.domain).toBe("a.com");
  });

  it("records a non-2xx as unreadable rather than throwing", async () => {
    const profile = await readCompetitorPage({
      url: "https://a.com/",
      domain: "a.com",
      position: 2,
      now: NOW,
      fetch: (async () => ({ statusCode: 403, html: "", finalUrl: "https://a.com/", bytes: 0, contentType: "text/html", truncated: false })) as never,
    });
    expect(profile.unreadable).toBe("HTTP 403");
    expect(profile.wordCount).toBeNull();
  });

  it("refuses to parse a PDF as a page", async () => {
    const profile = await readCompetitorPage({
      url: "https://a.com/x.pdf",
      domain: "a.com",
      position: 2,
      now: NOW,
      fetch: (async () => ({ statusCode: 200, html: "%PDF", finalUrl: "https://a.com/x.pdf", bytes: 4, contentType: "application/pdf", truncated: false })) as never,
    });
    expect(profile.unreadable).toContain("not an HTML page");
  });

  it("records a transport failure with its reason", async () => {
    const profile = await readCompetitorPage({
      url: "https://blocked.test/",
      domain: "blocked.test",
      position: 1,
      now: NOW,
      fetch: (async () => {
        throw new Error("Blocked: blocked.test resolves to private/reserved IP (10.0.0.1)");
      }) as never,
    });
    expect(profile.unreadable).toContain("private/reserved");
  });

  it("reuses a stored profile inside the cache window and fetches nothing", async () => {
    const fetchSpy = vi.fn();
    const db = mockDb({
      competitorRanks: [rankRow("q", "a.com", "https://a.com/", 2)],
      onpage: [
        {
          id: "e1",
          observedAt: new Date(NOW.getTime() - 5 * 86_400_000),
          dimensions: {
            scope: "competitor",
            url: "https://a.com/",
            title: "Cached",
            wordCount: 1840,
            h1Count: 1,
            headings: ["Hi"],
            schemaTypes: ["Product"],
          },
          metrics: {},
        },
      ],
    });
    const result = await competitorPageGap(db as never, {
      projectId: "p1",
      siteId: "s1",
      query: "q",
      ours: null,
      now: NOW,
      apply: true,
      fetch: fetchSpy as never,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.fetch.cached).toBe(1);
    expect(result.fetch.fetched).toBe(0);
    expect(result.competitors[0].wordCount).toBe(1840);
    expect(result.competitors[0].source).toBe("cached");
  });

  it("ignores a stored profile older than the cache window", async () => {
    const stale = new Date(NOW.getTime() - (COMPETITOR_CACHE_DAYS + 1) * 86_400_000);
    const fetchSpy = vi.fn(async () => ({ statusCode: 200, html, finalUrl: "https://a.com/", bytes: html.length, contentType: "text/html", truncated: false }));
    const db = mockDb({
      competitorRanks: [rankRow("q", "a.com", "https://a.com/", 2)],
      onpage: [{ id: "e1", observedAt: stale, dimensions: { scope: "competitor", url: "https://a.com/", wordCount: 1 }, metrics: {} }],
    });
    const result = await competitorPageGap(db as never, {
      projectId: "p1",
      siteId: "s1",
      query: "q",
      ours: null,
      now: NOW,
      apply: true,
      fetch: fetchSpy as never,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.fetch.fetched).toBe(1);
  });

  it("caches an unreadable page too, so a 404 is not retried every run", async () => {
    const fetchSpy = vi.fn();
    const db = mockDb({
      competitorRanks: [rankRow("q", "gone.com", "https://gone.com/", 3)],
      onpage: [
        {
          id: "e2",
          observedAt: new Date(NOW.getTime() - 2 * 86_400_000),
          dimensions: { scope: "competitor", url: "https://gone.com/", unreadable: "HTTP 404" },
          metrics: {},
        },
      ],
    });
    const result = await competitorPageGap(db as never, {
      projectId: "p1",
      siteId: "s1",
      query: "q",
      ours: null,
      now: NOW,
      apply: true,
      fetch: fetchSpy as never,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.competitors[0].unreadable).toBe("HTTP 404");
    expect(result.fetch.unreadable).toBe(1);
  });

  it("reports a cap hit rather than silently fetching fewer pages", async () => {
    const fetchSpy = vi.fn(async () => ({ statusCode: 200, html, finalUrl: "https://a.com/", bytes: html.length, contentType: "text/html", truncated: false }));
    const db = mockDb({
      competitorRanks: [1, 2, 3].map((position) => rankRow("q", `c${position}.com`, `https://c${position}.com/`, position)),
    });
    const result = await competitorPageGap(db as never, {
      projectId: "p1",
      siteId: "s1",
      query: "q",
      ours: null,
      now: NOW,
      apply: true,
      remaining: 1,
      fetch: fetchSpy as never,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.fetch.fetched).toBe(1);
    expect(result.fetch.skipped).toBe(2);
  });

  it("reads nothing when apply is false", async () => {
    const fetchSpy = vi.fn();
    const db = mockDb({ competitorRanks: [rankRow("q", "a.com", "https://a.com/", 2)] });
    const result = await competitorPageGap(db as never, {
      projectId: "p1",
      siteId: "s1",
      query: "q",
      ours: null,
      now: NOW,
      apply: false,
      fetch: fetchSpy as never,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.fetch.skipped).toBe(1);
  });
});
