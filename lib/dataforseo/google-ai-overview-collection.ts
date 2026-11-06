import type { PrismaClient } from "@prisma/client";

import { evaluateGoogleAiOverviewQuestion } from "@/lib/aeo/google-ai-overview";
import { withResearchBudget, type CollectedEvidence } from "@/lib/dataforseo/collection";
import { storeEvidenceRecord, type MetricValue } from "@/lib/funnel/evidence";

/**
 * Google AI Overviews as measured AEO/GEO evidence.
 *
 * The ChatGPT `llm_responses` path is a valid surface, but it costs roughly
 * $0.027 per question. The monthly bundle needs 10–20 measured questions inside
 * a small cap, so the bundle uses the Google AI Overview item DataForSEO already
 * returns from a normal advanced SERP call (~$0.002). It is still a measured
 * observation: the answer text and its citations come from the provider.
 *
 * The evaluator in `lib/aeo/google-ai-overview.ts` deliberately does not persist
 * anything. This adapter adds the two things the evidence store requires: a
 * budget reservation around every paid call and a RawProviderResponse before any
 * provider-sourced metric.
 */

export type GoogleAiOverviewCollectionInput = {
  projectId: string;
  siteId: string | null;
  questions: string[];
  languageCode: string;
  locationCode: number;
  domain: string;
  brand?: string | null;
  device?: "desktop" | "mobile";
  /** Distinguishes an explicit retry; see `CollectionInput.attempt`. */
  attempt?: string;
};

export type GoogleAiOverviewCollectionOutput = {
  evidence: CollectedEvidence[];
  spentMicros: number;
  /** Asked, but Google returned no AI Overview. Not evidence of absence. */
  absent: string[];
  failed: Array<{ question: string; error: string }>;
};

type CollectionDb = Pick<PrismaClient, "rawProviderResponse"> & Parameters<typeof storeEvidenceRecord>[0];

export async function collectGoogleAiOverviews(
  db: CollectionDb,
  input: GoogleAiOverviewCollectionInput
): Promise<GoogleAiOverviewCollectionOutput> {
  const evidence: CollectedEvidence[] = [];
  const absent: string[] = [];
  const failed: Array<{ question: string; error: string }> = [];
  let spentMicros = 0;

  const host = input.domain.replace(/^www\./, "").toLowerCase();
  const device = input.device ?? "desktop";
  const locale = `${input.languageCode}:${input.locationCode}`;

  for (const question of input.questions) {
    const { result, spentMicros: callSpent } = await withResearchBudget(input.projectId, {
      operation: "dataforseo:ai_overview",
      detail: { question, locale, device, attempt: input.attempt ?? null },
      expectedMicros: 3_000,
      run: () =>
        evaluateGoogleAiOverviewQuestion({
          projectId: input.projectId,
          question,
          locale: { languageCode: input.languageCode, locationCode: input.locationCode },
          device,
          brand: input.brand ?? null,
        }),
      costOf: (value) => value.costMicros ?? 0,
    });
    spentMicros += callSpent;

    if (result.state === "overview_absent") {
      absent.push(question);
      continue;
    }
    if (result.state !== "succeeded") {
      failed.push({ question, error: result.error ?? result.state });
      continue;
    }

    const citations = result.citations ?? [];
    const ours = citations.filter((url) => url.toLowerCase().includes(host)).length;
    const competitors = citations.filter((url) => !url.toLowerCase().includes(host)).length;
    const observedAt = new Date();

    const raw = await storeRawProviderResponse(db, {
      provider: "dataforseo",
      product: "ai_visibility",
      endpoint: "serp/google/organic/live/advanced",
      providerTaskId: result.taskId,
      locale,
      requestedAt: observedAt,
      deliveredAt: observedAt,
      costMicros: BigInt(callSpent),
      status: "succeeded",
      payload: result as never,
    });

    const metrics: Record<string, MetricValue> = {
      "provider:citedCount": { value: ours, unit: "count", source: "provider" },
      "provider:competitorCitedCount": { value: competitors, unit: "count", source: "provider" },
      "provider:samples": { value: 1, unit: "count", source: "provider" },
      "provider:denominator": { value: citations.length, unit: "count", source: "provider" },
    };
    if (result.brandPresent !== null) {
      metrics["provider:brandPresent"] = { value: result.brandPresent ? 1 : 0, unit: "flag", source: "provider" };
    }

    const dimensions = {
      question,
      // A punctuated question is sent cleaned; the evidence says which phrase
      // was actually searched so the observation can be reproduced.
      ...(result.searchedKeyword && result.searchedKeyword !== question
        ? { searchedKeyword: result.searchedKeyword }
        : {}),
      surface: "google_ai_overview",
      model: null,
      locale,
      dataset: result.taskId,
      rawExportReference: `dataforseo:${result.taskId ?? "unknown"}`,
      answered: "true",
      device,
    };
    const stored = await storeEvidenceRecord(db, {
      projectId: input.projectId,
      siteId: input.siteId,
      kind: "ai_visibility_observation",
      observedAt,
      producer: "dataforseo",
      rawResponseId: raw.id,
      dimensions,
      metrics,
    });
    evidence.push({ id: stored.id, kind: "ai_visibility_observation", observedAt, dimensions, metrics });
  }

  return { evidence, spentMicros, absent, failed };
}

async function storeRawProviderResponse(
  db: Pick<PrismaClient, "rawProviderResponse">,
  data: {
    provider: string;
    product: string;
    endpoint: string;
    providerTaskId: string | null;
    locale: string;
    requestedAt: Date;
    deliveredAt: Date;
    costMicros: bigint;
    status: string;
    payload: never;
  }
): Promise<{ id: string }> {
  try {
    return await db.rawProviderResponse.create({ data, select: { id: true } });
  } catch (error) {
    // A retried task id is the same immutable provider payload, not a new one.
    if ((error as { code?: string }).code !== "P2002" || !data.providerTaskId) throw error;
    const existing = await db.rawProviderResponse.findFirst({
      where: { provider: data.provider, providerTaskId: data.providerTaskId },
      select: { id: true },
    });
    if (!existing) throw error;
    return existing;
  }
}
