import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type ConnectorTransaction = Prisma.TransactionClient;

export async function emitConnectorEvent(
  tx: ConnectorTransaction,
  input: {
    projectId: string;
    siteId: string;
    actionId?: string | null;
    actionRevision?: number | null;
    type: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  const binding = await tx.connectorBinding.findUnique({
    where: { siteId: input.siteId },
    select: { projectId: true, status: true },
  });
  if (!binding || binding.projectId !== input.projectId || binding.status !== "ACTIVE") return;

  await tx.connectorEventCounter.upsert({
    where: { projectId: input.projectId },
    create: { projectId: input.projectId, sequence: 0 },
    update: {},
  });
  const counter = await tx.connectorEventCounter.update({
    where: { projectId: input.projectId },
    data: { sequence: { increment: 1 } },
    select: { sequence: true },
  });
  await tx.connectorEvent.create({
    data: {
      id: randomUUID(),
      projectId: input.projectId,
      siteId: input.siteId,
      sequence: counter.sequence,
      actionId: input.actionId ?? null,
      actionRevision: input.actionRevision ?? null,
      type: input.type,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });
}

export async function recordConnectorEvent(input: Parameters<typeof emitConnectorEvent>[1]): Promise<void> {
  await db.$transaction((tx) => emitConnectorEvent(tx, input));
}
