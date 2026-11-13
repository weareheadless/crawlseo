import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { z } from "zod";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";
import { db } from "@/lib/db";
import { withOpportunityAnchor } from "@/lib/connectors/opportunity-anchor";
import { ConnectorError, requireConnectorSite } from "@/lib/connectors/service";
import { opportunityListSchema, opportunityOperationSchema, taskConfirmationSchema } from "@/lib/connectors/types";
import { acceptOpportunityIntoTaskInTransaction, confirmHumanStepInTransaction, TaskTransitionError } from "@/lib/funnel/join";
import { decideOpportunity } from "@/lib/funnel/opportunity";

type OpportunityOperation = z.infer<typeof opportunityOperationSchema>;
type TaskConfirmation = z.infer<typeof taskConfirmationSchema>;
type Confirmation = Pick<TaskConfirmation, "siteId" | "generation" | "idempotencyKey" | "confirmedBy" | "confirmationRef">;

/** Opportunities are project-owned in the canonical schema, not site-local copies. */
export async function listConnectorOpportunities(principal: ServicePrincipalContext, options: z.input<typeof opportunityListSchema>) {
  const input = opportunityListSchema.parse(options);
  await requireConnectorSite(principal, input.siteId);
  if (input.cursor && !await db.opportunity.findFirst({ where: { id: input.cursor, projectId: principal.projectId }, select: { id: true } })) {
    throw new ConnectorError("Opportunity cursor does not belong to this project", 400);
  }
  const rows = await db.opportunity.findMany({ where: { projectId: principal.projectId,
    ...(input.status ? { status: input.status } : {}) },
    include: { tasks: { orderBy: { id: "asc" } } }, orderBy: { id: "asc" }, take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}) });
  // The pipeline counts describe the whole project, not the filtered page, so a
  // client can show "13 to decide / 138 parked" without reading every page.
  const counts = input.cursor ? undefined : await db.opportunity.groupBy({
    by: ["status"], where: { projectId: principal.projectId }, _count: { _all: true } });
  const page = rows.slice(0, input.limit);
  return { schemaVersion: "1.0", projectId: principal.projectId, siteId: input.siteId,
    opportunities: page.map(withOpportunityAnchor),
    ...(counts ? { counts: {
      ...Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
      total: counts.reduce((sum, row) => sum + row._count._all, 0),
    } } : {}),
    nextCursor: rows.length > input.limit ? page.at(-1)!.id : null };
}

export async function getConnectorTask(principal: ServicePrincipalContext, siteId: string, taskId: string) {
  await requireConnectorSite(principal, siteId);
  const task = await db.task.findFirst({ where: { id: taskId, opportunity: { projectId: principal.projectId } },
    include: { opportunity: true } });
  if (!task) throw new ConnectorError("Task not found in this project", 404);
  return { schemaVersion: "1.0", projectId: principal.projectId, siteId,
    task: { ...task, opportunity: withOpportunityAnchor(task.opportunity) } };
}

/** Reuse the connector's receipt store; no second task ledger or scheduler. */
async function mutate(
  principal: ServicePrincipalContext, target: string, operation: string, input: Confirmation,
  request: Record<string, unknown>, apply: (tx: Prisma.TransactionClient) => Promise<Record<string, unknown>>,
) {
  await requireConnectorSite(principal, input.siteId);
  const content = { target, ...request, relayedBy: principal.servicePrincipalId };
  const requestHash = createHash("sha256").update(JSON.stringify(content, Object.keys(content).sort())).digest("hex");
  try {
    return await db.$transaction(async (tx) => {
      // Binding transfers lock this exact row. A Site lock would not fence them.
      await tx.$queryRaw`SELECT id FROM "ConnectorBinding" WHERE "siteId" = ${input.siteId} FOR UPDATE`;
      const prior = await tx.connectorOperationReceipt.findUnique({ where: {
        projectId_operation_idempotencyKey: { projectId: principal.projectId, operation, idempotencyKey: input.idempotencyKey },
      } });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new ConnectorError("Idempotency key was reused for a different confirmation", 409);
        return prior.result;
      }
      // An exact completed request remains replayable after a transfer. Only a
      // new effect needs the current executor generation.
      const binding = await tx.connectorBinding.findUnique({ where: { siteId: input.siteId } });
      if (!binding || binding.status !== "ACTIVE" || binding.executor !== "helloada" || binding.generation !== input.generation) {
        throw new ConnectorError("Connector executor/generation changed; refresh before confirming", 409);
      }
      const result = { schemaVersion: "1.0", projectId: principal.projectId, siteId: input.siteId,
        ...await apply(tx), confirmation: { ownerId: input.confirmedBy, reference: input.confirmationRef,
          relayedBy: principal.servicePrincipalId } };
      await tx.connectorOperationReceipt.create({ data: { projectId: principal.projectId, siteId: input.siteId,
        actionId: target, actionRevision: 0, operation, idempotencyKey: input.idempotencyKey,
        requestHash, result: result as Prisma.InputJsonValue } });
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof TaskTransitionError) throw new ConnectorError(error.message, error.status);
    if (["P2034", "P2002"].includes((error as { code?: string }).code ?? "")) {
      throw new ConnectorError("Work changed concurrently; refresh before retrying the same request", 409);
    }
    throw error;
  }
}

export async function operateOnOpportunity(principal: ServicePrincipalContext, opportunityId: string, input: OpportunityOperation) {
  input = opportunityOperationSchema.parse(input);
  return mutate(principal, `opportunity:${opportunityId}`, "opportunity.decide", input, input, async (tx) => {
    const opportunity = await tx.opportunity.findFirst({ where: { id: opportunityId, projectId: principal.projectId } });
    if (!opportunity) throw new ConnectorError("Opportunity not found in this project", 404);
    if (opportunity.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new ConnectorError("Opportunity changed; review it again", 409);
    if (!["detected", "parked"].includes(opportunity.status)) throw new ConnectorError("Active or closed work cannot be accepted, parked or rejected", 409);
    if (input.operation === "accept") {
      let taskId: string;
      try {
        taskId = await acceptOpportunityIntoTaskInTransaction(tx, opportunity.id, {
          title: opportunity.title, assignedTo: input.confirmedBy, expectedProjectId: principal.projectId,
          expectedDecisionId: input.expectedDecisionId,
        });
      } catch (error) {
        throw new ConnectorError(error instanceof Error ? error.message : "Opportunity acceptance failed", 409);
      }
      return { opportunityId, status: "accepted", taskId };
    }
    const status = input.operation === "park" ? "parked" : "rejected";
    try {
      await decideOpportunity(tx, opportunityId, status, input.confirmedBy, input.reason,
        { projectId: principal.projectId, expectedUpdatedAt: opportunity.updatedAt });
    } catch (error) {
      throw new ConnectorError(error instanceof Error ? error.message : "Opportunity decision failed", 409);
    }
    return { opportunityId, status };
  });
}

export async function confirmConnectorTask(principal: ServicePrincipalContext, taskId: string, input: TaskConfirmation) {
  input = taskConfirmationSchema.parse(input);
  return mutate(principal, `task:${taskId}`, "task.confirm", input, input, async (tx) => {
    await confirmHumanStepInTransaction(tx, taskId, { status: input.status, confirmedBy: input.confirmedBy,
      opportunityId: input.opportunityId, expectedProjectId: principal.projectId, expectedStatus: input.expectedStatus });
    return { taskId, opportunityId: input.opportunityId, status: input.status };
  });
}
