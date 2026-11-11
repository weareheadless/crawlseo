import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { userOwnsAgentTask } from "@/lib/auth/research-action-access";
import { readAgentProgress } from "@/lib/agent-tasks/progress";
import { JobKind } from "@prisma/client";

/**
 * The live view of a run.
 *
 * The page used to read progress once, on the server render, so the operator
 * had to refresh to see anything. This returns the same data the page renders
 * so the console can poll it while a run is in flight.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  if (!(await userOwnsAgentTask(taskId, userId))) {
    return Response.json({ error: "Agent task not found" }, { status: 404 });
  }

  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: {
      status: true,
      errorCode: true,
      startedAt: true,
      completedAt: true,
      updatedAt: true,
      result: true,
      messages: {
        orderBy: { createdAt: "asc" },
        take: 100,
        select: { id: true, role: true, content: true, createdAt: true },
      },
      artifacts: {
        where: { kind: "preview_html" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
    },
  });
  if (!task) return Response.json({ error: "Agent task not found" }, { status: 404 });

  // A run is queued before it is RUNNING, so the job is part of the state the
  // console polls: without it the console would stop during the queue window.
  const job = await db.job.findFirst({
    where: {
      kind: JobKind.AGENT_TASK,
      payload: { path: ["agentTaskId"], equals: taskId },
    },
    orderBy: { createdAt: "desc" },
    select: { status: true, attempts: true, maxAttempts: true, lastErrorCode: true },
  });

  return Response.json(
    {
      task: {
        status: task.status,
        errorCode: task.errorCode,
        startedAt: task.startedAt,
        completedAt: task.completedAt,
        updatedAt: task.updatedAt,
        progress: readAgentProgress(task.result),
        previewAt: task.artifacts[0]?.createdAt ?? null,
      },
      messages: task.messages,
      job: job
        ? {
            status: job.status,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            errorCode: job.lastErrorCode,
          }
        : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
