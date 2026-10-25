import { ZodError } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { connectorBudget, ConnectorError, updateConnectorBudgetPolicy } from "@/lib/connectors/service";
import { budgetPolicyUpdateSchema } from "@/lib/connectors/types";

export async function GET(req: Request) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  const siteId = new URL(req.url).searchParams.get("siteId")?.trim();
  if (!siteId) return Response.json({ error: "siteId is required" }, { status: 400 });
  try { return Response.json({ budget: await connectorBudget(auth.principal, siteId) }); }
  catch (error) { return Response.json({ error: error instanceof ConnectorError ? error.message : "Research budget unavailable" }, { status: error instanceof ConnectorError ? error.status : 500 }); }
}

export async function PUT(req: Request) {
  const auth = await connectorPrincipal(req, "connector:write");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const input = budgetPolicyUpdateSchema.parse(await req.json());
    return Response.json({ policy: await updateConnectorBudgetPolicy(auth.principal, input) });
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: error.issues[0]?.message ?? "Invalid budget policy" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Research budget policy update failed" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
