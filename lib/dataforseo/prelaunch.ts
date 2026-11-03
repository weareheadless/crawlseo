import { JobKind, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";
import { projectConnectorBudget, reserveProjectConnectorBudget } from "@/lib/connectors/service";
import { closedPeriod, ResearchValidationError, validateResearchBrief, STANDARD_PACKAGE_VERSION, STANDARD_TASK_LIMIT } from "@/lib/dataforseo/research";
import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";

const json = (v: unknown) => v as Prisma.InputJsonValue;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** One planned provider call. Stored in the run brief, not in a task table. */
export type PrelaunchTaskPlan = {
  operationKey: string;
  kind: "KEYWORD_SEED";
  ordinal: number;
  input: { seed: string; language_code: string; location_code: number };
  requestHash: string;
};

/**
 * DS-02 prelaunch cutover: the request writes a `ResearchRun` (kind PRELAUNCH),
 * not `SeoResearchRun` + `SeoResearchTask`.
 *
 * The task plan lives in the run's brief and its results in the run's report, so
 * the legacy task table has no writer left. `PrelaunchResearchRequest` stays as
 * the idempotency ledger and now points at the unified run.
 */
export async function requestPrelaunchResearch(input: { projectId: string; brief: unknown; idempotencyKey: string }) {
  const brief = validateResearchBrief(input.brief);
  const key = input.idempotencyKey.trim();
  if (!key || key.length > 240) throw new ResearchValidationError("idempotency_key must be non-empty and at most 240 characters");
  const periodStart = closedPeriod(brief.period).start;
  const packageVersion = brief.package || STANDARD_PACKAGE_VERSION;
  // The existing connector budget query requires a Site. No Site is created;
  // validate the exact same configured project fields and budget reservations.
  const principal = { projectId: input.projectId } as ServicePrincipalContext;
  const budget = await projectConnectorBudget(principal);
  if (budget.configured !== true || !budget.allowanceMicros || BigInt(budget.allowanceMicros) <= BigInt(0) || !budget.maxOperationMicros || BigInt(budget.maxOperationMicros) <= BigInt(0) || budget.currency !== "USD")
    throw new ResearchValidationError("Paid SEO research requires an owner-configured USD monthly allowance and per-operation ceiling");
  const locale = await resolveDataForSeoLocale(input.projectId, brief.focus_market.language, brief.focus_market.country);

  const tasks: PrelaunchTaskPlan[] = brief.keyword_seeds.map((seed, i) => ({
    operationKey: `keyword:${i + 1}:${seed.toLowerCase()}:${brief.focus_market.language}:${brief.focus_market.country}`,
    kind: "KEYWORD_SEED",
    ordinal: i + 1,
    input: { seed, language_code: locale.languageCode, location_code: locale.locationCode },
    requestHash: hash({ seed, language_code: locale.languageCode, location_code: locale.locationCode }),
  }));

  type Result = { runId: string; status: string; existing: boolean };
  let data: Result;
  try {
    data = await db.$transaction(async (tx): Promise<Result> => {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} FOR UPDATE`;
      const requestHash = hash({ projectId: input.projectId, period: brief.period, packageVersion, brief });

      const mapping = await tx.prelaunchResearchRequest.findUnique({
        where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey: key } },
        select: { requestHash: true, researchRunId: true, researchRunRef: true },
      });
      if (mapping) {
        if (mapping.requestHash !== requestHash) throw new ResearchValidationError("idempotency_key is already used for another research request");
        const existingId = mapping.researchRunRef ?? mapping.researchRunId;
        // A mapping written before the cutover points at a SeoResearchRun; its
        // shadow carries the legacy id in the brief.
        const existing = existingId
          ? await tx.researchRun.findUnique({ where: { id: existingId }, select: { id: true, status: true, brief: true } })
            ?? await tx.researchRun.findFirst({
              where: { projectId: input.projectId, kind: "PRELAUNCH", brief: { path: ["legacyRunId"], equals: existingId } },
              select: { id: true, status: true, brief: true },
            })
          : null;
        if (!existing) throw new ResearchValidationError("idempotency_key points at a run that no longer exists");
        const existingPeriod = (existing.brief as { period?: string } | null)?.period;
        if (existingPeriod && existingPeriod !== brief.period) {
          throw new ResearchValidationError("idempotency_key is already used for another research request");
        }
        return { runId: existing.id, status: existing.status, existing: true };
      }

      // One run per project + period, as before: a second request in the same
      // period reuses the run instead of paying for the same keywords twice.
      const byPeriod = await tx.researchRun.findFirst({
        where: { projectId: input.projectId, kind: "PRELAUNCH", brief: { path: ["period"], equals: brief.period } },
        select: { id: true, status: true },
      });
      const run = byPeriod ?? await tx.researchRun.create({
        data: {
          siteId: null,
          projectId: input.projectId,
          kind: "PRELAUNCH",
          trigger: "MANUAL",
          status: "QUEUED",
          title: brief.business_goal?.trim() || `Prelaunch research ${brief.period}`,
          brief: json({ family: "prelaunch_research", period: brief.period, packageVersion, tasks, brief }),
          idempotencyKey: key,
        },
        select: { id: true, status: true },
      });
      await tx.prelaunchResearchRequest.create({
        data: { projectId: input.projectId, researchRunRef: run.id, idempotencyKey: key, requestHash },
      });
      return { runId: run.id, status: run.status, existing: Boolean(byPeriod) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002" || (e as { code?: string }).code === "P2034") {
      throw new ResearchValidationError("Research request raced another project request; retry with the same key");
    }
    throw e;
  }

  if (!data.existing) {
    for (const task of tasks) {
      await reserveProjectConnectorBudget(principal, {
        period: budget.period,
        policyRevision: budget.policyRevision,
        idempotencyKey: `dataforseo-task:${data.runId}:${task.operationKey}`,
        amountMicros: budget.maxOperationMicros!,
        currency: "USD",
        operation: "dataforseo:keyword_seed",
        detail: { researchRunId: data.runId, operationKey: task.operationKey },
      });
    }
  }
  await enqueueJob({
    projectId: input.projectId,
    kind: JobKind.SEO_RESEARCH,
    payload: { researchRunId: data.runId },
    idempotencyKey: `seo-research:${input.projectId}:${data.runId}`,
    maxAttempts: 12,
  });
  return {
    report_id: data.runId,
    project_id: input.projectId,
    period: brief.period,
    // Same vocabulary the endpoint returned before the cutover.
    status: legacyStatus(data.status),
    task_limit: STANDARD_TASK_LIMIT,
    task_count: tasks.length,
    existing: data.existing,
  };
}

/** The unified enum in the vocabulary this endpoint already published. */
export function legacyStatus(status: string): string {
  switch (status) {
    case "QUEUED":
      return "requested";
    case "RUNNING":
      return "running_paid_research";
    case "COMPLETED":
      return "completed";
    case "PARTIAL":
      return "partial";
    case "FAILED":
      return "failed";
    default:
      return status.toLowerCase();
  }
}
