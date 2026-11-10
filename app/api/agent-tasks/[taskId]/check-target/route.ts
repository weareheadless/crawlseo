import { getUserIdFromCookies } from "@/lib/session-helper";
import { userOwnsAgentTask } from "@/lib/auth/research-action-access";
import { resumeWixPageDelivery } from "@/lib/agent-tasks/wix-page";
import { ResearchServiceError } from "@/lib/research/service";

/** Probe the page route now instead of waiting for the worker's next attempt. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  if (!(await userOwnsAgentTask(taskId, userId))) {
    return Response.json({ error: "Agent task not found" }, { status: 404 });
  }
  try {
    const result = await resumeWixPageDelivery(taskId);
    return Response.json(result);
  } catch (error) {
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Wix page target check error:", error);
    return Response.json({ error: error instanceof Error ? error.message : "Target check failed" }, { status: 500 });
  }
}
