"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { refreshFunnelForSite } from "@/lib/funnel/backfill";
import { recordAgentPreparation, confirmHumanStep } from "@/lib/funnel/join";
import { acceptOpportunityForSite } from "@/lib/funnel/accept";
import { decideOpportunity } from "@/lib/funnel/opportunity";
import { prepareOpportunityWithAgent } from "@/lib/agent-tasks/opportunity-task";

/**
 * Funnel actions. Detection is automatic; these are the human decisions the
 * plan reserves for a person (docs/seo-funnel-spine-plan.md §3):
 * refresh evidence, accept/park an opportunity, and confirm execution steps.
 * None of them spends money or calls a paid provider.
 */

async function requireSiteAccess(siteId: string) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, projectId: true } });
  if (!site || (site.userId && site.userId !== userId)) redirect("/sites");
  return site;
}

export async function refreshFunnelAction(siteId: string) {
  await requireSiteAccess(siteId);
  await refreshFunnelForSite(db as never, siteId, { detectedBy: "funnel-refresh" });
  revalidatePath(`/sites/${siteId}/opportunities`);
  revalidatePath(`/sites/${siteId}`);
  revalidatePath(`/sites/${siteId}/demand`);
  revalidatePath(`/sites/${siteId}/evidence`);
}

export async function decideOpportunityAction(
  siteId: string,
  opportunityId: string,
  decision: "accepted" | "parked" | "rejected",
  reason?: string
) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  await requireSiteAccess(siteId);
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  const decidedBy = user?.name || user?.email || userId;
  await decideOpportunity(db as never, opportunityId, decision, decidedBy, reason);
  revalidatePath(`/sites/${siteId}/opportunities`);
  revalidatePath(`/sites/${siteId}/opportunities/${opportunityId}`);
  revalidatePath(`/sites/${siteId}/work`);
}

/** The single task-creation gate: a task exists only by accepting an opportunity. */
export async function acceptOpportunityAction(
  siteId: string,
  opportunityId: string,
  expectedDecisionId?: string | null
) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  await requireSiteAccess(siteId);
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  const executor = user?.name || user?.email || userId;
  const taskId = await acceptOpportunityForSite(db as never, {
    siteId,
    opportunityId,
    assignedTo: executor,
    expectedDecisionId: expectedDecisionId ?? null,
  });
  revalidatePath(`/sites/${siteId}/opportunities/${opportunityId}`);
  revalidatePath(`/sites/${siteId}/work`);
  redirect(`/sites/${siteId}/opportunities/${opportunityId}?task=${taskId}`);
}

/**
 * Turn an accepted opportunity into a page or article task the agent can
 * prepare. The funnel task stays the human's record; this creates the action
 * and agent task that actually deliver.
 *
 * An article needs a draft written first, which can take a minute. The result
 * is returned instead of thrown so a failure shows as a message on the page
 * the person is reading, not as an error screen that replaces it.
 */
export async function prepareOpportunityWithAgentAction(
  siteId: string,
  opportunityId: string,
): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  await requireSiteAccess(siteId);
  try {
    const task = await prepareOpportunityWithAgent(opportunityId, siteId);
    revalidatePath(`/sites/${siteId}/opportunities/${opportunityId}`);
    revalidatePath(`/sites/${siteId}/work`);
    return { ok: true, taskId: task.id };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.message
        ? error.message
        : "The agent could not prepare this task. Try again.",
    };
  }
}

export async function confirmTaskStepAction(
  siteId: string,
  opportunityId: string,
  taskId: string,
  status: "in_progress" | "delivered" | "verified_outcome"
) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  await requireSiteAccess(siteId);
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  await confirmHumanStep(db as never, taskId, { status, confirmedBy: user?.name || user?.email || userId });
  revalidatePath(`/sites/${siteId}/opportunities/${opportunityId}`);
  revalidatePath(`/sites/${siteId}/work`);
}

export async function attachAgentPlanAction(siteId: string, opportunityId: string, taskId: string) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  await requireSiteAccess(siteId);
  await recordAgentPreparation(db as never, taskId, {
    agentId: "crawlseo-agent",
    plan: { note: "Plan drafted by the funnel agent; awaiting human confirmation.", draftedAt: new Date().toISOString() },
  });
  revalidatePath(`/sites/${siteId}/opportunities/${opportunityId}`);
  revalidatePath(`/sites/${siteId}/work`);
}
