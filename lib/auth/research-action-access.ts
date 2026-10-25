import { db } from "@/lib/db";

/** Cookie-authenticated actions are accessible only through their owning site. */
export async function userOwnsResearchAction(actionId: string, userId: string): Promise<boolean> {
  const action = await db.researchAction.findFirst({
    where: { id: actionId, site: { userId } },
    select: { id: true },
  });
  return Boolean(action);
}

/** Cookie-authenticated site endpoints must not reveal another owner's site. */
export async function userOwnsSite(siteId: string, userId: string): Promise<boolean> {
  const site = await db.site.findFirst({
    where: { id: siteId, userId },
    select: { id: true },
  });
  return Boolean(site);
}

export async function userOwnsResearchRun(runId: string, userId: string): Promise<boolean> {
  const run = await db.researchRun.findFirst({
    where: { id: runId, site: { userId } },
    select: { id: true },
  });
  return Boolean(run);
}

export async function userOwnsDelivery(deliveryId: string, userId: string): Promise<boolean> {
  const delivery = await db.delivery.findFirst({
    where: { id: deliveryId, action: { site: { userId } } },
    select: { id: true },
  });
  return Boolean(delivery);
}

export async function userOwnsAgentTask(taskId: string, userId: string): Promise<boolean> {
  const task = await db.agentTask.findFirst({
    where: { id: taskId, site: { userId } },
    select: { id: true },
  });
  return Boolean(task);
}
