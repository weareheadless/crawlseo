import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { syncGSCDataForSite } from "@/lib/workers/gsc-sync";
import { randomUUID } from "node:crypto";
import { JobKind } from "@prisma/client";
import { enqueueJob } from "@/lib/jobs/queue";

export async function POST(req: Request) {
  try {
    const userId = await getUserIdFromCookies();
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { siteId } = (await req.json()) as { siteId?: string };
    if (!siteId) return Response.json({ error: "Missing siteId" }, { status: 400 });
    const site = await db.site.findFirst({
      where: { id: siteId, userId },
      select: { userId: true, projectId: true },
    });
    if (!site) {
      return Response.json({ error: "Site not found or unauthorized" }, { status: 404 });
    }

    if (site.projectId) {
      const job = await enqueueJob({
        projectId: site.projectId,
        siteId,
        kind: JobKind.GSC_SYNC,
        payload: { daysBack: 28 },
        idempotencyKey: req.headers.get("idempotency-key")?.trim() || `browser-gsc:${siteId}:${randomUUID()}`,
      });
      return Response.json({ queued: true, jobId: job.id, status: job.status }, { status: 202 });
    }

    const result = await syncGSCDataForSite(userId, siteId, 28);
    if (!result.success) {
      return Response.json({ error: result.error ?? "Failed to sync GSC data" }, { status: 502 });
    }
    return Response.json(result);
  } catch (error) {
    console.error("Error syncing GSC data:", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "Failed to sync GSC data" }, { status: 500 });
  }
}
