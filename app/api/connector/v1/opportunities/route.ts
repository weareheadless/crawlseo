import { ZodError } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { ConnectorError } from "@/lib/connectors/service";
import { listConnectorOpportunities } from "@/lib/connectors/opportunities";
import { opportunityListSchema } from "@/lib/connectors/types";

export async function GET(req: Request) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    return Response.json(await listConnectorOpportunities(auth.principal,
      opportunityListSchema.parse(Object.fromEntries(new URL(req.url).searchParams))));
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: "Invalid opportunity query" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Opportunity read failed" },
      { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
