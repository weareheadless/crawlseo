import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { refreshFunnelForSite } from "@/lib/funnel/backfill";
import { storeEvidenceRecord } from "@/lib/funnel/evidence";
import { z } from "zod";
import { ZodError } from "zod";
import { userOwnsSite } from "@/lib/auth/research-action-access";

const schema = z.object({
  keyword: z.string().trim().min(2).max(300),
  volume: z.number().nonnegative().nullable().optional(),
  difficulty: z.number().min(0).max(100).nullable().optional(),
  cpc: z.number().nonnegative().nullable().optional(),
  competition: z.number().nullable().optional(),
  intent: z.string().trim().max(60).nullable().optional(),
});

/**
 * Wave 6 cutover: this endpoint used to mint a legacy Action from a keyword the
 * owner picked out of a research run. The funnel has one way for work to exist —
 * an opportunity, detected from evidence — so the endpoint now records the
 * keyword as tracked demand and refreshes detection.
 *
 * What the owner meant ("this keyword matters") is preserved; what they get is a
 * demand-map entry and, when the evidence supports it, an opportunity.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { siteId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });

  const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true } });
  if (!site?.projectId) {
    return Response.json({ error: "This site is not attached to a project, so it cannot track demand" }, { status: 409 });
  }

  try {
    const input = schema.parse(await req.json());
    const observedAt = new Date();
    await storeEvidenceRecord(db, {
      projectId: site.projectId,
      siteId,
      kind: "keyword_universe_membership",
      observedAt,
      producer: "owner_selection",
      dimensions: { cluster: "owner-selected", query: input.keyword, source: "owner_selection" },
      metrics: {
        ...(typeof input.volume === "number" ? { "provider:volume": { value: input.volume, unit: "searches/month" as const, source: "provider" as const } } : {}),
        ...(typeof input.difficulty === "number" ? { "provider:difficulty": { value: input.difficulty, unit: "score" as const, source: "provider" as const } } : {}),
      },
    });
    const result = await refreshFunnelForSite(db, siteId, { detectedBy: "owner-keyword-selection" });
    return Response.json({ tracked: true, keyword: input.keyword, created: result.created, updated: result.updated });
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "Invalid keyword payload", issues: error.issues }, { status: 400 });
    }
    console.error("Keyword tracking error:", error);
    return Response.json({ error: "Failed to track keyword" }, { status: 500 });
  }
}
