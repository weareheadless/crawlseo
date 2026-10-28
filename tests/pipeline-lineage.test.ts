import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({ db: { researchAction: { findFirst: vi.fn() }, researchSource: { findMany: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db }));

import { readActionLineage, projectActionLineage } from "@/lib/pipeline/lineage";

const action = (override: Record<string, unknown> = {}) => ({
  id: "a1", siteId: "s1", projectId: "p1", title: "Improve page", source: "legacy", kind: "CONTENT", status: "VERIFIED", revision: 2,
  runId: "r1", findingId: "f1", evidence: { source_ids: ["src1"] }, createdAt: new Date("2025-01-01"), approvedAt: null,
  deliveredAt: new Date("2025-01-02"), verifiedAt: new Date("2025-01-03"), run: { id: "r1", title: "Run", status: "COMPLETED", createdAt: new Date("2024-12-01") },
  finding: { id: "f1", runId: "r1", summary: "Finding", createdAt: new Date("2024-12-02"), evidenceSourceIds: ["src1"] },
  drafts: [{ id: "d1", title: "Draft", status: "READY", createdAt: new Date("2025-01-01"), wixApprovedAt: null }],
  agentTasks: [{ id: "t1", status: "COMPLETED", createdAt: new Date("2025-01-01"), startedAt: null, completedAt: null, actionRevision: 1, errorCode: "PRIVATE" }],
  deliveries: [{ id: "delivery1", status: "DELIVERED", createdAt: new Date("2025-01-02"), verifiedAt: null, outcome: null, outcomeMeasuredAt: null }],
  questionCoverages: [], ...override,
});

describe("pipeline action lineage", () => {
  beforeEach(() => { vi.clearAllMocks(); db.researchSource.findMany.mockResolvedValue([{ id: "src1", runId: "r1", title: "Source", url: "https://example.com", provider: "news", retrievedAt: new Date("2024-12-01") }]); });
  it("rejects wrong-site and missing actions by scoped lookup", async () => {
    db.researchAction.findFirst.mockResolvedValue(null);
    await expect(readActionLineage("s2", "a1")).rejects.toMatchObject({ status: 404 });
    expect(db.researchAction.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a1", siteId: "s2" } }));
  });
  it("projects legacy actions and never guesses a business revision", () => {
    const result = projectActionLineage(action({ runId: null, findingId: null, run: null, finding: null, evidence: {}, deliveredAt: null, verifiedAt: null, deliveries: [] }) as never);
    expect(result.links.business).toMatchObject({ state: "not_recorded" });
    expect(result.nodes.filter((node) => node.kind === "research_run")).toHaveLength(0);
    expect(result.links.research).toMatchObject({ state: "not_recorded" });
  });
  it("keeps retries and draft versions distinct and strips private task fields", () => {
    const value = action({ agentTasks: [{ id: "t1", status: "FAILED", createdAt: new Date(), actionRevision: 1, errorCode: "SECRET" }, { id: "t2", status: "COMPLETED", createdAt: new Date(), actionRevision: 2, errorCode: null }], drafts: [{ id: "d1", title: "v1", status: "READY", createdAt: new Date() }, { id: "d2", title: "v2", status: "READY", createdAt: new Date() }] });
    const result = projectActionLineage(value as never);
    expect(result.nodes.filter((node) => node.kind === "agent_attempt")).toHaveLength(2);
    expect(result.nodes.filter((node) => node.kind === "draft")).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("does not expose cross-run sources and distinguishes delivery, verification and measurement", async () => {
    db.researchAction.findFirst.mockResolvedValue(action());
    db.researchSource.findMany.mockResolvedValue([{ id: "src1", runId: "foreign", title: "Foreign", url: "https://foreign.example", provider: "news", retrievedAt: new Date() }]);
    const result = await readActionLineage("s1", "a1");
    expect(result.nodes.some((node) => node.id === "src1")).toBe(false);
    expect(result.links.delivery.state).toBe("recorded");
    expect(result.links.verification.state).toBe("recorded");
    expect(result.links.outcome.state).toBe("not_recorded");
  });
  it("marks delivered-but-unverified and verified-but-unmeasured", () => {
    const result = projectActionLineage(action({ verifiedAt: null, status: "DELIVERED", deliveries: [{ id: "x", status: "DELIVERED", createdAt: new Date(), verifiedAt: null, outcome: null, outcomeMeasuredAt: null }] }) as never);
    expect(result.links.verification.state).toBe("not_recorded");
    expect(result.links.outcome.state).toBe("not_recorded");
  });
});
