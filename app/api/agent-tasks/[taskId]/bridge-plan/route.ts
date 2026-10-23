import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";
import { planBridgeSite } from "@/lib/bridge/client";
import { addAgentArtifact } from "@/lib/agent-tasks/chat";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  const task = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { id: true, siteId: true, worktreePath: true },
  });
  if (!task) return Response.json({ error: "Agent task not found" }, { status: 404 });
  if (!task.worktreePath) return Response.json({ error: "Run the agent first to create a worktree" }, { status: 409 });
  const config = await getSiteDeliveryConfig(task.siteId);
  if (!config?.enabled) return Response.json({ error: "Bridge delivery is not configured for this site" }, { status: 409 });

  try {
    const plan = await planBridgeSite(config.bridgeAlias, task.worktreePath);
    const artifact = await addAgentArtifact(task.id, {
      kind: "bridge_plan",
      content: JSON.stringify(plan, null, 2).slice(0, 100_000),
    });
    return Response.json({ plan, artifact });
  } catch (error) {
    return Response.json({
      error: error instanceof Error ? error.message : "Bridge plan failed",
    }, { status: 502 });
  }
}
