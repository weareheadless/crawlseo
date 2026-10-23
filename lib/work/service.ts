import { db } from "@/lib/db";
import { ResearchServiceError } from "@/lib/research/service";

export async function getWorkData(siteId: string) {
  const [site, actions, drafts, agentTasks, runs] = await Promise.all([
    db.site.findUnique({ where: { id: siteId }, select: { id: true, domain: true } }),
    db.researchAction.findMany({
      where: { siteId },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: 200,
      include: { _count: { select: { drafts: true, agentTasks: true, deliveries: true } } },
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
  return { site, actions, drafts, agentTasks, runs };
}

export async function getActionDetail(siteId: string, actionId: string) {
  const action = await db.researchAction.findFirst({
    where: { id: actionId, siteId },
    include: {
      site: { select: { id: true, domain: true } },
      run: { select: { id: true, title: true, status: true } },
      finding: true,
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
  return action;
}
