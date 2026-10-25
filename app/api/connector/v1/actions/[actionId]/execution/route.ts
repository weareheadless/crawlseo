import { ZodError } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { executionStatusSchema } from "@/lib/connectors/types";
import { ConnectorError, recordExecutionStatus } from "@/lib/connectors/service";

export async function POST(req: Request, { params }: { params: Promise<{ actionId: string }> }) {
  const auth = await connectorPrincipal(req, "connector:write");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const input = executionStatusSchema.parse(await req.json());
    const { actionId } = await params;
    return Response.json(await recordExecutionStatus(auth.principal, { ...input, actionId }));
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: error.issues[0]?.message ?? "Invalid execution status" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Execution status failed" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
