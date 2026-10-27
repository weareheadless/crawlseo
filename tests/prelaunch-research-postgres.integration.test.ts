import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/dataforseo/client", async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/dataforseo/client')>()),
  resolveDataForSeoLocale: vi.fn(async () => ({ languageCode: "en", locationCode: 2840, country: "US" })),
  executeDataForSeoOperation: provider.execute }));
const enabled = process.env.RUN_UI019_DB_TESTS === "1";
const fixture = (() => { try { const u = new URL(process.env.DATABASE_URL ?? ""); return u.protocol.startsWith("postgres") && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname) && u.username === "codex" && u.pathname.slice(1).endsWith("_validation"); } catch { return false; } })();
if (enabled && !fixture) throw new Error("UI019 DB tests require a local codex _validation database");
const suite = enabled ? describe : describe.skip;
import { db } from "@/lib/db";
import { requestPrelaunchResearch } from "@/lib/dataforseo/prelaunch";
import { getResearchReport } from "@/lib/dataforseo/research";
import { runPrelaunchResearch } from "@/lib/dataforseo/prelaunch-runner";
import { enqueueJob } from "@/lib/jobs/queue";
import { JobKind } from "@prisma/client";
const orgs: string[] = [];
const brief = (period: string) => ({ period, focus_market: { language: "en", country: "US" }, business_goal: "Grow business", audience: ["buyers"], priority_services: ["service"], keyword_seeds: ["seed one", "seed two", "seed three", "seed four", "seed five"], competitor: null, research_questions: ["What is needed?"], selection_rationale: { market: "owner brief", seeds: ["seed one", "seed two", "seed three", "seed four", "seed five"], competitor: "none" }, package: "standard-v1" });
const lastClosedPeriod = () => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); };
suite("UI-019 domainless prelaunch persistence", () => {
  beforeAll(async () => db.$connect());
  afterEach(async () => { if (orgs.length) await db.workspace.deleteMany({ where: { externalOrganizationId: { in: orgs.splice(0) } } }); vi.clearAllMocks(); });
  afterAll(async () => db.$disconnect());
  async function project() {
    const id = randomUUID().replaceAll("-", ""); const org = `ui019:${id}`; orgs.push(org);
    const workspace = await db.workspace.create({ data: { externalOrganizationId: org, name: org } });
    return db.project.create({ data: { workspaceId: workspace.id, externalProjectId: id, name: org,
      monthlyResearchAllowanceMicros: BigInt(1000000), maxResearchOperationMicros: BigInt(10000), researchBudgetCurrency: "USD" } });
  }
  it("rejects missing monetary budget before creating a run or job", async () => {
    const p = await project(); await db.project.update({ where: { id: p.id }, data: { monthlyResearchAllowanceMicros: null, maxResearchOperationMicros: null } });
    await expect(requestPrelaunchResearch({ projectId: p.id, brief: brief(lastClosedPeriod()), idempotencyKey: "no-budget-123" })).rejects.toThrow(/allowance and per-operation ceiling/);
    expect(await db.seoResearchRun.count({ where: { projectId: p.id } })).toBe(0);
    expect(await db.job.count({ where: { projectId: p.id } })).toBe(0);
  });
  it("keeps identical site-scoped job dedupe keys independent across sites in one project", async () => {
    const p = await project();
    const a = await db.site.create({ data: { projectId: p.id, domain: `a-${p.id}.example` } });
    const b = await db.site.create({ data: { projectId: p.id, domain: `b-${p.id}.example` } });
    const first = await enqueueJob({ projectId: p.id, siteId: a.id, kind: JobKind.SEO_RESEARCH, idempotencyKey: "same-site-key" });
    const second = await enqueueJob({ projectId: p.id, siteId: b.id, kind: JobKind.SEO_RESEARCH, idempotencyKey: "same-site-key" });
    expect(second.id).not.toBe(first.id);
    expect(await db.job.count({ where: { projectId: p.id, kind: JobKind.SEO_RESEARCH, idempotencyKey: "same-site-key" } })).toBe(2);
  });
  it("creates and reads a domainless run; a second key maps to it without spending or creating a Site", async () => {
    const p = await project();
    const first = await requestPrelaunchResearch({ projectId: p.id, brief: brief(lastClosedPeriod()), idempotencyKey: "key-one-123" });
    const spent = await db.researchBudgetReservation.count({ where: { projectId: p.id } });
    const again = await requestPrelaunchResearch({ projectId: p.id, brief: brief(lastClosedPeriod()), idempotencyKey: "key-two-123" });
    expect(again).toMatchObject({ report_id: first.report_id, existing: true });
    expect(await db.researchBudgetReservation.count({ where: { projectId: p.id } })).toBe(spent);
    expect(await db.site.count({ where: { projectId: p.id } })).toBe(0);
    expect(await getResearchReport(p.id, first.report_id)).toMatchObject({ report_id: first.report_id, site_id: null });
    expect(await db.prelaunchResearchRequest.count({ where: { projectId: p.id } })).toBe(2);
  });
  it("rejects a reused key for another period", async () => {
    const p = await project(); const b = brief(lastClosedPeriod());
    await requestPrelaunchResearch({ projectId: p.id, brief: b, idempotencyKey: "key-period-123" });
    const previous = new Date(`${lastClosedPeriod()}-01T00:00:00Z`); previous.setUTCMonth(previous.getUTCMonth() - 1);
    await expect(requestPrelaunchResearch({ projectId: p.id, brief: brief(previous.toISOString().slice(0, 7)), idempotencyKey: "key-period-123" })).rejects.toThrow(/idempotency_key/);
  });
  it("marks provider failures partial and provides explicit domain-dependent skips", async () => {
    const p = await project(); const result = await requestPrelaunchResearch({ projectId: p.id, brief: brief(lastClosedPeriod()), idempotencyKey: "key-outage-123" });
    provider.execute.mockRejectedValue(new Error("provider rejected request"));
    const finished = await runPrelaunchResearch(p.id, result.report_id);
    expect(finished.status).toBe("PARTIAL");
    const report = finished.report as { skipped: Array<{ reason: string }> };
    expect(report.skipped.map(x => x.reason)).toEqual(expect.arrayContaining(["no_domain_available", "no_site_integrations_available", "no_site_to_crawl", "no_competitor_selected"]));
    expect(await db.site.count({ where: { projectId: p.id } })).toBe(0);
  });
});
