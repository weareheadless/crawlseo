"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { refreshFunnelForSite } from "@/lib/funnel/backfill";
import { acceptOpportunityIntoTask, recordAgentPreparation, confirmHumanStep, taskPlanFromOpportunity } from "@/lib/funnel/join";
import { decideOpportunity } from "@/lib/funnel/opportunity";

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
export async function acceptOpportunityAction(siteId: string, opportunityId: string) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  await requireSiteAccess(siteId);
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, name: true } });
  const executor = user?.name || user?.email || userId;
  const opportunity = await db.opportunity.findUnique({
    where: { id: opportunityId },
    select: { title: true, summary: true, scoreInputs: true, recommendationDecision: true },
  });
  if (!opportunity) redirect(`/sites/${siteId}/opportunities`);
  const taskId = await acceptOpportunityIntoTask(db as never, opportunityId, {
    title: opportunity.title,
    assignedTo: executor,
    // The task carries the decision it came from: target page, change and check.
    plan: taskPlanFromOpportunity(opportunity),
    recommendationDecision: opportunity.recommendationDecision,
  });
  revalidatePath(`/sites/${siteId}/opportunities/${opportunityId}`);
  revalidatePath(`/sites/${siteId}/work`);
  redirect(`/sites/${siteId}/opportunities/${opportunityId}?task=${taskId}`);
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
