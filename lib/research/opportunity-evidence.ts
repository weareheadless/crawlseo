import type { TopicCluster } from "@/lib/research/topic-map";

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
    for (const query of queries.slice(0, 2)) {
      const key = normalize(query.query);
      const rank = rankFor(query.query, 0);
      if (rank) ids.push(rank.id);
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
    const unique = [...new Set(ids)].slice(0, 8);
    result.set(cluster.slug, unique.length > 0 ? unique : (memberships.get(cluster.slug) ?? []).slice(0, 6));
  }
  return result;
}
