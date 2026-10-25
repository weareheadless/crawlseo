import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { ConnectorError, getConnectorAction } from "@/lib/connectors/service";

export async function GET(req: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  try { const { actionId } = await params; return Response.json({ action: await getConnectorAction(auth.principal, actionId, new URL(req.url).searchParams.get("siteId") ?? undefined) }); }
  catch (error) { return Response.json({ error: error instanceof ConnectorError ? error.message : "Connector unavailable" }, { status: error instanceof ConnectorError ? error.status : 500 }); }
}
