import { type EdgeEndpointType, type EdgeRelation, type PrismaClient } from "@prisma/client";

/**
 * Typed lineage edges (docs/seo-funnel-spine-plan.md §4). This *is* the funnel
 * lineage; no IDs inside JSON. Edge writes are idempotent.
 */

export type EdgeDb = Pick<PrismaClient, "evidenceEdge">;

export type EdgeInput = {
  fromType: EdgeEndpointType;
  fromId: string;
  toType: EdgeEndpointType;
  toId: string;
  relation: EdgeRelation;
  createdBy: string;
};

export async function addEdge(db: EdgeDb, input: EdgeInput): Promise<string> {
  if (input.fromId === input.toId && input.fromType === input.toType) {
    throw new Error("self edges are not allowed");
  }
  const edge = await db.evidenceEdge.upsert({
    where: {
      fromType_fromId_toType_toId_relation: {
        fromType: input.fromType,
        fromId: input.fromId,
        toType: input.toType,
        toId: input.toId,
        relation: input.relation,
      },
    },
    create: input,
    update: {},
    select: { id: true },
  });
  return edge.id;
}

export async function edgesFor(
  db: EdgeDb,
  endpoint: { type: EdgeEndpointType; id: string }
) {
  const [outgoing, incoming] = await Promise.all([
    db.evidenceEdge.findMany({
      where: { fromType: endpoint.type, fromId: endpoint.id },
      orderBy: { createdAt: "asc" },
    }),
    db.evidenceEdge.findMany({
      where: { toType: endpoint.type, toId: endpoint.id },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return { outgoing, incoming };
}
