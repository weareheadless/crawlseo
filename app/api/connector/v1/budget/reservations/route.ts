import { ZodError } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { ConnectorError, reserveConnectorBudget } from "@/lib/connectors/service";
import { budgetReserveSchema } from "@/lib/connectors/types";

export async function POST(req: Request) {
  const auth = await connectorPrincipal(req, "connector:write");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const input = budgetReserveSchema.parse(await req.json());
    const reservation = await reserveConnectorBudget(auth.principal, input);
    return Response.json({ reservation: { ...reservation, amountMicros: reservation.amountMicros.toString(),
      actualCostMicros: reservation.actualCostMicros?.toString() ?? null } });
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: error.issues[0]?.message ?? "Invalid budget reservation" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Research budget reservation failed" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
