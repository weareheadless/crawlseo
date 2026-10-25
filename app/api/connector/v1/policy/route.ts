import { ZodError } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { ConnectorError, getConnectorResearchPolicy, updateConnectorResearchPolicy } from "@/lib/connectors/service";
import { connectorResearchPolicySchema } from "@/lib/connectors/types";

export async function GET(req: Request) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  const siteId = new URL(req.url).searchParams.get("siteId")?.trim();
  if (!siteId) return Response.json({ error: "siteId is required" }, { status: 400 });
  try { return Response.json({ policy: await getConnectorResearchPolicy(auth.principal, siteId) }); }
  catch (error) { return Response.json({ error: error instanceof ConnectorError ? error.message : "Research policy unavailable" }, { status: error instanceof ConnectorError ? error.status : 500 }); }
}

export async function PUT(req: Request) {
  const auth = await connectorPrincipal(req, "connector:write");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const input = connectorResearchPolicySchema.parse(await req.json());
    return Response.json({ policy: await updateConnectorResearchPolicy(auth.principal, input) });
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: error.issues[0]?.message ?? "Invalid research policy" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Research policy update failed" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
