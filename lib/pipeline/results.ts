import { db } from "@/lib/db";
import { splitObservations } from "@/lib/research/aeo-geo-view";

export type ResultEvidence = {
  actionId: string; title: string; status: string; updatedAt: Date;
  deliveryStatus: string | null; deliveredAt: Date | null; verifiedAt: Date | null;
  measuredAt: Date | null; outcomeRecorded: boolean;
  result: "not_delivered" | "delivered_unverified" | "verification_recorded" | "verified_unmeasured" | "measured_unattributed";
};

export function projectResultEvidence(input: Omit<ResultEvidence, "result">): ResultEvidence {
  let result: ResultEvidence["result"] = "not_delivered";
  if (input.deliveredAt || input.deliveryStatus) {
    result = input.verifiedAt ? "verification_recorded" : "delivered_unverified";
  }
  return { ...input, result };
}

/** Read bounded, explicitly action-related outcomes and site/project-scoped observations. */
export async function readPipelineResults(siteId: string, projectId: string | null) {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const [actions, rawObservations] = await Promise.all([
    db.researchAction.findMany({
      where: { siteId, updatedAt: { gte: since } }, orderBy: { updatedAt: "desc" }, take: 51,
      select: { id: true, title: true, status: true, updatedAt: true, deliveredAt: true, verifiedAt: true,
        deliveries: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, createdAt: true, verifiedAt: true, outcome: true, outcomeMeasuredAt: true } } },
    }),
    projectId ? db.aIVisibilityObservation.findMany({ where: { projectId, observedAt: { gte: since } }, orderBy: { observedAt: "desc" }, take: 101,
      select: { provider: true, modelSurface: true, observedAt: true, sourceKind: true, coverage: true } }) : Promise.resolve([]),
  ]);
  const evidence = actions.slice(0, 50).map((action) => {
    const delivery = action.deliveries[0];
    const deliveredAt = action.deliveredAt ?? delivery?.createdAt ?? null;
    const verifiedAt = action.verifiedAt ?? delivery?.verifiedAt ?? null;
    return projectResultEvidence({ actionId: action.id, title: action.title, status: action.status, updatedAt: action.updatedAt,
      deliveryStatus: delivery?.status ?? null, deliveredAt, verifiedAt,
      measuredAt: delivery?.outcomeMeasuredAt ?? null, outcomeRecorded: delivery?.outcome != null });
  });
  const split = splitObservations(rawObservations);
  return {
    windowDays: 90, since, actions: evidence, hasMoreActions: actions.length > 50,
    observations: split.customer.slice(0, 100), fixtureObservations: split.fixtures.length,
    hasMoreObservations: split.customer.length > 100 || rawObservations.length > 100,
  };
}
