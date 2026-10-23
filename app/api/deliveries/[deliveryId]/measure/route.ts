import { getUserIdFromCookies } from "@/lib/session-helper";
import { measureDeliveryOutcome } from "@/lib/delivery/outcomes";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ deliveryId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { deliveryId } = await params;
  try {
    return Response.json({ delivery: await measureDeliveryOutcome(deliveryId) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Outcome measurement failed" }, { status: 400 });
  }
}
