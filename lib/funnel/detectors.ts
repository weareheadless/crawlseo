import { type DemandMapCluster, type EvidenceRecord, type EvidenceRecordKind, type OpportunityDimension, type OpportunityType, type PrismaClient } from "@prisma/client";

import type { OpportunityDb } from "@/lib/funnel/opportunity";
import { upsertOpportunity, applyHysteresis } from "@/lib/funnel/opportunity";
import type { ScoreInputs } from "@/lib/funnel/scoring";
import { ctrAtPosition, rankDistanceFactor, freshnessFactor } from "@/lib/funnel/scoring";
import { clusterFindings } from "@/lib/research/finding-evidence";
import { assessCustomerNeed } from "@/lib/funnel/assess-need";
import { parsePersistedAssessment, type NeedAssessment } from "@/lib/research/need-assessment";

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
  whyEvidenceIds: string[];
  howEvidenceIds: string[];
  scoreInputs: Omit<ScoreInputs, "evidenceCompleteness">;
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
  /** pages sharing one issue before it becomes a single site-level opportunity */
  siteLevelIssuePages: 10,
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
  /** The kinds it needs and does not have. */
  missing: EvidenceRecordKind[];
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

/**
 * The assessment behind a decision, persisted with the recommendation.
 *
 * Without it a board can show "actionable" but not why, and a later reader cannot
 * tell a checked conclusion from a model's guess.
 */
function assessmentProvenance(assessment: NeedAssessment | null) {
  if (!assessment) return {};
  return {
    needRationale: assessment.need.rationale,
    needEvidenceUrls: assessment.need.evidenceUrls,
    offerFitRationale: assessment.offerFit.rationale,
    offerFitEvidenceUrls: assessment.offerFit.evidenceUrls,
    assessmentModel: assessment.model,
    assessmentPromptVersion: assessment.promptVersion,
    assessedAt: assessment.assessedAt,
  };
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
  opts: { minPages: number; siteTitle: (issueKey: string, count: number) => string }
): DetectorCandidate[] {
  const groups = new Map<string, PageIssue[]>();
  for (const issue of issues) {
    groups.set(issue.issueKey, [...(groups.get(issue.issueKey) ?? []), issue]);
  }
  const out: DetectorCandidate[] = [];
  for (const [issueKey, group] of groups) {
    if (group.length < opts.minPages) {
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
      rankDistance: null,
      authorityGap: null,
      pageStrength: 0.5,
      serpCompetition: 0.5,
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
};

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
 * Two kinds do: `keyword_rank` (one projection per month) and `onpage_crawl` (one
 * set of issues per crawl). Detecting over every historical run counted the same
 * query once per month and kept defects that a later crawl had already fixed —
 * a page whose missing H1 was repaired stayed on the board forever.
 */
export function selectCurrentEvidence(evidence: Evidence[]): Evidence[] {
  const window = latestValue(evidence, "keyword_rank", "windowEnd");
  const crawl = latestValue(evidence, "onpage_crawl", "crawlId");
  return evidence.filter((row) => {
    if (row.kind === "keyword_rank" && window) return dim(row, "windowEnd") === window;
    if (row.kind === "onpage_crawl" && crawl) return dim(row, "crawlId") === crawl;
    return true;
  });
}

/**
 * The comparison window's rank rows: the newest windowEnd that is older than the
 * current one. Empty when only one window has been projected.
 */
export function previousWindowEvidence(evidence: Evidence[]): Evidence[] {
  const windows = [...new Set(
    byKind(evidence, "keyword_rank")
      .map((row) => dim(row, "windowEnd"))
      .filter((value): value is string => typeof value === "string" && value.length > 0)
  )].sort();
  if (windows.length < 2) return [];
  const previous = windows[windows.length - 2];
  return byKind(evidence, "keyword_rank").filter((row) => dim(row, "windowEnd") === previous);
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
        const position = num(row, "provider:position") ?? num(row, "first_party:position");
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
    detect: (evidence, ctx) =>
      byKind(evidence, "keyword_rank")
        .filter((row) => {
          if (isBrandQuery(byQuery(row), ctx.brandTerms)) return false;
          const position = num(row, "provider:position") ?? num(row, "first_party:position");
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
          const position = num(row, "provider:position") ?? num(row, "first_party:position")!;
          const impressions = num(row, "first_party:impressions") ?? 0;
          const clicks = num(row, "first_party:clicks") ?? 0;
          const ctr = num(row, "first_party:ctr") ?? 0;
          const snippet = position <= 10;
          return {
            type: "O2_striking_distance" as const,
            title: snippet
              ? `Snippet not earning the click: "${byQuery(row)}" at position ${Math.round(position)}`
              : `Striking distance: "${byQuery(row)}" gets impressions, no clicks`,
            summary: snippet
              ? `Position ${Math.round(position)} with ${Math.round(impressions)} impressions but ${Math.round(clicks)} clicks (${(ctr * 100).toFixed(1)}%). The rank is there and the snippet is not earning the click; the cause may be the title, the description, or a SERP feature taking the click.`
              : `Position ${Math.round(position)} with ${Math.round(impressions)} impressions and low CTR — the title/meta is not earning the click.`,
            dedupKey: `O2:${byQuery(row)}:${dim(row, "url") ?? ""}`,
            clusterSlug: dim(row, "cluster"),
            whyEvidenceIds: [],
            howEvidenceIds: [row.id],
            scoreInputs: scoreDefaults({
              worth: {
                volume: impressions,
                ctrAtPosition: ctr,
                businessValue: businessValueForQuery(evidence, byQuery(row)).value,
                businessValueSource: businessValueForQuery(evidence, byQuery(row)).source,
                volumeSource: "first_party",
                currentPosition: position,
                // The snippet play targets the CTR the position already deserves.
                targetPosition: position,
                windowDays: dimNum(row, "windowDays"),
                observedCtr: ctr,
                observedImpressions: impressions,
              },
              winProbability: { rankDistance: rankDistanceFactor(position), playTypeFactor: 0.8 },
              effort: { playTypeBase: 2, sizeFactor: 1 },
              freshness: freshnessFactor(row.observedAt, new Date()),
            }),
          };
        }),
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
    detect: (evidence) => {
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
        siteTitle: (issueKey, count) => `${humanizeIssue(issueKey)} on ${count} pages`,
      });
    },
  },
  {
    type: "O8_structured_data_gap",
    detect: (evidence) => {
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
        siteTitle: (_issueKey, count) => `Missing structured data on ${count} pages`,
      });
    },
  },
  {
    type: "O9_backlink_gap",
    detect: (evidence) =>
      byKind(evidence, "backlink_profile")
        .filter((row) => (num(row, "provider:referringDomainGap") ?? 0) >= DETECTOR_THRESHOLDS.minReferringDomainGap)
        .map((row) => ({
          type: "O9_backlink_gap" as const,
          title: `Authority gap vs ${dim(row, "competitor") ?? "competitor"}`,
          summary: `${Math.round(num(row, "provider:referringDomainGap") ?? 0)} domains link to competitors but not to us.`,
          dedupKey: `O9:${dim(row, "competitor") ?? ""}`,
          clusterSlug: dim(row, "cluster"),
          whyEvidenceIds: [],
          howEvidenceIds: [row.id],
          scoreInputs: scoreDefaults({
            worth: { volume: null, ctrAtPosition: null, businessValue: 0.4 },
            winProbability: { authorityGap: 0.3, playTypeFactor: 0.4 },
            effort: { playTypeBase: 24, sizeFactor: 1 },
            freshness: freshnessFactor(row.observedAt, new Date()),
          }),
        })),
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
          const position = num(row, "provider:position") ?? num(row, "first_party:position");
          return impressions >= DETECTOR_THRESHOLDS.minImpressions && position != null && position <= 30;
        });
        const urls = new Set(competing.map((row) => dim(row, "url") ?? "").filter(Boolean));
        if (urls.size < 2) continue;
        const [first] = competing;
        candidates.push({
          type: "O10_cannibalization",
          title: `Query overlap: ${urls.size} of our pages appear for "${query}"`,
          summary: `${urls.size} pages each received impressions for this query in the window. Check the query's intent and the pages' content before changing anything: overlap is not proof that they compete, and consolidation is not the default fix.`,
          dedupKey: `O10:${query}`,
          clusterSlug: dim(first, "cluster"),
          whyEvidenceIds: [],
          howEvidenceIds: competing.map((row) => row.id),
          scoreInputs: scoreDefaults({
            // No demand of its own and no declared play: this is a question to
            // answer, so it stays a hypothesis rather than claiming an upside.
            worth: {
              volume: null,
              ctrAtPosition: null,
              businessValue: 0.6,
              volumeSource: "unknown",
              readiness: "needs_investigation",
              measurement: "unquantified",
              benefitTrack: "organic_growth",
              intervention: "investigate",
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
      const previousByKey = new Map(previous.map((row) => [`${byQuery(row)}|${dim(row, "url") ?? ""}`, row]));
      const candidates: DetectorCandidate[] = [];
      for (const row of byKind(evidence, "keyword_rank")) {
        const key = `${byQuery(row)}|${dim(row, "url") ?? ""}`;
        const before = previousByKey.get(key);
        if (!before) continue;
        const currentPosition = num(row, "provider:position") ?? num(row, "first_party:position");
        const previousPosition = num(before, "provider:position") ?? num(before, "first_party:position");
        const currentImpressions = num(row, "first_party:impressions") ?? 0;
        const previousImpressions = num(before, "first_party:impressions") ?? 0;
        if (currentPosition == null || previousPosition == null) continue;
        // Both windows need enough signal for the move to mean anything.
        if (currentImpressions < DETECTOR_THRESHOLDS.minImpressions || previousImpressions < DETECTOR_THRESHOLDS.minImpressions) continue;
        const delta = currentPosition - previousPosition;
        if (delta < DETECTOR_THRESHOLDS.freshnessDecayDelta) continue;
        const windowDays = dimNum(row, "windowDays") ?? 28;
        candidates.push({
          type: "O11_freshness_decay",
          title: `Position decline: "${byQuery(row)}" ${Math.round(previousPosition)} → ${Math.round(currentPosition)}`,
          summary: `Average position moved from ${Math.round(previousPosition)} to ${Math.round(currentPosition)} between the previous and current ${windowDays}-day windows (${Math.round(previousImpressions)} → ${Math.round(currentImpressions)} impressions). The cause is not established: check the SERP, competitors and the page before refreshing it.`,
          dedupKey: `O11:${byQuery(row)}:${dim(row, "url") ?? ""}`,
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
    // A customer need becomes work only when the decision contract says so. A
    // contradicted premise and a research-quality failure are dropped here, not
    // published at a lower score.
    detect: (evidence) => {
      const knowledge = businessValueFromKnowledge(evidence);
      const candidates: DetectorCandidate[] = [];
      for (const cluster of clusterFindings(
        byKind(evidence, "research_finding")
          .filter((row) => dim(row, "painPoint") === "true")
          .map((row) => ({
            id: row.id,
            theme: dim(row, "theme") ?? null,
            summary: dim(row, "painPointSummary") ?? "",
            confidence: 0,
            createdAt: row.observedAt,
            row,
          }))
      )) {
        const row = cluster.representative.row;
        const statement = dim(row, "painPointSummary") ?? "";
        const assessment = parsePersistedAssessment(dim(row, "assessmentJson"));
        const decision = assessCustomerNeed({
          label: dim(row, "theme") ?? undefined,
          statement,
          clusterSize: cluster.members.length,
          verification: dim(row, "verification") ?? null,
          verificationReason: dim(row, "verificationReason") ?? null,
          coverageState: dim(row, "coverageState") ?? null,
          coveragePage: dim(row, "coveragePage") ?? null,
          coverageComplete: dim(row, "coverageComplete") === "true",
          businessFit: knowledge,
          kind: "need",
          assessment,
        });
        if (decision.readiness === "rejected" || decision.readiness === "no_action") continue;
        candidates.push({
          type: "O13_user_pain_point" as const,
          // Label from the theme; the prose belongs in the summary, where a reader
          // can open it instead of scrolling past it on the board.
          title: dim(row, "title") ?? dim(row, "theme") ?? dim(row, "query") ?? "Customer need",
          summary: statement || `Research surfaced a customer need worth checking.`,
          dedupKey: `O13:${cluster.key}`,
          clusterSlug: dim(row, "cluster"),
          whyEvidenceIds: cluster.members.map((member) => member.row.id),
          howEvidenceIds: [],
          scoreInputs: scoreDefaults({
            worth: {
              volume: null,
              ctrAtPosition: null,
              businessValue: knowledge.value,
              businessValueSource: knowledge.source,
              readiness: decision.readiness,
              measurement: "unquantified",
              benefitTrack: decision.tracks[0],
              intervention: decision.intervention,
              change: decision.change,
              successMeasure: decision.successMeasure,
              targetPages: decision.targetPages,
              coverageSummary: decision.coverage[0]
                ? `${decision.coverage[0].state.replaceAll("_", " ")} at ${decision.coverage[0].pageUrl}`
                : "no page assessed",
              ...assessmentProvenance(assessment),
            },
            winProbability: { playTypeFactor: 0.5 },
            effort: { playTypeBase: 16, sizeFactor: 1 },
            freshness: freshnessFactor(row.observedAt, new Date()),
          }),
        });
      }
      return candidates;
    },
  },
  {
    type: "O14_offer_positioning_gap",
    detect: (evidence) => {
      const knowledge = businessValueFromKnowledge(evidence);
      const candidates: DetectorCandidate[] = [];
      for (const cluster of clusterFindings(
        byKind(evidence, "research_finding")
          .filter((row) => dim(row, "positioningGap") === "true")
          .map((row) => ({
            id: row.id,
            theme: dim(row, "theme") ?? null,
            summary: dim(row, "gapSummary") ?? "",
            confidence: 0,
            createdAt: row.observedAt,
            row,
          }))
      )) {
        const row = cluster.representative.row;
        const statement = dim(row, "gapSummary") ?? "";
        const assessment = parsePersistedAssessment(dim(row, "assessmentJson"));
        const decision = assessCustomerNeed({
          label: dim(row, "theme") ?? undefined,
          statement,
          clusterSize: cluster.members.length,
          verification: dim(row, "verification") ?? null,
          verificationReason: dim(row, "verificationReason") ?? null,
          coverageState: dim(row, "coverageState") ?? null,
          coveragePage: dim(row, "coveragePage") ?? null,
          coverageComplete: dim(row, "coverageComplete") === "true",
          businessFit: knowledge,
          kind: "offer",
          assessment,
        });
        if (decision.readiness === "rejected" || decision.readiness === "no_action") continue;
        candidates.push({
          type: "O14_offer_positioning_gap" as const,
          title: dim(row, "title") ?? dim(row, "theme") ?? dim(row, "query") ?? "Positioning gap",
          summary: statement || `Research and SERP evidence suggest a positioning gap worth checking.`,
          dedupKey: `O14:${cluster.key}`,
          clusterSlug: dim(row, "cluster"),
          whyEvidenceIds: cluster.members.map((member) => member.row.id),
          howEvidenceIds: [],
          scoreInputs: scoreDefaults({
            worth: {
              volume: null,
              ctrAtPosition: null,
              businessValue: knowledge.value,
              businessValueSource: knowledge.source,
              readiness: decision.readiness,
              measurement: "unquantified",
              benefitTrack: decision.tracks[0],
              intervention: decision.intervention,
              change: decision.change,
              successMeasure: decision.successMeasure,
              targetPages: decision.targetPages,
              coverageSummary: decision.coverage[0]
                ? `${decision.coverage[0].state.replaceAll("_", " ")} at ${decision.coverage[0].pageUrl}`
                : "no page assessed",
              ...assessmentProvenance(assessment),
            },
            winProbability: { playTypeFactor: 0.5 },
            effort: { playTypeBase: 12, sizeFactor: 1 },
            freshness: freshnessFactor(row.observedAt, new Date()),
          }),
        });
      }
      return candidates;
    },
  },
];

export type DetectorDb = Pick<PrismaClient, "opportunity" | "evidenceRecord" | "demandMapCluster" | "evidenceEdge">;

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

export type DetectorRunResult = {
  created: number;
  updated: number;
  parked: string[];
  /** Detectors that could not run because their evidence kind is absent. */
  disabled: DisabledDetector[];
  /** Every candidate produced, when the run was a dry run (shadow comparison). */
  candidates?: DetectorCandidate[];
};

/** Run every detector for a project, upsert opportunities, then hysteresis. */
export async function runDetectors(
  db: DetectorDb,
  projectId: string,
  opts: { detectedBy?: string; now?: Date; dryRun?: boolean; brandTerms?: string[] } = {}
): Promise<DetectorRunResult> {
  const detectedBy = opts.detectedBy ?? "funnel-detectors";
  const now = opts.now ?? new Date();
  const allEvidence = (await db.evidenceRecord.findMany({
    where: { projectId, supersededById: null },
  })) as Evidence[];
  const evidence = selectCurrentEvidence(allEvidence);
  const previousRank = previousWindowEvidence(allEvidence);

  const available = new Set(evidence.map((row) => row.kind));
  const disabled: DisabledDetector[] = DETECTORS.flatMap((detector) => {
    const missing = (DETECTOR_REQUIRES[detector.type] ?? []).filter((kind) => !available.has(kind));
    return missing.length > 0 ? [{ type: detector.type, missing }] : [];
  });
  const disabledTypes = new Set(disabled.map((entry) => entry.type));

  let created = 0;
  let updated = 0;
  const candidates: DetectorCandidate[] = [];
  const produced = new Map<OpportunityType, Set<string>>();
  const remember = (candidate: DetectorCandidate) => {
    produced.set(candidate.type, (produced.get(candidate.type) ?? new Set()).add(candidate.dedupKey));
  };
  for (const detector of DETECTORS) {
    if (disabledTypes.has(detector.type)) continue;
    for (const candidate of detector.detect(evidence, { now, previousRank, brandTerms: opts.brandTerms })) {
      remember(candidate);
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
        clusterId: null,
        scoreInputs: candidate.scoreInputs,
        whyEvidenceIds: candidate.whyEvidenceIds,
        howEvidenceIds: candidate.howEvidenceIds,
      });
      if (result.created) created += 1;
      else updated += 1;
    }
  }
  for (const candidate of await clusterPlayDetector(db, projectId, now)) {
    remember(candidate);
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
      clusterId: null,
      scoreInputs: candidate.scoreInputs,
      whyEvidenceIds: candidate.whyEvidenceIds,
      howEvidenceIds: candidate.howEvidenceIds,
    });
    if (result.created) created += 1;
    else updated += 1;
  }

  const parked = await applyHysteresis(db, { projectId, threshold: DETECTOR_THRESHOLDS.hysteresis, detectedBy });
  const superseded = await retireStaleDetected(db, { projectId, produced, detectedBy });
  const capped = await applyOpenCap(db, { projectId, cap: DETECTOR_THRESHOLDS.openCap, detectedBy });
  return {
    created,
    updated,
    parked: [...parked, ...superseded, ...capped],
    disabled,
    ...(opts.dryRun ? { candidates } : {}),
  };
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
  opts: { projectId: string; cap: number; detectedBy: string }
): Promise<string[]> {
  // Only machine-detected work is capped. A human accepted these; parking them
  // would silently undo a decision.
  const open = await db.opportunity.findMany({
    where: { projectId: opts.projectId, status: "detected" },
    select: { id: true, scoreValue: true },
    orderBy: [{ scoreValue: "desc" }, { firstDetectedAt: "asc" }],
  });
  const overflow = open.slice(opts.cap);
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
