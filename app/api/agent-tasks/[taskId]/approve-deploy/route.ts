import { getUserIdFromCookies } from "@/lib/session-helper";
import { approveAndDeployAgentTask } from "@/lib/agent-tasks/deploy";
import { ResearchServiceError } from "@/lib/research/service";
import { userOwnsAgentTask } from "@/lib/auth/research-action-access";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  if (!(await userOwnsAgentTask(taskId, userId))) return Response.json({ error: "Agent task not found" }, { status: 404 });
  const body = await req.json().catch(() => ({})) as { targetKey?: unknown };
  const targetKey = typeof body.targetKey === "string" && body.targetKey.trim()
    ? body.targetKey.trim()
    : undefined;

  try {
    return Response.json(await approveAndDeployAgentTask(taskId, targetKey));
  } catch (error) {
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Agent approve/deploy error:", error);
    return Response.json({ error: "Failed to approve and deploy the agent task" }, { status: 500 });
  }
}
