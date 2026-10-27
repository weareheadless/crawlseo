import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ execute: vi.fn(async () => ({ costMicros: 100, providerTaskId: "fixture-task", result: { volume: 7 } })) }));
vi.mock("@/lib/dataforseo/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/dataforseo/client")>()),
  resolveDataForSeoLocale: vi.fn(async () => ({ languageCode: "en", locationCode: 2840, country: "US" })), executeDataForSeoOperation: provider.execute }));
import { db } from "@/lib/db";
import { registerProject } from "@/lib/projects/register-project";
import { writeBusinessKnowledge, readBusinessKnowledge } from "@/lib/projects/business-knowledge";
import { requestPrelaunchResearch } from "@/lib/dataforseo/prelaunch";
import { runPrelaunchResearch } from "@/lib/dataforseo/prelaunch-runner";
import { getResearchReport } from "@/lib/dataforseo/research";
import { auditSchemaSemantics } from "@/lib/research/crawl-live-check";
import { recordQuestionCoverage } from "@/lib/research/question-coverage";

const enabled = process.env.RUN_UI018_DB_TESTS === "1";
const suite = enabled ? describe : describe.skip;
if (enabled) { const u = new URL(process.env.DATABASE_URL ?? ""); if (!u.hostname.match(/^(localhost|127\.0\.0\.1|\[::1\]|::1)$/) || u.username !== "codex" || !u.pathname.endsWith("_validation")) throw new Error("UI018 requires local codex _validation PostgreSQL"); }
const organizations: string[] = [];
const time = "2026-10-26T00:00:00.000Z";
const confirmed = (value: string) => ({ value, provenance: { kind: "intake" as const, sourceId: "intake-fixture", originSystem: "helloada", originRecordId: "owner-fixture", originRevision: 1, actor: { type: "owner" as const, id: "owner-fixture" }, status: "owner_confirmed" as const, recordedAt: time, observedAt: time, evidenceUri: "https://helloada.invalid/intake/fixture" }, publicationUse: "approved" as const });
const period = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
const brief = (p: string) => ({ period: p, focus_market: { language: "en", country: "US" }, business_goal: "Grow", audience: ["local customers"], priority_services: ["plumbing"], keyword_seeds: ["fixture plumbing search", "fixture drain repair", "fixture pipe service", "fixture water heater", "fixture emergency plumber"], competitor: null, research_questions: ["What plumbing services are available?"], selection_rationale: { market: "fixture", seeds: ["fixture plumbing search", "fixture drain repair", "fixture pipe service", "fixture water heater", "fixture emergency plumber"], competitor: "none" }, package: "standard-v1" });

suite("UI-018 CrawlSEO content intelligence contract on disposable PostgreSQL", () => {
  beforeAll(async () => db.$connect());
  afterEach(async () => { if (organizations.length) await db.workspace.deleteMany({ where: { externalOrganizationId: { in: organizations.splice(0) } } }); vi.clearAllMocks(); });
  afterAll(async () => db.$disconnect());
  it("preserves canonical revision references through domainless bounded research, coverage, audit and replay", async () => {
    const suffix = randomUUID().replaceAll("-", ""), org = `ui018:${suffix}`; organizations.push(org);
    const reg = await registerProject({ schemaVersion: "business-knowledge/1", kind: "project_registration", externalOrganizationId: org, workspaceName: org, externalProjectId: `helloada:${suffix}`, displayName: "UI018 fixture", domain: null, origin: { system: "helloada", externalId: suffix }, idempotencyKey: `register-${suffix}`, requestedCredentialScope: { audience: "business-knowledge", requestedPermissions: ["project:read", "document:read", "document:write"] } });
    const { projectId, workspaceId } = reg.identity;
    await db.project.update({ where: { id: projectId }, data: { monthlyResearchAllowanceMicros: BigInt("1000000"), maxResearchOperationMicros: BigInt("10000"), researchBudgetCurrency: "USD" } });
    const principal = { credentialId: "fixture", servicePrincipalId: "fixture", workspaceId, projectId, scopes: ["document:read", "document:write"] } as any;
    const doc = await writeBusinessKnowledge({ workspaceId, projectId, documentId: "business-profile", expectedRevision: 0, idempotencyKey: `intake-${suffix}`, reason: "confirmed intake", changes: { businessName: confirmed("Fixture Plumbing"), services: { ...confirmed("Plumbing"), value: ["Plumbing"] } } }, principal);
    expect(doc).toMatchObject({ documentId: "business-profile", revision: 1, state: "working" });
    const p = period(); const req = await requestPrelaunchResearch({ projectId, brief: brief(p), idempotencyKey: `research-${suffix}` });
    const finished = await runPrelaunchResearch(projectId, req.report_id);
    expect(finished.status).toBe("COMPLETED"); expect(provider.execute).toHaveBeenCalledTimes(5);
    const report = await getResearchReport(projectId, req.report_id); expect(report).toMatchObject({ report_id: req.report_id, site_id: null });
    const readback = await readBusinessKnowledge(projectId, "business-profile");
    const consumerShape = { documentId: readback.documentId, revision: readback.revision, state: readback.state, fields: readback.fields };
    expect(consumerShape).toEqual({ documentId: doc.documentId, revision: doc.revision, state: doc.state, fields: doc.fields });
    expect(Object.keys(consumerShape)).toEqual(["documentId", "revision", "state", "fields"]);
    const reservationsBeforeReplay = await db.researchBudgetReservation.count({ where: { projectId } });
    const replay = await requestPrelaunchResearch({ projectId, brief: brief(p), idempotencyKey: `research-${suffix}` });
    expect(replay).toMatchObject({ report_id: req.report_id, existing: true });
    expect(await db.researchBudgetReservation.count({ where: { projectId } })).toBe(5);
    expect(await db.researchBudgetReservation.count({ where: { projectId } })).toBe(reservationsBeforeReplay);
    expect(await db.seoResearchRun.count({ where: { projectId } })).toBe(1);
    expect(await db.job.count({ where: { projectId } })).toBe(1);
    // QuestionCoverage findings belong to the separate site-scoped ResearchRun model.
    // Keep prelaunch itself domainless, and create the minimal isolated fixture site only
    // for exercising the existing question-coverage contract.
    const site = await db.site.create({ data: { projectId, domain: `ui018-${suffix}.example` } });
    const researchRun = await db.researchRun.create({ data: { siteId: site.id, projectId, title: "UI018 coverage fixture", brief: {}, status: "COMPLETED",
      findings: { create: { type: "QUESTION", theme: "plumbing", summary: "What plumbing services are available?", confidence: 100 } } }, include: { findings: true } });
    const finding = researchRun.findings[0];
    const coverage = await recordQuestionCoverage({ projectId, findingId: finding.id, evidence: { documentId: (await db.businessKnowledgeDocument.findUniqueOrThrow({ where: { projectId } })).id, fieldPath: "services", revision: 1 }, section: { key: "faq:services", contentHash: "fixture-content" }, service: "Plumbing", audience: "local customers", locale: "en-US", status: "covered" });
    expect(coverage).toMatchObject({ status: "COVERED", evidenceRevision: 1 });
    const findings = auditSchemaSemantics('<p>Fixture Plumbing</p><script type="application/ld+json">{"@type":"LocalBusiness","name":"Fixture Plumbing"}</script>', readback);
    expect(findings).toEqual([]);
  }, 60000);
});
