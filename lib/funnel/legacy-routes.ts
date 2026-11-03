/**
 * Wave 6 step 1: archive the legacy routes.
 *
 * The pre-funnel screens read tables the funnel no longer writes to. They stay
 * on disk so the history is still reachable by URL, but they redirect to the
 * funnel surface that replaced them. Reversible: set
 * `CRAWLSEO_LEGACY_ROUTES=live` to serve them again without a code change.
 */

export type LegacyRoute = "legacy-work" | "legacy-opportunities" | "actions" | "findings" | "results";

/** Where each archived screen sends the reader instead. */
export const LEGACY_ROUTE_DESTINATION: Record<LegacyRoute, string> = {
  "legacy-work": "work",
  "legacy-opportunities": "opportunities",
  actions: "work",
  findings: "opportunities",
  results: "work",
};

/**
 * Archived by default: the cutover has happened, so the default must be the
 * safe one. `CRAWLSEO_LEGACY_ROUTES=live` is the explicit escape hatch.
 */
export function legacyRoutesArchived(): boolean {
  return process.env.CRAWLSEO_LEGACY_ROUTES !== "live";
}

/** Destination for an archived screen, or null when they are still served. */
export function archivedDestination(route: LegacyRoute, siteId: string): string | null {
  if (!legacyRoutesArchived()) return null;
  return `/sites/${siteId}/${LEGACY_ROUTE_DESTINATION[route]}`;
}
