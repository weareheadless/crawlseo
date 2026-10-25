import { getUserIdFromCookies } from "@/lib/session-helper";
import { getSiteDeliveryConfig } from "@/lib/site-delivery/config";
import { inspectBridgeSite } from "@/lib/bridge/client";
import { userOwnsSite } from "@/lib/auth/research-action-access";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { siteId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });
  const config = await getSiteDeliveryConfig(siteId);
  if (!config) return Response.json({ error: "No delivery configuration for this site" }, { status: 404 });
  try {
    return Response.json({
      config: {
        bridgeAlias: config.bridgeAlias,
        adapters: config.adapters,
        enabled: config.enabled,
      },
      bridge: await inspectBridgeSite(config.bridgeAlias),
    });
  } catch (error) {
    return Response.json({
      config: {
        bridgeAlias: config.bridgeAlias,
        adapters: config.adapters,
        enabled: config.enabled,
      },
      error: error instanceof Error ? error.message : "Bridge inspect failed",
    }, { status: 502 });
  }
}
