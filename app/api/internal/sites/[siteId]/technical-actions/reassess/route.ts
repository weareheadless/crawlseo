import { createHash, timingSafeEqual } from "node:crypto";

const NO_STORE = { "Cache-Control": "no-store" };

function authorized(req: Request): boolean {
  const configured = process.env.HELLOADA_PROVISIONING_TOKEN;
  const supplied = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!configured || !supplied) return false;
  return timingSafeEqual(createHash("sha256").update(configured).digest(), createHash("sha256").update(supplied).digest());
}

/**
 * Wave 6: retired.
 *
 * This endpoint minted and revised legacy Actions from a crawl issue group. The
 * funnel has one producer of work — opportunities detected from evidence — so
 * there is nothing here to reassess: a recrawl refreshes the funnel and the O7/O8
 * detectors raise or re-score the opportunity themselves.
 *
 * It answers 410 rather than 404 so a caller still wired to it learns why, and it
 * keeps its authentication so an unauthenticated request cannot probe it.
 * See docs/site-agent-connector-contract.md.
 */
export async function POST(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  }
  return Response.json(
    {
      error: "This endpoint is retired",
      detail:
        "Technical reassessment now happens in the funnel: run a crawl and the O7/O8 detectors raise or re-score opportunities from the new evidence. No legacy Action is created or revised.",
      replacedBy: "POST /api/sites/{siteId}/crawl (or the scheduled crawl), then GET /api/sites/{siteId}/opportunities",
    },
    { status: 410, headers: NO_STORE }
  );
}
