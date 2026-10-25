import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type LegacyBudgetImportRow = {
  localReservationId: string;
  taskId: string;
  operation: "dataforseo:article_keyword_overview" | "dataforseo:article_serp_snapshot";
  legacyStatus: "reserved" | "settled" | "uncertain" | "released";
  period: string;
  timeZone: string;
  currency: string;
  amountMicros: string;
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
};

export type LegacyBudgetImportInput = {
  mode: "plan" | "apply";
  sourceProjectId: string;
  sourceSiteId: string;
  targetSiteId: string;
  expectedBindingGeneration: number;
  expectedSourceEvidenceHash?: string;
  idempotencyKey: string;
  rows: LegacyBudgetImportRow[];
};

export class LegacyBudgetImportError extends Error {
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409) {
    super(message);
    this.name = "LegacyBudgetImportError";
  }
}

export type LegacyBudgetSourceFreezeInput = {
  mode: "freeze-source-plan" | "freeze-source-apply";
  sourceProjectId: string;
  sourceSiteId: string;
  targetSiteId: string;
  expectedBindingGeneration: number;
  idempotencyKey: string;
  reason: string;
  expectedSourcePolicyHash?: string;
};

const stableJson = (value: unknown): unknown => Array.isArray(value) ? value.map(stableJson)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableJson(item)]))
    : value;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
const operationByKind = {
  KEYWORD_OVERVIEW: "dataforseo:article_keyword_overview",
  ORGANIC_SERP: "dataforseo:article_serp_snapshot",
} as const;

function periodAt(time: Date, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(time);
  } catch {
    throw new LegacyBudgetImportError("Legacy budget timezone is invalid", 400);
  }
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new LegacyBudgetImportError("Legacy budget period could not be verified", 400);
  return `${year}-${month}`;
}

function date(value: string, label: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new LegacyBudgetImportError(`${label} is invalid`, 400);
  return parsed;
}

function validMicros(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > BigInt("9223372036854775807")) {
    throw new LegacyBudgetImportError("Legacy budget amount must be nonnegative integer micros", 400);
  }
  return BigInt(value);
}

function statusFor(row: LegacyBudgetImportRow, task: {
  status: string; costMicros: number | null; providerTaskId: string | null; attemptedAt: Date | null;
}): "RESERVED" | "SETTLED" | "RELEASED" | "UNCERTAIN" {
  if (task.costMicros !== null && (task.status === "COMPLETED" || task.status === "FAILED")) return "SETTLED";
  if (row.legacyStatus === "released" && task.status === "REQUESTED" && task.attemptedAt === null && !task.providerTaskId) {
    return "RELEASED";
  }
  if (row.legacyStatus === "reserved" && task.status === "REQUESTED" && task.attemptedAt === null && !task.providerTaskId) {
    return "RESERVED";
  }
  // A terminal/provider-started task without a cost receipt may still have been
  // billed. Keep its full quote committed until someone reconciles a receipt.
  return "UNCERTAIN";
}

async function buildPlan(tx: Prisma.TransactionClient, input: LegacyBudgetImportInput) {
  if (input.rows.length === 0 || input.rows.length > 100) throw new LegacyBudgetImportError("Import requires 1 to 100 scoped rows", 400);
  if (new Set(input.rows.map((row) => row.localReservationId)).size !== input.rows.length
      || new Set(input.rows.map((row) => row.taskId)).size !== input.rows.length) {
    throw new LegacyBudgetImportError("Import rows must have unique reservation and task IDs", 400);
  }
  if (input.mode === "apply" && !input.expectedSourceEvidenceHash) {
    throw new LegacyBudgetImportError("Apply requires the source evidence hash returned by plan", 400);
  }

  const [sourceSiteBeforeLock, targetSiteBeforeLock] = await Promise.all([
    tx.site.findUnique({ where: { id: input.sourceSiteId }, select: { projectId: true } }),
    tx.site.findUnique({ where: { id: input.targetSiteId }, select: { projectId: true } }),
  ]);
  if (!sourceSiteBeforeLock?.projectId || sourceSiteBeforeLock.projectId !== input.sourceProjectId) {
    throw new LegacyBudgetImportError("Source site does not belong to the declared source project", 409);
  }
  if (!targetSiteBeforeLock?.projectId) throw new LegacyBudgetImportError("Target project site not found", 404);
  const lockIds = [...new Set([input.sourceProjectId, targetSiteBeforeLock.projectId])].sort();
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" IN (${Prisma.join(lockIds)}) ORDER BY "id" FOR UPDATE`;
  const siteLockIds = [...new Set([input.sourceSiteId, input.targetSiteId])].sort();
  await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" IN (${Prisma.join(siteLockIds)}) ORDER BY "id" FOR UPDATE`;

  const [source, target] = await Promise.all([
    tx.site.findUnique({ where: { id: input.sourceSiteId }, select: {
      id: true, domain: true, projectId: true,
      project: { select: { id: true, externalProjectId: true, status: true, workspaceId: true,
        researchBudgetCurrency: true, workspace: { select: { id: true, status: true } } } },
    } }),
    tx.site.findUnique({ where: { id: input.targetSiteId }, select: {
      id: true, domain: true, projectId: true,
      project: { select: { id: true, externalProjectId: true, status: true, workspaceId: true,
        researchBudgetCurrency: true, researchBudgetRevision: true,
        workspace: { select: { id: true, status: true } } } },
    } }),
  ]);
  const sourceProject = source?.project;
  const targetProject = target?.project;
  if (!source || !target || !sourceProject || !targetProject) throw new LegacyBudgetImportError("Source or target project site not found", 404);
  if (source.projectId !== sourceSiteBeforeLock.projectId || target.projectId !== targetSiteBeforeLock.projectId
      || source.projectId !== input.sourceProjectId || sourceProject.id !== input.sourceProjectId) {
    throw new LegacyBudgetImportError("Source site does not belong to the declared source project", 409);
  }
  if (source.id === target.id || sourceProject.id === targetProject.id) {
    throw new LegacyBudgetImportError("Historical budget imports require distinct source and target identities", 409);
  }
  if (!sourceProject.externalProjectId.trim() || !targetProject.externalProjectId.trim()) {
    throw new LegacyBudgetImportError("Source and target require a registered external project identity", 409);
  }
  if (source.domain.toLowerCase() !== target.domain.toLowerCase()
      || sourceProject.externalProjectId !== targetProject.externalProjectId) {
    throw new LegacyBudgetImportError("Source and target must share the same registered domain and external project identity", 409);
  }
  if (targetProject.status !== "ACTIVE" || targetProject.workspace.status !== "ACTIVE") {
    throw new LegacyBudgetImportError("Target project and workspace must be active", 403);
  }

  const projectBindingIds = [...new Set([sourceProject.id, targetProject.id])].sort();
  await tx.$queryRaw`SELECT "id" FROM "ConnectorBinding" WHERE "projectId" IN (${Prisma.join(projectBindingIds)}) ORDER BY "id" FOR UPDATE`;
  const sourceActiveBindings = await tx.connectorBinding.findMany({
    where: { projectId: input.sourceProjectId, status: "ACTIVE" },
    select: { id: true, siteId: true, executor: true, generation: true },
  });
  if (sourceActiveBindings.length > 0) {
    throw new LegacyBudgetImportError("Source project still has an active executor; historical import is not allowed", 409);
  }
  await tx.$queryRaw`SELECT "id" FROM "SeoResearchPolicy" WHERE "siteId" = ${source.id} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "ResearchPolicy" WHERE "siteId" = ${source.id} FOR UPDATE`;
  const sourceDispatchState = await tx.seoResearchPolicy.findUnique({
    where: { siteId: source.id }, select: { enabled: true, articleResearchEnabled: true },
  });
  const sourceAutoResearch = await tx.researchPolicy.findUnique({
    where: { siteId: source.id }, select: { enabled: true },
  });
  await tx.$queryRaw`SELECT "id" FROM "SeoResearchPolicy" WHERE "siteId" = ${source.id} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "ResearchPolicy" WHERE "siteId" = ${source.id} FOR UPDATE`;
  if (!sourceDispatchState || sourceDispatchState.enabled || sourceDispatchState.articleResearchEnabled
      || !sourceAutoResearch || sourceAutoResearch.enabled) {
    throw new LegacyBudgetImportError("Pause source SEO and article research dispatch before importing historical budget", 409);
  }
  const pendingSourceRuns = await tx.articleKeywordResearchRun.count({
    where: { siteId: source.id, status: { in: ["REQUESTED", "ATTEMPTING"] } },
  });
  const pendingSeoRuns = await tx.seoResearchRun.count({
    where: { siteId: source.id, status: { in: ["REQUESTED", "WAITING_FOR_SOURCES", "RUNNING_PAID_RESEARCH"] } },
  });
  const pendingGenericResearchRuns = await tx.researchRun.count({
    where: { siteId: source.id, status: { in: ["QUEUED", "RUNNING"] } },
  });
  if (pendingSourceRuns > 0 || pendingSeoRuns > 0 || pendingGenericResearchRuns > 0) {
    throw new LegacyBudgetImportError("Source project has queued or active article research tasks; drain them before importing", 409);
  }

  const binding = await tx.connectorBinding.findUnique({ where: { siteId: target.id } });
  if (!binding || binding.projectId !== targetProject.id || binding.executor !== "helloada"
      || binding.status !== "ACTIVE" || binding.generation !== input.expectedBindingGeneration) {
    throw new LegacyBudgetImportError("Target HelloAda binding changed; refresh the migration plan", 409);
  }
  if (sourceProject.researchBudgetCurrency.toUpperCase() !== "USD"
      || targetProject.researchBudgetCurrency.toUpperCase() !== "USD") {
    throw new LegacyBudgetImportError("Legacy DataForSEO costs can only be imported when both projects use USD", 409);
  }

  const tasks = await tx.articleKeywordResearchRun.findMany({
    where: { id: { in: input.rows.map((row) => row.taskId) } },
    select: { id: true, projectId: true, siteId: true, status: true, kind: true, providerTaskId: true,
      costMicros: true, requestedAt: true, attemptedAt: true, completedAt: true, updatedAt: true },
  });
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  if (tasks.length !== input.rows.length) throw new LegacyBudgetImportError("One or more scoped source task records no longer exist", 409);
  const taskIds = input.rows.map((row) => row.taskId);
  const providerTaskIds = tasks.map((task) => task.providerTaskId).filter((id): id is string => Boolean(id));
  const priorTasks = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ResearchBudgetReservation"
    WHERE ("detail"->>'sourceProjectId' = ${sourceProject.id} AND "detail"->>'sourceTaskId' IN (${Prisma.join(taskIds)}))
       OR "detail"->>'taskId' IN (${Prisma.join(taskIds)})
       OR "providerTaskId" IN (${Prisma.join(providerTaskIds.length ? providerTaskIds : ["__no_provider_task__"] )})
    LIMIT 1`;

  const plannedRows = input.rows.map((row) => {
    const task = taskById.get(row.taskId);
    if (!task || task.siteId !== source.id || task.projectId !== sourceProject.id) {
      throw new LegacyBudgetImportError("A source task is outside the declared source site and project", 409);
    }
    if (task.status === "REQUESTED" || task.status === "ATTEMPTING") {
      throw new LegacyBudgetImportError("Source task is still queued or active; drain it before importing", 409);
    }
    const expectedOperation = operationByKind[task.kind as keyof typeof operationByKind];
    if (!expectedOperation || row.operation !== expectedOperation) {
      throw new LegacyBudgetImportError("Legacy operation does not match the source DataForSEO task kind", 409);
    }
    if (row.currency !== "USD") throw new LegacyBudgetImportError("Unknown or unsupported legacy currency", 409);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.period)) throw new LegacyBudgetImportError("Legacy budget period is invalid", 400);
    const amount = validMicros(row.amountMicros);
    const createdAt = date(row.createdAt, "Legacy reservation createdAt");
    const updatedAt = date(row.updatedAt, "Legacy reservation updatedAt");
    const settledAt = row.settledAt === null ? null : date(row.settledAt, "Legacy reservation settledAt");
    if (updatedAt < createdAt || (settledAt && (settledAt < createdAt || settledAt > updatedAt))) {
      throw new LegacyBudgetImportError("Legacy reservation timestamps are inconsistent", 409);
    }
    if (periodAt(createdAt, row.timeZone) !== row.period) {
      throw new LegacyBudgetImportError("Legacy reservation period does not match its recorded timezone and task time", 409);
    }
    if (task.costMicros !== null && (!Number.isSafeInteger(task.costMicros) || task.costMicros < 0 || !task.providerTaskId)) {
      throw new LegacyBudgetImportError("Source task cost lacks a valid DataForSEO provider receipt", 409);
    }
    const status = statusFor(row, task);
    return {
      source: {
        id: task.id, siteId: task.siteId, projectId: task.projectId, kind: task.kind,
        status: task.status, providerTaskId: task.providerTaskId, costMicros: task.costMicros,
        requestedAt: task.requestedAt.toISOString(), attemptedAt: task.attemptedAt?.toISOString() ?? null,
        completedAt: task.completedAt?.toISOString() ?? null, updatedAt: task.updatedAt.toISOString(),
      },
      input: row,
      amountMicros: amount,
      actualCostMicros: status === "SETTLED" ? BigInt(task.costMicros as number) : null,
      status,
      createdAt,
      updatedAt,
      settledAt: status === "SETTLED" ? settledAt : null,
    };
  }).sort((a, b) => a.input.localReservationId.localeCompare(b.input.localReservationId));

  const sourceEvidenceHash = hash({
    source: { projectId: sourceProject.id, siteId: source.id, domain: source.domain,
      externalProjectId: sourceProject.externalProjectId, currency: sourceProject.researchBudgetCurrency },
    target: { projectId: targetProject.id, siteId: target.id, domain: target.domain,
      externalProjectId: targetProject.externalProjectId, currency: targetProject.researchBudgetCurrency,
      binding: { executor: binding.executor, generation: binding.generation, status: binding.status } },
    rows: plannedRows.map(({ source: task, input: row, amountMicros, actualCostMicros, status }) => ({
      legacy: row, sourceTask: task, amountMicros: amountMicros.toString(),
      actualCostMicros: actualCostMicros?.toString() ?? null, status,
    })),
  });
  if (input.expectedSourceEvidenceHash && input.expectedSourceEvidenceHash.toLowerCase() !== sourceEvidenceHash) {
    throw new LegacyBudgetImportError("Source evidence changed since the plan was reviewed", 409);
  }
  if (input.mode === "apply" && input.expectedSourceEvidenceHash?.toLowerCase() !== sourceEvidenceHash) {
    throw new LegacyBudgetImportError("Apply requires an exact reviewed source evidence hash", 409);
  }
  const requestHash = hash({
    sourceProjectId: input.sourceProjectId, sourceSiteId: input.sourceSiteId,
    targetProjectId: targetProject.id, targetSiteId: target.id,
    expectedBindingGeneration: input.expectedBindingGeneration, idempotencyKey: input.idempotencyKey,
    sourceEvidenceHash,
  });
  const snapshot = stableJson({
    source: { projectId: sourceProject.id, siteId: source.id, domain: source.domain,
      externalProjectId: sourceProject.externalProjectId, currency: sourceProject.researchBudgetCurrency },
    target: { projectId: targetProject.id, siteId: target.id, domain: target.domain,
      externalProjectId: targetProject.externalProjectId, currency: targetProject.researchBudgetCurrency,
      bindingExecutor: binding.executor, bindingGeneration: binding.generation, bindingStatus: binding.status },
    rows: plannedRows.map(({ source: task, input: row, amountMicros, actualCostMicros, status, createdAt, updatedAt, settledAt }) => ({
      input: row, sourceTask: task, effective: { amountMicros: amountMicros.toString(),
        actualCostMicros: actualCostMicros?.toString() ?? null, status,
        createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(), settledAt: settledAt?.toISOString() ?? null },
    })),
  });
  return { source, sourceProject, target, targetProject, binding, plannedRows, sourceEvidenceHash, requestHash, snapshot,
    hasPriorTaskLedger: priorTasks.length > 0 };
}

function reservationIdempotencyKey(targetProjectId: string, importKey: string, localReservationId: string): string {
  const identity = `${targetProjectId}:${importKey}:${localReservationId}`;
  return `legacy-budget-import:${createHash("sha256").update(identity).digest("hex")}`;
}

export async function importLegacyBudget(input: LegacyBudgetImportInput) {
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 128) {
    throw new LegacyBudgetImportError("A stable 1 to 128 character import idempotency key is required", 400);
  }
  if (!Number.isSafeInteger(input.expectedBindingGeneration) || input.expectedBindingGeneration < 1) {
    throw new LegacyBudgetImportError("Expected target binding generation is invalid", 400);
  }
  try {
    return await db.$transaction(async (tx) => {
    const plan = await buildPlan(tx, input);
    const receipt = await tx.$queryRaw<Array<{
      id: string; requestHash: string; sourceEvidenceHash: string; reservationIds: string[];
      snapshot: unknown;
    }>>`SELECT "id", "requestHash", "sourceEvidenceHash", "reservationIds", "snapshot" FROM "LegacyBudgetImportReceipt"
      WHERE "targetProjectId" = ${plan.targetProject.id} AND "idempotencyKey" = ${input.idempotencyKey}`;
    if (receipt[0]) {
      if (receipt[0].requestHash !== plan.requestHash || receipt[0].sourceEvidenceHash !== plan.sourceEvidenceHash) {
        throw new LegacyBudgetImportError("Import idempotency key was already used for different source data", 409);
      }
      return { mode: input.mode, reused: true, receiptId: receipt[0].id,
        reservationIds: receipt[0].reservationIds, sourceEvidenceHash: plan.sourceEvidenceHash };
    }
    if (plan.hasPriorTaskLedger) {
      throw new LegacyBudgetImportError("One or more source provider tasks already have a budget ledger entry", 409);
    }
    const priorItems = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ResearchBudgetReservation"
      WHERE "projectId" = ${plan.targetProject.id}
        AND "detail"->>'source' = 'site-agent-legacy-budget-import'
        AND "detail"->>'sourceProjectId' = ${plan.sourceProject.id}
        AND "detail"->>'localReservationId' IN (${Prisma.join(input.rows.map((row) => row.localReservationId))})`;
    if (priorItems.length > 0) {
      throw new LegacyBudgetImportError("One or more source reservations were already imported under another key", 409);
    }
    if (input.mode === "plan") {
      return {
        mode: "plan", reused: false, sourceEvidenceHash: plan.sourceEvidenceHash,
        requestHash: plan.requestHash,
        source: { projectId: plan.sourceProject.id, externalProjectId: plan.sourceProject.externalProjectId,
          siteId: plan.source.id, domain: plan.source.domain },
        target: { projectId: plan.targetProject.id, externalProjectId: plan.targetProject.externalProjectId,
          siteId: plan.target.id, domain: plan.target.domain,
          bindingGeneration: plan.binding.generation },
        rows: plan.plannedRows.map((row) => ({ localReservationId: row.input.localReservationId,
          taskId: row.source.id, operation: row.input.operation, period: row.input.period,
          legacyStatus: row.input.legacyStatus, timeZone: row.input.timeZone, currency: row.input.currency,
          amountMicros: row.amountMicros.toString(),
          status: row.status, actualCostMicros: row.actualCostMicros?.toString() ?? null,
          providerTaskId: row.source.providerTaskId, createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(), settledAt: row.settledAt?.toISOString() ?? null })),
      };
    }

    const createdIds: string[] = [];
    for (const row of plan.plannedRows) {
      const idempotencyKey = reservationIdempotencyKey(plan.targetProject.id, input.idempotencyKey, row.input.localReservationId);
      const existing = await tx.researchBudgetReservation.findUnique({
        where: { projectId_idempotencyKey: { projectId: plan.targetProject.id, idempotencyKey } },
        select: { id: true, detail: true },
      });
      if (existing) throw new LegacyBudgetImportError("An imported reservation exists without its matching import receipt", 409);
      const sourceTask = row.source;
      const created = await tx.researchBudgetReservation.create({
        data: {
          projectId: plan.targetProject.id, siteId: plan.target.id, idempotencyKey,
          period: row.input.period, timeZone: row.input.timeZone,
          policyRevision: plan.targetProject.researchBudgetRevision,
          amountMicros: row.amountMicros, actualCostMicros: row.actualCostMicros,
          currency: row.input.currency, operation: row.input.operation, status: row.status,
          providerTaskId: sourceTask.providerTaskId,
          detail: {
            source: "site-agent-legacy-budget-import",
            sourceProjectId: plan.sourceProject.id, sourceSiteId: plan.source.id,
            sourceTaskId: sourceTask.id, sourceProviderTaskId: sourceTask.providerTaskId,
            localReservationId: row.input.localReservationId,
            sourceEvidenceHash: plan.sourceEvidenceHash,
            requestHash: plan.requestHash,
            legacyStatus: row.input.legacyStatus,
            legacyCreatedAt: row.input.createdAt,
            legacyUpdatedAt: row.input.updatedAt,
            legacySettledAt: row.input.settledAt,
            sourceTaskStatus: sourceTask.status,
            sourceTaskKind: sourceTask.kind,
            sourceTaskRequestedAt: sourceTask.requestedAt,
            sourceTaskCompletedAt: sourceTask.completedAt,
          } as Prisma.InputJsonValue,
          createdAt: row.createdAt, updatedAt: row.updatedAt,
          settledAt: row.settledAt,
        },
        select: { id: true },
      });
      createdIds.push(created.id);
    }
    const receiptId = randomUUID();
    await tx.$executeRaw`INSERT INTO "LegacyBudgetImportReceipt"
      ("id", "sourceProjectId", "sourceSiteId", "targetProjectId", "targetSiteId", "idempotencyKey", "requestHash", "sourceEvidenceHash", "reservationIds", "snapshot")
      VALUES (${receiptId}, ${plan.sourceProject.id}, ${plan.source.id}, ${plan.targetProject.id}, ${plan.target.id},
        ${input.idempotencyKey}, ${plan.requestHash}, ${plan.sourceEvidenceHash}, ${JSON.stringify(createdIds)}::jsonb,
        ${JSON.stringify(plan.snapshot)}::jsonb)`;
    return { mode: "apply", reused: false, receiptId, reservationIds: createdIds,
      sourceEvidenceHash: plan.sourceEvidenceHash };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "P2002" || code === "P2034") {
      if (input.mode === "apply") {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const replay = await db.$transaction(async (tx) => {
              const plan = await buildPlan(tx, input);
              const receipt = await tx.$queryRaw<Array<{
                id: string; requestHash: string; sourceEvidenceHash: string; reservationIds: string[];
              }>>`SELECT "id", "requestHash", "sourceEvidenceHash", "reservationIds" FROM "LegacyBudgetImportReceipt"
                WHERE "targetProjectId" = ${plan.targetProject.id} AND "idempotencyKey" = ${input.idempotencyKey}`;
              if (!receipt[0]) return null;
              if (receipt[0].requestHash !== plan.requestHash || receipt[0].sourceEvidenceHash !== plan.sourceEvidenceHash) {
                throw new LegacyBudgetImportError("Import idempotency key was already used for different source data", 409);
              }
              return { mode: input.mode, reused: true, receiptId: receipt[0].id,
                reservationIds: receipt[0].reservationIds, sourceEvidenceHash: plan.sourceEvidenceHash };
            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
            if (replay) return replay;
          } catch (retryError) {
            if (retryError instanceof LegacyBudgetImportError) throw retryError;
            const retryCode = (retryError as { code?: string }).code;
            if (retryCode !== "P2002" && retryCode !== "P2034") throw retryError;
          }
          await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        }
      }
      throw new LegacyBudgetImportError("Legacy budget import raced another request; refresh the plan", 409);
    }
    throw error;
  }
}

export async function getLegacyBudgetImportReceipt(receiptId: string) {
  const rows = await db.$queryRaw<Array<{
    id: string; sourceProjectId: string; sourceSiteId: string; targetProjectId: string; targetSiteId: string;
    idempotencyKey: string; requestHash: string; sourceEvidenceHash: string; reservationIds: string[];
    snapshot: unknown; createdAt: Date;
  }>>`SELECT "id", "sourceProjectId", "sourceSiteId", "targetProjectId", "targetSiteId", "idempotencyKey",
      "requestHash", "sourceEvidenceHash", "reservationIds", "snapshot", "createdAt"
    FROM "LegacyBudgetImportReceipt" WHERE "id" = ${receiptId}`;
  return rows[0] ?? null;
}

export async function getLegacyBudgetSourceFreezeReceipt(receiptId: string) {
  const rows = await db.$queryRaw<Array<Record<string, unknown>>>`SELECT "id", "sourceProjectId", "sourceSiteId", "targetProjectId", "targetSiteId",
      "idempotencyKey", "reason", "requestHash", "sourcePolicyHash", "snapshot", "createdAt"
    FROM "LegacyBudgetSourceFreezeReceipt" WHERE "id" = ${receiptId}`;
  return rows[0] ?? null;
}

export async function freezeLegacyBudgetSourceDispatch(input: LegacyBudgetSourceFreezeInput) {
  return db.$transaction(async (tx) => {
    if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 128 || !input.reason.trim() || input.reason.length > 500) {
      throw new LegacyBudgetImportError("Freeze requires a stable idempotency key and a reason", 400);
    }
    const targetSiteBeforeLock = await tx.site.findUnique({ where: { id: input.targetSiteId }, select: { projectId: true } });
    if (!targetSiteBeforeLock?.projectId) throw new LegacyBudgetImportError("Target site not found", 404);
    const projectIds = [...new Set([input.sourceProjectId, targetSiteBeforeLock.projectId])].sort();
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" IN (${Prisma.join(projectIds)}) ORDER BY "id" FOR UPDATE`;
    const siteIds = [...new Set([input.sourceSiteId, input.targetSiteId])].sort();
    await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" IN (${Prisma.join(siteIds)}) ORDER BY "id" FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "SeoResearchPolicy" WHERE "siteId" = ${input.sourceSiteId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ResearchPolicy" WHERE "siteId" = ${input.sourceSiteId} FOR UPDATE`;
    const [source, target] = await Promise.all([
      tx.site.findUnique({ where: { id: input.sourceSiteId }, select: { id: true, domain: true, projectId: true,
        project: { select: { id: true, externalProjectId: true, status: true } } } }),
      tx.site.findUnique({ where: { id: input.targetSiteId }, select: { id: true, domain: true, projectId: true,
        project: { select: { id: true, externalProjectId: true, status: true, workspace: { select: { status: true } } } } } }),
    ]);
    if (!source?.project || !target?.project || source.projectId !== input.sourceProjectId
        || target.projectId !== targetSiteBeforeLock.projectId) {
      throw new LegacyBudgetImportError("Source or target site is outside the declared project mapping", 409);
    }
    if (!source.project.externalProjectId.trim() || source.project.externalProjectId !== target.project.externalProjectId
        || source.domain.toLowerCase() !== target.domain.toLowerCase() || source.projectId === target.projectId) {
      throw new LegacyBudgetImportError("Source and target must be distinct registered projects with matching domain and external identity", 409);
    }
    if (target.project.status !== "ACTIVE" || target.project.workspace.status !== "ACTIVE") {
      throw new LegacyBudgetImportError("Target project and workspace must be active", 403);
    }
    const sourceBindings = await tx.connectorBinding.findMany({ where: { projectId: input.sourceProjectId, status: "ACTIVE" }, select: { id: true } });
    if (sourceBindings.length) throw new LegacyBudgetImportError("Source project still has an active executor", 409);
    await tx.$queryRaw`SELECT "id" FROM "ConnectorBinding" WHERE "projectId" IN (${Prisma.join(projectIds)}) ORDER BY "id" FOR UPDATE`;
    const binding = await tx.connectorBinding.findUnique({ where: { siteId: input.targetSiteId } });
    if (!binding || binding.projectId !== target.projectId || binding.executor !== "helloada" || binding.status !== "ACTIVE"
        || binding.generation !== input.expectedBindingGeneration) {
      throw new LegacyBudgetImportError("Target HelloAda binding changed; refresh the freeze plan", 409);
    }
    if (input.mode === "freeze-source-apply") {
      const prior = await tx.$queryRaw<Array<{ id: string; requestHash: string; sourcePolicyHash: string; snapshot: unknown }>>`
        SELECT "id", "requestHash", "sourcePolicyHash", "snapshot" FROM "LegacyBudgetSourceFreezeReceipt"
        WHERE "sourceProjectId" = ${input.sourceProjectId} AND "idempotencyKey" = ${input.idempotencyKey}`;
      if (prior[0]) {
        const [currentSeo, currentResearch] = await Promise.all([
          tx.seoResearchPolicy.findUnique({ where: { siteId: input.sourceSiteId }, select: { enabled: true, articleResearchEnabled: true, updatedAt: true } }),
          tx.researchPolicy.findUnique({ where: { siteId: input.sourceSiteId }, select: { enabled: true, revision: true, updatedAt: true } }),
        ]);
        if (!currentSeo || currentSeo.enabled || currentSeo.articleResearchEnabled || !currentResearch || currentResearch.enabled) {
          throw new LegacyBudgetImportError("Freeze receipt exists but source research policies are no longer paused", 409);
        }
        const after = (prior[0].snapshot as { after?: { seo?: { updatedAt?: string }; research?: { revision?: number; updatedAt?: string } } }).after;
        if (!after?.seo?.updatedAt || currentSeo.updatedAt.toISOString() !== after.seo.updatedAt
            || currentResearch.revision !== after.research?.revision
            || currentResearch.updatedAt.toISOString() !== after.research.updatedAt) {
          throw new LegacyBudgetImportError("Freeze receipt exists but source policy revision changed after the freeze", 409);
        }
        const expectedRequestHash = hash({ sourceDispatchHash: prior[0].sourcePolicyHash,
          sourceProjectId: input.sourceProjectId, sourceSiteId: input.sourceSiteId,
          targetProjectId: target.projectId, targetSiteId: target.id, expectedBindingGeneration: input.expectedBindingGeneration,
          idempotencyKey: input.idempotencyKey, reason: input.reason });
        if (prior[0].requestHash !== expectedRequestHash || input.expectedSourcePolicyHash !== prior[0].sourcePolicyHash) {
          throw new LegacyBudgetImportError("Freeze idempotency key was already used for different policy state", 409);
        }
        return { mode: input.mode, reused: true, receiptId: prior[0].id, requestHash: prior[0].requestHash,
          sourceDispatchHash: prior[0].sourcePolicyHash, snapshot: prior[0].snapshot };
      }
    }
    const [seo, research] = await Promise.all([
      tx.seoResearchPolicy.findUnique({ where: { siteId: input.sourceSiteId }, select: { id: true, enabled: true, articleResearchEnabled: true, updatedAt: true } }),
      tx.researchPolicy.findUnique({ where: { siteId: input.sourceSiteId }, select: { id: true, enabled: true, revision: true, updatedAt: true } }),
    ]);
    if (!seo) throw new LegacyBudgetImportError("Source SEO research policy is missing; dispatch state cannot be frozen safely", 409);
    const [pendingArticleRuns, pendingSeoRuns, pendingGenericResearchRuns] = await Promise.all([
      tx.articleKeywordResearchRun.count({ where: { siteId: input.sourceSiteId, status: { in: ["REQUESTED", "ATTEMPTING"] } } }),
      tx.seoResearchRun.count({ where: { siteId: input.sourceSiteId, status: { in: ["REQUESTED", "WAITING_FOR_SOURCES", "RUNNING_PAID_RESEARCH"] } } }),
      tx.researchRun.count({ where: { siteId: input.sourceSiteId, status: { in: ["QUEUED", "RUNNING"] } } }),
    ]);
    const pendingRuns = pendingArticleRuns + pendingSeoRuns + pendingGenericResearchRuns;
    const policySnapshot = stableJson({ sourceProjectId: input.sourceProjectId, sourceSiteId: input.sourceSiteId,
      sourceDomain: source.domain, targetProjectId: target.projectId, targetSiteId: target.id, targetDomain: target.domain,
      sourceExternalProjectId: source.project.externalProjectId,
      bindingGeneration: binding.generation, executor: binding.executor,
      sourceProjectStatus: source.project.status, targetProjectStatus: target.project.status,
      targetWorkspaceStatus: target.project.workspace.status,
      idempotencyKey: input.idempotencyKey, reason: input.reason,
      seo: { id: seo.id, enabled: seo.enabled, articleResearchEnabled: seo.articleResearchEnabled, updatedAt: seo.updatedAt.toISOString() },
      research: research ? { id: research.id, enabled: research.enabled, revision: research.revision, updatedAt: research.updatedAt.toISOString() } : null,
      pendingRuns });
    const sourceDispatchHash = hash(policySnapshot);
    const requestHash = hash({ sourceDispatchHash, sourceProjectId: input.sourceProjectId, sourceSiteId: input.sourceSiteId,
      targetProjectId: target.projectId, targetSiteId: target.id, expectedBindingGeneration: input.expectedBindingGeneration,
      idempotencyKey: input.idempotencyKey, reason: input.reason });
    if (input.mode === "freeze-source-plan") {
      return { mode: input.mode, sourceDispatchHash, requestHash, current: policySnapshot };
    }
    if (!input.expectedSourcePolicyHash || input.expectedSourcePolicyHash !== sourceDispatchHash) {
      throw new LegacyBudgetImportError("Source dispatch policy changed since the freeze plan", 409);
    }
    if (pendingRuns > 0) throw new LegacyBudgetImportError("Drain queued or active source tasks before freezing research dispatch", 409);
    const frozenSeo = await tx.seoResearchPolicy.update({
      where: { id: seo.id }, data: { enabled: false, articleResearchEnabled: false },
      select: { id: true, enabled: true, articleResearchEnabled: true, updatedAt: true },
    });
    const frozenResearch = research ? await tx.researchPolicy.update({
      where: { id: research.id }, data: { enabled: false, revision: { increment: 1 } },
      select: { id: true, enabled: true, revision: true, updatedAt: true },
    }) : await tx.researchPolicy.create({
      data: { siteId: input.sourceSiteId, enabled: false },
      select: { id: true, enabled: true, revision: true, updatedAt: true },
    });
    const receiptSnapshot = stableJson({ before: policySnapshot, after: {
      seo: { id: frozenSeo.id, enabled: frozenSeo.enabled, articleResearchEnabled: frozenSeo.articleResearchEnabled,
        updatedAt: frozenSeo.updatedAt.toISOString() },
      research: frozenResearch ? { id: frozenResearch.id, enabled: frozenResearch.enabled,
        revision: frozenResearch.revision, updatedAt: frozenResearch.updatedAt.toISOString() } : null,
    } });
    const receiptId = randomUUID();
    await tx.$executeRaw`INSERT INTO "LegacyBudgetSourceFreezeReceipt"
      ("id", "sourceProjectId", "sourceSiteId", "targetProjectId", "targetSiteId", "idempotencyKey", "reason", "requestHash", "sourcePolicyHash", "snapshot")
      VALUES (${receiptId}, ${input.sourceProjectId}, ${input.sourceSiteId}, ${target.projectId}, ${target.id}, ${input.idempotencyKey},
        ${input.reason}, ${requestHash}, ${sourceDispatchHash}, ${JSON.stringify(receiptSnapshot)}::jsonb)`;
    return { mode: input.mode, frozen: true, receiptId, requestHash, sourceDispatchHash, snapshot: receiptSnapshot };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
