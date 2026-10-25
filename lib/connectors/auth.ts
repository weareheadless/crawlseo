import {
  authenticateServiceToken,
  requireProjectScope,
  ServiceAuthError,
  type ServicePrincipalContext,
} from "@/lib/auth/service-credentials";

export async function connectorPrincipal(req: Request, scope: "connector:read" | "connector:write"):
  Promise<{ principal: ServicePrincipalContext } | { response: Response }> {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  try {
    const principal = await authenticateServiceToken(token);
    requireProjectScope(principal, scope);
    return { principal };
  } catch (error) {
    const status = error instanceof ServiceAuthError ? error.statusCode : 401;
    return { response: Response.json({ error: status === 403 ? "Forbidden" : "Unauthorized" }, { status }) };
  }
}

export function isConnectorResponse(value: { principal: ServicePrincipalContext } | { response: Response }): value is { response: Response } {
  return "response" in value;
}
