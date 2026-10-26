import { z } from "zod";
import { db } from "@/lib/db";
import { authenticateServiceToken, requireProjectScope, ServiceAuthError } from "@/lib/auth/service-credentials";
import { verifyBusinessKnowledgeOwnerProof, BusinessKnowledgeOwnerProofError } from "@/lib/auth/business-knowledge-owner-proof";
import { acceptBusinessKnowledge, BusinessKnowledgeError, businessKnowledgeFieldsSchema, readBusinessKnowledge, writeBusinessKnowledge } from "@/lib/projects/business-knowledge";
import { businessKnowledgeError } from "@/lib/projects/business-knowledge-response";

const id = z.string().min(1).max(120);
const base = { schemaVersion: z.literal("business-knowledge/1"), workspaceId: id, projectId: id, documentId: id };
const writeSchema = z.object({ ...base, kind: z.literal("document_write"), expectedRevision: z.number().int().min(0), idempotencyKey: z.string().min(8).max(240), reason: z.string().min(1).max(1000), changes: businessKnowledgeFieldsSchema }).strict();
const acceptSchema = z.object({ ...base, kind: z.literal("document_accept"), expectedRevision: z.number().int().min(1), idempotencyKey: z.string().min(8).max(240), reason: z.string().min(1).max(1000), actor: z.object({ type: z.literal("owner"), id }).strict() }).strict();

function bearer(req: Request) { return req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null; }
function errorResponse(error: unknown): Response {
  if (error instanceof BusinessKnowledgeOwnerProofError) return businessKnowledgeError(error.statusCode, error.statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message);
  if (error instanceof ServiceAuthError) return businessKnowledgeError(error.statusCode, error.statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message);
  if (error instanceof BusinessKnowledgeError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : error.code === "VALIDATION_FAILED" ? 400 : 409;
    return businessKnowledgeError(status, error.code, error.message, error.code === "REVISION_CONFLICT", error.currentRevision);
  }
  if (error instanceof z.ZodError) return businessKnowledgeError(400, "VALIDATION_FAILED", error.issues[0]?.message ?? "Invalid business knowledge request");
  return businessKnowledgeError(500, "UNAVAILABLE", "Business knowledge is temporarily unavailable", true);
}

async function principal(req: Request, scope: string) {
  const auth = await authenticateServiceToken(bearer(req));
  requireProjectScope(auth, scope);
  return auth;
}

export async function GET(req: Request) {
  try {
    const auth = await principal(req, "document:read");
    const params = new URL(req.url).searchParams;
    const projectId = params.get("projectId") ?? "";
    const workspaceId = params.get("workspaceId") ?? "";
    if (auth.projectId !== projectId || auth.workspaceId !== workspaceId) return businessKnowledgeError(404, "NOT_FOUND", "Document not found");
    const document = await readBusinessKnowledge(projectId, params.get("documentId") ?? undefined,
      params.has("revision") ? Number(params.get("revision")) : undefined, params.get("view") === "accepted" ? "accepted" : "working");
    return Response.json(document, { headers: { "cache-control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: Request) {
  try {
    const raw: unknown = await req.json();
    const kind = typeof raw === "object" && raw !== null && "kind" in raw ? (raw as { kind?: unknown }).kind : undefined;
    if (kind === "document_write") {
      const auth = await principal(req, "document:write");
      const body = writeSchema.parse(raw);
      const document = await writeBusinessKnowledge(body, auth);
      return Response.json(document, { headers: { "cache-control": "no-store" } });
    }
    if (kind === "document_accept") {
      const auth = await principal(req, "document:write");
      const body = acceptSchema.parse(raw);
      const project = await db.project.findFirst({ where: { id: body.projectId, workspaceId: body.workspaceId }, select: { workspace: { select: { externalOrganizationId: true } } } });
      if (!project) return businessKnowledgeError(404, "NOT_FOUND", "Document not found");
      const owner = verifyBusinessKnowledgeOwnerProof(req.headers.get("x-helloada-owner-proof"), { externalOrganizationId: project.workspace.externalOrganizationId,
        projectId: body.projectId, documentId: body.documentId, revision: body.expectedRevision });
      if (owner.actorId !== body.actor.id) return businessKnowledgeError(403, "FORBIDDEN", "Acceptance actor does not match the verified owner proof");
      const document = await acceptBusinessKnowledge(body, auth, { ...owner, externalOrganizationId: project.workspace.externalOrganizationId });
      return Response.json(document, { headers: { "cache-control": "no-store" } });
    }
    return businessKnowledgeError(400, "VALIDATION_FAILED", "Unknown business knowledge operation");
  } catch (error) { return errorResponse(error); }
}
