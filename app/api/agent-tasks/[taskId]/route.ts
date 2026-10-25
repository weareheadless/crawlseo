import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { updateAgentTask } from "@/lib/agent-tasks/service";
import { ResearchServiceError } from "@/lib/research/service";
import { z } from "zod";
import { ZodError } from "zod";
import { userOwnsAgentTask } from "@/lib/auth/research-action-access";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      status: true,
      startedAt: true,
      completedAt: true,
      closedAt: true,
      errorCode: true,
      result: true,
      publishedUrl: true,
      commitSha: true,
    },
  });
  if (!task) return Response.json({ error: "Agent task not found" }, { status: 404 });
  return Response.json({ task });
}

const schema = z.object({
  status: z.enum(["READY", "RUNNING", "AWAITING_REVIEW", "CHANGES_REQUESTED", "APPROVED", "COMMITTED", "PUBLISHING", "PUBLISHED", "CLOSED", "COMPLETED", "FAILED", "CANCELLED"]).optional(),
  result: z.unknown().optional(),
  errorCode: z.string().trim().max(120).nullable().optional(),
  branch: z.string().trim().max(200).nullable().optional(),
  worktreePath: z.string().trim().max(500).nullable().optional(),
  commitSha: z.string().trim().max(80).nullable().optional(),
  publishedUrl: z.string().trim().max(2_000).nullable().optional(),
  bridgeReceiptId: z.string().trim().max(200).nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { taskId } = await params;
  if (!(await userOwnsAgentTask(taskId, userId))) return Response.json({ error: "Agent task not found" }, { status: 404 });
  try {
    const input = schema.parse(await req.json());
    return Response.json({ task: await updateAgentTask(taskId, input) });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid update" }, { status: 400 });
    }
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Agent task update error:", error);
    return Response.json({ error: "Failed to update agent task" }, { status: 500 });
  }
}
