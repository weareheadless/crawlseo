import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { readSiteBrand } from "@/lib/site/brand";

/**
 * One site's brand and representation, for another service in this backend.
 *
 * Cicero used to keep its own `brand.json`; the logo was empty in the copy while
 * the real logo existed, so posts shipped without it. It reads this instead.
 *
 * Internal service auth: one deployment secret, no tenant credentials, because
 * these services are one backend. The site id is the only tenant input.
 */
function authorized(req: Request): boolean {
  // `SITE_INTEL_INTERNAL_TOKEN` is the older name for the same deployment
  // secret; both are accepted so the existing crawl trigger keeps working.
  const configured = process.env.INTERNAL_SERVICE_TOKEN ?? process.env.SITE_INTEL_INTERNAL_TOKEN;
  const header = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!configured || !header) return false;
  const expected = createHash("sha256").update(configured).digest();
  const actual = createHash("sha256").update(header).digest();
  return timingSafeEqual(expected, actual);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { siteId } = await params;
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { domain: true, retiredAt: true },
  });
  if (!site || site.retiredAt) return Response.json({ error: "Site not found" }, { status: 404 });

  const record = await readSiteBrand(db, siteId);
  if (!record) return Response.json({ error: "Site profile not found" }, { status: 404 });

  return Response.json(
    {
      schemaVersion: "site-brand/1",
      siteId,
      domain: site.domain,
      revision: record.revision,
      // False means the profile has no brand block. A renderer must refuse the
      // job rather than fall back to a default palette or a nameless post.
      configured: record.configured,
      brand: record.brand,
      representation: record.representation,
      updatedAt: record.updatedAt,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
