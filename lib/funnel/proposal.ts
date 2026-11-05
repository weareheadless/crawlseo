import type { OpportunityDimension } from "@prisma/client";

/**
 * The Phase 3 proposal contract, read from `Opportunity.recommendationDecision`.
 *
 * It is deliberately smaller than the old 13-field decision schema: the bundle
 * and topic map already hold the evidence; a proposal only needs to say what to
 * do, where, why now and how success is measured. The board and the acceptance
 * gate share this parser so the page and the task cannot disagree.
 */

export type OpportunityLane = "timely" | "content_business" | "aeo_geo" | "technical";
export type OpportunityProposalKind = "article" | "update" | "cluster_hub" | "business" | "aeo" | "technical";
export type OpportunityProposalEffort = "small" | "medium" | "large" | "unknown";
export type OpportunityProposalConfidence = "high" | "medium" | "low";

export type OpportunityProposal = {
  schemaVersion: "phase3-v1";
  source: "phase3-topic-map";
  lane: OpportunityLane;
  kind: OpportunityProposalKind;
  readiness: "actionable" | "needs_investigation";
  title: string;
  summary: string;
  whyNow: string | null;
  evidenceRefs: string[];
  target: { url: string | null; newAsset: boolean; section: string | null };
  action: string;
  expectedOutcome: string;
  effort: OpportunityProposalEffort;
  confidence: OpportunityProposalConfidence;
  expiresAt: string | null;
  topicSlug: string | null;
  sources: Array<{ title: string; url: string; publishedAt: string | null }>;
  critique: { verdict: "keep" | "revise" | "drop"; reason: string } | null;
};

export const OPPORTUNITY_LANES: ReadonlyArray<{
  key: OpportunityLane;
  label: string;
  description: string;
}> = [
  { key: "timely", label: "Timely", description: "Events, news, regulation and market changes with a real why-now." },
  { key: "content_business", label: "Content & business", description: "Article ideas, updates, cluster hubs and offer/positioning gaps." },
  { key: "aeo_geo", label: "AEO/GEO", description: "Measured AI Overview and AI-surface citation gaps." },
  { key: "technical", label: "Technical", description: "Crawl, schema, canonical, performance and broken links." },
];

export function fallbackLane(dimension: OpportunityDimension | string): OpportunityLane {
  if (dimension === "aeo" || dimension === "geo") return "aeo_geo";
  if (dimension === "technical") return "technical";
  return "content_business";
}

export function laneLabel(lane: OpportunityLane | string | null | undefined): string {
  return OPPORTUNITY_LANES.find((entry) => entry.key === lane)?.label ?? "Content & business";
}

export function parseOpportunityProposal(value: unknown): OpportunityProposal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== "phase3-v1" || row.source !== "phase3-topic-map") return null;
  const lane = row.lane;
  const kind = row.kind;
  const readiness = row.readiness;
  if (!["timely", "content_business", "aeo_geo", "technical"].includes(String(lane))) return null;
  if (!["article", "update", "cluster_hub", "business", "aeo", "technical"].includes(String(kind))) return null;
  if (!["actionable", "needs_investigation"].includes(String(readiness))) return null;
  const target = row.target && typeof row.target === "object" && !Array.isArray(row.target)
    ? (row.target as Record<string, unknown>)
    : null;
  if (!target) return null;
  const text = (key: string) => (typeof row[key] === "string" ? (row[key] as string) : "");
  return {
    schemaVersion: "phase3-v1",
    source: "phase3-topic-map",
    lane: lane as OpportunityLane,
    kind: kind as OpportunityProposalKind,
    readiness: readiness as "actionable" | "needs_investigation",
    title: text("title"),
    summary: text("summary"),
    whyNow: typeof row.whyNow === "string" ? row.whyNow : null,
    evidenceRefs: Array.isArray(row.evidenceRefs)
      ? row.evidenceRefs.filter((id): id is string => typeof id === "string")
      : [],
    target: {
      url: typeof target.url === "string" ? target.url : null,
      newAsset: target.newAsset === true,
      section: typeof target.section === "string" ? target.section : null,
    },
    action: text("action"),
    expectedOutcome: text("expectedOutcome"),
    effort: (["small", "medium", "large", "unknown"].includes(String(row.effort))
      ? row.effort
      : "unknown") as OpportunityProposalEffort,
    confidence: (["high", "medium", "low"].includes(String(row.confidence))
      ? row.confidence
      : "medium") as OpportunityProposalConfidence,
    expiresAt: typeof row.expiresAt === "string" ? row.expiresAt : null,
    topicSlug: typeof row.topicSlug === "string" ? row.topicSlug : null,
    sources: Array.isArray(row.sources)
      ? row.sources.flatMap((source) => {
          if (!source || typeof source !== "object" || Array.isArray(source)) return [];
          const entry = source as Record<string, unknown>;
          if (typeof entry.url !== "string") return [];
          return [{
            title: typeof entry.title === "string" ? entry.title : "",
            url: entry.url,
            publishedAt: typeof entry.publishedAt === "string" ? entry.publishedAt : null,
          }];
        })
      : [],
    critique: row.critique && typeof row.critique === "object" && !Array.isArray(row.critique)
      ? (() => {
          const critique = row.critique as Record<string, unknown>;
          const verdict = critique.verdict;
          if (!["keep", "revise", "drop"].includes(String(verdict))) return null;
          return {
            verdict: verdict as "keep" | "revise" | "drop",
            reason: typeof critique.reason === "string" ? critique.reason : "",
          };
        })()
      : null,
  };
}
