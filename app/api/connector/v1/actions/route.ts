import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { ConnectorError, listConnectorActions } from "@/lib/connectors/service";
import { connectorActionListQuerySchema } from "@/lib/connectors/types";

export async function GET(req: Request) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  const url = new URL(req.url);
  const query = connectorActionListQuerySchema.safeParse({ siteId: url.searchParams.get("siteId") ?? undefined, limit: url.searchParams.get("limit") ?? undefined, since: url.searchParams.get("since") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined });
  if (!query.success) return Response.json({ error: query.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  try { return Response.json({ schemaVersion: "1.0", ...await listConnectorActions(auth.principal, query.data) }); }
  catch (error) { return Response.json({ error: error instanceof ConnectorError ? error.message : "Connector unavailable" }, { status: error instanceof ConnectorError ? error.status : 500 }); }
}
