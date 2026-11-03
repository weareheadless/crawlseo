import { db } from "@/lib/db";
import { legacyStatus } from "@/lib/dataforseo/prelaunch";
import { reportEntries } from "@/lib/dataforseo/prelaunch-runner";

type Row = Record<string, unknown>;
const object = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const items = (v: unknown): Row[] => Array.isArray(v) ? v.filter((x): x is Row => !!x && typeof x === "object" && !Array.isArray(x)) : [];
export const unknownValue = (v: unknown) => v === null || v === undefined || v === "" ? "Unknown" : String(v);

/** `keyword:1:freediving coach:en:MX` → the seed, so old rows keep their label. */
function seedFromOperationKey(key: string): string {
  const parts = key.split(":");
  return parts.length > 4 ? parts.slice(2, parts.length - 2).join(":") : "Unknown";
}

export function prelaunchTaskView(task: { id: string; kind: string; status: string; costMicros: number | null; seed: string; errorCode: string | null; result: unknown }) {
  const values = items(task.result);
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    costMicros: task.costMicros,
    seed: task.seed,
    errorCode: task.errorCode,
    keywords: values.map((x) => ({
      keyword: unknownValue(x.keyword),
      volume: unknownValue(x.volume),
      difficulty: unknownValue(x.difficulty),
      intent: unknownValue(x.intent),
    })),
  };
}

export function prelaunchSkipReasons(report: unknown) {
  const skips = items(object(report).skipped);
  return skips.map((s) => ({ task: unknownValue(s.task), reason: unknownValue(s.reason) }));
}

/**
 * DS-02 prelaunch cutover: the report reads the unified run.
 *
 * Task rows are gone; the plan and results live in the run's brief and report.
 * The returned shape is unchanged so the page did not have to move.
 */
export async function getPrelaunchReport(projectId: string, runId: string) {
  const run = await db.researchRun.findFirst({
    where: { id: runId, projectId, kind: "PRELAUNCH" },
    select: { id: true, status: true, brief: true, report: true, costMicros: true, createdAt: true },
  });
  if (!run) return null;

  const brief = object(run.brief);
  // Legacy shadows stored a full ISO date; the page shows a month.
  const period = typeof brief.period === "string" ? brief.period.slice(0, 7) : run.createdAt.toISOString().slice(0, 7);
  const entries = reportEntries(run.report);

  const actions = await db.researchAction.findMany({
    where: { projectId, source: "keyword_research" },
    select: { id: true, title: true, siteId: true, evidence: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const linkedActions = actions.filter((a) => object(a.evidence).research_run_id === runId);

  return {
    id: run.id,
    period,
    status: legacyStatus(run.status).toUpperCase(),
    totalCostMicros: run.costMicros,
    tasks: entries.map((entry) =>
      prelaunchTaskView({
        id: entry.operation_key,
        kind: entry.kind.toUpperCase(),
        status: entry.status,
        costMicros: entry.cost_micros,
        seed: entry.seed ?? seedFromOperationKey(entry.operation_key),
        errorCode: entry.error_code,
        result: entry.result,
      })
    ),
    skipped: prelaunchSkipReasons(run.report),
    actions: linkedActions,
  };
}
