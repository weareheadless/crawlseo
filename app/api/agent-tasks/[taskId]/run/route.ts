import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobKind } from "@prisma/client";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, siteId: true, status: true },
  });
  if (!task) return Response.json({ error: "Agent task not found" }, { status: 404 });
  if (!["READY", "CHANGES_REQUESTED"].includes(task.status)) {
    return Response.json({ error: `Agent task is ${task.status}; only READY or CHANGES_REQUESTED tasks can run` }, { status: 409 });
  }
  const job = await enqueueJob({
    siteId: task.siteId,
    kind: JobKind.AGENT_TASK,
    payload: { agentTaskId: task.id },
    idempotencyKey: `agent-task:${task.id}:${Date.now()}`,
    maxAttempts: 1,
  });
  return Response.json({ jobId: job.id, status: job.status }, { status: 202 });
}
