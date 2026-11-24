import { authenticateServiceToken, requireProjectScope, ServiceAuthError } from "@/lib/auth/service-credentials";
import { db } from "@/lib/db";
import { businessKnowledgeError } from "@/lib/projects/business-knowledge-response";
import { readSiteBrand } from "@/lib/site/brand";

/**
 * One site's brand and representation, for a rendering or writing consumer.
 *
 * Cicero used to hold its own `brand.json`; the logo was empty in the copy while
 * the real logo was elsewhere, so four posts shipped without it. A consumer reads
 * this instead and may cache the payload by `revision`, which is a hash of the
 * record — the cache is disposable, this response is the answer.
 *
 * Service credential only: no session cookie, no browser session, no write.
 */
export async function GET(req: Request) {
  try {
    const token = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
    const principal = await authenticateServiceToken(token);
    requireProjectScope(principal, "project:read");

    const siteId = new URL(req.url).searchParams.get("siteId")?.trim() ?? "";
    if (!siteId) return businessKnowledgeError(400, "VALIDATION_FAILED", "Site ID is required");

    const site = await db.site.findUnique({ where: { id: siteId }, select: { projectId: true, domain: true, retiredAt: true } });
    // A site belonging to another project answers exactly as a missing one does;
    // otherwise the 404 doubles as a directory of sites this credential cannot see.
    if (!site || site.projectId !== principal.projectId || site.retiredAt) {
      return businessKnowledgeError(404, "NOT_FOUND", "Site was not found");
    }

    const record = await readSiteBrand(db, siteId);
    if (!record) return businessKnowledgeError(404, "NOT_FOUND", "Site profile was not found");

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
  } catch (error) {
    if (error instanceof ServiceAuthError) {
      return businessKnowledgeError(error.statusCode, error.statusCode === 401 ? "UNAUTHENTICATED" : "FORBIDDEN", error.message);
    }
    console.error("Site brand lookup failed:", error instanceof Error ? error.message : "unknown");
    return businessKnowledgeError(500, "UNAVAILABLE", "Site brand is temporarily unavailable", true);
  }
}
