import { db } from "@/lib/db";

/**
 * Resolve the site a project-scoped MCP caller represents. A project may hold
 * both a locally managed production site and an externally bound tenant site
 * (for example a HelloAda test host). The bound site is the tenant identity, so
 * it wins over the oldest project row.
 */
export async function projectSite(projectId: string) {
  const select = { id: true, domain: true, gscProperty: true, userId: true } as const;
  const bound = await db.site.findFirst({
    where: { projectId, connectorBinding: { is: { status: "ACTIVE" } } },
    select,
    orderBy: { createdAt: "asc" },
  });
  if (bound) return bound;

  const site = await db.site.findFirst({
    where: { projectId },
    select,
    orderBy: { createdAt: "asc" },
  });
  if (!site) throw new Error("Project has no site");
  return site;
}
