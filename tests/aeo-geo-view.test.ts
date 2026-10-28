import { describe, expect, it } from "vitest";
import {
  accessState,
  groupIssuesByType,
  groupObservations,
  identityIssues,
  observationCount,
  splitObservations,
  summarizeDimensions,
} from "@/lib/research/aeo-geo-view";

const observation = (id: string, provider: string, modelSurface: string, observedAt = new Date("2026-10-01")) => ({
  id,
  provider,
  modelSurface,
  observedAt,
});

describe("aeo-geo-view", () => {
  it("excludes fixture observations from customer totals and keeps them visible separately", () => {
    const rows = [
      observation("1", "perplexity", "Perplexity web answer (fixture)"),
      observation("2", "perplexity", "Perplexity web answer"),
      observation("3", "openai", "ChatGPT search"),
    ];
    const { customer, fixtures } = splitObservations(rows);
    expect(customer.map((row) => row.id)).toEqual(["2", "3"]);
    expect(fixtures.map((row) => row.id)).toEqual(["1"]);
  });

  it("groups observations by provider and surface", () => {
    const rows = [
      observation("1", "perplexity", "Perplexity web answer"),
      observation("2", "perplexity", "Perplexity web answer"),
      observation("3", "openai", "ChatGPT search"),
    ];
    const grouped = groupObservations(rows);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].key).toBe("openai · ChatGPT search");
    expect(grouped[1].rows).toHaveLength(2);
  });

  it("treats a missing provider count as unknown rather than zero", () => {
    expect(observationCount(null)).toBeNull();
    expect(observationCount(undefined)).toBeNull();
    expect(observationCount(0)).toBe(0);
    expect(observationCount(["a", "b"])).toBe(2);
    expect(observationCount({ count: 4 })).toBe(4);
  });

  it("finds identity issues and groups them by type with counts", () => {
    const issues = [
      { id: "a", type: "NO_STRUCTURED_DATA", details: { kind: "identity_jsonld" } },
      { id: "b", type: "NO_STRUCTURED_DATA", details: null },
      { id: "c", type: "MISSING_H1", details: null },
      { id: "d", type: "MISSING_ROBOTS", details: { kind: "ai_crawler_block" } },
    ];
    expect(identityIssues(issues).map((issue) => issue.id)).toEqual(["a", "b"]);
    expect(groupIssuesByType(identityIssues(issues))).toEqual([
      { type: "NO_STRUCTURED_DATA", count: 2, ids: ["a", "b"] },
    ]);
  });

  it("reports unknown access when there is no crawl", () => {
    expect(accessState(null)).toEqual({
      crawlDate: null,
      robots: "unknown",
      sitemap: "unknown",
      reachability: "unknown",
    });
  });

  it("reports restrictions and missing sitemap from crawl issues", () => {
    const state = accessState({
      finishedAt: new Date("2026-10-25T10:00:00Z"),
      issues: [
        { id: "1", type: "MISSING_ROBOTS", details: null },
        { id: "2", type: "MISSING_SITEMAP", details: null },
      ],
    });
    expect(state.robots).toBe("restricted");
    expect(state.sitemap).toBe("missing");
    expect(state.crawlDate).toBe("2026-10-25T10:00:00.000Z");
  });

  it("summarizes AEO and GEO actions by state and ignores other dimensions", () => {
    const actions = [
      { id: "1", title: "a", status: "PROPOSED", kind: "fix_business_identity_jsonld", source: "crawl_issue" },
      { id: "2", title: "b", status: "DISMISSED", kind: "fix_business_identity_jsonld", source: "crawl_issue" },
      { id: "3", title: "c", status: "PROPOSED", kind: "citation_gap", source: "ai_visibility_coverage" },
      { id: "4", title: "d", status: "PROPOSED", kind: "fix_technical_issue", source: "crawl_issue" },
    ];
    const dimensionOf = (action: (typeof actions)[number]) => {
      if (/identity_jsonld/.test(action.kind)) return "aeo";
      if (/citation|visibility/.test(action.kind)) return "geo";
      return "technical";
    };
    const summary = summarizeDimensions(actions, dimensionOf);
    expect(summary.aeoTotal).toBe(2);
    expect(summary.geoTotal).toBe(1);
    expect(summary.aeo).toEqual({ proposed: 1, dismissed: 1 });
  });
});
