import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";

const identifier = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const rfc3339DateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/).refine((value) => !Number.isNaN(Date.parse(value)), "Invalid RFC3339 timestamp");
const absoluteUri = z.string().max(2000).regex(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/);
const provenance = z.object({
  kind: z.enum(["owner_input", "admin_input", "intake", "official_source", "research_observation", "ai_observation"]),
  sourceId: identifier, originSystem: identifier, originRecordId: identifier,
  originRevision: z.union([z.number().int().positive(), z.string().min(1).max(200), z.null()]),
  actor: z.object({ type: z.enum(["owner", "workspace_admin", "service", "researcher", "model", "unknown"]), id: identifier }).strict(),
  status: z.enum(["owner_confirmed", "admin_confirmed", "advised", "assumed", "verified", "disputed", "deferred", "not_applicable", "unknown"]),
  recordedAt: rfc3339DateTime, observedAt: rfc3339DateTime, evidenceUri: absoluteUri, quote: z.string().max(2000).optional(),
}).strict();
const textFact = z.object({ value: z.string().max(2000), provenance, publicationUse: z.enum(["approved", "internal_only", "prohibited", "unknown"]), locale: z.string().min(2).max(35).optional(), validFrom: rfc3339DateTime.nullable().optional(), validUntil: rfc3339DateTime.nullable().optional() }).strict();
const listFact = z.object({ value: z.array(z.string().min(1).max(500)).min(1).max(30), provenance, publicationUse: z.enum(["approved", "internal_only", "prohibited", "unknown"]), locale: z.string().min(2).max(35).optional(), validFrom: rfc3339DateTime.nullable().optional(), validUntil: rfc3339DateTime.nullable().optional() }).strict();
export const businessKnowledgeFieldsSchema = z.object({
  businessName: textFact.optional(), services: listFact.optional(), location: textFact.optional(), serviceArea: listFact.optional(),
  differentiators: listFact.optional(), verifiedTrustEvidence: listFact.optional(), audienceMotivations: listFact.optional(),
  concerns: listFact.optional(), conversionGoals: listFact.optional(), voice: textFact.optional(), prohibitedClaims: listFact.optional(),
}).strict().refine((fields) => Object.keys(fields).length > 0, "At least one business field is required");

export type BusinessKnowledgeFields = z.infer<typeof businessKnowledgeFieldsSchema>;
export type BusinessKnowledgeDocument = {
  schemaVersion: "business-knowledge/1"; kind: "business_document"; workspaceId: string; projectId: string;
  documentId: string; revision: number; state: "working" | "accepted"; updatedAt: string;
  acceptedRevision: number | null; fields: BusinessKnowledgeFields;
};
export type BusinessKnowledgeCorrectionImpact = {
  projectId: string;
  documentId: string;
  revision: number;
  reason: string;
  changedFields: string[];
  affectedActionIds: string[];
  affectedActionsHaveMore: boolean;
};
export class BusinessKnowledgeError extends Error {
  constructor(readonly code: "FORBIDDEN" | "NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "REVISION_CONFLICT" | "VALIDATION_FAILED", message: string, readonly currentRevision?: number) { super(message); }
}
const json = (value: unknown) => value as Prisma.InputJsonValue;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const receiptOp = "business_document_write_v1";

function documentShape(project: { id: string; workspaceId: string }, head: { logicalId: string; revision: number; acceptedRevision: number | null }, revision: { state: string; fields: Prisma.JsonValue; createdAt: Date }): BusinessKnowledgeDocument {
  return { schemaVersion: "business-knowledge/1", kind: "business_document", workspaceId: project.workspaceId,
    projectId: project.id, documentId: head.logicalId, revision: head.revision, state: head.acceptedRevision === head.revision ? "accepted" : "working",
    updatedAt: revision.createdAt.toISOString(), acceptedRevision: head.acceptedRevision,
    fields: revision.fields as unknown as BusinessKnowledgeFields };
}

export async function readBusinessKnowledge(projectId: string, documentId: string, revision?: number, view: "working" | "accepted" = "working") {
  if (!identifier.safeParse(projectId).success || !identifier.safeParse(documentId).success
      || (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1))
      || !["working", "accepted"].includes(view)) {
    throw new BusinessKnowledgeError("VALIDATION_FAILED", "Invalid document selector");
  }
  const project = await db.project.findUnique({ where: { id: projectId }, select: { id: true, workspaceId: true } });
  if (!project) throw new BusinessKnowledgeError("NOT_FOUND", "Document not found");
  const head = await db.businessKnowledgeDocument.findUnique({ where: { projectId } });
  if (!head || head.logicalId !== documentId) throw new BusinessKnowledgeError("NOT_FOUND", "Document not found");
  const selectedRevision = revision ?? (view === "accepted" ? head.acceptedRevision : head.revision);
  if (selectedRevision == null) throw new BusinessKnowledgeError("NOT_FOUND", "No accepted document exists");
  if (view === "accepted") {
    const accepted = await db.businessKnowledgeAcceptance.findFirst({ where: { documentId: head.id, revision: selectedRevision } });
    if (!accepted) throw new BusinessKnowledgeError("NOT_FOUND", "Accepted revision not found");
  }
  const stored = await db.businessKnowledgeRevision.findFirst({ where: { documentId: head.id, revision: selectedRevision }, select: { revision: true, state: true, fields: true, createdAt: true } });
  if (!stored) throw new BusinessKnowledgeError("NOT_FOUND", "Document revision not found");
  return documentShape(project, { ...head, revision: stored.revision,
    acceptedRevision: view === "accepted" ? selectedRevision : head.acceptedRevision !== null && head.acceptedRevision <= stored.revision ? head.acceptedRevision : null }, stored);
}

/** Read the durable, bounded correction impact for a precise project revision. */
export async function readBusinessKnowledgeCorrectionImpact(
  projectId: string,
  documentId: string,
  revision: number,
): Promise<BusinessKnowledgeCorrectionImpact> {
  const stored = await db.businessKnowledgeRevision.findFirst({
    where: { revision, document: { projectId, logicalId: documentId } },
    select: { revision: true, reason: true, changedFields: true, affectedActionIds: true, affectedActionsHaveMore: true, document: { select: { logicalId: true } } },
  });
  if (!stored) throw new BusinessKnowledgeError("NOT_FOUND", "Document revision not found");
  return { projectId, documentId: stored.document.logicalId, revision: stored.revision, reason: stored.reason,
    changedFields: stored.changedFields as string[], affectedActionIds: stored.affectedActionIds as string[],
    affectedActionsHaveMore: stored.affectedActionsHaveMore };
}

export async function writeBusinessKnowledge(input: {
  workspaceId: string; projectId: string; documentId: string; expectedRevision: number; idempotencyKey: string;
  reason: string; changes: unknown;
}, principal: ServicePrincipalContext, corrector?: { type: "owner" | "workspace_admin"; id: string }) {
  if (!principal.scopes.includes("document:write")) throw new BusinessKnowledgeError("FORBIDDEN", "Document write permission is required");
  if (input.projectId !== principal.projectId || input.workspaceId !== principal.workspaceId) throw new BusinessKnowledgeError("NOT_FOUND", "Document not found");
  const fields = businessKnowledgeFieldsSchema.parse(input.changes);
  if (!input.idempotencyKey || input.idempotencyKey.length > 240 || !input.reason.trim() || input.reason.length > 1000) throw new BusinessKnowledgeError("VALIDATION_FAILED", "Invalid write metadata");
  const requestHash = hash({ ...input, changes: fields, corrector });
  try {
    return await db.$transaction(async (tx) => {
      const prior = await tx.businessKnowledgeReceipt.findUnique({ where: { projectId_operation_idempotencyKey: { projectId: input.projectId, operation: receiptOp, idempotencyKey: input.idempotencyKey } } });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new BusinessKnowledgeError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different content");
        return prior.result as unknown as BusinessKnowledgeDocument;
      }
      const project = await tx.project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, select: { id: true, workspaceId: true, sites: { take: 1, orderBy: { createdAt: "asc" }, select: { id: true } } } });
      if (!project) throw new BusinessKnowledgeError("NOT_FOUND", "Document not found");
      const head = await tx.businessKnowledgeDocument.findUnique({ where: { projectId: input.projectId } });
      if (head && head.logicalId !== input.documentId) throw new BusinessKnowledgeError("NOT_FOUND", "Document not found");
      const current = head?.revision ?? 0;
      if (input.expectedRevision !== current) throw new BusinessKnowledgeError("REVISION_CONFLICT", "Document revision changed", current);
      const oldFields = head ? await tx.businessKnowledgeRevision.findUnique({ where: { documentId_revision: { documentId: head.id, revision: current } } }) : null;
      const previousFields = oldFields?.fields as Record<string, unknown> | undefined ?? {};
       const corrected = Object.fromEntries(Object.entries(fields).map(([name, fact]) => {
         const previous = previousFields[name] as { provenance?: { status?: string } } | undefined;
         if (previous?.provenance?.status === "disputed" || previous?.provenance?.status === "deferred") {
           throw new BusinessKnowledgeError("VALIDATION_FAILED", `Cannot correct ${name} while its existing status is ${previous.provenance.status}`);
         }
         if (previous?.provenance?.status === "owner_confirmed" && corrector?.type === "workspace_admin"
             && !input.reason.trim()) throw new BusinessKnowledgeError("VALIDATION_FAILED", "An explicit reason is required to overwrite an owner-confirmed fact");
         if (corrector) {
           const record = fact as { provenance: Record<string, unknown> };
           return [name, { ...record, provenance: { ...record.provenance, kind: corrector.type === "owner" ? "owner_input" : "admin_input",
             actor: corrector, status: corrector.type === "owner" ? "owner_confirmed" : "admin_confirmed" } }];
         }
         return [name, fact];
       }));
       const merged = { ...previousFields, ...corrected };
      const validated = businessKnowledgeFieldsSchema.parse(merged);
       const changedFields = (Object.keys(corrected) as Array<keyof BusinessKnowledgeFields>).filter((field) => JSON.stringify(previousFields[field]) !== JSON.stringify(corrected[field]));
      const affectedActions = current > 0 && changedFields.length > 0
        ? await tx.researchAction.findMany({ where: { projectId: input.projectId, status: { in: ["PROPOSED", "DRAFTING", "DRAFT_READY"] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 101, select: { id: true, siteId: true } })
        : [];
      const affectedActionsHaveMore = affectedActions.length > 100;
      const boundedActions = affectedActions.slice(0, 100);
      const affectedActionIds = boundedActions.map((action) => action.id);
      const documentRowId = head?.id ?? randomUUID();
      if (head) {
        const count = await tx.businessKnowledgeDocument.updateMany({ where: { id: head.id, revision: current }, data: { revision: current + 1 } });
        if (count.count !== 1) throw new BusinessKnowledgeError("REVISION_CONFLICT", "Document revision changed", current);
      } else {
        await tx.businessKnowledgeDocument.create({ data: { id: documentRowId, logicalId: input.documentId, projectId: input.projectId, revision: 1, updatedAt: new Date() } });
      }
      const saved = await tx.businessKnowledgeRevision.create({ data: { documentId: documentRowId, revision: current + 1, state: "working", fields: json(validated),
        reason: input.reason.trim(), changedFields: json(changedFields), affectedActionIds: json(affectedActionIds), affectedActionsHaveMore,
        serviceCaller: principal.servicePrincipalId } });
      const result = documentShape(project, { logicalId: input.documentId, revision: current + 1, acceptedRevision: head?.acceptedRevision ?? null }, saved);
      await tx.businessKnowledgeReceipt.create({ data: { projectId: input.projectId, operation: receiptOp, idempotencyKey: input.idempotencyKey, requestHash, result: json(result) } });
      const eventBySite = new Map<string, string[]>();
      for (const action of boundedActions) eventBySite.set(action.siteId, [...(eventBySite.get(action.siteId) ?? []), action.id]);
      if (eventBySite.size === 0 && project.sites[0]) eventBySite.set(project.sites[0].id, []);
      for (const [siteId, actionIds] of eventBySite) {
        await tx.connectorEventCounter.upsert({ where: { projectId: input.projectId }, create: { projectId: input.projectId, sequence: 1 }, update: { sequence: { increment: 1 } } });
        const counter = await tx.connectorEventCounter.findUniqueOrThrow({ where: { projectId: input.projectId } });
        await tx.connectorEvent.create({ data: { id: randomUUID(), projectId: input.projectId, siteId, sequence: counter.sequence,
          type: current > 0 && actionIds.length ? "business.knowledge.corrected" : "business.knowledge.updated",
          payload: json({ documentId: input.documentId, revision: current + 1, changedFields, affectedActionIds: actionIds }) } });
      }
      return result;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof BusinessKnowledgeError) throw error;
    if (error instanceof z.ZodError) throw new BusinessKnowledgeError("VALIDATION_FAILED", error.issues[0]?.message ?? "Invalid business knowledge");
    if ((error as { code?: string }).code === "P2002" || (error as { code?: string }).code === "P2034") {
      const prior = await db.businessKnowledgeReceipt.findUnique({ where: { projectId_operation_idempotencyKey: { projectId: input.projectId, operation: receiptOp, idempotencyKey: input.idempotencyKey } } });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new BusinessKnowledgeError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different content");
        return prior.result as unknown as BusinessKnowledgeDocument;
      }
      const head = await db.businessKnowledgeDocument.findUnique({ where: { projectId: input.projectId } });
      throw new BusinessKnowledgeError("REVISION_CONFLICT", "Concurrent document write; retry against the current revision", head?.revision ?? 0);
    }
    throw error;
  }
}

export async function acceptBusinessKnowledge(input: {
  workspaceId: string; projectId: string; documentId: string; expectedRevision: number; idempotencyKey: string; reason: string;
}, principal: ServicePrincipalContext, owner: { actorId: string; externalOrganizationId: string }) {
  if (!principal.scopes.includes("document:write")) throw new BusinessKnowledgeError("FORBIDDEN", "Document write permission is required");
  if (input.projectId !== principal.projectId || input.workspaceId !== principal.workspaceId) throw new BusinessKnowledgeError("NOT_FOUND", "Document not found");
  const requestHash = hash({ input, actorId: owner.actorId });
  try {
    return await db.$transaction(async (tx) => {
      const project = await tx.project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId, workspace: { externalOrganizationId: owner.externalOrganizationId } }, select: { id: true, workspaceId: true } });
      const head = await tx.businessKnowledgeDocument.findUnique({ where: { projectId: input.projectId } });
      if (!project || !head || head.logicalId !== input.documentId) throw new BusinessKnowledgeError("NOT_FOUND", "Document not found");
      const prior = await tx.businessKnowledgeAcceptance.findUnique({ where: { documentId_idempotencyKey: { documentId: head.id, idempotencyKey: input.idempotencyKey } } });
      if (prior) {
        if (prior.requestHash !== requestHash) throw new BusinessKnowledgeError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different acceptance details");
        const priorRevision = await tx.businessKnowledgeRevision.findUniqueOrThrow({ where: { documentId_revision: { documentId: head.id, revision: prior.revision } } });
        return documentShape(project!, { ...head, revision: prior.revision, acceptedRevision: prior.revision }, priorRevision);
      }
      if (head.revision !== input.expectedRevision) throw new BusinessKnowledgeError("REVISION_CONFLICT", "Document revision changed", head.revision);
      await tx.businessKnowledgeAcceptance.create({ data: { documentId: head.id, revision: head.revision, actorType: "owner", actorId: owner.actorId, serviceCaller: principal.servicePrincipalId, reason: input.reason, idempotencyKey: input.idempotencyKey, requestHash } });
      await tx.businessKnowledgeDocument.update({ where: { id: head.id }, data: { acceptedRevision: head.revision } });
      const rev = await tx.businessKnowledgeRevision.findUniqueOrThrow({ where: { documentId_revision: { documentId: head.id, revision: head.revision } } });
      return documentShape(project, { ...head, acceptedRevision: head.revision }, rev);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof BusinessKnowledgeError) throw error;
    if ((error as { code?: string }).code === "P2002" || (error as { code?: string }).code === "P2034") {
      const head = await db.businessKnowledgeDocument.findUnique({ where: { projectId: input.projectId } });
      const prior = head?.logicalId === input.documentId
        ? await db.businessKnowledgeAcceptance.findUnique({ where: { documentId_idempotencyKey: { documentId: head.id, idempotencyKey: input.idempotencyKey } } })
        : null;
      if (prior) {
        if (prior.requestHash !== requestHash) throw new BusinessKnowledgeError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different acceptance details");
        return readBusinessKnowledge(input.projectId, input.documentId, prior.revision, "accepted");
      }
      throw new BusinessKnowledgeError("REVISION_CONFLICT", "Concurrent acceptance; refresh and retry", head?.revision ?? 0);
    }
    throw error;
  }
}
