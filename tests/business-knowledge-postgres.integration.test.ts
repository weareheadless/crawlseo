import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { acceptBusinessKnowledge, readBusinessKnowledge, writeBusinessKnowledge } from "@/lib/projects/business-knowledge";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";

const enabled = process.env.RUN_BUSINESS_KNOWLEDGE_DB_TESTS === "1";
const fixtureDatabase = (() => {
  try { const url = new URL(process.env.DATABASE_URL ?? ""); return url.protocol.startsWith("postgres") && new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(url.hostname) && url.username === "codex" && url.pathname.slice(1).endsWith("_validation"); }
  catch { return false; }
})();
if (enabled && !fixtureDatabase) throw new Error("RUN_BUSINESS_KNOWLEDGE_DB_TESTS requires the disposable PostgreSQL fixture DATABASE_URL");
const dbDescribe = enabled ? describe : describe.skip;
const ownedOrganizations = new Set<string>();
const principal = (workspaceId: string, projectId: string): ServicePrincipalContext => ({ credentialId: "fixture-credential", servicePrincipalId: "fixture-principal", workspaceId, projectId, scopes: ["document:read", "document:write"] });
const fact = (value: string) => ({ value, provenance: { kind: "intake" as const, sourceId: "intake-fixture", originSystem: "helloada", originRecordId: "owner-fixture", originRevision: 1,
  actor: { type: "owner" as const, id: "owner-fixture" }, status: "owner_confirmed" as const, recordedAt: new Date().toISOString(), observedAt: new Date().toISOString(), evidenceUri: "https://helloada.invalid/intake/fixture" }, publicationUse: "internal_only" as const });

dbDescribe("business knowledge revisions on disposable PostgreSQL", () => {
  beforeAll(async () => { await db.$connect(); });
  afterEach(async () => { if (ownedOrganizations.size) { await db.workspace.deleteMany({ where: { externalOrganizationId: { in: [...ownedOrganizations] } } }); ownedOrganizations.clear(); } });
  afterAll(async () => { await db.$disconnect(); });

  it("handles exact retries, CAS conflicts, acceptance history and correction", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const externalOrganizationId = `helloada:owner-${suffix}`;
    ownedOrganizations.add(externalOrganizationId);
    const workspace = await db.workspace.create({ data: { externalOrganizationId, name: `UI-003 fixture ${suffix}` } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, externalProjectId: `helloada:${suffix}`, name: "Business knowledge fixture" } });
    const actor = principal(workspace.id, project.id);
    const documentId = "business-profile";
    const initial = { workspaceId: workspace.id, projectId: project.id, documentId, expectedRevision: 0, idempotencyKey: `initial-${suffix}`, reason: "fixture intake", changes: { businessName: fact("Fixture Business") } };
    const [first, concurrentRetry] = await Promise.all([writeBusinessKnowledge(initial, actor), writeBusinessKnowledge(initial, actor)]);
    expect(first).toEqual(concurrentRetry);
    expect(await readBusinessKnowledge(project.id, documentId)).toEqual(first);
    expect(await db.businessKnowledgeRevision.count({ where: { document: { projectId: project.id } } })).toBe(1);
    await expect(writeBusinessKnowledge({ ...initial, idempotencyKey: `stale-${suffix}` }, actor)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const acceptanceInput = { workspaceId: workspace.id, projectId: project.id, documentId, expectedRevision: 1, idempotencyKey: `accept-${suffix}`, reason: "owner reviewed" };
    const accepted = await acceptBusinessKnowledge(acceptanceInput, actor, { actorId: `owner-${suffix}`, externalOrganizationId });
    expect(accepted).toMatchObject({ state: "accepted", acceptedRevision: 1 });
    const acceptedRetry = await acceptBusinessKnowledge(acceptanceInput, actor, { actorId: `owner-${suffix}`, externalOrganizationId });
    expect(acceptedRetry).toEqual(accepted);
    const corrected = await writeBusinessKnowledge({ ...initial, expectedRevision: 1, idempotencyKey: `correct-${suffix}`, reason: "correction", changes: { businessName: fact("Corrected Fixture Business") } }, actor);
    expect(corrected).toMatchObject({ revision: 2, acceptedRevision: 1, state: "working" });
    expect(await readBusinessKnowledge(project.id, documentId, 1, "accepted")).toEqual(accepted);
    expect(await acceptBusinessKnowledge(acceptanceInput, actor, { actorId: `owner-${suffix}`, externalOrganizationId })).toEqual(accepted);
    expect(await db.businessKnowledgeAcceptance.count({ where: { document: { projectId: project.id } } })).toBe(1);
    expect(await db.businessKnowledgeReceipt.count({ where: { projectId: project.id } })).toBe(2);
    expect(await db.connectorEvent.count({ where: { projectId: project.id } })).toBe(0);
    expect(await db.connectorEventCounter.findUnique({ where: { projectId: project.id } })).toBeNull();

    const otherProject = await db.project.create({ data: { workspaceId: workspace.id, externalProjectId: `helloada:other-${suffix}`, name: "Second business knowledge fixture" } });
    const otherActor = principal(workspace.id, otherProject.id);
    const secondDocument = await writeBusinessKnowledge({ ...initial, projectId: otherProject.id,
      idempotencyKey: `second-${suffix}`, changes: { businessName: fact("Other Fixture Business") } }, otherActor);
    expect(secondDocument.documentId).toBe(documentId);
    expect(await readBusinessKnowledge(otherProject.id, documentId)).toMatchObject({ projectId: otherProject.id, documentId, fields: { businessName: { value: "Other Fixture Business" } } });
    expect(await readBusinessKnowledge(project.id, documentId)).toMatchObject({ projectId: project.id, documentId, fields: { businessName: { value: "Corrected Fixture Business" } } });
    expect(await db.businessKnowledgeDocument.count({ where: { projectId: { in: [project.id, otherProject.id] } } })).toBe(2);
  }, 60_000);
});
