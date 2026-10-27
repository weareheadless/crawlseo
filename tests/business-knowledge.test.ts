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
      findFirst: vi.fn(async ({ where }: any) => {
        const row = state.head ? state.revisions.get(key(state.head.id, where.revision)) : null;
        return row ? { ...row, document: { logicalId: state.head.logicalId } } : null;
      }),
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

import { acceptBusinessKnowledge, BusinessKnowledgeError, businessKnowledgeFieldsSchema, readBusinessKnowledge, readBusinessKnowledgeCorrectionImpact, writeBusinessKnowledge } from "@/lib/projects/business-knowledge";

const principal = { credentialId: "credential-1", servicePrincipalId: "principal-1", workspaceId: "workspace-1", projectId: "project-1", scopes: ["document:read", "document:write"] };
const fact = (value: string) => ({ value, provenance: { kind: "intake", sourceId: "intake-1", originSystem: "helloada", originRecordId: "owner-1", originRevision: 1,
  actor: { type: "owner", id: "owner-1" }, status: "owner_confirmed", recordedAt: "2026-10-26T00:00:00.000Z", observedAt: "2026-10-26T00:00:00.000Z", evidenceUri: "https://helloada.test/intake/1" }, publicationUse: "internal_only" });
const writeInput = (overrides: Record<string, unknown> = {}) => ({ workspaceId: "workspace-1", projectId: "project-1", documentId: "document-1", expectedRevision: 0,
  idempotencyKey: "intake-write-0001", reason: "confirmed intake", changes: { businessName: fact("Acme") }, ...overrides });
const contractSchema = JSON.parse(readFileSync(resolve(process.cwd(), "contracts/business-knowledge-v1.schema.json"), "utf8"));
const validateDocument = new Ajv({ allErrors: true }).compile(contractSchema);
const canonicalFixtures = JSON.parse(readFileSync(resolve(process.cwd(), "examples/business-knowledge-v1-fixtures.json"), "utf8")) as { valid: Array<Record<string, any>> };

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
    expect(state.revisions.get(`${state.head.id}:2`)).toMatchObject({ reason: "corrected name", changedFields: ["businessName"], affectedActionIds: ["action-1"], serviceCaller: "principal-1" });
    await expect(readBusinessKnowledgeCorrectionImpact("project-1", "document-1", 2)).resolves.toMatchObject({ affectedActionIds: ["action-1"], affectedActionsHaveMore: false });
    await expect(readBusinessKnowledge("project-1", "document-1", 1, "accepted")).resolves.toMatchObject({ revision: 1, state: "accepted", acceptedRevision: 1, fields: { businessName: { value: "Acme" } } });
    await expect(readBusinessKnowledge("project-1", "document-1")).resolves.toMatchObject({ revision: 2, state: "working", acceptedRevision: 1 });
    expect(state.events).toHaveLength(2);
    expect(state.events[1]).toMatchObject({ type: "business.knowledge.corrected", payload: { affectedActionIds: ["action-1"], changedFields: ["businessName"] } });
  });

  it("replays exact write retries, rejects changed key reuse, and detects stale revisions", async () => {
    const first = await writeBusinessKnowledge(writeInput(), principal);
    await expect(writeBusinessKnowledge(writeInput(), principal)).resolves.toEqual(first);
    await expect(writeBusinessKnowledge(writeInput({ changes: { businessName: fact("Other") } }), principal)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(writeBusinessKnowledge(writeInput({ idempotencyKey: "new-key-0002" }), principal)).rejects.toMatchObject({ code: "REVISION_CONFLICT", currentRevision: 1 });
  });

  it("records dashboard correction provenance, requires rationale over owner truth, preserves disputes, and replays exactly", async () => {
    await writeBusinessKnowledge(writeInput(), principal);
    const correction = { expectedRevision: 1, idempotencyKey: "dashboard-correct-01", reason: "Owner provided corrected name", changes: { businessName: fact("New") } };
    await expect(writeBusinessKnowledge(writeInput(correction), principal, { type: "workspace_admin", id: "operator-1" })).rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("acknowledgement") });
    const corrected = await writeBusinessKnowledge(writeInput({ ...correction, acknowledgeOwnerOverride: true }), principal, { type: "workspace_admin", id: "operator-1" });
    expect(corrected.revision).toBe(2);
    expect(corrected.fields.businessName?.provenance).toMatchObject({ kind: "admin_input", status: "admin_confirmed", actor: { type: "workspace_admin", id: "operator-1" } });
    await expect(writeBusinessKnowledge(writeInput({ expectedRevision: 2, idempotencyKey: "dashboard-correct-02", reason: "", changes: { businessName: fact("No reason") } }), principal, { type: "workspace_admin", id: "operator-1" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(writeBusinessKnowledge(writeInput({ ...correction, acknowledgeOwnerOverride: true }), principal, { type: "workspace_admin", id: "operator-1" })).resolves.toEqual(corrected);
    expect(state.events.at(-1)?.payload).toMatchObject({ ownerOverrideAcknowledged: true });
    expect(state.head.revision).toBe(2);
  });

  it("does not resurrect disputed facts as confirmed", async () => {
    const disputed = { ...fact("Old"), provenance: { ...fact("Old").provenance, status: "disputed" as const } };
    await writeBusinessKnowledge(writeInput({ changes: { businessName: disputed } }), principal);
    await expect(writeBusinessKnowledge(writeInput({ expectedRevision: 1, idempotencyKey: "disputed-correction-01", reason: "correction", changes: { businessName: fact("New") } }), principal, { type: "workspace_admin", id: "operator-1" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(state.head.revision).toBe(1);
  });

  it("hides documents outside the credential project and enforces write scope", async () => {
    await expect(writeBusinessKnowledge({ ...writeInput(), projectId: "other-project", workspaceId: "other-workspace" }, principal)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(writeBusinessKnowledge(writeInput(), { ...principal, scopes: ["document:read"] })).rejects.toBeInstanceOf(BusinessKnowledgeError);
  });

  it("parses canonical fixtures, Python RFC3339 offsets, and opaque evidence URIs", () => {
    for (const fixture of canonicalFixtures.valid) {
      if (fixture.kind === "business_document") expect(businessKnowledgeFieldsSchema.parse(fixture.fields)).toEqual(fixture.fields);
      if (fixture.kind === "document_write") expect(businessKnowledgeFieldsSchema.parse(fixture.changes)).toEqual(fixture.changes);
    }
    const offsetFact = { ...fact("Offset-aware evidence"), validFrom: "2026-10-26T13:00:00+00:00", validUntil: null,
      provenance: { ...fact("Offset-aware evidence").provenance, observedAt: "2026-10-26T13:00:00+00:00", recordedAt: "2026-10-26T13:01:00+00:00", evidenceUri: "urn:source:owner-intake:42" } };
    expect(businessKnowledgeFieldsSchema.parse({ businessName: offsetFact }).businessName?.validFrom).toBe("2026-10-26T13:00:00+00:00");
  });

  it("rejects malformed selectors instead of treating them as missing revisions", async () => {
    await expect(readBusinessKnowledge("project-1", "document-1", 0 as any)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(readBusinessKnowledge("project-1", "document-1", Number.NaN)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(readBusinessKnowledge("project-1", "document-1", undefined, "other" as any)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("caps durable correction impact and signals remaining pending work", async () => {
    await writeBusinessKnowledge(writeInput(), principal);
    state.actions = Array.from({ length: 101 }, (_, index) => ({ id: `action-${index}`, siteId: "site-1" }));
    await writeBusinessKnowledge(writeInput({ expectedRevision: 1, idempotencyKey: "bounded-correction-0001", reason: "bounded correction", changes: { businessName: fact("Changed") } }), principal);
    await expect(readBusinessKnowledgeCorrectionImpact("project-1", "document-1", 2)).resolves.toMatchObject({
      affectedActionIds: expect.arrayContaining(["action-0", "action-99"]), affectedActionsHaveMore: true,
    });
    const impact = await readBusinessKnowledgeCorrectionImpact("project-1", "document-1", 2);
    expect(impact.affectedActionIds).toHaveLength(100);
  });
});
