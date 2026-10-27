import { z } from "zod";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { writeBusinessKnowledge, BusinessKnowledgeError, businessKnowledgeFieldsSchema } from "@/lib/projects/business-knowledge";

const schema = z.object({ workspaceId: z.string().min(1), projectId: z.string().min(1), documentId: z.string().min(1),
  expectedRevision: z.number().int().min(0), idempotencyKey: z.string().min(8).max(240), reason: z.string().min(1).max(1000),
  changes: businessKnowledgeFieldsSchema }).strict();

export async function POST(request: Request) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ code: "UNAUTHENTICATED", error: "Unauthorized" }, { status: 401 });
  try {
    const input = schema.parse(await request.json());
    const project = await db.project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { id: true, workspaceId: true, sites: { select: { id: true, userId: true } } } });
    if (!project || project.sites.some((site) => site.userId !== null && site.userId !== userId)) return Response.json({ code: "NOT_FOUND", error: "Document not found" }, { status: 404 });
    const owner = project.sites.some((site) => site.userId === userId);
    const principal = { credentialId: `dashboard:${userId}`, servicePrincipalId: `dashboard:${userId}`,
      workspaceId: input.workspaceId, projectId: input.projectId, scopes: ["document:write"] };
    const document = await writeBusinessKnowledge(input, principal, { type: owner ? "owner" : "workspace_admin", id: userId });
    return Response.json(document, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof BusinessKnowledgeError) {
      const status = error.code === "NOT_FOUND" ? 404 : error.code === "FORBIDDEN" ? 403 : error.code === "VALIDATION_FAILED" ? 400 : 409;
      return Response.json({ code: error.code, error: error.message, currentRevision: error.currentRevision }, { status });
    }
    if (error instanceof z.ZodError) return Response.json({ code: "VALIDATION_FAILED", error: error.issues[0]?.message }, { status: 400 });
    return Response.json({ code: "UNAVAILABLE", error: "Business knowledge is temporarily unavailable" }, { status: 500 });
  }
}
