import { type DemandMapCluster, type EvidenceRecord, type EvidenceRecordKind, type OpportunityDimension, type OpportunityType, type PrismaClient } from "@prisma/client";

import type { OpportunityDb } from "@/lib/funnel/opportunity";
import { capabilitiesOwnedBy, ALL_CAPABILITIES } from "@/lib/funnel/capabilities";
import { compareRankWindows, latestWindowPerIdentity, partitionByWindowRole, rankOf } from "@/lib/funnel/evidence";
import { upsertOpportunity, applyHysteresis } from "@/lib/funnel/opportunity";
import type { ScoreInputs } from "@/lib/funnel/scoring";
import { ctrAtPosition, rankDistanceFactor, freshnessFactor } from "@/lib/funnel/scoring";
import { TARGET_POSITION } from "@/lib/funnel/impact";
import { clusterFindings } from "@/lib/research/finding-evidence";
import { clusterByQuery, queryFromDedupKey, resolveCluster } from "@/lib/funnel/cluster-resolver";
import { decisionFingerprint, parsePersistedDecision, type RecommendationDecision } from "@/lib/recommendation/contracts";
import { scoreInputsFromDecision } from "@/lib/recommendation/publish";
import { resolveWinProbability } from "@/lib/funnel/win-probability";
import { opportunityOrder } from "@/lib/funnel/opportunity-order";

/**
 * Automatic opportunity detectors (docs/seo-funnel-spine-plan.md §2/§3).
 * Every detector has a stated rule and a stated threshold; detection is
 * automatic, acceptance is human. Detectors read EvidenceRecord only — they
 * never see raw payloads, never make paid calls.
 */

export type DetectorCandidate = {
  type: OpportunityType;
  title: string;
  summary: string;
  dedupKey: string;
  clusterSlug?: string;
  /**
   * CMP-012: the page this work targets, when the candidate names one.
   *
   * Page strength compares our page against the strongest competitor page profiled for
   * the same query, so the resolver needs the URL. Candidates that do not name one get
   * `null` for page strength rather than a default.
   */
  targetUrl?: string | null;
  whyEvidenceIds: string[];
  howEvidenceIds: string[];
  scoreInputs: Omit<ScoreInputs, "evidenceCompleteness">;
  /** The canonical decision this candidate projects, when it has one. */
  recommendationDecision?: RecommendationDecision;
  recommendationVersion?: string;
  recommendationFingerprint?: string;
  recommendationEvidenceId?: string;
};

type Evidence = Pick<EvidenceRecord, "id" | "kind" | "observedAt" | "dimensions" | "metrics">;

/** Stated thresholds (config, not vibes). All counts are per project. */
export const DETECTOR_THRESHOLDS = {
  minVolume: 10,
  /**
   * A striking-distance opportunity needs enough impressions that a click is
   * worth winning. With only `impressions > 0` this fired on queries that got a
   * single impression and scored 0, adding rows nobody can act on.
   */
  minImpressions: 10,
  lowCtr: 0.02,
  minCompetitorSubtopics: 2,
  minReferringDomainGap: 3,
  maxLcpSeconds: 2.5,
  freshnessDecayDelta: 3,
  minClusterQueries: 3,
  maxClusterCoverage: 0.34,
  /** below this score a `detected` opportunity parks (hysteresis) */
  hysteresis: 3,
  /** open opportunities per project before overflow parks (plan §3) */
  openCap: 100,
  /**
   * Pages sharing one issue before it becomes a single site-level opportunity.
   * Three is the floor: one delivery closes all three, so separate rows would
   * ask the owner to decide the same fix three times.
   */
  siteLevelIssuePages: 3,
  /**
   * The other half of the grouping rule: a defect found on a quarter of the
   * crawled pages is systemic even when the site is too small to reach three
   * pages. Both conditions are per issue key, never across issues.
   */
  siteLevelIssueShare: 0.25,
  /** pages sharing one issue that make it systemic enough to act on */
  systemicIssuePages: 3,
  /**
   * Grouped volume is capped for scoring: worth is linear in volume, so summing
   * 120 pages of impressions pins any site-wide fix at the 0-100 ceiling and
   * erases the ranking it was meant to express. The raw demand stays in evidence.
   */
  maxGroupVolume: 300,
  /**
   * Declared worth of a page-level defect with no recorded traffic. Impressions
   * are the honest basis; this proxy keeps a no-traffic page from inheriting the
   * 120 searches/month query fallback (plan §2.3, §10).
   */
  technicalImpactVolume: 10,
  /**
   * Whether a *presentational* defect competes for a board slot at all.
   *
   * Two kinds of technical work are not the same thing and must not share a rule:
   *
   *  - **Crawlability defects** (`O7`: a broken link, a duplicate title, a missing
   *    canonical, a slow page) can be the reason a page has no demand yet. Requiring
   *    demand before admitting them is circular: the fix is the precondition for the
   *    impressions that would justify it. They always earn a slot.
   *  - **Presentational gaps** (`O8`: missing structured data) do not prevent a page
   *    from being found or from ranking. They earn a slot only when the pages they
   *    affect carry measured demand, or belong to a cluster being worked.
   *
   * Measured 2026-11-25: inmersionfreediving's "Missing structured data on 48 pages"
   * sat above the only content proposal while none of its 48 pages had measured
   * demand, and superincompetence's "on 2 pages" scored 21 for a site with three
   * queries. An SEO does not choose between a schema sweep and the article that
   * defines the offer; they add schema when it serves a page that earns.
   *
   * Set to `false` to put presentational gaps back on the board.
   */
  presentationalGapNeedsDemand: true,
} as const;

/**
 * Which evidence kinds a detector needs before it can say anything (plan §2.2).
 *
 * A detector whose kind is absent is **disabled**, not empty: an empty O3 board
 * must mean "no content gap", never "no SERP data". v1 shipped detectors before
 * their collection and read the emptiness as a detector failure.
 */
export const DETECTOR_REQUIRES: Record<OpportunityType, EvidenceRecordKind[]> = {
  O1_winnable_rank: ["keyword_rank"],
  O2_striking_distance: ["keyword_rank"],
  O3_content_gap: ["serp_snapshot"],
  O4_aeo_citation_gap: ["ai_visibility_observation"],
  O5_aeo_presence_gap: ["question_coverage"],
  O6_business_fact_mismatch: ["onpage_crawl", "knowledge_fact"],
  O7_technical_defect: ["onpage_crawl"],
  O8_structured_data_gap: ["onpage_crawl"],
  O9_backlink_gap: ["backlink_profile"],
  O10_cannibalization: ["keyword_rank"],
  O11_freshness_decay: ["keyword_rank"],
  O12_page_experience: ["vitals"],
  O13_user_pain_point: ["research_finding"],
  O14_offer_positioning_gap: ["research_finding"],
};

export type DisabledDetector = {
  type: OpportunityType;
  /** The kinds it needs and does not have. Empty when the kind exists but cannot be used. */
  missing: EvidenceRecordKind[];
  /**
   * Why it is disabled, in words, when the reason is not a missing kind.
   *
   * CMP-010: O11 needs two non-overlapping windows, and a project with one projected window
   * must say that rather than showing an empty board — "nothing declined" and "we cannot
   * tell" are different claims.
   */
  reason?: string;
};

/**
 * Business value from knowledge (plan §2.3), not a constant.
 *
 * 0.9 when knowledge names the offer/audience, 0.5 declared unknown when the
 * project has none. A detector that hardcodes 0.6 claims relevance it never
 * checked.
 */
export function businessValueFromKnowledge(evidence: Evidence[]): { value: number; source: "knowledge" | "unknown" } {
  return byKind(evidence, "knowledge_fact").length > 0
    ? { value: 0.9, source: "knowledge" }
    : { value: 0.5, source: "unknown" };
}

const RELEVANCE_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "our", "your", "you", "are",
  "les", "des", "une", "aux", "pour", "avec", "sans", "dans", "sur", "est", "sont",
  "de", "la", "le", "du", "en", "et", "un", "a", "of", "in", "to", "on",
]);

function tokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !RELEVANCE_STOPWORDS.has(token));
}

/** Every knowledge fact's text, used to test whether a query touches the offer. */
function knowledgeTokens(evidence: Evidence[]): Set<string> {
  const all = new Set<string>();
  for (const row of byKind(evidence, "knowledge_fact")) {
    const dimensions = (row.dimensions ?? {}) as Record<string, unknown>;
    for (const value of Object.values(dimensions)) {
      if (typeof value !== "string") continue;
      for (const token of tokens(value)) all.add(token);
    }
  }
  return all;
}

/**
 * Business relevance of a query, tested rather than assumed.
 *
 * `businessValueFromKnowledge` answered 0.9 for every query as soon as one
 * knowledge fact existed, so a rental query on a sales site scored like the site's
 * own service. A query that shares no word with the knowledge is `unknown`.
 */
export function businessValueForQuery(
  evidence: Evidence[],
  query: string
): { value: number; source: "knowledge" | "unknown" } {
  const facts = knowledgeTokens(evidence);
  if (facts.size === 0) return { value: 0.5, source: "unknown" };
  const shared = tokens(query).filter((token) => facts.has(token));
  return shared.length > 0 ? { value: 0.9, source: "knowledge" } : { value: 0.5, source: "unknown" };
}

/**
 * Near-identical tokens, enough to match a transliteration ("harmony" / "harmonie")
 * without pulling in a fuzzy-matching dependency. Longer tokens allow two edits,
 * short ones one, so "art" does not match "car".
 */
function nearToken(a: string, b: string): boolean {
  const maxEdits = Math.min(a.length, b.length) >= 6 ? 2 : 1;
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > maxEdits) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > maxEdits) return false;
    if (a.length - i > b.length - j) i += 1;
    else if (b.length - j > a.length - i) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= maxEdits;
}

/**
 * Whether a query is the site's own name.
 *
 * "atelier harmonie" at position 6 is not an opportunity: the site already ranks
 * for its brand, and improving a brand query is not the work the board is for.
 */
export function isBrandQuery(query: string, brandTerms: string[] | undefined): boolean {
  if (!brandTerms || brandTerms.length === 0) return false;
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return false;
  const brand = brandTerms.map((term) => term.toLowerCase());
  return queryTokens.every((token) => brand.some((term) => term === token || nearToken(token, term)));
}

/** Brand terms from a domain: "www.atelier-harmonie.com" -> atelier, harmonie. */
export function brandTermsFromDomain(domain: string): string[] {
  return domain
    .replace(/^www\./i, "")
    .split(".")[0]
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3)
    .map((token) => token.toLowerCase());
}

/**
 * First-party impressions recorded per URL: the demand a page-level defect risks.
 *
 * `gsc_page` is the complete page total; `keyword_rank` is query-level and Google
 * samples it (662 query rows carried 835 impressions where the same site's pages
 * carried 2,556). Page rows win; query rows are only a fallback for URLs the page
 * report does not cover.
 */
export function pageDemandByUrl(evidence: Evidence[]): Map<string, number> {
  const demand = new Map<string, number>();
  for (const row of byKind(evidence, "gsc_page")) {
    const url = dim(row, "url");
    if (!url) continue;
    const impressions = num(row, "first_party:impressions") ?? 0;
    if (impressions <= 0) continue;
    demand.set(url, Math.max(demand.get(url) ?? 0, impressions));
  }
  for (const row of byKind(evidence, "keyword_rank")) {
    const url = dim(row, "url");
    if (!url || demand.has(url)) continue;
    const impressions = num(row, "first_party:impressions") ?? 0;
    if (impressions <= 0) continue;
    demand.set(url, (demand.get(url) ?? 0) + impressions);
  }
  return demand;
}

type PageIssue = {
  candidate: DetectorCandidate;
  pageUrl: string;
  issueKey: string;
};

/**
 * Plan §3 grouping: one opportunity per page normally; when `minPages` pages
 * share the same issue, one site-level opportunity that a single delivery
 * closes. The pages stay in the evidence edges, so the detail page still lists
 * them.
 */
export function collapsePageIssues(
  issues: PageIssue[],
  opts: {
    minPages: number;
    /** Pages the latest crawl assessed; enables the share half of the rule. */
    totalPages?: number | null;
    /** Fraction of crawled pages that makes an issue systemic. */
    share?: number;
    siteTitle: (issueKey: string, count: number) => string;
  }
): DetectorCandidate[] {
  const groups = new Map<string, PageIssue[]>();
  for (const issue of issues) {
    groups.set(issue.issueKey, [...(groups.get(issue.issueKey) ?? []), issue]);
  }
  const share = opts.share ?? DETECTOR_THRESHOLDS.siteLevelIssueShare;
  const totalPages = typeof opts.totalPages === "number" && Number.isFinite(opts.totalPages) && opts.totalPages > 0
    ? opts.totalPages
    : null;
  const out: DetectorCandidate[] = [];
  for (const [issueKey, group] of groups) {
    const systemic = group.length >= opts.minPages
      || (totalPages !== null && group.length / totalPages >= share);
    if (!systemic) {
      for (const issue of group) out.push(issue.candidate);
      continue;
    }
    const first = group[0].candidate;
    const pages = group.map((issue) => issue.pageUrl);
    // Sum real demand across the pages; an impact proxy is a per-defect stand-in,
    // so multiplying it by 60 pages would turn "no traffic" into a top score.
    const realDemand = group.reduce(
      (sum, issue) =>
        sum + (issue.candidate.scoreInputs.worth.volumeSource === "first_party" ? issue.candidate.scoreInputs.worth.volume ?? 0 : 0),
      0
    );
    const volume = realDemand > 0
      ? Math.min(realDemand, DETECTOR_THRESHOLDS.maxGroupVolume)
      : DETECTOR_THRESHOLDS.technicalImpactVolume;
    out.push({
      ...first,
      title: opts.siteTitle(issueKey, group.length),
      summary: `${group.length} pages share this issue, so one delivery closes all of them: ${pages.slice(0, 3).join(", ")}${pages.length > 3 ? "…" : ""}.`,
      dedupKey: `${first.type}:site:${issueKey}`,
      howEvidenceIds: [...new Set(group.flatMap((issue) => issue.candidate.howEvidenceIds))].slice(0, 50),
      scoreInputs: {
        ...first.scoreInputs,
        worth: {
          ...first.scoreInputs.worth,
          volume,
          volumeSource: realDemand > 0 ? "first_party" : "impact_proxy",
        },
      },
    });
  }
  return out;
}

/**
 * Read a metric regardless of who produced it. The same semantic metric can be
 * recorded as provider-sourced (DataForSEO) or first-party (our crawler, GSC);
 * a detector must not silently miss evidence because of the namespace.
 */
function num(evidence: Evidence, key: string): number | null {
  const metrics = (evidence.metrics ?? {}) as { [k: string]: { value: number | null } };
  const bare = key.includes(":") ? key.split(":").slice(1).join(":") : key;
  const direct = metrics[key]?.value;
  if (typeof direct === "number") return direct;
  for (const [label, metric] of Object.entries(metrics)) {
    const labelBare = label.includes(":") ? label.split(":").slice(1).join(":") : label;
    if (labelBare === bare && typeof metric?.value === "number") return metric.value;
  }
  return null;
}

/** MISSING_CANONICAL -> "Missing canonical". Titles read as sentences. */
function humanizeIssue(type: string | undefined): string {
  if (!type) return "issue";
  const words = type.replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function dimNum(evidence: Evidence, key: string): number | null {
  const value = (evidence.dimensions as Record<string, unknown>)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dim(evidence: Evidence, key: string): string | undefined {
  const value = (evidence.dimensions as Record<string, unknown>)?.[key];
  return typeof value === "string" ? value : undefined;
}

type PartialScoreInputs = {
  worth?: Partial<ScoreInputs["worth"]>;
  winProbability?: Partial<ScoreInputs["winProbability"]>;
  effort?: Partial<ScoreInputs["effort"]>;
  freshness?: number;
  stability?: number;
};

function scoreDefaults(over: PartialScoreInputs): Omit<ScoreInputs, "evidenceCompleteness"> {
  return {
    worth: { volume: null, ctrAtPosition: null, businessValue: 0.5, ...(over.worth ?? {}) },
    winProbability: {
      // CMP-012: every one of these is `null` until something measured it. The
      // resolver in `lib/funnel/win-probability.ts` fills them from stored evidence at
      // the place candidates become rows, so a literal here would be overwritten anyway —
      // but keeping it null is what makes that contract visible. Measured 2026-11-24:
      // `pageStrength` and `serpCompetition` were the literal 0.5 on all 145 live rows.
      rankDistance: null,
      authorityGap: null,
      pageStrength: null,
      serpCompetition: null,
      // The one permitted constant: a declared property of the play, not a measurement.
      playTypeFactor: 0.6,
      ...(over.winProbability ?? {}),
    },
    effort: { playTypeBase: 6, sizeFactor: 1, ...(over.effort ?? {}) },
    freshness: over.freshness ?? 1,
    stability: over.stability ?? 0.8,
  };
}

type Detector = {
  type: OpportunityType;
  detect: (evidence: Evidence[], ctx: DetectContext) => DetectorCandidate[];
};

type DetectContext = {
  now: Date;
  /** The site's own name, so a brand query is not offered as a win. */
  brandTerms?: string[];
  /**
   * The previous window's rank observations. Decline is only meaningful against a
   * comparable window; comparing daily rows treated normal oscillation as a trend.
   */
  previousRank?: Evidence[];
  /**
   * Pages the latest completed crawl assessed. Grouping uses the share of
   * crawled pages, not a hard page count alone, so a small site's systemic
   * defect is not split into one row per page.
   */
  crawledPages?: number;
  /** CMP-010: days the two compared rank windows share, so O11 can state it. */
  comparisonOverlapDays?: number | null;
};

/**
 * CMP-012: the page a candidate is about, taken from the evidence it cites.
 *
 * This is reading a stored fact back, not inferring one: the crawl and the rank rows both
 * carry the `url` they observed. Order is preserved so the first cited row wins, which is
 * the one the detector treated as primary.
 */
function urlFromEvidence(evidence: Evidence[], ids: string[]): string | null {
  for (const id of ids) {
    const row = evidence.find((entry) => entry.id === id);
    if (!row) continue;
    const dims = (row.dimensions ?? {}) as { url?: unknown; scope?: unknown };
    if (dims.scope === "competitor") continue;
    if (typeof dims.url === "string" && dims.url.trim() !== "") return dims.url;
  }
  return null;
}

function byKind(evidence: Evidence[], kind: string): Evidence[] {
  return evidence.filter((row) => row.kind === kind);
}

/**
 * Keep only the current performance window.
 *
 * Every monthly projection writes a new `keyword_rank` observation per
 * query/page, so a project accumulates one set per month. Detecting over all of
 * them would count the same query once per month and let a superseded ranking
 * compete with today's. Rows written before windows existed are kept when no
 * window is present, so an un-migrated project still analyses.
 */
function latestValue(evidence: Evidence[], kind: string, key: string): string | null {
  const values = byKind(evidence, kind)
    .map((row) => dim(row, key))
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort();
  return values.length > 0 ? values[values.length - 1] : null;
}

/**
 * Keep only the current observation set for kinds that accumulate by run.
 *
 * The decision itself lives in `currentEvidence` now (CMP-011). This wrapper keeps
 * the detectors working on an already-loaded list, and it must not grow a second
 * opinion about "current": that is how CMP-010 happened.
 *
 * Two kinds accumulate by run: `keyword_rank` (one projection per month) and
 * `onpage_crawl` (one set of issues per crawl). Re-detecting over every historical
 * run counted a query once per month and kept defects a later crawl had fixed.
 */
export function selectCurrentEvidence(evidence: Evidence[]): Evidence[] {
  /**
   * Rank rows: the newest observation per (query, url), not one aligned window.
   *
   * This used `partitionByWindowRole`, which narrows to a single `windowEnd` because O11 needs
   * two aligned windows to diff. That is the wrong question for every other detector: Search
   * Console projects different queries on different days, so "the newest window" is a subset of
   * the queries rather than the current state of all of them.
   *
   * Measured 2026-11-25 on casamigo: 9 distinct queries carried a `current` role across 5
   * `windowEnd`s, the newest held 4 rows, and **no query had two competing URLs** — so
   * cannibalisation could not fire on real data at all, while its detector and its tests both
   * passed.
   *
   * O11 still gets its aligned pair through `rankWindowComparison`, which is called separately
   * with the unfiltered evidence. The two rules stay separate because they answer different
   * questions, and conflating them is what starved the other detectors.
   */
  const rankRows = latestWindowPerIdentity(evidence.filter((row) => row.kind === "keyword_rank") as never);
  const currentRankIds = new Set(rankRows.map((row) => (row as { id: string }).id));
  const crawl = latestValue(evidence, "onpage_crawl", "crawlId");
  return evidence.filter((row) => {
    if (row.kind === "keyword_rank") return currentRankIds.has(row.id);
    if (row.kind === "onpage_crawl" && crawl) return dim(row, "crawlId") === crawl;
    return true;
  });
}

/**
 * The comparison window's rank rows.
 *
 * CMP-010: this used to take the second-newest `windowEnd`, which for a daily
 * rolling 28-day sync is yesterday's *current* window — the two spans shared 27 of
 * 28 days, so 51 % of pairs differed by exactly 0 and O11 fired once. It now reads
 * the window a writer labelled `previous`, through the same rule as
 * `currentEvidence`.
 */
export function previousWindowEvidence(evidence: Evidence[]): Evidence[] {
  const { previous } = partitionByWindowRole(evidence.filter((row) => row.kind === "keyword_rank") as never);
  return previous as never;
}

/**
 * CMP-010: the rank-window pair O11 is allowed to compare, with the reason when it is not.
 *
 * Kept next to the selector so a caller cannot take the rows without the explanation: the
 * old signature returned `[]` for both "no history yet" and "the windows overlap", and a
 * detector that returns nothing looks identical to a site with no declines.
 */
export function rankWindowComparison(evidence: Evidence[]) {
  return compareRankWindows(evidence.filter((row) => row.kind === "keyword_rank") as never);
}

/** @deprecated use selectCurrentEvidence; kept for callers that only rank evidence. */
export const selectCurrentPerformanceWindow = selectCurrentEvidence;

/**
 * One crawl row per (url, issue, schema): repeated crawls otherwise stack and
 * a 60-page site reports "missing schema on 120 pages".
 */
function latestCrawlRows(evidence: Evidence[]): Evidence[] {
  const latest = new Map<string, Evidence>();
  for (const row of byKind(evidence, "onpage_crawl")) {
    const key = `${dim(row, "url") ?? ""}|${dim(row, "issueType") ?? ""}|${dim(row, "schemaType") ?? ""}`;
    const previous = latest.get(key);
    if (!previous || row.observedAt > previous.observedAt) latest.set(key, row);
  }
  return [...latest.values()];
}

function group<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    map.set(k, [...(map.get(k) ?? []), row]);
  }
  return map;
}

const byQuery = (row: Evidence) => `${dim(row, "query") ?? ""}`;
const byQuestion = (row: Evidence) => `${dim(row, "question") ?? ""}`;

/**
 * Project the canonical decision; do not decide again here.
 *
 * A legacy finding without a decision stays visible as explicitly unassessed
 * backlog. It is never made actionable from its prose or from a knowledge record.
 */
function canonicalDecisionCandidates(evidence: Evidence[], type: "O13_user_pain_point" | "O14_offer_positioning_gap"): DetectorCandidate[] {
  const rows = byKind(evidence, "research_finding").filter((row) =>
    type === "O13_user_pain_point" ? dim(row, "painPoint") === "true" : dim(row, "positioningGap") === "true"
  );
  const candidates: DetectorCandidate[] = [];
  for (const row of rows) {
    const decision = parsePersistedDecision(dim(row, "recommendationDecisionJson"));
    if (!decision) {
      // A legacy lexical verdict is diagnostic. It must not suppress canonical
      // assessment; the row stays visible as explicitly unassessed backlog.
      const theme = dim(row, "theme") ?? dim(row, "title") ?? "Unassessed research finding";
      candidates.push({
        type,
        title: theme,
        summary: "This finding predates the canonical assessment. It is not actionable until it is reassessed against the business and its pages.",
        dedupKey: `${type === "O13_user_pain_point" ? "O13" : "O14"}:legacy:${row.id}`,
        whyEvidenceIds: [row.id],
        howEvidenceIds: [],
        scoreInputs: scoreDefaults({
          worth: {
            volume: null,
            ctrAtPosition: null,
            businessValue: 0.5,
            businessValueSource: "unknown",
            readiness: "research_backlog",
            measurement: "unquantified",
            intervention: "investigate",
            targetPages: [],
            coverageSummary: "not assessed",
          },
          winProbability: { playTypeFactor: 0.5 },
          effort: { playTypeBase: 10, sizeFactor: 1 },
          freshness: freshnessFactor(row.observedAt, new Date()),
        }),
      });
      continue;
    }
    if (decision.readiness === "rejected" || decision.readiness === "no_action") continue;
    candidates.push({
      type,
      title: decision.question.text,
      summary: decision.question.rationale,
      dedupKey: decision.dedupKey,
      whyEvidenceIds: [row.id],
      howEvidenceIds: [],
      scoreInputs: scoreInputsFromDecision(decision) as Omit<ScoreInputs, "evidenceCompleteness">,
      recommendationDecision: decision,
      recommendationVersion: decision.schemaVersion,
      recommendationFingerprint: decisionFingerprint({
        packetHash: decision.packetHash,
        policyVersion: decision.policyVersion,
        promptVersion: decision.promptVersion,
        model: decision.model,
      }),
      recommendationEvidenceId: row.id,
    });
  }
  return candidates;
}

const DETECTORS: Detector[] = [
  {
    type: "O1_winnable_rank",
    detect: (evidence, ctx) => {
      // Volume arrives as its own evidence kind from the provider (Wave 0.5), not
      // on the rank row. A rank without any demand evidence is a position, not an
      // opportunity — but demand can be first-party: a site whose Search Console
      // shows impressions has measured demand even when nobody bought keyword
      // volume, and refusing to analyse it left connected sites with no
      // query-level opportunities at all.
      const volumeByQuery = new Map<string, number>();
      for (const row of byKind(evidence, "keyword_metrics")) {
        const query = dim(row, "query");
        const volume = num(row, "provider:volume");
        if (query && volume != null) volumeByQuery.set(query, volume);
      }
      const candidates: DetectorCandidate[] = [];
      for (const row of byKind(evidence, "keyword_rank")) {
        const position = rankOf(row.metrics);
        if (position == null || position < 4 || position > 10) continue;
        const query = byQuery(row);
        if (isBrandQuery(query, ctx.brandTerms)) continue;
        const providerVolume = num(row, "provider:volume") ?? volumeByQuery.get(query) ?? null;
        const impressions = num(row, "first_party:impressions") ?? 0;
        const clicks = num(row, "first_party:clicks") ?? 0;
        const measuredVolume = providerVolume != null && providerVolume >= DETECTOR_THRESHOLDS.minVolume;
        const measuredImpressions = impressions >= DETECTOR_THRESHOLDS.minImpressions;
        if (!measuredVolume && !measuredImpressions) continue;

        const knowledge = businessValueForQuery(evidence, query);
        const windowDays = dimNum(row, "windowDays");
        const volume = measuredVolume ? (providerVolume as number) : impressions;
        const observedCtr = num(row, "first_party:ctr");
        const ctr = observedCtr != null && impressions > 0 ? observedCtr : ctrAtPosition(position);
        candidates.push({
          type: "O1_winnable_rank" as const,
          title: `Winnable rank: "${query}" at position ${Math.round(position)}`,
          summary: measuredVolume
            ? `Our page ranks ${Math.round(position)} for a keyword with ${Math.round(volume)} searches/month — a few ranks to win.`
            : `Our page ranks ${Math.round(position)} for "${query}" over the last ${windowDays ?? 28} days (${Math.round(impressions)} impressions, ${Math.round(clicks)} clicks) — a few ranks to win.`,
          dedupKey: `O1:${query}:${dim(row, "url") ?? ""}`,
          clusterSlug: dim(row, "cluster"),
          whyEvidenceIds: [],
          howEvidenceIds: [row.id],
          scoreInputs: scoreDefaults({
            worth: {
              volume,
              ctrAtPosition: ctr,
              businessValue: knowledge.value,
              volumeSource: measuredVolume ? "provider" : "first_party",
              businessValueSource: knowledge.source,
              currentPosition: position,
              targetPosition: 3,
              windowDays: windowDays ?? null,
              observedCtr: observedCtr ?? null,
              observedImpressions: impressions,
            },
            winProbability: { rankDistance: rankDistanceFactor(position) },
            effort: { playTypeBase: 6, sizeFactor: 1 },
            freshness: freshnessFactor(row.observedAt, new Date()),
          }),
        });
      }
      return candidates;
    },
  },
  {
    type: "O2_striking_distance",
    // Two different plays shared one detector: a page ranking 11–20 that earns
    // impressions but no clicks, and a page already in the top ten whose snippet
    // still earns almost nothing. The second is the commoner one — 49 impressions
    // at position 5.6 with a 0% CTR is a title problem, not a ranking problem —
    // and it used to be invisible because the band started at 11.
    detect: (evidence, ctx) => {
      // CMP-005: both rank detectors must read demand the same way. O1 has always
      // looked up the bought volume for a query; O2 did not, so the same query
      // scored differently depending on which detector happened to fire.
      const volumeByQuery = new Map<string, number>();
      for (const row of byKind(evidence, "keyword_metrics")) {
        const query = dim(row, "query");
        const volume = num(row, "provider:volume");
        if (query && volume != null) volumeByQuery.set(query, volume);
      }
      return byKind(evidence, "keyword_rank")
        .filter((row) => {
          if (isBrandQuery(byQuery(row), ctx.brandTerms)) return false;
          const position = rankOf(row.metrics);
          const ctr = num(row, "first_party:ctr");
          const impressions = num(row, "first_party:impressions") ?? 0;
          if (position == null || ctr == null) return false;
          if (impressions < DETECTOR_THRESHOLDS.minImpressions) return false;
          const curve = ctrAtPosition(position);
          const striking = position > 10 && position <= 20 && ctr <= DETECTOR_THRESHOLDS.lowCtr;
          const snippet = position <= 10 && curve != null && ctr < curve * 0.5;
          return striking || snippet;
        })
        .map((row) => {
          const position = rankOf(row.metrics)!;
          const impressions = num(row, "first_party:impressions") ?? 0;
          const clicks = num(row, "first_party:clicks") ?? 0;
          const ctr = num(row, "first_party:ctr") ?? 0;
          const snippet = position <= 10;
          // CMP-005: a striking-distance row is a *ranking* play, so its target is
          // the position the play is expected to reach — not the position it is
          // currently at. Passing `position` here made the incremental upside the
          // CTR gap between the current position and itself, which understated 57
          // live rows by a median 2.7×. The snippet play below keeps `position`,
          // because a snippet rewrite is not expected to change the rank.
          const targetPosition = snippet ? position : TARGET_POSITION.O2_striking_distance;
          // CMP-005: read the measured demand the same way O1 does. This branch used
          // to pass first-party impressions as if they were a search volume and
          // never looked at a bought volume at all, so the two detectors disagreed
          // about the same query.
          const query = byQuery(row);
          const providerVolume = num(row, "provider:volume") ?? volumeByQuery.get(query) ?? null;
          const measuredVolume = providerVolume != null && providerVolume >= DETECTOR_THRESHOLDS.minVolume;
          const knowledge = businessValueForQuery(evidence, query);
          return {
            type: "O2_striking_distance" as const,
            title: snippet
              ? `Snippet not earning the click: "${query}" at position ${Math.round(position)}`
              : `Striking distance: "${query}" gets impressions, no clicks`,
            summary: snippet
              ? `Position ${Math.round(position)} with ${Math.round(impressions)} impressions but ${Math.round(clicks)} clicks (${(ctr * 100).toFixed(1)}%). The rank is there and the snippet is not earning the click; the cause may be the title, the description, or a SERP feature taking the click.`
              : `Position ${Math.round(position)} with ${Math.round(impressions)} impressions and low CTR — the title/meta is not earning the click.`,
            dedupKey: `O2:${query}:${dim(row, "url") ?? ""}`,
            clusterSlug: dim(row, "cluster"),
            whyEvidenceIds: [],
            howEvidenceIds: [row.id],
            scoreInputs: scoreDefaults({
              worth: {
                // A measured search volume is the market size; impressions are only
                // the reachable slice of it. Prefer the volume when it exists.
                volume: measuredVolume ? (providerVolume as number) : impressions,
                ctrAtPosition: ctr,
                businessValue: knowledge.value,
                businessValueSource: knowledge.source,
                volumeSource: measuredVolume ? "provider" : "first_party",
                currentPosition: position,
                targetPosition,
                windowDays: dimNum(row, "windowDays"),
                observedCtr: ctr,
                observedImpressions: impressions,
              },
              winProbability: { rankDistance: rankDistanceFactor(position), playTypeFactor: 0.8 },
              effort: { playTypeBase: 2, sizeFactor: 1 },
              freshness: freshnessFactor(row.observedAt, new Date()),
            }),
          };
        });
    },
  },
  {
    type: "O3_content_gap",
    detect: (evidence) => {
      const ourRanks = new Set(byKind(evidence, "keyword_rank").map(byQuery));
      return byKind(evidence, "serp_snapshot")
        .filter((row) => {
          const covered = dim(row, "competitorCovered");
          return covered === "true" && !ourRanks.has(byQuery(row));
        })
        .map((row) => ({
          type: "O3_content_gap" as const,
          title: `Content gap: competitors answer "${dim(row, "query")}", we do not rank`,
          summary: `SERP analysis shows competing URLs covering this subtopic; we have no ranking page for it.`,
          dedupKey: `O3:${dim(row, "query")}`,
          clusterSlug: dim(row, "cluster"),
          whyEvidenceIds: [],
          howEvidenceIds: [row.id],
          scoreInputs: scoreDefaults({
            worth: { volume: num(row, "provider:volume") ?? 0, ctrAtPosition: ctrAtPosition(5), businessValue: 0.6 },
            winProbability: { rankDistance: rankDistanceFactor(11), serpCompetition: 0.4 },
            effort: { playTypeBase: 16, sizeFactor: 1 },
            freshness: freshnessFactor(row.observedAt, new Date()),
          }),
        }));
    },
  },
  {
    type: "O4_aeo_citation_gap",
    detect: (evidence) => {
      const knowledgeByQuestion = group(
        byKind(evidence, "knowledge_fact").filter((row) => byQuestion(row) !== ""),
        byQuestion
      );
      // A question's worth is its search demand where we have it; the sample count
      // is only a fallback, because one AI answer is not demand.
      const volumeByQuery = new Map<string, number>();
      for (const row of byKind(evidence, "keyword_metrics")) {
        const query = dim(row, "query");
        const volume = num(row, "provider:volume");
        if (query && volume != null) volumeByQuery.set(query, volume);
      }
      return byKind(evidence, "ai_visibility_observation")
        .filter((row) => {
          const cited = num(row, "provider:citedCount") ?? 0;
          const competitorCited = num(row, "provider:competitorCitedCount") ?? 0;
          return cited === 0 && competitorCited > 0;
        })
        .map((row) => {
          const question = byQuestion(row);
          const why = knowledgeByQuestion.get(question)?.map((r) => r.id) ?? [];
          return {
            type: "O4_aeo_citation_gap" as const,
            title: `AEO citation gap: "${question}"`,
            summary: `The question was asked, a competitor was cited, we were not — and our knowledge has an answer.`,
            dedupKey: `O4:${question}`,
            clusterSlug: dim(row, "cluster"),
            whyEvidenceIds: why,
            howEvidenceIds: [row.id],
            scoreInputs: scoreDefaults({
              worth: {
              volume: volumeByQuery.get(question) ?? num(row, "provider:askCount") ?? num(row, "provider:samples") ?? 0,
              ctrAtPosition: null,
              businessValue: 0.8,
            },
              winProbability: { playTypeFactor: 0.7 },
              effort: { playTypeBase: 8, sizeFactor: 1 },
              freshness: freshnessFactor(row.observedAt, new Date()),
            }),
          };
        });
    },
  },
  {
    type: "O5_aeo_presence_gap",
    detect: (evidence) =>
      byKind(evidence, "question_coverage")
        .filter((row) => dim(row, "observed") === "false")
        .map((row) => {
          const question = byQuestion(row);
          const why = byKind(evidence, "knowledge_fact").filter((k) => byQuestion(k) === question).map((k) => k.id);
          return {
            type: "O5_aeo_presence_gap" as const,
            title: `AEO presence gap: "${question}" has never been observed`,
            summary: `The question is in the set from business knowledge but no AI surface has ever been asked — subscribe it to evaluation.`,
            dedupKey: `O5:${question}`,
            clusterSlug: dim(row, "cluster"),
            whyEvidenceIds: why,
            howEvidenceIds: [row.id],
            scoreInputs: scoreDefaults({
              // The question was generated from business knowledge, not searched.
              worth: { volume: null, ctrAtPosition: null, businessValue: 0.5, unmeasured: true },
              winProbability: { playTypeFactor: 0.5 },
              effort: { playTypeBase: 1, sizeFactor: 1 },
              freshness: freshnessFactor(row.observedAt, new Date()),
            }),
          };
        }),
  },
  {
    type: "O6_business_fact_mismatch",
    detect: (evidence) => {
      const knowledgeByQuestion = group(
        byKind(evidence, "knowledge_fact").filter((row) => byQuestion(row) !== ""),
        byQuestion
      );
      return byKind(evidence, "onpage_crawl")
        .filter((row) => dim(row, "factMismatch") === "true")
        .map((row) => {
          const question = dim(row, "question") ?? "";
          const why = knowledgeByQuestion.get(question)?.map((r) => r.id) ?? [];
          return {
            type: "O6_business_fact_mismatch" as const,
            title: `Fact mismatch on ${dim(row, "url") ?? "page"}`,
            summary: `Crawl content contradicts canonical business knowledge (${dim(row, "field") ?? "field"}).`,
            dedupKey: `O6:${dim(row, "url")}:${dim(row, "field") ?? ""}`,
            clusterSlug: dim(row, "cluster"),
            whyEvidenceIds: why,
            howEvidenceIds: [row.id],
            scoreInputs: scoreDefaults({
              worth: { volume: null, ctrAtPosition: null, businessValue: 0.9 },
              winProbability: { playTypeFactor: 1.0 },
              effort: { playTypeBase: 1, sizeFactor: 1 },
              freshness: freshnessFactor(row.observedAt, new Date()),
            }),
          };
        });
    },
  },
  {
    type: "O7_technical_defect",
    detect: (evidence, ctx) => {
      const demand = pageDemandByUrl(evidence);
      const crawlable = latestCrawlRows(evidence).filter(
        (row) => (num(row, "first_party:issueCount") ?? 0) > 0 && dim(row, "impact") === "crawlability"
      );
      // Plan §3: a defect with no traffic is only worth acting on when the same
      // issue is systemic (>= 3 pages), otherwise it is noise on a dead page.
      const issueCounts = new Map<string, number>();
      for (const row of crawlable) {
        const key = dim(row, "issueType") ?? "issue";
        issueCounts.set(key, (issueCounts.get(key) ?? 0) + 1);
      }
      const issues: PageIssue[] = [];
      for (const row of crawlable) {
        const url = dim(row, "url") ?? "site";
        const issueType = dim(row, "issueType") ?? "issue";
        const pageImpressions = demand.get(url) ?? 0;
        if (pageImpressions === 0 && (issueCounts.get(issueType) ?? 0) < DETECTOR_THRESHOLDS.systemicIssuePages) continue;
        issues.push({
          pageUrl: url,
          issueKey: issueType,
          candidate: {
            type: "O7_technical_defect" as const,
            title: `${humanizeIssue(issueType)} on ${url}`,
            summary: `Crawl found ${plural(num(row, "first_party:issueCount") ?? 0, "issue", "issues")} with crawlability or user impact on this page.`,
            dedupKey: `O7:${url}:${issueType}`,
            clusterSlug: dim(row, "cluster"),
            whyEvidenceIds: [],
            howEvidenceIds: [row.id],
            scoreInputs: scoreDefaults({
              worth: {
                volume: pageImpressions > 0 ? pageImpressions : DETECTOR_THRESHOLDS.technicalImpactVolume,
                ctrAtPosition: null,
                businessValue: businessValueFromKnowledge(evidence).value,
                volumeSource: pageImpressions > 0 ? "first_party" : "impact_proxy",
                technical: true,
                severity: dim(row, "severity") === "CRITICAL" ? 1 : dim(row, "severity") === "WARNING" ? 0.6 : 0.3,
                readiness: "actionable",
                measurement: "unquantified",
                benefitTrack: "technical_health",
                intervention: "technical_fix",
              },
              winProbability: { playTypeFactor: 0.9 },
              effort: { playTypeBase: 3, sizeFactor: 1 },
              freshness: freshnessFactor(row.observedAt, new Date()),
            }),
          },
        });
      }
      return collapsePageIssues(issues, {
        minPages: DETECTOR_THRESHOLDS.siteLevelIssuePages,
        totalPages: ctx.crawledPages,
        share: DETECTOR_THRESHOLDS.siteLevelIssueShare,
        siteTitle: (issueKey, count) => `${humanizeIssue(issueKey)} on ${count} pages`,
      });
    },
  },
  {
    type: "O8_structured_data_gap",
    detect: (evidence, ctx) => {
      const knowledge = byKind(evidence, "knowledge_fact");
      const demand = pageDemandByUrl(evidence);
      const issues: PageIssue[] = latestCrawlRows(evidence)
        .filter((row) => dim(row, "schemaMissing") === "true" && dim(row, "impact") === "structured_data")
        .map((row) => {
          const url = dim(row, "url") ?? "page";
          const schemaType = dim(row, "schemaType") ?? "identity";
          const pageImpressions = demand.get(url) ?? 0;
          return {
            pageUrl: url,
            issueKey: schemaType,
            candidate: {
              type: "O8_structured_data_gap" as const,
              title: `Missing structured data on ${url}`,
              summary: `No ${schemaType} schema on this page, so answer engines and rich results cannot read who the business is.`,
              dedupKey: `O8:${url}:${schemaType}`,
              clusterSlug: dim(row, "cluster"),
              whyEvidenceIds: knowledge.slice(0, 1).map((k) => k.id),
              howEvidenceIds: [row.id],
              scoreInputs: scoreDefaults({
                worth: {
                  volume: pageImpressions > 0 ? pageImpressions : DETECTOR_THRESHOLDS.technicalImpactVolume,
                  ctrAtPosition: null,
                  businessValue: businessValueFromKnowledge(evidence).value,
                  volumeSource: pageImpressions > 0 ? "first_party" : "impact_proxy",
                  technical: true,
                  severity: dim(row, "severity") === "CRITICAL" ? 1 : dim(row, "severity") === "WARNING" ? 0.6 : 0.3,
                  readiness: "actionable",
                  measurement: "unquantified",
                  benefitTrack: "technical_health",
                  intervention: "technical_fix",
                },
                winProbability: { playTypeFactor: 1.0 },
                effort: { playTypeBase: 2, sizeFactor: 1 },
                freshness: freshnessFactor(row.observedAt, new Date()),
              }),
            },
          };
        });
      return collapsePageIssues(issues, {
        minPages: DETECTOR_THRESHOLDS.siteLevelIssuePages,
        totalPages: ctx.crawledPages,
        share: DETECTOR_THRESHOLDS.siteLevelIssueShare,
        siteTitle: (_issueKey, count) => `Missing structured data on ${count} pages`,
      });
    },
  },
  {
    type: "O9_backlink_gap",
    // CMP-007: O9 fires on a measured set difference, and its summary names the
    // domains. "Competitors have more links" is not a brief; a list of domains that
    // link to the page above us and not to us is one a person can act on.
    detect: (evidence) =>
      byKind(evidence, "backlink_profile")
        .filter((row) => {
          // A referring *set* is one side of the subtraction, so it never carries a
          // gap of its own. Excluding it is what stops O9 reporting a competitor's
          // link strength as our opportunity. Any row that does measure the gap is
          // read, whatever scope it declares, so a legacy profile is not silenced.
          const scope = dim(row, "scope") ?? "";
          if (scope === "competitor_referring_domains" || scope === "own_referring_domains") return false;
          return (num(row, "provider:referringDomainGap") ?? 0) >= DETECTOR_THRESHOLDS.minReferringDomainGap;
        })
        .map((row) => {
          const gap = Math.round(num(row, "provider:referringDomainGap") ?? 0);
          const targets = Array.isArray((row.dimensions as { domains?: unknown })?.domains)
            ? ((row.dimensions as { domains: unknown[] }).domains.filter(
                (value): value is string => typeof value === "string"
              ))
            : [];
          const ranks = Array.isArray((row.dimensions as { domainRanks?: unknown })?.domainRanks)
            ? ((row.dimensions as { domainRanks: unknown[] }).domainRanks.filter(
                (value): value is number => typeof value === "number"
              ))
            : [];
          const named = targets.slice(0, 3);
          const rankOf = (domain: string): number | null => {
            const index = targets.indexOf(domain);
            const rank = index >= 0 ? ranks[index] : null;
            return typeof rank === "number" && rank > 0 ? rank : null;
          };
          const withRank = named.map((domain) => {
            const rank = rankOf(domain);
            return rank != null ? `${domain} (authority ${rank})` : domain;
          });
          const suffix = targets.length > named.length ? `, and ${targets.length - named.length} more` : "";
          // The competitor profiles the subtraction read, so the how leg cites both
          // sides: this opportunity is not just "our profile says there is a gap".
          const competitorEvidenceIds = Array.isArray(
            (row.dimensions as { competitorEvidenceIds?: unknown })?.competitorEvidenceIds
          )
            ? ((row.dimensions as { competitorEvidenceIds: unknown[] }).competitorEvidenceIds.filter(
                (value): value is string => typeof value === "string"
              ))
            : [];
          return {
            type: "O9_backlink_gap" as const,
            title:
              named.length > 0
                ? `Link gap: ${gap} domains link to the pages above us, not to us`
                : `Authority gap vs ${dim(row, "competitor") ?? "competitors"}`,
            summary:
              named.length > 0
                ? `${gap} domains link to the pages ranking above us without linking to us: ${withRank.join(", ")}${suffix}. The target list is on this opportunity.`
                : `${gap} domains link to competitors but not to us.`,
            dedupKey: `O9:${dim(row, "competitor") ?? dim(row, "domain") ?? ""}`,
            clusterSlug: dim(row, "cluster"),
            whyEvidenceIds: [],
            howEvidenceIds: [row.id, ...competitorEvidenceIds],
            scoreInputs: scoreDefaults({
              worth: { volume: null, ctrAtPosition: null, businessValue: 0.4 },
              // A measured gap is a real path to authority, so the win probability is
              // no longer the flat 0.3 the old detector guessed: the more targets
              // there are, the more of them a campaign can reach.
              winProbability: { authorityGap: Math.min(0.7, 0.2 + gap / 50), playTypeFactor: 0.4 },
              effort: { playTypeBase: 24, sizeFactor: 1 },
              freshness: freshnessFactor(row.observedAt, new Date()),
            }),
          };
        }),
  },
  {
    type: "O10_cannibalization",
    // Two URLs appearing for one query is not proof of harm. Search engines
    // routinely rank several pages of one site for related intent, and telling the
    // owner to consolidate on that basis destroys pages that were never competing.
    detect: (evidence) => {
      const urlsByQuery = group(byKind(evidence, "keyword_rank"), byQuery);
      const candidates: DetectorCandidate[] = [];
      for (const [query, rows] of urlsByQuery) {
        const competing = rows.filter((row) => {
          const impressions = num(row, "first_party:impressions") ?? 0;
          const position = rankOf(row.metrics);
          return impressions >= DETECTOR_THRESHOLDS.minImpressions && position != null && position <= 30;
        });
        const urls = new Set(competing.map((row) => dim(row, "url") ?? "").filter(Boolean));
        if (urls.size < 2) continue;
        const [first] = competing;

        /**
         * The numbers the detector already has, instead of a null.
         *
         * It knows how many impressions the query gets, and how far down the pages sit. All
         * of it was discarded — `volume: null`, no observed impressions, no window — so every
         * cannibalisation row scored 2 and the hysteresis sweep parked it below a threshold
         * of 3. Measured 2026-11-25: all 4 cannibalisation rows on the fleet were retired,
         * which is why the detector looked like it did not exist.
         *
         * What is *not* claimed: that the pages compete. Overlap is not proof, so readiness
         * stays `needs_investigation` and the summary asks for the intent check. The
         * impressions are the size of the question, not of a win.
         */
        const strongest = competing.reduce((best, row) => {
          const position = rankOf(row.metrics) ?? Number.POSITIVE_INFINITY;
          const bestPosition = rankOf(best.metrics) ?? Number.POSITIVE_INFINITY;
          return position < bestPosition ? row : best;
        }, competing[0]);
        const totalImpressions = competing.reduce((sum, row) => sum + (num(row, "first_party:impressions") ?? 0), 0);
        const disputed = Math.max(0, totalImpressions - (num(strongest, "first_party:impressions") ?? 0));
        const windowDays = dimNum(first, "windowDays") ?? dimNum(strongest, "windowDays") ?? 28;

        candidates.push({
          type: "O10_cannibalization",
          title: `Query overlap: ${urls.size} of our pages appear for "${query}"`,
          summary: `${urls.size} pages each received impressions for this query in the window (${Math.round(totalImpressions)} impressions, ${Math.round(disputed)} on pages other than the best-placed one at position ${Math.round(rankOf(strongest.metrics) ?? 0)}). Check the query's intent and the pages' content before changing anything: overlap is not proof that they compete, and consolidation is not the default fix.`,
          dedupKey: `O10:${query}`,
          clusterSlug: dim(first, "cluster"),
          whyEvidenceIds: [],
          howEvidenceIds: competing.map((row) => row.id),
          scoreInputs: scoreDefaults({
            worth: {
              // Measured impressions, so the row is sized by what is actually at stake rather
              // than being a hypothesis with no evidence behind it.
              volume: totalImpressions > 0 ? totalImpressions : null,
              volumeSource: totalImpressions > 0 ? "first_party" : "unknown",
              observedImpressions: totalImpressions > 0 ? totalImpressions : null,
              ctrAtPosition: ctrAtPosition(rankOf(strongest.metrics)),
              currentPosition: rankOf(strongest.metrics),
              targetPosition: TARGET_POSITION.O10_cannibalization,
              // The window the impressions cover. Without it the impact cannot be
              // annualised and the row falls back to a hypothesis.
              windowDays,
              businessValue: 0.6,
              readiness: "needs_investigation",
              measurement: "observed_baseline",
              benefitTrack: "organic_growth",
              intervention: "investigate",
              change: `Decide whether the ${urls.size} pages appearing for "${query}" compete, and consolidate only if they do`,
              successMeasure: `one page holds the query instead of ${urls.size}`,
              targetPages: [...urls],
            },
            winProbability: { playTypeFactor: 0.5 },
            effort: { playTypeBase: 4, sizeFactor: 1 },
            freshness: freshnessFactor(first.observedAt, new Date()),
          }),
        });
      }
      return candidates;
    },
  },
  {
    type: "O11_freshness_decay",
    // A position that fell is an observation, not a diagnosis: the cause could be a
    // competitor, a SERP feature, seasonality or the content. The detector reports
    // the movement and asks for the check; it does not prescribe a refresh.
    detect: (evidence, ctx) => {
      const previous = ctx.previousRank ?? [];
      if (previous.length === 0) return [];
      const previousByKey = new Map<string, Evidence>();
      // One previous row per query and URL. The evidence store can hold the same observation
      // twice — measured 2026-11-24 on Susi: `akumal real estate` had a `segments: 6` row
      // written twice with an identical position and impression count — and a Map keeps the
      // last, which is why this is explicit rather than incidental.
      for (const row of previous) previousByKey.set(`${byQuery(row)}|${dim(row, "url") ?? ""}`, row);

      /**
       * CMP-010: one candidate per (query, url, window) — the same identity its dedup key
       * declares.
       *
       * A query projected under several segments is stored as several `keyword_rank` rows,
       * all sharing one dedup key. Emitting one candidate per row made a single run report 45
       * candidates for 43 distinct observations, and the extras only disappeared because the
       * row write is idempotent. The row with the most impressions is kept: it carries the
       * most signal about what actually happened, and the choice is arithmetic on a stored
       * count rather than a judgement about which projection is "right".
       */
      const bestCurrent = new Map<string, Evidence>();
      for (const row of byKind(evidence, "keyword_rank")) {
        const key = `${byQuery(row)}|${dim(row, "url") ?? ""}`;
        const existing = bestCurrent.get(key);
        if (!existing) {
          bestCurrent.set(key, row);
          continue;
        }
        const impressions = (candidate: Evidence) => num(candidate, "first_party:impressions") ?? 0;
        if (impressions(row) > impressions(existing)) bestCurrent.set(key, row);
      }

      const candidates: DetectorCandidate[] = [];
      for (const row of bestCurrent.values()) {
        const key = `${byQuery(row)}|${dim(row, "url") ?? ""}`;
        const before = previousByKey.get(key);
        if (!before) continue;
        const currentPosition = rankOf(row.metrics);
        const previousPosition = rankOf(before.metrics);
        const currentImpressions = num(row, "first_party:impressions") ?? 0;
        const previousImpressions = num(before, "first_party:impressions") ?? 0;
        if (currentPosition == null || previousPosition == null) continue;
        // Both windows need enough signal for the move to mean anything.
        if (currentImpressions < DETECTOR_THRESHOLDS.minImpressions || previousImpressions < DETECTOR_THRESHOLDS.minImpressions) continue;
        const delta = currentPosition - previousPosition;
        if (delta < DETECTOR_THRESHOLDS.freshnessDecayDelta) continue;
        const windowDays = dimNum(row, "windowDays") ?? 28;
        // CMP-010: state both periods so a person can check the claim, and say how much the
        // two windows overlap — a movement between overlapping windows is the same average
        // moving by less than its own noise.
        const currentEnd = dim(row, "windowEnd") ?? null;
        const previousEnd = dim(before, "windowEnd") ?? null;
        const compared =
          currentEnd && previousEnd
            ? `the ${windowDays}-day window ending ${currentEnd.slice(0, 10)} and the one ending ${previousEnd.slice(0, 10)}`
            : `the previous and current ${windowDays}-day windows`;
        const overlap = ctx.comparisonOverlapDays;
        candidates.push({
          type: "O11_freshness_decay",
          title: `Position decline: "${byQuery(row)}" ${Math.round(previousPosition)} → ${Math.round(currentPosition)}`,
          summary:
            `Average position moved from ${Math.round(previousPosition)} to ${Math.round(currentPosition)} between ${compared}` +
            ` (${Math.round(previousImpressions)} → ${Math.round(currentImpressions)} impressions)` +
            (overlap != null ? `; the two windows share ${overlap} day${overlap === 1 ? "" : "s"}` : "") +
            ". The cause is not established: check the SERP, competitors and the page before refreshing it.",
          // The later window is part of the identity: a decline in November is not the same
          // observation as a decline in October, and merging them hides that the site moved
          // twice.
          dedupKey: `O11:${byQuery(row)}:${dim(row, "url") ?? ""}:${(currentEnd ?? "").slice(0, 10)}`,
          clusterSlug: dim(row, "cluster"),
          whyEvidenceIds: [],
          howEvidenceIds: [before.id, row.id],
          scoreInputs: scoreDefaults({
            worth: {
              volume: currentImpressions,
              ctrAtPosition: num(row, "first_party:ctr") ?? ctrAtPosition(currentPosition),
              businessValue: 0.6,
              volumeSource: "first_party",
              currentPosition,
              // Recovering the previous position is the declared target.
              targetPosition: previousPosition,
              windowDays,
              observedCtr: num(row, "first_party:ctr") ?? null,
              observedImpressions: currentImpressions,
              // The decline is observed; the cause is not, so the play is a check.
              readiness: "needs_investigation",
              measurement: "observed_baseline",
              benefitTrack: "organic_growth",
              intervention: "investigate",
            },
            winProbability: { rankDistance: rankDistanceFactor(currentPosition) },
            effort: { playTypeBase: 5, sizeFactor: 1 },
            freshness: freshnessFactor(row.observedAt, new Date()),
          }),
        });
      }
      return candidates;
    },
  },
  {
    type: "O12_page_experience",
    detect: (evidence) =>
      byKind(evidence, "vitals")
        .filter((row) => (num(row, "first_party:lcpSeconds") ?? 0) > DETECTOR_THRESHOLDS.maxLcpSeconds)
        .map((row) => ({
          type: "O12_page_experience" as const,
          title: `Page experience: slow LCP on ${dim(row, "url") ?? "page"}`,
          summary: `LCP ${num(row, "first_party:lcpSeconds")}s exceeds the ${DETECTOR_THRESHOLDS.maxLcpSeconds}s threshold on a revenue page.`,
          dedupKey: `O12:${dim(row, "url") ?? ""}`,
          clusterSlug: dim(row, "cluster"),
          whyEvidenceIds: [],
          howEvidenceIds: [row.id],
          scoreInputs: scoreDefaults({
            worth: { volume: null, ctrAtPosition: null, businessValue: 0.5 },
            winProbability: { playTypeFactor: 0.7 },
            effort: { playTypeBase: 12, sizeFactor: 1 },
            freshness: freshnessFactor(row.observedAt, new Date()),
          }),
        })),
  },
  {
    type: "O13_user_pain_point",
    // A customer need becomes work only through the canonical decision. Legacy
    // findings without one are visible as unassessed backlog, never actionable.
    detect: (evidence) => canonicalDecisionCandidates(evidence, "O13_user_pain_point"),
  },
  {
    type: "O14_offer_positioning_gap",
    detect: (evidence) => canonicalDecisionCandidates(evidence, "O14_offer_positioning_gap"),
  },
];

export type DetectorDb = Pick<
  PrismaClient,
  // `crawl` and `auditPage` are read by CMP-012's page-strength resolver: the crawl is
  // where a page's own word count and schema state actually live.
  "opportunity" | "evidenceRecord" | "demandMapCluster" | "evidenceEdge" | "crawl" | "auditPage" | "site"
>;

/** Cluster play: when a tracked cluster is under-covered but has enough
 * tracked queries, emit a topical-authority opportunity that one delivery
 * can close for several atomic gaps. */
export async function clusterPlayDetector(db: DetectorDb, projectId: string, now = new Date()): Promise<DetectorCandidate[]> {
  const clusters = (await db.demandMapCluster.findMany({ where: { projectId } })) as DemandMapCluster[];
  void now;
  const candidates: DetectorCandidate[] = [];
  for (const cluster of clusters) {
    const membership = await db.evidenceRecord.findMany({
      where: { projectId, kind: "keyword_universe_membership", supersededById: null, dimensions: { path: ["cluster"], equals: cluster.slug } },
      select: { id: true, dimensions: true },
    });
    if (membership.length < DETECTOR_THRESHOLDS.minClusterQueries) continue;
    // Coverage = members we actually rank for. Rank evidence is not tagged with
    // a cluster (the same query can move between clusters), so coverage is the
    // intersection of member queries with queries that have a recorded rank.
    const memberQueries = new Set(
      membership
        .map((row) => (row.dimensions as { query?: string } | null)?.query)
        .filter((query): query is string => Boolean(query))
    );
    const ranked = await db.evidenceRecord.findMany({
      where: { projectId, kind: "keyword_rank", supersededById: null },
      select: { dimensions: true },
    });
    const rankedQueries = new Set(
      ranked
        .map((row) => (row.dimensions as { query?: string } | null)?.query)
        .filter((query): query is string => Boolean(query))
    );
    const covered = [...memberQueries].filter((query) => rankedQueries.has(query)).length;
    const coverage = memberQueries.size === 0 ? 1 : covered / memberQueries.size;
    if (coverage <= DETECTOR_THRESHOLDS.maxClusterCoverage) {
      candidates.push({
        type: "O3_content_gap",
        title: `Cluster play: build topical authority for "${cluster.name}"`,
        summary: `${memberQueries.size} tracked queries, ${covered} with a ranking page — a topic hub can close the cluster.`,
        dedupKey: `O3:cluster:${cluster.slug}`,
        clusterSlug: cluster.slug,
        whyEvidenceIds: [],
        howEvidenceIds: membership.slice(0, 1).map((m) => m.id),
        scoreInputs: scoreDefaults({
          worth: { volume: memberQueries.size * 20, ctrAtPosition: ctrAtPosition(5), businessValue: 0.8 },
          winProbability: { rankDistance: 0.5, serpCompetition: 0.4 },
          effort: { playTypeBase: 16, sizeFactor: 2 },
        }),
      });
    }
  }
  return candidates;
}

/**
 * Whether a technical defect has earned a board slot.
 *
 * A defect is admitted only when the pages it affects carry measured demand, or when
 * it belongs to a cluster that is being worked. Otherwise it is a health line: the
 * crawl page already lists it with its severity and page count, so nothing is hidden
 * by keeping it off the opportunity board.
 *
 * This is a filter at the boundary, not a score adjustment. Adjusting the number
 * would leave a no-demand schema sweep competing for the slot below a real proposal,
 * which is the same mistake one rank down.
 */
export function technicalDefectEarnsSlot(
  candidate: DetectorCandidate,
  opts: { clusterId: string | null; threshold?: boolean }
): boolean {
  const gate = opts.threshold ?? DETECTOR_THRESHOLDS.presentationalGapNeedsDemand;
  if (!gate) return true;
  const worth = candidate.scoreInputs.worth;
  if (!worth.technical) return true;
  // Crawlability defects are never gated: a page that cannot be crawled cannot earn
  // the demand the gate would ask it for.
  if (candidate.type === "O7_technical_defect") return true;
  // A presentational gap earns a slot when the pages it affects carry enough measured
  // demand to justify the work. The floor is `minImpressions` — the same declared
  // number the striking-distance detector uses for "enough impressions that a click is
  // worth winning" — not a second threshold invented for this rule. One impression a
  // month is not demand, and admitting it would let a schema sweep outrank the article
  // that defines the offer, which is the defect this gate exists to fix.
  if (worth.volumeSource === "first_party" && (worth.volume ?? 0) >= DETECTOR_THRESHOLDS.minImpressions) return true;
  // Or when the page belongs to a topic someone is working: the fix serves that topic.
  if (opts.clusterId != null) return true;
  return false;
}

export type DetectorRunResult = {
  created: number;
  updated: number;
  parked: string[];
  /** Detectors that could not run because their evidence kind is absent. */
  disabled: DisabledDetector[];
  /** Every candidate produced, when the run was a dry run (shadow comparison). */
  candidates?: DetectorCandidate[];
  /**
   * Technical defects kept off the board because the pages they affect carry no
   * measured demand, and no cluster is working them. They are still on the crawl
   * page; this counter is what stops their absence from being invisible.
   */
  hygieneOnly?: number;
};

/**
 * Run the detectors this project's ownership allows, upsert opportunities, then hysteresis.
 *
 * ## Which detectors run
 *
 * The topic map and the detectors are complementary, not alternatives. The map owns the five
 * capabilities its proposal pipeline can express; the detectors own the nine that only exist as
 * arithmetic over stored evidence. When the map owns the board, the detectors run for their own
 * nine and stay out of the map's five — that is the "one board per project" rule, and it is
 * right, because two producers reasoning differently about the same finding would show it twice.
 *
 * What was wrong is that "the map owns the board" was implemented as "the detectors do not run",
 * which deleted nine capabilities instead of dividing fourteen. Measured 2026-11-25: all 8
 * tenants had modelled clusters, so no detector ran in production for any of them.
 *
 * A project with no modelled topics still bootstraps through every detector, so an unmodelled
 * tenant is not left with an empty board.
 */
export async function runDetectors(
  db: DetectorDb,
  projectId: string,
  opts: {
    detectedBy?: string;
    now?: Date;
    dryRun?: boolean;
    brandTerms?: string[];
    crawledPages?: number;
    /**
     * The topic map has modelled this project and owns the capabilities it can express.
     *
     * The detectors then produce only their own. Ownership comes from `CAPABILITY_PRODUCER`,
     * the single declared table, so this flag cannot become a second opinion about which
     * capabilities exist.
     */
    topicMapOwnsBoard?: boolean;
  } = {}
): Promise<DetectorRunResult> {
  const detectedBy = opts.detectedBy ?? "funnel-detectors";
  const now = opts.now ?? new Date();
  const ownedTypes = opts.topicMapOwnsBoard ? capabilitiesOwnedBy("detectors") : ALL_CAPABILITIES;
  const owned = new Set<OpportunityType>(ownedTypes);
  const allEvidence = (await db.evidenceRecord.findMany({
    where: { projectId, supersededById: null },
  })) as Evidence[];
  const evidence = selectCurrentEvidence(allEvidence);
  const comparison = rankWindowComparison(allEvidence);
  const previousRank = comparison.previous as Evidence[];
  // One resolver, built once per run. Which cluster a query belongs to is a
  // stored fact (an accepted membership row), not an inference, so it is read
  // here and never guessed from the query's words.
  const byQuery = await clusterByQuery(db, projectId);
  const slugToId = new Map<string, string>();
  for (const resolution of byQuery.values()) slugToId.set(resolution.slug, resolution.clusterId);

  const available = new Set(evidence.map((row) => row.kind));
  /**
   * Capabilities this run owns but cannot produce, with the input that is missing.
   *
   * Only owned types are reported: a capability the topic map owns is not this run's business,
   * and saying "O3 disabled, no SERP snapshot" beside a board full of the map's O3 rows would be
   * a false alarm. Scoped this way the list is the honest one — absence of *this* producer's
   * work, which is the number that has to exist for a missing capability to be visible rather
   * than silent.
   */
  const disabled: DisabledDetector[] = DETECTORS.flatMap((detector) => {
    if (!owned.has(detector.type)) return [];
    const missing = (DETECTOR_REQUIRES[detector.type] ?? []).filter((kind) => !available.has(kind));
    if (missing.length > 0) return [{ type: detector.type, missing }];
    // CMP-010: O11 needs two honest windows, not just the `keyword_rank` kind. A project with
    // one projected window has the kind and no comparison, and reporting it as an empty board
    // says "nothing declined" when the truth is "we cannot tell".
    if (detector.type === "O11_freshness_decay" && comparison.reason != null) {
      return [{ type: detector.type, missing: [], reason: comparison.reason }];
    }
    return [];
  });
  const disabledTypes = new Set(disabled.map((entry) => entry.type));

  /**
   * The cluster an opportunity belongs to, or null when its query has no accepted
   * membership row. Resolving from the dedup key's query is reading a stored fact
   * back; a key whose segment matches no membership stays unclustered.
   */
  const clusterIdFor = (candidate: DetectorCandidate): string | null => {
    const resolved = resolveCluster({
      query: queryFromDedupKey(candidate.dedupKey),
      slug: candidate.clusterSlug ?? null,
      byQuery,
      slugToId,
    });
    return resolved?.clusterId ?? null;
  };

  let created = 0;
  let updated = 0;
  let hygieneOnly = 0;
  /** Dedup keys the gate kept off the board, so existing rows can be parked as such. */
  const hygieneParked: string[] = [];
  const candidates: DetectorCandidate[] = [];
  const produced = new Map<OpportunityType, Set<string>>();
  const remember = (candidate: DetectorCandidate) => {
    produced.set(candidate.type, (produced.get(candidate.type) ?? new Set()).add(candidate.dedupKey));
  };
  /**
   * CMP-012: replace every literal winnability input with a stored fact, or null.
   *
   * This runs at the one place candidates become rows, so a detector cannot reintroduce a
   * constant by accident: whatever it set is overridden by what is measured. The detector
   * still supplies `rankDistance` (it knows the position it detected at) and
   * `playTypeFactor` (a declared property of the play).
   */
  // One lookup per run: the crawl that holds our page facts belongs to the site. Read from
  // `site` directly rather than through an opportunity, because a project with no rows yet
  // still has a site and a crawl.
  //
  // The `typeof` guard is not defensive noise: a caller that passes a narrower client (a
  // test double, a connector) simply cannot measure page strength, and that is reported as
  // "not measured" downstream instead of throwing here and losing the whole detector run.
  const siteId =
    typeof db.site?.findFirst === "function"
      ? ((await db.site.findFirst({ where: { projectId }, select: { id: true } }))?.id ?? null)
      : null;

  const withMeasuredWinnability = async (candidate: DetectorCandidate): Promise<DetectorCandidate> => {
    const resolved = await resolveWinProbability(db, {
      projectId,
      siteId,
      query: queryFromDedupKey(candidate.dedupKey),
      rankDistance: candidate.scoreInputs.winProbability.rankDistance,
      // The date the position behind it was observed, so the panel can date every input it
      // calls measured. Rank distance is the one input computed upstream, not read here.
      rankObservedAt: candidate.clusterSlug
        ? null
        : (evidence.find(
            (row) =>
              row.kind === "keyword_rank" &&
              (row.dimensions as { query?: string } | null)?.query?.toLowerCase() ===
                (queryFromDedupKey(candidate.dedupKey) ?? "").toLowerCase()
          )?.observedAt ?? null),
      playTypeFactor: candidate.scoreInputs.winProbability.playTypeFactor,
      // The page this work targets, read from the evidence the candidate already cites.
      // A detector that names the page itself wins; otherwise the first cited row carrying
      // a `url` dimension is the page the opportunity is about. Never derived from the
      // dedup key, which does not always carry one.
      targetUrl: candidate.targetUrl ?? urlFromEvidence(evidence, candidate.howEvidenceIds) ?? urlFromEvidence(evidence, candidate.whyEvidenceIds) ?? null,
      now,
    });
    return {
      ...candidate,
      scoreInputs: {
        ...candidate.scoreInputs,
        winProbability: resolved.winProbability,
        winProbabilitySource: resolved.provenance.source,
        winProbabilityObservedAt: Object.fromEntries(
          Object.entries(resolved.provenance.observedAt).map(([key, value]) => [
            key,
            (value as Date).toISOString(),
          ])
        ),
        winProbabilityMissing: resolved.provenance.missing,
      },
    };
  };

  for (const detector of DETECTORS) {
    // Not this run's capability: its producer of record is elsewhere.
    if (!owned.has(detector.type)) continue;
    if (disabledTypes.has(detector.type)) continue;
    for (const rawCandidate of detector.detect(evidence, {
      now,
      previousRank,
      brandTerms: opts.brandTerms,
      crawledPages: opts.crawledPages,
      comparisonOverlapDays: comparison.overlapDays,
    })) {
      const candidate = await withMeasuredWinnability(rawCandidate);
      const clusterId = clusterIdFor(candidate);
      // Remembered before the gate on purpose: `retireStaleDetected` parks rows this
      // producer no longer emits, and a gated defect must be *parked as hygiene*, not
      // retired as stale — the difference is whether it comes back when demand does.
      remember(candidate);
      if (!technicalDefectEarnsSlot(candidate, { clusterId })) {
        // Counted, not silently dropped: the row stays on the crawl page and this
        // number is how the run says so.
        hygieneOnly += 1;
        if (!opts.dryRun) hygieneParked.push(candidate.dedupKey);
        continue;
      }
      if (opts.dryRun) {
        candidates.push(candidate);
        continue;
      }
      const result = await upsertOpportunity(db, {
        projectId,
        type: candidate.type,
        dimension: dimensionFor(candidate.type),
        title: candidate.title,
        summary: candidate.summary,
        dedupKey: candidate.dedupKey,
        detectedBy,
        clusterId,
        scoreInputs: candidate.scoreInputs,
        whyEvidenceIds: candidate.whyEvidenceIds,
        howEvidenceIds: candidate.howEvidenceIds,
        recommendationDecision: candidate.recommendationDecision,
        recommendationVersion: candidate.recommendationVersion,
        recommendationFingerprint: candidate.recommendationFingerprint,
        recommendationEvidenceId: candidate.recommendationEvidenceId,
      });
      if (result.created) created += 1;
      else updated += 1;
    }
  }
  for (const rawCandidate of await clusterPlayDetector(db, projectId, now)) {
    const candidate = await withMeasuredWinnability(rawCandidate);
    const clusterId = clusterIdFor(candidate);
    remember(candidate);
    if (!technicalDefectEarnsSlot(candidate, { clusterId })) {
      hygieneOnly += 1;
      if (!opts.dryRun) hygieneParked.push(candidate.dedupKey);
      continue;
    }
    if (opts.dryRun) {
      candidates.push(candidate);
      continue;
    }
    const result = await upsertOpportunity(db, {
      projectId,
      type: candidate.type,
      dimension: dimensionFor(candidate.type),
      title: candidate.title,
      summary: candidate.summary,
      dedupKey: candidate.dedupKey,
      detectedBy,
      clusterId,
      scoreInputs: candidate.scoreInputs,
      whyEvidenceIds: candidate.whyEvidenceIds,
      howEvidenceIds: candidate.howEvidenceIds,
    });
    if (result.created) created += 1;
    else updated += 1;
  }

  if (hygieneParked.length > 0) {
    // Park by id, like every other system park, so one shape covers hysteresis, the
    // cap and this. A dedupKey filter would be a second way to address the same rows.
    const gated = await db.opportunity.findMany({
      where: { projectId, status: "detected", detectedBy, dedupKey: { in: hygieneParked } },
      select: { id: true },
    });
    if (gated.length > 0) {
      await db.opportunity.updateMany({
        where: { id: { in: gated.map((row) => row.id) } },
        data: { status: "parked", parkReason: "hygiene_only", decidedBy: detectedBy, decidedAt: now },
      });
    }
  }
  /**
   * A dry run performs no writes at all.
   *
   * Only `applyDecisionSuppression` used to be guarded, so the three sweeps above it ran on
   * every "shadow" comparison: `dryRun` skipped creating and updating rows, then parked the
   * ones already there. Measured 2026-11-25 on susimacdonald, a dry run taken to *measure* what
   * turning the detectors back on would do parked 35 live rows as `superseded` before anything
   * was decided. `scripts/shadow-analysis.ts` has the same shape, so every shadow run it ever
   * made was mutating the board it was comparing against — which is how a measurement can
   * quietly become the cause of the thing it is measuring.
   *
   * A flag named `dryRun` that writes is worse than no flag: it invites exactly the confident
   * read-only measurement that damages production.
   */
  if (opts.dryRun) {
    return { created, updated, parked: [], hygieneOnly, disabled, candidates };
  }
  const parked = await applyHysteresis(db, { projectId, threshold: DETECTOR_THRESHOLDS.hysteresis, detectedBy, ownedTypes });
  const superseded = await retireStaleDetected(db, { projectId, produced, detectedBy });
  const capped = await applyOpenCap(db, { projectId, cap: DETECTOR_THRESHOLDS.openCap, detectedBy, ownedTypes });
  const suppressed = await applyDecisionSuppression(db, { projectId, detectedBy, evidence });
  return {
    created,
    updated,
    parked: [...parked, ...superseded, ...capped, ...suppressed],
    hygieneOnly,
    disabled,
  };
}

/**
 * A canonical rejected/no-action decision must remove a previously detected row
 * even when no candidate for its type survives. Otherwise an old premise stays
 * visible because the detector simply stopped emitting it.
 */
export async function applyDecisionSuppression(
  db: DetectorDb,
  opts: { projectId: string; detectedBy: string; evidence: Evidence[] }
): Promise<string[]> {
  const suppressed = new Map<string, string>();
  for (const row of opts.evidence) {
    const decision = parsePersistedDecision(dim(row, "recommendationDecisionJson"));
    if (!decision) continue;
    if (decision.readiness === "rejected" || decision.readiness === "no_action") {
      suppressed.set(decision.dedupKey, decision.readiness);
    }
  }
  if (suppressed.size === 0) return [];
  const existing = await db.opportunity.findMany({
    where: { projectId: opts.projectId, status: "detected", dedupKey: { in: [...suppressed.keys()] } },
    select: { id: true, dedupKey: true },
  });
  for (const row of existing) {
    await db.opportunity.update({
      where: { id: row.id },
      data: {
        status: "parked",
        parkReason: `decision_${suppressed.get(row.dedupKey) ?? "rejected"}`,
        decidedBy: opts.detectedBy,
        decidedAt: new Date(),
      },
    });
  }
  return existing.map((row) => row.id);
}

/**
 * Plan §3: "noise is superseded, not accumulated."
 *
 * A detector that ran and no longer emits a key means that opportunity is gone
 * (grouped into a site-level one, or below a threshold now). Its `detected` row
 * parks with a reason; accepted work is never touched. Without this, changing a
 * detector leaves the old rows on the board forever.
 */
export async function retireStaleDetected(
  db: DetectorDb,
  opts: { projectId: string; produced: Map<OpportunityType, Set<string>>; detectedBy: string }
): Promise<string[]> {
  if (opts.produced.size === 0) return [];
  /**
   * Only the types this run actually produced, across every writer.
   *
   * Scoping by capability rather than by `detectedBy` is deliberate. A type the topic map owns
   * must not be retired because a detector did not re-produce it — `produced` only holds the
   * types this run emitted, so that is already excluded. But a type this run *did* emit is this
   * capability's current state, and rows of it left behind by an older writer (`batch-reanalysis`,
   * `cmp-005-verify`, and 21 other producers that will never run again) have to be maintained by
   * whoever owns the capability now. Otherwise they stay `detected` forever: stale work shown
   * as current, which is the same defect as hiding work.
   */
  const existing = await db.opportunity.findMany({
    where: { projectId: opts.projectId, status: "detected", type: { in: [...opts.produced.keys()] } },
    select: { id: true, type: true, dedupKey: true },
  });
  const stale = existing.filter((row) => !(opts.produced.get(row.type)?.has(row.dedupKey) ?? false));
  if (stale.length === 0) return [];
  await db.opportunity.updateMany({
    where: { id: { in: stale.map((row) => row.id) }, status: "detected" },
    data: { status: "parked", parkReason: "superseded", decidedBy: opts.detectedBy, decidedAt: new Date() },
  });
  return stale.map((row) => row.id);
}

/**
 * Plan §3: at most `cap` open opportunities per project, score-sorted overflow
 * parks. Nothing is deleted, so a later re-score can lift an opportunity back.
 */
export async function applyOpenCap(
  db: DetectorDb,
  opts: { projectId: string; cap: number; detectedBy: string; ownedTypes: OpportunityType[] }
): Promise<string[]> {
  /**
   * Only machine-detected work is capped, and only work this producer owns.
   *
   * A human accepted some of these; parking them would silently undo a decision. The ownership
   * bound is the other half: the cap used to order the whole board and park whatever fell past
   * the limit, so turning one producer on could evict another producer's rows to make room for
   * its own. A resource limit on how much work the owner is shown is a display concern; using
   * deletion to enforce it is how capabilities vanish. Each producer is accountable for its own
   * overflow.
   */
  const open = await db.opportunity.findMany({
    where: { projectId: opts.projectId, status: "detected", type: { in: opts.ownedTypes } },
    select: { id: true, scoreValue: true, recommendationDecision: true },
    orderBy: opportunityOrder(),
  });
  // A resource cap must not hide a canonical decision. Legacy rows remain capped.
  const capped = open.filter((row) => row.recommendationDecision == null);
  const overflow = capped.slice(opts.cap);
  if (overflow.length === 0) return [];
  await db.opportunity.updateMany({
    where: { id: { in: overflow.map((row) => row.id) }, status: "detected" },
    data: { status: "parked", parkReason: "cap", decidedBy: opts.detectedBy, decidedAt: new Date() },
  });
  return overflow.map((row) => row.id);
}

export function dimensionFor(type: OpportunityType): OpportunityDimension {
  const map: Record<OpportunityType, OpportunityDimension> = {
    O1_winnable_rank: "seo",
    O2_striking_distance: "seo",
    O3_content_gap: "content",
    O4_aeo_citation_gap: "aeo",
    O5_aeo_presence_gap: "aeo",
    O6_business_fact_mismatch: "technical",
    O7_technical_defect: "technical",
    O8_structured_data_gap: "technical",
    O9_backlink_gap: "seo",
    O10_cannibalization: "seo",
    O11_freshness_decay: "seo",
    O12_page_experience: "technical",
    O13_user_pain_point: "content",
    O14_offer_positioning_gap: "content",
  };
  return map[type];
}
