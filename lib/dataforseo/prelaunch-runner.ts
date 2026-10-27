import { Prisma, SeoResearchRunStatus, SeoResearchTaskStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { projectConnectorBudget, reserveProjectConnectorBudget, settleConnectorBudget, ConnectorError } from "@/lib/connectors/service";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";
import { executeDataForSeoOperation, type DataForSeoOperation } from "@/lib/dataforseo/client";

const json = (v: unknown) => v as Prisma.InputJsonValue;
export async function runPrelaunchResearch(projectId: string, researchRunId: string) {
  const run = await db.seoResearchRun.findFirst({ where: { id: researchRunId, projectId, siteId: null }, include: { tasks: { orderBy: { createdAt: "asc" } } } });
  if (!run) throw new Error("PRELAUNCH_RESEARCH_NOT_FOUND");
  if (run.status === SeoResearchRunStatus.COMPLETED || run.status === SeoResearchRunStatus.PARTIAL || run.status === SeoResearchRunStatus.FAILED) return run;
  const principal = { projectId } as ServicePrincipalContext;
  const budget = await projectConnectorBudget(principal);
  if (!budget.configured || !budget.allowanceMicros || !budget.maxOperationMicros || budget.currency !== "USD") throw new ConnectorError("A USD allowance and operation ceiling are required", 409);
  await db.seoResearchRun.update({ where: { id: run.id }, data: { status: SeoResearchRunStatus.RUNNING_PAID_RESEARCH, startedAt: run.startedAt ?? new Date() } });
  let successes = 0;
  for (const task of run.tasks) {
    if (task.status === SeoResearchTaskStatus.UNCERTAIN) continue;
    if (task.status !== SeoResearchTaskStatus.RESERVED) { if (task.status === SeoResearchTaskStatus.COMPLETED) successes++; continue; }
    const input = task.input as Record<string, unknown>;
    const operation: DataForSeoOperation = { kind: "KEYWORD_SEED", seed: String(input.seed), languageCode: String(input.language_code), locationCode: Number(input.location_code) };
    const reservation = await reserveProjectConnectorBudget(principal, { period: budget.period, policyRevision: budget.policyRevision,
      idempotencyKey: `dataforseo-task:${run.id}:${task.operationKey}`, amountMicros: budget.maxOperationMicros, currency: "USD", operation: "dataforseo:keyword_seed", detail: { researchRunId: run.id, operationKey: task.operationKey } });
    await db.seoResearchTask.updateMany({ where: { id: task.id, status: SeoResearchTaskStatus.RESERVED }, data: { status: SeoResearchTaskStatus.ATTEMPTING, attemptedAt: new Date() } });
    try {
      const result = await executeDataForSeoOperation({ projectId, researchRunId: run.id, taskId: task.id, operation });
      if (result.costMicros == null) {
        await settleConnectorBudget(principal, reservation.id, { status: "uncertain", providerTaskId: result.providerTaskId, detail: { reason: "provider_cost_missing" } });
        await db.seoResearchTask.update({ where: { id: task.id }, data: { status: SeoResearchTaskStatus.UNCERTAIN, errorCode: "PROVIDER_COST_MISSING", completedAt: new Date() } }); continue;
      }
      await settleConnectorBudget(principal, reservation.id, { status: "settled", actualCostMicros: String(result.costMicros), providerTaskId: result.providerTaskId });
      await db.seoResearchTask.update({ where: { id: task.id }, data: { status: SeoResearchTaskStatus.COMPLETED, providerTaskId: result.providerTaskId, costMicros: result.costMicros, result: json(result.result), completedAt: new Date() } }); successes++;
    } catch (e) {
      const uncertain = e instanceof Error && /timeout|network|fetch failed/i.test(e.message);
      await settleConnectorBudget(principal, reservation.id, { status: uncertain ? "uncertain" : "released", detail: { reason: "provider_failure" } });
      await db.seoResearchTask.update({ where: { id: task.id }, data: { status: uncertain ? SeoResearchTaskStatus.UNCERTAIN : SeoResearchTaskStatus.FAILED, errorCode: "DATAFORSEO_TASK_FAILED", completedAt: new Date() } });
    }
  }
  const tasks = await db.seoResearchTask.findMany({ where: { researchRunId: run.id }, orderBy: { createdAt: "asc" } });
  const completed = tasks.filter(t => t.status === SeoResearchTaskStatus.COMPLETED).length;
  const status = completed === tasks.length ? SeoResearchRunStatus.COMPLETED : tasks.some(t => t.status === SeoResearchTaskStatus.UNCERTAIN) || completed > 0 || tasks.some(t => t.status === SeoResearchTaskStatus.FAILED) ? SeoResearchRunStatus.PARTIAL : SeoResearchRunStatus.FAILED;
  const report = { schema_version: 1, period: run.periodStart.toISOString().slice(0, 7), generated_at: new Date().toISOString(),
    domainless: true, dataforseo: tasks.map(t => ({ operation_key: t.operationKey, kind: t.kind.toLowerCase(), status: t.status.toLowerCase(), result: t.result, cost_micros: t.costMicros, error_code: t.errorCode })),
    skipped: [{ task: "own_domain_overview", reason: "no_domain_available" }, { task: "own_backlinks", reason: "no_domain_available" }, { task: "gsc_ga4", reason: "no_site_integrations_available" }, { task: "crawl_history", reason: "no_site_to_crawl" }, { task: "competitor", reason: "no_competitor_selected" }] };
  return db.seoResearchRun.update({ where: { id: run.id }, data: { status, attemptedCount: tasks.filter(t => t.status !== "RESERVED").length,
    actualCostMicros: tasks.reduce((sum, t) => sum + (t.costMicros ?? 0), 0), report: json(report), sourceManifest: json(report), completedAt: new Date(), errorCode: status === SeoResearchRunStatus.FAILED ? "ALL_DATAFORSEO_TASKS_FAILED" : null } });
}
