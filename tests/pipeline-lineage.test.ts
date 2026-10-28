import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({ db: { researchAction: { findFirst: vi.fn() }, researchSource: { findMany: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db }));
import { readActionLineage, projectActionLineage } from "@/lib/pipeline/lineage";
import type { ActionLineageProjectionInput } from "@/lib/pipeline/lineage-types";

const action = (override: Partial<ActionLineageProjectionInput> = {}): ActionLineageProjectionInput => ({
  id: "a1", siteId: "s1", projectId: "p1", title: "Improve page", status: "VERIFIED", revision: 2,
  runId: "r1", findingId: "f1", evidence: { source_ids: ["src1"] }, createdAt: new Date("2025-01-01"), approvedAt: null,
  deliveredAt: new Date("2025-01-02"), verifiedAt: new Date("2025-01-03"), run: { id: "r1", siteId: "s1", projectId: "p1", title: "Run", status: "COMPLETED", createdAt: new Date("2024-12-01") },
  finding: { id: "f1", runId: "r1", summary: "Finding", createdAt: new Date("2024-12-02"), evidenceSourceIds: ["src1"] },
  drafts: [{ id: "d1", siteId: "s1", title: "Draft", status: "READY", createdAt: new Date("2025-01-01") }],
  agentTasks: [{ id: "t1", siteId: "s1", status: "COMPLETED", createdAt: new Date("2025-01-01"), actionRevision: 1 }],
  deliveries: [{ id: "delivery1", status: "DELIVERED", createdAt: new Date("2025-01-02"), verifiedAt: null, outcome: null, outcomeMeasuredAt: null }],
  ...override,
});
const source = (override: Partial<{ id: string; runId: string; projectId: string; title: string; url: string; provider: string; retrievedAt: Date }> = {}) => ({
  id: "src1", runId: "r1", projectId: "p1", title: "Source", url: "https://example.com", provider: "news", retrievedAt: new Date("2024-12-01"), ...override,
});

describe("pipeline action lineage", () => {
  beforeEach(() => { vi.clearAllMocks(); db.researchSource.findMany.mockResolvedValue([source()]); });
  it("rejects missing and wrong-site actions with a site-scoped lookup", async () => {
    db.researchAction.findFirst.mockResolvedValue(null);
    await expect(readActionLineage("s2", "a1")).rejects.toMatchObject({ status: 404 });
    expect(db.researchAction.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a1", siteId: "s2" } }));
  });
  it("uses only supported site-local detail paths and rejects malformed identifiers", () => {
    const value = projectActionLineage(action(), [source()]);
    expect(value.nodes.find((n) => n.kind === "action")?.href).toBe("/sites/s1/actions/a1");
    expect(value.nodes.find((n) => n.kind === "research_run")?.href).toBe("/sites/s1/research/runs/r1");
    expect(value.nodes.find((n) => n.kind === "finding")?.href).toBeNull();
    expect(value.nodes.find((n) => n.kind === "draft")?.href).toBeNull();
    expect(value.nodes.find((n) => n.kind === "agent_attempt")?.href).toBeNull();
    const unsafe = projectActionLineage(action({ siteId: "../elsewhere", id: "a1" }));
    expect(unsafe.nodes.find((n) => n.kind === "action")?.href).toBeNull();
  });
  it("does not claim business revision pinning for undocumented or malformed evidence shapes", () => {
    for (const evidence of [{ business_document_id: "doc", business_revision: "not-a-revision" }, { business_knowledge: { documentId: "doc", revision: 4 } }, {}]) {
      const value = projectActionLineage(action({ evidence }));
      expect(value.links.business.state).not.toBe("recorded");
      expect(value.nodes.some((n) => n.kind === "business_revision")).toBe(false);
    }
  });
  it("tolerates invalid legacy dates", () => {
    const value = projectActionLineage(action({ createdAt: "not-a-date", run: { ...action().run!, createdAt: "broken" } }));
    expect(value.nodes.find((n) => n.kind === "action")?.occurredAt).toBeNull();
    expect(value.nodes.find((n) => n.kind === "research_run")?.occurredAt).toBeNull();
  });
  it("queries cited sources inside the exact site and project run and returns same-run evidence only", async () => {
    db.researchAction.findFirst.mockResolvedValue(action());
    const value = await readActionLineage("s1", "a1");
    expect(db.researchSource.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { in: ["src1"] }, runId: "r1", run: { is: { siteId: "s1", projectId: "p1" } } }),
    }));
    expect(value.nodes.some((n) => n.id === "src1" && n.kind === "source")).toBe(true);
    db.researchSource.findMany.mockResolvedValue([source({ runId: "r-foreign", projectId: "p-foreign" })]);
    expect((await readActionLineage("s1", "a1")).nodes.some((n) => n.kind === "source")).toBe(false);
  });
  it("excludes foreign child rows and discloses capped lists with hasMore", () => {
    const drafts = Array.from({ length: 101 }, (_, i) => ({ id: `d${i}`, siteId: i === 100 ? "elsewhere" : "s1", title: "Draft", status: "READY", createdAt: new Date() }));
    const agents = Array.from({ length: 101 }, (_, i) => ({ id: `t${i}`, siteId: i === 100 ? "elsewhere" : "s1", status: "COMPLETED", createdAt: new Date(), actionRevision: i }));
    const deliveries = Array.from({ length: 21 }, (_, i) => ({ id: `delivery${i}`, status: "DELIVERED", createdAt: new Date(), verifiedAt: null, outcome: null, outcomeMeasuredAt: null }));
    const value = projectActionLineage(action({ drafts, agentTasks: agents, deliveries }));
    expect(value.nodes.filter((n) => n.kind === "draft")).toHaveLength(100);
    expect(value.lists.drafts).toEqual({ returned: 100, limit: 100, hasMore: true });
    expect(value.lists.agentAttempts).toEqual({ returned: 100, limit: 100, hasMore: true });
    expect(value.lists.deliveries).toEqual({ returned: 20, limit: 20, hasMore: true });
    expect(value.nodes.some((n) => n.id === "d100" || n.id === "t100")).toBe(false);
  });
  it("keeps delivery, recorded verification and measured outcome distinct", () => {
    const delivered = projectActionLineage(action({ verifiedAt: null, status: "DELIVERED", deliveries: [{ id: "x", status: "DELIVERED", createdAt: new Date(), verifiedAt: null, outcome: null, outcomeMeasuredAt: null }] }));
    expect(delivered.links.delivery.state).toBe("recorded");
    expect(delivered.links.verification.state).toBe("not_recorded");
    const verified = projectActionLineage(action({ verifiedAt: new Date(), deliveries: [{ id: "x", status: "DELIVERED", createdAt: new Date(), verifiedAt: new Date(), outcome: null, outcomeMeasuredAt: null }] }));
    expect(verified.links.verification.state).toBe("recorded");
    expect(verified.links.outcome.state).toBe("not_recorded");
  });
});
