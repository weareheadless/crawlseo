import { z } from "zod";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { userOwnsSite } from "@/lib/auth/research-action-access";
import { db } from "@/lib/db";
import { runEvaluation } from "@/lib/aeo/run";

const bodySchema = z.object({ actionId: z.string().trim().min(1).max(120) }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ siteId: string }> }) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { siteId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "actionId is required" }, { status: 400 });
  const [site, action] = await Promise.all([
    db.site.findUnique({ where: { id: siteId }, select: { id: true, projectId: true, project: { select: { status: true } } } }),
    db.researchAction.findUnique({ where: { id: parsed.data.actionId }, select: { id: true, siteId: true, revision: true, primaryQuery: true, title: true } }),
  ]);
  if (!action) return Response.json({ error: "Unknown action" }, { status: 404 });
  if (action.siteId !== siteId) return Response.json({ error: "Action does not belong to this site" }, { status: 400 });
  if (!site?.projectId || site.project?.status !== "ACTIVE") return Response.json({ error: "Site has no active project budget" }, { status: 409 });
  try {
    const question = action.primaryQuery?.trim() || action.title.trim();
    const receipt = await runEvaluation({ projectId: site.projectId, siteId, trigger: "action", actionId: action.id, actionRevision: action.revision, question, cap: 2 });
    return Response.json(receipt);
  } catch (error) {
    console.error("AEO action re-ask failed", error);
    return Response.json({ error: "AEO re-ask failed" }, { status: 500 });
  }
}
