import { describe, expect, it, vi } from "vitest";

import { bridgeFindingsToEvidence, findingDimensions } from "@/lib/research/finding-evidence";
import { finaliseDecision, type EvidencePacket, type ModelDecision } from "@/lib/recommendation/contracts";

const AT = new Date("2026-11-02T00:00:00.000Z");

const finding = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "f1",
  runId: "run-1",
  type: "PAIN_POINT",
  theme: "fitted wardrobe pricing",
  summary: "Homeowners ask what a fitted wardrobe costs before booking.",
  confidence: 70,
  sentiment: "negative",
  urgency: "high",
  createdAt: AT,
  evidenceSourceIds: ["src-1"],
  ...over,
});

function decisionFor(packet: EvidencePacket): ModelDecision {
  const page = packet.pages[0];
  return {
    question: {
      text: "What does a fitted wardrobe cost?",
      audience: "homeowners",
      journeyStage: "consideration",
      bases: [{ basis: "inferred_need", references: [], note: "Homeowners ask about cost before booking a survey" }],
      state: "unverified",
      rationale: "The finding and the service page show that cost is the next question.",
    },
    premise: { state: "unverified", rationale: "The finding makes no checkable absence claim.", references: [] },
    offerFit: {
      state: "supported",
      rationale: "The business makes fitted wardrobes.",
      references: ["fact:services"],
    },
    coverage: page
      ? [{ pageId: page.id, state: "does_not_answer", rationale: "It lists the service but not the cost.", excerpts: [], limitations: [] }]
      : [],
    readiness: "actionable",
    intervention: "update_page",
    change: "Add a price range and what the quotation includes.",
    investigation: null,
    targets: page
      ? [{ pageId: page.id, pageUrl: page.url, sectionId: null, role: "update", rationale: "The service page is where the question arises." }]
      : [],
    benefits: [{
      track: "customer_value",
      mechanism: "A homeowner can judge the budget before booking.",
      measurement: "unquantified",
      baselineReference: null,
      assumptions: [],
      uncertainty: ["demand is not measured"],
    }],
    effort: { size: "small", rationale: "One section on an existing page.", uncertainty: [] },
    risks: [],
    reviews: [],
    success: { measure: "A homeowner can state a typical range after reading.", instrumentation: "unavailable", rationale: "No enquiry tracking is connected." },
    uncertainty: ["demand is not measured"],
    contradictions: [],
    reasons: ["A specific existing-page improvement is justified by the service content."],
  };
}

function fakeDb(findings: Array<Record<string, unknown>>) {
  const evidence: Array<Record<string, unknown>> = [];
  const opportunities: Array<Record<string, unknown>> = [];
  const knowledge = {
    revision: 1,
    acceptedRevision: 1,
    revisions: [{ revision: 1, fields: { services: { value: ["fitted wardrobes"], provenance: { evidenceUri: "https://site.test/services", kind: "ai_observation", status: "assumed" } } } }],
  };
  const db = {
    site: {
      findUnique: vi.fn(async () => ({ id: "s1", projectId: "p1", domain: "site.test" })),
    },
    siteProfile: {
      findUnique: vi.fn(async () => ({ language: "en", topics: [], audience: null, constraints: {} })),
    },
    businessKnowledgeDocument: {
      findUnique: vi.fn(async (args: { select?: Record<string, unknown> }) =>
        args?.select?.revisions ? knowledge : { id: "doc-1", revision: 1, acceptedRevision: 1 }
      ),
    },
    businessKnowledgeRevision: {
      findFirst: vi.fn(async () => ({ fields: knowledge.revisions[0].fields })),
    },
    crawl: {
      findFirst: vi.fn(async () => ({ id: "c1", pagesFound: 2, maxPages: 100, finishedAt: AT })),
    },
    auditPage: {
      findMany: vi.fn(async (args: { skip?: number }) =>
        (args?.skip ?? 0) > 0
          ? []
          : [
              { url: "https://site.test/services", title: "Fitted wardrobes", contentText: "We make fitted wardrobes to measure for each room.", contentHash: "h1", statusCode: 200, indexable: true },
              { url: "https://site.test/", title: "Home", contentText: "Bespoke furniture in Bristol.", contentHash: "h2", statusCode: 200, indexable: true },
            ]
      ),
      count: vi.fn(async () => 0),
    },
    researchSource: {
      findMany: vi.fn(async () => [{ id: "src-1", url: "https://forum.test/cost", title: "What did you pay?", provider: "community", excerpt: "I could not find a price before booking.", retrievedAt: AT, language: "en" }]),
    },
    researchFinding: { findMany: vi.fn(async () => findings) },
    evidenceRecord: {
      findMany: vi.fn(async (args?: { where?: { kind?: unknown } }) => {
        const kind = args?.where?.kind;
        if (!kind) return evidence;
        const kinds = typeof kind === "string" ? [kind] : (kind as { in?: string[] }).in ?? [];
        return evidence.filter((row) => kinds.includes(row.kind as string));
      }),
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        const row = { id: `ev-${evidence.length + 1}`, ...args.create };
        evidence.push(row);
        return { id: row.id };
      }),
      update: vi.fn(async () => ({})),
    },
    opportunity: {
      findUnique: vi.fn(async (args: { where?: { projectId_dedupKey?: { dedupKey?: string } } }) =>
        opportunities.find((row) => row.dedupKey === args?.where?.projectId_dedupKey?.dedupKey) ?? null
      ),
      findMany: vi.fn(async () => opportunities),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: `op-${opportunities.length + 1}`, status: "detected", ...args.data };
        opportunities.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = opportunities.find((entry) => entry.id === args.where.id);
        if (row) Object.assign(row, args.data);
        return row ?? { id: args.where.id };
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
      groupBy: vi.fn(async () => []),
    },
    evidenceEdge: {
      upsert: vi.fn(async () => ({ id: "edge" })),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    rawProviderResponse: { findUnique: vi.fn(async () => null) },
  };
  return { db: db as never, evidence, opportunities };
}

describe("research finding → canonical decision → evidence", () => {
  it("does not assess a context-only finding", async () => {
    const { db, evidence } = fakeDb([finding({ type: "GENERAL" })]);
    const assess = vi.fn();
    const result = await bridgeFindingsToEvidence(db, { projectId: "p1", siteId: "s1", runId: "run-1", assess });
    expect(result.assessed).toBe(0);
    expect(assess).not.toHaveBeenCalled();
    expect(evidence[0].dimensions).not.toHaveProperty("recommendationDecisionJson");
  });

  it("assesses an eligible finding and publishes the same decision", async () => {
    const { db, evidence, opportunities } = fakeDb([finding()]);
    const assess = vi.fn(async (packet: EvidencePacket) => ({
      ok: true as const,
      attempts: 1,
      decision: finaliseDecision({ model: decisionFor(packet), packet, modelName: "fixture-model", promptVersion: "recommendation-prompt/1" }),
    }));
    const result = await bridgeFindingsToEvidence(db, { projectId: "p1", siteId: "s1", runId: "run-1", assess });
    expect(result.assessed).toBe(1);
    const dimensions = evidence[0].dimensions as Record<string, unknown>;
    expect(dimensions.recommendationOutcome).toBe("actionable");
    expect(dimensions.recommendationModel).toBe("fixture-model");
    expect(opportunities).toHaveLength(1);
    expect((opportunities[0].recommendationDecision as Record<string, unknown>).readiness).toBe("actionable");
  });

  it("reuses a decision when the sealed packet is unchanged", async () => {
    const { db } = fakeDb([finding()]);
    const assess = vi.fn(async (packet: EvidencePacket) => ({
      ok: true as const,
      attempts: 1,
      decision: finaliseDecision({ model: decisionFor(packet), packet, modelName: "fixture-model", promptVersion: "recommendation-prompt/1" }),
    }));
    await bridgeFindingsToEvidence(db, { projectId: "p1", siteId: "s1", runId: "run-1", assess });
    await bridgeFindingsToEvidence(db, { projectId: "p1", siteId: "s1", runId: "run-1", assess });
    expect(assess).toHaveBeenCalledTimes(1);
  });

  it("records a failed assessment without inventing a decision", async () => {
    const { db, evidence, opportunities } = fakeDb([finding()]);
    const result = await bridgeFindingsToEvidence(db, {
      projectId: "p1",
      siteId: "s1",
      runId: "run-1",
      assess: async () => ({ ok: false as const, attempts: 2, errors: ["invalid output"], raw: null }),
    });
    expect(result.assessed).toBe(0);
    expect(result.assessmentFailures).toHaveLength(1);
    expect((evidence[0].dimensions as Record<string, unknown>).recommendationOutcome).toBe("assessment_failed");
    expect(opportunities).toHaveLength(0);
  });

  it("counts failed attempts against the assessment ceiling", async () => {
    const { db } = fakeDb([finding({ id: "f1" }), finding({ id: "f2", theme: "second question" })]);
    const assess = vi.fn(async () => ({ ok: false as const, attempts: 1, errors: ["bad"], raw: null }));
    await bridgeFindingsToEvidence(db, { projectId: "p1", siteId: "s1", runId: "run-1", assess, maxAssessments: 1 });
    expect(assess).toHaveBeenCalledTimes(1);
  });

  it("flags only winnable gaps, so context does not become work", () => {
    expect(findingDimensions(finding({ type: "PAIN_POINT" }) as never).painPoint).toBe("true");
    expect(findingDimensions(finding({ type: "COMPETITOR" }) as never).positioningGap).toBe("true");
    const context = findingDimensions(finding({ type: "GENERAL" }) as never);
    expect(context.painPoint).toBeNull();
    expect(context.positioningGap).toBeNull();
  });
});
