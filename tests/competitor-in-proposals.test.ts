import { describe, expect, it } from "vitest";

import {
  COMPETITOR_CONTEXT_BOUNDS,
  buildClusterEvidenceCatalogue,
  buildClusterEvidenceIds,
  orderByOpportunity,
  selectClusterEvidence,
} from "@/lib/research/opportunity-evidence";
import { competitorSummaryForTest, proposalIdentity } from "@/lib/research/opportunity-drafting";
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
    //
    // We rank 12th here, so the domain that matters is the one just above us, not the
    // leader 9 places up the page. c4 (11th) is a one-place fight; c1 (3rd) is not.
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
    // The nearest fight above us is the one the work is aimed at.
    expect(selected).toContain("c4");
    expect(selected).toContain("c3");
    // The leader is still carried for context, but it is not what crowds out the fight.
    expect(selected).toContain("c1");
    // c2 (7th) is two places further than c3 and three further than c4, and the bound is
    // a bound: the three nearest above us plus the leader is what is sent.
    expect(selected).not.toContain("c2");
    expect(selected.length).toBeLessThanOrEqual(COMPETITOR_CONTEXT_BOUNDS.evidencePerCluster);
  });

  it("sends the queries where we rank nowhere before the ones we already win", () => {
    // The bug this guards, measured 2026-11-24 on atelier-harmonie: a gap query earns ~0
    // impressions, so ordering by impressions selected the queries we already ranked
    // top 10 for and dropped every real gap. 0 of 5 such queries reached the model.
    const rows = [
      ourRank("r1", "lampe artisanale", 6, 4000),
      competitor("c1", "lampe artisanale", "pinterest.com", 4),
      ourRank("r2", "abat jour pagode", 11, 3),
      competitor("c2", "abat jour pagode", "carcassepourabat-jour.com", 1),
      // No rank row at all: we do not rank for this, and somebody holds it.
      competitor("c3", "tapisserie de siège", "bucherie.com", 1),
      competitor("c4", "tapisserie de siège", "ecoute-bergere.fr", 26),
    ];
    const ids = buildClusterEvidenceIds(
      [cluster({ queries: [
        { query: "lampe artisanale", impressions: 4000, position: 6, volume: 500 },
        { query: "abat jour pagode", impressions: 3, position: 11, volume: 50 },
        { query: "tapisserie de siège", impressions: 0, position: null, volume: 90 },
      ] as never })],
      rows
    );
    const selected = ids.get("lamps") ?? [];
    // The gap query is sent even though it has zero impressions.
    expect(selected).toContain("c3");
    // And the two-place fight is sent ahead of the query we already lead.
    expect(selected).toContain("c2");
  });

  it("still sends a cluster's own rank evidence when no SERP was ever sampled", () => {
    // Most clusters have no competitor rows at all. An ordering built for the ones that
    // do must not empty the payload for the rest — that would trade a narrow blind spot
    // for a total one.
    const rows = [
      ourRank("r1", "lampe artisanale", 12, 300),
      ourRank("r2", "lampe coquelicot", 20, 100),
    ];
    const selected = buildClusterEvidenceIds([cluster()], rows).get("lamps") ?? [];
    expect(selected).toContain("r1");
    expect(selected).toContain("r2");
  });

  it("reports what the competitor bound dropped instead of dropping it silently", () => {
    const queries = Array.from({ length: 9 }, (_, index) => ({
      query: `lampe modele ${index}`,
      impressions: 10,
      position: 20,
      volume: 10,
    }));
    const rows = queries.flatMap((query, index) => [
      ourRank(`r${index}`, query.query, 20, 10),
      competitor(`c${index}`, query.query, `concurrent-${index}.fr`, 5),
    ]);
    const selection = selectClusterEvidence([cluster({ queries: queries as never })], rows);
    expect(selection.truncations.join(" ")).toContain("were not sent");
    expect(selection.truncations.join(" ")).toContain(String(9 - COMPETITOR_CONTEXT_BOUNDS.queriesPerCluster));
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

describe("CMP-003 queries are ordered by opportunity, not by impressions", () => {
  const candidate = (
    query: string,
    impressions: number,
    position: number | null
  ) => ({ query, impressions, volume: null, position, clusterSlug: "lamps" });

  it("puts a query we do not rank for first, whatever its impressions", () => {
    // A gap earns no impressions by definition, so impressions cannot be the axis.
    const ordered = orderByOpportunity(
      [candidate("lampe artisanale", 4000, 6), candidate("tapisserie de siège", 0, null)],
      (query) => (query === "tapisserie de siège" ? 1 : 4)
    );
    expect(ordered.map((row) => row.query)).toEqual(["tapisserie de siège", "lampe artisanale"]);
  });

  it("puts the nearest fight above the distant one", () => {
    // We are 6th against 4th here; 45th against 1st is a different project.
    const ordered = orderByOpportunity(
      [candidate("luminaire artisanal", 900, 45), candidate("lampe artisanale", 132, 6)],
      () => 1
    );
    expect(ordered.map((row) => row.query)).toEqual(["lampe artisanale", "luminaire artisanal"]);
  });

  it("uses demand only to break a tie", () => {
    const ordered = orderByOpportunity(
      [candidate("petit volume", 10, 6), candidate("gros volume", 500, 6)],
      () => 4
    );
    expect(ordered.map((row) => row.query)).toEqual(["gros volume", "petit volume"]);
  });

  it("sorts a query with no sampled competitor by demand, last", () => {
    const ordered = orderByOpportunity(
      [candidate("sans concurrent", 800, 3), candidate("avec concurrent", 1, 6)],
      (query) => (query === "avec concurrent" ? 4 : null)
    );
    expect(ordered.map((row) => row.query)).toEqual(["avec concurrent", "sans concurrent"]);
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
    // Only the domains actually ahead of us, nearest to us first: the model is being
    // told what to take, not who is famous.
    expect(entry?.aboveUs.map((row) => row.domain)).toEqual(["europages.fr", "vintage-nancy.fr"]);
    expect(entry?.aboveUs[0].evidenceId).toBe("c2");
    // And the distance to the nearest fight is stated, because that decides the work.
    expect(entry?.nearestAbove?.domain).toBe("europages.fr");
    expect(entry?.nearestAbove?.places).toBe(5);
    // The leader is context, not the target.
    expect(entry?.leader?.domain).toBe("vintage-nancy.fr");
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

describe("CMP-003 an accented query and its unaccented spelling are one query", () => {
  const unaccented = (id: string, query: string, domain: string, position: number) =>
    row({
      id,
      kind: "competitor_rank",
      // The sampled SERP wrote the query without the accent the topic map used.
      dimensions: { query, domain, rankAbsolute: position, observedAt: "2026-11-24", cluster: "seats" },
      metrics: { "provider:position": { value: position, unit: "rank", source: "provider" } },
    });

  it("files an unaccented sampled SERP under the accented topic query", () => {
    // Measured 2026-11-24: the map held `tapisserie de siège`, the SERP wrote
    // `tapisserie de siege`, the two never met, and 12 competitor rows plus the keyword
    // were dropped as "no topic to file it under".
    const accented = cluster({
      slug: "seats",
      queries: [
        { query: "fauteuil restauration", impressions: 200, position: 12, volume: 90 },
        { query: "tapisserie de siège", impressions: 40, position: 18, volume: 70 },
      ] as never,
    });
    const rows = [ourRank("r1", "tapisserie de siège", 18, 40), unaccented("c1", "tapisserie de sieges", "bucherie.com", 1)];
    // A plural is not an accent: ask for the same spelling minus the accent.
    const same = [ourRank("r1", "tapisserie de siège", 18, 40), unaccented("c1", "tapisserie de siege", "bucherie.com", 1)];
    const selection = selectClusterEvidence([accented], same);
    const selected = selection.idsByCluster.get("seats") ?? [];
    expect(selected).toContain("c1");
    // And nothing is reported as unfiled, because a topic did claim it.
    expect(selection.unfiled).toHaveLength(0);
    void rows;
  });

  it("does not re-propose a query the topic review already excluded", () => {
    // A paid SERP says the query exists; it does not say the business serves it. Measured
    // 2026-11-24: `lustre artisanal` had competitor data and had already been judged
    // "not sold" by a person, and `restauration fauteuil saint-germain-en-laye` was out of
    // market. Carrying those to the model would overrule a human decision.
    const rows = [
      ourRank("r1", "fauteuil restauration", 12, 200),
      competitor("c1", "lustre artisanal", "atelier-loupiote.fr", 1),
      competitor("c2", "restauration de sièges", "bienassise.fr", 3),
    ];
    const selection = selectClusterEvidence(
      [cluster({ slug: "seats" })],
      rows,
      new Map([["lustre artisanal", "noise: not sold"]])
    );
    expect(selection.unfiled.map((entry) => entry.query)).toEqual(["restauration de sièges"]);
    // And the exclusion is stated, so it does not look like the SERP found nothing.
    expect(selection.truncations.join(" ")).toContain("topic review already excluded");
  });

  it("carries a truly unfiled query as data, not only as a sentence in the report", () => {
    // `restauration de sièges` had 7 competitor rows naming bienassise.fr at #3, no
    // cluster and no keyword-universe row, so only a data channel reaches the model.
    const rows = [
      ourRank("r1", "fauteuil restauration", 12, 200),
      competitor("c1", "restauration de sièges", "bienassise.fr", 3),
      competitor("c2", "restauration de sièges", "blog.artapisserie.fr", 4),
    ];
    const selection = selectClusterEvidence([cluster({ slug: "seats" })], rows);
    const unfiled = selection.unfiled.find((entry) => entry.query === "restauration de sièges");
    expect(unfiled).toBeTruthy();
    expect(unfiled?.competitors.map((entry) => entry.domain)).toEqual(["bienassise.fr", "blog.artapisserie.fr"]);
    expect(unfiled?.competitors[0].evidenceId).toBe("c1");
    // No recorded position: we do not rank, which is the largest gap there is.
    expect(unfiled?.ourPosition).toBeNull();
    // It is still named in the report, so the count is never silent.
    expect(selection.truncations.join(" ")).toContain("no topic to file it under");
  });
});

describe("CMP-003 an unfiled-query proposal is its own board row", () => {
  it("does not collapse two unfiled proposals onto one dedup key", () => {
    // An unfiled proposal has no page and no topic by design, so the identity fell back to
    // the constant "site" and two of them hashed to the same key — the second silently
    // replaced the first on the board.
    const one = proposalIdentity({
      lane: "content_business",
      kind: "update",
      topicSlug: null,
      title: "Restauration de sièges : viser bienassise.fr",
      target: { url: null, newAsset: false, section: null },
    });
    const two = proposalIdentity({
      lane: "content_business",
      kind: "update",
      topicSlug: null,
      title: "Abat-jour ancien : viser defilenbobine.com",
      target: { url: null, newAsset: false, section: null },
    });
    expect(one).not.toBe(two);
  });

  it("keeps the same unfiled job on one row across runs", () => {
    const proposal = {
      lane: "content_business" as const,
      kind: "update" as const,
      topicSlug: null,
      title: "Restauration de sièges : viser bienassise.fr",
      target: { url: null, newAsset: false, section: null },
    };
    expect(proposalIdentity(proposal)).toBe(proposalIdentity({ ...proposal }));
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
