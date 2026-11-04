import { describe, expect, it, vi } from "vitest";

import {
  getFunnelCounts,
  getOpportunityDetail,
  headlineFor,
  legForKind,
  listEvidence,
  listOpportunities,
  listTasks,
} from "@/lib/funnel/views";
import { OPPORTUNITY_LABELS } from "@/lib/funnel/labels";

const evidence = (overrides: Record<string, unknown> = {}) => ({
  id: "ev-1",
  kind: "keyword_rank",
  producer: "search_console",
  observedAt: new Date("2026-11-01T00:00:00.000Z"),
  dimensions: { query: "coral print", url: "https://example.com/" },
  metrics: {
    "first_party:position": { value: 7, unit: "rank", source: "first_party" },
    "first_party:impressions": { value: 900, unit: "count", source: "first_party" },
  },
  ...overrides,
});

function db(overrides: Record<string, unknown> = {}) {
  const base = {
    opportunity: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    evidenceRecord: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    evidenceEdge: { findMany: vi.fn().mockResolvedValue([]) },
    task: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    baseline: { findMany: vi.fn().mockResolvedValue([]) },
    outcomeObservation: { findMany: vi.fn().mockResolvedValue([]) },
    demandMapCluster: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0) },
    site: { findUnique: vi.fn().mockResolvedValue(null) },
    project: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  return { ...base, ...overrides } as never;
}

describe("funnel read model (wave 4 surfaces)", () => {
  it("every taxonomy type has a label, a play and a success metric", () => {
    for (const [type, meta] of Object.entries(OPPORTUNITY_LABELS)) {
      expect(meta.code).toMatch(/^O\d+$/);
      expect(meta.label.length).toBeGreaterThan(2);
      expect(meta.play.length).toBeGreaterThan(10);
      expect(meta.successMetric.length).toBeGreaterThan(5);
      expect(["search", "business", "both"]).toContain(meta.firesFrom);
      expect(type).toMatch(/^O\d+_/);
    }
  });

  it("classifies evidence into the two legs", () => {
    expect(legForKind("knowledge_fact")).toBe("why");
    expect(legForKind("research_finding")).toBe("why");
    expect(legForKind("question_coverage")).toBe("why");
    expect(legForKind("keyword_rank")).toBe("how");
    expect(legForKind("onpage_crawl")).toBe("how");
    expect(legForKind("ai_visibility_observation")).toBe("how");
  });

  it("builds a decisive headline per evidence kind", () => {
    expect(headlineFor(evidence() as never)).toContain("coral print");
    expect(headlineFor(evidence() as never)).toContain("position 7");
    expect(
      headlineFor(evidence({ kind: "onpage_crawl", dimensions: { url: "https://x/a", issueType: "MISSING_SCHEMA" }, metrics: {} }) as never)
    ).toContain("missing schema");
    expect(headlineFor(evidence({ kind: "knowledge_fact", dimensions: { question: "opening hours" }, metrics: {} }) as never)).toContain(
      "opening hours"
    );
  });

  it("returns the board sorted by score with the reason attached", async () => {
    const client = db({
      opportunity: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "op-1",
            type: "O1_winnable_rank",
            status: "detected",
            dimension: "seo",
            title: "Winnable rank",
            summary: "s",
            scoreValue: 42,
            evidenceCompleteness: "how",
            detectedBy: "funnel-refresh",
            firstDetectedAt: new Date("2026-11-01T00:00:00.000Z"),
            clusterId: null,
            dedupKey: "O1:q:u",
          },
        ]),
        findUnique: vi.fn(),
        groupBy: vi.fn(),
      },
      evidenceEdge: { findMany: vi.fn().mockResolvedValue([{ toId: "op-1", fromId: "ev-1" }]) },
      evidenceRecord: { findMany: vi.fn().mockResolvedValue([evidence()]), count: vi.fn().mockResolvedValue(1) },
    });
    const rows = await listOpportunities(client, { projectId: "p1", statuses: ["detected"] });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toContain("coral print");
    expect(rows[0].score).toBe(42);
    expect(rows[0].evidenceCount).toBe(1);
    // sorted by score desc at the query level
    expect((client as unknown as { opportunity: { findMany: ReturnType<typeof vi.fn> } }).opportunity.findMany.mock.calls[0][0].orderBy[0]).toEqual({
      scoreValue: "desc",
    });
  });

  it("renders a missing leg as missing rather than inventing evidence", async () => {
    const client = db({
      opportunity: {
        findUnique: vi.fn().mockResolvedValue({
          id: "op-1",
          type: "O13_user_pain_point",
          status: "detected",
          dimension: "content",
          title: "Pain point",
          summary: "s",
          scoreValue: 12,
          scoreInputs: {
            worth: {
              readiness: "actionable",
              measurement: "unquantified",
              benefitTrack: "customer_value",
              intervention: "update_page",
              change: "Add a worked cost example and the current fee ranges.",
              targetPages: ["https://site.test/services"],
              successMeasure: "A buyer can state the expected cost after reading.",
              uncertainty: ["the frequency of the question is not measured"],
              coverageSummary: "partially answers at https://site.test/services",
              needRationale: "Three buyers asked before booking.",
              needEvidenceUrls: ["https://forum.test/cost"],
              offerFitRationale: "The business makes fitted wardrobes.",
              offerFitEvidenceUrls: ["https://site.test/about"],
              assessmentModel: "fixture-model",
            },
          },
          evidenceCompleteness: "why",
          detectedBy: "funnel-refresh",
          firstDetectedAt: new Date(),
          clusterId: null,
          decidedBy: null,
          decidedAt: null,
          parkReason: null,
          dedupKey: "d",
        }),
        findMany: vi.fn(),
        groupBy: vi.fn(),
      },
      evidenceEdge: { findMany: vi.fn().mockResolvedValue([{ fromId: "ev-why" }]) },
      evidenceRecord: {
        findMany: vi.fn().mockResolvedValue([
          evidence({ id: "ev-why", kind: "research_finding", producer: "research", dimensions: { painPointSummary: "owners fear contracts" }, metrics: {} }),
        ]),
        count: vi.fn(),
      },
    });
    const detail = await getOpportunityDetail(client, "op-1");
    expect(detail?.whyEvidence).toHaveLength(1);
    expect(detail?.howEvidence).toHaveLength(0);
    expect(detail?.completeness).toBe("why");
    expect(detail?.task).toBeNull();
    expect(detail?.decision.change).toContain("worked cost example");
    expect(detail?.decision.targetPages).toEqual(["https://site.test/services"]);
    expect(detail?.decision.successMeasure).toContain("state the expected cost");
    expect(detail?.decision.uncertainty).toEqual(["the frequency of the question is not measured"]);
    expect(detail?.decision.needRationale).toContain("Three buyers");
    expect(detail?.decision.assessmentModel).toBe("fixture-model");
  });

  it("returns null for an unknown opportunity instead of an empty shell", async () => {
    const client = db();
    expect(await getOpportunityDetail(client, "missing")).toBeNull();
  });

  it("counts stages, dimensions, legs and unknown scores honestly", async () => {
    const client = db({
      opportunity: {
        findMany: vi.fn().mockResolvedValue([
          { status: "detected", dimension: "seo", type: "O1_winnable_rank", evidenceCompleteness: "both", scoreValue: 30 },
          { status: "detected", dimension: "technical", type: "O8_structured_data_gap", evidenceCompleteness: "how", scoreValue: null },
          { status: "parked", dimension: "seo", type: "O2_striking_distance", evidenceCompleteness: "how", scoreValue: 2 },
        ]),
        findUnique: vi.fn(),
        groupBy: vi.fn(),
      },
      evidenceRecord: { findMany: vi.fn(), count: vi.fn().mockResolvedValue(5) },
    });
    const counts = await getFunnelCounts(client, "p1");
    expect(counts.total).toBe(3);
    expect(counts.detected).toBe(2);
    expect(counts.parked).toBe(1);
    expect(counts.bothLegs).toBe(1);
    expect(counts.missingWhy).toBe(2);
    expect(counts.byDimension).toEqual({ seo: 2, technical: 1 });
    expect(counts.scored).toBe(2); // the null score is not counted as zero
    expect(counts.evidenceTotal).toBe(5);
    expect(counts.byType[0]).toEqual({ type: "O1_winnable_rank", count: 1 });
  });

  it("marks evidence usage and supersede state in the store view", async () => {
    const client = db({
      evidenceRecord: {
        findMany: vi.fn().mockResolvedValue([evidence(), evidence({ id: "ev-2", supersededById: "ev-3" })]),
        count: vi.fn(),
      },
      evidenceEdge: { findMany: vi.fn().mockResolvedValue([{ fromId: "ev-1" }]) },
    });
    const rows = await listEvidence(client, { projectId: "p1" });
    expect(rows[0].usedBy).toBe(1);
    expect(rows[0].superseded).toBe(false);
    expect(rows[1].usedBy).toBe(0);
    expect(rows[1].superseded).toBe(true);
  });

  it("lists tasks with their opportunity reason and verdict", async () => {
    const client = db({
      task: {
        findFirst: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "t1",
            title: "Fix schema",
            status: "awaiting_human",
            assignedTo: "dana",
            agentPreparedById: "agent",
            humanConfirmedBy: null,
            humanConfirmedAt: null,
            createdAt: new Date("2026-11-02T00:00:00.000Z"),
            opportunity: { id: "op-1", title: "Structured data gap", type: "O8_structured_data_gap", scoreValue: 55 },
            outcomeObservations: [{ verdict: "pending" }],
          },
        ]),
      },
    });
    const rows = await listTasks(client, "p1");
    expect(rows[0]).toMatchObject({
      opportunityId: "op-1",
      opportunityType: "O8_structured_data_gap",
      verdict: "pending",
      agentPreparedById: "agent",
      humanConfirmedBy: null,
    });
  });
});
