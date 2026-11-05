import type { PrismaClient } from "@prisma/client";

import {
  acceptOpportunityIntoTask,
  taskPlanFromOpportunity,
  type TaskDb,
} from "@/lib/funnel/join";

/**
 * The acceptance boundary used by the server action.
 *
 * It binds the opportunity to the site's project before the task gate runs, and
 * forwards the decision version that was rendered to the person. The action itself
 * only authenticates and revalidates the page.
 */
export type AcceptOpportunityDb = TaskDb & Pick<PrismaClient, "site">;

export async function acceptOpportunityForSite(
  db: AcceptOpportunityDb,
  input: {
    siteId: string;
    opportunityId: string;
    assignedTo: string;
    expectedDecisionId?: string | null;
  }
): Promise<string> {
  const site = await db.site.findUnique({
    where: { id: input.siteId },
    select: { projectId: true },
  });
  if (!site) throw new Error("site not found");
  const opportunity = await db.opportunity.findUnique({
    where: { id: input.opportunityId },
    select: {
      projectId: true,
      title: true,
      summary: true,
      scoreInputs: true,
      recommendationDecision: true,
    },
  });
  if (!opportunity || opportunity.projectId !== site.projectId) {
    throw new Error("opportunity does not belong to the site's project");
  }
  return acceptOpportunityIntoTask(db, input.opportunityId, {
    title: opportunity.title,
    assignedTo: input.assignedTo,
    // The task carries the decision it came from: target page, change and check.
    plan: taskPlanFromOpportunity(opportunity),
    recommendationDecision: opportunity.recommendationDecision,
    expectedDecisionId: input.expectedDecisionId ?? null,
    expectedProjectId: site.projectId,
  });
}
