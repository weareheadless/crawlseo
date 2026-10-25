import { getUserIdFromCookies } from "@/lib/session-helper";
import { addAgentMessage, listAgentMessages } from "@/lib/agent-tasks/chat";
import { updateAgentTask } from "@/lib/agent-tasks/service";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobKind } from "@prisma/client";
import { ResearchServiceError } from "@/lib/research/service";
import { z } from "zod";
import { ZodError } from "zod";

const schema = z.object({ content: z.string().trim().min(1).max(20_000) });

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  try {
    return Response.json({ messages: await listAgentMessages(taskId) });
  } catch (error) {
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "Failed to load messages" }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  try {
    const { content } = schema.parse(await req.json());
    const message = await addAgentMessage(taskId, content, "HUMAN");
    const task = await db.agentTask.findUnique({
      where: { id: taskId },
      select: { status: true, siteId: true },
    });
    let systemMessage = null;
    let jobId: string | null = null;
    if (task) {
      if (["AWAITING_REVIEW", "APPROVED", "COMMITTED", "PUBLISHED", "CLOSED"].includes(task.status)) {
        await updateAgentTask(taskId, { status: "CHANGES_REQUESTED", errorCode: null });
      }
      const activeJob = await db.job.findFirst({
        where: {
          siteId: task.siteId,
          kind: JobKind.AGENT_TASK,
          status: { in: ["PENDING", "RUNNING"] },
          payload: { path: ["agentTaskId"], equals: taskId },
        },
        select: { id: true },
      });
      if (!activeJob) {
        const job = await enqueueJob({
          siteId: task.siteId,
          kind: JobKind.AGENT_TASK,
          payload: { agentTaskId: taskId },
          idempotencyKey: `agent-task:${taskId}:followup:${Date.now()}`,
          maxAttempts: 1,
        });
        jobId = job.id;
      }
      systemMessage = await addAgentMessage(
        taskId,
        jobId ? "Follow-up requested. Agent run queued." : "Follow-up requested. The agent is already running.",
        "SYSTEM",
      );
    }
    return Response.json({ message, systemMessage, reopened: Boolean(systemMessage), jobId }, { status: 201 });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid message" }, { status: 400 });
    }
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Agent message error:", error);
    return Response.json({ error: "Failed to send message" }, { status: 500 });
  }
}
