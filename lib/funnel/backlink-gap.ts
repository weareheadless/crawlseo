/**
 * CMP-007: the link-target gap, as a set operation.
 *
 * O9 could never fire: it filters on `provider:referringDomainGap` and nothing
 * wrote that metric. The database held two `backlink_profile` rows, both
 * `scope: "own_domain"`. This module computes the number the detector needs.
 *
 * The arithmetic is deliberately plain:
 *
 *   targets = competitor_referring_domains − our_referring_domains
 *
 * A domain that links to both is not a link opportunity — we already have it. A
 * domain that links only to the competitor is one. Nothing here weights, scores or
 * prioritises: the provider's own metrics travel with each domain, and ordering by
 * a declared number is the caller's choice, not a judgement made in code.
 */

/** One domain that links somewhere, with the provider's own facts about it. */
export type ReferringDomain = {
  domain: string;
  /** Provider rank of the linking domain, higher is stronger. */
  rank: number | null;
  backlinks: number | null;
  /** The competitor URL this domain links to, when the provider reported it. */
  targetUrl: string | null;
  linkType: string | null;
};

export type LinkTarget = ReferringDomain & {
  /** How many competitors' referring sets this domain appears in. */
  competitorsLinking: number;
};

export type BacklinkGap = {
  /** Domains that link to a competitor and not to us. Sorted by provider rank. */
  targets: LinkTarget[];
  /** Domains both we and at least one competitor have. */
  shared: string[];
  /** The count the detector reads: `provider:referringDomainGap`. */
  gap: number;
  /** How many distinct domains we were measured against. */
  competitorDomainCount: number;
  /** How many domains our own profile had, when it had one. */
  ourDomainCount: number | null;
  /** Competitors with no referring-domain data, by domain. */
  missing: string[];
};

/** Normalise a domain for set comparison: lower-case, no scheme, no www. */
export function normalizeDomain(value: string): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

/**
 * Compute the gap.
 *
 * `ours` is the set of domains linking to the site. When it is null — because our
 * own profile has not been collected — the gap is still computed against an empty
 * set, but `ourDomainCount` is null so the caller can say the subtraction was
 * against nothing rather than pretending we were measured.
 *
 * A competitor that returned no domains is named in `missing` rather than counted
 * as "no gap": an absent measurement is not evidence that a competitor has no links.
 */
export function backlinkGap(input: {
  competitors: Array<{ domain: string; referring: ReferringDomain[] | null }>;
  ours: ReferringDomain[] | null;
}): BacklinkGap {
  const ourDomains = new Set(
    (input.ours ?? []).map((row) => normalizeDomain(row.domain)).filter(Boolean)
  );

  const byDomain = new Map<string, LinkTarget>();
  const shared = new Set<string>();
  const missing: string[] = [];
  let measuredCompetitors = 0;

  for (const competitor of input.competitors) {
    if (!competitor.referring) {
      // No data is not zero data. The caller reports which competitor is missing.
      missing.push(competitor.domain);
      continue;
    }
    measuredCompetitors += 1;
    for (const row of competitor.referring) {
      const key = normalizeDomain(row.domain);
      if (!key) continue;
      if (ourDomains.has(key)) {
        shared.add(key);
        continue;
      }
      const existing = byDomain.get(key);
      if (existing) {
        existing.competitorsLinking += 1;
        // The strongest link from one domain is what an outreach list needs.
        if ((row.rank ?? 0) > (existing.rank ?? 0)) existing.rank = row.rank;
        if ((row.backlinks ?? 0) > (existing.backlinks ?? 0)) existing.backlinks = row.backlinks;
        if (!existing.targetUrl && row.targetUrl) existing.targetUrl = row.targetUrl;
        continue;
      }
      byDomain.set(key, {
        domain: key,
        rank: row.rank,
        backlinks: row.backlinks,
        targetUrl: row.targetUrl,
        linkType: row.linkType,
        competitorsLinking: 1,
      });
    }
  }

  const targets = [...byDomain.values()].sort(
    (a, b) =>
      // Ordering by a provider number, then by how many competitors a domain links
      // to. Both are facts; neither is a score invented here.
      (b.rank ?? 0) - (a.rank ?? 0) ||
      b.competitorsLinking - a.competitorsLinking ||
      a.domain.localeCompare(b.domain)
  );

  return {
    targets,
    shared: [...shared].sort(),
    gap: targets.length,
    competitorDomainCount: measuredCompetitors,
    ourDomainCount: input.ours == null ? null : ourDomains.size,
    missing,
  };
}

/**
 * The one-line summary O9 shows.
 *
 * It names the domains, because "competitors have more links" is not a brief. The
 * count comes first so the number and the names always agree.
 */
export function linkTargetSummary(gap: BacklinkGap, limit = 3): string {
  if (gap.missing.length > 0 && gap.targets.length === 0) {
    return `No referring-domain data for ${gap.missing.join(", ")}, so the link gap is not measured.`;
  }
  if (gap.targets.length === 0) {
    return `No link gap: ${gap.competitorDomainCount} competitor ${gap.competitorDomainCount === 1 ? "profile" : "profiles"} compared and every domain linking to them also links to us.`;
  }
  const named = gap.targets.slice(0, limit).map((row) => row.domain);
  const suffix = gap.targets.length > limit ? ` and ${gap.targets.length - limit} more` : "";
  return `${gap.gap} domains link to the pages above us without linking to us: ${named.join(", ")}${suffix}.`;
}
