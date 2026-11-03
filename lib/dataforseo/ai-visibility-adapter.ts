import type { PrismaClient } from "@prisma/client";

import { storeEvidenceRecord, type MetricValue } from "@/lib/funnel/evidence";

/**
 * DS-06 (producer half): AI visibility → typed evidence.
 *
 * The plan's rules, enforced here rather than left to a consumer:
 *  - a real observation is stored with its dataset/surface, model, locale,
 *    observation time, sampling and denominator;
 *  - observed zero (asked, not cited) is a measurement and is stored;
 *  - no measurement (never asked, unsupported engine/market) is *not* stored as
 *    zero and must stay unknown;
 *  - per-question answers are never manufactured from aggregate target metrics;
 *  - incompatible cohorts are never summed into one visibility count.
 */

export type AiVisibilityObservation = {
  question: string;
  /** Engine/surface that answered: perplexity_api, google_ai_overview, llm_mentions, … */
  surface: string;
  /** Model identifier when the provider supplies one. */
  model?: string | null;
  locale: string;
  askedAt: Date;
  /** How many answers were sampled for this question in this run. */
  samples: number;
  /** Of those samples, how many cited us. */
  citationsOfUs: number;
  /** Of those samples, how many cited a competitor. */
  citationsOfCompetitor: number;
  /** Denominator the provider used, when it reports one. */
  denominator?: number | null;
  /** Where the answer came from: dataset id, task id, export reference. */
  dataset?: string | null;
  /** True when the provider answered at all. */
  answered: boolean;
  rawExportReference: string;
};

export type AiVisibilityIngestOptions = {
  projectId: string;
  siteId?: string | null;
  requestedAt: Date;
  deliveredAt?: Date;
  costMicros: bigint;
  /** Provider payload, stored immutably for audit. */
  payload: unknown;
  providerTaskId: string;
};

export type AiVisibilityIngestResult = {
  rawResponseId: string;
  stored: number;
  /** Observations the rules refused, with the reason. Never silently dropped. */
  refused: Array<{ question: string; reason: string }>;
};

export const SUPPORTED_SURFACES = [
  "perplexity_api",
  "google_ai_overview",
  "llm_mentions",
  "llm_responses",
  "chatgpt_search",
] as const;

export function validateObservation(observation: AiVisibilityObservation): string | null {
  if (!observation.question.trim()) return "missing question";
  if (!SUPPORTED_SURFACES.includes(observation.surface as (typeof SUPPORTED_SURFACES)[number])) {
    // An unsupported engine stays unknown; it is not evidence of absence.
    return `unsupported surface "${observation.surface}"`;
  }
  if (!observation.locale.trim()) return "missing locale";
  if (Number.isNaN(observation.askedAt.getTime())) return "missing observation time";
  if (!Number.isInteger(observation.samples) || observation.samples <= 0) return "missing sample count";
  if (observation.citationsOfUs < 0 || observation.citationsOfUs > observation.samples) {
    return "citation count exceeds the sample";
  }
  if (!observation.answered) return "no answer: absence is not a measurement";
  if (!observation.rawExportReference.trim()) return "missing raw reference";
  return null;
}

export async function ingestAiVisibility(
  db: Parameters<typeof storeEvidenceRecord>[0] & Pick<PrismaClient, "rawProviderResponse">,
  observations: AiVisibilityObservation[],
  options: AiVisibilityIngestOptions
): Promise<AiVisibilityIngestResult> {
  const deliveredAt = options.deliveredAt ?? new Date();
  const raw = await db.rawProviderResponse.create({
    data: {
      provider: "dataforseo",
      product: "ai_visibility",
      endpoint: "task_get",
      providerTaskId: options.providerTaskId,
      locale: null,
      requestedAt: options.requestedAt,
      deliveredAt,
      costMicros: options.costMicros,
      status: "succeeded",
      payload: options.payload as never,
    },
    select: { id: true },
  });

  const refused: Array<{ question: string; reason: string }> = [];
  let stored = 0;

  for (const observation of observations) {
    const reason = validateObservation(observation);
    if (reason) {
      refused.push({ question: observation.question, reason });
      continue;
    }

    const metrics: Record<string, MetricValue> = {
      // Observed zero is stored as a real 0: we asked and were not cited.
      "provider:citedCount": { value: observation.citationsOfUs, unit: "count", source: "provider" },
      "provider:competitorCitedCount": { value: observation.citationsOfCompetitor, unit: "count", source: "provider" },
      "provider:samples": { value: observation.samples, unit: "count", source: "provider" },
    };
    if (observation.denominator != null) {
      metrics["provider:denominator"] = { value: observation.denominator, unit: "count", source: "provider" };
    }

    await storeEvidenceRecord(db, {
      projectId: options.projectId,
      siteId: options.siteId ?? null,
      kind: "ai_visibility_observation",
      observedAt: observation.askedAt,
      producer: "dataforseo",
      rawResponseId: raw.id,
      dimensions: {
        question: observation.question,
        surface: observation.surface,
        model: observation.model ?? null,
        locale: observation.locale,
        dataset: observation.dataset ?? null,
        rawExportReference: observation.rawExportReference,
        answered: "true",
      },
      metrics,
    });
    stored += 1;
  }

  return { rawResponseId: raw.id, stored, refused };
}

/**
 * Visibility is only computable within one cohort. Summing citations across
 * engines, models or locales produces a number that means nothing, so the
 * cohort key is explicit and aggregation across cohorts is refused.
 */
export type VisibilityCohort = {
  surface: string;
  model: string | null;
  locale: string;
  observations: number;
  /** Questions asked in this cohort. */
  questions: number;
  /** Questions where we were cited at least once. */
  citedQuestions: number;
  /** Questions asked and not cited: a measurement, not a gap. */
  uncitedQuestions: number;
  /** Share of asked questions that cited us. */
  citationRate: number | null;
};

export function visibilityCohorts(
  rows: Array<{ surface: string; model: string | null; locale: string; question: string; cited: number }>
): VisibilityCohort[] {
  const cohorts = new Map<string, Array<{ question: string; cited: number }>>();
  const meta = new Map<string, { surface: string; model: string | null; locale: string }>();
  for (const row of rows) {
    const key = `${row.surface}|${row.model ?? ""}|${row.locale}`;
    cohorts.set(key, [...(cohorts.get(key) ?? []), { question: row.question, cited: row.cited }]);
    meta.set(key, { surface: row.surface, model: row.model, locale: row.locale });
  }
  return [...cohorts.entries()].map(([key, entries]) => {
    const identity = meta.get(key)!;
    const byQuestion = new Map<string, number>();
    for (const entry of entries) {
      byQuestion.set(entry.question, Math.max(byQuestion.get(entry.question) ?? 0, entry.cited));
    }
    const questions = byQuestion.size;
    const citedQuestions = [...byQuestion.values()].filter((cited) => cited > 0).length;
    return {
      ...identity,
      observations: entries.length,
      questions,
      citedQuestions,
      uncitedQuestions: questions - citedQuestions,
      citationRate: questions === 0 ? null : citedQuestions / questions,
    };
  });
}

/** Refuse to present one visibility number across incompatible cohorts. */
export function assertSingleCohort(cohorts: VisibilityCohort[]): void {
  const keys = new Set(cohorts.map((cohort) => `${cohort.surface}|${cohort.model ?? ""}|${cohort.locale}`));
  if (keys.size > 1) {
    throw new Error(
      `cannot aggregate visibility across ${keys.size} cohorts (surface/model/locale); report them separately`
    );
  }
}
