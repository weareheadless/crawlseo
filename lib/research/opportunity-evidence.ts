import type { TopicCluster } from "@/lib/research/topic-map";
import type { DraftEvidence } from "@/lib/research/opportunity-drafting";

/**
 * Select the evidence a proposal actually rests on.
 *
 * `keyword_universe_membership` says a query belongs to a topic; it is not the
 * evidence that the site can win it. The board's "how we win it" leg should show
 * the Search Console query row, the keyword metrics and the SERP snapshot for
 * the member queries. Membership is only a fallback when no query evidence
 * exists.
 */

export type ClusterEvidenceRow = {
  id: string;
  kind: string;
  dimensions: unknown;
  metrics: unknown;
  observedAt: Date;
};

/**
 * Fold a query to the form the same query is compared in.
 *
 * **Accents are folded, because they are a spelling of one phrase, not two phrases.**
 * Measured 2026-11-24 on atelier-harmonie: `tapisserie de siège` sat in the topic map
 * with an accent, the sampled SERP wrote `tapisserie de siege` without one, and the two
 * never met — so 12 `competitor_rank` rows and the keyword they describe were dropped as
 * "no topic to file it under". NFKC normalises the encoding but keeps the accent
 * (`siège` stays `siège`), which is why this needs the diacritic strip as well.
 *
 * This is the one kind of normalisation `AGENTS.md` allows code to do: case, accents and
 * whitespace are facts in every language. Plural agreement, word order and synonyms are
 * not, and stay the model's job.
 */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * How far above us a query's best competitor sits, in places.
 *
 * The decision-relevant measure is not "who is number one" but "is this a fight we can
 * win soon". A competitor 2 places above us is a rewrite; one 40 places above us is a
 * different project. Returns null when we have no recorded position — an unknown
 * distance, not a zero.
 */
function placesAbove(ours: number | null | undefined, theirs: number): number | null {
  if (ours == null || !Number.isFinite(ours) || !Number.isFinite(theirs)) return null;
  // A smaller number is a better position, so a competitor above us has a lower one.
  return theirs < ours ? ours - theirs : null;
}

/** A query as the selector needs it, whether it came from a cluster or from sampled SERPs. */
export type CandidateQuery = {
  query: string;
  impressions: number;
  volume: number | null;
  /** Our best recorded position, or null when we do not rank. */
  position: number | null;
  clusterSlug: string | null;
};

/**
 * Order the queries a cluster's competitor evidence should cover.
 *
 * **This ordering is the fix, not a detail.** A content gap is a query we do not rank
 * for, which means it earns roughly no impressions. Sorting by impressions therefore
 * prefers the queries we already own — the opposite of where the gaps are. Measured
 * 2026-11-24 on atelier-harmonie: of the 5 queries with competitor rows where we rank
 * nowhere at all, **0** survived a top-2-by-impressions cut, and 13 of the 22 queries
 * carrying competitor data were ones we already ranked top 10 for.
 *
 * The order is:
 *
 *  1. **A gap first.** We do not rank, a competitor does. This is the largest gap there
 *     is and it cannot be found by looking at our own numbers.
 *  2. **Then the winnable fights**, nearest competitor above us first — a query where we
 *     are 6th and they are 4th is a rewrite; 45th against 1st is a different project.
 *  3. **Then everything else**, by demand, so the list is still ordered when nothing is
 *     close.
 *
 * Demand is the tie-break inside each band, never the primary sort.
 */
export function orderByOpportunity(
  candidates: CandidateQuery[],
  bestCompetitorPosition: (query: string) => number | null
): CandidateQuery[] {
  const rank = (row: CandidateQuery): [number, number, number] => {
    const theirs = bestCompetitorPosition(row.query);
    // A query we do not rank for, where somebody does, is the first thing to look at.
    if (row.position == null && theirs != null) return [0, 0, -row.impressions];
    const gap = placesAbove(row.position, theirs ?? Number.POSITIVE_INFINITY);
    // Nearest fight first; unknown distance sorts after any known one.
    if (gap != null) return [1, gap, -row.impressions];
    return [2, 0, -row.impressions];
  };
  return candidates
    .slice()
    .sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || a.query.localeCompare(b.query);
    });
}

/**
 * A stated payload bound. Exceeding it is reported in `truncations`, never silent.
 *
 * The old code used bare slices, which is how "we send the top 6 by impressions" became a
 * policy nobody chose. These are the numbers, named, and the count of what they dropped
 * travels with the run.
 */
export const COMPETITOR_CONTEXT_BOUNDS = {
  /** Queries per cluster that carry competitor context. */
  queriesPerCluster: 6,
  /** Sampled domains per query: the ones directly above us, plus the leader. */
  domainsPerQuery: 3,
  /** Evidence rows per cluster in the drafting payload. */
  evidencePerCluster: 20,
} as const;

/**
 * A query a paid SERP sampled, with nobody to file it under.
 *
 * The largest gaps are exactly the queries a site has no page for, and a query with no
 * page has no cluster either — so the topic map never sees it and the filing step has
 * nothing to attach it to. Returning them as data (not only as a sentence in the report)
 * is what lets them reach the model.
 */
export type UnfiledCompetitorQuery = {
  query: string;
  /** Sampled domains, best position first, with the evidence ids that prove them. */
  competitors: Array<{ domain: string; position: number; evidenceId: string }>;
  /** Our own position, or null when we do not rank at all. */
  ourPosition: number | null;
};

export type ClusterEvidenceSelection = {
  idsByCluster: Map<string, string[]>;
  /** What the bounds dropped, named per cluster so the run report can state it. */
  truncations: string[];
  /** Sampled queries no cluster could claim. Carried, not dropped. */
  unfiled: UnfiledCompetitorQuery[];
};

export function buildClusterEvidenceIds(
  clusters: TopicCluster[],
  rows: ClusterEvidenceRow[]
): Map<string, string[]> {
  return selectClusterEvidence(clusters, rows).idsByCluster;
}

export function selectClusterEvidence(
  clusters: TopicCluster[],
  rows: ClusterEvidenceRow[],
  /**
   * Queries the topic map's review already ruled out, folded, with the reason.
   *
   * A sampled SERP says a query exists; it does not say the business serves it. Measured
   * 2026-11-24 on atelier-harmonie: three of the seven unfiled queries had been judged
   * out of market or plain noise by a human — `restauration fauteuil
   * saint-germain-en-laye` (outside Normandy), `lustre artisanal` (not sold) and
   * `art et tapisserie` (a different trade). Carrying those to the model would overrule
   * a decision a person already made, so they are excluded here and reported as excluded
   * rather than as opportunities.
   */
  excludedByReview: Map<string, string> = new Map()
): ClusterEvidenceSelection {
  const ranks = new Map<string, Array<{ id: string; impressions: number; observedAt: Date }>>();
  const metrics = new Map<string, { id: string; observedAt: Date }>();
  const serps = new Map<string, { id: string; observedAt: Date }>();
  const memberships = new Map<string, string[]>();
  /** Every sampled domain per query, deduped by domain on read. */
  const competitors = new Map<
    string,
    Array<{ id: string; domain: string; position: number; observedAt: Date; query: string }>
  >();
  /** Our own best position per query, so a gap can be identified without the cluster. */
  const ourPosition = new Map<string, number>();
  /**
   * The cluster a sampled SERP row itself declares.
   *
   * 21 of 130 competitor rows on atelier-harmonie carry none, and those queries are the
   * ones missing from the keyword universe. Keeping the declared value apart from the
   * membership map is what lets a cluster claim a query it never had a membership for.
   */
  const competitorCluster = new Map<string, string>();

  for (const row of rows) {
    const dimensions = asRecord(row.dimensions);
    const query = typeof dimensions.query === "string" ? normalize(dimensions.query) : null;
    if (row.kind === "keyword_rank" && query) {
      if (dimensions.windowRole === "previous") continue;
      const metric = asRecord(asRecord(row.metrics)["first_party:impressions"]);
      const impressions = typeof metric.value === "number" ? metric.value : 0;
      ranks.set(query, [...(ranks.get(query) ?? []), { id: row.id, impressions, observedAt: row.observedAt }]);
      const position =
        typeof asRecord(asRecord(row.metrics)["first_party:position"]).value === "number"
          ? (asRecord(asRecord(row.metrics)["first_party:position"]).value as number)
          : typeof asRecord(asRecord(row.metrics)["provider:position"]).value === "number"
            ? (asRecord(asRecord(row.metrics)["provider:position"]).value as number)
            : null;
      if (position != null && position > 0) {
        const held = ourPosition.get(query);
        if (held == null || position < held) ourPosition.set(query, position);
      }
    } else if (row.kind === "keyword_metrics" && query) {
      const current = metrics.get(query);
      if (!current || row.observedAt > current.observedAt) metrics.set(query, { id: row.id, observedAt: row.observedAt });
    } else if (row.kind === "serp_snapshot" && query) {
      const current = serps.get(query);
      if (!current || row.observedAt > current.observedAt) serps.set(query, { id: row.id, observedAt: row.observedAt });
    } else if (row.kind === "competitor_rank" && query) {
      // CMP-003: the domain and its absolute position are the whole point of the row.
      const domain = typeof dimensions.domain === "string" ? dimensions.domain : null;
      const position =
        typeof dimensions.rankAbsolute === "number"
          ? dimensions.rankAbsolute
          : typeof asRecord(asRecord(row.metrics)["provider:position"]).value === "number"
            ? (asRecord(asRecord(row.metrics)["provider:position"]).value as number)
            : null;
      if (typeof dimensions.cluster === "string" && !competitorCluster.has(query)) {
        competitorCluster.set(query, dimensions.cluster);
      }
      if (domain && position != null) {
        competitors.set(query, [
          ...(competitors.get(query) ?? []),
          {
            id: row.id,
            domain,
            position,
            observedAt: row.observedAt,
            // The row's own spelling, kept so an unfiled query can be shown the way the
            // SERP wrote it rather than in the folded form used for comparison.
            query: typeof dimensions.query === "string" ? dimensions.query : query,
          },
        ]);
      }
    } else if (row.kind === "keyword_universe_membership") {
      const cluster = typeof dimensions.cluster === "string" ? dimensions.cluster : null;
      if (cluster) memberships.set(cluster, [...(memberships.get(cluster) ?? []), row.id]);
    }
  }

  /** Distinct domains for a query, newest row per domain, lowest position first. */
  const domainsFor = (query: string) => {
    const byDomain = new Map<string, { id: string; domain: string; position: number; observedAt: Date; query: string }>();
    for (const row of competitors.get(normalize(query)) ?? []) {
      const held = byDomain.get(row.domain);
      if (!held || row.observedAt > held.observedAt) byDomain.set(row.domain, row);
    }
    return [...byDomain.values()].sort((a, b) => a.position - b.position);
  };
  const bestCompetitorPosition = (query: string): number | null => domainsFor(query)[0]?.position ?? null;

  const result = new Map<string, string[]>();
  const truncations: string[] = [];
  /**
   * Queries a cluster actually covered. A sampled SERP row that no cluster claims is not
   * a bound being hit — it is an observation falling on the floor, and the two must not
   * look the same in the report.
   */
  const claimed = new Set<string>();

  for (const cluster of clusters) {
    // Every query this cluster knows about, including ones only a sampled SERP names.
    // A query with competitor rows but no membership is still a real gap: measured
    // 2026-11-24, 21 of 130 competitor rows on atelier-harmonie had no cluster, and all
    // four of their queries were absent from the keyword universe — the largest gaps on
    // the site, invisible because nothing filed them.
    /**
     * Keyed on the folded spelling, so a query the map writes with an accent and a SERP
     * writes without one are the same query. `query` keeps the map's own spelling for
     * display; every lookup uses the folded key.
     */
    const byName = new Map<string, CandidateQuery>();
    for (const query of cluster.queries) {
      const key = normalize(query.query);
      byName.set(key, {
        query: query.query,
        impressions: query.impressions ?? 0,
        volume: query.volume ?? null,
        position: query.position ?? ourPosition.get(key) ?? null,
        clusterSlug: cluster.slug,
      });
    }
    for (const key of competitors.keys()) {
      if (byName.has(key)) continue;
      // A query a sampled SERP names, and this cluster owns it by its own dimension. That
      // is the shape of a real gap — measured 2026-11-24, all four such queries on
      // atelier-harmonie were absent from the keyword universe — so it belongs here, not
      // in a side table nobody reads.
      if (competitorCluster.get(key) !== cluster.slug) continue;
      const existing = cluster.queries.find((query) => normalize(query.query) === key);
      byName.set(key, {
        query: existing?.query ?? key,
        impressions: existing?.impressions ?? 0,
        volume: existing?.volume ?? null,
        position: existing?.position ?? ourPosition.get(key) ?? null,
        clusterSlug: cluster.slug,
      });
    }

    for (const key of byName.keys()) claimed.add(normalize(key));
    const ordered = orderByOpportunity([...byName.values()], bestCompetitorPosition);
    const withCompetitors = ordered.filter((row) => bestCompetitorPosition(row.query) != null);
    const bound = COMPETITOR_CONTEXT_BOUNDS.queriesPerCluster;
    /**
     * Opportunity first, then the plain top of the cluster.
     *
     * Most clusters have no sampled SERP at all, and they still need their own rank and
     * keyword-metric evidence — a competitor ordering that returned nothing for them
     * would trade one blind spot for a bigger one. So the fight-worthy queries take the
     * bound first and the rest of the slots are filled by demand, which is the old
     * behaviour and the right one when there is no fight to order.
     */
    const covered = [
      ...withCompetitors.slice(0, bound),
      ...ordered.filter((row) => bestCompetitorPosition(row.query) == null).slice(0, Math.max(0, bound - withCompetitors.length)),
    ];
    if (withCompetitors.length > Math.min(withCompetitors.length, bound)) {
      truncations.push(
        `${cluster.slug}: ${withCompetitors.length - Math.min(withCompetitors.length, bound)} of ${withCompetitors.length} queries with competitor data were not sent (bound: ${bound})`
      );
    }

    const ids: string[] = [];
    const rankFor = (query: string, index: number) =>
      (ranks.get(normalize(query)) ?? [])
        .sort((a, b) => b.impressions - a.impressions || b.observedAt.getTime() - a.observedAt.getTime())[index];

    for (const candidate of covered) {
      const key = normalize(candidate.query);
      const rank = rankFor(candidate.query, 0);
      if (rank) ids.push(rank.id);
      // The domains immediately above us, plus the leader for context. "Who is number
      // one" is not the fight; "who is one place above us" is — so the nearest gets the
      // budget first and the leader is kept in whatever room is left.
      const domains = domainsFor(candidate.query);
      const ours = candidate.position;
      const bound = COMPETITOR_CONTEXT_BOUNDS.domainsPerQuery;
      // No recorded position means we are not on the page at all, so the whole sampled
      // top is above us and the leader is the one to name.
      const chosen =
        ours == null
          ? domains.slice(0, bound)
          : [
              ...new Set([
                ...domains.filter((row) => row.position < ours).slice(-(bound - 1)).reverse(),
                ...(domains.length > 0 ? [domains[0]] : []),
              ]),
            ];
      for (const row of chosen) ids.push(row.id);
      // The strongest competitor is worth saying explicitly when we do not rank at all.
      const metric = metrics.get(key);
      if (metric) ids.push(metric.id);
      const serp = serps.get(key);
      if (serp) ids.push(serp.id);
    }
    for (const candidate of ordered.slice(0, 2)) {
      const rank = rankFor(candidate.query, 0);
      if (rank) ids.push(rank.id);
    }

    const unique = [...new Set(ids)].slice(0, COMPETITOR_CONTEXT_BOUNDS.evidencePerCluster);
    if ([...new Set(ids)].length > COMPETITOR_CONTEXT_BOUNDS.evidencePerCluster) {
      truncations.push(
        `${cluster.slug}: ${[...new Set(ids)].length - COMPETITOR_CONTEXT_BOUNDS.evidencePerCluster} evidence rows were not sent (bound: ${COMPETITOR_CONTEXT_BOUNDS.evidencePerCluster})`
      );
    }
    result.set(cluster.slug, unique.length > 0 ? unique : (memberships.get(cluster.slug) ?? []).slice(0, 6));
  }
  /**
   * Report the competitor observations no cluster could take.
   *
   * Measured 2026-11-24 on atelier-harmonie: 21 of 130 `competitor_rank` rows carried no
   * cluster, and all four of their queries were absent from the keyword universe — real
   * demand with a named incumbent and no page, which is exactly what a gap list should
   * lead with. They are not lost, but they are also not attributable to a topic here, so
   * the run says so instead of letting them disappear.
   */
  const allUnfiled = [...competitors.keys()].filter((query) => !claimed.has(query));
  const overruled = allUnfiled.filter((query) => excludedByReview.has(query));
  const unfiledQueries = allUnfiled.filter((query) => !excludedByReview.has(query));
  if (overruled.length > 0) {
    // Stated, not silently dropped: the SERP did find demand the review then declined.
    const named = overruled.slice(0, 5).map((query) => `"${competitors.get(query)?.[0]?.query ?? query}"`).join(", ");
    truncations.push(
      `${overruled.length} sampled quer${overruled.length === 1 ? "y" : "ies"} had competitor data but the topic review already excluded ${overruled.length === 1 ? "it" : "them"}, so ${overruled.length === 1 ? "it was" : "they were"} not proposed: ${named}${overruled.length > 5 ? ", …" : ""}`
    );
  }
  if (unfiledQueries.length > 0) {
    const named = unfiledQueries.slice(0, 5).map((query) => `"${query}"`).join(", ");
    truncations.push(
      `${unfiledQueries.length} quer${unfiledQueries.length === 1 ? "y" : "ies"} had a sampled SERP but no topic to file it under: ${named}${unfiledQueries.length > 5 ? ", …" : ""}. They are sent to the drafting call as unfiled observations, listed under no topic.`
    );
  }
  const unfiled: UnfiledCompetitorQuery[] = unfiledQueries.map((query) => ({
    // The folded key is not a spelling anyone wrote; the sampled row's own spelling is.
    query: competitors.get(query)?.[0]?.query ?? query,
    competitors: domainsFor(query).map((row) => ({ domain: row.domain, position: row.position, evidenceId: row.id })),
    ourPosition: ourPosition.get(query) ?? null,
  }));
  return { idsByCluster: result, truncations, unfiled };
}

/**
 * Build the evidence catalogue the drafting call sees: one compact row per
 * selected evidence record, grouped by cluster. The model can only cite ids
 * from this catalogue, which is how a proposal's claim stays checkable.
 */
export function buildClusterEvidenceCatalogue(
  clusters: TopicCluster[],
  rows: ClusterEvidenceRow[],
  idsByCluster: Map<string, string[]>
): Map<string, DraftEvidence[]> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const catalogue = new Map<string, DraftEvidence[]>();
  for (const cluster of clusters) {
    const entries: DraftEvidence[] = [];
    for (const id of idsByCluster.get(cluster.slug) ?? []) {
      const row = byId.get(id);
      if (!row) continue;
      const dimensions = asRecord(row.dimensions);
      const metrics = asRecord(row.metrics);
      const metric = (key: string): number | null => {
        const value = asRecord(metrics[key]).value;
        return typeof value === "number" ? value : null;
      };
      entries.push({
        id: row.id,
        kind: row.kind,
        query: typeof dimensions.query === "string" ? dimensions.query : null,
        position: metric("first_party:position"),
        impressions: metric("first_party:impressions"),
        volume: metric("provider:volume"),
        url: typeof dimensions.url === "string" ? dimensions.url : null,
        // CMP-003: a competitor row is meaningless without the domain that holds the
        // position. `position` above is *our* Search Console position, so a competitor
        // row would otherwise arrive with a null position and no name — unusable.
        domain: typeof dimensions.domain === "string" ? dimensions.domain : null,
        rank: metric("provider:position") ?? (typeof dimensions.rankAbsolute === "number" ? dimensions.rankAbsolute : null),
      });
    }
    catalogue.set(cluster.slug, entries);
  }
  return catalogue;
}
