import { type DemandMapCluster, type EvidenceRecord, type OpportunityDimension, type OpportunityType, type PrismaClient } from "@prisma/client";

import type { OpportunityDb } from "@/lib/funnel/opportunity";
import { upsertOpportunity, applyHysteresis } from "@/lib/funnel/opportunity";
import type { ScoreInputs } from "@/lib/funnel/scoring";
import { ctrAtPosition, rankDistanceFactor, freshnessFactor } from "@/lib/funnel/scoring";

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
  lowCtr: 0.02,
  minCompetitorSubtopics: 2,
  minReferringDomainGap: 3,
  maxLcpSeconds: 2.5,
  freshnessDecayDelta: 3,
  minClusterQueries: 3,
  maxClusterCoverage: 0.34,
  /** below this score a `detected` opportunity parks (hysteresis) */
  hysteresis: 3,
} as const;

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
};

function byKind(evidence: Evidence[], kind: string): Evidence[] {
  return evidence.filter((row) => row.kind === kind);
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
    detect: (evidence) =>
      byKind(evidence, "keyword_rank")
        .filter((row) => {
          const position = num(row, "provider:position") ?? num(row, "first_party:position");
          const volume = num(row, "provider:volume") ?? 0;
          return position != null && position >= 4 && position <= 10 && volume >= DETECTOR_THRESHOLDS.minVolume;
        })
        .map((row) => {
          const position = num(row, "provider:position") ?? num(row, "first_party:position")!;
          const volume = num(row, "provider:volume") ?? 0;
          return {
            type: "O1_winnable_rank" as const,
            title: `Winnable rank: "${dim(row, "query")}" at position ${Math.round(position)}`,
            summary: `Our page ranks ${Math.round(position)} for a keyword with ${Math.round(volume)} searches/month — a few ranks to win.`,
            dedupKey: `O1:${dim(row, "query")}:${dim(row, "url") ?? ""}`,
            clusterSlug: dim(row, "cluster"),
            whyEvidenceIds: [],
            howEvidenceIds: [row.id],
            scoreInputs: scoreDefaults({
              worth: { volume, ctrAtPosition: ctrAtPosition(position), businessValue: 0.7 },
              winProbability: { rankDistance: rankDistanceFactor(position) },
              effort: { playTypeBase: 6, sizeFactor: 1 },
              freshness: freshnessFactor(row.observedAt, new Date()),
            }),
          };
        }),
  },
  {
    type: "O2_striking_distance",
    detect: (evidence) =>
      byKind(evidence, "keyword_rank")
        .filter((row) => {
          const position = num(row, "provider:position") ?? num(row, "first_party:position");
          const ctr = num(row, "first_party:ctr");
          const impressions = num(row, "first_party:impressions") ?? 0;
          return position != null && position > 10 && position <= 20 && ctr != null && ctr <= DETECTOR_THRESHOLDS.lowCtr && impressions > 0;
        })
        .map((row) => {
          const position = num(row, "provider:position") ?? num(row, "first_party:position")!;
          const impressions = num(row, "first_party:impressions") ?? 0;
          return {
            type: "O2_striking_distance" as const,
            title: `Striking distance: "${dim(row, "query")}" gets impressions, no clicks`,
            summary: `Position ${Math.round(position)} with ${Math.round(impressions)} impressions and low CTR — the title/meta is not earning the click.`,
            dedupKey: `O2:${dim(row, "query")}:${dim(row, "url") ?? ""}`,
            clusterSlug: dim(row, "cluster"),
            whyEvidenceIds: [],
            howEvidenceIds: [row.id],
            scoreInputs: scoreDefaults({
              worth: { volume: impressions, ctrAtPosition: ctrAtPosition(position), businessValue: 0.5 },
              winProbability: { rankDistance: rankDistanceFactor(position) },
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
              worth: { volume: num(row, "provider:askCount") ?? 0, ctrAtPosition: null, businessValue: 0.8 },
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
              worth: { volume: null, ctrAtPosition: null, businessValue: 0.5 },
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
    detect: (evidence) =>
      byKind(evidence, "onpage_crawl")
        .filter((row) => (num(row, "first_party:issueCount") ?? 0) > 0 && dim(row, "impact") === "crawlability")
        .map((row) => ({
          type: "O7_technical_defect" as const,
          title: `${humanizeIssue(dim(row, "issueType"))} on ${dim(row, "url") ?? "site"}`,
          summary: `Crawl found ${plural(num(row, "first_party:issueCount") ?? 0, "issue", "issues")} with crawlability or user impact on this page.`,
          dedupKey: `O7:${dim(row, "url")}:${dim(row, "issueType") ?? ""}`,
          clusterSlug: dim(row, "cluster"),
          whyEvidenceIds: [],
          howEvidenceIds: [row.id],
          scoreInputs: scoreDefaults({
            worth: { volume: null, ctrAtPosition: null, businessValue: 0.5 },
            winProbability: { playTypeFactor: 0.9 },
            effort: { playTypeBase: 3, sizeFactor: 1 },
            freshness: freshnessFactor(row.observedAt, new Date()),
          }),
        })),
  },
  {
    type: "O8_structured_data_gap",
    detect: (evidence) => {
      const knowledge = byKind(evidence, "knowledge_fact");
      return byKind(evidence, "onpage_crawl")
        .filter((row) => dim(row, "schemaMissing") === "true" && dim(row, "impact") === "structured_data")
        .map((row) => ({
          type: "O8_structured_data_gap" as const,
          title: `Missing structured data on ${dim(row, "url") ?? "page"}`,
          summary: `No ${dim(row, "schemaType") ?? "identity"} schema on this page, so answer engines and rich results cannot read who the business is.`,
          dedupKey: `O8:${dim(row, "url")}:${dim(row, "schemaType") ?? ""}`,
          clusterSlug: dim(row, "cluster"),
          whyEvidenceIds: knowledge.slice(0, 1).map((k) => k.id),
          howEvidenceIds: [row.id],
          scoreInputs: scoreDefaults({
            worth: { volume: null, ctrAtPosition: null, businessValue: 0.6 },
            winProbability: { playTypeFactor: 1.0 },
            effort: { playTypeBase: 2, sizeFactor: 1 },
            freshness: freshnessFactor(row.observedAt, new Date()),
          }),
        }));
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
    detect: (evidence) => {
      const urlsByQuery = group(
        byKind(evidence, "keyword_rank"),
        byQuery
      );
      const candidates: DetectorCandidate[] = [];
      for (const [query, rows] of urlsByQuery) {
        const urls = new Set(rows.map((row) => dim(row, "url") ?? "").filter(Boolean));
        if (urls.size >= 2) {
          const [first, ...rest] = rows;
          candidates.push({
            type: "O10_cannibalization",
            title: `Cannibalization: ${urls.size} URLs split "${query}"`,
            summary: `Multiple our-URLs compete for one query — consolidate.`,
            dedupKey: `O10:${query}`,
            clusterSlug: dim(first, "cluster"),
            whyEvidenceIds: [],
            howEvidenceIds: rows.map((r) => r.id),
            scoreInputs: scoreDefaults({
              worth: { volume: num(first, "provider:volume") ?? 0, ctrAtPosition: ctrAtPosition(8), businessValue: 0.6 },
              winProbability: { rankDistance: 0.6, playTypeFactor: 0.8 },
              effort: { playTypeBase: 4, sizeFactor: 1 },
              freshness: freshnessFactor(first.observedAt, new Date()),
            }),
          });
          void rest;
        }
      }
      return candidates;
    },
  },
  {
    type: "O11_freshness_decay",
    detect: (evidence) => {
      const series = group(byKind(evidence, "keyword_rank"), (row) => `${byQuery(row)}|${dim(row, "url") ?? ""}`);
      const candidates: DetectorCandidate[] = [];
      for (const rows of series.values()) {
        if (rows.length < 2) continue;
        const sorted = [...rows].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
        const first = num(sorted[0], "provider:position") ?? num(sorted[0], "first_party:position");
        const last = num(sorted[sorted.length - 1], "provider:position") ?? num(sorted[sorted.length - 1], "first_party:position");
        if (first != null && last != null && last - first >= DETECTOR_THRESHOLDS.freshnessDecayDelta) {
          candidates.push({
            type: "O11_freshness_decay",
            title: `Freshness decay on "${byQuery(sorted[0])}"`,
            summary: `Position moved from ${Math.round(first)} to ${Math.round(last)} over the observed window.`,
            dedupKey: `O11:${byQuery(sorted[0])}:${dim(sorted[0], "url") ?? ""}`,
            clusterSlug: dim(sorted[0], "cluster"),
            whyEvidenceIds: [],
            howEvidenceIds: [sorted[0].id, sorted[sorted.length - 1].id],
            scoreInputs: scoreDefaults({
              worth: { volume: num(sorted[0], "provider:volume") ?? 0, ctrAtPosition: ctrAtPosition(last), businessValue: 0.6 },
              winProbability: { rankDistance: rankDistanceFactor(last) },
              effort: { playTypeBase: 5, sizeFactor: 1 },
              freshness: freshnessFactor(sorted[sorted.length - 1].observedAt, new Date()),
            }),
          });
        }
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
    detect: (evidence) =>
      byKind(evidence, "research_finding")
        .filter((row) => dim(row, "painPoint") === "true")
        .map((row) => ({
          type: "O13_user_pain_point" as const,
          title: `User pain point without content: ${dim(row, "painPointSummary") ?? dim(row, "question") ?? "need"}`,
          summary: `Research surfaced a real customer need with no (or weak) on-site answer — awaiting keyword validation.`,
          dedupKey: `O13:${dim(row, "painPointSummary") ?? dim(row, "question") ?? row.id}`,
          clusterSlug: dim(row, "cluster"),
          whyEvidenceIds: [row.id],
          howEvidenceIds: [],
          scoreInputs: scoreDefaults({
            worth: { volume: null, ctrAtPosition: null, businessValue: 0.9 },
            winProbability: { playTypeFactor: 0.5 },
            effort: { playTypeBase: 16, sizeFactor: 1 },
            freshness: freshnessFactor(row.observedAt, new Date()),
          }),
        })),
  },
  {
    type: "O14_offer_positioning_gap",
    detect: (evidence) =>
      byKind(evidence, "research_finding")
        .filter((row) => dim(row, "positioningGap") === "true")
        .map((row) => ({
          type: "O14_offer_positioning_gap" as const,
          title: `Positioning gap: ${dim(row, "gapSummary") ?? "competitors position an offer we do not articulate"}`,
          summary: `Research + SERP show a positioning gap worth a content/positioning update.`,
          dedupKey: `O14:${dim(row, "gapSummary") ?? row.id}`,
          clusterSlug: dim(row, "cluster"),
          whyEvidenceIds: [row.id],
          howEvidenceIds: [],
          scoreInputs: scoreDefaults({
            worth: { volume: null, ctrAtPosition: null, businessValue: 0.8 },
            winProbability: { playTypeFactor: 0.5 },
            effort: { playTypeBase: 12, sizeFactor: 1 },
            freshness: freshnessFactor(row.observedAt, new Date()),
          }),
        })),
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
    });
    if (membership.length < DETECTOR_THRESHOLDS.minClusterQueries) continue;
    const ranks = await db.evidenceRecord.findMany({
      where: { projectId, kind: "keyword_rank", supersededById: null, dimensions: { path: ["cluster"], equals: cluster.slug } },
    });
    const coverage = ranks.length / membership.length;
    if (coverage <= DETECTOR_THRESHOLDS.maxClusterCoverage) {
      candidates.push({
        type: "O3_content_gap",
        title: `Cluster play: build topical authority for "${cluster.name}"`,
        summary: `${cluster.slug} has ${membership.length} tracked queries but only ${ranks.length} ranking pages — a topic hub can close the cluster.`,
        dedupKey: `O3:cluster:${cluster.slug}`,
        clusterSlug: cluster.slug,
        whyEvidenceIds: [],
        howEvidenceIds: membership.slice(0, 1).map((m) => m.id),
        scoreInputs: scoreDefaults({
          worth: { volume: membership.length * 20, ctrAtPosition: ctrAtPosition(5), businessValue: 0.8 },
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
};

/** Run every detector for a project, upsert opportunities, then hysteresis. */
export async function runDetectors(
  db: DetectorDb,
  projectId: string,
  opts: { detectedBy?: string; now?: Date } = {}
): Promise<DetectorRunResult> {
  const detectedBy = opts.detectedBy ?? "funnel-detectors";
  const now = opts.now ?? new Date();
  const evidence = (await db.evidenceRecord.findMany({
    where: { projectId, supersededById: null },
  })) as Evidence[];

  let created = 0;
  let updated = 0;
  for (const detector of DETECTORS) {
    for (const candidate of detector.detect(evidence, { now })) {
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

  const parked = await applyHysteresis(db, { threshold: DETECTOR_THRESHOLDS.hysteresis, detectedBy });
  return { created, updated, parked };
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
