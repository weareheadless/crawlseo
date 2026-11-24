import type { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord } from "@/lib/funnel/evidence";

/**
 * CMP-004: declaring which queries a cluster is *tracked* on.
 *
 * The defect this fixes: `DemandMapCluster.tracked` is `true` on 0 of 540
 * clusters. `upsertCluster` accepts the flag, nothing ever sets it, and the demand
 * map's "Tracked" tile therefore reads 0 everywhere. A grid that is never
 * declared is a chart with nothing to draw.
 *
 * Two rules shape the selection:
 *
 * 1. **The model or the human chooses the grid.** An explicit `queries` list is
 *    used as given. Without one, the default is arithmetic on stored facts, not
 *    token matching: the query the cluster's own identity names (its declared hub,
 *    when the identity carries one and that query is a member), then the members
 *    with the highest measured demand — provider volume first, first-party
 *    impressions second. No query is invented and no phrase is guessed.
 * 2. **The grid is written on the membership, not on the query.** The issue
 *    forbids a second membership table and a duplicate flag on the query row, so
 *    the selection is a dimension on the existing `keyword_universe_membership`
 *    record: `grid: "tracked"`. One membership, one cluster, one answer.
 *
 * Declaring is idempotent: re-running writes the same rows to the same place and
 * supersedes nothing, so a person can re-declare a grid safely.
 */

/** How many queries one cluster's grid holds by default. */
export const DEFAULT_GRID_SIZE = 5;

/** The dimension that marks a membership as part of its cluster's grid. */
export const GRID_DIMENSION = "grid";
export const GRID_VALUE = "tracked";

export type GridDb = Pick<PrismaClient, "demandMapCluster" | "evidenceRecord" | "rawProviderResponse">;

export type GridMember = {
  query: string;
  /** Provider volume when the membership carries one, else 0. */
  volume: number;
  /** First-party impressions when the membership carries them, else 0. */
  impressions: number;
};

export type GridDeclaration = {
  clusterId: string;
  slug: string;
  /** Queries now marked as the cluster's grid, in declaration order. */
  tracked: string[];
  /** Members deliberately left off the grid, with the reason. */
  untracked: Array<{ query: string; reason: "beyond_grid_size" | "no_measured_demand" }>;
  /** True when the cluster has no members at all: nothing was declared. */
  empty: boolean;
};

type Membership = {
  id: string;
  query: string;
  volume: number;
  impressions: number;
  dimensions: Record<string, unknown>;
  metrics: Record<string, { value: number | null; unit?: string; source?: string }>;
};

/**
 * Read a cluster's members with the demand facts already stored on them.
 *
 * `derived:volume` / `derived:impressions` are written by the topic map from
 * first-party rows it read; a membership with neither has no measured demand and
 * cannot be ranked against its siblings.
 */
export async function clusterGridMembers(db: GridDb, input: { projectId: string; slug: string }): Promise<Membership[]> {
  const rows = await db.evidenceRecord.findMany({
    where: {
      projectId: input.projectId,
      kind: "keyword_universe_membership",
      supersededById: null,
    },
    select: { id: true, dimensions: true, metrics: true },
  });

  const members: Membership[] = [];
  for (const row of rows) {
    const dims = (row.dimensions ?? {}) as { cluster?: string; query?: string };
    if (dims.cluster !== input.slug || !dims.query) continue;
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    const volume = Number(metrics["derived:volume"]?.value ?? 0);
    const impressions = Number(metrics["derived:impressions"]?.value ?? 0);
    members.push({
      id: row.id,
      query: dims.query,
      volume: Number.isFinite(volume) ? volume : 0,
      impressions: Number.isFinite(impressions) ? impressions : 0,
      dimensions: (row.dimensions ?? {}) as Record<string, unknown>,
      metrics: (row.metrics ?? {}) as Membership["metrics"],
    });
  }
  return members;
}

/**
 * The declared hub of a cluster, when its identity names one and that query is a
 * member. `serp:<hub>` and `lexical:<phrase>` both carry the phrase discovery
 * chose; anything else (a curated slug, a competitor hash, a question hash) names
 * no member and returns null rather than guessing from the display name.
 */
export function hubFromIdentity(identityKey: string | null, members: Array<{ query: string }>): string | null {
  if (!identityKey) return null;
  const match = /^(?:serp|lexical):(.+)$/.exec(identityKey);
  if (!match) return null;
  const hub = match[1].trim().toLowerCase();
  const found = members.find((member) => member.query.trim().toLowerCase() === hub);
  return found?.query ?? null;
}

/**
 * Order members into a grid: the declared hub first, then by measured demand.
 *
 * A member with neither volume nor impressions still goes last rather than being
 * silently dropped — the grid is a person's choice, and an unmeasured member may
 * be exactly the one they want watched.
 */
export function orderGridMembers(
  members: GridMember[],
  opts: { hub?: string | null; size?: number }
): { selected: string[]; untracked: Array<{ query: string; reason: "beyond_grid_size" | "no_measured_demand" }> } {
  const size = Math.max(1, opts.size ?? DEFAULT_GRID_SIZE);
  const seen = new Set<string>();
  const unique: GridMember[] = [];
  for (const member of members) {
    const key = member.query.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(member);
  }

  const hubKey = opts.hub?.trim().toLowerCase() ?? null;
  const ranked = [...unique].sort((a, b) => {
    const aHub = hubKey != null && a.query.trim().toLowerCase() === hubKey;
    const bHub = hubKey != null && b.query.trim().toLowerCase() === hubKey;
    if (aHub !== bHub) return aHub ? -1 : 1;
    if (b.volume !== a.volume) return b.volume - a.volume;
    if (b.impressions !== a.impressions) return b.impressions - a.impressions;
    // A stable last resort, so the same input always yields the same grid.
    return a.query.localeCompare(b.query);
  });

  const selected = ranked.slice(0, size).map((member) => member.query);
  const untracked = ranked.slice(size).map((member) => ({
    query: member.query,
    reason: (member.volume === 0 && member.impressions === 0 ? "no_measured_demand" : "beyond_grid_size") as
      | "beyond_grid_size"
      | "no_measured_demand",
  }));
  return { selected, untracked };
}

/**
 * Declare a cluster's grid.
 *
 * `queries` wins when given: a person naming the grid is the authority. Otherwise
 * the default rule above chooses. Either way the flag lives on the membership, so
 * there is one place a tracked query is recorded per cluster.
 */
export async function declareTrackedGrid(
  db: GridDb,
  input: { projectId: string; clusterSlug: string; queries?: string[]; size?: number }
): Promise<GridDeclaration> {
  const cluster = await db.demandMapCluster.findFirst({
    where: { projectId: input.projectId, slug: input.clusterSlug },
    select: { id: true, slug: true, identityKey: true },
  });
  if (!cluster) throw new Error(`no cluster "${input.clusterSlug}" in this project`);

  const members = await clusterGridMembers(db, { projectId: input.projectId, slug: cluster.slug });
  if (members.length === 0) {
    return { clusterId: cluster.id, slug: cluster.slug, tracked: [], untracked: [], empty: true };
  }

  let selected: string[];
  let untracked: GridDeclaration["untracked"];
  if (input.queries?.length) {
    // A named grid must be made of this cluster's real members; a typo would
    // otherwise create a tracked query that no cluster owns.
    const byKey = new Map(members.map((member) => [member.query.trim().toLowerCase(), member.query]));
    const missing = input.queries.filter((query) => !byKey.has(query.trim().toLowerCase()));
    if (missing.length > 0) {
      throw new Error(`not a member of "${cluster.slug}": ${missing.join(", ")}`);
    }
    selected = input.queries.map((query) => byKey.get(query.trim().toLowerCase())!);
    const selectedKeys = new Set(selected.map((query) => query.trim().toLowerCase()));
    untracked = members
      .filter((member) => !selectedKeys.has(member.query.trim().toLowerCase()))
      .map((member) => ({ query: member.query, reason: "beyond_grid_size" as const }));
  } else {
    const ordered = orderGridMembers(members, {
      hub: hubFromIdentity(cluster.identityKey, members),
      size: input.size,
    });
    selected = ordered.selected;
    untracked = ordered.untracked;
  }

  const selectedKeys = new Set(selected.map((query) => query.trim().toLowerCase()));
  for (const member of members) {
    const shouldTrack = selectedKeys.has(member.query.trim().toLowerCase());
    const wasTracked = member.dimensions[GRID_DIMENSION] === GRID_VALUE;
    // Nothing to write when the membership already says the right thing: a
    // re-declaration must not mint a duplicate row with a new hash.
    if (shouldTrack === wasTracked) continue;
    const dimensions: Record<string, unknown> = { ...member.dimensions };
    if (shouldTrack) dimensions[GRID_DIMENSION] = GRID_VALUE;
    else delete dimensions[GRID_DIMENSION];
    // The membership keeps its own demand metrics: flipping the grid flag must
    // not change what the query's demand is.
    const stored = await storeEvidenceRecord(db, {
      projectId: input.projectId,
      siteId: null,
      kind: "keyword_universe_membership",
      observedAt: new Date(),
      producer: "cmp-004:grid",
      dimensions: dimensions as never,
      metrics: member.metrics as never,
    });
    // The old membership is replaced, not deleted: superseding keeps the history
    // of what the grid said when, and every reader already ignores superseded rows.
    await db.evidenceRecord.update({ where: { id: member.id }, data: { supersededById: stored.id } });
  }

  await db.demandMapCluster.update({ where: { id: cluster.id }, data: { tracked: true } });
  return { clusterId: cluster.id, slug: cluster.slug, tracked: selected, untracked, empty: false };
}
