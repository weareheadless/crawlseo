import type { PrismaClient } from "@prisma/client";

/**
 * CMP-012: winnability is a measurement, not five constants.
 *
 * The board could not answer "can we actually win this, and who is in the way?", and
 * the reason was not missing data. `authorityGap`, `pageStrength` and `serpCompetition`
 * were **literals** (`0.5`) — measured 2026-11-24 on 145 live opportunities,
 * `pageStrength` and `serpCompetition` were `0.5` on **all 145**, and `authorityGap` on
 * 70. The score read as "this is a fair fight" while the fair-fight number was typed in
 * by a developer. That is worse than a missing measurement: it looks like one.
 *
 * This module reads the facts already stored and returns `null` where a fact is absent.
 *
 * Three rules, each of them the reason this is not a one-line change:
 *
 *  - **`null`, never a neutral default.** `computeScore` already drops a null from the
 *    geometric mean, so an unmeasured input stops pretending to be a fair fight. A `0.5`
 *    is a claim; `null` is not.
 *  - **A difficulty of `0` is unmeasured.** Measured: 435 of 621 stored
 *    `provider:difficulty` values are `0`, and those rows carry a **median volume of
 *    1,900** — a genuinely easy keyword would not. `0` is what the provider returns when
 *    it has nothing to say, so mapping it to a high `serpCompetition` would promote
 *    exactly the rows nobody measured.
 *  - **Every value carries its source and its date.** `winProbabilitySource` says
 *    measured / estimated / assumed, and `winProbabilityObservedAt` says when. A number
 *    whose provenance is invisible is the defect this ticket exists to remove.
 */

/** Days after which a stored difficulty is stale enough to be called estimated. */
export const WIN_PROBABILITY_FRESH_DAYS = 90;

/**
 * A record of how sure each input is. `assumed` is the honest word for a
 * `playTypeFactor` — it is a declared property of the play, not a measurement.
 */
/**
 * Fold a query to the form two spellings of it are compared in.
 *
 * Accents are a spelling, not a second phrase. Measured 2026-11-24: the topic map held
 * `tapisserie de siège` while the sampled SERP wrote `tapisserie de siege`, and a plain
 * `toLowerCase()` compared them as different queries. Case, accents and whitespace are
 * facts in every language, so folding them is arithmetic, not a judgement about meaning.
 */
function foldQuery(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export type WinProbabilitySource = "measured" | "estimated" | "assumed";

export type WinProbabilityProvenance = {
  source: Record<"rankDistance" | "authorityGap" | "pageStrength" | "serpCompetition" | "playTypeFactor", WinProbabilitySource>;
  /** The observation the input was read from, per input. Null where none exists. */
  observedAt: Partial<Record<"rankDistance" | "authorityGap" | "pageStrength" | "serpCompetition", Date>>;
  /** One line per input that is null, saying what is missing. Never a silent zero. */
  missing: string[];
};

/**
 * Map a provider keyword-difficulty score (0–100) to a win-probability input (0–1).
 *
 * **One function, one curve, no tenant rule.** Difficulty 0–100 is an absolute provider
 * score, so the mapping is arithmetic. It is monotonic and gentle at the hard end: the
 * difference between difficulty 90 and 95 is not the difference between 10 and 15.
 *
 * `0` returns `null`, not `1`. See the module note: with a median volume of 1,900 on the
 * zero rows, `0` is the absence of a measurement, and treating it as the easiest possible
 * SERP would put the least-measured keywords at the top of the board.
 */
export function difficultyToSerpCompetition(difficulty: number | null | undefined): number | null {
  if (difficulty == null || !Number.isFinite(difficulty)) return null;
  if (difficulty <= 0) return null;
  const clamped = Math.min(100, Math.max(0, difficulty));
  // 1 at difficulty 0 (excluded above), 0.5 at 50, approaching 0 at 100. The linear form
  // is deliberate: any curve here would be a guess dressed as a model, and a linear one is
  // the one a person can check by hand.
  return Math.round((1 - clamped / 100) * 1000) / 1000;
}

/**
 * How hard the sampled SERP is, from the domains a paid SERP actually placed.
 *
 * Two facts, both measured, neither a guess:
 *
 *  - **How many distinct domains are in the way.** A result page filled to the bottom is
 *    a harder field than one where five domains are the whole answer.
 *  - **How good the best of them is.** A leader at #1 is a stronger incumbent than a
 *    leader at #9 on a thin SERP.
 *
 * The curve is deliberately gentle and linear on domain count, because any sharper shape
 * would be an opinion wearing a formula. Returns `null` with no sampled domains: the
 * absence of a sample is not evidence of an easy SERP.
 *
 * Kept separate from `difficultyToSerpCompetition` because the two read different things —
 * a provider's market score and our own one-page sample — and conflating them would hide
 * which one a row used. The caller records the source either way.
 */
export function competitorToSerpCompetition(
  sampled: Array<{ position: number; observedAt: Date }>
): { value: number; bestPosition: number; observedAt: Date } | null {
  const valid = sampled.filter((row) => Number.isFinite(row.position) && row.position > 0);
  if (valid.length === 0) return null;
  const bestPosition = Math.min(...valid.map((row) => row.position));
  // 10 domains or more is the full field we ever sample; below that the page is thinner.
  const fieldFactor = Math.min(1, valid.length / 10);
  // A leader at #1 rather than #10 — climbing past #1 is the hardest single step.
  const leaderFactor = bestPosition <= 1 ? 0.3 : bestPosition <= 3 ? 0.6 : bestPosition <= 10 ? 0.85 : 1;
  const value = Math.round((1 - fieldFactor * leaderFactor) * 1000) / 1000;
  // The newest sample is when this comparison became true.
  const observedAt = valid.reduce((newest, row) => (row.observedAt > newest ? row.observedAt : newest), valid[0].observedAt);
  return { value, bestPosition, observedAt };
}

/**
 * Our page's strength against the page that is ahead of us, from stored crawl facts.
 *
 * This is a **fact ratio**, not a score: the share of the compared dimensions where our
 * page is at least as strong as the competitor's. `null` when either side was never
 * crawled, because "we did not look" is not "our page is weak".
 */
export type PageFacts = {
  wordCount: number | null;
  hasSchema: boolean | null;
  internalLinks: number | null;
  responseTimeMs: number | null;
};

export function pageStrength(ours: PageFacts | null, theirs: PageFacts | null): number | null {
  if (!ours || !theirs) return null;
  const comparisons: boolean[] = [];
  if (ours.wordCount != null && theirs.wordCount != null) {
    // Within 20% counts as at least as strong; a 500-word gap on a 2,000-word page is a
    // different claim from a 40-word gap.
    comparisons.push(ours.wordCount >= theirs.wordCount * 0.8);
  }
  if (ours.hasSchema != null && theirs.hasSchema != null) {
    comparisons.push(ours.hasSchema || !theirs.hasSchema);
  }
  if (ours.internalLinks != null && theirs.internalLinks != null) {
    comparisons.push(ours.internalLinks >= theirs.internalLinks * 0.5);
  }
  if (ours.responseTimeMs != null && theirs.responseTimeMs != null) {
    comparisons.push(ours.responseTimeMs <= theirs.responseTimeMs * 1.5);
  }
  if (comparisons.length === 0) return null;
  return Math.round((comparisons.filter(Boolean).length / comparisons.length) * 1000) / 1000;
}

/**
 * Our authority against the competitors', from the referring-domain sets CMP-007 stores.
 *
 * `ours / (ours + theirs)` — the share of the measured referring-domain pool that is ours.
 * A site with 63 referring domains against a competitor's 200 has an authority gap of
 * 0.24, which is a different fight from 0.9. Null when either set is absent.
 */
export function authorityGapFromSets(ours: number | null, theirs: number | null): number | null {
  if (ours == null || theirs == null) return null;
  if (ours < 0 || theirs < 0) return null;
  if (ours === 0 && theirs === 0) return null;
  return Math.round((ours / (ours + theirs)) * 1000) / 1000;
}

export type WinProbabilityInputs = {
  rankDistance: number | null;
  authorityGap: number | null;
  pageStrength: number | null;
  serpCompetition: number | null;
  playTypeFactor: number;
};

export type ResolvedWinProbability = {
  winProbability: WinProbabilityInputs;
  provenance: WinProbabilityProvenance;
  /** True when not one input was measured — the row must read as low-confidence. */
  entirelyAssumed: boolean;
  /** True when every measurable input was measured. */
  fullyMeasured: boolean;
};

type ResolveDb = Pick<PrismaClient, "evidenceRecord" | "crawl" | "auditPage">;

const MEASURABLE = ["rankDistance", "authorityGap", "pageStrength", "serpCompetition"] as const;

/**
 * Resolve the winnability inputs for one query from stored evidence.
 *
 * `rankDistance` is passed in, because the detector already computes it from the position
 * it detected the opportunity at — re-deriving it here would be a second opinion.
 *
 * Everything else is read from the store:
 *  - `serpCompetition` from `keyword_metrics.provider:difficulty` for this query,
 *  - `authorityGap` from the referring-domain sets CMP-007 wrote,
 *  - `pageStrength` from our crawled page against the highest-ranked competitor page
 *    CMP-006 profiled.
 *
 * Nothing here buys anything, and nothing invents a number: an absent fact returns null
 * and a line in `missing` saying which fact it was.
 */
export async function resolveWinProbability(
  db: ResolveDb,
  input: {
    projectId: string;
    /** The site whose crawl holds our page facts. */
    siteId?: string | null;
    query: string | null;
    /** From the detector; null when the query has no measured position. */
    rankDistance: number | null;
    /** When the position behind `rankDistance` was observed, so it carries a date. */
    rankObservedAt?: Date | null;
    playTypeFactor: number;
    /** The page this work targets, so pageStrength compares the right page. */
    targetUrl?: string | null;
    now?: Date;
  }
): Promise<ResolvedWinProbability> {
  const now = input.now ?? new Date();
  const source: WinProbabilityProvenance["source"] = {
    rankDistance: input.rankDistance == null ? "assumed" : "measured",
    authorityGap: "assumed",
    pageStrength: "assumed",
    serpCompetition: "assumed",
    playTypeFactor: "assumed",
  };
  const observedAt: WinProbabilityProvenance["observedAt"] = {};
  const missing: string[] = [];

  if (input.rankDistance == null) missing.push("rank distance: the query has no measured position");
  else if (input.rankObservedAt) observedAt.rankDistance = input.rankObservedAt;

  let serpCompetition: number | null = null;
  let authorityGap: number | null = null;
  let pageStrengthValue: number | null = null;

  if (input.query) {
    const query = foldQuery(input.query);
    const evidence = await db.evidenceRecord.findMany({
      where: {
        projectId: input.projectId,
        supersededById: null,
        // `competitor_rank` is here because it is the only measured answer to "who is in
        // the way" for a query we hold no difficulty for. Measured 2026-11-24 on
        // atelier-harmonie: 25 of the 27 queries with sampled SERPs had no
        // `provider:difficulty` above zero, so `serpCompetition` was `assumed` on nearly
        // every row while a paid SERP naming the competing domains sat unread.
        kind: { in: ["keyword_metrics", "backlink_profile", "onpage_crawl", "competitor_rank"] as never },
      },
      select: { kind: true, dimensions: true, metrics: true, observedAt: true },
    });

    // 1. Difficulty → serpCompetition. The newest stored difficulty for this query wins.
    let difficulty: { value: number; observedAt: Date } | null = null;
    for (const row of evidence) {
      if (row.kind !== "keyword_metrics") continue;
      const dims = (row.dimensions ?? {}) as { query?: string };
      if (typeof dims.query !== "string" || foldQuery(dims.query) !== query) continue;
      const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
      const value = metrics["provider:difficulty"]?.value ?? null;
      // A literal 0 is the provider's "no data", not "easy" — see the module note.
      if (value == null || value <= 0) continue;
      if (!difficulty || row.observedAt > difficulty.observedAt) difficulty = { value, observedAt: row.observedAt };
    }
    if (difficulty) {
      serpCompetition = difficultyToSerpCompetition(difficulty.value);
      if (serpCompetition != null) {
        source.serpCompetition = "measured";
        observedAt.serpCompetition = difficulty.observedAt;
      }
    }
    /**
     * 1b. Competitor strength from the sampled SERP, when the provider had nothing to say.
     *
     * Two facts are measured here and neither is a guess: how many distinct domains the
     * sample placed ahead of us, and how good their best position is. Thirty results
     * filled to the bottom is a harder SERP than one where five domains are the whole
     * answer, and a leader at #1 is a harder fight than a leader at #9.
     *
     * Deliberately not used when a real difficulty exists: the provider's number is a
     * market measurement, while this only reads the one page of results we bought.
     */
    if (serpCompetition == null) {
      const sampled = new Map<string, { position: number; observedAt: Date }>();
      for (const row of evidence) {
        if (row.kind !== "competitor_rank") continue;
        const dims = (row.dimensions ?? {}) as { query?: string; domain?: string; rankAbsolute?: number };
        if (typeof dims.query !== "string" || foldQuery(dims.query) !== query) continue;
        const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
        const position =
          typeof dims.rankAbsolute === "number" ? dims.rankAbsolute : metrics["provider:position"]?.value ?? null;
        if (typeof dims.domain !== "string" || position == null || position <= 0) continue;
        const held = sampled.get(dims.domain);
        // The newest sample of a domain wins; an older one is a stale position.
        if (!held || row.observedAt > held.observedAt) {
          sampled.set(dims.domain, { position, observedAt: row.observedAt });
        }
      }
      const derived = competitorToSerpCompetition([...sampled.values()]);
      if (derived != null) {
        serpCompetition = derived.value;
        source.serpCompetition = "measured";
        // The sample is when the comparison became true.
        observedAt.serpCompetition = derived.observedAt;
        missing.push(
          `SERP competition: no provider difficulty for this query, so it is read from ${sampled.size} sampled competitor domain${sampled.size === 1 ? "" : "s"} (best position ${derived.bestPosition})`
        );
      }
    }
    if (serpCompetition == null) missing.push("SERP competition: the query has no stored difficulty above zero");

    // 2. Our referring set against the strongest measured competitor's.
    let ourDomains: { count: number; observedAt: Date } | null = null;
    let bestCompetitor: { count: number; observedAt: Date } | null = null;
    for (const row of evidence) {
      if (row.kind !== "backlink_profile") continue;
      const dims = (row.dimensions ?? {}) as { scope?: string; domains?: unknown };
      const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
      const listed = Array.isArray(dims.domains)
        ? dims.domains.filter((value): value is string => typeof value === "string").length
        : null;
      const count =
        metrics["provider:referringDomains"]?.value ?? (listed != null ? listed : null);
      if (count == null) continue;
      if (dims.scope === "own_referring_domains" && (!ourDomains || row.observedAt > ourDomains.observedAt)) {
        ourDomains = { count, observedAt: row.observedAt };
      }
      if (dims.scope === "competitor_referring_domains" && (!bestCompetitor || count > bestCompetitor.count)) {
        bestCompetitor = { count, observedAt: row.observedAt };
      }
    }
    if (ourDomains && bestCompetitor) {
      authorityGap = authorityGapFromSets(ourDomains.count, bestCompetitor.count);
      if (authorityGap != null) {
        source.authorityGap = "measured";
        // The older of the two sets is when the comparison became true.
        observedAt.authorityGap =
          ourDomains.observedAt < bestCompetitor.observedAt ? ourDomains.observedAt : bestCompetitor.observedAt;
      }
    }
    if (authorityGap == null) missing.push("authority: no measured referring-domain set for us and a competitor");

    // 3. Our page against the strongest competitor page CMP-006 profiled for this query.
    //
    // Our own facts come from `AuditPage`, the crawl's own table, because that is where
    // `wordCount`, `hasSchema`, `internalLinks` and `responseTimeMs` actually live.
    // Measured 2026-11-24: the `onpage_crawl` evidence rows carry the URL and the issue
    // count but **not** these fields, so reading them there would have produced a null
    // page strength for every row and looked like "we did not measure it".
    const ours: PageFacts | null = input.targetUrl
      ? await readPageFacts(db, { siteId: input.siteId, url: input.targetUrl })
      : null;
    let theirs: PageFacts | null = null;
    let theirObservedAt: Date | null = null;
    for (const row of evidence) {
      if (row.kind !== "onpage_crawl") continue;
      const dims = (row.dimensions ?? {}) as {
        scope?: string;
        query?: string;
        wordCount?: number;
        schemaTypes?: unknown;
        internalLinks?: number;
      };
      if (dims.scope !== "competitor") continue;
      if (typeof dims.query !== "string" || foldQuery(dims.query) !== query) continue;
      const facts: PageFacts = {
        wordCount: typeof dims.wordCount === "number" ? dims.wordCount : null,
        hasSchema: Array.isArray(dims.schemaTypes) ? dims.schemaTypes.length > 0 : null,
        internalLinks: typeof dims.internalLinks === "number" ? dims.internalLinks : null,
        responseTimeMs: null,
      };
      // The strongest competitor is the one with the most words: the brief's own measure
      // of "what they have that we do not".
      if (!theirs || (facts.wordCount ?? 0) > (theirs.wordCount ?? 0)) {
        theirs = facts;
        theirObservedAt = row.observedAt;
      }
    }
    if (!input.targetUrl) missing.push("page strength: this opportunity names no target URL");
    pageStrengthValue = pageStrength(ours, theirs);
    if (pageStrengthValue != null) {
      source.pageStrength = "measured";
      if (theirObservedAt) observedAt.pageStrength = theirObservedAt;
    } else if (input.targetUrl) {
      missing.push(
        ours == null
          ? "page strength: our target page has not been crawled"
          : "page strength: no competitor page has been profiled for this query"
      );
    }
  } else {
    missing.push(
      "the opportunity names no query, so difficulty, authority and page strength cannot be looked up"
    );
  }

  const winProbability: WinProbabilityInputs = {
    rankDistance: input.rankDistance,
    authorityGap,
    pageStrength: pageStrengthValue,
    serpCompetition,
    playTypeFactor: input.playTypeFactor,
  };

  const measuredCount = MEASURABLE.filter((key) => winProbability[key] != null).length;
  return {
    winProbability,
    provenance: { source, observedAt, missing },
    entirelyAssumed: measuredCount === 0,
    fullyMeasured: measuredCount === MEASURABLE.length,
  };
}

/**
 * Our page's facts, from the crawl's own `AuditPage` row.
 *
 * The latest completed crawl only: a page's word count from three crawls ago is not a
 * statement about the page today. `null` when the URL is absent from that crawl, which is
 * the same condition the board audit already reports as "not in the latest crawl".
 */
async function readPageFacts(
  db: ResolveDb,
  input: { siteId?: string | null; url: string }
): Promise<PageFacts | null> {
  if (!input.siteId) return null;
  // A client without the crawl tables cannot measure a page. Reported as absent, so the
  // input stays null, rather than thrown and losing the whole run.
  if (typeof db.crawl?.findFirst !== "function" || typeof db.auditPage?.findMany !== "function") return null;
  const crawl = await db.crawl.findFirst({
    where: { siteId: input.siteId, status: "COMPLETED" },
    select: { id: true },
    orderBy: { startedAt: "desc" },
  });
  if (!crawl) return null;
  const pages = await db.auditPage.findMany({
    where: { crawlId: crawl.id },
    select: { url: true, wordCount: true, hasSchema: true, internalLinks: true, responseTimeMs: true },
  });
  const target = normaliseUrl(input.url);
  const page = pages.find((row) => normaliseUrl(row.url) === target);
  if (!page) return null;
  return {
    // A crawl writes `wordCount: 0` as its default for a page it could not read, so zero
    // is treated as absent rather than as a page with no words.
    wordCount: page.wordCount > 0 ? page.wordCount : null,
    hasSchema: page.hasSchema,
    internalLinks: page.internalLinks ?? null,
    responseTimeMs: page.responseTimeMs ?? null,
  };
}

/** Compare URLs without scheme, `www.`, trailing slash or a fragment. */
function normaliseUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[#?].*$/, "")
    .replace(/\/+$/, "");
}

/**
 * The priority ceiling for a row whose winnability is entirely assumed.
 *
 * A board where every row is `assumed` is honest and visibly low-confidence; a board where
 * every row says `0.5` is a lie with good spacing. Applying a ceiling rather than silently
 * dropping the row keeps the work visible while stopping an unmeasured guess from topping
 * the list.
 */
export const ASSUMED_WIN_PROBABILITY_CEILING = 40;

/** True when a score's provenance means it must not reach the top band. */
export function isLowConfidence(provenance: WinProbabilityProvenance | null | undefined): boolean {
  if (!provenance) return false;
  return MEASURABLE.every((key) => provenance.source[key] === "assumed");
}
