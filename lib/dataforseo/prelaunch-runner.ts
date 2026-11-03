import { db } from "@/lib/db";
import { projectConnectorBudget, reserveProjectConnectorBudget, settleConnectorBudget, ConnectorError } from "@/lib/connectors/service";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";
import { performDataForSeoOperation, type DataForSeoOperation } from "@/lib/dataforseo/client";
import type { PrelaunchTaskPlan } from "@/lib/dataforseo/prelaunch";

/**
 * DS-02 prelaunch cutover: the runner reads and writes `ResearchRun` only.
 *
 * The legacy runner kept one row per provider call in `SeoResearchTask` and
 * derived the report from them. The plan now lives in the run's brief and each
 * result is appended to the run's report as it lands, which keeps the resume
 * property the task rows provided: a retry never pays twice for a call that
 * already produced a result.
 */

export type PrelaunchReportEntry = {
  operation_key: string;
  kind: string;
  status: "completed" | "failed" | "uncertain";
  result: unknown;
  cost_micros: number | null;
  error_code: string | null;
  seed: string | null;
};

export type PrelaunchRunBrief = {
  family?: string;
  period?: string;
  packageVersion?: string;
  tasks?: PrelaunchTaskPlan[];
};

const SKIPPED = [
  { task: "own_domain_overview", reason: "no_domain_available" },
  { task: "own_backlinks", reason: "no_domain_available" },
  { task: "gsc_ga4", reason: "no_site_integrations_available" },
  { task: "crawl_history", reason: "no_site_to_crawl" },
  { task: "competitor", reason: "no_competitor_selected" },
];

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function reportEntries(report: unknown): PrelaunchReportEntry[] {
  const rows = object(report).dataforseo;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    const entry = object(row);
    const operationKey = typeof entry.operation_key === "string" ? entry.operation_key : null;
    if (!operationKey) return [];
    const status = entry.status === "completed" || entry.status === "failed" || entry.status === "uncertain" ? entry.status : "failed";
    return [{
      operation_key: operationKey,
      kind: typeof entry.kind === "string" ? entry.kind : "keyword_seed",
      status,
      result: entry.result ?? null,
      cost_micros: typeof entry.cost_micros === "number" ? entry.cost_micros : null,
      error_code: typeof entry.error_code === "string" ? entry.error_code : null,
      seed: typeof entry.seed === "string" ? entry.seed : null,
    }];
  });
}

/** Completed calls decide the status; a partial run is not a success. */
export function prelaunchRunStatus(entries: PrelaunchReportEntry[], planned: number): "COMPLETED" | "PARTIAL" | "FAILED" {
  const completed = entries.filter((entry) => entry.status === "completed").length;
  if (planned > 0 && completed === planned) return "COMPLETED";
  if (completed > 0 || entries.some((entry) => entry.status === "uncertain" || entry.status === "failed")) return "PARTIAL";
  return "FAILED";
}

export function buildPrelaunchReport(period: string, entries: PrelaunchReportEntry[]): Record<string, unknown> {
  return {
    schema_version: 1,
    period,
    generated_at: new Date().toISOString(),
    domainless: true,
    dataforseo: entries,
    skipped: SKIPPED,
  };
}

export async function runPrelaunchResearch(projectId: string, researchRunId: string) {
  const run = await db.researchRun.findFirst({ where: { id: researchRunId, projectId, kind: "PRELAUNCH" } });
  if (!run) throw new Error("PRELAUNCH_RESEARCH_NOT_FOUND");
  if (run.status === "COMPLETED" || run.status === "PARTIAL" || run.status === "FAILED") return run;

  const brief = object(run.brief) as PrelaunchRunBrief;
  const tasks = Array.isArray(brief.tasks) ? brief.tasks : [];
  const period = typeof brief.period === "string" ? brief.period : run.createdAt.toISOString().slice(0, 7);

  const principal = { projectId } as ServicePrincipalContext;
  const budget = await projectConnectorBudget(principal);
  if (!budget.configured || !budget.allowanceMicros || !budget.maxOperationMicros || budget.currency !== "USD") {
    throw new ConnectorError("A USD allowance and operation ceiling are required", 409);
  }

  await db.researchRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt: run.startedAt ?? new Date() } });

  const entries = reportEntries(run.report);
  // Anything already attempted is not retried, exactly like the task statuses
  // did: a failed call stays failed rather than spending twice on resume.
  const attempted = new Set(entries.map((entry) => entry.operation_key));

  for (const task of tasks) {
    if (attempted.has(task.operationKey)) continue;
    const operation: DataForSeoOperation = {
      kind: "KEYWORD_SEED",
      seed: task.input.seed,
      languageCode: task.input.language_code,
      locationCode: task.input.location_code,
    };
    const reservation = await reserveProjectConnectorBudget(principal, {
      period: budget.period,
      policyRevision: budget.policyRevision,
      idempotencyKey: `dataforseo-task:${run.id}:${task.operationKey}`,
      amountMicros: budget.maxOperationMicros,
      currency: "USD",
      operation: "dataforseo:keyword_seed",
      detail: { researchRunId: run.id, operationKey: task.operationKey },
    });

    let entry: PrelaunchReportEntry;
    try {
      const result = await performDataForSeoOperation(projectId, operation);
      if (result.costMicros == null) {
        await settleConnectorBudget(principal, reservation.id, { status: "uncertain", providerTaskId: result.providerTaskId, detail: { reason: "provider_cost_missing" } });
        entry = { operation_key: task.operationKey, kind: "keyword_seed", status: "uncertain", result: result.result, cost_micros: null, error_code: "PROVIDER_COST_MISSING", seed: task.input.seed };
      } else {
        await settleConnectorBudget(principal, reservation.id, { status: "settled", actualCostMicros: String(result.costMicros), providerTaskId: result.providerTaskId });
        entry = { operation_key: task.operationKey, kind: "keyword_seed", status: "completed", result: result.result, cost_micros: result.costMicros, error_code: null, seed: task.input.seed };
      }
    } catch (error) {
      const uncertain = error instanceof Error && /timeout|network|fetch failed/i.test(error.message);
      await settleConnectorBudget(principal, reservation.id, { status: uncertain ? "uncertain" : "released", detail: { reason: "provider_failure" } });
      entry = { operation_key: task.operationKey, kind: "keyword_seed", status: uncertain ? "uncertain" : "failed", result: null, cost_micros: null, error_code: "DATAFORSEO_TASK_FAILED", seed: task.input.seed };
    }

    entries.push(entry);
    // Persist after every call so a crash mid-run resumes without repaying.
    await db.researchRun.update({ where: { id: run.id }, data: { report: buildPrelaunchReport(period, entries) as never } });
  }

  const status = prelaunchRunStatus(entries, tasks.length);
  const costMicros = entries.reduce((sum, entry) => sum + (entry.cost_micros ?? 0), 0);
  return db.researchRun.update({
    where: { id: run.id },
    data: {
      status,
      report: buildPrelaunchReport(period, entries) as never,
      costMicros,
      findingCount: entries.filter((entry) => entry.status === "completed").length,
      completedAt: new Date(),
      errorCode: status === "FAILED" ? "ALL_DATAFORSEO_TASKS_FAILED" : null,
    },
  });
}
