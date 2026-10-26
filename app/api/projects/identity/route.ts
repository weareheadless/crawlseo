import { authenticateServiceToken, requireProjectScope, ServiceAuthError } from "@/lib/auth/service-credentials";
import { db } from "@/lib/db";
import { businessKnowledgeError } from "@/lib/projects/business-knowledge-response";

const BUSINESS_KNOWLEDGE_PERMISSIONS = new Set(["project:read", "document:read", "document:write"]);

export async function GET(req: Request) {
  try {
    const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    const principal = await authenticateServiceToken(token);
    requireProjectScope(principal, "project:read");
    const projectId = new URL(req.url).searchParams.get("projectId")?.trim() ?? "";
    if (!projectId) return businessKnowledgeError(400, "VALIDATION_FAILED", "Project ID is required");
    if (projectId !== principal.projectId) return businessKnowledgeError(404, "NOT_FOUND", "Project was not found");

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        externalProjectId: true,
        workspace: { select: { externalOrganizationId: true, name: true } },
      },
    });
    if (!project || project.workspaceId !== principal.workspaceId) {
      return businessKnowledgeError(404, "NOT_FOUND", "Project was not found");
    }
    const separator = project.externalProjectId.indexOf(":");
    if (separator < 1 || separator === project.externalProjectId.length - 1) {
      return businessKnowledgeError(404, "NOT_FOUND", "Project was not found");
    }
    const permissions = principal.scopes.filter((scope) => BUSINESS_KNOWLEDGE_PERMISSIONS.has(scope)).sort();
    return Response.json({
      schemaVersion: "business-knowledge/1",
      kind: "project_registration_result",
      externalOrganizationId: project.workspace.externalOrganizationId,
      workspaceId: project.workspaceId,
      workspaceName: project.workspace.name,
      projectId: project.id,
      externalProjectId: project.externalProjectId,
      origin: {
        system: project.externalProjectId.slice(0, separator),
        externalId: project.externalProjectId.slice(separator + 1),
      },
      credentialScope: {
        audience: "business-knowledge",
        externalOrganizationId: project.workspace.externalOrganizationId,
        workspaceId: project.workspaceId,
        projectId: project.id,
        permissions,
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ServiceAuthError) {
      return businessKnowledgeError(error.statusCode, error.statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message);
    }
    console.error("Project identity lookup failed:", error instanceof Error ? error.message : "unknown");
    return businessKnowledgeError(500, "UNAVAILABLE", "Project identity lookup is temporarily unavailable", true);
  }
}
