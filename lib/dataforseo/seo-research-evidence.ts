import type { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord, type MetricValue } from "@/lib/funnel/evidence";

/**
 * Bridge: stored SEO research runs → funnel evidence.
 *
 * The DataForSEO research family (`SeoResearchRun`/`SeoResearchTask`) is the
 * last thing keeping those tables alive: their results are only readable as
 * JSON blobs, so the funnel cannot use them and the tables cannot be retired.
 * This projects each completed task into the evidence kind that matches what it
 * measured, with the raw payload stored first.
 *
 * A task with no recorded cost is skipped and reported — paid data is never
 * given a provenance it does not have.
 */

export type SeoResearchEvidenceDb = Pick<PrismaClient, "rawProviderResponse" | "evidenceRecord" | "seoResearchTask"> &
  Parameters<typeof storeEvidenceRecord>[0];

type StoredTask = {
  id: string;
  kind: string;
  providerTaskId: string | null;
  costMicros: number | null;
  result: unknown;
  completedAt: Date | null;
  input: unknown;
};

export type SeoResearchEvidenceResult = {
  tasks: number;
  stored: number;
  skipped: Array<{ taskId: string; reason: string }>;
  /** Evidence kinds produced, so the caller can report what landed. */
  kinds: Record<string, number>;
};

const PRODUCT_BY_KIND: Record<string, { product: string; endpoint: string }> = {
  KEYWORD_SEED: { product: "keywords_data", endpoint: "keyword_seed" },
  DOMAIN_OVERVIEW: { product: "domain_analytics", endpoint: "domain_overview" },
  BACKLINKS_OVERVIEW: { product: "backlinks", endpoint: "backlinks_overview" },
};

function numberMetrics(prefix: string, values: Record<string, unknown>, units: Record<string, string>): Record<string, MetricValue> {
  const metrics: Record<string, MetricValue> = {};
  for (const [key, unit] of Object.entries(units)) {
    const value = values[key];
    if (typeof value === "number") metrics[`provider:${prefix}${key}`] = { value, unit, source: "provider" };
  }
  return metrics;
}

/**
 * Map one completed task to an evidence payload, or explain why it cannot be
 * mapped. Kept pure so the mapping is testable without a database.
 */
export function taskToEvidence(task: StoredTask): {
  kind: "keyword_metrics" | "analytics" | "backlink_profile" | null;
  dimensions: Record<string, string | number | boolean | null>;
  metrics: Record<string, MetricValue>;
  reason?: string;
} {
  const result = task.result;
  if (result == null) return { kind: null, dimensions: {}, metrics: {}, reason: "no stored result" };

  if (task.kind === "KEYWORD_SEED") {
    const rows = Array.isArray(result) ? result : [];
    const metrics: Record<string, MetricValue> = {};
    // A keyword seed task yields many rows; the first is summarised here and the
    // per-keyword rows are written by the caller.
    if (rows.length === 0) return { kind: null, dimensions: {}, metrics: {}, reason: "empty keyword list" };
    const first = rows[0] as Record<string, unknown>;
    if (typeof first.volume === "number") metrics["provider:topVolume"] = { value: first.volume, unit: "searches/month", source: "provider" };
    return { kind: "keyword_metrics", dimensions: { rowCount: rows.length }, metrics };
  }

  if (task.kind === "DOMAIN_OVERVIEW") {
    const value = result as Record<string, unknown>;
    const metrics = numberMetrics("", value, {
      organicKeywords: "count",
      organicTraffic: "visits/month",
      organicCost: "currency",
      backlinks: "count",
      referringDomains: "count",
    });
    return { kind: "analytics", dimensions: { scope: "domain_overview" }, metrics };
  }

  if (task.kind === "BACKLINKS_OVERVIEW") {
    const value = result as Record<string, unknown>;
    const metrics = numberMetrics("", value, {
      totalBacklinks: "count",
      referringDomains: "count",
      referringIps: "count",
      dofollow: "count",
      nofollow: "count",
    });
    return { kind: "backlink_profile", dimensions: { scope: "backlinks_overview" }, metrics };
  }

  return { kind: null, dimensions: {}, metrics: {}, reason: `unmapped task kind ${task.kind}` };
}

export async function bridgeSeoResearchRunToEvidence(
  db: SeoResearchEvidenceDb,
  opts: { projectId: string; siteId?: string | null; researchRunId: string }
): Promise<SeoResearchEvidenceResult> {
  const tasks = (await db.seoResearchTask.findMany({
    where: { researchRunId: opts.researchRunId, status: "COMPLETED" },
    select: { id: true, kind: true, providerTaskId: true, costMicros: true, result: true, completedAt: true, input: true },
  })) as StoredTask[];

  const result: SeoResearchEvidenceResult = { tasks: tasks.length, stored: 0, skipped: [], kinds: {} };

  for (const task of tasks) {
    if (task.costMicros == null) {
      result.skipped.push({ taskId: task.id, reason: "no recorded cost" });
      continue;
    }
    const mapped = taskToEvidence(task);
    if (!mapped.kind) {
      result.skipped.push({ taskId: task.id, reason: mapped.reason ?? "unmapped" });
      continue;
    }

    const product = PRODUCT_BY_KIND[task.kind] ?? { product: "keywords_data", endpoint: "unknown" };
    const deliveredAt = task.completedAt ?? new Date();
    const raw = await db.rawProviderResponse.upsert({
      where: {
        provider_providerTaskId: {
          provider: "dataforseo",
          providerTaskId: task.providerTaskId ?? `seo-task:${task.id}`,
        },
      },
      create: {
        provider: "dataforseo",
        product: product.product,
        endpoint: product.endpoint,
        providerTaskId: task.providerTaskId ?? `seo-task:${task.id}`,
        locale: null,
        requestedAt: deliveredAt,
        deliveredAt,
        costMicros: BigInt(task.costMicros),
        status: "succeeded",
        payload: task.result as never,
      },
      update: {},
      select: { id: true },
    });

    await storeEvidenceRecord(db, {
      projectId: opts.projectId,
      siteId: opts.siteId ?? null,
      kind: mapped.kind,
      observedAt: deliveredAt,
      producer: "dataforseo",
      rawResponseId: raw.id,
      dimensions: mapped.dimensions,
      metrics: mapped.metrics,
    });
    result.stored += 1;
    result.kinds[mapped.kind] = (result.kinds[mapped.kind] ?? 0) + 1;

    // Keyword seeds carry a row per keyword: project them all, not just a summary.
    if (task.kind === "KEYWORD_SEED" && Array.isArray(task.result)) {
      for (const row of task.result as Array<Record<string, unknown>>) {
        if (typeof row.keyword !== "string") continue;
        const metrics: Record<string, MetricValue> = {};
        if (typeof row.volume === "number") metrics["provider:volume"] = { value: row.volume, unit: "searches/month", source: "provider" };
        if (typeof row.difficulty === "number") metrics["provider:difficulty"] = { value: row.difficulty, unit: "score", source: "provider" };
        if (typeof row.cpc === "number") metrics["provider:cpc"] = { value: row.cpc, unit: "currency", source: "provider" };
        if (typeof row.competition === "number") metrics["provider:competition"] = { value: row.competition, unit: "score", source: "provider" };
        await storeEvidenceRecord(db, {
          projectId: opts.projectId,
          siteId: opts.siteId ?? null,
          kind: "keyword_metrics",
          observedAt: deliveredAt,
          producer: "dataforseo",
          rawResponseId: raw.id,
          dimensions: { query: row.keyword },
          metrics,
        });
      }
    }
  }

  return result;
}
