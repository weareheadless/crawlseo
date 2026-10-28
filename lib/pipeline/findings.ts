import { db } from "@/lib/db";
import { actionDimension, type ActionDimension } from "@/lib/work/categories";

export const FINDINGS_LIMIT = 100;
export type FindingRow = {
  id: string;
  title: string;
  recommendation: string;
  kind: string;
  source: string;
  status: string;
  updatedAt: Date;
  targetUrl: string | null;
  projectId: string | null;
  finding: { summary: string; run: { id: string; createdAt: Date } } | null;
};
export type FindingDimension = ActionDimension | "all";

export function recordedRunInputState(input: { brief: unknown; topics: unknown; providers: unknown; policyRevision?: number | null }): "brief" | "stored_fields" | "not_recorded" {
  const hasBrief = input.brief !== null && typeof input.brief === "object" && !Array.isArray(input.brief);
  const hasStoredLists = (Array.isArray(input.topics) && input.topics.length > 0) || (Array.isArray(input.providers) && input.providers.length > 0);
  if (hasBrief) return "brief";
  return hasStoredLists ? "stored_fields" : "not_recorded";
}

export function formatResearchCost(costMicros: number | null): string {
  return costMicros == null || !Number.isFinite(costMicros) ? "Not recorded" : `$${(costMicros / 1_000_000).toFixed(4)}`;
}

/** Pure projection over canonical actions. Fixture markers apply to imported observations, not actions. */
export function projectFindings<T extends FindingRow>(rows: readonly T[], options: { limit?: number; dimension?: FindingDimension } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? FINDINGS_LIMIT, FINDINGS_LIMIT));
  const filtered = rows.filter((row) => options.dimension === undefined || options.dimension === "all" || actionDimension(row) === options.dimension);
  const returned = filtered.slice(0, limit);
  return { rows: returned, count: returned.length, limit, hasMore: filtered.length > limit, available: rows.length > 0 };
}

/** Read only canonical actions and their recorded finding/run relation, always scoped to the site. */
export async function readFindings(siteId: string, dimension?: FindingDimension) {
  const rows = await db.researchAction.findMany({
    where: { siteId },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: FINDINGS_LIMIT + 1,
    select: {
      id: true, title: true, recommendation: true, kind: true, source: true, status: true,
      updatedAt: true, targetUrl: true, projectId: true,
      finding: { select: { summary: true, run: { select: { id: true, createdAt: true } } } },
    },
  });
  return projectFindings(rows, { dimension });
}
