/**
 * Typed claims about the site, and their verification (plan P3/P5).
 *
 * A finding used to be free prose. When it said "the site has no city-level entry
 * point", nothing checked that against the crawl that held thirteen city pages, so
 * the claim was published as a positioning gap. Prose cannot be verified; a
 * declared claim can.
 *
 * The rule this enforces: a claim about the site is either contradicted by the
 * inventory we hold, supported by it, or explicitly unverified. A contradicted
 * premise never becomes a recommendation, and an unverified one never reads as a
 * finding of absence.
 */

export type SiteClaimKind = "missing_page_type" | "missing_answer" | "absent_offering";

export type SiteClaim = {
  kind: SiteClaimKind;
  /** For `missing_page_type`: the page type the finding says does not exist. */
  pageType: string | null;
  /** The sentence the finding asserts, kept for the audit record. */
  statement: string;
};

export type VerificationStatus = "supported" | "contradicted" | "unverified";

export type Verification = {
  status: VerificationStatus;
  reason: string;
};

export type PageTypeInventory = {
  type: string;
  pages: number;
  /** A page of that type that exists, so the claim can be checked by example. */
  sample?: string;
};

/**
 * Normalise a page type for comparison: "City Pages", "/cities/", "cities" and
 * "city" are the same type.
 */
export function normalizePageType(value: string): string {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/^\/+|\/+$/g, "")
    .split(/[/?#]/)[0] ?? "";
  const singular = trimmed.replace(/(ies)$/, "y").replace(/(ses)$/, "s").replace(/s$/, "");
  return singular.replace(/[^a-z0-9-]/g, "");
}

function inventoryMatches(claimType: string, inventory: PageTypeInventory[]): PageTypeInventory | null {
  const wanted = normalizePageType(claimType);
  if (!wanted) return null;
  for (const entry of inventory) {
    if (entry.pages <= 0) continue;
    const candidate = normalizePageType(entry.type);
    if (!candidate) continue;
    // Equality only: a substring match made "mexico-city-inventory" match "city"
    // and silently rejected a legitimate finding about a missing inventory.
    if (candidate === wanted) return entry;
  }
  return null;
}

/**
 * Verify one claim against the page inventory.
 *
 * `missing_page_type` is the only claim we can settle mechanically today, because
 * the crawl holds the inventory. Claims about an answer or an offer need the page
 * content, so they stay `unverified` rather than being treated as proven absence.
 */
export function verifySiteClaim(claim: SiteClaim, inventory: PageTypeInventory[]): Verification {
  if (claim.kind === "missing_page_type") {
    if (!claim.pageType) {
      return { status: "unverified", reason: "the claim names no page type to check" };
    }
    const match = inventoryMatches(claim.pageType, inventory);
    if (match) {
      return {
        status: "contradicted",
        reason: `the crawl holds ${match.pages} ${match.type} page(s)${match.sample ? `, e.g. ${match.sample}` : ""}`,
      };
    }
    return {
      status: "supported",
      reason: `no ${claim.pageType} page appears in the crawl inventory`,
    };
  }

  return {
    status: "unverified",
    reason: "an answer or offer claim needs the page content; the inventory alone cannot settle it",
  };
}

export type ClaimedFinding = {
  siteClaim?: SiteClaim | null;
  [key: string]: unknown;
};

export type ClaimedFindingResult<T extends ClaimedFinding> = {
  /** Findings that may be published. */
  kept: Array<T & { verification: Verification }>;
  /** Findings whose premise the evidence contradicts, with the reason. */
  rejected: Array<{ finding: T; verification: Verification }>;
};

/**
 * Apply verification to a batch of findings.
 *
 * Contradicted findings are removed from the publishable set and returned
 * separately so the run can record why. Unverified ones are kept and labelled:
 * they are hypotheses worth checking, not findings of absence.
 */
export function verifyClaimedFindings<T extends ClaimedFinding>(
  findings: T[],
  inventory: PageTypeInventory[]
): ClaimedFindingResult<T> {
  const kept: Array<T & { verification: Verification }> = [];
  const rejected: Array<{ finding: T; verification: Verification }> = [];
  for (const finding of findings) {
    if (!finding.siteClaim) {
      kept.push({ ...finding, verification: { status: "unverified", reason: "the finding makes no claim about the site" } });
      continue;
    }
    const verification = verifySiteClaim(finding.siteClaim, inventory);
    if (verification.status === "contradicted") {
      rejected.push({ finding, verification });
      continue;
    }
    kept.push({ ...finding, verification });
  }
  return { kept, rejected };
}
