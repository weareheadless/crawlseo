import { getUserIdFromCookies } from "@/lib/session-helper";
import { verifyEmbedDelivery, WixEmbedDeliveryError } from "@/lib/delivery/wix-embed";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId } = await params;
  try {
    const body = await req.json() as { targetKey?: unknown };
    if (typeof body.targetKey !== "string" || !body.targetKey.trim()) {
      return Response.json({ error: "targetKey is required" }, { status: 400 });
    }
    return Response.json(await verifyEmbedDelivery(taskId, body.targetKey.trim()));
  } catch (error) {
    if (error instanceof WixEmbedDeliveryError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Embed verify error:", error);
    return Response.json({ error: "Failed to verify embed delivery" }, { status: 500 });
  }
}
