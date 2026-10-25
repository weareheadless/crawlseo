import { getUserIdFromCookies } from "@/lib/session-helper";
import { commitAgentTask } from "@/lib/agent-tasks/commit";
import { ResearchServiceError } from "@/lib/research/service";
import { userOwnsAgentTask } from "@/lib/auth/research-action-access";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  if (!(await userOwnsAgentTask(taskId, userId))) return Response.json({ error: "Agent task not found" }, { status: 404 });

  try {
    return Response.json(await commitAgentTask(taskId));
  } catch (error) {
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Agent commit error:", error);
    return Response.json({ error: "Failed to commit agent changes" }, { status: 500 });
  }
}
