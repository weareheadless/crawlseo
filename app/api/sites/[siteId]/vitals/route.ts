import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { randomUUID } from "node:crypto";
import { JobKind, JobStatus } from "@prisma/client";
import { enqueueJob } from "@/lib/jobs/queue";

export const maxDuration = 60;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { siteId } = await params;
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true, projectId: true },
    });
    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const existing = await db.job.findFirst({
      where: { siteId, kind: JobKind.VITALS_SYNC, status: { in: [JobStatus.PENDING, JobStatus.RUNNING] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    if (existing) return Response.json({ queued: true, jobId: existing.id, status: existing.status }, { status: 202 });

    const job = await enqueueJob({
      projectId: site.projectId,
      siteId,
      kind: JobKind.VITALS_SYNC,
      payload: { limit: 5, userId },
      idempotencyKey: req.headers.get("idempotency-key")?.trim() || `browser-vitals:${siteId}:${randomUUID()}`,
    });
    return Response.json({ queued: true, jobId: job.id, status: job.status }, { status: 202 });
  } catch (error) {
    console.error(error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Vitals sync failed" },
      { status: 500 }
    );
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { siteId } = await params;
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true },
    });
    if (!site) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const reports = await db.vitalsReport.findMany({
      where: { siteId },
      orderBy: { date: "desc" },
      take: 50,
    });

    return Response.json(reports);
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Failed" }, { status: 500 });
  }
}
