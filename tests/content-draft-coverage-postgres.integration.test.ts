import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { recordDraftCoverage } from "@/lib/research/question-coverage";
import { writeBusinessKnowledge } from "@/lib/projects/business-knowledge";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";

const enabled = process.env.RUN_CONTENT_DRAFT_DB_TESTS === "1";
const fixture = (() => { try { const u = new URL(process.env.DATABASE_URL ?? ""); return u.protocol.startsWith("postgres") && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname) && u.username === "codex" && u.pathname.slice(1).endsWith("_validation"); } catch { return false; } })();
if (enabled && !fixture) throw new Error("RUN_CONTENT_DRAFT_DB_TESTS requires the disposable local codex _validation PostgreSQL database");
const suite = enabled ? describe : describe.skip;
const organizations: string[] = [];
const time = new Date().toISOString();

suite("content draft coverage on disposable PostgreSQL", () => {
  beforeAll(async () => db.$connect());
  afterEach(async () => { if (organizations.length) await db.workspace.deleteMany({ where: { externalOrganizationId: { in: organizations.splice(0) } } }); });
  afterAll(async () => db.$disconnect());
  it("accepts logical document identity and persists its internal foreign key", async () => {
    const suffix = randomUUID().replaceAll("-", ""), organization = `ui035:${suffix}`; organizations.push(organization);
    const workspace = await db.workspace.create({ data: { externalOrganizationId: organization, name: organization } });
    const project = await db.project.create({ data: { workspaceId: workspace.id, externalProjectId: `helloada:${suffix}`, name: "UI-035 fixture" } });
    const principal: ServicePrincipalContext = { credentialId: "fixture", servicePrincipalId: "fixture", workspaceId: workspace.id, projectId: project.id, scopes: ["document:read", "document:write"] };
    const fact = { value: ["Service"], provenance: { kind: "intake", sourceId: "fixture", originSystem: "helloada", originRecordId: suffix, originRevision: 1, actor: { type: "owner", id: suffix }, status: "owner_confirmed", recordedAt: time, observedAt: time, evidenceUri: "https://helloada.invalid/fixture" }, publicationUse: "approved" };
    await writeBusinessKnowledge({ workspaceId: workspace.id, projectId: project.id, documentId: "business-profile", expectedRevision: 0, idempotencyKey: `knowledge-${suffix}`, reason: "fixture", changes: { services: fact } }, principal);
    const document = await db.businessKnowledgeDocument.findUniqueOrThrow({ where: { projectId: project.id } });
    const site = await db.site.create({ data: { projectId: project.id, domain: `${suffix}.example` } });
    const draft = await db.contentDraft.create({ data: { siteId: site.id, opportunityKey: `fixture-${suffix}`, actionKind: "content", format: "article", intent: "informational", title: "Fixture", slug: `fixture-${suffix}`, metaTitle: "Fixture", metaDescription: "Fixture", excerpt: "Fixture", markdown: "# Fixture", brief: {}, model: "fixture", provider: "fixture" } });
    const coverage = await recordDraftCoverage(draft.id, { documentId: "business-profile", fieldPath: "services", revision: 1 });
    expect(coverage).toMatchObject({ status: "COVERED", documentId: document.id });
    if (!("id" in coverage)) throw new Error("Expected persisted coverage row");
    const row = await db.questionCoverage.findUniqueOrThrow({ where: { id: coverage.id }, include: { document: true } });
    expect(row.documentId).toBe(document.id);
    expect(row.document).toMatchObject({ id: document.id, logicalId: "business-profile" });
  }, 30_000);
});
