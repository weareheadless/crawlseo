import { db } from "@/lib/db";
import { resolveSiteAuthority } from "@/lib/research/execution-authority";

/** Cookie-authenticated actions are accessible only through their owning site. */
export async function userOwnsResearchAction(actionId: string, userId: string): Promise<boolean> {
  const action = await db.researchAction.findFirst({
    where: { id: actionId, OR: [{ site: { userId } }, { site: { userId: null } }] },
    select: { id: true },
  });
  return Boolean(action);
}

/** Cookie-authenticated site endpoints must not reveal another owner's site. */
export async function userOwnsSite(siteId: string, userId: string): Promise<boolean> {
  const site = await db.site.findFirst({
    where: { id: siteId, OR: [{ userId }, { userId: null }] },
    select: { id: true },
  });
  return Boolean(site);
}

export async function userOwnsResearchRun(runId: string, userId: string): Promise<boolean> {
  const run = await db.researchRun.findFirst({
    where: { id: runId, OR: [{ site: { userId } }, { site: { userId: null } }] },
    select: { id: true },
  });
  return Boolean(run);
}

export async function userOwnsDelivery(deliveryId: string, userId: string): Promise<boolean> {
  const delivery = await db.delivery.findFirst({
    where: {
      id: deliveryId,
      OR: [{ action: { site: { userId } } }, { action: { site: { userId: null } } }],
    },
    select: { id: true },
  });
  return Boolean(delivery);
}

export async function userOwnsAgentTask(taskId: string, userId: string): Promise<boolean> {
  const task = await db.agentTask.findFirst({
    where: { id: taskId, OR: [{ site: { userId } }, { site: { userId: null } }] },
    select: { id: true },
  });
  return Boolean(task);
}

export type ResearchActionAccess = "owner" | "external" | "missing";

/**
 * Resolve what a signed-in owner may do with an Action. An Action on a site
 * whose active executor is external is readable, but its owner decisions belong
 * to that executor's review surface, so the local UI must not mutate it.
 */
export async function researchActionAccess(actionId: string, userId: string): Promise<ResearchActionAccess> {
  const action = await db.researchAction.findFirst({
    where: { id: actionId },
    select: {
      site: {
        select: {
          id: true,
          domain: true,
          userId: true,
          connectorBinding: { select: { executor: true, status: true } },
        },
      },
    },
  });
  if (!action) return "missing";
  // Project-owned rows (userId null) are visible and operable to the signed-in
  // operator, matching the single-operator site and crawl routes. Another
  // user's owned site stays private.
  if (action.site.userId !== null && action.site.userId !== userId) return "missing";
  const authority = await resolveSiteAuthority(action.site);
  return authority.managed ? "external" : "owner";
}
