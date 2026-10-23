import { db } from "@/lib/db";
import { getContentActionPlan } from "@/lib/ai-seo/content-plan";
import { createResearchAction } from "@/lib/research/service";

/**
 * Persist the existing GSC/crawl opportunity plan into the central Action queue.
 * The plan is deterministic; the Action layer adds review status and dedupe.
 */
export async function syncSeoOpportunitiesToActions(siteId: string) {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, domain: true },
  });
  if (!site) return { created: 0, existing: 0, total: 0 };

  const plan = await getContentActionPlan(siteId, site.domain);
  let created = 0;
  let existing = 0;

  for (const action of plan.actions) {
    const result = await createResearchAction(
      siteId,
      {
        source: "seo_opportunity",
        kind: action.kind,
        format: action.format,
        title: action.title,
        primaryQuery: action.primaryQuery || undefined,
        targetUrl: action.targetUrl || undefined,
        recommendation: action.recommendedAction,
        evidence: {
          action_id: action.id,
          signals: action.signals,
          intent: action.intent,
          expected_clicks: action.expectedClicks,
          metrics: action.evidence,
          page: action.page,
        },
        priority: action.score,
        automationMode: "MANUAL",
      },
      "seo-engine",
    );
    if (result.created) created += 1;
    else existing += 1;
  }

  return { created, existing, total: plan.actions.length };
}
