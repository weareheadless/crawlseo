import { getUserIdFromCookies } from "@/lib/session-helper";
import { planEmbedDelivery, WixEmbedDeliveryError } from "@/lib/delivery/wix-embed";
import { userOwnsAgentTask } from "@/lib/auth/research-action-access";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  if (!(await userOwnsAgentTask(taskId, userId))) return Response.json({ error: "Agent task not found" }, { status: 404 });
  try {
    const body = await req.json() as { targetKey?: unknown };
    if (typeof body.targetKey !== "string" || !body.targetKey.trim()) {
      return Response.json({ error: "targetKey is required" }, { status: 400 });
    }
    return Response.json(await planEmbedDelivery(taskId, body.targetKey.trim()));
  } catch (error) {
    if (error instanceof WixEmbedDeliveryError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Embed plan error:", error);
    return Response.json({ error: "Failed to plan embed delivery" }, { status: 500 });
  }
}
