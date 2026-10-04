import { createHash, timingSafeEqual } from "node:crypto";
import { provisionProject, type ProvisionProjectInput } from "@/lib/projects/provision-project";

function authorized(req: Request): boolean {
  const configured = process.env.HELLOADA_PROVISIONING_TOKEN;
  const header = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!configured || !header) return false;
  const expected = createHash("sha256").update(configured).digest();
  const actual = createHash("sha256").update(header).digest();
  return timingSafeEqual(expected, actual);
}

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = (await req.json()) as Partial<ProvisionProjectInput>;
    const required = [
      "externalOrganizationId",
      "workspaceName",
      "externalProjectId",
      "projectName",
      "domain",
      "gscProperty",
      "ga4PropertyId",
      "serviceCredentialIdempotencyKey",
    ] as const;
    if (required.some((field) => body[field] === undefined || body[field] === null)) {
      return Response.json({ error: "Missing provisioning field" }, { status: 400 });
    }
    if (!body.serviceAccountCredentials && !body.googleOAuthUserEmail) {
      return Response.json({ error: "Missing Google credential" }, { status: 400 });
    }

    const result = await provisionProject({
      ...(body as ProvisionProjectInput),
      requireDataForSeo: true,
    });
    return Response.json({
      workspace_id: result.workspaceId,
      project_id: result.projectId,
      site_id: result.siteId,
      service_principal_id: result.servicePrincipalId,
      credential_id: result.credentialId,
      credential_token: result.credentialToken,
      credential_reused: result.credentialReused,
      dataforseo_grant_source: result.dataforseoGrantSource,
      jobs: result.jobs,
    });
  } catch (error) {
    console.error("Project provisioning failed:", error instanceof Error ? error.message : "unknown");
    return Response.json({ error: "Project provisioning failed" }, { status: 400 });
  }
}
