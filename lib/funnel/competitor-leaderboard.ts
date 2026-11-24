import type { PrismaClient } from "@prisma/client";

/**
 * CMP-003: who is actually winning our queries.
 *
 * This is the difference between "we should rank better" and "this domain holds 9
 * of our 12 tracked queries at an average of 4.2". It is a read projection over
 * `competitor_rank` rows that a SERP snapshot already paid for — no second call,
 * no invented competitor.
 *
 * Three rules, each of which was a bug somewhere else in this codebase:
 *
 *  1. **A single observation is kept.** A domain seen once for one query appears
 *     with `queries: 1` and the sample count is stated, because "we only looked
 *     once" is information, not a reason to hide the row.
 *  2. **Every observed domain is stored and shown.** The declared competitor set
 *     is for emphasis only. Filtering the measurement to a list somebody typed
 *     would mean the leaderboard stops describing the SERP.
 *  3. **No competitor is derived from a string.** A domain is here because a
 *     snapshot named it, never because it looks like a rival.
 */

export type CompetitorRow = {
  domain: string;
  /** Distinct queries in this cluster where the domain ranked above us. */
  queries: number;
  /** Mean of the domain's best position across those queries. Lower is better. */
  averagePosition: number;
  bestPosition: number;
  /** Position bands, so an SEO can see whether they are 4 or 19. */
  at1to3: number;
  at4to10: number;
  at11to20: number;
  /** Queries this domain holds where we do not rank at all. */
  queriesWeDoNotRank: string[];
  /** True when a person declared this domain a competitor for the site. */
  declared: boolean;
};

export type CompetitorLeaderboard = {
  cluster: string;
  competitors: CompetitorRow[];
  /** How many snapshots fed this board. Stated, never implied. */
  samples: number;
  /** Queries in this cluster that have no competitor row yet. */
  queriesWithoutSample: number;
  /** Set when the cluster has no sampled SERP at all. */
  reason?: string;
};

export type CompetitorDb = Pick<PrismaClient, "evidenceRecord">;

/** A position is worth a band only when it is a real rank. */
function band(position: number, from: number, to: number): boolean {
  return position >= from && position <= to;
}

export async function clusterCompetitors(
  db: CompetitorDb,
  input: {
    projectId: string;
    clusterSlug: string;
    /** Domains a person declared for the site; emphasis only. */
    declared?: string[];
  }
): Promise<CompetitorLeaderboard> {
  const [rows, memberships, ranks] = await Promise.all([
    db.evidenceRecord.findMany({
      where: { projectId: input.projectId, kind: "competitor_rank", supersededById: null },
      select: { dimensions: true, metrics: true, observedAt: true },
    }),
    db.evidenceRecord.findMany({
      where: { projectId: input.projectId, kind: "keyword_universe_membership", supersededById: null },
      select: { dimensions: true },
    }),
    db.evidenceRecord.findMany({
      where: { projectId: input.projectId, kind: "keyword_rank", supersededById: null },
      select: { dimensions: true, metrics: true },
    }),
  ]);

  const clusterQueries = new Set<string>();
  for (const row of memberships) {
    const dims = (row.dimensions ?? {}) as { cluster?: string; query?: string };
    if (dims.cluster === input.clusterSlug && typeof dims.query === "string") clusterQueries.add(dims.query);
  }

  // Queries where our own page has a recorded rank. A query we rank for and a
  // domain outranks is a different statement from one we do not rank for at all.
  const ourRanked = new Set<string>();
  for (const row of ranks) {
    const dims = (row.dimensions ?? {}) as { query?: string };
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    const position = metrics["provider:position"]?.value ?? metrics["first_party:position"]?.value ?? null;
    if (dims.query && position != null && position > 0) ourRanked.add(dims.query);
  }

  const declared = new Set((input.declared ?? []).map((domain) => domain.trim().toLowerCase()));
  const samples = new Set<string>();
  const byDomain = new Map<
    string,
    {
      positions: Map<string, number>;
      queriesWeDoNotRank: Set<string>;
    }
  >();

  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as {
      query?: string;
      domain?: string;
      cluster?: string;
      observedAt?: string;
    };
    // Cluster membership can be absent on the row (the query had no accepted
    // membership when the snapshot was taken), so membership is resolved from the
    // cluster's own query set as well. Never from a domain string.
    const inCluster =
      dims.cluster === input.clusterSlug ||
      (typeof dims.query === "string" && clusterQueries.has(dims.query));
    if (!inCluster) continue;
    if (typeof dims.domain !== "string" || typeof dims.query !== "string") continue;
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    const position = metrics["provider:position"]?.value;
    if (position == null || position <= 0) continue;

    samples.add(dims.observedAt ?? row.observedAt.toISOString().slice(0, 10));
    const entry = byDomain.get(dims.domain) ?? { positions: new Map<string, number>(), queriesWeDoNotRank: new Set<string>() };
    // Best position wins when a domain appears twice for the same query across
    // samples: the leaderboard describes the domain's strength, not one bad month.
    const existing = entry.positions.get(dims.query);
    if (existing == null || position < existing) entry.positions.set(dims.query, position);
    if (!ourRanked.has(dims.query)) entry.queriesWeDoNotRank.add(dims.query);
    byDomain.set(dims.domain, entry);
  }

  const competitors: CompetitorRow[] = [...byDomain.entries()]
    .map(([domain, entry]) => {
      const positions = [...entry.positions.values()];
      return {
        domain,
        queries: entry.positions.size,
        averagePosition: Math.round((positions.reduce((sum, value) => sum + value, 0) / positions.length) * 10) / 10,
        bestPosition: Math.min(...positions),
        at1to3: positions.filter((position) => band(position, 1, 3)).length,
        at4to10: positions.filter((position) => band(position, 4, 10)).length,
        at11to20: positions.filter((position) => band(position, 11, 20)).length,
        queriesWeDoNotRank: [...entry.queriesWeDoNotRank].sort(),
        declared: declared.has(domain.toLowerCase()),
      };
    })
    .sort(
      (a, b) =>
        b.queries - a.queries ||
        a.averagePosition - b.averagePosition ||
        a.domain.localeCompare(b.domain)
    );

  const queriesWithRows = new Set<string>();
  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as { query?: string; cluster?: string };
    if (dims.cluster === input.clusterSlug && typeof dims.query === "string") queriesWithRows.add(dims.query);
    else if (typeof dims.query === "string" && clusterQueries.has(dims.query)) queriesWithRows.add(dims.query);
  }

  return {
    cluster: input.clusterSlug,
    competitors,
    samples: samples.size,
    queriesWithoutSample: [...clusterQueries].filter((query) => !queriesWithRows.has(query)).length,
    reason:
      competitors.length === 0
        ? clusterQueries.size === 0
          ? "This cluster has no members, so there is nothing to compare."
          : "No sampled SERP names a competitor for this cluster yet."
        : undefined,
  };
}
