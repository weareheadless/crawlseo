import { z } from "zod";
import { authenticateServiceToken, requireProjectScope, ServiceAuthError } from "@/lib/auth/service-credentials";
import { requestPrelaunchResearch } from "@/lib/dataforseo/prelaunch";
import { getResearchReport, ResearchValidationError, ResearchNotFoundError } from "@/lib/dataforseo/research";

const paramsSchema = z.object({ projectId: z.string().min(1).max(120) });
const bodySchema = z.object({ brief: z.unknown(), idempotency_key: z.string().min(1).max(240) }).strict();
async function auth(req: Request, projectId: string) {
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  const principal = await authenticateServiceToken(token);
  requireProjectScope(principal, "seo:research");
  if (principal.projectId !== projectId) throw new Error("Project not found");
}
function error(error: unknown) {
  const status = error instanceof ServiceAuthError ? error.statusCode : error instanceof ResearchNotFoundError ? 404 : error instanceof ResearchValidationError ? 400 : error instanceof z.ZodError ? 400 : 500;
  return Response.json({ error: error instanceof Error ? error.message : "Research unavailable" }, { status, headers: { "cache-control": "no-store" } });
}
export async function POST(req: Request, context: { params: Promise<{ projectId: string }> }) {
  try { const p = paramsSchema.parse(await context.params); await auth(req, p.projectId); const body = bodySchema.parse(await req.json());
    return Response.json(await requestPrelaunchResearch({ projectId: p.projectId, brief: body.brief, idempotencyKey: body.idempotency_key }), { headers: { "cache-control": "no-store" } });
  } catch (e) { return error(e); }
}
export async function GET(req: Request, context: { params: Promise<{ projectId: string }> }) {
  try { const p = paramsSchema.parse(await context.params); await auth(req, p.projectId); const id = new URL(req.url).searchParams.get("report_id");
    if (!id) return Response.json({ error: "report_id is required" }, { status: 400 });
    return Response.json(await getResearchReport(p.projectId, id), { headers: { "cache-control": "no-store" } });
  } catch (e) { return error(e); }
}
