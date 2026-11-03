import { createHash } from "node:crypto";

import type { PrismaClient, Prisma } from "@prisma/client";

import type { EvidenceRecordKind } from "@prisma/client";

/**
 * Evidence store for the funnel spine (docs/seo-funnel-spine-plan.md §4).
 * One envelope for both evidence legs (business and search).
 *
 * Invariants enforced here:
 *  - no evidence without provenance: producer + observedAt always; a paid
 *    provider response (with cost) for provider-collected kinds;
 *  - provider-sourced and first-party metrics never share a label: metric
 *    keys must be namespaced by their declared source;
 *  - every metric declares its unit;
 *  - supersede, never delete: superseding a record writes the replacement
 *    and points the old row at it.
 */

export type MetricSource = "provider" | "first_party" | "derived";

export type MetricValue = {
  value: number | null;
  unit: string;
  source: MetricSource;
};

/**
 * Dimensions are JSON scalars or arrays of scalars. Arrays are allowed because
 * some observations are inherently multi-valued (a SERP's top URLs, a page's
 * internal link targets) and flattening them into JSON strings would lose type.
 */
export type EvidenceDimensionValue = string | number | boolean | null | string[] | number[];
export type EvidenceDimensions = Record<string, EvidenceDimensionValue>;

export type EvidenceRecordPayload = {
  projectId: string;
  siteId?: string | null;
  kind: EvidenceRecordKind;
  observedAt: Date;
  validFrom?: Date | null;
  validTo?: Date | null;
  producer: string;
  rawResponseId?: string | null;
  dimensions: EvidenceDimensions;
  metrics: Record<string, MetricValue>;
};

/** Kinds whose metrics may come from a paid provider (see the rule below). */
export const PROVIDER_COLLECTED_KINDS: ReadonlySet<string> = new Set([
  "keyword_rank",
  "keyword_metrics",
  "serp_snapshot",
  "serp_features",
  "competitor_rank",
  "backlink_profile",
  "share_of_voice",
  "keyword_universe_membership",
  "ai_visibility_observation",
]);

/**
 * Provenance rule: evidence is "paid" when any stored metric declares
 * `source: "provider"`. Paid evidence must point at the raw response and its
 * recorded cost. The same kind can be collected first-party (GSC ranks, our
 * crawler) and then needs no raw provider payload — so the rule is driven by
 * the declared metric source, not by the kind alone.
 */
export function requiresPaidProvenance(metrics: Record<string, MetricValue>): boolean {
  return Object.values(metrics).some((metric) => metric.source === "provider");
}

export const EVIDENCE_KINDS: readonly EvidenceRecordKind[] = [
  "keyword_rank",
  "keyword_metrics",
  "serp_snapshot",
  "serp_features",
  "intent_label",
  "competitor_rank",
  "backlink_profile",
  "share_of_voice",
  "keyword_universe_membership",
  "onpage_crawl",
  "internal_link_graph",
  "ai_visibility_observation",
  "gsc_query",
  "gsc_page",
  "vitals",
  "analytics",
  "knowledge_fact",
  "question_coverage",
  "research_finding",
];

export function computeObservationHash(payload: EvidenceRecordPayload): string {
  const canonical = JSON.stringify({
    projectId: payload.projectId,
    kind: payload.kind,
    observedAt: payload.observedAt.toISOString(),
    dimensions: sorted(payload.dimensions),
    metrics: sortedMetrics(payload.metrics),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function sorted(input: EvidenceDimensions): EvidenceDimensions {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function sortedMetrics(metrics: Record<string, MetricValue>): Record<string, MetricValue> {
  return Object.fromEntries(Object.entries(metrics).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function validateMetricLabel(label: string, metric: MetricValue): void {
  if (!label.startsWith(`${metric.source}:`)) {
    throw new Error(
      `metric label "${label}" must be namespaced by its declared source "${metric.source}" (provider and first-party metrics never share a label)`
    );
  }
  if (typeof metric.unit !== "string" || metric.unit.trim() === "") {
    throw new Error(`metric "${label}" must declare a unit`);
  }
}

export type EvidenceDb = Pick<PrismaClient, "evidenceRecord" | "rawProviderResponse">;

export type StoredEvidenceRecord = {
  id: string;
  kind: EvidenceRecordKind;
  projectId: string;
  siteId: string | null;
  observedAt: Date;
  observationHash: string;
  supersededById: string | null;
};

export async function storeEvidenceRecord(
  db: EvidenceDb,
  input: EvidenceRecordPayload
): Promise<StoredEvidenceRecord> {
  if (!EVIDENCE_KINDS.includes(input.kind)) {
    throw new Error(`unknown evidence kind: ${String(input.kind)}`);
  }
  if (!input.producer || input.producer.trim() === "") {
    throw new Error("evidence requires a producer (provenance)");
  }
  if (!(input.observedAt instanceof Date) || Number.isNaN(input.observedAt.getTime())) {
    throw new Error("evidence requires a valid observedAt (provenance)");
  }
  if (PROVIDER_COLLECTED_KINDS.has(input.kind)) {
    const providerMetrics = Object.entries(input.metrics).filter(([, metric]) => metric.source === "provider");
    if (providerMetrics.length > 0) {
      if (!input.rawResponseId) {
        throw new Error(
          `provider-sourced metrics require a raw response reference (provenance); kind "${input.kind}"`
        );
      }
      const raw = await db.rawProviderResponse.findUnique({
        where: { id: input.rawResponseId },
        select: { costMicros: true, status: true },
      });
      if (!raw) {
        throw new Error("raw provider response not found");
      }
      if (raw.costMicros == null) {
        throw new Error("provider-sourced evidence requires the raw response to record its cost (provenance)");
      }
    }
  }
  for (const [label, metric] of Object.entries(input.metrics)) {
    validateMetricLabel(label, metric);
  }

  const observationHash = computeObservationHash(input);
  const record = await db.evidenceRecord.upsert({
    where: {
      projectId_kind_observationHash: {
        projectId: input.projectId,
        kind: input.kind,
        observationHash,
      },
    },
    create: {
      projectId: input.projectId,
      siteId: input.siteId ?? null,
      kind: input.kind,
      observedAt: input.observedAt,
      validFrom: input.validFrom ?? null,
      validTo: input.validTo ?? null,
      producer: input.producer,
      rawResponseId: input.rawResponseId ?? null,
      dimensions: input.dimensions as Prisma.InputJsonValue,
      metrics: input.metrics as unknown as Prisma.InputJsonValue,
      observationHash,
    },
    update: {},
    select: {
      id: true,
      kind: true,
      projectId: true,
      siteId: true,
      observedAt: true,
      observationHash: true,
      supersededById: true,
    },
  });
  return record;
}

/** Supersede, never delete: write the replacement and point the old row at it. */
export async function supersedeEvidenceRecord(
  db: EvidenceDb,
  supersededId: string,
  replacement: EvidenceRecordPayload
): Promise<StoredEvidenceRecord> {
  const replacementRecord = await storeEvidenceRecord(db, replacement);
  await db.evidenceRecord.update({
    where: { id: supersededId },
    data: { supersededById: replacementRecord.id },
  });
  return replacementRecord;
}

export type EvidenceFilter = {
  projectId: string;
  kinds?: EvidenceRecordKind[];
  siteId?: string | null;
  /** Only records that are not superseded (the active view). Default true. */
  activeOnly?: boolean;
};

export async function listActiveEvidence(db: EvidenceDb, filter: EvidenceFilter) {
  return db.evidenceRecord.findMany({
    where: {
      projectId: filter.projectId,
      siteId: filter.siteId ?? undefined,
      kind: filter.kinds ? { in: filter.kinds } : undefined,
      supersededById: filter.activeOnly === false ? undefined : null,
    },
    orderBy: { observedAt: "desc" },
  });
}
