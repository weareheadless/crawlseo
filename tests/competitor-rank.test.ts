import { describe, expect, it, vi } from "vitest";

import { clusterCompetitors } from "@/lib/funnel/competitor-leaderboard";

/**
 * CMP-003's leaderboard projection.
 *
 * The acceptance is specific and each case here is one of its bullets:
 *  - a domain seen once appears once with `queries: 1`, and the sample count is stated,
 *  - the board names the queries a competitor holds that we do not rank for,
 *  - a cluster with no sampled SERP says so instead of showing an empty table.
 *
 * The projection is arithmetic over stored rows. It never invents a competitor.
 */

type Row = {
  dimensions: Record<string, unknown>;
  metrics: Record<string, { value: number | null }>;
  observedAt?: Date;
};

function mockDb(input: { competitors: Row[]; memberships?: Row[]; ranks?: Row[] }) {
  return {
    evidenceRecord: {
      findMany: vi.fn(async (args: { where: { kind: string } }) => {
        if (args.where.kind === "competitor_rank") return input.competitors;
        if (args.where.kind === "keyword_universe_membership") return input.memberships ?? [];
        return input.ranks ?? [];
      }),
    },
  };
}

const competitor = (query: string, domain: string, position: number, extra: Record<string, unknown> = {}): Row => ({
  dimensions: { query, domain, cluster: "c1", observedAt: "2026-11-01", ...extra },
  metrics: { "provider:position": { value: position } },
});

const membership = (query: string, cluster = "c1"): Row => ({ dimensions: { query, cluster }, metrics: {} });

const ourRank = (query: string, position: number): Row => ({
  dimensions: { query },
  metrics: { "provider:position": { value: position } },
});

describe("CMP-003 competitor leaderboard", () => {
  it("counts the queries a domain ranks for and its average position", async () => {
    const db = mockDb({
      competitors: [competitor("a", "rival.com", 3), competitor("b", "rival.com", 7)],
      memberships: [membership("a"), membership("b")],
      ranks: [ourRank("a", 9), ourRank("b", 14)],
    });
    const board = await clusterCompetitors(db as never, { projectId: "p1", clusterSlug: "c1" });
    expect(board.competitors).toHaveLength(1);
    expect(board.competitors[0]).toMatchObject({
      domain: "rival.com",
      queries: 2,
      averagePosition: 5,
      bestPosition: 3,
    });
  });

  it("keeps a single observation and states the sample count", async () => {
    // The acceptance: a domain that ranks in one snapshot for one query is not
    // dropped, and the board says how many snapshots it summarised.
    const db = mockDb({
      competitors: [competitor("only query", "once.com", 4)],
      memberships: [membership("only query")],
      ranks: [ourRank("only query", 12)],
    });
    const board = await clusterCompetitors(db as never, { projectId: "p1", clusterSlug: "c1" });
    expect(board.competitors).toHaveLength(1);
    expect(board.competitors[0].queries).toBe(1);
    expect(board.samples).toBe(1);
  });

  it("names the queries a competitor holds where we do not rank", async () => {
    const db = mockDb({
      competitors: [competitor("we rank", "rival.com", 2), competitor("we do not", "rival.com", 5)],
      memberships: [membership("we rank"), membership("we do not")],
      // We have a rank only for the first query.
      ranks: [ourRank("we rank", 8)],
    });
    const board = await clusterCompetitors(db as never, { projectId: "p1", clusterSlug: "c1" });
    expect(board.competitors[0].queriesWeDoNotRank).toEqual(["we do not"]);
  });

  it("bands positions so 4 and 19 are not the same claim", async () => {
    const db = mockDb({
      competitors: [
        competitor("a", "top.com", 2),
        competitor("b", "top.com", 6),
        competitor("c", "top.com", 15),
      ],
      memberships: [membership("a"), membership("b"), membership("c")],
      ranks: [],
    });
    const board = await clusterCompetitors(db as never, { projectId: "p1", clusterSlug: "c1" });
    expect(board.competitors[0]).toMatchObject({ at1to3: 1, at4to10: 1, at11to20: 1 });
  });

  it("keeps the best position when a domain is seen twice for one query", async () => {
    // Two monthly samples of the same query: the leaderboard describes the
    // domain's strength, not one bad month, and it does not double-count the query.
    const db = mockDb({
      competitors: [
        competitor("a", "rival.com", 9, { observedAt: "2026-11-01" }),
        competitor("a", "rival.com", 3, { observedAt: "2026-12-01" }),
      ],
      memberships: [membership("a")],
      ranks: [ourRank("a", 14)],
    });
    const board = await clusterCompetitors(db as never, { projectId: "p1", clusterSlug: "c1" });
    expect(board.competitors[0].queries).toBe(1);
    expect(board.competitors[0].bestPosition).toBe(3);
    expect(board.samples).toBe(2);
  });

  it("orders by how much of the cluster a domain holds", async () => {
    const db = mockDb({
      competitors: [
        competitor("a", "small.com", 3),
        competitor("a", "big.com", 8),
        competitor("b", "big.com", 9),
      ],
      memberships: [membership("a"), membership("b")],
      ranks: [],
    });
    const board = await clusterCompetitors(db as never, { projectId: "p1", clusterSlug: "c1" });
    expect(board.competitors[0].domain).toBe("big.com");
    expect(board.competitors[0].queries).toBe(2);
  });

  it("does not count a competitor row from another cluster", async () => {
    const db = mockDb({
      competitors: [competitor("other", "elsewhere.com", 2, { cluster: "c2" })],
      memberships: [membership("mine", "c1")],
      ranks: [],
    });
    const board = await clusterCompetitors(db as never, { projectId: "p1", clusterSlug: "c1" });
    expect(board.competitors).toEqual([]);
  });

  it("resolves a row with no cluster dimension through the cluster's own members", async () => {
    // A snapshot taken before the query had a membership carries no `cluster`.
    const row = competitor("mine", "rival.com", 4);
    delete (row.dimensions as { cluster?: string }).cluster;
    const db = mockDb({
      competitors: [row],
      memberships: [membership("mine", "c1")],
      ranks: [ourRank("mine", 10)],
    });
    const board = await clusterCompetitors(db as never, { projectId: "p1", clusterSlug: "c1" });
    expect(board.competitors).toHaveLength(1);
    expect(board.competitors[0].domain).toBe("rival.com");
  });

  it("says there is no sample rather than showing an empty table", async () => {
    const db = mockDb({ competitors: [], memberships: [membership("a"), membership("b")], ranks: [] });
    const board = await clusterCompetitors(db as never, { projectId: "p1", clusterSlug: "c1" });
    expect(board.competitors).toEqual([]);
    expect(board.reason).toContain("No sampled SERP");
    expect(board.queriesWithoutSample).toBe(2);
  });

  it("says the cluster is empty rather than that nothing ranks", async () => {
    const db = mockDb({ competitors: [], memberships: [], ranks: [] });
    const board = await clusterCompetitors(db as never, { projectId: "p1", clusterSlug: "c1" });
    expect(board.reason).toContain("no members");
  });

  it("marks a declared competitor without hiding an undeclared one", async () => {
    const db = mockDb({
      competitors: [competitor("a", "declared.com", 3), competitor("b", "surprise.com", 4)],
      memberships: [membership("a"), membership("b")],
      ranks: [],
    });
    const board = await clusterCompetitors(db as never, {
      projectId: "p1",
      clusterSlug: "c1",
      declared: ["Declared.com"],
    });
    const declared = board.competitors.find((row) => row.domain === "declared.com");
    const surprise = board.competitors.find((row) => row.domain === "surprise.com");
    expect(declared?.declared).toBe(true);
    // Emphasised, never filtered: the SERP named it, so the board shows it.
    expect(surprise).toBeTruthy();
    expect(surprise?.declared).toBe(false);
  });

  it("ignores a row with no position or no domain", async () => {
    const db = mockDb({
      competitors: [
        { dimensions: { query: "a", domain: "no-position.com", cluster: "c1" }, metrics: {} },
        { dimensions: { query: "a", cluster: "c1" }, metrics: { "provider:position": { value: 4 } } },
        competitor("a", "real.com", 5),
      ],
      memberships: [membership("a")],
      ranks: [],
    });
    const board = await clusterCompetitors(db as never, { projectId: "p1", clusterSlug: "c1" });
    expect(board.competitors.map((row) => row.domain)).toEqual(["real.com"]);
  });
});
