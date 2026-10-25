import { ZodError } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { actionOperationSchema } from "@/lib/connectors/types";
import { ConnectorError, operateOnAction } from "@/lib/connectors/service";

export async function POST(req: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const auth = await connectorPrincipal(req, "connector:write");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const input = actionOperationSchema.parse(await req.json());
    const { actionId } = await params;
    return Response.json(await operateOnAction(auth.principal, { ...input, actionId }));
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: error.issues[0]?.message ?? "Invalid operation" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Connector operation failed" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
