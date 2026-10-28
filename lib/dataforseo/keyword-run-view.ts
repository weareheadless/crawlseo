export type KeywordRunRow = {
  id: string;
  seed: string;
  kind: string;
  status: string;
  requestedAt: string;
  completedAt: string | null;
  costMicros: number | null;
  errorCode: string | null;
  keywordCount: number | null;
  resultLabel: string;
  keywords: Array<{
    keyword: string;
    volume: number | null;
    difficulty: number | null;
    cpc: number | null;
    competition: number | null;
    intent: string | null;
    trend: number[] | null;
  }>;
};

type StoredRun = {
  id: string;
  seed: string;
  kind: string;
  status: string;
  requestedAt: Date;
  completedAt: Date | null;
  costMicros: number | null;
  errorCode: string | null;
  result: unknown;
};

function organicCount(result: unknown): number | null {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const organic = (result as { organic?: unknown }).organic;
    if (Array.isArray(organic)) return organic.length;
  }
  return null;
}

/**
 * Stored runs are not all keyword lists: ORGANIC_SERP runs store ranked results.
 * The count column must say which one it is instead of printing "0 keywords".
 */
export function keywordRunRows(runs: StoredRun[]): KeywordRunRow[] {
  return runs.map((run) => {
    const failed = run.status === "FAILED";
    const keywords = !failed && Array.isArray(run.result)
      ? (run.result as Array<Record<string, unknown>>).map((row) => ({
          keyword: String(row.keyword ?? ""),
          volume: typeof row.volume === "number" ? row.volume : null,
          difficulty: typeof row.difficulty === "number" ? row.difficulty : null,
          cpc: typeof row.cpc === "number" ? row.cpc : null,
          competition: typeof row.competition === "number" ? row.competition : null,
          intent: typeof row.intent === "string" ? row.intent : null,
          trend: Array.isArray(row.trend) ? (row.trend as number[]) : null,
        }))
      : [];
    keywords.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
    const organic = failed ? null : organicCount(run.result);
    const keywordCount = failed ? null : Array.isArray(run.result) ? run.result.length : organic;
    return {
      id: run.id,
      seed: run.seed,
      kind: run.kind,
      status: run.status,
      requestedAt: run.requestedAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      costMicros: run.costMicros,
      errorCode: run.errorCode,
      keywordCount,
      resultLabel: organic != null ? "SERP results" : "Keywords",
      keywords,
    };
  });
}
