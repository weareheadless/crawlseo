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
  now: Date;
};

export type DraftResult = {
  proposals: Proposal[];
  errors: string[];
  model: string | null;
};

/** Product rule: a story older than this is not timely. */
const TIMELY_WINDOW_DAYS = 21;
const CLUSTER_BATCH = 6;
const MAX_CLUSTERS = 24;
const MAX_PROPOSALS_PER_BATCH = 6;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Identity is the asset, not the wording. A proposal that updates /lampes and a
 * proposal that rewrites it are the same board row; the model may change the
 * title and action on every run without growing the board.
 */
export function proposalIdentity(proposal: Pick<Proposal, "lane" | "target" | "topicSlug">): string {
  const asset = proposal.target.url
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
    coverage: cluster.coverage,
    marketScope: cluster.marketScope,
    demand: cluster.metrics,
    gaps: cluster.gaps.slice(0, 5),
    outOfMarket: cluster.excludedQueries.slice(0, 5),
    queries: cluster.queries.slice(0, 6).map((query) => ({
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
    evidence: evidence.slice(0, 8),
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
  "You receive the business, its market scope, its topic clusters with measured Search Console demand, the pages that cover each topic, and the evidence rows the map cites.",
  "Decide for each cluster whether there is work worth proposing. It is correct to propose nothing for a cluster: say why in the batch summary.",
  "Use only the supplied facts, page URLs and evidence ids. Never invent a metric, a page, a query or an evidence id.",
  "Respect the market scope. A local offer is limited to the business location and service area; a national or international offer is not. Queries listed under outOfMarket are already excluded: never build a proposal on them.",
  "Do not assume a product range exists or does not exist. If demand names a format or service the supplied pages do not cover, the proposal is a decision for the owner, not an assumption.",
  "A low-demand cluster can still deserve a small test when it is business-relevant. Say so and set confidence accordingly.",
  "Set confidence from the strength of the cited evidence: high only when first-party search data supports the action directly, medium when the data is directional, low for a test or an owner decision. Give a confidenceReason that describes the evidence in plain words for the owner; do not paste evidence ids into it.",
  "Target an existing page URL from the supplied pages when the work updates a page. Use newAsset true and a path only when a new page is genuinely required.",
  "Return exactly one JSON object: { summary: string, proposals: [{ lane, kind, title, summary, whyNow, topicSlug, target: { url, newAsset, section }, action, expectedOutcome, effort, confidence, confidenceReason, evidenceIds: string[], expiresAt }] }.",
  "lane is one of timely, content_business, aeo_geo. kind is article, update, cluster_hub, business or aeo. effort is small, medium, large or unknown. confidence is high, medium or low.",
  "kind business is an owner decision about the offer with no page to build. When the work creates a page, use article for a new content page and cluster_hub for a hub or category page.",
  "Use lane aeo_geo when the proposal rests on measured AI Overview observations and the work is answer blocks on a page that already exists.",
  "Every proposal needs at least one evidenceId from the supplied evidence for its cluster. Keep titles under 120 characters, summaries under 300, actions under 600, confidenceReason under 200.",
].join("\n");

function parseProposals(
  parsed: unknown,
  input: DraftInput,
  allowedEvidence: Map<string, DraftEvidence>,
  batchClusters: TopicCluster[]
): Proposal[] {
  const record = asRecord(parsed);
  const rows = Array.isArray(record.proposals) ? record.proposals.slice(0, MAX_PROPOSALS_PER_BATCH) : [];
  const slugs = new Set(batchClusters.map((cluster) => cluster.slug));
  const proposals: Proposal[] = [];
  for (const raw of rows) {
    const row = asRecord(raw);
    let lane = text(row.lane) as ProposalLane | null;
    let kind = text(row.kind) as ProposalKind | null;
    const effort = (text(row.effort) as ProposalEffort | null) ?? "unknown";
    const confidenceRaw = text(row.confidence);
    const confidence = confidenceRaw && CONFIDENCES.includes(confidenceRaw as ProposalConfidence)
      ? (confidenceRaw as ProposalConfidence)
      : null;
    const title = text(row.title);
    const summary = text(row.summary);
    const action = text(row.action);
    const expectedOutcome = text(row.expectedOutcome);
    const topicSlug = text(row.topicSlug);
    const target = asRecord(row.target);
    const evidenceIds = Array.isArray(row.evidenceIds)
      ? row.evidenceIds.filter((id): id is string => typeof id === "string")
      : [];
    if (!lane || !LANES.includes(lane)) continue;
    if (!kind || !KINDS.includes(kind)) continue;
    if (!EFFORTS.includes(effort)) continue;
    if (!title || !summary || !action || !expectedOutcome) continue;
    if (!topicSlug || !slugs.has(topicSlug)) continue;
    const known = evidenceIds.filter((id) => allowedEvidence.has(id));
    if (known.length === 0) continue;
    // A proposal that rests only on measured AI Overview observations is an
    // AEO proposal, whatever lane the model labelled it with. The lane then
    // reflects the evidence rather than a naming choice.
    if (known.every((id) => allowedEvidence.get(id)?.kind === "ai_visibility_observation")) {
      lane = "aeo_geo";
      kind = "aeo";
    }
    const url = text(target.url);
    const newAsset = bool(target.newAsset) ?? false;
    const confidenceReason = text(row.confidenceReason);
    // Expiry is a timely concept. A content proposal is not "expired" because
    // a date passed, so a stray date from the model is dropped.
    const expiresAt = lane === "timely" ? text(row.expiresAt) : null;
    proposals.push({
      dedupKey: "",
      lane,
      kind,
      title: title.slice(0, 160),
      summary: summary.slice(0, 400),
      whyNow: text(row.whyNow)?.slice(0, 400) ?? null,
      evidenceRefs: [...new Set([...input.knowledgeEvidenceIds.slice(0, 2), ...known])].slice(0, 10),
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
    });
  }
  return proposals;
}

export async function draftClusterProposals(input: DraftInput): Promise<DraftResult> {
  const config = contentWriterConfig();
  if (!config) return { proposals: [], errors: ["CONTENT_LLM_API_KEY is not configured"], model: null };

  const clusters = input.map.clusters
    .filter((cluster) => cluster.queries.length > 0 || cluster.coverage !== "none")
    .slice(0, MAX_CLUSTERS);
  const allowedEvidence = new Map<string, DraftEvidence>();
  for (const cluster of clusters) {
    for (const row of input.evidenceByCluster.get(cluster.slug) ?? []) allowedEvidence.set(row.id, row);
  }

  const proposals: Proposal[] = [];
  const errors: string[] = [];
  for (let index = 0; index < clusters.length; index += CLUSTER_BATCH) {
    const batch = clusters.slice(index, index + CLUSTER_BATCH);
    const payload = {
      ...businessPayload(input),
      aeoQuestions: input.aeoQuestions.slice(0, 12),
      clusters: batch.map((cluster) =>
        clusterPayload(cluster, input.evidenceByCluster.get(cluster.slug) ?? [])
      ),
    };
    try {
      const parsed = await chatJson({
        config,
        system: SYSTEM,
        user: JSON.stringify(payload),
        maxTokens: 16_000,
        temperature: 0.2,
        attempts: 2,
        timeoutMs: 180_000,
        jsonMode: false,
      });
      proposals.push(...parseProposals(parsed, input, allowedEvidence, batch));
    } catch (error) {
      errors.push(
        `clusters ${batch.map((cluster) => cluster.slug).join(", ")}: ${
          error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
        }`
      );
    }
  }
  return { proposals, errors, model: config.model };
}

export async function draftTimelyProposals(input: DraftInput): Promise<DraftResult> {
  const config = contentWriterConfig();
  if (!config) return { proposals: [], errors: ["CONTENT_LLM_API_KEY is not configured"], model: null };
  const current = input.news.filter(
    (item) => item.publishedAt && input.now.getTime() - Date.parse(item.publishedAt) <= TIMELY_WINDOW_DAYS * 86_400_000
  );
  if (current.length === 0) {
    return {
      proposals: [],
      errors: input.news.length > 0 ? [`no news source within ${TIMELY_WINDOW_DAYS} days`] : [],
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
  const evidence = new Map<string, DraftEvidence>();
  for (const cluster of evidenceClusters.slice(0, 2)) {
    for (const row of input.evidenceByCluster.get(cluster.slug) ?? []) evidence.set(row.id, row);
  }
  const payload = {
    ...businessPayload(input),
    news: current.slice(0, 8),
    localClusters: evidenceClusters.slice(0, 3).map((cluster) => ({
      slug: cluster.slug,
      name: cluster.name,
      marketScope: cluster.marketScope,
      demand: cluster.metrics,
      evidence: (input.evidenceByCluster.get(cluster.slug) ?? []).slice(0, 6),
    })),
  };
  const system = [
    "You are an SEO strategist reviewing this week's news for one business.",
    "Decide whether any item is a real, current opportunity for this business. A local news item that does not concern the business's market, trade or customers is not an opportunity: propose nothing.",
    "Use the business location and service area to judge whether the story is in the business's market. Judge the place the story names; do not use a fixed list of cities.",
    "A story older than 21 days is not current: do not propose it. A timely proposal must expire; set expiresAt to the date the story stops being current, at most 30 days from today.",
    "Use only the supplied evidence ids. Return exactly one JSON object: { summary: string, proposals: [{ lane, kind, title, summary, whyNow, topicSlug, target: { url, newAsset, section }, action, expectedOutcome, effort, confidence, confidenceReason, evidenceIds: string[], expiresAt, sourceUrl }] }.",
    "lane must be timely. kind is article, update or business. Every proposal needs at least one evidenceId and one sourceUrl from the supplied news.",
  ].join("\n");

  try {
    const parsed = await chatJson({
      config,
      system,
      user: JSON.stringify(payload),
      maxTokens: 12_000,
      temperature: 0.2,
      attempts: 2,
      timeoutMs: 180_000,
      jsonMode: false,
    });
    // The evidence is restricted to the local clusters, but a timely proposal
    // may attach to any real cluster in the map.
    const proposals = parseProposals(parsed, input, evidence, input.map.clusters);
    const byUrl = new Map(current.map((item) => [item.url, item]));
    const timely = proposals
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
    return { proposals: timely, errors: [], model: config.model };
  } catch (error) {
    return {
      proposals: [],
      errors: [
        `timely: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`,
      ],
      model: config.model,
    };
  }
}

export async function draftProposals(input: DraftInput): Promise<DraftResult> {
  const clusters = await draftClusterProposals(input);
  const timely = await draftTimelyProposals(input);
  return {
    proposals: [...clusters.proposals, ...timely.proposals],
    errors: [...clusters.errors, ...timely.errors],
    model: clusters.model ?? timely.model,
  };
}
