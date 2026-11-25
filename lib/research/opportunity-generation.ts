import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { upsertOpportunity, type OpportunityDb } from "@/lib/funnel/opportunity";
import { ctrAtPosition, type ScoreInputs } from "@/lib/funnel/scoring";
import { TARGET_POSITION } from "@/lib/funnel/impact";
import { queryFromDedupKey } from "@/lib/funnel/cluster-resolver";
import { resolveWinProbability } from "@/lib/funnel/win-probability";
import {
  comparePriority,
  foundationsGate,
  intentFitFor,
  proposalPriority,
  type ProposalPriority,
} from "@/lib/research/priority";
import { type TopicCluster, type TopicMap } from "@/lib/research/topic-map";

/**
 * Phase 3: turn the reviewed topic map into board-ready proposals.
 *
 * The deterministic templates come from the topic map's own gaps: a missing
 * service page, a thin category page, a product-range question, a local gap, a
 * measured AEO citation gap and a timely news item. The optional AI critique
 * can drop or challenge a proposal; it cannot invent queries, pages or evidence.
 *
 * Proposals are stored in the existing `Opportunity` table. The minimal contract
 * lives in `recommendationDecision`; no new table, no task, no acceptance.
 */

export type ProposalLane = "timely" | "content_business" | "aeo_geo" | "technical";
export type ProposalKind = "article" | "update" | "cluster_hub" | "business" | "aeo" | "technical";
export type ProposalEffort = "small" | "medium" | "large" | "unknown";
export type ProposalConfidence = "high" | "medium" | "low";

export type ProposalTarget = {
  url: string | null;
  newAsset: boolean;
  section: string | null;
};

export type Proposal = {
  dedupKey: string;
  lane: ProposalLane;
  kind: ProposalKind;
  title: string;
  summary: string;
  whyNow: string | null;
  evidenceRefs: string[];
  target: ProposalTarget;
  action: string;
  expectedOutcome: string;
  effort: ProposalEffort;
  /** null until the drafting call judges it; never a template default. */
  confidence: ProposalConfidence | null;
  confidenceReason: string | null;
  expiresAt: string | null;
  topicSlug: string | null;
  sources: Array<{ title: string; url: string; publishedAt: string | null }>;
  critique?: { verdict: "keep" | "revise" | "drop"; reason: string } | null;
};

export type ProposalGenerationDb = OpportunityDb &
  Pick<
    PrismaClient,
    | "site"
    | "researchRun"
    | "researchSource"
    | "demandMapCluster"
    | "evidenceRecord"
    | "opportunity"
    // CMP-012: reading a page's own facts needs the crawl.
    | "crawl"
    | "auditPage"
  >;

/**
 * The Search Console window the stored rank rows were measured over.
 *
 * Read from the rows themselves rather than off the topic map: measured 2026-11-24, a map
 * rebuilt before this change carried no window, so every generated opportunity still
 * assessed as a `hypothesis` and no sampled SERP could move its priority. The row is the
 * measurement, so the row is where the window is read. Null when no row states one.
 */
async function readSearchConsoleWindow(
  db: ProposalGenerationDb,
  input: { projectId: string; siteId: string }
): Promise<number | null> {
  // A client without the evidence table cannot state a window; absent stays absent rather
  // than throwing and losing the whole run.
  if (typeof db.evidenceRecord?.findMany !== "function") return null;
  const rows = await db.evidenceRecord.findMany({
    where: { projectId: input.projectId, siteId: input.siteId, supersededById: null, kind: "keyword_rank" as never },
    select: { dimensions: true },
  });
  let windowDays: number | null = null;
  for (const row of rows) {
    const dimensions = (row.dimensions ?? {}) as { windowRole?: string; windowDays?: number };
    // The previous window is a comparison, not the measurement being scored.
    if (dimensions.windowRole === "previous") continue;
    if (typeof dimensions.windowDays !== "number" || dimensions.windowDays <= 0) continue;
    windowDays = windowDays == null ? dimensions.windowDays : Math.max(windowDays, dimensions.windowDays);
  }
  return windowDays;
}

/**
 * The query a proposal is about, read from the evidence it cites.
 *
 * Only a `competitor_rank` (or `keyword_rank`) row carries a query per proposal, and only
 * the first one that names a query is needed: the model cites the handful of rows the
 * proposal rests on, and they describe the same query.
 */
async function queryFromCitedEvidence(
  db: ProposalGenerationDb,
  projectId: string,
  evidenceRefs: string[]
): Promise<string | null> {
  if (evidenceRefs.length === 0) return null;
  if (typeof db.evidenceRecord?.findMany !== "function") return null;
  const rows = await db.evidenceRecord.findMany({
    where: { id: { in: evidenceRefs }, projectId },
    select: { kind: true, dimensions: true },
  });
  for (const row of rows) {
    if (row.kind !== "competitor_rank" && row.kind !== "keyword_rank") continue;
    const query = (row.dimensions ?? {}) as { query?: unknown };
    if (typeof query.query === "string" && query.query.trim() !== "") return query.query;
  }
  return null;
}

/** Fold a query the way the evidence layer does: case, accents and whitespace. */
function foldQuery(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The queries this project has a sampled SERP for, folded.
 *
 * Read once per run so a cluster can be scored on a query whose competition was actually
 * measured, instead of on its biggest query whether or not anyone looked at that SERP.
 */
async function readMeasurableQueries(
  db: ProposalGenerationDb,
  projectId: string
): Promise<Set<string>> {
  // Same rule: no evidence table means nothing is known to be sampled.
  if (typeof db.evidenceRecord?.findMany !== "function") return new Set();
  const rows = await db.evidenceRecord.findMany({
    where: { projectId, supersededById: null, kind: "competitor_rank" as never },
    select: { dimensions: true },
  });
  const queries = new Set<string>();
  for (const row of rows) {
    const query = (row.dimensions ?? {}) as { query?: unknown };
    if (typeof query.query === "string") queries.add(foldQuery(query.query));
  }
  return queries;
}

/** The opportunity type a proposal maps to, from the same table the board stores. */
function typeForProposal(
  lane: string,
  kind: string
): keyof typeof TARGET_POSITION {
  return TYPE_FOR_PROPOSAL[`${lane}:${kind}`] ?? "O3_content_gap";
}

/**
 * The query a cluster's winnability should be measured on.
 *
 * A cluster is many queries and the score needs one, so it takes the one with the most
 * observed impressions: that is the query the cluster is actually competing for, and it
 * is arithmetic on a measured number rather than a guess about wording. Ties break on
 * volume, then on the spelling, so the same cluster always yields the same query.
 *
 * Returns `null` for a cluster with no measured query, which leaves the inputs `null` and
 * the row visibly low-confidence — the honest outcome, not a default.
 */
function leadQueryFor(cluster: TopicCluster | null, measurable?: Set<string>): string | null {
  if (!cluster || cluster.queries.length === 0) return null;
  const ranked = cluster.queries
    .filter((query) => typeof query.query === "string" && query.query.trim() !== "")
    .slice()
    .sort(
      (a, b) =>
        (b.impressions ?? 0) - (a.impressions ?? 0) ||
        (b.volume ?? 0) - (a.volume ?? 0) ||
        a.query.localeCompare(b.query)
    );
  /**
   * Prefer the strongest query we can actually measure a fight on.
   *
   * A cluster is many queries and only some of them were sampled. Measured 2026-11-24: 8
   * of 13 clusters had no sampled SERP for their top-impression query, so their priority
   * was scored blind while competitor rows for other queries in the same cluster sat
   * unread. Choosing among the queries that do have a sample is arithmetic on what was
   * measured, not a judgement about which query matters — the impression order still
   * decides within each group.
   */
  if (measurable && measurable.size > 0) {
    const withSample = ranked.find((query) => measurable.has(foldQuery(query.query)));
    if (withSample) return withSample.query;
  }
  return ranked[0]?.query ?? null;
}

/**
 * CMP-012: replace a proposal's winnability literals with stored facts, or null.
 *
 * The generator produces a score before anything is measured; that is fine for volume and
 * effort, but "how likely are we to win" is a claim about a SERP. Measured 2026-11-24:
 * `phase3:topic-map` rows carried `pageStrength: 0.5` and `serpCompetition: 0.5` on every
 * one, and those are exactly the rows the board was sorting by.
 */
async function withMeasuredWinnability(
  db: ProposalGenerationDb,
  input: {
    projectId: string;
    siteId: string;
    dedupKey: string;
    targetUrl: string | null;
    /**
     * The cluster's own lead query, when the proposal belongs to a topic.
     *
     * `queryFromDedupKey` reads the query out of a dedup key, but a `phase3:` key is
     * `phase3:<lane>:<hash>` — it carries no query at all. Measured 2026-11-24: 1 of 23
     * open opportunities resolved to a query, so `serpCompetition`, `authorityGap` and
     * `pageStrength` were `assumed` on 22 of them and the board was ordered without ever
     * looking at the SERP. The cluster knows its query; this passes it in rather than
     * pretending the key has one.
     */
    query: string | null;
    /**
     * The evidence the proposal cites. Used as a last resort to find the query: an unfiled
     * proposal has no cluster, but the competitor row it cites names the query it is about.
     */
    evidenceRefs?: string[];
    /** The Search Console window, read once for the whole run. */
    windowDays?: number | null;
    inputs: ReturnType<typeof proposalScoreInputs>;
  }
): Promise<ReturnType<typeof proposalScoreInputs>> {
  /**
   * The query to measure, from the most specific source available.
   *
   * A `phase3:` dedup key is a hash, so it is usually no help. The cluster's lead query
   * covers a proposal that belongs to a topic. An unfiled proposal has neither — but it
   * cites the sampled competitor row that made it worth proposing, and that row names the
   * query. Measured 2026-11-24: without this, the three unfiled proposals scored `null`
   * on every winnability input and sat at 1/100 on the board, which is the opposite of
   * what a gap with a named incumbent should rank.
   */
  const query =
    queryFromDedupKey(input.dedupKey) ??
    input.query ??
    (await queryFromCitedEvidence(db, input.projectId, input.evidenceRefs ?? []));
  const resolved = await resolveWinProbability(db as never, {
    projectId: input.projectId,
    siteId: input.siteId,
    query,
    rankDistance: (input.inputs.winProbability.rankDistance as number | null) ?? null,
    playTypeFactor: (input.inputs.winProbability.playTypeFactor as number | null) ?? 0.6,
    targetUrl: input.targetUrl,
  });
  const worth = input.inputs.worth as Record<string, unknown>;
  if (worth.windowDays == null && input.windowDays != null) worth.windowDays = input.windowDays;
  return {
    ...input.inputs,
    winProbability: resolved.winProbability,
    winProbabilitySource: resolved.provenance.source,
    winProbabilityObservedAt: Object.fromEntries(
      Object.entries(resolved.provenance.observedAt).map(([key, value]) => [key, (value as Date).toISOString()])
    ),
    winProbabilityMissing: resolved.provenance.missing,
  } as never;
}

export type ProposalInputs = {
  site: { id: string; domain: string; projectId: string };
  map: TopicMap;
  topicMapRunId: string;
  clusters: Array<{ id: string; slug: string }>;
  evidenceByCluster: Map<string, string[]>;
  knowledgeEvidenceIds: string[];
  aeoEvidence: Array<{ id: string; question: string; cited: number; competitorCited: number }>;
  news: Array<{ id: string; title: string; url: string; publishedAt: string | null; excerpt: string | null }>;
  technical: Array<{
    id: string;
    type: string;
    title: string;
    summary: string;
    scoreValue: number | null;
  }>;
};

export type ProposalRunResult = {
  status: "planned" | "completed" | "existing";
  runId: string | null;
  proposals: Proposal[];
  dropped: Array<{ title: string; reason: string }>;
  critique: { available: boolean; model: string | null; summary: string | null; error: string | null };
  technical: ProposalInputs["technical"];
  counts: { proposals: number; byLane: Record<string, number>; dropped: number };
};

const TYPE_FOR_PROPOSAL: Record<
  string,
  "O3_content_gap" | "O4_aeo_citation_gap" | "O11_freshness_decay" | "O14_offer_positioning_gap" | "O7_technical_defect"
> = {
  "content_business:article": "O3_content_gap",
  "content_business:update": "O3_content_gap",
  "content_business:cluster_hub": "O3_content_gap",
  "content_business:business": "O14_offer_positioning_gap",
  "aeo_geo:aeo": "O4_aeo_citation_gap",
  "timely:article": "O11_freshness_decay",
  "timely:update": "O11_freshness_decay",
  "timely:business": "O14_offer_positioning_gap",
  "technical:technical": "O7_technical_defect",
};

const DIMENSION_FOR_TYPE = {
  O3_content_gap: "content",
  O4_aeo_citation_gap: "aeo",
  O11_freshness_decay: "seo",
  O14_offer_positioning_gap: "content",
  O7_technical_defect: "technical",
} as const;

export function proposalHash(proposal: Omit<Proposal, "dedupKey">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        lane: proposal.lane,
        kind: proposal.kind,
        target: proposal.target,
        action: proposal.action,
        title: proposal.title,
      })
    )
    .digest("hex")
    .slice(0, 16);
}

export function dedupeProposals(proposals: Proposal[]): Proposal[] {
  const seen = new Set<string>();
  return proposals.filter((proposal) => {
    if (seen.has(proposal.dedupKey)) return false;
    seen.add(proposal.dedupKey);
    return true;
  });
}

export function validateProposal(
  proposal: Proposal,
  input: { domain: string; evidenceIds: Set<string>; firstPartyEvidenceIds?: Set<string> }
): string | null {
  if (!proposal.title.trim()) return "missing title";
  if (!proposal.summary.trim()) return "missing summary";
  if (!proposal.action.trim()) return "missing action";
  if (!proposal.expectedOutcome.trim()) return "missing expected outcome";
  if (!["timely", "content_business", "aeo_geo", "technical"].includes(proposal.lane)) return "invalid lane";
  if (!["article", "update", "cluster_hub", "business", "aeo", "technical"].includes(proposal.kind)) return "invalid kind";
  if (!["small", "medium", "large", "unknown"].includes(proposal.effort)) return "invalid effort";
  if (proposal.confidence != null && !["high", "medium", "low"].includes(proposal.confidence)) {
    return "invalid confidence";
  }
  // Confidence is a claim about evidence, so it has to name the evidence. A
  // high claim needs first-party search data behind it; provider volume alone
  // is a market estimate, not proof the site can win the query.
  if (proposal.confidence != null && !proposal.confidenceReason?.trim()) {
    return "confidence needs a reason";
  }
  if (
    proposal.confidence === "high" &&
    input.firstPartyEvidenceIds &&
    !proposal.evidenceRefs.some((id) => input.firstPartyEvidenceIds?.has(id))
  ) {
    return "high confidence needs first-party evidence";
  }
  if (proposal.evidenceRefs.length === 0) return "no evidence references";
  const missingEvidence = proposal.evidenceRefs.filter((id) => !input.evidenceIds.has(id));
  if (missingEvidence.length > 0) return `unknown evidence: ${missingEvidence.slice(0, 3).join(", ")}`;
  if (proposal.target.url) {
    try {
      const host = new URL(proposal.target.url, `https://${input.domain}`).hostname.replace(/^www\./, "");
      if (host !== input.domain.replace(/^www\./, "")) return "target is not on the site";
    } catch {
      return "invalid target URL";
    }
  } else if (!proposal.target.newAsset && proposal.kind !== "business" && proposal.kind !== "aeo") {
    return "article/update needs a target page or a new asset";
  }
  if (proposal.lane === "timely") {
    if (!proposal.whyNow) return "timely proposal needs whyNow";
    if (!proposal.expiresAt || Number.isNaN(Date.parse(proposal.expiresAt))) return "timely proposal needs a valid expiry";
    if (Date.parse(proposal.expiresAt) <= Date.now()) return "timely proposal expiry is in the past";
  }
  return null;
}

export function proposalScoreInputs(
  proposal: Proposal,
  cluster: TopicCluster | null
): {
  worth: Record<string, unknown>;
  // CMP-012: nullable, because an unmeasured input is `null` and not a neutral default.
  winProbability: Record<string, number | null>;
  effort: { playTypeBase: number; sizeFactor: number };
  freshness: number;
  stability: number;
} {
  const volume = cluster?.metrics.volume || cluster?.metrics.impressions || null;
  const businessValue = cluster?.relevance === "high" ? 0.85 : cluster?.relevance === "medium" ? 0.55 : 0.25;
  // Where that number came from. The model rated the topic's commercial relevance
  // from the site's own knowledge facts and its pages, so the provenance is
  // `cluster`; a proposal with no cluster behind it has no judgement at all and says
  // `unknown` rather than borrowing the shape of one.
  //
  // This was absent, and absence is not neutral: `computeScore` damped every row
  // without a source to 0.25, so a generated proposal's own relevance rating never
  // reached the score. Measured 2026-11-25, all 102 open rows were in that state and
  // the apnea article scored 7 instead of 22.
  const businessValueSource: ScoreInputs["worth"]["businessValueSource"] = cluster
    ? cluster.relevance === "high" || cluster.relevance === "medium" || cluster.relevance === "low"
      ? "cluster"
      : "unknown"
    : "unknown";
  const sizeFactor = proposal.effort === "small" ? 0.5 : proposal.effort === "large" ? 2 : 1;
  return {
    worth: {
      volume,
      // The curve is declared in scoring.ts; a flat 3% made a page at position
      // 8 and a page at position 60 look like the same opportunity.
      ctrAtPosition: cluster?.metrics.position != null ? ctrAtPosition(cluster.metrics.position) : null,
      businessValue,
      businessValueSource,
      intentFit: intentFitFor(cluster?.intent),
      volumeSource: cluster?.metrics.volume ? "provider" : volume ? "first_party" : "unknown",
      readiness: proposal.kind === "business" ? "needs_investigation" : "actionable",
      measurement: proposal.kind === "business" ? "unquantified" : volume ? "observed_baseline" : "unquantified",
      benefitTrack: proposal.lane === "technical" ? "technical_health" : "organic_growth",
      intervention:
        proposal.kind === "business"
          ? "investigate"
          : proposal.kind === "update"
            ? "update_page"
            : proposal.kind === "article"
              ? "create_asset"
              : "improve_journey",
      change: proposal.action,
      successMeasure: proposal.expectedOutcome,
      targetPages: proposal.target.url ? [proposal.target.url] : [],
      coverageSummary: cluster ? `Topic coverage: ${cluster.coverage}` : null,
      needRationale: proposal.summary,
      offerFitRationale: cluster?.rationale ?? null,
      /**
       * The position this play is bidding for, from the shared declared table.
       *
       * This was `null`, and a null target is not a missing detail: `assessImpact` reads
       * it to compute the upside, so every generated row assessed as a `hypothesis` and
       * `computeScore` returned from the low-confidence band before it ever looked at the
       * winnability inputs. Measured 2026-11-24: the score was identical (20) whether a
       * sampled SERP was easy or hard, because the competitor evidence was never reached.
       * A declared target is what lets the fight the competitor data describes become a
       * priority.
       */
      targetPosition: TARGET_POSITION[typeForProposal(proposal.lane, proposal.kind)] ?? null,
      currentPosition: cluster?.metrics.position ?? null,
      // The window the impressions were measured over, so they can be read per month.
      windowDays: cluster?.metrics.windowDays ?? null,
      observedImpressions: cluster?.metrics.impressions ?? null,
      technical: false,
      unmeasured: !volume,
    },
    // CMP-012: no literals here. A generated proposal has measured nothing yet, so every
    // input is null and the row scores as low-confidence until the resolver reads a stored
    // fact. `playTypeFactor` is the single permitted constant: a declared property of the
    // play, not a claim about this SERP.
    winProbability: {
      rankDistance: null,
      authorityGap: null,
      pageStrength: null,
      serpCompetition: null,
      playTypeFactor: 0.6,
    },
    effort: { playTypeBase: 8, sizeFactor },
    freshness: 0.9,
    stability: 0.8,
  };
}

function deterministicCritique(proposals: Proposal[]): {
  available: boolean;
  model: string | null;
  summary: string | null;
  error: string | null;
  decisions: Map<string, { verdict: "keep" | "revise" | "drop"; reason: string }>;
} {
  const decisions = new Map<string, { verdict: "keep" | "revise" | "drop"; reason: string }>();
  const byTarget = new Map<string, Proposal[]>();
  for (const proposal of proposals) {
    if (!proposal.target.url) continue;
    byTarget.set(proposal.target.url, [...(byTarget.get(proposal.target.url) ?? []), proposal]);
  }
  let overlaps = 0;
  for (const [url, group] of byTarget) {
    if (group.length <= 1) continue;
    overlaps += 1;
    for (const proposal of group.slice(1)) {
      decisions.set(proposal.dedupKey, {
        verdict: "revise",
        reason: `Same target (${url}) as “${group[0].title}”; sequence or merge before accepting.`,
      });
    }
  }
  let dependencies = 0;
  for (const proposal of proposals) {
    if (!proposal.target.newAsset || !proposal.target.url) continue;
    // The proposal that creates the page is not dependent on itself. Other
    // proposals aimed at the same new URL are.
    const creator = proposals.find(
      (other) =>
        other.target.newAsset &&
        other.target.url === proposal.target.url &&
        (other.kind === "article" || other.kind === "cluster_hub")
    );
    if (creator && creator !== proposal) {
      dependencies += 1;
      decisions.set(proposal.dedupKey, {
        verdict: "revise",
        reason: `Depends on the new asset at ${proposal.target.url}; sequence after “${creator.title}”.`,
      });
    }
  }
  let thin = 0;
  for (const proposal of proposals) {
    if (proposal.evidenceRefs.length >= 2) continue;
    thin += 1;
    decisions.set(proposal.dedupKey, {
      verdict: "revise",
      reason: "Thin evidence: fewer than two evidence references.",
    });
  }
  return {
    available: true,
    model: "deterministic",
    summary: `Deterministic critique: ${proposals.length} proposals checked; ${overlaps} target overlap(s), ${dependencies} new-asset dependency, ${thin} thin-evidence item(s).`,
    error: null,
    decisions,
  };
}

export async function critiqueProposals(
  proposals: Proposal[],
  map: TopicMap
): Promise<{
  available: boolean;
  model: string | null;
  summary: string | null;
  error: string | null;
  decisions: Map<string, { verdict: "keep" | "revise" | "drop"; reason: string }>;
}> {
  const config = contentWriterConfig();
  if (!config) {
    return { available: false, model: null, summary: null, error: "CONTENT_LLM_API_KEY is not configured", decisions: new Map() };
  }
  if (proposals.length === 0) {
    return { available: false, model: config.model, summary: null, error: "no proposals to critique", decisions: new Map() };
  }
  const payload = {
    site: map.domain,
    proposals: proposals.map((proposal) => ({
      dedupKey: proposal.dedupKey,
      lane: proposal.lane,
      kind: proposal.kind,
      title: proposal.title.slice(0, 180),
      summary: proposal.summary.slice(0, 300),
      target: proposal.target,
      action: proposal.action.slice(0, 400),
      evidenceCount: proposal.evidenceRefs.length,
    })),
  };
  const system = [
    "You are an SEO critic for the business described in the payload.",
    "Judge it by the proposals and the site, not by an assumed trade.",
    "Check each proposal for unsupported claims, duplicates and wrong target pages.",
    "Respect the tenant market scope: a local service is local, while a national or international product offer may be proposed beyond the local service area. The owner decides whether to add a product range.",
    "A low-demand but business-relevant local proposal is valid; do not drop it only because volume is low. Check whether it is a reasonable expansion or small test.",
    "Do not rewrite the proposals. Return exactly one JSON object: { summary: string, decisions: [{ dedupKey: string, verdict: 'keep'|'revise'|'drop', reason: string }] }.",
    "Use only the supplied dedupKeys. Keep the summary under 300 characters and each reason under 200.",
  ].join("\n");

  try {
    const parsed = await chatJson({
      config,
      system,
      user: JSON.stringify(payload),
      maxTokens: 24_000,
      temperature: 0.2,
      attempts: 2,
      timeoutMs: 180_000,
      // Reasoning models can spend a small completion budget before emitting
      // content; keep enough room for both the reasoning and the JSON answer.
      jsonMode: false,
    });
    const record = asRecord(parsed);
    const decisions = new Map<string, { verdict: "keep" | "revise" | "drop"; reason: string }>();
    for (const raw of Array.isArray(record.decisions) ? record.decisions : []) {
      const row = asRecord(raw);
      const dedupKey = textValue(row.dedupKey);
      const verdict = textValue(row.verdict);
      const reason = textValue(row.reason);
      if (!dedupKey || !verdict || !["keep", "revise", "drop"].includes(verdict)) continue;
      decisions.set(dedupKey, { verdict: verdict as "keep" | "revise" | "drop", reason: reason?.slice(0, 400) ?? "" });
    }
    return {
      available: true,
      model: config.model,
      summary: textValue(record.summary)?.slice(0, 800) ?? null,
      error: null,
      decisions,
    };
  } catch (error) {
    const fallback = deterministicCritique(proposals);
    return {
      ...fallback,
      error: `AI critique unavailable: ${
        error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400)
      }. Deterministic checks used.`,
    };
  }
}

export async function storeProposals(
  db: ProposalGenerationDb,
  input: {
    projectId: string;
    siteId: string;
    domain: string;
    map: TopicMap;
    topicMapRunId: string;
    proposals: Proposal[];
    evidenceIds: Set<string>;
    firstPartyEvidenceIds?: Set<string>;
    /** Which phase owns these proposals; the weekly sweep and the monthly pass
     * must not supersede each other's rows. */
    detectedBy?: "phase3:topic-map" | "phase5:weekly";
    knowledgeEvidenceIds: string[];
    clusters: Array<{ id: string; slug: string }>;
  }
): Promise<{
  stored: Array<{ id: string; dedupKey: string }>;
  dropped: Array<{ title: string; reason: string }>;
  /** Rows a verified closure already covers, proposed again by the model. */
  reproposedClosed: string[];
}> {
  const stored: Array<{ id: string; dedupKey: string }> = [];
  const dropped: Array<{ title: string; reason: string }> = [];
  const reproposedClosed: string[] = [];
  const clusterIdBySlug = new Map(input.clusters.map((cluster) => [cluster.slug, cluster.id]));
  // Read once for the whole run: the window is a property of the measurement period, not
  // of one proposal.
  const searchConsoleWindowDays = await readSearchConsoleWindow(db, {
    projectId: input.projectId,
    siteId: input.siteId,
  });
  const measurableQueries = await readMeasurableQueries(db, input.projectId);

  for (const proposal of input.proposals) {
    const invalid = validateProposal(proposal, {
      domain: input.domain,
      evidenceIds: input.evidenceIds,
      firstPartyEvidenceIds: input.firstPartyEvidenceIds,
    });
    if (invalid) {
      dropped.push({ title: proposal.title, reason: invalid });
      continue;
    }
    const type = TYPE_FOR_PROPOSAL[`${proposal.lane}:${proposal.kind}`];
    if (!type) {
      dropped.push({ title: proposal.title, reason: `no opportunity type for ${proposal.lane}:${proposal.kind}` });
      continue;
    }
    const cluster = input.map.clusters.find((entry) => entry.slug === proposal.topicSlug) ?? null;
    // The "why" leg is the business fact this proposal actually rests on. If
    // the drafting did not cite one, the leg stays empty rather than repeating
    // the same knowledge row on every card.
    const whyEvidenceIds = proposal.evidenceRefs
      .filter((id) => input.knowledgeEvidenceIds.includes(id))
      .slice(0, 3);
    const howEvidenceIds = proposal.evidenceRefs
      .filter((id) => !input.knowledgeEvidenceIds.includes(id))
      .slice(0, 8);
    try {
      // A refresh replaces the evidence this generated proposal rests on. Old
      // membership-only edges must not linger next to the new query/SERP edges.
      const existing = await db.opportunity.findUnique({
        where: { projectId_dedupKey: { projectId: input.projectId, dedupKey: proposal.dedupKey } },
        select: { id: true, status: true, parkReason: true },
      });
      const wasClosed = existing?.status === "closed";
      if (existing && (existing.status === "accepted" || existing.status === "in_progress" || existing.status === "rejected")) {
        // An accepted or rejected proposal is a human decision, and for accepted
        // work it is the task's brief. A later draft must not rewrite it.
        continue;
      }
      if (existing) {
        // A proposal that was merely not re-proposed on a previous run comes
        // back when it is proposed again. It was parked, never closed: closure
        // means verified fixed. A human rejection is never reopened.
        const autoParked =
          existing.status === "parked" &&
          (existing.parkReason === "superseded by refreshed proposal" ||
            existing.parkReason === "merged into another proposal" ||
            existing.parkReason === "dropped by critique");
        if (autoParked) {
          await db.opportunity.update({
            where: { id: existing.id },
            data: { status: "detected", parkReason: null },
          });
        }
        await db.evidenceEdge.deleteMany({
          where: {
            toType: "opportunity",
            toId: existing.id,
            relation: "supporting",
            createdBy: { in: ["phase3:topic-map", "phase5:weekly"] },
          },
        });
      }
      const record = await upsertOpportunity(db, {
        projectId: input.projectId,
        type,
        dimension: DIMENSION_FOR_TYPE[type],
        title: proposal.title,
        summary: proposal.summary,
        dedupKey: proposal.dedupKey,
        detectedBy: input.detectedBy ?? "phase3:topic-map",
        clusterId: proposal.topicSlug ? clusterIdBySlug.get(proposal.topicSlug) ?? null : null,
        // CMP-012: the generated inputs are a starting point; the winnability inputs are
        // replaced by stored facts at this single place, so a proposal cannot carry a
        // literal into a score. A proposal whose query has no stored difficulty, no
        // referring-domain sets and no crawled target page gets nulls, and the row is
        // visibly low-confidence rather than a fabricated fair fight.
        scoreInputs: await withMeasuredWinnability(db, {
          projectId: input.projectId,
          siteId: input.siteId,
          dedupKey: proposal.dedupKey,
          targetUrl: proposal.target.url ?? null,
          query: leadQueryFor(cluster, measurableQueries),
          // A proposal with no topic still knows its query through what it cites.
          evidenceRefs: proposal.evidenceRefs,
          windowDays: searchConsoleWindowDays,
          inputs: proposalScoreInputs(proposal, cluster),
        }) as never,
        whyEvidenceIds,
        howEvidenceIds: howEvidenceIds.length > 0 ? howEvidenceIds : proposal.evidenceRefs.slice(0, 4),
        recommendationDecision: {
          schemaVersion: "phase3-v1",
          source: "phase3-topic-map",
          readiness: proposal.kind === "business" ? "needs_investigation" : "actionable",
          lane: proposal.lane,
          kind: proposal.kind,
          title: proposal.title,
          summary: proposal.summary,
          whyNow: proposal.whyNow,
          evidenceRefs: proposal.evidenceRefs,
          target: proposal.target,
          action: proposal.action,
          expectedOutcome: proposal.expectedOutcome,
          effort: proposal.effort,
          confidence: proposal.confidence,
          confidenceReason: proposal.confidenceReason,
          expiresAt: proposal.expiresAt,
          topicSlug: proposal.topicSlug,
          sources: proposal.sources,
          critique: proposal.critique ?? null,
          topicMapRunId: input.topicMapRunId,
        },
        recommendationVersion: "phase3-v1",
        recommendationFingerprint: proposalHash(proposal),
        recommendationEvidenceId: proposal.evidenceRefs[0] ?? null,
      });
      stored.push({ id: record.id, dedupKey: proposal.dedupKey });
      if (wasClosed) reproposedClosed.push(proposal.title);
    } catch (error) {
      dropped.push({
        title: proposal.title,
        reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }
  return { stored, dropped, reproposedClosed };
}

function describePriority(priority: ProposalPriority): string {
  const hold = priority.hold ? "HOLD — " : "";
  if (priority.track === "foundation") return `${hold}foundation · ${priority.reason}`;
  if (priority.score != null) return `${hold}≈${priority.score.toFixed(1)} clicks/month at the measured position · ${priority.reason}`;
  return `${hold}not quantified · ${priority.reason}`;
}

export function renderProposalBoard(input: {
  map: TopicMap;
  proposals: Proposal[];
  dropped: Array<{ title: string; reason: string }>;
  critique: { available: boolean; model: string | null; summary: string | null; error: string | null };
  /** The drafting call's own note, including why it proposed nothing. */
  drafting?: { model: string | null; summary: string | null; errors: string[]; truncations?: string[] } | null;
  /** What changed against the previous run of this month. */
  changes?: { updated: number; added: string[]; noLongerProposed: string[] } | null;
  /** Proposals the model drafted again although a verified closure covers them. */
  reproposedClosed?: string[];
  technical: ProposalInputs["technical"];
  generatedAt: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Opportunity board — ${input.map.domain} — ${input.map.month}`);
  lines.push("");
  lines.push(`Generated ${input.generatedAt}. Proposals only; no task is created until a human accepts one.`);
  lines.push("");
  const gate = foundationsGate(input.map);
  const clusterBySlug = new Map(input.map.clusters.map((cluster) => [cluster.slug, cluster]));
  const ranked = input.proposals
    .map((proposal) => ({
      proposal,
      priority: proposalPriority(proposal, proposal.topicSlug ? clusterBySlug.get(proposal.topicSlug) ?? null : null, gate),
    }))
    .sort((a, b) => comparePriority(a, b, gate));
  if (input.changes) {
    lines.push(
      `Since the previous run: ${input.changes.updated} updated in place, ${input.changes.added.length} new, ${input.changes.noLongerProposed.length} no longer proposed.`
    );
    for (const title of input.changes.added) lines.push(`- new: ${title}`);
    for (const title of input.changes.noLongerProposed) lines.push(`- no longer proposed: ${title}`);
    lines.push("");
  }
  if (ranked.length > 0) {
    lines.push("## Priority order");
    lines.push("");
    lines.push(gate.reason);
    lines.push("");
    for (const [index, item] of ranked.entries()) {
      lines.push(`${index + 1}. **${item.proposal.title}** — ${describePriority(item.priority)}`);
    }
    lines.push("");
  }
  const languageMismatch = (cluster: TopicCluster) =>
    cluster.language != null && cluster.language !== input.map.locale.language;
  const taxonomyReview = input.map.clusters.filter(
    (cluster) => cluster.reviewFlags.includes("no-need-word") || cluster.contextOnly.queries > 0 || languageMismatch(cluster)
  );
  if (taxonomyReview.length > 0) {
    lines.push("## Taxonomy review");
    lines.push("");
    for (const cluster of taxonomyReview) {
      if (cluster.reviewFlags.includes("no-need-word")) {
        lines.push(`- \`${cluster.slug}\` — no need word: defined only by place or brand. Not drafted until the taxonomy is corrected.`);
      }
      if (languageMismatch(cluster)) {
        lines.push(`- \`${cluster.slug}\` — queries are in ${cluster.language}; the site locale is ${input.map.locale.language}. Decide the language architecture before drafting this topic.`);
      }
    }
    // The same place-only queries are context-only for every topic that names
    // the place. Group them so the board shows one gap, not one row per topic.
    const contextGroups = new Map<string, { topics: string[]; queries: number; volume: number }>();
    for (const cluster of taxonomyReview) {
      if (cluster.contextOnly.queries === 0) continue;
      const key = cluster.contextOnly.examples.slice(0, 2).join("|") || `${cluster.contextOnly.queries}:${cluster.contextOnly.volume}`;
      const group = contextGroups.get(key) ?? { topics: [], queries: cluster.contextOnly.queries, volume: cluster.contextOnly.volume };
      group.topics.push(cluster.slug);
      contextGroups.set(key, group);
    }
    for (const group of contextGroups.values()) {
      const topics = group.topics.map((slug) => `\`${slug}\``).join(", ");
      lines.push(`- ${topics} — ${group.queries} queries / ${group.volume} monthly demand name this place or brand but not its need. Review for a missing need term or a separate audience.`);
    }
    lines.push("");
  }
  lines.push("## Lanes");
  lines.push("");
  const lanes: Array<{ lane: ProposalLane; title: string }> = [
    { lane: "timely", title: "Timely" },
    { lane: "content_business", title: "Content & business" },
    { lane: "aeo_geo", title: "AEO/GEO" },
    { lane: "technical", title: "Technical" },
  ];
  for (const lane of lanes) {
    const laneItems = ranked.filter((item) => item.proposal.lane === lane.lane);
    lines.push(`### ${lane.title}`);
    lines.push("");
    if (laneItems.length === 0) {
      lines.push("No proposal in this lane.");
      lines.push("");
      continue;
    }
    for (const { proposal, priority } of laneItems) {
      lines.push(`#### ${proposal.title}`);
      lines.push("");
      lines.push(`- Kind: ${proposal.kind}; effort: ${proposal.effort}; confidence: ${proposal.confidence ?? "not assessed"}${proposal.confidenceReason ? ` (${proposal.confidenceReason})` : ""}`);
      lines.push(`- Priority: ${describePriority(priority)}`);
      lines.push(`- Summary: ${proposal.summary}`);
      if (proposal.whyNow) lines.push(`- Why now: ${proposal.whyNow}`);
      lines.push(`- Target: ${proposal.target.url ?? (proposal.target.newAsset ? "new asset" : "no page")}${proposal.target.section ? ` (${proposal.target.section})` : ""}`);
      lines.push(`- Action: ${proposal.action}`);
      lines.push(`- Expected outcome: ${proposal.expectedOutcome}`);
      lines.push(`- Evidence: ${proposal.evidenceRefs.length} reference(s)`);
      if (proposal.sources.length > 0) {
        lines.push(`- Sources: ${proposal.sources.map((source) => source.url).join(", ")}`);
      }
      if (proposal.expiresAt) lines.push(`- Expires: ${proposal.expiresAt.slice(0, 10)}`);
      if (proposal.critique) lines.push(`- Critique: ${proposal.critique.verdict} — ${proposal.critique.reason}`);
      lines.push("");
    }
  }
  if (input.drafting?.summary || (input.drafting?.errors.length ?? 0) > 0) {
    lines.push("## Drafting note");
    lines.push("");
    if (input.drafting?.summary) lines.push(input.drafting.summary);
    for (const error of input.drafting?.errors ?? []) lines.push(`\n- ${error}`);
    lines.push("");
  }
  if ((input.drafting?.truncations?.length ?? 0) > 0) {
    lines.push("## Data omitted from the drafting call");
    lines.push("");
    for (const row of input.drafting?.truncations ?? []) lines.push(`- ${row}`);
    lines.push("");
  }
  lines.push("## Critique");
  if (input.reproposedClosed && input.reproposedClosed.length > 0) {
    lines.push("");
    lines.push("Proposed again after a verified closure — check for regression before reopening:");
    for (const title of input.reproposedClosed) lines.push(`- ${title}`);
  }
  lines.push("");
  if (input.critique.available) {
    lines.push(`Model: ${input.critique.model ?? "configured model"}.`);
    if (input.critique.summary) lines.push(`\n${input.critique.summary}`);
    if (input.critique.error) lines.push(`\nNote: ${input.critique.error}`);
  } else {
    lines.push(`Critique unavailable: ${input.critique.error ?? "unknown error"}. The proposals are shown as generated.`);
  }
  lines.push("");
  if (input.dropped.length > 0) {
    lines.push("Not stored:");
    lines.push("");
    for (const row of input.dropped) lines.push(`- ${row.title} — ${row.reason}`);
    lines.push("");
  }
  lines.push("## Limits");
  lines.push("");
  lines.push("- This board is a proposal set, not accepted work. No task, delivery or publication is created.");
  lines.push("- Proposals are drafted from the reviewed topic map and its cited evidence; the critique can challenge them but cannot add queries, pages or evidence.");
  lines.push("- A business proposal with no target page is an investigation, not an article.");
  lines.push("- Technical proposals are drafted from the crawl findings like any other lane; the crawl rows are cited as evidence.");
  lines.push("");
  return lines.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
