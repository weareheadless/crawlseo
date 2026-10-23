import { getUserIdFromCookies } from "@/lib/session-helper";
import { applyEmbedDelivery, WixEmbedDeliveryError } from "@/lib/delivery/wix-embed";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  try {
    const body = await req.json() as { targetKey?: unknown; confirmation?: unknown };
    if (typeof body.targetKey !== "string" || typeof body.confirmation !== "string") {
      return Response.json({ error: "targetKey and confirmation are required" }, { status: 400 });
    }
    return Response.json(await applyEmbedDelivery(taskId, body.targetKey.trim(), body.confirmation));
  } catch (error) {
    if (error instanceof WixEmbedDeliveryError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Embed apply error:", error);
    return Response.json({ error: "Failed to apply embed delivery" }, { status: 500 });
  }
}
