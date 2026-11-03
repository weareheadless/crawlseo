import { Prisma, type PrismaClient } from "@prisma/client";

import { storeEvidenceRecord } from "@/lib/funnel/evidence";

/**
 * Bridge: stored DataForSEO research runs → funnel evidence.
 *
 * The keyword research and article research runs already hold provider data in
 * their `result` column, but the funnel cannot reason about a JSON blob. This
 * projects each stored result into `keyword_metrics` evidence with declared
 * provider metrics, so the demand map and the opportunity detectors can use it.
 *
 * Provenance is preserved rather than asserted: the stored result is written to
 * `RawProviderResponse` first, and the evidence points at it. A run with no
 * recorded cost is reported as unpriced instead of being given a fake one.
 */

export type ResearchEvidenceDb = Pick<PrismaClient, "rawProviderResponse" | "evidenceRecord" | "articleKeywordResearchRun"> &
  Parameters<typeof storeEvidenceRecord>[0];

export type StoredKeywordRun = {
  id: string;
  siteId: string;
  projectId: string;
  providerTaskId: string | null;
  costMicros: number | null;
  result: unknown;
  language: string;
  country: string;
  completedAt: Date | null;
  requestedAt: Date;
};

type KeywordRow = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
};

/** The stored result is either an array of keyword rows or an object wrapping one. */
export function readKeywordRows(result: unknown): KeywordRow[] {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray((result as { items?: unknown }).items)
      ? ((result as { items: unknown[] }).items)
      : [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const value = row as Record<string, unknown>;
    const keyword = typeof value.keyword === "string" ? value.keyword : null;
    if (!keyword) return [];
    const num = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : null);
    return [{ keyword, volume: num("volume"), difficulty: num("difficulty"), cpc: num("cpc"), competition: num("competition") }];
  });
}

export type ResearchEvidenceResult = {
  rows: number;
  stored: number;
  skipped: number;
  /** Runs whose stored result was already ingested under the same raw identity. */
  rawResponseId: string | null;
};

/**
 * Release the duplicated payload once the evidence store owns it.
 *
 * The plan's rule is one home for raw provider data. After a run is bridged, its
 * `result` column is a second copy of a payload that already lives in
 * `RawProviderResponse`, so it is cleared. This is safe only because the raw row
 * exists first and the screen reads evidence; a run that was not bridged keeps its
 * result, so nothing is lost.
 */
export async function releaseBridgedRunResult(
  db: Pick<PrismaClient, "rawProviderResponse" | "articleKeywordResearchRun">,
  run: { id: string; providerTaskId: string | null }
): Promise<boolean> {
  const raw = await db.rawProviderResponse.findUnique({
    where: {
      provider_providerTaskId: {
        provider: "dataforseo",
        providerTaskId: run.providerTaskId ?? `stored-run:${run.id}`,
      },
    },
    select: { id: true },
  });
  if (!raw) return false;
  await db.articleKeywordResearchRun.update({ where: { id: run.id }, data: { result: Prisma.DbNull } });
  return true;
}

/**
 * Ingest one stored keyword run. Idempotent: the raw response is keyed by the
 * provider task id, and evidence is keyed by the observation hash, so replaying
 * the same run adds nothing.
 */
export async function bridgeKeywordRunToEvidence(
  db: ResearchEvidenceDb,
  run: StoredKeywordRun
): Promise<ResearchEvidenceResult> {
  const rows = readKeywordRows(run.result);
  if (rows.length === 0) return { rows: 0, stored: 0, skipped: 0, rawResponseId: null };
  if (run.costMicros == null) {
    // Paid data without a recorded cost cannot be given a provenance it lacks.
    return { rows: rows.length, stored: 0, skipped: rows.length, rawResponseId: null };
  }

  const deliveredAt = run.completedAt ?? run.requestedAt;
  const raw = await db.rawProviderResponse.upsert({
    where: {
      provider_providerTaskId: {
        provider: "dataforseo",
        providerTaskId: run.providerTaskId ?? `stored-run:${run.id}`,
      },
    },
    create: {
      provider: "dataforseo",
      product: "keywords_data",
      endpoint: "stored_run_import",
      providerTaskId: run.providerTaskId ?? `stored-run:${run.id}`,
      locale: `${run.language}-${run.country}`,
      requestedAt: run.requestedAt,
      deliveredAt,
      costMicros: BigInt(run.costMicros),
      status: "succeeded",
      payload: run.result as never,
    },
    update: {},
    select: { id: true },
  });

  let stored = 0;
  for (const row of rows) {
    await storeEvidenceRecord(db, {
      projectId: run.projectId,
      siteId: run.siteId,
      kind: "keyword_metrics",
      observedAt: deliveredAt,
      producer: "dataforseo",
      rawResponseId: raw.id,
      dimensions: { query: row.keyword, locale: `${run.language}-${run.country}` },
      metrics: {
        ...(row.volume == null ? {} : { "provider:volume": { value: row.volume, unit: "searches/month", source: "provider" as const } }),
        ...(row.difficulty == null ? {} : { "provider:difficulty": { value: row.difficulty, unit: "score", source: "provider" as const } }),
        ...(row.cpc == null ? {} : { "provider:cpc": { value: row.cpc, unit: "currency", source: "provider" as const } }),
        ...(row.competition == null ? {} : { "provider:competition": { value: row.competition, unit: "score", source: "provider" as const } }),
      },
    });
    stored += 1;
  }

  return { rows: rows.length, stored, skipped: rows.length - stored, rawResponseId: raw.id };
}
