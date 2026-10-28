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

/** Pure projection: counts always describe the returned rows; fixtures are never customer actions. */
export function projectFindings<T extends FindingRow>(rows: readonly T[], options: { limit?: number; dimension?: FindingDimension } = {}) {
  const limit = Math.max(1, Math.min(options.limit ?? FINDINGS_LIMIT, FINDINGS_LIMIT));
  const customer = rows.filter((row) => row.source !== "fixture" && row.projectId !== "fixture");
  const filtered = customer.filter((row) => options.dimension === undefined || options.dimension === "all" || actionDimension(row) === options.dimension);
  const returned = filtered.slice(0, limit);
  return { rows: returned, count: returned.length, limit, hasMore: filtered.length > limit, available: customer.length > 0 };
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
