import type { PrismaClient } from "@prisma/client";

import type {
  EvidenceRecordKind,
  OpportunityDimension,
  OpportunityStatus,
  OpportunityType,
  TaskStatus,
} from "@prisma/client";

import { fallbackLane, parseOpportunityProposal, type OpportunityLane, type OpportunityProposal } from "@/lib/funnel/proposal";
import { parsePersistedDecision, type RecommendationDecision } from "@/lib/recommendation/contracts";

/**
 * Funnel read models (docs/seo-funnel-spine-plan.md §5).
 *
 * Every surface reads from here, so the UI is a projection of the schema rather
 * than a second interpretation of it. Read-only by contract: no paid calls, no
 * mutation, no synthesised numbers. A value the store does not have is `null`
 * and the UI must render it as "unknown", never as zero.
 */

export type FunnelDb = Pick<
  PrismaClient,
  | "opportunity"
  | "evidenceRecord"
  | "evidenceEdge"
  | "task"
  | "baseline"
  | "outcomeObservation"
  | "demandMapCluster"
  | "site"
  | "project"
>;

export type EvidenceLeg = "why" | "how";

export type EvidenceLine = {
  id: string;
  kind: EvidenceRecordKind;
  producer: string;
  observedAt: Date;
  leg: EvidenceLeg;
  /** Human-readable decisive line, built from dimensions + metrics. */
  headline: string;
  /** Metric chips with declared unit and source, for the provenance badge. */
  metrics: Array<{ label: string; value: number | null; unit: string; source: string }>;
};

export type OpportunityRow = {
  id: string;
  type: OpportunityType;
  status: OpportunityStatus;
  dimension: OpportunityDimension;
  title: string;
  summary: string;
  score: number | null;
  completeness: string;
  detectedBy: string;
  firstDetectedAt: Date;
  clusterSlug: string | null;
  /** One line of decisive evidence: the reason this row exists. */
  reason: string | null;
  evidenceCount: number;
  /** Readiness from the decision contract, so the board can separate work from questions. */
  readiness: string | null;
  measurement: string | null;
  /** The Phase 3 lane, explicit when the row carries the proposal contract. */
  lane: OpportunityLane;
  /** The minimal Phase 3 proposal, when this row has one. */
  proposal: OpportunityProposal | null;
};

export type OpportunityDetail = OpportunityRow & {
  scoreInputs: unknown;
  /** The complete canonical decision, when this row has one. */
  recommendation: RecommendationDecision | null;
  /** True when the accepted task predates the current decision. */
  decisionChanged: boolean;
  /** The decision the board and the detail page both render. */
  decision: {
    readiness: string | null;
    measurement: string | null;
    track: string | null;
    intervention: string | null;
    benefit: string | null;
    /** The assessed change and its target, not a reconstructed generic sentence. */
    change: string | null;
    targetPages: string[];
    successMeasure: string | null;
    uncertainty: string[];
    coverage: string | null;
    coverageDetail: Array<{ pageId: string; url: string | null; state: string; rationale: string; excerpts: string[] }>;
    premise: { state: string; rationale: string } | null;
    investigation: { kind?: string; question: string; inspect: string[]; decisionCriteria: string[]; deliverable: string } | null;
    benefits: Array<{ track: string; mechanism: string; measurement: string; uncertainty: string[] }>;
    risks: string[];
    contradictions: string[];
    references: Array<{ ref: string; label: string; url: string | null }>;
    needRationale: string | null;
    needEvidenceUrls: string[];
    offerFitRationale: string | null;
    offerFitEvidenceUrls: string[];
    assessmentModel: string | null;
    reviews: string[];
  };
  decidedBy: string | null;
  decidedAt: Date | null;
  parkReason: string | null;
  whyEvidence: EvidenceLine[];
  howEvidence: EvidenceLine[];
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    assignedTo: string;
    agentPreparedById: string | null;
    humanConfirmedBy: string | null;
    humanConfirmedAt: Date | null;
    plan: unknown;
    baselines: Array<{ id: string; metrics: unknown; observedAt: Date }>;
    outcomes: Array<{
      id: string;
      verdict: string;
      baselineMetrics: unknown;
      baselineObservedAt: Date;
      afterMetrics: unknown;
      afterObservedAt: Date;
      measuredBy: string;
    }>;
  } | null;
};

const LEG_WHY: ReadonlySet<EvidenceRecordKind> = new Set([
  "knowledge_fact",
  "research_finding",
  "question_coverage",
]);

export function legForKind(kind: EvidenceRecordKind): EvidenceLeg {
  return LEG_WHY.has(kind) ? "why" : "how";
}

type RawEvidence = {
  id: string;
  kind: EvidenceRecordKind;
  producer: string;
  observedAt: Date;
  dimensions: unknown;
  metrics: unknown;
};

function dims(record: RawEvidence): Record<string, unknown> {
  return (record.dimensions ?? {}) as Record<string, unknown>;
}

function metricsOf(record: RawEvidence): Record<string, { value: number | null; unit: string; source: string }> {
  return (record.metrics ?? {}) as Record<string, { value: number | null; unit: string; source: string }>;
}

function str(record: RawEvidence, key: string): string | null {
  const value = dims(record)[key];
  return typeof value === "string" ? value : null;
}

/** A single decisive sentence for an evidence record, per kind. */
export function headlineFor(record: RawEvidence): string {
  const m = metricsOf(record);
  const num = (key: string) => m[key]?.value ?? null;
  switch (record.kind) {
    case "keyword_rank": {
      const query = str(record, "query") ?? "query";
      const position = num("provider:position") ?? num("first_party:position");
      const impressions = num("first_party:impressions") ?? num("provider:impressions");
      const parts = [position == null ? null : `position ${Math.round(position)}`, impressions == null ? null : `${impressions} impressions`].filter(Boolean);
      return parts.length ? `"${query}" — ${parts.join(", ")}` : `"${query}"`;
    }
    case "onpage_crawl": {
      const url = str(record, "url") ?? "page";
      const issue = str(record, "issueType");
      const count = num("first_party:issueCount");
      return issue ? `${issue.replaceAll("_", " ").toLowerCase()} on ${url}` : `${count ?? 0} issue(s) on ${url}`;
    }
    case "serp_snapshot":
      return `SERP analysed for "${str(record, "query") ?? "query"}"`;
    case "ai_visibility_observation":
      return `AI answer observed for "${str(record, "question") ?? "question"}"`;
    case "knowledge_fact":
      return `Business fact recorded: ${str(record, "question") ?? str(record, "field") ?? "fact"}`;
    case "research_finding":
      return str(record, "painPointSummary") ?? str(record, "gapSummary") ?? "Research finding recorded";
    case "question_coverage":
      return `Question coverage: ${str(record, "question") ?? "question"}`;
    case "vitals":
      return `Vitals measured for ${str(record, "url") ?? "page"}`;
    default:
      return record.kind.replaceAll("_", " ");
  }
}

function evidenceLine(record: RawEvidence, leg: EvidenceLeg): EvidenceLine {
  const m = metricsOf(record);
  return {
    id: record.id,
    kind: record.kind,
    producer: record.producer,
    observedAt: record.observedAt,
    leg,
    headline: headlineFor(record),
    metrics: Object.entries(m).map(([label, value]) => ({
      label: label.split(":").slice(1).join(":"),
      value: value.value,
      unit: value.unit,
      source: value.source,
    })),
  };
}

export type OpportunityFilter = {
  projectId: string;
  statuses?: OpportunityStatus[];
  types?: OpportunityType[];
  dimensions?: OpportunityDimension[];
  /** "why" | "how" | "both" | "none" */
  completeness?: string[];
  search?: string;
  lane?: OpportunityLane;
};

/**
 * The board. Sorted by score desc, unknown scores last — the intersection
 * "worth doing and winnable" floats up, leaks stay visible.
 */
/**
 * Read the decision the opportunity was scored with.
 *
 * The board and the detail page must not each infer readiness from a different
 * field: a hypothesis read as a recommendation is exactly the failure the contract
 * exists to prevent.
 */
function decisionFromScoreInputs(inputs: unknown): OpportunityDetail["decision"] {
  const worth = (inputs as { worth?: Record<string, unknown> } | null)?.worth ?? {};
  const assessment = (inputs as { assessment?: { kind?: string; incrementalClicksPerMonth?: number | null } } | null)?.assessment;
  const read = (key: string) => (typeof worth[key] === "string" ? (worth[key] as string) : null);
  const list = (key: string) =>
    Array.isArray(worth[key]) ? (worth[key] as unknown[]).filter((value): value is string => typeof value === "string") : [];
  return {
    readiness: read("readiness"),
    measurement: read("measurement") ?? (assessment?.kind === "hypothesis" ? "unquantified" : null),
    track: read("benefitTrack"),
    intervention: read("intervention"),
    benefit:
      assessment?.incrementalClicksPerMonth != null
        ? `about ${Math.round(assessment.incrementalClicksPerMonth)} additional clicks/month in the stated scenario`
        : null,
    change: read("change"),
    targetPages: list("targetPages"),
    successMeasure: read("successMeasure"),
    uncertainty: list("uncertainty"),
    coverage: read("coverageSummary"),
    coverageDetail: [],
    premise: null,
    investigation: null,
    benefits: [],
    risks: [],
    contradictions: [],
    references: [],
    needRationale: read("needRationale"),
    needEvidenceUrls: list("needEvidenceUrls"),
    offerFitRationale: read("offerFitRationale"),
    offerFitEvidenceUrls: list("offerFitEvidenceUrls"),
    assessmentModel: read("assessmentModel"),
    reviews: [],
  };
}

type ResolvedReference = { label: string; url: string | null };

/** Resolve packet refs to readable labels and URLs for the detail page. */
function resolvePacketReferences(packetJson: unknown): Map<string, ResolvedReference> {
  const refs = new Map<string, ResolvedReference>();
  const packet = (() => {
    if (typeof packetJson === "string") {
      try {
        return JSON.parse(packetJson) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return (packetJson ?? null) as Record<string, unknown> | null;
  })();
  if (!packet) return refs;
  const facts = Array.isArray(packet.businessFacts) ? (packet.businessFacts as Array<Record<string, unknown>>) : [];
  for (const fact of facts) {
    if (typeof fact.id !== "string") continue;
    refs.set(fact.id, {
      label: `Business fact: ${String(fact.field ?? fact.id)}`,
      url: typeof fact.sourceUrl === "string" ? fact.sourceUrl : null,
    });
  }
  const sources = Array.isArray(packet.sources) ? (packet.sources as Array<Record<string, unknown>>) : [];
  for (const source of sources) {
    if (typeof source.id !== "string") continue;
    refs.set(source.id, {
      label: typeof source.title === "string" && source.title ? source.title : String(source.url ?? source.id),
      url: typeof source.url === "string" ? source.url : null,
    });
  }
  const pages = Array.isArray(packet.pages) ? (packet.pages as Array<Record<string, unknown>>) : [];
  for (const page of pages) {
    if (typeof page.id !== "string") continue;
    const url = typeof page.url === "string" ? page.url : null;
    refs.set(page.id, { label: url ?? page.id, url });
    const sections = Array.isArray(page.sections) ? (page.sections as Array<Record<string, unknown>>) : [];
    for (const section of sections) {
      if (typeof section.id !== "string") continue;
      refs.set(section.id, { label: `${url ?? page.id} (${String(section.locator ?? "section")})`, url });
    }
  }
  const search = Array.isArray(packet.search) ? (packet.search as Array<Record<string, unknown>>) : [];
  for (const row of search) {
    if (typeof row.id !== "string") continue;
    refs.set(row.id, {
      label: `Search: ${String(row.query ?? row.id)}`,
      url: typeof row.pageUrl === "string" ? row.pageUrl : null,
    });
  }
  return refs;
}

/** Project the canonical decision into the shared presentation shape. */
function decisionFromCanonical(
  decision: RecommendationDecision,
  references: Map<string, ResolvedReference> = new Map()
): OpportunityDetail["decision"] {
  const firstBenefit = decision.benefits[0];
  const resolve = (ref: string) => references.get(ref) ?? { label: ref, url: null };
  const usedRefs = new Set<string>();
  const collect = (refs: string[]) => refs.forEach((ref) => usedRefs.add(ref));
  decision.question.bases.forEach((basis) => collect(basis.references));
  collect(decision.premise.references);
  collect(decision.offerFit.references);
  return {
    readiness: decision.readiness,
    measurement: firstBenefit?.measurement ?? "unquantified",
    track: firstBenefit?.track ?? null,
    intervention: decision.intervention,
    benefit: firstBenefit?.mechanism ?? null,
    change: decision.change,
    targetPages: decision.targets.map((target) => target.pageUrl).filter((url): url is string => Boolean(url)),
    successMeasure: decision.success.measure,
    uncertainty: decision.uncertainty,
    coverage: decision.coverage[0]
      ? `${decision.coverage[0].state.replaceAll("_", " ")} at ${resolve(decision.coverage[0].pageId).label}`
      : null,
    coverageDetail: decision.coverage.map((entry) => ({
      pageId: entry.pageId,
      url: resolve(entry.pageId).url,
      state: entry.state,
      rationale: entry.rationale,
      excerpts: entry.excerpts,
    })),
    premise: { state: decision.premise.state, rationale: decision.premise.rationale },
    investigation: decision.investigation,
    benefits: decision.benefits.map((benefit) => ({
      track: benefit.track,
      mechanism: benefit.mechanism,
      measurement: benefit.measurement,
      uncertainty: benefit.uncertainty,
    })),
    risks: decision.risks,
    contradictions: decision.contradictions,
    references: [...usedRefs].map((ref) => ({ ref, ...resolve(ref) })),
    needRationale: decision.question.rationale,
    needEvidenceUrls: decision.question.bases.flatMap((basis) => basis.references),
    offerFitRationale: decision.offerFit.rationale,
    offerFitEvidenceUrls: decision.offerFit.references,
    assessmentModel: decision.model,
    reviews: decision.reviews.map((review) => `${review.requirement.replaceAll("_", " ")}: ${review.reason}`),
  };
}

export async function listOpportunities(db: FunnelDb, filter: OpportunityFilter): Promise<OpportunityRow[]> {
  const opportunities = await db.opportunity.findMany({
    where: {
      projectId: filter.projectId,
      status: filter.statuses?.length ? { in: filter.statuses } : undefined,
      type: filter.types?.length ? { in: filter.types } : undefined,
      dimension: filter.dimensions?.length ? { in: filter.dimensions } : undefined,
      evidenceCompleteness: filter.completeness?.length ? { in: filter.completeness as never } : undefined,
      OR: filter.search
        ? [{ title: { contains: filter.search, mode: "insensitive" } }, { summary: { contains: filter.search, mode: "insensitive" } }]
        : undefined,
    },
    orderBy: [{ scoreValue: "desc" }, { firstDetectedAt: "desc" }],
    select: {
      id: true,
      type: true,
      status: true,
      dimension: true,
      title: true,
      summary: true,
      scoreValue: true,
      evidenceCompleteness: true,
      detectedBy: true,
      firstDetectedAt: true,
      clusterId: true,
      dedupKey: true,
      scoreInputs: true,
      recommendationDecision: true,
    },
  });

  const edges = await db.evidenceEdge.findMany({
    where: { toType: "opportunity", toId: { in: opportunities.map((row) => row.id) }, relation: "supporting" },
    select: { toId: true, fromId: true },
  });
  const evidenceIds = [...new Set(edges.map((edge) => edge.fromId))];
  const evidence = evidenceIds.length
    ? await db.evidenceRecord.findMany({
        where: { id: { in: evidenceIds } },
        select: { id: true, kind: true, producer: true, observedAt: true, dimensions: true, metrics: true },
      })
    : [];
  const evidenceById = new Map(evidence.map((row) => [row.id, row as RawEvidence]));
  const clusterIds = [...new Set(opportunities.map((row) => row.clusterId).filter((id): id is string => Boolean(id)))];
  const clusters = clusterIds.length
    ? await db.demandMapCluster.findMany({ where: { id: { in: clusterIds } }, select: { id: true, slug: true } })
    : [];
  const clusterSlug = new Map(clusters.map((row) => [row.id, row.slug]));

  return opportunities.map((row) => {
    const rowEdges = edges.filter((edge) => edge.toId === row.id);
    const first = rowEdges.map((edge) => evidenceById.get(edge.fromId)).find((value): value is RawEvidence => Boolean(value));
    const canonical = parsePersistedDecision(row.recommendationDecision);
    const legacy = decisionFromScoreInputs(row.scoreInputs);
    const proposal = parseOpportunityProposal(row.recommendationDecision);
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      dimension: row.dimension,
      title: row.title,
      summary: row.summary,
      score: row.scoreValue,
      completeness: row.evidenceCompleteness,
      detectedBy: row.detectedBy,
      firstDetectedAt: row.firstDetectedAt,
      clusterSlug: row.clusterId ? clusterSlug.get(row.clusterId) ?? null : null,
      reason: first ? headlineFor(first) : null,
      evidenceCount: rowEdges.length,
      readiness: canonical?.readiness ?? legacy.readiness,
      measurement: canonical ? canonical.benefits[0]?.measurement ?? "unquantified" : legacy.measurement,
      lane: proposal?.lane ?? fallbackLane(row.dimension),
      proposal,
    };
  }).filter((row) => !filter.lane || row.lane === filter.lane);
}

/** One page per opportunity: the whole chain, both legs, task, delivery, outcome. */
export async function getOpportunityDetail(db: FunnelDb, opportunityId: string): Promise<OpportunityDetail | null> {
  const row = await db.opportunity.findUnique({
    where: { id: opportunityId },
    select: {
      id: true,
      type: true,
      status: true,
      dimension: true,
      title: true,
      summary: true,
      scoreValue: true,
      scoreInputs: true,
      evidenceCompleteness: true,
      detectedBy: true,
      firstDetectedAt: true,
      clusterId: true,
      decidedBy: true,
      decidedAt: true,
      parkReason: true,
      dedupKey: true,
      recommendationDecision: true,
      recommendationEvidenceId: true,
    },
  });
  if (!row) return null;

  const edges = await db.evidenceEdge.findMany({
    where: { toType: "opportunity", toId: opportunityId, relation: "supporting" },
    select: { fromId: true },
  });
  const evidence = edges.length
    ? await db.evidenceRecord.findMany({
        where: { id: { in: edges.map((edge) => edge.fromId) } },
        orderBy: { observedAt: "desc" },
        select: { id: true, kind: true, producer: true, observedAt: true, dimensions: true, metrics: true },
      })
    : [];

  const lines = evidence.map((record) => evidenceLine(record as RawEvidence, legForKind(record.kind)));
  const cluster = row.clusterId
    ? await db.demandMapCluster.findUnique({ where: { id: row.clusterId }, select: { slug: true } })
    : null;

  const task = await db.task.findFirst({
    where: { opportunityId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      status: true,
      assignedTo: true,
      agentPreparedById: true,
      humanConfirmedBy: true,
      humanConfirmedAt: true,
      plan: true,
    },
  });

  const canonical = parsePersistedDecision(row.recommendationDecision);
  let packetJson: unknown = null;
  if (canonical && row.recommendationEvidenceId) {
    const packetRow = await db.evidenceRecord.findUnique({
      where: { id: row.recommendationEvidenceId },
      select: { dimensions: true },
    });
    const dimensions = (packetRow?.dimensions ?? null) as {
      recommendationFinalPacketJson?: unknown;
      recommendationPacketJson?: unknown;
    } | null;
    packetJson = dimensions?.recommendationFinalPacketJson ?? dimensions?.recommendationPacketJson ?? null;
  }
  const references = resolvePacketReferences(packetJson);
  const taskDecisionId = (task?.plan as { decisionId?: unknown } | null)?.decisionId;
  const decisionChanged = Boolean(
    task && canonical && typeof taskDecisionId === "string" && taskDecisionId !== canonical.decisionId
  );

  const [baselines, outcomes] = task
    ? await Promise.all([
        db.baseline.findMany({ where: { taskId: task.id }, orderBy: { observedAt: "desc" } }),
        db.outcomeObservation.findMany({ where: { taskId: task.id }, orderBy: { createdAt: "desc" } }),
      ])
    : [[], []];

  return {
    id: row.id,
    type: row.type,
    status: row.status,
    dimension: row.dimension,
    title: row.title,
    summary: row.summary,
    readiness: canonical?.readiness ?? decisionFromScoreInputs(row.scoreInputs).readiness,
    measurement: canonical
      ? canonical.benefits[0]?.measurement ?? "unquantified"
      : decisionFromScoreInputs(row.scoreInputs).measurement,
    score: row.scoreValue,
    scoreInputs: row.scoreInputs,
    recommendation: canonical,
    lane: parseOpportunityProposal(row.recommendationDecision)?.lane ?? fallbackLane(row.dimension),
    proposal: parseOpportunityProposal(row.recommendationDecision),
    decisionChanged,
    decision: canonical ? decisionFromCanonical(canonical, references) : decisionFromScoreInputs(row.scoreInputs),
    completeness: row.evidenceCompleteness,
    detectedBy: row.detectedBy,
    firstDetectedAt: row.firstDetectedAt,
    clusterSlug: cluster?.slug ?? null,
    reason: lines[0]?.headline ?? null,
    evidenceCount: lines.length,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    parkReason: row.parkReason,
    whyEvidence: lines.filter((line) => line.leg === "why"),
    howEvidence: lines.filter((line) => line.leg === "how"),
    task: task
      ? {
          ...task,
          baselines: baselines.map((baseline) => ({ id: baseline.id, metrics: baseline.metrics, observedAt: baseline.observedAt })),
          outcomes: outcomes.map((outcome) => ({
            id: outcome.id,
            verdict: outcome.verdict,
            baselineMetrics: outcome.baselineMetrics,
            baselineObservedAt: outcome.baselineObservedAt,
            afterMetrics: outcome.afterMetrics,
            afterObservedAt: outcome.afterObservedAt,
            measuredBy: outcome.measuredBy,
          })),
        }
      : null,
  };
}

export type FunnelCounts = {
  detected: number;
  accepted: number;
  inProgress: number;
  parked: number;
  rejected: number;
  closed: number;
  total: number;
  byDimension: Record<string, number>;
  byLane: Record<string, number>;
  byType: Array<{ type: OpportunityType; count: number }>;
  missingWhy: number;
  missingHow: number;
  bothLegs: number;
  scoreSum: number;
  scored: number;
  evidenceTotal: number;
};

export async function getFunnelCounts(db: FunnelDb, projectId: string): Promise<FunnelCounts> {
  const rows = await db.opportunity.findMany({
    where: { projectId },
    select: { status: true, dimension: true, type: true, evidenceCompleteness: true, scoreValue: true, recommendationDecision: true },
  });
  const counts: FunnelCounts = {
    detected: 0,
    accepted: 0,
    inProgress: 0,
    parked: 0,
    rejected: 0,
    closed: 0,
    total: rows.length,
    byDimension: {},
    byLane: {},
    byType: [],
    missingWhy: 0,
    missingHow: 0,
    bothLegs: 0,
    scoreSum: 0,
    scored: 0,
    evidenceTotal: 0,
  };
  const typeCounts = new Map<OpportunityType, number>();
  for (const row of rows) {
    if (row.status === "detected") counts.detected += 1;
    else if (row.status === "accepted") counts.accepted += 1;
    else if (row.status === "in_progress") counts.inProgress += 1;
    else if (row.status === "parked") counts.parked += 1;
    else if (row.status === "rejected") counts.rejected += 1;
    else if (row.status === "closed") counts.closed += 1;
    counts.byDimension[row.dimension] = (counts.byDimension[row.dimension] ?? 0) + 1;
    const lane = parseOpportunityProposal(row.recommendationDecision)?.lane ?? fallbackLane(row.dimension);
    counts.byLane[lane] = (counts.byLane[lane] ?? 0) + 1;
    typeCounts.set(row.type, (typeCounts.get(row.type) ?? 0) + 1);
    if (row.evidenceCompleteness === "both") counts.bothLegs += 1;
    else if (row.evidenceCompleteness === "why") counts.missingHow += 1;
    else if (row.evidenceCompleteness === "how") counts.missingWhy += 1;
    if (row.scoreValue != null) {
      counts.scoreSum += row.scoreValue;
      counts.scored += 1;
    }
  }
  counts.byType = [...typeCounts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  counts.evidenceTotal = await db.evidenceRecord.count({ where: { projectId } });
  return counts;
}

export type DemandClusterRow = {
  id: string;
  slug: string;
  name: string;
  intent: string;
  topicSummary: string;
  tracked: boolean;
  businessRelevance: unknown;
  proposedBy: string;
  confidence: number;
  /** Queries recorded as members of this cluster. */
  members: number;
  /** Members with a recorded rank, i.e. we have a page competing. */
  covered: number;
  /** Best recorded position across the members, null when we rank for none. */
  bestPosition: number | null;
  openOpportunities: number;
};

export async function listDemandClusters(db: FunnelDb, projectId: string): Promise<DemandClusterRow[]> {
  const clusters = await db.demandMapCluster.findMany({
    where: { projectId, supersededAt: null },
    orderBy: { slug: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      intent: true,
      topicSummary: true,
      tracked: true,
      businessRelevance: true,
      proposedBy: true,
      confidence: true,
    },
  });
  const counts = await db.opportunity.groupBy({
    by: ["clusterId"],
    where: { projectId, status: { in: ["detected", "accepted", "in_progress"] } },
    _count: { _all: true },
  });
  const countByCluster = new Map(counts.map((row) => [row.clusterId, row._count._all]));

  const memberships = await db.evidenceRecord.findMany({
    where: { projectId, kind: "keyword_universe_membership", supersededById: null },
    select: { dimensions: true },
  });
  const membersBySlug = new Map<string, Set<string>>();
  for (const row of memberships) {
    const dims = (row.dimensions ?? {}) as { cluster?: string; query?: string };
    if (!dims.cluster || !dims.query) continue;
    membersBySlug.set(dims.cluster, (membersBySlug.get(dims.cluster) ?? new Set()).add(dims.query));
  }
  const ranks = await db.evidenceRecord.findMany({
    where: { projectId, kind: "keyword_rank", supersededById: null },
    select: { dimensions: true, metrics: true },
  });
  const ranked = new Map<string, number>();
  for (const row of ranks) {
    const dims = (row.dimensions ?? {}) as { query?: string };
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    const position = metrics["provider:position"]?.value ?? metrics["first_party:position"]?.value ?? null;
    if (!dims.query || position == null) continue;
    const current = ranked.get(dims.query);
    if (current == null || position < current) ranked.set(dims.query, position);
  }

  return clusters.map((cluster) => {
    const members = membersBySlug.get(cluster.slug) ?? new Set<string>();
    return {
      ...cluster,
      members: members.size,
      covered: [...members].filter((query) => ranked.has(query)).length,
      bestPosition: [...members].reduce<number | null>((best, query) => {
        const position = ranked.get(query);
        if (position == null) return best;
        return best == null || position < best ? position : best;
      }, null),
      openOpportunities: countByCluster.get(cluster.id) ?? 0,
    };
  });
}

export type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  assignedTo: string;
  agentPreparedById: string | null;
  humanConfirmedBy: string | null;
  humanConfirmedAt: Date | null;
  createdAt: Date;
  opportunityId: string;
  opportunityTitle: string;
  opportunityType: OpportunityType;
  opportunityScore: number | null;
  hasOutcome: boolean;
  verdict: string | null;
};

export async function listTasks(db: FunnelDb, projectId: string, statuses?: TaskStatus[]): Promise<TaskRow[]> {
  const tasks = await db.task.findMany({
    where: {
      opportunity: { projectId },
      status: statuses?.length ? { in: statuses } : undefined,
    },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      status: true,
      assignedTo: true,
      agentPreparedById: true,
      humanConfirmedBy: true,
      humanConfirmedAt: true,
      createdAt: true,
      opportunity: { select: { id: true, title: true, type: true, scoreValue: true } },
      outcomeObservations: { select: { verdict: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  return tasks.map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    assignedTo: task.assignedTo,
    agentPreparedById: task.agentPreparedById,
    humanConfirmedBy: task.humanConfirmedBy,
    humanConfirmedAt: task.humanConfirmedAt,
    createdAt: task.createdAt,
    opportunityId: task.opportunity.id,
    opportunityTitle: task.opportunity.title,
    opportunityType: task.opportunity.type,
    opportunityScore: task.opportunity.scoreValue,
    hasOutcome: task.outcomeObservations.length > 0,
    verdict: task.outcomeObservations[0]?.verdict ?? null,
  }));
}

export type EvidenceRow = {
  id: string;
  kind: EvidenceRecordKind;
  producer: string;
  observedAt: Date;
  headline: string;
  superseded: boolean;
  usedBy: number;
};

export async function listEvidence(
  db: FunnelDb,
  filter: { projectId: string; kinds?: EvidenceRecordKind[]; search?: string; limit?: number }
): Promise<EvidenceRow[]> {
  const records = await db.evidenceRecord.findMany({
    where: {
      projectId: filter.projectId,
      kind: filter.kinds?.length ? { in: filter.kinds } : undefined,
    },
    orderBy: { observedAt: "desc" },
    take: filter.limit ?? 100,
    select: {
      id: true,
      kind: true,
      producer: true,
      observedAt: true,
      dimensions: true,
      metrics: true,
      supersededById: true,
    },
  });
  const edges = await db.evidenceEdge.findMany({
    where: { fromType: "evidence_record", fromId: { in: records.map((row) => row.id) } },
    select: { fromId: true },
  });
  const usage = new Map<string, number>();
  for (const edge of edges) usage.set(edge.fromId, (usage.get(edge.fromId) ?? 0) + 1);

  const rows = records.map((record) => ({
    id: record.id,
    kind: record.kind,
    producer: record.producer,
    observedAt: record.observedAt,
    headline: headlineFor(record as RawEvidence),
    superseded: Boolean(record.supersededById),
    usedBy: usage.get(record.id) ?? 0,
  }));
  return filter.search
    ? rows.filter((row) => row.headline.toLowerCase().includes(filter.search!.toLowerCase()))
    : rows;
}

export type FunnelOverview = {
  counts: FunnelCounts;
  topOpportunities: OpportunityRow[];
  tasks: TaskRow[];
  recentVerdicts: Array<{ verdict: string; count: number }>;
  evidenceTotal: number;
  clusters: number;
};

export async function getFunnelOverview(db: FunnelDb, projectId: string): Promise<FunnelOverview> {
  const [counts, topOpportunities, tasks, evidenceTotal, clusters, outcomes] = await Promise.all([
    getFunnelCounts(db, projectId),
    listOpportunities(db, { projectId, statuses: ["detected", "accepted", "in_progress"] }),
    listTasks(db, projectId),
    db.evidenceRecord.count({ where: { projectId } }),
    db.demandMapCluster.count({ where: { projectId } }),
    db.outcomeObservation.findMany({
      where: { task: { opportunity: { projectId } } },
      select: { verdict: true },
    }),
  ]);
  const verdictCounts = new Map<string, number>();
  for (const row of outcomes) verdictCounts.set(row.verdict, (verdictCounts.get(row.verdict) ?? 0) + 1);
  return {
    counts,
    topOpportunities: topOpportunities.slice(0, 5),
    tasks: tasks.slice(0, 5),
    recentVerdicts: [...verdictCounts.entries()].map(([verdict, count]) => ({ verdict, count })),
    evidenceTotal,
    clusters,
  };
}
