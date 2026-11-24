import { describe, expect, it } from "vitest";

import { buildClusterEvidenceCatalogue, buildClusterEvidenceIds } from "@/lib/research/opportunity-evidence";
import { competitorSummaryForTest } from "@/lib/research/opportunity-drafting";
import type { TopicCluster } from "@/lib/research/topic-map";

/**
 * CMP-003, the half that was actually missing.
 *
 * The measurement existed — `competitor_rank` rows naming the domain and position on
 * every sampled query — and it never reached the drafting call. Measured 2026-11-24:
 * **0 of 45** live content-gap rows named a competitor domain, because the payload the
 * model received carried no competitor field at all. The model could therefore only
 * describe our own position ("we sit at 27") and call that a competitive gap.
 *
 * These tests are about the *payload*, not the storage: the point is that competitor
 * rows are selected, sent, and readable as "domain at position for query".
 */

const cluster = (over: Partial<TopicCluster> = {}): TopicCluster =>
  ({
    slug: "lamps",
    name: "Lamps",
    intent: "commercial",
    relevance: "high",
    coverage: "partial",
    visibility: "proven",
    marketScope: null,
    metrics: { volume: 500, impressions: 400 },
    contextOnly: 0,
    reviewFlags: [],
    gaps: [],
    excludedQueries: [],
    queries: [
      { query: "lampe artisanale", impressions: 300, position: 12, volume: 500 },
      { query: "lampe coquelicot", impressions: 100, position: null, volume: 200 },
    ],
    pages: [],
    ...over,
  }) as unknown as TopicCluster;

const row = (input: {
  id: string;
  kind: string;
  dimensions: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  observedAt?: Date;
}) => ({
  id: input.id,
  kind: input.kind,
  dimensions: input.dimensions,
  metrics: input.metrics ?? {},
  observedAt: input.observedAt ?? new Date("2026-11-24T00:00:00Z"),
});

const competitor = (id: string, query: string, domain: string, position: number, observedAt?: Date) =>
  row({
    id,
    kind: "competitor_rank",
    dimensions: { query, domain, rankAbsolute: position, observedAt: "2026-11-24" },
    metrics: { "provider:position": { value: position, unit: "rank", source: "provider" } },
    observedAt,
  });

const ourRank = (id: string, query: string, position: number, impressions: number) =>
  row({
    id,
    kind: "keyword_rank",
    dimensions: { query, url: "https://oursite.com/lamps", windowRole: "current" },
    metrics: {
      "first_party:position": { value: position, unit: "rank", source: "first_party" },
      "first_party:impressions": { value: impressions, unit: "count", source: "first_party" },
    },
  });

describe("CMP-003 competitor rows reach the drafting payload", () => {
  it("selects the best-placed competitors for the top queries", () => {
    const rows = [
      ourRank("r1", "lampe artisanale", 12, 300),
      competitor("c1", "lampe artisanale", "vintage-nancy.fr", 3),
      competitor("c2", "lampe artisanale", "europages.fr", 7),
      competitor("c3", "lampe artisanale", "pinterest.com", 18),
    ];
    const ids = buildClusterEvidenceIds([cluster()], rows);
    const selected = ids.get("lamps") ?? [];
    // Both better-placed domains are cited; the one below us is not the thing to beat.
    expect(selected).toContain("c1");
    expect(selected).toContain("c2");
    expect(selected).not.toContain("c3");
  });

  it("carries the domain and the domain's rank into the catalogue", () => {
    // The defect this guards: a competitor row arriving with `position: null` (our own
    // Search Console metric, which it does not have) and no name, so the model could
    // cite the id but not say anything with it.
    const rows = [ourRank("r1", "lampe artisanale", 12, 300), competitor("c1", "lampe artisanale", "vintage-nancy.fr", 3)];
    const ids = buildClusterEvidenceIds([cluster()], rows);
    const catalogue = buildClusterEvidenceCatalogue([cluster()], rows, ids);
    const entry = (catalogue.get("lamps") ?? []).find((item) => item.id === "c1");
    expect(entry).toBeTruthy();
    expect(entry?.domain).toBe("vintage-nancy.fr");
    expect(entry?.rank).toBe(3);
    // And our own position is NOT on the competitor row: the two numbers are different.
    expect(entry?.position).toBeNull();
  });

  it("keeps competitor rows inside the evidence budget rather than letting them crowd it out", () => {
    // A query sampled monthly yields one row per domain per sample. With a plain head
    // slice these fill the budget and the model gets three copies of one competitor and
    // none of our own rank.
    const rows = [
      ourRank("r1", "lampe artisanale", 12, 300),
      competitor("c1", "lampe artisanale", "vintage-nancy.fr", 3),
      competitor("c2", "lampe artisanale", "europages.fr", 7),
      competitor("c3", "lampe artisanale", "pinterest.com", 9),
      competitor("c4", "lampe artisanale", "facebook.com", 11),
      ourRank("r2", "lampe coquelicot", 20, 100),
    ];
    const ids = buildClusterEvidenceIds([cluster()], rows);
    const selected = ids.get("lamps") ?? [];
    // Our own rank row survives alongside the competitors.
    expect(selected).toContain("r1");
    expect(selected).toContain("c1");
    // And the budget is still a budget.
    expect(selected.length).toBeLessThanOrEqual(14);
  });

  it("does not send the same domain three times for one query", () => {
    const rows = [
      ourRank("r1", "lampe artisanale", 12, 300),
      competitor("c1", "lampe artisanale", "vintage-nancy.fr", 3, new Date("2026-09-24T00:00:00Z")),
      competitor("c2", "lampe artisanale", "vintage-nancy.fr", 4, new Date("2026-10-24T00:00:00Z")),
      competitor("c3", "lampe artisanale", "vintage-nancy.fr", 3, new Date("2026-11-24T00:00:00Z")),
    ];
    const ids = buildClusterEvidenceIds([cluster()], rows);
    const selected = (ids.get("lamps") ?? []).filter((id) => id.startsWith("c"));
    expect(selected).toHaveLength(1);
    // The newest sample wins, because it is the current position.
    expect(selected[0]).toBe("c3");
  });

  it("does not claim a competitor when the SERP was never sampled", () => {
    const rows = [ourRank("r1", "lampe artisanale", 12, 300)];
    const ids = buildClusterEvidenceIds([cluster()], rows);
    const catalogue = buildClusterEvidenceCatalogue([cluster()], rows, ids);
    expect((catalogue.get("lamps") ?? []).some((item) => item.kind === "competitor_rank")).toBe(false);
  });
});

describe("CMP-003 the model is told who holds each query", () => {
  const evidenceRow = (id: string, query: string, domain: string, rank: number) => ({
    id,
    kind: "competitor_rank",
    query,
    position: null,
    impressions: null,
    volume: null,
    url: null,
    domain,
    rank,
  });

  it("lists the domains above us, with their positions and evidence ids", () => {
    const summary = competitorSummaryForTest(cluster(), [
      evidenceRow("c1", "lampe artisanale", "vintage-nancy.fr", 3),
      evidenceRow("c2", "lampe artisanale", "europages.fr", 7),
      evidenceRow("c3", "lampe artisanale", "below-us.fr", 30),
    ]);
    expect(summary.aboveUsCount).toBe(2);
    const entry = summary.queries.find((item) => item.query === "lampe artisanale");
    expect(entry?.ourPosition).toBe(12);
    // Only the domains actually ahead of us, best first.
    expect(entry?.aboveUs.map((row) => row.domain)).toEqual(["vintage-nancy.fr", "europages.fr"]);
    expect(entry?.aboveUs[0].evidenceId).toBe("c1");
  });

  it("treats every sampled domain as ahead when we do not rank at all", () => {
    const summary = competitorSummaryForTest(cluster(), [
      evidenceRow("c1", "lampe coquelicot", "vintage-nancy.fr", 4),
      evidenceRow("c2", "lampe coquelicot", "europages.fr", 9),
    ]);
    const entry = summary.queries.find((item) => item.query === "lampe coquelicot");
    // `ourPosition` null means "not ranking", which is a different statement from 0.
    expect(entry?.ourPosition).toBeNull();
    expect(entry?.aboveUs).toHaveLength(2);
  });

  it("excludes a domain that ranks below us", () => {
    const summary = competitorSummaryForTest(cluster(), [
      evidenceRow("c1", "lampe artisanale", "below-us.fr", 30),
    ]);
    expect(summary.aboveUsCount).toBe(0);
  });

  it("states that nobody was sampled rather than saying nobody competes", () => {
    const summary = competitorSummaryForTest(cluster(), []);
    expect(summary.aboveUsCount).toBe(0);
    expect(summary.reason).toContain("No competitor SERP has been sampled");
    expect(summary.reason).toContain("not empty");
  });

  it("says when we are ahead of every sampled competitor", () => {
    const summary = competitorSummaryForTest(cluster(), [
      evidenceRow("c1", "lampe artisanale", "below-us.fr", 30),
    ]);
    expect(summary.reason).toContain("at or above the best sampled competitor");
  });

  it("collapses repeat samples of one domain to its best position", () => {
    const summary = competitorSummaryForTest(cluster(), [
      evidenceRow("c1", "lampe artisanale", "vintage-nancy.fr", 6),
      evidenceRow("c2", "lampe artisanale", "vintage-nancy.fr", 3),
    ]);
    const entry = summary.queries.find((item) => item.query === "lampe artisanale");
    expect(entry?.aboveUs).toHaveLength(1);
    expect(entry?.aboveUs[0].position).toBe(3);
  });
});

describe("CMP-003 a cited competitor row reads as a domain and a position", () => {
  it("names the domain, the query and the position on the evidence line", async () => {
    // The fallback printed only the query, which made a competitor row look like our own
    // rank row and hid the one fact it exists to state.
    const { headlineFor } = await import("@/lib/funnel/views");
    const line = headlineFor({
      kind: "competitor_rank",
      dimensions: { query: "lampe artisanale", domain: "vintage-nancy.fr", rankAbsolute: 3 },
      metrics: { "provider:position": { value: 3, unit: "rank", source: "provider" } },
    } as never);
    expect(line).toContain("vintage-nancy.fr");
    expect(line).toContain("position 3");
    expect(line).toContain("lampe artisanale");
  });

  it("does not invent a position when the row carries none", async () => {
    const { headlineFor } = await import("@/lib/funnel/views");
    const line = headlineFor({
      kind: "competitor_rank",
      dimensions: { query: "lampe artisanale", domain: "vintage-nancy.fr" },
      metrics: {},
    } as never);
    expect(line).toContain("vintage-nancy.fr");
    expect(line).not.toContain("position");
  });
});
