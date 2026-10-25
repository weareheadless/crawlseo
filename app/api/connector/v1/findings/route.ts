import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { ConnectorError, listConnectorFindings } from "@/lib/connectors/service";
import { connectorFindingListQuerySchema } from "@/lib/connectors/types";

export async function GET(req: Request) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  const url = new URL(req.url);
  const query = connectorFindingListQuerySchema.safeParse({
    siteId: url.searchParams.get("siteId") ?? undefined,
    runId: url.searchParams.get("runId") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    since: url.searchParams.get("since") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
  });
  if (!query.success) return Response.json({ error: query.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  try {
    return Response.json(await listConnectorFindings(auth.principal, query.data));
  } catch (error) {
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Connector unavailable" },
      { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
