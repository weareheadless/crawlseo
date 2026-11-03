import { describe, expect, it, vi } from "vitest";

import { ONPAGE_CHECK_MAP, compareCrawlParity, ingestOnPageResponse } from "@/lib/dataforseo/onpage-adapter";

const AT = new Date("2026-11-03T00:00:00.000Z");

const response = {
  id: "onpage-task-1",
  status: "ok",
  cost: 0.0012,
  datetime: "2026-11-02 10:00:00 +00:00",
  result: [
    {
      crawl_progress: "finished",
      crawl_status: { http_code: 200, pages_crawled: 2 },
      items: [
        {
          url: "https://example.com/",
          status_code: 200,
          meta: { title: "Home", canonical: "https://example.com/" },
          page_timing: { duration_time: 1.4 },
          content: { plain_text_word_count: 400 },
          onpage_score: 82,
          checks: { no_title: false, no_description: true, no_canonical: false, no_schema: true, unknown_future_check: false },
        },
        {
          url: "https://example.com/a",
          status_code: 200,
          checks: { high_loading_time: true },
        },
      ],
    },
  ],
};

function fakeDb() {
  const raws: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const db = {
    rawProviderResponse: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        raws.push(args.data);
        return { id: "raw-1" };
      }),
      findUnique: vi.fn(async () => ({ costMicros: BigInt(1200), status: "ok" })),
    },
    evidenceRecord: {
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        const row = { id: `ev-${evidence.length + 1}`, ...args.create };
        evidence.push(row);
        return { id: row.id };
      }),
      update: vi.fn(async () => ({})),
      findMany: vi.fn(async () => []),
    },
  };
  return { db: db as never, raws, evidence };
}

describe("DS-04 OnPage adapter (producer only)", () => {
  it("stores the raw payload immutably with its cost", async () => {
    const { db, raws } = fakeDb();
    await ingestOnPageResponse(db, response, {
      projectId: "p1",
      siteId: "s1",
      requestedAt: AT,
      costMicros: BigInt(1200),
    });
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({ provider: "dataforseo", product: "onpage", providerTaskId: "onpage-task-1" });
    expect(raws[0].costMicros).toBe(BigInt(1200));
  });

  it("derives one page observation and one observation per mapped issue", async () => {
    const { db, evidence } = fakeDb();
    const result = await ingestOnPageResponse(db, response, { projectId: "p1", siteId: "s1", requestedAt: AT, costMicros: BigInt(1200) });
    expect(result.pages).toBe(2);
    // no_description + no_schema on page 1, high_loading_time on page 2
    expect(result.issues).toBe(3);
    const issueRows = evidence.filter((row) => (row.dimensions as { issueType?: string }).issueType);
    expect(issueRows.map((row) => (row.dimensions as { issueType: string }).issueType).sort()).toEqual([
      "MISSING_DESCRIPTION",
      "MISSING_SCHEMA",
      "SLOW_PAGE",
    ]);
  });

  it("marks structured-data issues so our detectors key off them", async () => {
    const { db, evidence } = fakeDb();
    await ingestOnPageResponse(db, response, { projectId: "p1", siteId: "s1", requestedAt: AT, costMicros: BigInt(1200) });
    const schema = evidence.find((row) => (row.dimensions as { issueType?: string }).issueType === "MISSING_SCHEMA");
    expect(schema?.dimensions).toMatchObject({ impact: "structured_data", schemaMissing: "true" });
  });

  it("records provider checks we do not map instead of silently dropping them", async () => {
    const { db } = fakeDb();
    const result = await ingestOnPageResponse(db, response, { projectId: "p1", siteId: "s1", requestedAt: AT, costMicros: BigInt(1200) });
    expect(result.unmappedChecks).toEqual(["unknown_future_check"]);
  });

  it("uses the provider observation time, not the ingest time", async () => {
    const { db, evidence } = fakeDb();
    await ingestOnPageResponse(db, response, { projectId: "p1", siteId: "s1", requestedAt: AT, costMicros: BigInt(1200) });
    expect(evidence[0].observedAt).toEqual(new Date("2026-11-02 10:00:00 +00:00"));
  });

  it("does not touch the crawler, audit tables or read paths", async () => {
    const { db } = fakeDb();
    const touched: string[] = [];
    const spy = new Proxy(db as unknown as Record<string, unknown>, {
      get(target, prop) {
        if (typeof prop === "string") touched.push(prop);
        return Reflect.get(target, prop);
      },
    }) as never;
    await ingestOnPageResponse(spy, response, { projectId: "p1", siteId: "s1", requestedAt: AT, costMicros: BigInt(1200) });
    expect(touched.every((key) => key === "rawProviderResponse" || key === "evidenceRecord" || key === "then")).toBe(true);
  });

  it("maps every declared check to an issue with an impact", () => {
    for (const [check, mapping] of Object.entries(ONPAGE_CHECK_MAP)) {
      expect(mapping.issueType).toMatch(/^[A-Z0-9_]+$/);
      expect(["crawlability", "structured_data", "content"]).toContain(mapping.impact);
      expect(check).toBeTruthy();
    }
  });
});

describe("DS-04 parity report", () => {
  it("refuses to call parity proven when our crawler found something the provider did not", () => {
    const report = compareCrawlParity({
      providerIssues: { MISSING_TITLE: 4, MISSING_SCHEMA: 9 },
      ourIssues: { MISSING_TITLE: 4, MISSING_SCHEMA: 9, MULTIPLE_H1: 2 },
      providerPages: 40,
      ourPages: 40,
    });
    expect(report.oursOnly).toEqual(["MULTIPLE_H1"]);
    expect(report.both).toEqual(["MISSING_SCHEMA", "MISSING_TITLE"]);
    expect(report.parityProven).toBe(false);
  });

  it("requires enough pages on both sides", () => {
    const report = compareCrawlParity({
      providerIssues: { MISSING_TITLE: 2 },
      ourIssues: { MISSING_TITLE: 2 },
      providerPages: 19,
      ourPages: 40,
    });
    expect(report.parityProven).toBe(false);
  });

  it("proves parity only when coverage is sufficient and nothing unique is lost", () => {
    const report = compareCrawlParity({
      providerIssues: { MISSING_TITLE: 4, MISSING_SCHEMA: 9 },
      ourIssues: { MISSING_TITLE: 4, MISSING_SCHEMA: 9 },
      providerPages: 40,
      ourPages: 40,
    });
    expect(report.oursOnly).toEqual([]);
    expect(report.parityProven).toBe(true);
  });

  it("reports provider-only checks as candidates, not as replacements", () => {
    const report = compareCrawlParity({
      providerIssues: { THIN_CONTENT: 3, MISSING_TITLE: 1 },
      ourIssues: { MISSING_TITLE: 1 },
      providerPages: 40,
      ourPages: 40,
    });
    expect(report.providerOnly).toEqual(["THIN_CONTENT"]);
    expect(report.parityProven).toBe(true);
  });
});
