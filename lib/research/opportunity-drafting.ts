import { createHash } from "node:crypto";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import type { MarketScopeConfig } from "@/lib/site/market-scope";
import type { TopicCluster, TopicMap } from "@/lib/research/topic-map";
import type {
  Proposal,
  ProposalConfidence,
  ProposalEffort,
  ProposalKind,
  ProposalLane,
} from "@/lib/research/opportunity-generation";

/**
 * Phase 3 drafting.
 *
 * The board's proposals are drafted from the reviewed topic map and the
 * evidence the map cites. Code supplies facts and validates the answer; it does
 * not carry a playbook of pages, copy, offers or geography for a tenant. That is
 * what makes the same path work for a different business: the model reads the
 * cluster, its market scope and its evidence, and decides whether there is a
 * proposal, what it targets and how confident it is.
 */

export type DraftEvidence = {
  id: string;
  kind: string;
  /** Crawl defect label, when the row is a crawl observation. */
  issue?: string | null;
  /** How many pages share the defect; one delivery closes them together. */
  pages?: number | null;
  /** Readable text for a business fact. */
  text?: string | null;
  query: string | null;
  position: number | null;
  impressions: number | null;
  volume: number | null;
  url: string | null;
};

export type DraftAeoQuestion = {
  id: string;
  question: string;
  cited: number;
  competitors: number;
};

export type DraftNews = {
  id: string;
  title: string;
  url: string;
  publishedAt: string | null;
  excerpt: string | null;
};

export type DraftInput = {
  map: TopicMap;
  marketScope: MarketScopeConfig;
  evidenceByCluster: Map<string, DraftEvidence[]>;
  aeoQuestions: DraftAeoQuestion[];
  news: DraftNews[];
  /** Evidence that describes the business itself, used as the "why" leg. */
  knowledgeEvidenceIds: string[];
  /** Every indexable path the site already has, so the model never proposes
   *  creating a page that exists. */
  existingPaths?: string[];
  /** Business facts the model may cite as the proposal's "why". */
  knowledgeFacts?: DraftEvidence[];
  /** Site-level crawl defects the model can turn into technical proposals. */
  technicalEvidence?: DraftEvidence[];
  now: Date;
};

export type DraftResult = {
  proposals: Proposal[];
  errors: string[];
  /** Proposals the model returned that could not be stored, and why. */
  rejected: Array<{ title: string; reason: string }>;
  /** Input the payload bound omitted, named so it is never invisible. */
  truncations: string[];
  /** The model's own note on the batch, including why it proposed nothing. */
  summary: string | null;
  model: string | null;
};

/** Product rule: a story older than this is not timely. */
export const TIMELY_WINDOW_DAYS = 21;
// Smaller batches and a larger completion budget: the drafting model is a
// reasoning model, and a long batch spent its budget before emitting JSON.
const CLUSTER_BATCH = 4;
/** A per-call output bound. Exceeding it is reported, never silent. */
const MAX_PROPOSALS_PER_BATCH = 6;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Identity is the asset, not the wording. A proposal that updates /lampes and a
 * proposal that rewrites it are the same board row; the model may change the
 * title and action on every run without growing the board.
 */
export function proposalIdentity(proposal: Pick<Proposal, "lane" | "target" | "topicSlug" | "kind">): string {
  // A page that already exists is identified by its URL. A page that does not
  // exist yet is identified by the topic and the kind of asset, because the
  // model invents its URL: the same article on two runs must not become two
  // rows just because the slug moved.
  const asset =
    proposal.target.newAsset && proposal.topicSlug
      ? `new:${proposal.topicSlug}:${proposal.kind}`
      : proposal.target.url
        ? proposal.target.url.replace(/\/+$/, "").toLowerCase()
        : proposal.topicSlug
          ? `topic:${proposal.topicSlug}`
          : "site";
  return `phase3:${proposal.lane}:${hash(asset)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Accept the words a model actually uses for the same ordinal. Rejecting a
 * proposal because it said "moyen" instead of "medium" is a vocabulary test,
 * not an editorial one.
 */
const EFFORT_WORDS: Record<string, ProposalEffort> = {
  small: "small", s: "small", low: "small", petit: "small", petite: "small", faible: "small", quick: "small", light: "small",
  medium: "medium", m: "medium", moderate: "medium", moyen: "medium", moyenne: "medium", normal: "medium",
  large: "large", l: "large", big: "large", grand: "large", grande: "large", eleve: "large", "élevé": "large", heavy: "large",
  unknown: "unknown", "?": "unknown",
};

const CONFIDENCE_WORDS: Record<string, ProposalConfidence> = {
  high: "high", haute: "high", fort: "high", forte: "high", strong: "high",
  medium: "medium", moyenne: "medium", moyen: "medium", moderate: "medium",
  low: "low", basse: "low", faible: "low", weak: "low",
};

function normalizeEffort(value: string | null): ProposalEffort | null {
  if (!value) return null;
  return EFFORT_WORDS[value.trim().toLowerCase()] ?? null;
}

function normalizeConfidence(value: string | null): ProposalConfidence | null {
  if (!value) return null;
  return CONFIDENCE_WORDS[value.trim().toLowerCase()] ?? null;
}

function bool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

const LANES: ProposalLane[] = ["timely", "content_business", "aeo_geo", "technical"];
const KINDS: ProposalKind[] = ["article", "update", "cluster_hub", "business", "aeo", "technical"];
const EFFORTS: ProposalEffort[] = ["small", "medium", "large", "unknown"];
const CONFIDENCES: ProposalConfidence[] = ["high", "medium", "low"];

function clusterPayload(cluster: TopicCluster, evidence: DraftEvidence[]) {
  return {
    slug: cluster.slug,
    name: cluster.name,
    intent: cluster.intent,
    relevance: cluster.relevance,
    // Coverage is a page match; visibility is whether the site earns anything.
    // A "strong" page with no impressions is unproven, not finished.
    coverage: cluster.coverage,
    visibility: cluster.visibility,
    marketScope: cluster.marketScope,
    demand: cluster.metrics,
    contextOnly: cluster.contextOnly,
    reviewFlags: cluster.reviewFlags,
    gaps: cluster.gaps.slice(0, 5),
    outOfMarket: cluster.excludedQueries.slice(0, 5),
    queries: cluster.queries.slice(0, 10).map((query) => ({
      query: query.query,
      impressions: query.impressions,
      position: query.position == null ? null : Number(query.position.toFixed(1)),
      volume: query.volume,
    })),
    pages: cluster.pages.map((page) => ({
      url: page.url,
      type: page.type,
      words: page.wordCount,
      title: page.title,
    })),
    evidence: evidence.slice(0, 12),
  };
}

function businessPayload(input: DraftInput) {
  return {
    domain: input.map.domain,
    business: input.map.business,
    locale: input.map.locale,
    marketScope: input.marketScope,
    today: input.now.toISOString().slice(0, 10),
  };
}

const SYSTEM = [
  "You are an SEO strategist drafting a proposal board for one business.",
  "Write in the business's language, given in locale.language. Do not mix languages in one board.",
  "You receive the business, its market scope, its topic clusters with measured Search Console demand, the pages that cover each topic, and the evidence rows the map cites.",
  "Decide for each cluster whether there is work worth proposing. It is correct to propose nothing for a cluster: say why in the batch summary.",
  "Coverage is a page match, not visibility. A cluster with strong coverage but no impressions is unproven: the page exists but earns nothing, so it can still be worth proposing. Use the visibility field, not coverage alone, to decide a topic is finished.",
  "The owner is one person. Propose at most two items for a cluster, and only when they are genuinely different jobs (for example a page fix and a new asset). Do not split one job across several rows.",
  "Use only the supplied facts, page URLs and evidence ids. Never invent a metric, a page, a query or an evidence id.",
  "Respect the market scope. A local offer is limited to the business location and service area; a national or international offer is not. Queries listed under outOfMarket are already excluded: never build a proposal on them.",
  "Do not assume a product range exists or does not exist. If demand names a format or service the supplied pages do not cover, the proposal is a decision for the owner, not an assumption.",
  "A low-demand cluster can still deserve a small test when it is business-relevant. Say so and set confidence accordingly.",
  "Do not drop the business's core offer because measured demand is zero. If the cluster is a service the business sells, propose a small page or section and set confidence low; say that the case rests on the offer, not on volume.",
  "A cluster's contextOnly count is demand that names its place or brand but not its need. Do not build a proposal on it; it is evidence of a missing need term or a separate audience.",
  "Set confidence from the strength of the cited evidence: high only when first-party search data supports the action directly, medium when the data is directional, low for a test or an owner decision. Give a confidenceReason that describes the evidence in plain words for the owner; do not paste evidence ids into it.",
  "Target an existing page URL from the supplied pages when the work updates a page. Use newAsset true and a path only when a new page is genuinely required.",
  "The site's existing paths are listed in existingPaths. Never propose creating a page whose path already exists: propose an update to that page instead.",
  "Return exactly one JSON object: { summary: string, proposals: [{ lane, kind, title, summary, whyNow, topicSlug, target: { url, newAsset, section }, action, expectedOutcome, effort, confidence, confidenceReason, evidenceIds: string[], expiresAt }] }.",
  "lane is one of timely, content_business, aeo_geo. kind is article, update, cluster_hub, business or aeo. effort is small, medium, large or unknown. confidence is high, medium or low.",
  "kind business is an owner decision about the offer with no page to build. When the work creates a page, use article for a new content page and cluster_hub for a hub or category page.",
  "Use lane aeo_geo when the proposal rests on measured AI Overview observations and the work is answer blocks on a page that already exists.",
  "A technical finding is a crawl defect with its evidence id, a sample URL and how many pages share it. A defect on many pages is one delivery, not many. If it is worth proposing, use lane technical, kind technical, target the affected URL, cite its evidence id, and describe the fix; do not invent a defect that is not in the findings.",
  "Cite a business fact from businessFacts as evidence when the proposal rests on what the business actually offers; do not cite one that does not apply. Every proposal needs at least one evidenceId from the supplied evidence for its cluster. Keep titles under 120 characters, summaries under 300, actions under 600, confidenceReason under 200.",
].join("\n");

function parseProposals(
  parsed: unknown,
  input: DraftInput,
  allowedEvidence: Map<string, DraftEvidence>,
  batchClusters: TopicCluster[]
): { proposals: Proposal[]; rejected: Array<{ title: string; reason: string }>; truncations: string[] } {
  const record = asRecord(parsed);
  // Accept a list or a single object: a model that returns one proposal often
  // uses the singular key, and losing the proposal over a key name is not a
  // judgement the owner should pay for.
  const rawRows = Array.isArray(record.proposals)
    ? record.proposals
    : Array.isArray(record.proposal)
      ? record.proposal
      : record.proposal && typeof record.proposal === "object"
        ? [record.proposal]
        : [];
  const rows = rawRows.slice(0, MAX_PROPOSALS_PER_BATCH);
  const truncations: string[] = [];
  if (rawRows.length > MAX_PROPOSALS_PER_BATCH) {
    truncations.push(`${rawRows.length - MAX_PROPOSALS_PER_BATCH} proposals from one batch were not stored`);
  }
  const slugs = new Set(batchClusters.map((cluster) => cluster.slug));
  const proposals: Proposal[] = [];
  const rejected: Array<{ title: string; reason: string }> = [];
  const reject = (title: string | null, reason: string) => {
    rejected.push({ title: title?.slice(0, 120) ?? "untitled", reason });
  };
  for (const raw of rows) {
    const row = asRecord(raw);
    let lane = text(row.lane) as ProposalLane | null;
    let kind = text(row.kind) as ProposalKind | null;
    const effort = normalizeEffort(text(row.effort)) ?? "unknown";
    const confidence = normalizeConfidence(text(row.confidence));
    const title = text(row.title);
    const summary = text(row.summary);
    const action = text(row.action);
    const expectedOutcome = text(row.expectedOutcome);
    const topicSlug = text(row.topicSlug);
    const target = asRecord(row.target);
    // Evidence ids identify stored evidence records. A URL is a source, not an
    // evidence id; it is kept in `sources` and never used as a reference.
    const evidenceIds = Array.isArray(row.evidenceIds)
      ? row.evidenceIds.filter((id): id is string => typeof id === "string" && !id.includes("://"))
      : [];
    if (!lane || !LANES.includes(lane)) { reject(title, "invalid lane"); continue; }
    if (!kind || !KINDS.includes(kind)) { reject(title, "invalid kind"); continue; }
    if (!EFFORTS.includes(effort)) { reject(title, "invalid effort"); continue; }
    if (!title || !summary || !action || !expectedOutcome) { reject(title, "missing required field"); continue; }
    const technical = lane === "technical";
    if (technical && topicSlug && !slugs.has(topicSlug)) { reject(title, "unknown topic"); continue; }
    if (!technical && (!topicSlug || !slugs.has(topicSlug))) { reject(title, "unknown topic"); continue; }
    const requestedUrl = text(target.url);
    const normalizedPath = requestedUrl
      ? (() => {
          try {
            return new URL(requestedUrl, "https://example.invalid").pathname.replace(/\/+$/, "") || "/";
          } catch {
            return requestedUrl;
          }
        })()
      : null;
    if (bool(target.newAsset) === true && normalizedPath) {
      const exists = (input.existingPaths ?? []).some((path) => path.replace(/\/+$/, "") === normalizedPath);
      if (exists) {
        reject(title, `target ${normalizedPath} already exists; this is an update, not a new page`);
        continue;
      }
    }
    const known = evidenceIds.filter((id) => allowedEvidence.has(id));
    if (known.length === 0) {
      reject(title, evidenceIds.length === 0 ? "no evidence ids" : "evidence ids not in the supplied catalogue");
      continue;
    }
    // A proposal that rests only on measured AI Overview observations is an
    // AEO proposal, whatever lane the model labelled it with. The lane then
    // reflects the evidence rather than a naming choice.
    if (known.every((id) => allowedEvidence.get(id)?.kind === "ai_visibility_observation")) {
      lane = "aeo_geo";
      kind = "aeo";
    }
    // The timely lane is for a dated news story. A cluster proposal that only
    // feels seasonal ("the holidays are coming") is content work; without a
    // source URL it has no story to expire.
    if (lane === "timely" && !text(row.sourceUrl)) {
      lane = "content_business";
    }
    const url = text(target.url);
    const newAsset = bool(target.newAsset) ?? false;
    const confidenceReason = text(row.confidenceReason);
    // Expiry is a timely concept. A content proposal is not "expired" because
    // a date passed, so a stray date from the model is dropped.
    const expiresAt = lane === "timely" ? text(row.expiresAt) : null;
    const proposal: Proposal = {
      dedupKey: "",
      lane,
      kind,
      title: title.slice(0, 160),
      summary: summary.slice(0, 400),
      whyNow: text(row.whyNow)?.slice(0, 400) ?? null,
      // Only the evidence the model actually cited. A blanket business fact on
      // every proposal made the "why" leg identical everywhere.
      evidenceRefs: [...new Set(known)].slice(0, 10),
      target: { url, newAsset, section: text(target.section)?.slice(0, 120) ?? null },
      action: action.slice(0, 900),
      expectedOutcome: expectedOutcome.slice(0, 400),
      effort,
      confidence,
      confidenceReason: confidenceReason?.slice(0, 300) ?? null,
      expiresAt,
      topicSlug,
      sources: [],
      critique: null,
    };
    proposal.dedupKey = proposalIdentity(proposal);
    proposals.push(proposal);
  }
  return { proposals, rejected, truncations };
}

export async function draftClusterProposals(input: DraftInput): Promise<DraftResult> {
  const config = contentWriterConfig();
  if (!config) {
    return { proposals: [], errors: ["CONTENT_LLM_API_KEY is not configured"], rejected: [], truncations: [], summary: null, model: null };
  }

  // Every cluster with demand or coverage is drafted. Batching is a transport
  // detail; it must not decide which topics the owner gets to see. A topic with
  // no need word is the exception: it is a taxonomy defect, not an opportunity,
  // and the board lists it under Taxonomy review instead.
  const clusters = input.map.clusters.filter(
    (cluster) =>
      !cluster.reviewFlags.includes("no-need-word") &&
      (cluster.queries.length > 0 || cluster.coverage !== "none")
  );
  const allowedEvidence = new Map<string, DraftEvidence>();
  for (const cluster of clusters) {
    for (const row of input.evidenceByCluster.get(cluster.slug) ?? []) allowedEvidence.set(row.id, row);
  }
  for (const row of input.technicalEvidence ?? []) allowedEvidence.set(row.id, row);
  for (const row of input.knowledgeFacts ?? []) allowedEvidence.set(row.id, row);

  const proposals: Proposal[] = [];
  const errors: string[] = [];
  const rejected: Array<{ title: string; reason: string }> = [];
  const summaries: string[] = [];
  const truncations: string[] = [];
  for (let index = 0; index < clusters.length; index += CLUSTER_BATCH) {
    const batch = clusters.slice(index, index + CLUSTER_BATCH);
    const payload = {
      ...businessPayload(input),
      aeoQuestions: input.aeoQuestions,
      businessFacts: (input.knowledgeFacts ?? []).map((row) => ({
        evidenceId: row.id,
        fact: row.text,
      })),
      existingPaths: input.existingPaths ?? [],
      technicalFindings: (input.technicalEvidence ?? []).map((row) => ({
        evidenceId: row.id,
        issue: row.issue ?? row.kind,
        url: row.url,
        pages: row.pages ?? 1,
      })),
      clusters: batch.map((cluster) =>
        clusterPayload(cluster, input.evidenceByCluster.get(cluster.slug) ?? [])
      ),
    };
    try {
      const parsed = await chatJson({
        config,
        system: SYSTEM,
        user: JSON.stringify(payload),
        maxTokens: 24_000,
        temperature: 0.2,
        attempts: 2,
        timeoutMs: 240_000,
        jsonMode: false,
      });
      const parsedBatch = parseProposals(parsed, input, allowedEvidence, batch);
      proposals.push(...parsedBatch.proposals);
      rejected.push(...parsedBatch.rejected);
      truncations.push(...parsedBatch.truncations);
      const note = text(asRecord(parsed).summary);
      if (note) summaries.push(note.slice(0, 300));
    } catch (error) {
      errors.push(
        `clusters ${batch.map((cluster) => cluster.slug).join(", ")}: ${
          error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
        }`
      );
    }
  }
  return {
    proposals,
    errors,
    rejected,
    truncations,
    summary: summaries.length > 0 ? summaries.join(" ") : null,
    model: config.model,
  };
}

export async function draftTimelyProposals(input: DraftInput): Promise<DraftResult> {
  const config = contentWriterConfig();
  if (!config) {
    return { proposals: [], errors: ["CONTENT_LLM_API_KEY is not configured"], rejected: [], truncations: [], summary: null, model: null };
  }
  const current = input.news.filter(
    (item) => item.publishedAt && input.now.getTime() - Date.parse(item.publishedAt) <= TIMELY_WINDOW_DAYS * 86_400_000
  );
  if (current.length === 0) {
    return {
      proposals: [],
      errors: input.news.length > 0 ? [`no news source within ${TIMELY_WINDOW_DAYS} days`] : [],
      rejected: [],
      truncations: [],
      summary: null,
      model: config.model,
    };
  }

  const localClusters = input.map.clusters
    .filter((cluster) => cluster.marketScope.scope === "local")
    .sort((a, b) => b.metrics.impressions - a.metrics.impressions);
  // A business with no local offer can still react to news. Fall back to its
  // strongest clusters rather than refusing to draft.
  const evidenceClusters = localClusters.length > 0
    ? localClusters
    : [...input.map.clusters].sort((a, b) => b.metrics.impressions - a.metrics.impressions);
  // Every cluster's evidence is citable: the model attaches a timely note to
  // whichever topic the story touches, and a story about Tulum is not served by
  // a catalogue that only accepted the two strongest local clusters.
  const evidence = new Map<string, DraftEvidence>();
  for (const cluster of input.map.clusters) {
    for (const row of input.evidenceByCluster.get(cluster.slug) ?? []) evidence.set(row.id, row);
  }
  // The business's own facts are citable too: a timely note usually links the
  // story to what the business actually does. The news item is itself evidence.
  for (const id of input.knowledgeEvidenceIds) {
    evidence.set(id, { id, kind: "knowledge_fact", query: null, position: null, impressions: null, volume: null, url: null });
  }

  const payload = {
    ...businessPayload(input),
    // No `id` on a news item: its id is a URL, not a stored evidence id, and
    // offering one invited the model to cite something the catalogue rejects.
    // The story is cited through sourceUrl instead.
    news: current.map(({ id: _id, ...item }) => item),
    knowledgeEvidence: input.knowledgeEvidenceIds,
    localClusters: evidenceClusters.slice(0, 3).map((cluster) => ({
      slug: cluster.slug,
      name: cluster.name,
      marketScope: cluster.marketScope,
      demand: cluster.metrics,
      evidence: (input.evidenceByCluster.get(cluster.slug) ?? []).slice(0, 12),
    })),
  };
  const system = [
    "You are an SEO strategist reviewing this week's news for one business.",
    "Write in the business's language, given in locale.language.",
    "If your summary says there is an opportunity, you must return it as a proposal. If you return no proposals, the summary must say why there is no opportunity.",
    "Decide whether any item is a real, current opportunity for this business. A local news item that does not concern the business's market, trade or customers is not an opportunity: propose nothing.",
    "Use the business location and service area to judge whether the story is in the business's market. Judge the place the story names; do not use a fixed list of cities.",
    "A story older than 21 days is not current: do not propose it. A timely proposal must expire; set expiresAt to the date the story stops being current, at most 30 days from today.",
    "Use only the supplied evidence ids in evidenceIds; never put a URL there. The story goes in sourceUrl. Return exactly one JSON object: { summary: string, proposals: [{ lane, kind, title, summary, whyNow, topicSlug, target: { url, newAsset, section }, action, expectedOutcome, effort, confidence, confidenceReason, evidenceIds: string[], expiresAt, sourceUrl }] }.",
    "lane must be timely. kind is article, update or business. Every proposal needs at least one evidenceId and one sourceUrl from the supplied news.",
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
      jsonMode: false,
    });
    // The evidence is restricted to the local clusters, but a timely proposal
    // may attach to any real cluster in the map.
    const parsedBatch = parseProposals(parsed, input, evidence, input.map.clusters);
    const byUrl = new Map(current.map((item) => [item.url, item]));
    const timely = parsedBatch.proposals
      .filter((proposal) => proposal.lane === "timely")
      .map((proposal) => {
        const record = asRecord(parsed);
        const rows = Array.isArray(record.proposals) ? record.proposals.map(asRecord) : [];
        const match = rows.find((row) => text(row.title) === proposal.title);
        const sourceUrl = match ? text(match.sourceUrl) : null;
        const source = sourceUrl ? byUrl.get(sourceUrl) : undefined;
        return {
          ...proposal,
          sources: source ? [{ title: source.title, url: source.url, publishedAt: source.publishedAt }] : [],
          expiresAt: proposal.expiresAt ?? new Date(input.now.getTime() + 21 * 86_400_000).toISOString(),
        };
      });
    return {
      proposals: timely,
      errors: [],
      rejected: parsedBatch.rejected,
      truncations: parsedBatch.truncations,
      summary: text(asRecord(parsed).summary)?.slice(0, 400) ?? null,
      model: config.model,
    };
  } catch (error) {
    return {
      proposals: [],
      errors: [
        `timely: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`,
      ],
      rejected: [],
      truncations: [],
      summary: null,
      model: config.model,
    };
  }
}

/**
 * Technical findings get their own call. In the cluster batch the model
 * consistently spent its proposal budget on content, so crawl defects were
 * never proposed even when they were the cheapest work on the board.
 */
export async function draftTechnicalProposals(input: DraftInput): Promise<DraftResult> {
  const config = contentWriterConfig();
  if (!config) {
    return { proposals: [], errors: ["CONTENT_LLM_API_KEY is not configured"], rejected: [], truncations: [], summary: null, model: null };
  }
  const findings = input.technicalEvidence ?? [];
  if (findings.length === 0) {
    return { proposals: [], errors: [], rejected: [], truncations: [], summary: null, model: config.model };
  }
  const allowedEvidence = new Map(findings.map((row) => [row.id, row]));
  const payload = {
    ...businessPayload(input),
    findings: findings.slice(0, 8).map((row) => ({
      evidenceId: row.id,
      issue: row.issue ?? row.kind,
      url: row.url,
      pages: row.pages ?? 1,
    })),
  };
  const system = [
    "You are an SEO engineer reviewing crawl findings for one site.",
    "Write in the business's language, given in locale.language.",
    "Each finding is a defect with an evidence id, a sample URL and how many pages share it. A defect on many pages is one delivery, not many.",
    "Decide which findings are worth a proposal. A defect that blocks indexing, wastes crawl budget, splits signals or breaks navigation is worth proposing; a cosmetic one is not. It is correct to propose nothing, but say why in the summary.",
    "Use only the supplied evidence ids. Return exactly one JSON object: { summary: string, proposals: [{ lane, kind, title, summary, whyNow, target: { url, newAsset, section }, action, expectedOutcome, effort, confidence, confidenceReason, evidenceIds: string[] }] }.",
    "lane must be technical and kind must be technical. target.url is the affected URL, newAsset is false. effort is small, medium, large or unknown. confidence is high, medium or low with a reason.",
    "Do not invent a defect that is not in the findings, and do not turn a crawl defect into a content brief.",
  ].join("\n");
  try {
    const parsed = await chatJson({
      config,
      system,
      user: JSON.stringify(payload),
      maxTokens: 16_000,
      temperature: 0.2,
      attempts: 2,
      timeoutMs: 180_000,
      jsonMode: false,
    });
    const parsedBatch = parseProposals(parsed, input, allowedEvidence, input.map.clusters);
    // This call only reviews crawl findings, so its output is technical work by
    // construction. A model that labels it "update" is still proposing a fix.
    const proposals = parsedBatch.proposals.map((proposal) => {
      const url = proposal.target.url ?? allowedEvidence.get(proposal.evidenceRefs[0])?.url ?? null;
      const technical = {
        ...proposal,
        lane: "technical" as const,
        kind: "technical" as const,
        target: { url, newAsset: false, section: proposal.target.section ?? "crawl fix" },
      };
      return { ...technical, dedupKey: proposalIdentity(technical) };
    });
    return {
      proposals,
      errors: [],
      rejected: parsedBatch.rejected,
      truncations: parsedBatch.truncations,
      summary: text(asRecord(parsed).summary)?.slice(0, 400) ?? null,
      model: config.model,
    };
  } catch (error) {
    return {
      proposals: [],
      errors: [`technical: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`],
      rejected: [],
      truncations: [],
      summary: null,
      model: config.model,
    };
  }
}

/**
 * The monthly pass drafts content, AEO and technical work. Timely work belongs
 * to the weekly sweep, which has this week's news; drafting it here as well
 * produced a second timely lane from month-old bundle sources.
 */
export async function draftProposals(input: DraftInput): Promise<DraftResult> {
  const clusters = await draftClusterProposals(input);
  const technical = await draftTechnicalProposals(input);
  return {
    proposals: [...clusters.proposals, ...technical.proposals],
    errors: [...clusters.errors, ...technical.errors],
    rejected: [...clusters.rejected, ...technical.rejected],
    truncations: [...clusters.truncations, ...technical.truncations],
    summary:
      [
        clusters.summary ? `Content and AEO: ${clusters.summary}` : null,
        technical.summary ? `Technical: ${technical.summary}` : null,
      ]
        .filter(Boolean)
        .join("\n\n") || null,
    model: clusters.model ?? technical.model,
  };
}
