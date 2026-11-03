import type { PrismaClient } from "@prisma/client";

import { readKeywordRows } from "@/lib/dataforseo/research-evidence";

/**
 * DS-02, read half: the keyword research screen reads provider rows from the
 * evidence store instead of the run's duplicated `result` blob.
 *
 * The run row stays as the job record (status, cost, idempotency) until the
 * unification onto `ResearchRun` lands. What moves now is the *data*: evidence
 * already holds it with provenance, so the screen no longer needs a second copy.
 *
 * A run that was never bridged (no recorded cost, or created before the bridge)
 * falls back to its stored result, so nothing disappears from the UI.
 */

export type KeywordEvidenceRow = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: string | null;
  trend: number[] | null;
};

export type KeywordEvidenceDb = Pick<PrismaClient, "rawProviderResponse" | "evidenceRecord">;

/** The raw response identity the bridge uses for a stored run. */
export function rawTaskIdForRun(run: { id: string; providerTaskId: string | null }): string {
  return run.providerTaskId ?? `stored-run:${run.id}`;
}

export async function keywordRowsFromEvidence(
  db: KeywordEvidenceDb,
  run: { id: string; providerTaskId: string | null }
): Promise<KeywordEvidenceRow[] | null> {
  const raw = await db.rawProviderResponse.findUnique({
    where: { provider_providerTaskId: { provider: "dataforseo", providerTaskId: rawTaskIdForRun(run) } },
    select: { id: true },
  });
  if (!raw) return null;

  const records = await db.evidenceRecord.findMany({
    where: { kind: "keyword_metrics", rawResponseId: raw.id, supersededById: null },
    select: { dimensions: true, metrics: true },
  });

  const rows = records.flatMap((record) => {
    const dims = (record.dimensions ?? {}) as { query?: string };
    if (!dims.query) return [];
    const metrics = (record.metrics ?? {}) as Record<string, { value: number | null }>;
    return [
      {
        keyword: dims.query,
        volume: metrics["provider:volume"]?.value ?? null,
        difficulty: metrics["provider:difficulty"]?.value ?? null,
        cpc: metrics["provider:cpc"]?.value ?? null,
        competition: metrics["provider:competition"]?.value ?? null,
        // Intent and trend are not stored as evidence yet; the UI renders "—".
        intent: null,
        trend: null,
      },
    ];
  });

  if (rows.length === 0) return null;
  // Highest volume first, matching how the screen sorted the stored result.
  return rows.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
}

/**
 * Rows for the screen: evidence first, stored result as fallback. Never throws —
 * a read failure degrades to the legacy path rather than blanking the page.
 */
export async function keywordRowsForScreen(
  db: KeywordEvidenceDb,
  run: { id: string; providerTaskId: string | null; result: unknown }
): Promise<{ rows: KeywordEvidenceRow[]; source: "evidence" | "stored_result" }> {
  try {
    const fromEvidence = await keywordRowsFromEvidence(db, run);
    if (fromEvidence) return { rows: fromEvidence, source: "evidence" };
  } catch {
    // fall through to the stored result
  }
  return {
    rows: readKeywordRows(run.result).map((row) => ({ ...row, intent: null, trend: null })),
    source: "stored_result",
  };
}
