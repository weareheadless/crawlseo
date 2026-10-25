import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { connectorCapabilities } from "@/lib/connectors/service";
import { ConnectorError } from "@/lib/connectors/service";

export async function GET(req: Request) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  const siteId = new URL(req.url).searchParams.get("siteId")?.trim();
  if (!siteId) return Response.json({ error: "siteId is required" }, { status: 400 });
  try { return Response.json(await connectorCapabilities(auth.principal, siteId)); }
  catch (error) { return Response.json({ error: error instanceof ConnectorError ? error.message : "Connector unavailable" }, { status: error instanceof ConnectorError ? error.status : 500 }); }
}
