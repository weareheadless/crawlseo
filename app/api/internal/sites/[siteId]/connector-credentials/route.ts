import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createMigrationReadCredential, ServiceAuthError } from "@/lib/auth/service-credentials";

const requestSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(240),
}).strict();

function authorized(req: Request): boolean {
  const configured = process.env.HELLOADA_PROVISIONING_TOKEN;
  const supplied = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!configured || !supplied) return false;
  return timingSafeEqual(
    createHash("sha256").update(configured).digest(),
    createHash("sha256").update(supplied).digest(),
  );
}

/**
 * Mint a separate connector:read credential for inventory and comparison.
 * This route cannot issue write scopes, change a binding, or revoke the
 * existing MCP principal.
 */
export async function POST(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  let input: z.infer<typeof requestSchema>;
  try { input = requestSchema.parse(await req.json()); }
  catch (error) {
    return Response.json({ error: error instanceof z.ZodError ? error.issues[0]?.message : "Invalid request" }, { status: 400 });
  }
  try {
    const { siteId } = await params;
    const credential = await createMigrationReadCredential(siteId, input.idempotencyKey);
    return Response.json({
      credentialId: credential.credentialId,
      servicePrincipalId: credential.servicePrincipalId,
      token: credential.token,
      scopes: ["connector:read"],
      reused: credential.reused,
      expiresInDays: 30,
      note: credential.token ? "Store this token securely; it is returned only on first issuance." : "Credential already exists; the token is not reprinted.",
    });
  } catch (error) {
    if (error instanceof ServiceAuthError) return Response.json({ error: error.message }, { status: error.statusCode });
    if (error instanceof Error && /idempotency key|credential/i.test(error.message)) {
      return Response.json({ error: "Credential issuance conflicts with an existing request" }, { status: 409 });
    }
    return Response.json({ error: "Migration credential issuance failed" }, { status: 500 });
  }
}
