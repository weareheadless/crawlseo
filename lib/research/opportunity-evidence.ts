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

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function buildClusterEvidenceIds(
  clusters: TopicCluster[],
  rows: ClusterEvidenceRow[]
): Map<string, string[]> {
  const ranks = new Map<string, Array<{ id: string; impressions: number; observedAt: Date }>>();
  const metrics = new Map<string, { id: string; observedAt: Date }>();
  const serps = new Map<string, { id: string; observedAt: Date }>();
  const memberships = new Map<string, string[]>();
  /**
   * Who ranks above us, per query. A `competitor_rank` row is one domain's position on
   * one SERP, so a query has several; the top two are the ones the work has to beat.
   */
  const competitors = new Map<string, Array<{ id: string; domain: string; position: number; observedAt: Date }>>();

  for (const row of rows) {
    const dimensions = asRecord(row.dimensions);
    const query = typeof dimensions.query === "string" ? normalize(dimensions.query) : null;
    if (row.kind === "keyword_rank" && query) {
      if (dimensions.windowRole === "previous") continue;
      const metric = asRecord(asRecord(row.metrics)["first_party:impressions"]);
      const impressions = typeof metric.value === "number" ? metric.value : 0;
      ranks.set(query, [...(ranks.get(query) ?? []), { id: row.id, impressions, observedAt: row.observedAt }]);
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
      if (domain && position != null) {
        competitors.set(query, [
          ...(competitors.get(query) ?? []),
          { id: row.id, domain, position, observedAt: row.observedAt },
        ]);
      }
    } else if (row.kind === "keyword_universe_membership") {
      const cluster = typeof dimensions.cluster === "string" ? dimensions.cluster : null;
      if (cluster) memberships.set(cluster, [...(memberships.get(cluster) ?? []), row.id]);
    }
  }

  const result = new Map<string, string[]>();
  for (const cluster of clusters) {
    const ids: string[] = [];
    const queries = [...cluster.queries]
      .sort((a, b) => b.impressions - a.impressions || (b.volume ?? 0) - (a.volume ?? 0))
      .slice(0, 6);
    // A compact mix for the "how we win it" leg: GSC row, keyword metrics and
    // SERP for the top two queries, then a second GSC row for two more queries.
    const rankFor = (query: string, index: number) =>
      (ranks.get(normalize(query)) ?? [])
        .sort((a, b) => b.impressions - a.impressions || b.observedAt.getTime() - a.observedAt.getTime())[index];
    /**
     * The best-placed sampled domains for a query, lowest position first.
     *
     * Deduped by domain: a query is sampled monthly, so the same domain holds the same
     * position in several rows and sending three copies of it spends the evidence budget
     * on one competitor. The newest row for a domain wins.
     */
    const bestCompetitors = (query: string, count: number) => {
      const byDomain = new Map<string, { id: string; domain: string; position: number; observedAt: Date }>();
      for (const row of competitors.get(normalize(query)) ?? []) {
        const held = byDomain.get(row.domain);
        if (!held || row.observedAt > held.observedAt) byDomain.set(row.domain, row);
      }
      return [...byDomain.values()].sort((a, b) => a.position - b.position).slice(0, count);
    };
    for (const query of queries.slice(0, 2)) {
      const key = normalize(query.query);
      const rank = rankFor(query.query, 0);
      if (rank) ids.push(rank.id);
      // The two best-placed competitors on this query come first in the remaining
      // budget, so the proposal can say who it has to beat and cite the row that
      // proves it. Without these the model writes a self-assessment ("we sit at
      // 27") and calls it a content gap — measured 2026-11-24: 0 of 45 live
      // content-gap rows named a competitor.
      for (const competitor of bestCompetitors(query.query, 2)) ids.push(competitor.id);
      const metric = metrics.get(key);
      if (metric) ids.push(metric.id);
      const serp = serps.get(key);
      if (serp) ids.push(serp.id);
    }
    for (const query of queries.slice(2, 4)) {
      const rank = rankFor(query.query, 0);
      if (rank) ids.push(rank.id);
    }
    for (const query of queries.slice(0, 2)) {
      const rank = rankFor(query.query, 1);
      if (rank) ids.push(rank.id);
    }
    // 8 → 14: two competitors per top query are now in this budget, and a cap that
    // silently dropped them would defeat the purpose of adding them.
    const unique = [...new Set(ids)].slice(0, 14);
    result.set(cluster.slug, unique.length > 0 ? unique : (memberships.get(cluster.slug) ?? []).slice(0, 6));
  }
  return result;
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
