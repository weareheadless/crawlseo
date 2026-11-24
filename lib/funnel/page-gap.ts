import type { PageSnapshot } from "@/lib/crawler/engine";

/**
 * CMP-006: the specific deficit between our page and the pages beating it.
 *
 * This is a *pure comparison*. It reports numbers and their differences so a writer
 * or a developer can decide what to do — it does not decide what the difference
 * means, and it has no thresholds that turn a number into a verdict.
 *
 * Why that matters here: every "helpful" rule of the form "under 800 words is thin"
 * is a guess about someone else's business. A 420-word page can outrank a 1,840-word
 * one, and a service page legitimately has fewer words than a guide. So the diff says
 * "they have 1,840, we have 420" and stops.
 *
 * The one thing it does judge is *whether a difference exists*, because "no
 * measurable deficit" is a real and useful answer: it tells the SEO that this
 * opportunity is not a content gap and the energy should go elsewhere.
 */

export type PageProfile = {
  url: string;
  /** Which competitor this page belongs to, when known. */
  domain: string | null;
  position: number | null;
  title: string | null;
  wordCount: number | null;
  h1Count: number | null;
  /** The heading texts, so a writer can see what topics the page covers. */
  headings: string[];
  /** True when the page declares structured data of any kind. */
  hasSchema: boolean | null;
  /** The schema types found, when the profile could read them. */
  schemaTypes: string[];
  internalLinks: number | null;
  lastModified: Date | null;
  /** When we fetched it, which is the only honest date when the page has none. */
  fetchedAt: Date | null;
  /** Set when the page could not be read; the reason is stated, never hidden. */
  unreadable?: string;
};

export type DeficitKind =
  | "word_count"
  | "headings"
  | "schema"
  | "freshness"
  | "internal_links";

export type Deficit = {
  kind: DeficitKind;
  /** What the competitor has. */
  theirs: number | string | null;
  /** What our page has. */
  ours: number | string | null;
  /** The difference in the same unit, when it is arithmetic. */
  difference: number | null;
  /** One line a person can read, naming both sides. */
  sentence: string;
};

export type PageGapResult = {
  /** Competitor pages that could be read. */
  readable: PageProfile[];
  /** Competitor pages that could not, with the reason they were recorded. */
  unreadable: Array<{ url: string; reason: string }>;
  /** Concrete differences, largest first. Empty means "no measurable deficit". */
  deficits: Deficit[];
  /** A measured page-strength factor in 0–1, or null with the reason. */
  pageStrength: number | null;
  /** Why `pageStrength` is null, when it is. Never silent. */
  pageStrengthReason: string | null;
  /** Our own profile, when a crawl has one. */
  ours: PageProfile | null;
  /** The single line the board and the opportunity summary show. */
  summary: string;
};

/** Days between two dates, or null when either is missing. */
function daysBetween(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
}

/**
 * Read a crawler snapshot into the comparison shape.
 *
 * The competitor fetch and the site crawl both produce a `PageSnapshot`, so this is
 * the single translation from "what the parser found" to "what the diff compares".
 * Sharing it is what makes the two sides commensurable.
 */
export function profileFromSnapshot(
  snapshot: PageSnapshot,
  overrides: { url?: string; domain?: string | null; position?: number | null; fetchedAt?: Date | null } = {}
): PageProfile {
  const headings = Array.isArray(snapshot.h1s) ? snapshot.h1s.filter(Boolean) : [];
  return {
    url: overrides.url ?? snapshot.url,
    domain: overrides.domain ?? null,
    position: overrides.position ?? null,
    title: snapshot.title ?? null,
    wordCount: typeof snapshot.wordCount === "number" ? snapshot.wordCount : null,
    h1Count: headings.length,
    headings,
    hasSchema: typeof snapshot.hasSchema === "boolean" ? snapshot.hasSchema : null,
    // The crawler records presence, not the declared types; a type list is added by
    // the competitor fetch when it can read one. Never invented from presence.
    schemaTypes: [],
    internalLinks: Array.isArray(snapshot.internalOutlinks) ? snapshot.internalOutlinks.length : null,
    lastModified: null,
    fetchedAt: overrides.fetchedAt ?? null,
  };
}

/** The exported name the competitor reader calls. */
export const comparePageProfiles = pageGap;

/**
 * Compare our page with the pages above us.
 *
 * Only differences where the competitor is *ahead* are reported, because a page
 * that is already better than the competitor's has no deficit to close. If our page
 * could not be read, nothing is claimed: an unreadable page is not a comparison.
 */
export function pageGap(input: {
  ours: PageProfile | null;
  competitors: PageProfile[];
  now?: Date;
}): PageGapResult {
  const now = input.now ?? new Date();
  const readable = input.competitors.filter((page) => !page.unreadable);
  const unreadable = input.competitors
    .filter((page) => page.unreadable)
    .map((page) => ({ url: page.url, reason: page.unreadable as string }));

  if (!input.ours) {
    return {
      readable,
      unreadable,
      deficits: [],
      pageStrength: null,
      pageStrengthReason:
        readable.length === 0
          ? "no competitor page could be read, so there is nothing to compare"
          : "our page has not been crawled, so the comparison has no other side",
      ours: null,
      summary:
        readable.length > 0
          ? `${readable.length} competitor ${readable.length === 1 ? "page" : "pages"} read; our page is not crawled yet, so no deficit is claimed.`
          : "No competitor page could be read for this query.",
    };
  }

  if (readable.length === 0) {
    return {
      readable,
      unreadable,
      deficits: [],
      pageStrength: null,
      pageStrengthReason: "no competitor page could be read, so page strength is unknown",
      ours: input.ours,
      summary: `No competitor page could be read for this query (${unreadable.length} tried).`,
    };
  }

  const ours = input.ours;
  const deficits: Deficit[] = [];

  // Word count: the median of the readable competitors, so one outlier does not
  // set the standard. Median is a fact about the group, not a target.
  const theirWordCounts = readable
    .map((page) => page.wordCount)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  if (theirWordCounts.length > 0 && ours.wordCount != null) {
    const median = theirWordCounts[Math.floor(theirWordCounts.length / 2)];
    if (median > ours.wordCount) {
      deficits.push({
        kind: "word_count",
        theirs: median,
        ours: ours.wordCount,
        difference: median - ours.wordCount,
        sentence: `They have a median of ${median.toLocaleString()} words; our page has ${ours.wordCount.toLocaleString()}.`,
      });
    }
  }

  // Headings: the most structured competitor, because the question is "does anyone
  // above us organise this answer better", and one page doing it proves it is done.
  const theirHeadingCounts = readable
    .map((page) => page.headings.length)
    .filter((value) => value > 0)
    .sort((a, b) => b - a);
  if (theirHeadingCounts.length > 0 && ours.headings.length >= 0) {
    const most = theirHeadingCounts[0];
    if (most > ours.headings.length) {
      deficits.push({
        kind: "headings",
        theirs: most,
        ours: ours.headings.length,
        difference: most - ours.headings.length,
        sentence: `The best-structured page above us uses ${most} headings; ours has ${ours.headings.length}.`,
      });
    }
  }

  // Schema: a named type is a fact. "They declare Product and we declare nothing"
  // is actionable; "schema missing" as a boolean is not.
  const theirSchemaTypes = [
    ...new Set(readable.flatMap((page) => page.schemaTypes)),
  ].filter(Boolean);
  const ourSchemaTypes = new Set(ours.schemaTypes);
  const missingSchema = theirSchemaTypes.filter((type) => !ourSchemaTypes.has(type));
  if (missingSchema.length > 0) {
    deficits.push({
      kind: "schema",
      theirs: missingSchema.join(", "),
      ours: ours.schemaTypes.length > 0 ? ours.schemaTypes.join(", ") : "none",
      difference: missingSchema.length,
      sentence: `They declare ${missingSchema.join(", ")}; our page declares ${ours.schemaTypes.length > 0 ? ours.schemaTypes.join(", ") : "no structured data"}.`,
    });
  }

  // Freshness: only when both dates are known. A page without a last-modified is
  // not "old", it is unknown.
  const theirDates = readable
    .map((page) => page.lastModified)
    .filter((value): value is Date => value != null);
  if (theirDates.length > 0 && ours.lastModified != null) {
    const newest = theirDates.reduce((latest, date) => (date > latest ? date : latest));
    if (newest > ours.lastModified) {
      const days = daysBetween(newest, ours.lastModified);
      deficits.push({
        kind: "freshness",
        theirs: newest.toISOString().slice(0, 10),
        ours: ours.lastModified.toISOString().slice(0, 10),
        difference: days,
        sentence: `The newest page above us was updated ${days} days after ours.`,
      });
    }
  }

  // Internal links: only when both sides were measured. This codebase does not yet
  // write an internal link graph, and inventing a count would be worse than saying
  // "not recorded".
  const theirLinks = readable
    .map((page) => page.internalLinks)
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  if (theirLinks.length > 0 && ours.internalLinks != null) {
    const median = theirLinks[Math.floor(theirLinks.length / 2)];
    if (median > ours.internalLinks) {
      deficits.push({
        kind: "internal_links",
        theirs: median,
        ours: ours.internalLinks,
        difference: median - ours.internalLinks,
        sentence: `They have a median of ${median} internal links on the page; ours has ${ours.internalLinks}.`,
      });
    }
  }

  // Largest relative gap first: the biggest number of missing words, then headings,
  // then schema, so the board's one line is the most material difference.
  deficits.sort((a, b) => {
    const weight = (kind: DeficitKind) =>
      kind === "word_count" ? 0 : kind === "headings" ? 1 : kind === "schema" ? 2 : kind === "freshness" ? 3 : 4;
    return weight(a.kind) - weight(b.kind) || (b.difference ?? 0) - (a.difference ?? 0);
  });

  // Page strength is a measured factor, not a default. It is the share of the
  // compared dimensions where our page is at least as strong as the median
  // competitor — a fraction of a measurement, never a guess.
  const measures: boolean[] = [];
  if (theirWordCounts.length > 0 && ours.wordCount != null) {
    const median = theirWordCounts[Math.floor(theirWordCounts.length / 2)];
    measures.push(ours.wordCount >= median);
  }
  if (theirHeadingCounts.length > 0) {
    measures.push(ours.headings.length >= theirHeadingCounts[0]);
  }
  if (theirSchemaTypes.length > 0) {
    measures.push(missingSchema.length === 0);
  }
  const pageStrength = measures.length > 0 ? measures.filter(Boolean).length / measures.length : null;

  const strongest = readable
    .slice()
    .sort((a, b) => (b.wordCount ?? 0) - (a.wordCount ?? 0))[0];

  const summary =
    deficits.length === 0
      ? `No measurable deficit: ${readable.length} competitor ${readable.length === 1 ? "page" : "pages"} compared on words, headings, schema${theirDates.length > 0 ? ", freshness" : ""} and our page is at least as strong.`
      : strongest
        ? // Name who is winning and what they have, then the deficit itself. The
          // deficit sentence already states both sides, so the leader line must not
          // repeat the number — it says who and where, the sentence says how far.
          `${strongest.domain ?? strongest.url} ranks ${strongest.position != null ? `#${strongest.position} ` : ""}for this query${
            theirSchemaTypes.length > 0 ? `, declaring ${theirSchemaTypes.join("/")}` : ""
          }. ${deficits[0].sentence}`
        : deficits[0].sentence;

  return {
    readable,
    unreadable,
    deficits,
    pageStrength,
    pageStrengthReason:
      pageStrength == null ? "no dimension was measurable on both sides" : null,
    ours,
    summary,
  };
}
