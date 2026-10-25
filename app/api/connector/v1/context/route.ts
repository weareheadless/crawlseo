import { ZodError } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { currentContext, ConnectorError, saveContextSnapshot } from "@/lib/connectors/service";
import { contextSnapshotSchema } from "@/lib/connectors/types";

export async function GET(req: Request) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const siteId = new URL(req.url).searchParams.get("siteId")?.trim();
    if (!siteId) return Response.json({ error: "siteId is required" }, { status: 400 });
    return Response.json({ snapshot: await currentContext(auth.principal, siteId) });
  } catch (error) {
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Connector context unavailable" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}

export async function PUT(req: Request) {
  const auth = await connectorPrincipal(req, "connector:write");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const input = contextSnapshotSchema.parse(await req.json());
    const snapshot = await saveContextSnapshot(auth.principal, input);
    return Response.json({ snapshot });
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: error.issues[0]?.message ?? "Invalid context" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Connector context update failed" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
