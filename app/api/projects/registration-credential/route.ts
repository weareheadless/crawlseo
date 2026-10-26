import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { ProjectRegistrationProofError, verifyProjectRegistrationProof } from "@/lib/auth/project-registration-proof";
import { createServiceCredential } from "@/lib/auth/service-credentials";
import { businessKnowledgeError } from "@/lib/projects/business-knowledge-response";

type RegistrationReceiptIdentity = {
  projectId: string;
  credentialScope: { permissions: string[] };
};

function bearer(req: Request): string | null {
  return req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

export async function POST(req: Request) {
  try {
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return businessKnowledgeError(400, "VALIDATION_FAILED", "Invalid credential recovery request");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return businessKnowledgeError(400, "VALIDATION_FAILED", "Invalid credential recovery request");
    }
    if (typeof body.externalOrganizationId !== "string" || typeof body.registrationIdempotencyKey !== "string" ||
        body.registrationIdempotencyKey.trim().length < 8 || body.registrationIdempotencyKey.trim().length > 240 ||
        typeof body.recoveryIdempotencyKey !== "string" || body.recoveryIdempotencyKey.trim().length < 8 ||
        body.recoveryIdempotencyKey.trim().length > 240) {
      return businessKnowledgeError(400, "VALIDATION_FAILED", "Invalid credential recovery request");
    }
    const externalOrganizationId = verifyProjectRegistrationProof(bearer(req), body.externalOrganizationId);
    const receipt = await db.projectRegistrationReceipt.findUnique({
      where: { externalOrganizationId_operation_idempotencyKey: {
        externalOrganizationId,
        operation: "register_project_v1",
        idempotencyKey: body.registrationIdempotencyKey.trim(),
      } },
      select: { result: true },
    });
    if (!receipt) return businessKnowledgeError(404, "NOT_FOUND", "Project registration was not found");
    const identity = receipt.result as unknown as RegistrationReceiptIdentity;
    const project = await db.project.findUnique({
      where: { id: identity.projectId },
      select: { id: true, workspace: { select: { externalOrganizationId: true } } },
    });
    if (!project || project.workspace.externalOrganizationId !== externalOrganizationId) {
      return businessKnowledgeError(404, "NOT_FOUND", "Project registration was not found");
    }
    const requestHash = createHash("sha256").update(JSON.stringify({
      externalOrganizationId,
      projectId: project.id,
      permissions: identity.credentialScope.permissions,
    })).digest("hex");
    const credential = await createServiceCredential(project.id, identity.credentialScope.permissions, {
      idempotencyKey: `project-registration-recovery:${createHash("sha256").update(`${externalOrganizationId}:${body.recoveryIdempotencyKey.trim()}`).digest("hex")}`,
      principalName: "business-knowledge",
      requestHash,
    });
    const response = Response.json(receipt.result, { headers: { "cache-control": "no-store" } });
    if (credential.token) response.headers.set("x-crawlseo-service-credential", credential.token);
    return response;
  } catch (error) {
    if (error instanceof ProjectRegistrationProofError) {
      return businessKnowledgeError(error.statusCode, error.statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message);
    }
    if (error instanceof Error && /idempotency key|different scopes/i.test(error.message)) {
      return businessKnowledgeError(409, "IDEMPOTENCY_CONFLICT", "Credential recovery key conflicts with a prior request");
    }
    console.error("Project credential recovery failed:", error instanceof Error ? error.message : "unknown");
    return businessKnowledgeError(500, "UNAVAILABLE", "Project credential recovery is temporarily unavailable", true);
  }
}
