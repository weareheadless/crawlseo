import { ZodError } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { ConnectorError } from "@/lib/connectors/service";
import { opportunityOperationSchema } from "@/lib/connectors/types";
import { operateOnOpportunity } from "@/lib/connectors/opportunities";

export async function POST(req: Request, { params }: { params: Promise<{ opportunityId: string }> }) {
  const auth = await connectorPrincipal(req, "connector:write");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const input = opportunityOperationSchema.parse(await req.json());
    return Response.json(await operateOnOpportunity(auth.principal, (await params).opportunityId, input));
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return Response.json({ error: "Invalid opportunity decision" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Opportunity decision failed" },
      { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
