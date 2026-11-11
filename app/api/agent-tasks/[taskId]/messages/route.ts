import { getUserIdFromCookies } from "@/lib/session-helper";
import { addAgentMessage, listAgentMessages } from "@/lib/agent-tasks/chat";
import { updateAgentTask } from "@/lib/agent-tasks/service";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobKind } from "@prisma/client";
import { ResearchServiceError } from "@/lib/research/service";
import { z } from "zod";
import { ZodError } from "zod";
import { userOwnsAgentTask } from "@/lib/auth/research-action-access";
import { acceptsAgentFollowUp, followUpTargetStatus } from "@/lib/agent-tasks/transitions";

const schema = z.object({ content: z.string().trim().min(1).max(20_000) });

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  if (!(await userOwnsAgentTask(taskId, userId))) return Response.json({ error: "Agent task not found" }, { status: 404 });
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
  if (!(await userOwnsAgentTask(taskId, userId))) return Response.json({ error: "Agent task not found" }, { status: 404 });
  try {
    const { content } = schema.parse(await req.json());
    const task = await db.agentTask.findUnique({
      where: { id: taskId },
      select: { status: true, siteId: true, kind: true },
    });
    const message = await addAgentMessage(taskId, content, "HUMAN");
    let systemMessage = null;
    let jobId: string | null = null;
    let queued = false;
    if (task) {
      // A correction reopens the task for a run instead of leaving it in a
      // review or published state where the worker would refuse to start.
      let status = task.status;
      if (acceptsAgentFollowUp(status)) {
        const target = followUpTargetStatus(status);
        if (target !== status) {
          await updateAgentTask(taskId, { status: target, errorCode: null });
          status = target;
        }
      }
      const runnable = task.kind !== "wix_article" && ["READY", "CHANGES_REQUESTED"].includes(status);
      const activeJob = await db.job.findFirst({
        where: {
          siteId: task.siteId,
          kind: JobKind.AGENT_TASK,
          status: { in: ["PENDING", "RUNNING"] },
          payload: { path: ["agentTaskId"], equals: taskId },
        },
        select: { id: true },
      });
      if (runnable && !activeJob) {
        const job = await enqueueJob({
          siteId: task.siteId,
          kind: JobKind.AGENT_TASK,
          payload: { agentTaskId: taskId },
          idempotencyKey: `agent-task:${taskId}:followup:${Date.now()}`,
          maxAttempts: 1,
        });
        jobId = job.id;
        queued = true;
      }
      systemMessage = await addAgentMessage(
        taskId,
        queued
          ? "Follow-up requested. Agent run queued."
          : activeJob
            ? "Follow-up requested. The agent is already running."
            : task.kind === "wix_article"
              ? "Note saved. An article task publishes from its draft; there is no separate agent run."
              : "Note saved. The task cannot run in its current state.",
        "SYSTEM",
      );
    }
    return Response.json({ message, systemMessage, queued, jobId }, { status: 201 });
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
