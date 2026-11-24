import type { PrismaClient } from "@prisma/client";

/**
 * CMP-002: resolve an opportunity's query to the cluster that owns it.
 *
 * A query's cluster is **not a judgement**: `keyword_universe_membership` evidence
 * already stores it, proposed by the topic map and accepted by a human. So
 * resolving query → cluster is reading a stored fact, which is allowed; inferring
 * it from query tokens, path overlap or intent words is not, and is never done
 * here.
 *
 * A query with no membership row is unclustered. The opportunity says so rather
 * than being attached to the nearest-looking topic.
 */

export type ClusterResolution = { clusterId: string; slug: string };

/**
 * Normalize a query for comparison. Only facts that hold in every language:
 * case, accents and whitespace. Plural agreement, word order and synonyms stay
 * distinct here — the model owns those, and a normalizer that guessed them would
 * silently merge two different topics.
 */
export function normalizeQuery(query: string): string {
  return query
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

type MembershipDb = Pick<PrismaClient, "evidenceRecord" | "demandMapCluster">;

/**
 * The current query → cluster map for a project.
 *
 * Built once per detector run: one query, one map, every candidate resolved from
 * it. Reading it per candidate would be a query per opportunity.
 */
export async function clusterByQuery(
  db: MembershipDb,
  projectId: string
): Promise<Map<string, ClusterResolution>> {
  const memberships = await db.evidenceRecord.findMany({
    where: { projectId, kind: "keyword_universe_membership", supersededById: null },
    select: { dimensions: true },
  });

  const slugToId = new Map<string, string>();
  const clusters = await db.demandMapCluster.findMany({
    where: { projectId, supersededAt: null },
    select: { id: true, slug: true },
  });
  for (const cluster of clusters) slugToId.set(cluster.slug, cluster.id);

  const map = new Map<string, ClusterResolution>();
  for (const row of memberships) {
    const dimensions = (row.dimensions ?? {}) as { query?: unknown; cluster?: unknown };
    const query = typeof dimensions.query === "string" ? dimensions.query : "";
    const slug = typeof dimensions.cluster === "string" ? dimensions.cluster : "";
    if (query.trim() === "" || slug === "") continue;
    const clusterId = slugToId.get(slug);
    // A membership pointing at a superseded or deleted cluster resolves to
    // nothing: the documented topic is gone, so the query is unclustered.
    if (!clusterId) continue;
    map.set(normalizeQuery(query), { clusterId, slug });
  }
  return map;
}

/**
 * Resolve one opportunity's cluster.
 *
 * Precedence is the border between a fact and a guess:
 *  1. the query's membership row — a stored fact;
 *  2. a slug the detector already carries from evidence — also stored;
 *  3. nothing, and the opportunity is unclustered.
 */
export function resolveCluster(input: {
  query?: string | null;
  slug?: string | null;
  byQuery: Map<string, ClusterResolution>;
  slugToId?: Map<string, string>;
}): ClusterResolution | null {
  const query = (input.query ?? "").trim();
  if (query !== "") {
    const fromQuery = input.byQuery.get(normalizeQuery(query));
    if (fromQuery) return fromQuery;
  }
  const slug = (input.slug ?? "").trim();
  if (slug !== "") {
    const id = input.slugToId?.get(slug);
    if (id) return { clusterId: id, slug };
  }
  return null;
}

/**
 * The query a dedup key was built from.
 *
 * Detectors spell their keys differently — `O1:query:url`, `O8:url:TYPE`,
 * `phase3:lane:hash`. Only some carry the query in a readable position, so this
 * returns a candidate and the caller resolves it against the stored membership
 * map: a key segment that matches no membership is simply not a query.
 */
export function queryFromDedupKey(dedupKey: string): string | null {
  const parts = dedupKey.split(":");
  if (parts.length < 2) return null;
  const candidate = parts[1].trim();
  // A hash segment is not a query; requiring a space keeps opaque ids out.
  if (candidate === "" || !candidate.includes(" ") || candidate.length > 200) return null;
  return candidate;
}
