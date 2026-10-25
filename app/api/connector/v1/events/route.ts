import { ZodError } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { acknowledgeConnectorEvents, ConnectorError, pollConnectorEvents, reportConnectorEventFailure } from "@/lib/connectors/service";
import { eventAckSchema } from "@/lib/connectors/types";
import { connectorEventListQuerySchema } from "@/lib/connectors/types";

export async function GET(req: Request) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  const url = new URL(req.url);
  const query = connectorEventListQuerySchema.safeParse({ siteId: url.searchParams.get("siteId") ?? undefined, after: url.searchParams.get("after") ?? undefined, limit: url.searchParams.get("limit") ?? undefined });
  if (!query.success) return Response.json({ error: query.error.issues[0]?.message ?? "Invalid query" }, { status: 400 });
  const { after, limit } = query.data;
  try {
    const events = await pollConnectorEvents(auth.principal, after, limit, query.data.siteId);
    // Event sequence numbers are project-wide while this endpoint is site-scoped.
    // The after value is advisory; the durable delivery queue is acknowledged by ID.
    return Response.json({ schemaVersion: "1.0", events, nextCursor: events.at(-1)?.sequence ?? after, cursorMode: "advisory" });
  } catch (error) {
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Connector events unavailable" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}

export async function POST(req: Request) {
  const auth = await connectorPrincipal(req, "connector:write");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const input = eventAckSchema.parse(await req.json());
    const ack = await acknowledgeConnectorEvents(auth.principal, input.acknowledged, input.siteId);
    const failures = await Promise.all(input.failed.map(({ id, message }) => reportConnectorEventFailure(auth.principal, id, message, input.siteId)));
    return Response.json({ ...ack, failed: failures });
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: error.issues[0]?.message ?? "Invalid event acknowledgement" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Connector event acknowledgement failed" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
