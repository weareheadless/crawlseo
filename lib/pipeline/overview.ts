import { db } from "@/lib/db";

const LIMIT = 20;
export async function readPipelineOverview(siteId: string) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [runs, actions, latestCrawl] = await Promise.all([
    db.researchRun.findMany({ where: { siteId, status: { in: ["QUEUED", "RUNNING"] } }, orderBy: { createdAt: "desc" }, take: LIMIT + 1,
      select: { id: true, title: true, status: true, createdAt: true } }),
    db.researchAction.findMany({ where: { siteId, updatedAt: { gte: since }, OR: [{ status: { in: ["PROPOSED", "APPROVED", "DRAFTING", "DRAFT_READY", "DELIVERY_APPROVED", "DELIVERING"] } }, { preparationStatus: "BLOCKED" }] }, orderBy: { updatedAt: "desc" }, take: LIMIT + 1,
      select: { id: true, title: true, status: true, preparationStatus: true, updatedAt: true } }),
    db.researchRun.findFirst({ where: { siteId }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, createdAt: true } }),
  ]);
  return { windowDays: 30, since, runs: runs.slice(0, LIMIT), runsTruncated: runs.length > LIMIT,
    actions: actions.slice(0, LIMIT), actionsTruncated: actions.length > LIMIT, latestRun: latestCrawl };
}
