import { describe, expect, it, vi } from "vitest";

const at = new Date("2026-11-04T00:00:00.000Z");

function packet() {
  return sealPacket(
    {
      projectId: "p1",
      siteId: "s1",
      policyVersion: "recommendation-policy/2",
      candidate: {
        findingId: "f0",
        findingType: "CONCERN",
        theme: "Theme",
        summary: "Summary",
        premise: null,
        observedAt: at.toISOString(),
        dedupKey: "O13:f0",
        sourceIds: [],
      },
      businessFacts: [],
      context: { language: "en", audience: null, market: null, marketSource: null },
      sources: [],
      pages: [],
      links: [],
      requests: [],
      trace: [],
      inventory: [],
      search: [],
      limitations: [],
    },
    at
  );
}

function model(): ModelDecision {
  return {
    question: {
      text: "Is this needed?",
      audience: null,
      journeyStage: null,
      bases: [{ basis: "inferred_need", references: [], note: "An inferred question." }],
      state: "unverified",
      rationale: "A plausible question.",
    },
    premise: { state: "unverified", rationale: "Not established.", references: [] },
    offerFit: { state: "unverified", rationale: "Not established.", references: [] },
    coverage: [],
    readiness: "no_action",
    intervention: "maintain",
    change: null,
    assetJustification: null,
    investigation: null,
    targets: [],
    benefits: [],
    effort: { size: "unknown", rationale: "No implementation work.", uncertainty: [] },
    risks: [],
    reviews: [],
    success: { measure: "No work is justified.", instrumentation: "unknown", rationale: "No implementation work." },
    uncertainty: [],
    contradictions: [],
    reasons: ["No work is justified."],
  };
}

vi.mock("@/lib/recommendation/packet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/recommendation/packet")>();
  return { ...actual, buildEvidencePacket: vi.fn(async () => packet()) };
});
vi.mock("@/lib/recommendation/run", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/recommendation/run")>();
  return {
    ...actual,
    findReusableDecision: vi.fn(async () => null),
    assessFinding: vi.fn(async () => ({
      decision: finaliseDecision({
        model: model(),
        packet: packet(),
        modelName: "fixture",
        promptVersion: "fixture/1",
      }),
      packet: packet(),
      errors: [],
    })),
  };
});

import {
  finaliseDecision,
  sealPacket,
  type ModelDecision,
  type RecommendationDecision,
} from "@/lib/recommendation/contracts";
import { AnalysisLedger } from "@/lib/recommendation/ledger";
import { shadowRecommendations } from "@/lib/recommendation/shadow";

function db() {
  const rows = Array.from({ length: 15 }, (_, index) => ({
    id: `e${index}`,
    dimensions: {
      findingId: `f${index}`,
      painPoint: "true",
      theme: `Theme ${index}`,
      recommendationDedupKey: `O13:f${index}`,
    },
    observedAt: at,
  }));
  return {
    site: { findUnique: vi.fn(async () => ({ domain: "site.test", projectId: "p1" })) },
    evidenceRecord: {
      findMany: vi.fn(async (args: { where: { kind?: string } }) =>
        args.where.kind === "research_finding" ? rows : []
      ),
      findUnique: vi.fn(async () => null),
    },
    opportunity: { findMany: vi.fn(async () => []) },
    researchFinding: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => ({
        id: args.where.id,
        runId: "r1",
        type: "CONCERN",
        theme: "Theme",
        summary: "Summary",
        evidenceSourceIds: [],
        createdAt: at,
      })),
    },
    task: { findMany: vi.fn(async () => []) },
    rawProviderResponse: { findUnique: vi.fn(async () => null) },
    evidenceEdge: { findMany: vi.fn(async () => []) },
  } as never;
}

const assessor = (async (value: unknown) => ({
  kind: "final" as const,
  attempts: 1,
  raw: null,
  decision: finaliseDecision({
    model: model(),
    packet: value as ReturnType<typeof packet>,
    modelName: "fixture",
    promptVersion: "fixture/1",
  }),
})) as never;

describe("shadow completeness", () => {
  it("reports unassessed candidates separately instead of calling them failed", async () => {
    const report = await shadowRecommendations(db(), {
      projectId: "p1",
      siteId: "s1",
      maxAssessments: 8,
      assessor,
      ledger: new AnalysisLedger(),
    });
    expect(report.candidateCount).toBe(15);
    expect(report.assessedCount).toBe(8);
    expect(report.notAssessedCount).toBe(7);
    expect(report.complete).toBe(false);
    expect(report.totals.failed).toBe(0);
    expect(report.totals.not_assessed).toBe(7);
    expect(report.budget.reason).toMatch(/budget exhausted/);
  });

  it("assesses every candidate in all mode", async () => {
    const report = await shadowRecommendations(db(), {
      projectId: "p1",
      siteId: "s1",
      maxAssessments: "all",
      assessor,
      ledger: new AnalysisLedger(),
    });
    expect(report.candidateCount).toBe(15);
    expect(report.assessedCount).toBe(15);
    expect(report.notAssessedCount).toBe(0);
    expect(report.complete).toBe(true);
    expect(report.budget.maxAssessments).toBe("all");
  });
});
