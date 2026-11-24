import { resolveRankedResult, type ResolvedResult } from "@/lib/dataforseo/serp-attribution";

/**
 * CMP-003: which domains a paid SERP says are beating us.
 *
 * This is a pure function of one provider response, extracted so two callers can
 * use the same rule: the live collector (writing `competitor_rank` as it stores the
 * snapshot) and a backfill over SERPs that were already paid for but collected
 * before the rows existed.
 *
 * Three boundaries, each of which was a defect elsewhere in this codebase:
 *
 *  1. **Only domains above us.** For a query we lead, nobody is above us and the
 *     answer is "no competitors", not "everyone we beat". A domain that ranks below
 *     the site was never winning it.
 *  2. **Identity comes from the breadcrumb, not the URL.** A live organic item's
 *     `url` is an opaque `google.com/goto` wrapper; the resolver recovers the host
 *     from the breadcrumb. An item whose host cannot be resolved is skipped rather
 *     than guessed.
 *  3. **One row per domain.** A SERP can list several pages from one site; the
 *     domain's best position is the fact worth storing.
 *
 * It never invents a competitor from a domain-shaped string: a domain is here
 * because a snapshot named it.
 */

export type OrganicItem = {
  /** The provider's absolute rank when it is mapped into our own shape. */
  rankAbsolute?: number | null;
  /** The organic-only rank, which ignores feature blocks above the list. */
  rank?: number | null;
  url?: string | null;
  domain?: string | null;
  breadcrumb?: string | null;
  websiteName?: string | null;
  /** Raw provider field names, when a payload is read back from storage. */
  rank_absolute?: number | null;
  website_name?: string | null;
};

export type CompetitorObservation = {
  domain: string;
  /** The page's URL when the breadcrumb was complete enough to rebuild it. */
  url: string | null;
  /** The domain's best absolute position on this SERP. */
  position: number;
};

export type SerpCompetitorExtraction = {
  /** Domains above our position, or every attributed domain when we are absent. */
  competitors: CompetitorObservation[];
  /** Our own absolute position, or 0 when we do not appear. */
  ourPosition: number;
  /** How many organic items could be attributed to a real host. */
  attributable: number;
  /** True when the SERP had at least one attributable result. */
  observed: boolean;
};

/** The site's own domain, normalised for comparison (lower-case, no www). */
export function normalizeSiteDomain(domain: string): string {
  return (domain ?? "").trim().toLowerCase().replace(/^www\./, "");
}

export function sameSite(candidate: string | null | undefined, site: string): boolean {
  if (!candidate) return false;
  const normalised = normalizeSiteDomain(candidate);
  return normalised === site || normalised.endsWith(`.${site}`);
}

/**
 * Read one provider SERP response.
 *
 * `organic` is the provider's own item list. Every item is resolved through the
 * CMP-001 attribution rule, and anything that cannot be attributed is dropped —
 * an unattributable item is evidence of nothing, and keeping it would let a
 * `google.com` wrapper onto a leaderboard.
 */
export function extractSerpCompetitors(input: {
  organic: OrganicItem[] | null | undefined;
  domain: string;
}): SerpCompetitorExtraction {
  const site = normalizeSiteDomain(input.domain);
  const ranked = (input.organic ?? [])
    .map((item, index) => ({ item, index, resolved: resolveRankedResult(item as never) }))
    .filter(
      (entry): entry is { item: OrganicItem; index: number; resolved: ResolvedResult } => entry.resolved != null
    )
    .map(({ item, index, resolved }) => ({
      item,
      url: resolved.url,
      domain: resolved.domain,
      // The provider's own absolute rank first (a feature block above the organic
      // list shifts it); the organic rank is the fallback, then list order, which
      // is the index in the attributable list so dropping an unattributable item
      // cannot shift everyone up a place.
      position: item.rankAbsolute ?? item.rank_absolute ?? item.rank ?? index + 1,
    }));

  const ours = ranked.filter((entry) => sameSite(entry.domain, site));
  const ourPosition = ours.length > 0 ? (ours[0].position ?? 0) : 0;

  // Above us when we rank; everything when we are absent. `position == null`
  // cannot be proven to be below us, so it is kept rather than dropping a
  // competitor whose rank the provider omitted.
  const beating = ourPosition > 0
    ? ranked.filter((entry) => entry.position == null || entry.position < ourPosition)
    : ranked;

  const byDomain = new Map<string, CompetitorObservation>();
  for (const entry of beating) {
    if (!entry.domain) continue;
    if (sameSite(entry.domain, site)) continue;
    if (entry.position == null || entry.position <= 0) continue;
    const existing = byDomain.get(entry.domain);
    if (existing) {
      if (entry.position < existing.position) existing.position = entry.position;
      continue;
    }
    byDomain.set(entry.domain, { domain: entry.domain, url: entry.url, position: entry.position });
  }

  return {
    competitors: [...byDomain.values()].sort((a, b) => a.position - b.position),
    ourPosition,
    attributable: ranked.length,
    observed: ranked.length > 0,
  };
}
