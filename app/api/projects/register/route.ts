import { z } from "zod";
import { ProjectRegistrationProofError, verifyProjectRegistrationProof } from "@/lib/auth/project-registration-proof";
import { ProjectRegistrationError, registerProject, type RegisterProjectInput } from "@/lib/projects/register-project";
import { businessKnowledgeError } from "@/lib/projects/business-knowledge-response";

const identifier = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const registrationSchema = z.object({
  schemaVersion: z.literal("business-knowledge/1"),
  kind: z.literal("project_registration"),
  externalOrganizationId: identifier,
  workspaceName: z.string().min(1).max(500),
  externalProjectId: identifier,
  displayName: z.string().min(1).max(500),
  origin: z.object({
    system: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    externalId: identifier,
  }).strict(),
  idempotencyKey: z.string().min(8).max(240),
  domain: z.string().max(253).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/).nullable().optional(),
  requestedCredentialScope: z.object({
    audience: z.literal("business-knowledge"),
    requestedPermissions: z.array(z.enum(["project:read", "document:read", "document:write"]))
      .min(1).max(3).refine((permissions) => new Set(permissions).size === permissions.length),
  }).strict(),
}).strict().refine((body) => body.externalProjectId === `${body.origin.system}:${body.origin.externalId}`);

function bearer(req: Request): string | null {
  return req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

function errorResponse(error: unknown): Response {
  if (error instanceof ProjectRegistrationProofError) {
    return businessKnowledgeError(error.statusCode, error.statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message);
  }
  if (error instanceof ProjectRegistrationError) {
    const code = error.code === "INVALID_REQUEST" ? "VALIDATION_FAILED" : error.code;
    const status = code === "VALIDATION_FAILED" ? 400 : code === "FORBIDDEN" ? 403 : 409;
    return businessKnowledgeError(status, code, error.message);
  }
  console.error("Project registration failed:", error instanceof Error ? error.message : "unknown");
  return businessKnowledgeError(500, "UNAVAILABLE", "Project registration is temporarily unavailable", true);
}

export async function POST(req: Request) {
  try {
    let body: z.infer<typeof registrationSchema>;
    try { body = registrationSchema.parse(await req.json()); }
    catch {
      throw new ProjectRegistrationError("INVALID_REQUEST", "Invalid project registration fields");
    }
    verifyProjectRegistrationProof(bearer(req), body.externalOrganizationId);
    const result = await registerProject({
      schemaVersion: body.schemaVersion,
      kind: body.kind,
      externalOrganizationId: body.externalOrganizationId,
      workspaceName: body.workspaceName,
      externalProjectId: body.externalProjectId,
      displayName: body.displayName,
      domain: body.domain,
      origin: body.origin,
      idempotencyKey: body.idempotencyKey,
      requestedCredentialScope: body.requestedCredentialScope as RegisterProjectInput["requestedCredentialScope"],
    });
    const response = Response.json(result.identity, { headers: { "cache-control": "no-store" } });
    if (result.credentialToken) response.headers.set("x-crawlseo-service-credential", result.credentialToken);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
