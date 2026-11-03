import { JobKind, JobStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import { processNextJob } from "./job-worker";
import { randomUUID } from "node:crypto";

export async function smokeSiteLessJob() {
  const project = await db.project.findFirst({ select: { id: true } });
  if (!project) throw new Error("Worker release smoke requires at least one project");
  const key = `release-smoke:${randomUUID()}`;
  const job = await enqueueJob({ projectId: project.id, siteId: null, kind: JobKind.AGENT_TASK, payload: {}, idempotencyKey: key, maxAttempts: 1 });
  // A live worker loop may claim the job first; poll to a terminal state and
  // process in-process as a fallback, so the smoke is deterministic either way.
  const deadline = Date.now() + 30_000;
  let result: { status: JobStatus; siteId: string | null; lastErrorCode: string | null } | null = null;
  while (Date.now() < deadline) {
    result = await db.job.findUnique({ where: { id: job.id }, select: { status: true, siteId: true, lastErrorCode: true } });
    if (result && result.status !== JobStatus.PENDING && result.status !== JobStatus.RUNNING) break;
    await processNextJob().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (result?.siteId !== null || result.status !== JobStatus.FAILED || result.lastErrorCode !== "AGENT_SITE_REQUIRED") throw new Error(`Site-less worker smoke failed: ${result?.status ?? "missing job"} (${result?.lastErrorCode ?? "no error code"})`);
}

if (process.argv[1]?.endsWith("smoke-worker-release.ts")) {
  smokeSiteLessJob().then(() => console.log("Site-less worker release smoke completed")).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
}
