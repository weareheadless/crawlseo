import { db } from "@/lib/db";
import { resolveSiteAuthority } from "@/lib/research/execution-authority";

/**
 * Access is workspace-wide.
 *
 * One deployment serves one operator workspace: the dashboard lists every site,
 * the site routes render every site, and the project rows carry no owner. The
 * API used to gate on `site.userId`, which made pages that rendered fine answer
 * 404 from their own progress, preview and action calls whenever the signed-in
 * account was not the account that had created the site — an agent console that
 * polled a 404 every two seconds and never left "Queued".
 *
 * So these helpers answer "does this record exist in this workspace", and the
 * session check is the only boundary: a request without a user is refused by
 * the route before it gets here. A per-user boundary belongs to a workspace
 * model, not to five functions that disagree with every page.
 */
function signedIn(userId: string): boolean {
  return Boolean(userId.trim());
}

export async function userOwnsResearchAction(actionId: string, userId: string): Promise<boolean> {
  if (!signedIn(userId)) return false;
  const action = await db.researchAction.findFirst({ where: { id: actionId }, select: { id: true } });
  return Boolean(action);
}

export async function userOwnsSite(siteId: string, userId: string): Promise<boolean> {
  if (!signedIn(userId)) return false;
  const site = await db.site.findFirst({ where: { id: siteId }, select: { id: true } });
  return Boolean(site);
}

export async function userOwnsResearchRun(runId: string, userId: string): Promise<boolean> {
  if (!signedIn(userId)) return false;
  const run = await db.researchRun.findFirst({ where: { id: runId }, select: { id: true } });
  return Boolean(run);
}

export async function userOwnsDelivery(deliveryId: string, userId: string): Promise<boolean> {
  if (!signedIn(userId)) return false;
  const delivery = await db.delivery.findFirst({ where: { id: deliveryId }, select: { id: true } });
  return Boolean(delivery);
}

export async function userOwnsAgentTask(taskId: string, userId: string): Promise<boolean> {
  if (!signedIn(userId)) return false;
  const task = await db.agentTask.findFirst({ where: { id: taskId }, select: { id: true } });
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
          projectId: true,
          domain: true,
          userId: true,
          connectorBinding: { select: { executor: true, status: true } },
        },
      },
    },
  });
  if (!action) return "missing";
  if (!signedIn(userId)) return "missing";
  // Workspace-wide, like every page that lists these sites. The authority
  // check below still decides whether this UI may mutate the row, because an
  // externally executed Action belongs to that executor's review surface.
  const authority = await resolveSiteAuthority(action.site);
  return authority.managed ? "external" : "owner";
}
