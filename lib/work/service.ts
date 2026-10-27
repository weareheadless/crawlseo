import { db } from "@/lib/db";
import { ResearchServiceError } from "@/lib/research/service";
import { sourceIdsForAction } from "@/lib/research/evidence";

export async function getWorkData(siteId: string) {
  const [site, actions, drafts, agentTasks, runs] = await Promise.all([
    db.site.findUnique({ where: { id: siteId }, select: { id: true, domain: true, projectId: true } }),
    db.researchAction.findMany({
      where: { siteId },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: 200,
      include: {
        finding: { select: { evidenceSourceIds: true } },
        _count: { select: { drafts: true, agentTasks: true, deliveries: true } },
      },
    }),
    db.contentDraft.findMany({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        actionId: true,
        title: true,
        format: true,
        status: true,
        createdAt: true,
      },
    }),
    db.agentTask.findMany({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { action: { select: { id: true, title: true } } },
    }),
    db.researchRun.findMany({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { _count: { select: { sources: true, findings: true, actions: true } } },
    }),
  ]);
  if (!site) throw new ResearchServiceError("Site not found", 404);
  const prelaunchRuns = site.projectId ? await db.seoResearchRun.findMany({ where: { projectId: site.projectId, siteId: null }, orderBy: { periodStart: "desc" }, take: 10, select: { id: true, periodStart: true, status: true } }) : [];
  return { site, actions, drafts, agentTasks, runs, prelaunchRuns };
}

export async function getActionDetail(siteId: string, actionId: string) {
  const action = await db.researchAction.findFirst({
    where: { id: actionId, siteId },
    include: {
      site: { select: { id: true, domain: true } },
      run: {
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
        },
      },
      finding: true,
      questionCoverages: { include: { document: { select: { id: true, logicalId: true } } }, orderBy: { updatedAt: "desc" } },
      drafts: { orderBy: { createdAt: "desc" } },
      deliveries: { orderBy: { createdAt: "desc" }, take: 20 },
      agentTasks: {
        orderBy: { createdAt: "desc" },
        include: {
          messages: { orderBy: { createdAt: "asc" }, take: 200 },
          artifacts: { orderBy: { createdAt: "desc" }, take: 100 },
        },
      },
    },
  });
  if (!action) throw new ResearchServiceError("Action not found", 404);
  const citedSourceIds = sourceIdsForAction(action);
  const evidenceSources = citedSourceIds.length > 0
    ? await db.researchSource.findMany({
        where: { id: { in: citedSourceIds } },
        orderBy: { retrievedAt: "desc" },
        take: 200,
      })
    : [];
  return { ...action, evidenceSources };
}
