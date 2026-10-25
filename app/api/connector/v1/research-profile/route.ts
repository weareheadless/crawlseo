import { ZodError } from "zod";
import { connectorPrincipal, isConnectorResponse } from "@/lib/connectors/auth";
import { ConnectorError, updateConnectorResearchProfile } from "@/lib/connectors/service";
import { connectorResearchProfileSchema } from "@/lib/connectors/types";

export async function PUT(req: Request) {
  const auth = await connectorPrincipal(req, "connector:write");
  if (isConnectorResponse(auth)) return auth.response;
  try {
    const input = connectorResearchProfileSchema.parse(await req.json());
    return Response.json(await updateConnectorResearchProfile(auth.principal, input));
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: error.issues[0]?.message ?? "Invalid research profile" }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof ConnectorError ? error.message : "Research profile update failed" },
      { status: error instanceof ConnectorError ? error.status : 500 },
    );
  }
}
