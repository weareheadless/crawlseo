import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { upsertOpportunity, type OpportunityDb } from "@/lib/funnel/opportunity";
import { assignQuery, type TopicCluster, type TopicMap } from "@/lib/research/topic-map";
import { taxonomyForDomain } from "@/lib/research/topic-taxonomy";

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

export type ProposalGroup = {
  members: string[];
  title: string;
  action: string;
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
  >;

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

const TYPE_FOR_PROPOSAL: Record<string, "O3_content_gap" | "O4_aeo_citation_gap" | "O11_freshness_decay" | "O14_offer_positioning_gap"> = {
  "content_business:article": "O3_content_gap",
  "content_business:update": "O3_content_gap",
  "content_business:cluster_hub": "O3_content_gap",
  "content_business:business": "O14_offer_positioning_gap",
  "aeo_geo:aeo": "O4_aeo_citation_gap",
  "timely:article": "O11_freshness_decay",
  "timely:update": "O11_freshness_decay",
  "timely:business": "O14_offer_positioning_gap",
};

const DIMENSION_FOR_TYPE = {
  O3_content_gap: "content",
  O4_aeo_citation_gap: "aeo",
  O11_freshness_decay: "seo",
  O14_offer_positioning_gap: "content",
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
  winProbability: Record<string, number>;
  effort: { playTypeBase: number; sizeFactor: number };
  freshness: number;
  stability: number;
} {
  const volume = cluster?.metrics.volume || cluster?.metrics.impressions || null;
  const businessValue = cluster?.relevance === "high" ? 0.85 : cluster?.relevance === "medium" ? 0.55 : 0.25;
  const sizeFactor = proposal.effort === "small" ? 0.5 : proposal.effort === "large" ? 2 : 1;
  return {
    worth: {
      volume,
      ctrAtPosition: volume ? 0.03 : null,
      businessValue,
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
      targetPosition: null,
      currentPosition: cluster?.metrics.position ?? null,
      windowDays: null,
      observedImpressions: cluster?.metrics.impressions ?? null,
      technical: false,
      unmeasured: !volume,
    },
    winProbability: {
      rankDistance: 0.5,
      authorityGap: 0.5,
      pageStrength: 0.5,
      serpCompetition: 0.5,
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
  groups: ProposalGroup[];
} {
  const decisions = new Map<string, { verdict: "keep" | "revise" | "drop"; reason: string }>();
  const groups: ProposalGroup[] = [];
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
    groups.push({
      members: group.map((proposal) => proposal.dedupKey),
      title: group[0].title,
      action: group.map((proposal) => proposal.action).join(" "),
    });
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
    groups,
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
  groups: ProposalGroup[];
}> {
  const config = contentWriterConfig();
  if (!config) {
    return { available: false, model: null, summary: null, error: "CONTENT_LLM_API_KEY is not configured", decisions: new Map(), groups: [] };
  }
  if (proposals.length === 0) {
    return { available: false, model: config.model, summary: null, error: "no proposals to critique", decisions: new Map(), groups: [] };
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
    "You are an SEO critic for a small craft business.",
    "Check each proposal for unsupported claims, duplicates and wrong target pages.",
    "Respect the tenant market scope: a local service is local, while a national or international product offer may be proposed beyond the local service area. The owner decides whether to add a product range.",
    "A low-demand but business-relevant local proposal is valid; do not drop it only because volume is low. Check whether it is a reasonable expansion or small test.",
    "Group proposals that are the same job on the same asset, or that overlap so closely that the owner should see one row: a page update and its answer blocks, a hub update and a product-range question about the same formats. A group is advice on presentation; it does not delete the members.",
    "Do not rewrite the proposals. Return exactly one JSON object: { summary: string, decisions: [{ dedupKey: string, verdict: 'keep'|'revise'|'drop', reason: string }], groups: [{ members: string[], title: string, action: string }] }.",
    "Use only the supplied dedupKeys. A group needs at least two members. Keep the summary under 300 characters, each reason under 200, each group title under 120 and each group action under 600.",
  ].join("\n");

  try {
    const parsed = await chatJson({
      config,
      system,
      user: JSON.stringify(payload),
      maxTokens: 12_000,
      temperature: 0.2,
      attempts: 2,
      timeoutMs: 120_000,
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
    const known = new Set(proposals.map((proposal) => proposal.dedupKey));
    const groups: ProposalGroup[] = [];
    for (const raw of Array.isArray(record.groups) ? record.groups : []) {
      const row = asRecord(raw);
      const members = Array.isArray(row.members)
        ? row.members.filter((key): key is string => typeof key === "string" && known.has(key))
        : [];
      const title = textValue(row.title);
      const action = textValue(row.action);
      if (members.length < 2 || !title || !action) continue;
      groups.push({ members: [...new Set(members)], title: title.slice(0, 160), action: action.slice(0, 900) });
    }
    return {
      available: true,
      model: config.model,
      summary: textValue(record.summary)?.slice(0, 800) ?? null,
      error: null,
      decisions,
      groups,
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
    knowledgeEvidenceIds: string[];
    clusters: Array<{ id: string; slug: string }>;
  }
): Promise<{ stored: Array<{ id: string; dedupKey: string }>; dropped: Array<{ title: string; reason: string }> }> {
  const stored: Array<{ id: string; dedupKey: string }> = [];
  const dropped: Array<{ title: string; reason: string }> = [];
  const clusterIdBySlug = new Map(input.clusters.map((cluster) => [cluster.slug, cluster.id]));

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
    const howEvidenceIds = proposal.evidenceRefs.filter((id) => !input.knowledgeEvidenceIds.includes(id)).slice(0, 8);
    const whyEvidenceIds = input.knowledgeEvidenceIds.slice(0, 2);
    try {
      // A refresh replaces the evidence this generated proposal rests on. Old
      // membership-only edges must not linger next to the new query/SERP edges.
      const existing = await db.opportunity.findUnique({
        where: { projectId_dedupKey: { projectId: input.projectId, dedupKey: proposal.dedupKey } },
        select: { id: true },
      });
      if (existing) {
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
        detectedBy: "phase3:topic-map",
        clusterId: proposal.topicSlug ? clusterIdBySlug.get(proposal.topicSlug) ?? null : null,
        scoreInputs: proposalScoreInputs(proposal, cluster) as never,
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
    } catch (error) {
      dropped.push({
        title: proposal.title,
        reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
    }
  }
  return { stored, dropped };
}

export function renderProposalBoard(input: {
  map: TopicMap;
  proposals: Proposal[];
  dropped: Array<{ title: string; reason: string }>;
  critique: { available: boolean; model: string | null; summary: string | null; error: string | null };
  technical: ProposalInputs["technical"];
  generatedAt: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Opportunity board — ${input.map.domain} — ${input.map.month}`);
  lines.push("");
  lines.push(`Generated ${input.generatedAt}. Proposals only; no task is created until a human accepts one.`);
  lines.push("");
  lines.push("## Lanes");
  lines.push("");
  const lanes: Array<{ lane: ProposalLane; title: string }> = [
    { lane: "timely", title: "Timely" },
    { lane: "content_business", title: "Content & business" },
    { lane: "aeo_geo", title: "AEO/GEO" },
    { lane: "technical", title: "Technical" },
  ];
  for (const lane of lanes) {
    const laneProposals = input.proposals.filter((proposal) => proposal.lane === lane.lane);
    lines.push(`### ${lane.title}`);
    lines.push("");
    if (lane.lane === "technical") {
      if (input.technical.length === 0) lines.push("No existing technical opportunity in the current board.");
      for (const row of input.technical) {
        lines.push(`- **${row.title}** (${row.type}, score ${row.scoreValue ?? "—"}) — ${row.summary}`);
      }
      lines.push("");
      continue;
    }
    if (laneProposals.length === 0) {
      lines.push("No proposal in this lane.");
      lines.push("");
      continue;
    }
    for (const proposal of laneProposals) {
      lines.push(`#### ${proposal.title}`);
      lines.push("");
      lines.push(`- Kind: ${proposal.kind}; effort: ${proposal.effort}; confidence: ${proposal.confidence ?? "not assessed"}${proposal.confidenceReason ? ` (${proposal.confidenceReason})` : ""}`);
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
  lines.push("## Critique");
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
    lines.push("Merged or not stored:");
    lines.push("");
    for (const row of input.dropped) lines.push(`- ${row.title} — ${row.reason}`);
    lines.push("");
  }
  lines.push("## Limits");
  lines.push("");
  lines.push("- This board is a proposal set, not accepted work. No task, delivery or publication is created.");
  lines.push("- Proposals are drafted from the reviewed topic map and its cited evidence; the critique can challenge or group them but cannot add queries, pages or evidence.");
  lines.push("- A business proposal with no target page is an investigation, not an article.");
  lines.push("- Technical items are the existing board opportunities; this phase does not re-score or replace them.");
  lines.push("");
  return lines.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
