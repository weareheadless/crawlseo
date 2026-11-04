import { userOwnsSite } from "@/lib/auth/research-action-access";
import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { ensureTenantAnalysis, inspectTenant } from "@/lib/tenants/analysis";

/**
 * The tenant analysis pipeline, for one site.
 *
 * GET reports what is missing; POST performs the fixes that can be performed now
 * and queues the rest. This exists so that "analyse this tenant" is an operation
 * of the product rather than a script someone runs by hand.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { siteId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });
  try {
    return Response.json(await inspectTenant(db, siteId));
  } catch {
    return Response.json({ error: "Site not found" }, { status: 404 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const userId = await getUserIdFromCookies();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { siteId } = await params;
  if (!(await userOwnsSite(siteId, userId))) return Response.json({ error: "Site not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const maxJoinSpendMicros = Number.isFinite(body?.maxJoinSpendMicros)
    ? Math.max(0, Math.min(Number(body.maxJoinSpendMicros), 1_000_000))
    : 200_000;

  try {
    return Response.json(await ensureTenantAnalysis(db, siteId, {
      apply: true,
      requestedBy: userId,
      maxJoinSpendMicros,
    }));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message.slice(0, 200) : "analysis failed" },
      { status: 500 },
    );
  }
}
