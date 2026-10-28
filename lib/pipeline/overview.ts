import { db } from "@/lib/db";

const LIMIT = 20;

export async function readPipelineOverview(siteId: string) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true } });
  const [runs, actions, latestRun, business, profile, measured] = await Promise.all([
    db.researchRun.findMany({
      where: { siteId, status: { in: ["QUEUED", "RUNNING"] } },
      orderBy: { createdAt: "desc" },
      take: LIMIT + 1,
      select: { id: true, title: true, status: true, createdAt: true },
    }),
    db.researchAction.findMany({
      where: {
        siteId,
        updatedAt: { gte: since },
        OR: [
          { status: { in: ["PROPOSED", "APPROVED", "DRAFTING", "DRAFT_READY", "DELIVERY_APPROVED", "DELIVERING"] } },
          { preparationStatus: "BLOCKED" },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: LIMIT + 1,
      select: { id: true, title: true, status: true, preparationStatus: true, updatedAt: true },
    }),
    db.researchRun.findFirst({
      where: { siteId },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true, createdAt: true },
    }),
    site?.projectId
      ? db.businessKnowledgeDocument.findUnique({
          where: { projectId: site.projectId },
          select: { revision: true, acceptedRevision: true, updatedAt: true },
        })
      : null,
    db.siteProfile.findUnique({
      where: { siteId },
      select: { audience: true, topics: true, updatedAt: true },
    }),
    db.researchAction.findMany({
      where: { siteId, deliveries: { some: { outcomeMeasuredAt: { not: null } } } },
      orderBy: { updatedAt: "desc" },
      take: 3,
      select: {
        id: true,
        title: true,
        deliveries: {
          where: { outcomeMeasuredAt: { not: null } },
          orderBy: { outcomeMeasuredAt: "desc" },
          take: 1,
          select: { outcomeMeasuredAt: true },
        },
      },
    }),
  ]);

  return {
    windowDays: 30,
    since,
    runs: runs.slice(0, LIMIT),
    runsTruncated: runs.length > LIMIT,
    actions: actions.slice(0, LIMIT),
    actionsTruncated: actions.length > LIMIT,
    latestRun,
    business: business
      ? { revision: business.revision, acceptedRevision: business.acceptedRevision, updatedAt: business.updatedAt }
      : null,
    profile: profile
      ? {
          hasAudience: Boolean(profile.audience),
          topicCount: Array.isArray(profile.topics) ? profile.topics.length : 0,
          updatedAt: profile.updatedAt,
        }
      : null,
    measured: measured.map((action) => ({
      id: action.id,
      title: action.title,
      measuredAt: action.deliveries[0]?.outcomeMeasuredAt ?? null,
    })),
  };
}
