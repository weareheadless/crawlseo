import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv from "ajv";

const state = vi.hoisted(() => ({
  project: { id: "project-1", workspaceId: "workspace-1", workspace: { externalOrganizationId: "helloada:owner-1" }, sites: [{ id: "site-1" }] },
  head: null as any, actions: [{ id: "action-1", siteId: "site-1" }],
  revisions: new Map<string, any>(), receipts: new Map<string, any>(), acceptances: new Map<string, any>(), events: [] as any[], sequence: 0,
}));
const key = (documentId: string, revision: number) => `${documentId}:${revision}`;
const receiptKey = (projectId: string, operation: string, idempotencyKey: string) => `${projectId}:${operation}:${idempotencyKey}`;
vi.mock("@/lib/db", () => {
  const tx = {
    project: { findUnique: vi.fn(async () => ({ id: state.project.id, workspaceId: state.project.workspaceId })), findFirst: vi.fn(async () => state.project) },
    businessKnowledgeDocument: {
      findUnique: vi.fn(async () => state.head ? { ...state.head, revisions: [...state.revisions.values()] } : null),
      create: vi.fn(async ({ data }: any) => (state.head = { ...data, acceptedRevision: null, updatedAt: new Date() })),
      update: vi.fn(async ({ where, data }: any) => (state.head = { ...state.head, ...data, updatedAt: new Date() })),
      updateMany: vi.fn(async ({ where, data }: any) => { if (!state.head || state.head.id !== where.id || state.head.revision !== where.revision) return { count: 0 }; state.head = { ...state.head, ...data, updatedAt: new Date() }; return { count: 1 }; }),
      findUniqueOrThrow: vi.fn(async () => state.head),
    },
    businessKnowledgeRevision: {
      findUnique: vi.fn(async ({ where }: any) => state.revisions.get(key(where.documentId_revision.documentId, where.documentId_revision.revision)) ?? null),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => state.revisions.get(key(where.documentId_revision.documentId, where.documentId_revision.revision))),
      create: vi.fn(async ({ data }: any) => { const row = { id: `rev-${data.revision}`, ...data, createdAt: new Date() }; state.revisions.set(key(data.documentId, data.revision), row); return row; }),
    },
    businessKnowledgeReceipt: {
      findUnique: vi.fn(async ({ where }: any) => state.receipts.get(receiptKey(where.projectId_operation_idempotencyKey.projectId, where.projectId_operation_idempotencyKey.operation, where.projectId_operation_idempotencyKey.idempotencyKey)) ?? null),
      create: vi.fn(async ({ data }: any) => { state.receipts.set(receiptKey(data.projectId, data.operation, data.idempotencyKey), data); return data; }),
    },
    businessKnowledgeAcceptance: {
      findUnique: vi.fn(async ({ where }: any) => state.acceptances.get(`${where.documentId_idempotencyKey.documentId}:${where.documentId_idempotencyKey.idempotencyKey}`) ?? null),
      findFirst: vi.fn(async ({ where }: any) => [...state.acceptances.values()].find((row) => row.documentId === where.documentId && row.revision === where.revision) ?? null),
      create: vi.fn(async ({ data }: any) => { state.acceptances.set(`${data.documentId}:${data.idempotencyKey}`, data); return data; }),
    },
    connectorEventCounter: {
      upsert: vi.fn(async ({ update }: any) => { state.sequence += update.sequence.increment; return { sequence: state.sequence }; }),
      findUniqueOrThrow: vi.fn(async () => ({ sequence: state.sequence })),
    },
    connectorEvent: { create: vi.fn(async ({ data }: any) => { state.events.push(data); return data; }) },
    researchAction: { findMany: vi.fn(async () => state.actions) },
  };
  return { db: { ...tx, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) } };
});

import { acceptBusinessKnowledge, BusinessKnowledgeError, readBusinessKnowledge, writeBusinessKnowledge } from "@/lib/projects/business-knowledge";

const principal = { credentialId: "credential-1", servicePrincipalId: "principal-1", workspaceId: "workspace-1", projectId: "project-1", scopes: ["document:read", "document:write"] };
const fact = (value: string) => ({ value, provenance: { kind: "intake", sourceId: "intake-1", originSystem: "helloada", originRecordId: "owner-1", originRevision: 1,
  actor: { type: "owner", id: "owner-1" }, status: "owner_confirmed", recordedAt: "2026-10-26T00:00:00.000Z", observedAt: "2026-10-26T00:00:00.000Z", evidenceUri: "https://helloada.test/intake/1" }, publicationUse: "internal_only" });
const writeInput = (overrides: Record<string, unknown> = {}) => ({ workspaceId: "workspace-1", projectId: "project-1", documentId: "document-1", expectedRevision: 0,
  idempotencyKey: "intake-write-0001", reason: "confirmed intake", changes: { businessName: fact("Acme") }, ...overrides });
const contractSchema = JSON.parse(readFileSync(resolve(process.cwd(), "contracts/business-knowledge-v1.schema.json"), "utf8"));
const validateDocument = new Ajv({ allErrors: true }).compile(contractSchema);

describe("canonical business knowledge revisions", () => {
  beforeEach(() => { state.head = null; state.revisions.clear(); state.receipts.clear(); state.acceptances.clear(); state.events.length = 0; state.sequence = 0; state.actions = [{ id: "action-1", siteId: "site-1" }]; });

  it("creates a partial intake, preserves accepted history on correction, and reads pinned historical versions", async () => {
    const first = await writeBusinessKnowledge(writeInput(), principal);
    expect(first).toMatchObject({ revision: 1, state: "working", acceptedRevision: null, fields: { businessName: { value: "Acme" } } });
    expect(validateDocument(first)).toBe(true);
    const accepted = await acceptBusinessKnowledge({ workspaceId: "workspace-1", projectId: "project-1", documentId: "document-1", expectedRevision: 1, idempotencyKey: "accept-0001", reason: "owner accepted" }, principal, { actorId: "owner-1", externalOrganizationId: "helloada:owner-1" });
    expect(accepted).toMatchObject({ revision: 1, state: "accepted", acceptedRevision: 1 });
    expect(validateDocument(accepted)).toBe(true);
    const correction = await writeBusinessKnowledge(writeInput({ expectedRevision: 1, idempotencyKey: "correction-0001", reason: "corrected name", changes: { businessName: fact("Acme Studio") } }), principal);
    expect(correction).toMatchObject({ revision: 2, state: "working", acceptedRevision: 1 });
    expect(state.revisions.get("document-1:2")).toMatchObject({ reason: "corrected name", changedFields: ["businessName"], affectedActionIds: ["action-1"], serviceCaller: "principal-1" });
    await expect(readBusinessKnowledge("project-1", "document-1", 1, "accepted")).resolves.toMatchObject({ revision: 1, state: "accepted", acceptedRevision: 1, fields: { businessName: { value: "Acme" } } });
    await expect(readBusinessKnowledge("project-1")).resolves.toMatchObject({ revision: 2, state: "working", acceptedRevision: 1 });
    expect(state.events).toHaveLength(2);
    expect(state.events[1]).toMatchObject({ type: "business.knowledge.corrected", payload: { affectedActionIds: ["action-1"], changedFields: ["businessName"] } });
  });

  it("replays exact write retries, rejects changed key reuse, and detects stale revisions", async () => {
    const first = await writeBusinessKnowledge(writeInput(), principal);
    await expect(writeBusinessKnowledge(writeInput(), principal)).resolves.toEqual(first);
    await expect(writeBusinessKnowledge(writeInput({ changes: { businessName: fact("Other") } }), principal)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(writeBusinessKnowledge(writeInput({ idempotencyKey: "new-key-0002" }), principal)).rejects.toMatchObject({ code: "REVISION_CONFLICT", currentRevision: 1 });
  });

  it("hides documents outside the credential project and enforces write scope", async () => {
    await expect(writeBusinessKnowledge({ ...writeInput(), projectId: "other-project", workspaceId: "other-workspace" }, principal)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(writeBusinessKnowledge(writeInput(), { ...principal, scopes: ["document:read"] })).rejects.toBeInstanceOf(BusinessKnowledgeError);
  });
});
