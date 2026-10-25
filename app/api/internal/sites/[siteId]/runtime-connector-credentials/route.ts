import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  createRuntimeConnectorCredential,
  RuntimeConnectorCredentialError,
} from "@/lib/auth/service-credentials";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

const requestSchema = z.object({
  expectedGeneration: z.number().int().positive(),
  activationPlanHash: z.string().regex(/^[a-f0-9]{64}$/i),
  idempotencyKey: z.string().trim().min(1).max(200),
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

export async function POST(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });
  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await req.json());
  } catch (error) {
    return Response.json({ error: error instanceof z.ZodError ? error.issues[0]?.message : "Invalid request" }, { status: 400, headers: NO_STORE_HEADERS });
  }
  try {
    const { siteId } = await params;
    const credential = await createRuntimeConnectorCredential({ siteId, ...input });
    return Response.json({
      credentialId: credential.credentialId,
      servicePrincipalId: credential.servicePrincipalId,
      token: credential.token,
      scopes: ["connector:read", "connector:write"],
      reused: credential.reused,
      note: credential.token
        ? "Store this token securely; it is returned only on first issuance."
        : "Credential already exists; the token is not reprinted.",
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof RuntimeConnectorCredentialError) {
      return Response.json({ error: error.message }, { status: error.statusCode, headers: NO_STORE_HEADERS });
    }
    if (error instanceof Error && /idempotency key|credential/i.test(error.message)) {
      return Response.json({ error: "Credential issuance conflicts with an existing request" }, { status: 409, headers: NO_STORE_HEADERS });
    }
    return Response.json({ error: "Runtime connector credential issuance failed" }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
