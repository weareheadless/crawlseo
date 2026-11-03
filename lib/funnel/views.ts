import type { PrismaClient } from "@prisma/client";

import type {
  EvidenceRecordKind,
  OpportunityDimension,
  OpportunityStatus,
  OpportunityType,
  TaskStatus,
} from "@prisma/client";

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
};

export type OpportunityDetail = OpportunityRow & {
  scoreInputs: unknown;
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
};

/**
 * The board. Sorted by score desc, unknown scores last — the intersection
 * "worth doing and winnable" floats up, leaks stay visible.
 */
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
    };
  });
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
    score: row.scoreValue,
    scoreInputs: row.scoreInputs,
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
    select: { status: true, dimension: true, type: true, evidenceCompleteness: true, scoreValue: true },
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
  openOpportunities: number;
};

export async function listDemandClusters(db: FunnelDb, projectId: string): Promise<DemandClusterRow[]> {
  const clusters = await db.demandMapCluster.findMany({
    where: { projectId, supersededById: null },
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
  const ranked = new Set<string>();
  for (const row of ranks) {
    const dims = (row.dimensions ?? {}) as { query?: string };
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    if (dims.query && (metrics["provider:position"]?.value ?? metrics["first_party:position"]?.value) != null) {
      ranked.add(dims.query);
    }
  }

  return clusters.map((cluster) => {
    const members = membersBySlug.get(cluster.slug) ?? new Set<string>();
    return {
      ...cluster,
      members: members.size,
      covered: [...members].filter((query) => ranked.has(query)).length,
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
