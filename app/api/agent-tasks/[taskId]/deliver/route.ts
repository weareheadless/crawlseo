import { getUserIdFromCookies } from "@/lib/session-helper";
import { userOwnsAgentTask } from "@/lib/auth/research-action-access";
import { db } from "@/lib/db";
import { approveAndDeliverWixPage } from "@/lib/agent-tasks/wix-page";
import { approveAndPublishWixArticle } from "@/lib/agent-tasks/wix-article";
import { ResearchServiceError } from "@/lib/research/service";

/**
 * One human action: approve the reviewed deliverable and let the agent deliver
 * it. A page whose Wix route does not exist yet returns 202 with the route to
 * create; the worker resumes delivery without another click.
 */
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
  const task = await db.agentTask.findUnique({ where: { id: taskId }, select: { kind: true } });
  if (!task) return Response.json({ error: "Agent task not found" }, { status: 404 });

  try {
    if (task.kind === "wix_article") {
      const published = await approveAndPublishWixArticle(taskId, userId);
      return Response.json({ status: "published", task: published });
    }
    const result = await approveAndDeliverWixPage(taskId);
    if (result.status === "awaiting_target") {
      return Response.json(result, { status: 202 });
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof ResearchServiceError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Wix delivery error:", error);
    return Response.json({ error: error instanceof Error ? error.message : "Delivery failed" }, { status: 500 });
  }
}
