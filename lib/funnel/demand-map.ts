import { Prisma, type PrismaClient } from "@prisma/client";/**
 * Demand map (docs/seo-funnel-spine-plan.md §2.1): the per-project landscape —
 * offer/topics, query clusters, tracked grid, competitor set, our position.
 *
 * It is a derived, recomputable projection of EvidenceRecord. It stores no new
 * truth: clusters carry curated identity (slug, intent, business relevance);
 * every metric in the rollup is recomputed from evidence on demand.
 */

export type DemandMapDb = Pick<PrismaClient, "demandMapCluster" | "evidenceRecord" | "opportunity">;

export type UpsertClusterInput = {
  projectId: string;
  slug: string;
  name: string;
  topicSummary: string;
  intent: "informational" | "commercial" | "transactional" | "local" | "mixed";
  /** Declared: does the offer serve this need? { offers: string[], relevance: "core"|"adjacent"|"none", decidedBy } */
  businessRelevance: Record<string, unknown>;
  tracked?: boolean;
};

export async function upsertCluster(db: DemandMapDb, input: UpsertClusterInput) {
  if (!input.slug.trim()) throw new Error("cluster requires a slug");
  if (!input.topicSummary.trim()) throw new Error("cluster requires a topic summary (what need does this serve)");
  const relevance = input.businessRelevance as { relevance?: string; decidedBy?: string };
  if (relevance.relevance && !["core", "adjacent", "none"].includes(relevance.relevance)) {
    throw new Error('businessRelevance.relevance must be "core", "adjacent" or "none"');
  }
  if (relevance.relevance && relevance.relevance !== "none" && !relevance.decidedBy) {
    throw new Error("curated business relevance requires a decidedBy (declared inputs, no silent heuristics)");
  }
  return db.demandMapCluster.upsert({
    where: { projectId_slug: { projectId: input.projectId, slug: input.slug } },
    create: {
      projectId: input.projectId,
      slug: input.slug,
      // A curated cluster is its own identity: the slug is chosen by a person.
      identityKey: `curated:${input.slug}`,
      name: input.name,
      topicSummary: input.topicSummary,
      intent: input.intent,
      businessRelevance: input.businessRelevance as Prisma.InputJsonValue,
      tracked: input.tracked ?? false,
    },
    update: {
      name: input.name,
      topicSummary: input.topicSummary,
      intent: input.intent,
      businessRelevance: input.businessRelevance as never,
      tracked: input.tracked ?? undefined,
    },
    select: { id: true, slug: true },
  });
}

export type ClusterRollup = {
  clusterId: string;
  slug: string;
  intent: string;
  trackedQueries: number;
  ourBestPosition: number | null;
  competitorStrength: number; // 0–1: average presence of competitors above us
  coverageRatio: number; // 0–1: tracked queries with an on-site URL ranking
  shareOfVoice: number | null; // our CTR-weighted share vs competitors, when computable
  openOpportunities: number;
};

export async function recomputeDemandMap(db: DemandMapDb, projectId: string): Promise<ClusterRollup[]> {
  const clusters = await db.demandMapCluster.findMany({ where: { projectId }, orderBy: { slug: "asc" } });
  const memberships = await db.evidenceRecord.findMany({
    where: { projectId, kind: "keyword_universe_membership", supersededById: null },
    select: { dimensions: true },
  });
  const ranks = await db.evidenceRecord.findMany({
    where: {
      projectId,
      kind: { in: ["keyword_rank", "competitor_rank"] as never },
      supersededById: null,
    },
    select: { kind: true, dimensions: true, metrics: true },
  });
  const opportunityCounts = await db.opportunity.groupBy({
    by: ["clusterId"],
    where: { projectId, status: { in: ["detected", "accepted", "in_progress"] } },
    _count: { _all: true },
  });

  const clusterQueries = new Map<string, Map<string, number>>();
  for (const row of memberships) {
    const dims = row.dimensions as { cluster?: string; query?: string; volume?: number };
    if (!dims?.cluster || !dims?.query) continue;
    const perCluster = clusterQueries.get(dims.cluster as string) ?? new Map();
    perCluster.set(dims.query as string, (dims.volume as number) ?? 0);
    clusterQueries.set(dims.cluster as string, perCluster);
  }

  const positions = new Map<string, { our: number[]; competitors: Map<string, number[]> }>();
  for (const row of ranks) {
    const dims = row.dimensions as { cluster?: string; query?: string; url?: string; domain?: string; competitor?: string };
    const metrics = row.metrics as { [k: string]: { value: number | null; source?: string } };
    const position = metrics["provider:position"]?.value ?? metrics["first_party:position"]?.value ?? null;
    if (position == null || !dims?.cluster) continue;
    const entry = positions.get(dims.cluster as string) ?? { our: [], competitors: new Map<string, number[]>() };
    if (row.kind === "keyword_rank") {
      entry.our.push(position);
    } else {
      const competitor = (dims.competitor as string) ?? (dims.domain as string) ?? "unknown";
      const list = entry.competitors.get(competitor) ?? [];
      list.push(position);
      entry.competitors.set(competitor, list);
    }
    positions.set(dims.cluster as string, entry);
  }

  const countByCluster = new Map(opportunityCounts.map((row) => [row.clusterId, row._count._all]));

  return clusters.map((cluster) => {
    const queries = clusterQueries.get(cluster.slug);
    const trackedQueries = queries?.size ?? 0;
    const pos = positions.get(cluster.slug);
    const ourBest = pos?.our.length ? Math.min(...pos.our) : null;
    const coverageRatio = pos && trackedQueries > 0 ? new Set(pos.our.map(() => true)).size > 0 && pos.our.length > 0 ? Math.min(1, pos.our.length / trackedQueries) : 0 : 0;
    const competitorAvg =
      pos && pos.competitors.size
        ? [...pos.competitors.values()].reduce((acc, list) => acc + Math.min(...list), 0) / pos.competitors.size
        : null;
    const competitorStrength = competitorAvg == null ? 0 : Math.max(0, Math.min(1, 1 - (competitorAvg - 1) / 19));
    return {
      clusterId: cluster.id,
      slug: cluster.slug,
      intent: cluster.intent,
      trackedQueries,
      ourBestPosition: ourBest,
      competitorStrength,
      coverageRatio,
      shareOfVoice: ourBest == null ? null : Math.max(0, 1 - (ourBest - 1) / 19),
      openOpportunities: countByCluster.get(cluster.id) ?? 0,
    };
  });
}
