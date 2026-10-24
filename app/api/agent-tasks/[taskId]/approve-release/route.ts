import { getUserIdFromCookies } from "@/lib/session-helper";
import { approveAndReleaseAgentTask } from "@/lib/agent-tasks/release";
import { ResearchServiceError } from "@/lib/research/service";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const body = await req.json().catch(() => ({})) as { targetKey?: unknown };
  const targetKey = typeof body.targetKey === "string" && body.targetKey.trim()
    ? body.targetKey.trim()
    : undefined;
  try {
    return Response.json(await approveAndReleaseAgentTask(taskId, targetKey));
  } catch (error) {
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Agent approve/release error:", error);
    return Response.json({ error: "Failed to approve and release the agent task" }, { status: 500 });
  }
}
