import { db } from "@/lib/db";

type Row = Record<string, unknown>;
const object = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const items = (v: unknown): Row[] => Array.isArray(v) ? v.filter((x): x is Row => !!x && typeof x === "object" && !Array.isArray(x)) : [];
export const unknownValue = (v: unknown) => v === null || v === undefined || v === "" ? "Unknown" : String(v);

export function prelaunchTaskView(task: { id: string; kind: string; status: string; costMicros: number | null; input: unknown; result: unknown; errorCode: string | null }) {
  const input = object(task.input), seed = typeof input.seed === "string" ? input.seed : "Unknown";
  const values = items(task.result);
  return { id: task.id, kind: task.kind, status: task.status, costMicros: task.costMicros, seed, errorCode: task.errorCode,
    keywords: values.map((x) => ({ keyword: unknownValue(x.keyword), volume: unknownValue(x.volume), difficulty: unknownValue(x.difficulty), intent: unknownValue(x.intent) })) };
}

export function prelaunchSkipReasons(report: unknown) {
  const skips = items(object(report).skipped);
  return skips.map((s) => ({ task: unknownValue(s.task), reason: unknownValue(s.reason) }));
}

export async function getPrelaunchReport(projectId: string, runId: string) {
  const run = await db.seoResearchRun.findFirst({ where: { id: runId, projectId, siteId: null }, include: { tasks: { orderBy: { createdAt: "asc" } } } });
  if (!run) return null;
  const actions = await db.researchAction.findMany({ where: { projectId, source: "keyword_research" }, select: { id: true, title: true, siteId: true, evidence: true }, orderBy: { createdAt: "desc" }, take: 200 });
  const linkedActions = actions.filter((a) => object(a.evidence).research_run_id === runId);
  return { id: run.id, period: run.periodStart.toISOString().slice(0, 7), status: run.status, totalCostMicros: run.actualCostMicros,
    tasks: run.tasks.map(prelaunchTaskView), skipped: prelaunchSkipReasons(run.report), actions: linkedActions };
}
