import { randomUUID } from "node:crypto";
import { JobKind, JobStatus } from "@prisma/client";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";

function authorized(site: { userId: string | null }, userId: string): boolean {
  // Project-only sites are intentionally invisible to the legacy browser UI
  // unless provisioning attached an explicit operator owner.
  return site.userId === userId;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { siteId } = await params;
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true, projectId: true },
    });
    if (!site || !authorized(site, userId)) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    let maxPages = 200;
    try {
      const body = (await req.json()) as { maxPages?: unknown };
      if (typeof body.maxPages === "number" && Number.isFinite(body.maxPages)) {
        maxPages = Math.max(1, Math.min(Math.floor(body.maxPages), 2000));
      }
    } catch {
      // Empty request bodies use the default.
    }

    const idempotencyKey =
      req.headers.get("idempotency-key")?.trim() || `browser:${siteId}:${randomUUID()}`;
    const existingJob = await db.job.findUnique({
      where: { siteId_kind_idempotencyKey: { siteId, kind: JobKind.CRAWL, idempotencyKey } },
      select: { id: true, status: true, payload: true },
    });
    if (existingJob) {
      const payload = existingJob.payload as { crawlId?: string };
      return Response.json(
        { jobId: existingJob.id, crawlId: payload.crawlId ?? null, status: existingJob.status },
        { status: existingJob.status === JobStatus.COMPLETED ? 200 : 202 }
      );
    }

    const running = await db.crawl.findFirst({
      where: { siteId, status: { in: ["PENDING", "RUNNING"] } },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
    if (running) {
      return Response.json(
        { error: "A crawl is already queued or running", crawlId: running.id },
        { status: 409 }
      );
    }

    const crawl = await db.crawl.create({
      data: { siteId, status: "PENDING", maxPages },
      select: { id: true },
    });
    try {
      const job = await enqueueJob({
        projectId: site.projectId,
        siteId,
        kind: JobKind.CRAWL,
        payload: { crawlId: crawl.id, maxPages, userId },
        idempotencyKey,
      });
      return Response.json({ jobId: job.id, crawlId: crawl.id, status: job.status }, { status: 202 });
    } catch (error) {
      await db.crawl.delete({ where: { id: crawl.id } }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    console.error("Crawl queue error:", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "Failed to queue crawl" }, { status: 500 });
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { siteId } = await params;
    const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true } });
    if (!site || !authorized(site, userId)) return Response.json({ error: "Not found" }, { status: 404 });

    const crawls = await db.crawl.findMany({
      where: { siteId },
      orderBy: { startedAt: "desc" },
      take: 10,
      include: { issues: { take: 200, orderBy: { severity: "asc" } } },
    });
    return Response.json(crawls);
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Failed to load crawls" }, { status: 500 });
  }
}
