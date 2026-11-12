import { ZodError, z } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { ConnectorError } from "@/lib/connectors/service";
import { taskConfirmationSchema } from "@/lib/connectors/types";
import { confirmConnectorTask, getConnectorTask } from "@/lib/connectors/opportunities";

export async function GET(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const siteId = z.string().trim().min(1).max(120).parse(new URL(req.url).searchParams.get("siteId"));
    return Response.json(await getConnectorTask(auth.principal, siteId, (await params).taskId));
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: "Explicit siteId is required" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Task read failed" },
      { status: error instanceof ConnectorError ? error.status : 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const auth = await connectorPrincipal(req, "connector:write");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const input = taskConfirmationSchema.parse(await req.json());
    return Response.json(await confirmConnectorTask(auth.principal, (await params).taskId, input));
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return Response.json({ error: "Invalid human confirmation" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Task confirmation failed" },
      { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
