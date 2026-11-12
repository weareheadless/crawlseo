import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { ConnectorError } from "@/lib/connectors/service";
import { getConnectorAnalytics } from "@/lib/connectors/analytics";

export async function GET(req: Request) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const params = new URL(req.url).searchParams;
    const siteId = params.get("siteId")?.trim();
    if (!siteId) return Response.json({ error: "siteId is required" }, { status: 400 });
    const startDate = params.get("startDate") ?? undefined;
    const endDate = params.get("endDate") ?? undefined;
    if ([...params.keys()].some((key) => !["siteId", "startDate", "endDate"].includes(key))) {
      return Response.json({ error: "Unsupported analytics query parameter" }, { status: 400 });
    }
    return Response.json(await getConnectorAnalytics(auth.principal, siteId, { startDate, endDate }));
  } catch (error) {
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Connector analytics unavailable" },
      { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
