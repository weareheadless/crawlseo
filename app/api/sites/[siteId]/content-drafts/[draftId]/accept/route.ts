import { getUserIdFromCookies } from "@/lib/session-helper";
import { userOwnsSite } from "@/lib/auth/research-action-access";
import { db } from "@/lib/db";
import { recordDraftCoverage } from "@/lib/research/question-coverage";

export async function POST(req: Request, { params }: { params: Promise<{ siteId: string; draftId: string }> }) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { siteId, draftId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });
  const draft = await db.contentDraft.findFirst({ where: { id: draftId, siteId }, select: { id: true } });
  if (!draft) return Response.json({ error: "Draft not found" }, { status: 404 });

  let body: unknown = {};
  try { body = await req.json(); } catch { /* An empty body means no evidence was supplied. */ }
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid request body" }, { status: 400 });
  const raw = (body as Record<string, unknown>).evidence;
  let evidence: { documentId: string; fieldPath: string; revision: number } | undefined;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) return Response.json({ error: "Invalid evidence reference" }, { status: 400 });
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.documentId !== "string" || !candidate.documentId.trim() || typeof candidate.fieldPath !== "string" || !candidate.fieldPath.trim() || !Number.isInteger(candidate.revision) || (candidate.revision as number) < 1) {
      return Response.json({ error: "Evidence requires documentId, fieldPath and a positive revision" }, { status: 400 });
    }
    evidence = { documentId: candidate.documentId, fieldPath: candidate.fieldPath, revision: candidate.revision as number };
  }
  const coverage = await recordDraftCoverage(draftId, evidence);
  if (!coverage || !("status" in coverage)) return Response.json({ coverage: null, outcome: "unresolved" });
  return Response.json({ outcome: coverage.status === "COVERED" ? "covered" : "unresolved", coverage: { status: coverage.status, sectionHash: coverage.contentHash, missingEvidence: coverage.missingEvidence, actionId: coverage.actionId } });
}
