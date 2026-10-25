import { ZodError } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { ConnectorError, getConnectorBudgetReservation, settleConnectorBudget } from "@/lib/connectors/service";
import { budgetSettlementSchema } from "@/lib/connectors/types";

export async function POST(req: Request, { params }: { params: Promise<{ reservationId: string }> }) {
  const auth = await connectorPrincipal(req, "connector:write");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const input = budgetSettlementSchema.parse(await req.json());
    const { reservationId } = await params;
    const reservation = await settleConnectorBudget(auth.principal, reservationId, input);
    return Response.json({ reservation: reservation ? { ...reservation,
      amountMicros: reservation.amountMicros.toString(), actualCostMicros: reservation.actualCostMicros?.toString() ?? null } : null });
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ error: error.issues[0]?.message ?? "Invalid budget settlement" }, { status: 400 });
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Research budget settlement failed" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ reservationId: string }> }) {
  const auth = await connectorPrincipal(req, "connector:read");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const { reservationId } = await params;
    const reservation = await getConnectorBudgetReservation(auth.principal, reservationId);
    return Response.json({ reservation: { ...reservation, amountMicros: reservation.amountMicros.toString(),
      actualCostMicros: reservation.actualCostMicros?.toString() ?? null } });
  } catch (error) {
    return Response.json({ error: error instanceof ConnectorError ? error.message : "Research budget reservation unavailable" }, { status: error instanceof ConnectorError ? error.status : 500 });
  }
}
