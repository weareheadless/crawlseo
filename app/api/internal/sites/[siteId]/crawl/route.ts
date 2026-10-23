import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { JobKind, JobStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";

function authorized(req: Request): boolean {
  const configured = process.env.SITE_INTEL_INTERNAL_TOKEN;
  const header = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!configured || !header) return false;
  const expected = createHash("sha256").update(configured).digest();
  const actual = createHash("sha256").update(header).digest();
  return timingSafeEqual(expected, actual);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { siteId } = await params;
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { id: true, projectId: true, domain: true },
    });
    if (!site) return Response.json({ error: "Site not found" }, { status: 404 });

    let maxPages = 200;
    try {
      const body = (await req.json()) as { maxPages?: unknown };
      if (typeof body.maxPages === "number" && Number.isFinite(body.maxPages)) {
        maxPages = Math.max(1, Math.min(Math.floor(body.maxPages), 2000));
      }
    } catch {
      // Empty request bodies use the default.
    }

    const running = await db.crawl.findFirst({
      where: { siteId, status: { in: ["PENDING", "RUNNING"] } },
      orderBy: { startedAt: "desc" },
      select: { id: true, status: true },
    });
    if (running) {
      return Response.json(
        {
          error: "A crawl is already queued or running",
          crawlId: running.id,
          status: running.status,
        },
        { status: 409 }
      );
    }

    const idempotencyKey =
      req.headers.get("idempotency-key")?.trim() || `internal:${siteId}:${randomUUID()}`;
    const existingJob = await db.job.findUnique({
      where: { siteId_kind_idempotencyKey: { siteId, kind: JobKind.CRAWL, idempotencyKey } },
      select: { id: true, status: true, payload: true },
    });
    if (existingJob) {
      const payload = existingJob.payload as { crawlId?: string };
      return Response.json(
        {
          jobId: existingJob.id,
          crawlId: payload.crawlId ?? null,
          status: existingJob.status,
          reused: true,
        },
        { status: existingJob.status === JobStatus.COMPLETED ? 200 : 202 }
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
        payload: { crawlId: crawl.id, maxPages, source: "site-intel" },
        idempotencyKey,
      });
      return Response.json(
        { jobId: job.id, crawlId: crawl.id, status: job.status },
        { status: 202 }
      );
    } catch (error) {
      await db.crawl.delete({ where: { id: crawl.id } }).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    console.error("Internal crawl queue error:", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "Failed to queue crawl" }, { status: 500 });
  }
}
