import { JobKind, Prisma, SeoResearchRunStatus, SeoResearchTaskKind } from "@prisma/client";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";
import { projectConnectorBudget, reserveProjectConnectorBudget } from "@/lib/connectors/service";
import { closedPeriod, ResearchValidationError, validateResearchBrief, STANDARD_PACKAGE_VERSION, STANDARD_TASK_LIMIT } from "@/lib/dataforseo/research";
import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";

const json = (v: unknown) => v as Prisma.InputJsonValue;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
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
  // Explicitly authorize the bounded number of operations before queueing. The
  // task executor reserves each operation against this same owner policy.
  const tasks = brief.keyword_seeds.map((seed, i) => ({ operationKey: `keyword:${i + 1}:${seed.toLowerCase()}:${brief.focus_market.language}:${brief.focus_market.country}`, kind: SeoResearchTaskKind.KEYWORD_SEED,
    ordinal: i + 1, input: json({ seed, language_code: locale.languageCode, location_code: locale.locationCode }), requestHash: hash({ seed, language_code: locale.languageCode, location_code: locale.locationCode }) }));
  let data;
  try { data = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} FOR UPDATE`;
    const requestHash = hash({ projectId: input.projectId, period: brief.period, packageVersion, brief });
    const mapping = await tx.prelaunchResearchRequest.findUnique({ where: { projectId_idempotencyKey: { projectId: input.projectId, idempotencyKey: key } }, include: { researchRun: true } });
    if (mapping) {
      if (mapping.requestHash !== requestHash || mapping.researchRun.periodStart.getTime() !== periodStart.getTime()) throw new ResearchValidationError("idempotency_key is already used for another research request");
      return { run: mapping.researchRun, existing: true };
    }
    const byPeriod = await tx.seoResearchRun.findFirst({ where: { projectId: input.projectId, siteId: null, periodStart, packageVersion } });
    const run = byPeriod ?? await tx.seoResearchRun.create({ data: { projectId: input.projectId, siteId: null, periodStart, idempotencyKey: key, brief: json(brief), briefHash: hash(brief), packageVersion, reportSchemaVersion: 1, status: SeoResearchRunStatus.REQUESTED, taskLimit: STANDARD_TASK_LIMIT, taskCount: tasks.length, tasks: { create: tasks } } });
    await tx.prelaunchResearchRequest.create({ data: { projectId: input.projectId, researchRunId: run.id, idempotencyKey: key, requestHash } });
    return { run, existing: Boolean(byPeriod) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
  catch (e) { if ((e as { code?: string }).code === "P2002" || (e as { code?: string }).code === "P2034") throw new ResearchValidationError("Research request raced another project request; retry with the same key"); throw e; }
  if (!data.existing) for (const task of tasks) await reserveProjectConnectorBudget(principal, {
    period: budget.period, policyRevision: budget.policyRevision, idempotencyKey: `dataforseo-task:${data.run.id}:${task.operationKey}`,
    amountMicros: budget.maxOperationMicros!, currency: "USD", operation: "dataforseo:keyword_seed", detail: { researchRunId: data.run.id, operationKey: task.operationKey },
  });
  await enqueueJob({ projectId: input.projectId, kind: JobKind.SEO_RESEARCH, payload: { researchRunId: data.run.id }, idempotencyKey: `seo-research:${input.projectId}:${data.run.id}`, maxAttempts: 12 });
  return { report_id: data.run.id, project_id: input.projectId, period: brief.period, status: data.run.status.toLowerCase(), task_limit: data.run.taskLimit, task_count: data.run.taskCount, existing: data.existing };
}
