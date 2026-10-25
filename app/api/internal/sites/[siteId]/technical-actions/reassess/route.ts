import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { TechnicalActionError, reassessTechnicalActionGroup } from "@/lib/crawler/technical-actions";

const NO_STORE = { "Cache-Control": "no-store" };
const requestSchema = z.object({
  crawlId: z.string().trim().min(1).max(120),
  expectedBindingGeneration: z.number().int().positive(),
  expectedContextRevision: z.string().trim().min(1).max(200),
  issueIds: z.array(z.string().trim().min(1).max(120)).min(1).max(200),
  operatorRequestId: z.string().trim().min(8).max(200),
  reason: z.string().trim().min(8).max(1000),
  existingActionId: z.string().trim().min(1).max(120).optional(),
  expectedActionRevision: z.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.issueIds).size !== value.issueIds.length) {
    context.addIssue({ code: "custom", path: ["issueIds"], message: "Issue IDs must be unique" });
  }
  if (Boolean(value.existingActionId) !== Boolean(value.expectedActionRevision)) {
    context.addIssue({ code: "custom", path: ["expectedActionRevision"], message: "Existing Action ID and revision must be supplied together" });
  }
});

function authorized(req: Request): boolean {
  const configured = process.env.HELLOADA_PROVISIONING_TOKEN;
  const supplied = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!configured || !supplied) return false;
  return timingSafeEqual(createHash("sha256").update(configured).digest(), createHash("sha256").update(supplied).digest());
}

export async function POST(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  let input: z.infer<typeof requestSchema>;
  try { input = requestSchema.parse(await req.json()); }
  catch (error) {
    return Response.json({ error: error instanceof z.ZodError ? error.issues[0]?.message : "Invalid request" },
      { status: 400, headers: NO_STORE });
  }
  try {
    const { siteId } = await params;
    const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true } });
    if (!site) return Response.json({ error: "Project site not found" }, { status: 404, headers: NO_STORE });
    if (!site.projectId) return Response.json({ error: "Site is not bound to a project" }, { status: 409, headers: NO_STORE });
    const result = await reassessTechnicalActionGroup({ ...input, siteId, projectId: site.projectId });
    return Response.json({ actionId: result.action.id, revision: result.action.revision, reused: result.reused }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof TechnicalActionError) {
      return Response.json({ error: error.message }, { status: error.status, headers: NO_STORE });
    }
    return Response.json({ error: "Technical Action reassessment failed" }, { status: 500, headers: NO_STORE });
  }
}
