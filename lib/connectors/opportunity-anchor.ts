/**
 * The page and queries an Opportunity is anchored to.
 *
 * A client that shows "what this work is about" needs the page URL and the
 * queries, and it must never reconstruct them from a display string: the title
 * reads `Duplicate title on https://…` and the dedup key reads
 * `O7:https://…:DUPLICATE_TITLE`. Both are human- or identity-shaped, and
 * splitting them in a UI is exactly the deterministic guessing this codebase
 * refuses.
 *
 * This projection therefore only reads what the producing detector already
 * recorded, in order of authority:
 *
 *   1. `recommendationDecision.target` — the validated editorial proposal
 *      (`phase3-v1`), which names the page and whether the work creates it.
 *   2. `scoreInputs.worth.targetPages` — the page list the score was computed
 *      against.
 *   3. The dedup key's suffix, for the crawl and answer-engine detectors, whose
 *      identity *is* the anchor: `<type>:<url>:<CODE>` and `<type>:<query>`.
 *
 * Anything that cannot be proven from those fields is reported as `null` or
 * omitted, never inferred. `newPage` is `null` unless the proposal says so,
 * because "this page exists" is not something a URL can prove.
 */
import { parseOpportunityProposal } from "@/lib/funnel/proposal";

export type OpportunityAnchor = {
  /** The page the opportunity is about, existing or proposed. */
  pageUrl: string | null;
  /** True only when the accepted work creates that page. */
  newPage: boolean | null;
  /** Query strings the record itself names, in its own words. */
  queries: string[];
};

/** Detector identities whose suffix is `<url>:<CODE>` rather than prose. */
const ANCHOR_CODE = /^[A-Za-z0-9_]{2,64}$/;
const QUERY_LIMIT = 12;
const QUERY_LENGTH = 300;

function absoluteUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text || text.length > QUERY_LENGTH || text.includes("\n") || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= QUERY_LIMIT) break;
  }
  return out;
}

function worthOf(scoreInputs: unknown): Record<string, unknown> {
  if (!scoreInputs || typeof scoreInputs !== "object" || Array.isArray(scoreInputs)) return {};
  const worth = (scoreInputs as Record<string, unknown>).worth;
  return worth && typeof worth === "object" && !Array.isArray(worth) ? worth as Record<string, unknown> : {};
}

function decisionOf(recommendationDecision: unknown): Record<string, unknown> {
  if (!recommendationDecision || typeof recommendationDecision !== "object" || Array.isArray(recommendationDecision)) return {};
  return recommendationDecision as Record<string, unknown>;
}

/**
 * `<type>:<url>:<CODE>` is a crawl finding about a page that was fetched, and
 * `<type>:<query>` is an answer-engine observation about one query. Both are
 * identities the detector composed; neither is prose.
 */
function dedupAnchor(type: unknown, dedupKey: unknown): { pageUrl: string | null; queries: string[] } {
  if (typeof dedupKey !== "string") return { pageUrl: null, queries: [] };
  const separator = dedupKey.indexOf(":");
  if (separator < 0) return { pageUrl: null, queries: [] };
  const suffix = dedupKey.slice(separator + 1).trim();
  if (!suffix) return { pageUrl: null, queries: [] };

  if (/^https?:\/\//i.test(suffix)) {
    // The trailing `:<CODE>` is the only colon after the URL itself.
    const split = suffix.lastIndexOf(":");
    if (split <= "https://".length) return { pageUrl: null, queries: [] };
    const url = absoluteUrl(suffix.slice(0, split));
    return url && ANCHOR_CODE.test(suffix.slice(split + 1)) ? { pageUrl: url, queries: [] } : { pageUrl: null, queries: [] };
  }

  // O5 observations are keyed by the exact query an answer engine was asked.
  if (type === "O5_aeo_presence_gap") return { pageUrl: null, queries: stringList([suffix]) };
  return { pageUrl: null, queries: [] };
}

export function opportunityAnchor(row: {
  type: string;
  dedupKey: string;
  scoreInputs: unknown;
  recommendationDecision: unknown;
}): OpportunityAnchor {  const proposal = parseOpportunityProposal(row.recommendationDecision);
  const decision = decisionOf(row.recommendationDecision);
  const worth = worthOf(row.scoreInputs);
  const dedup = dedupAnchor(row.type, row.dedupKey);

  const pageUrl =
    absoluteUrl(proposal?.target.url)
    ?? stringList(worth.targetPages).map(absoluteUrl).find((value): value is string => Boolean(value))
    ?? dedup.pageUrl;

  const queries = [
    ...stringList(decision.queries),
    ...stringList(worth.queries),
    ...dedup.queries,
  ].filter((value, index, all) => all.indexOf(value) === index).slice(0, QUERY_LIMIT);

  return {
    pageUrl,
    // `parseOpportunityProposal` only returns a proposal when `target` is
    // present, so the flag is the proposal's own statement, not a default.
    newPage: proposal ? proposal.target.newAsset : null,
    queries,
  };
}

/** Attach the anchor without altering any stored field. */
export function withOpportunityAnchor<T extends {
  type: string;
  dedupKey: string;
  scoreInputs: unknown;
  recommendationDecision: unknown;
}>(row: T): T & OpportunityAnchor {
  return { ...row, ...opportunityAnchor(row) };
}
