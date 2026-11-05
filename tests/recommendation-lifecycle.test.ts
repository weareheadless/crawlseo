import { describe, expect, it, vi } from "vitest";

import {
  finaliseDecision,
  sealPacket,
  type EvidencePacket,
  type ModelDecision,
  type RecommendationDecision,
} from "@/lib/recommendation/contracts";
import { acceptOpportunityForSite } from "@/lib/funnel/accept";
import { AnalysisLedger } from "@/lib/recommendation/ledger";
import { publishDecision } from "@/lib/recommendation/publish";
import { shadowRecommendations } from "@/lib/recommendation/shadow";

const at = new Date("2026-11-04T00:00:00.000Z");

function packet(): EvidencePacket {
  return sealPacket({
    projectId: "p1",
    siteId: "s1",
    policyVersion: "recommendation-policy/2",
    candidate: {
      findingId: "f1",
      findingType: "CONCERN",
      theme: "documents",
      summary: "Which documents?",
      premise: null,
      observedAt: at.toISOString(),
      dedupKey: "O13:documents",
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
  });
}

function model(over: Partial<ModelDecision> = {}): ModelDecision {
  return {
    question: {
      text: "Which documents are required?",
      audience: null,
      journeyStage: null,
      bases: [{ basis: "inferred_need", references: [], note: "An explicitly inferred buying question." }],
      state: "unverified",
      rationale: "A plausible buying question.",
    },
    premise: { state: "unverified", rationale: "Not established.", references: [] },
    offerFit: { state: "unverified", rationale: "Not established.", references: [] },
    coverage: [],
    readiness: "needs_investigation",
    intervention: "investigate",
    change: null,
    assetJustification: null,
    investigation: {
      kind: "owner_input",
      question: "What does the owner's private ledger require?",
      inspect: ["Ask the owner for the private ledger."],
      decisionCriteria: ["The owner confirms the requirement."],
      deliverable: "A confirmed private list.",
    },
    targets: [],
    benefits: [],
    effort: { size: "unknown", rationale: "No implementation work.", uncertainty: [] },
    risks: [],
    reviews: [],
    success: { measure: "The owner confirms the requirement.", instrumentation: "unknown", rationale: "No implementation work." },
    uncertainty: [],
    contradictions: [],
    reasons: ["A private requirement is unresolved."],
    ...over,
  };
}

function investigationDecision(): RecommendationDecision {
  const p = packet();
  return finaliseDecision({
    model: model(),
    packet: p,
    modelName: "fixture-model",
    promptVersion: "recommendation-prompt/2",
  });
}

function rejectedDecision(): RecommendationDecision {
  const p = packet();
  return finaliseDecision({
    model: model({
      readiness: "rejected",
      intervention: "maintain",
      change: null,
      investigation: null,
      reasons: ["The premise is false."],
    }),
    packet: p,
    modelName: "fixture-model",
    promptVersion: "recommendation-prompt/2",
  });
}

function acceptanceDb(options: { projectId?: string; status?: string; decision?: RecommendationDecision } = {}) {
  const decision = options.decision ?? investigationDecision();
  const store = {
    status: options.status ?? "detected",
    projectId: options.projectId ?? "p1",
    recommendationDecision: decision,
    recommendationFingerprint: "fp-1",
    tasks: [] as Array<Record<string, unknown>>,
  };
  const db = {
    site: { findUnique: vi.fn(async () => ({ projectId: "p1" })) },
    opportunity: {
      findUnique: vi.fn(async (args: { where: { id?: string } }) =>
        args.where.id
          ? {
              id: "op1",
              projectId: store.projectId,
              status: store.status,
              type: "O13_user_pain_point",
              title: "Documents",
              summary: "Which documents?",
              scoreInputs: {},
              recommendationDecision: store.recommendationDecision,
              recommendationFingerprint: store.recommendationFingerprint,
            }
          : null
      ),
      updateMany: vi.fn(async (args: { where: { status: string; recommendationFingerprint: string | null }; data: Record<string, unknown> }) => {
        if (store.status !== args.where.status || store.recommendationFingerprint !== args.where.recommendationFingerprint) {
          return { count: 0 };
        }
        Object.assign(store, args.data);
        return { count: 1 };
      }),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        Object.assign(store, args.data);
        return {};
      }),
    },
    task: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        store.tasks.push(args.data);
        return { id: `task-${store.tasks.length}` };
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, store };
}

describe("R7 investigation acceptance", () => {
  it("accepts a canonical investigation with the rendered decision version", async () => {
    const decision = investigationDecision();
    const { db, store } = acceptanceDb({ decision });
    const taskId = await acceptOpportunityForSite(db as never, {
      siteId: "s1",
      opportunityId: "op1",
      assignedTo: "dana",
      expectedDecisionId: decision.decisionId,
    });
    expect(taskId).toBe("task-1");
    expect(store.status).toBe("accepted");
    expect(store.tasks[0]?.plan).toMatchObject({ kind: "investigation", decisionId: decision.decisionId });
  });

  it("refuses a stale render-time decision", async () => {
    const decision = investigationDecision();
    const { db } = acceptanceDb({ decision });
    await expect(
      acceptOpportunityForSite(db as never, {
        siteId: "s1",
        opportunityId: "op1",
        assignedTo: "dana",
        expectedDecisionId: "decision-stale",
      })
    ).rejects.toThrow(/changed since this page was loaded/);
  });

  it("refuses an opportunity from another project", async () => {
    const decision = investigationDecision();
    const { db } = acceptanceDb({ decision, projectId: "p2" });
    await expect(
      acceptOpportunityForSite(db as never, {
        siteId: "s1",
        opportunityId: "op1",
        assignedTo: "dana",
        expectedDecisionId: decision.decisionId,
      })
    ).rejects.toThrow(/does not belong to the site's project/);
  });

  it("refuses a duplicate click after the first acceptance", async () => {
    const decision = investigationDecision();
    const { db } = acceptanceDb({ decision });
    await acceptOpportunityForSite(db as never, {
      siteId: "s1",
      opportunityId: "op1",
      assignedTo: "dana",
      expectedDecisionId: decision.decisionId,
    });
    await expect(
      acceptOpportunityForSite(db as never, {
        siteId: "s1",
        opportunityId: "op1",
        assignedTo: "dana",
        expectedDecisionId: decision.decisionId,
      })
    ).rejects.toThrow(/status "accepted" cannot be accepted/);
  });

  it("does not create a task when the transaction fails", async () => {
    const decision = investigationDecision();
    const { db, store } = acceptanceDb({ decision });
    db.$transaction.mockRejectedValueOnce(new Error("transaction failed"));
    await expect(
      acceptOpportunityForSite(db as never, {
        siteId: "s1",
        opportunityId: "op1",
        assignedTo: "dana",
        expectedDecisionId: decision.decisionId,
      })
    ).rejects.toThrow(/transaction failed/);
    expect(store.status).toBe("detected");
    expect(store.tasks).toHaveLength(0);
  });
});

describe("R7 changed premise on accepted work", () => {
  it("records a rejected assessment on an accepted row without changing its status", async () => {
    const decision = rejectedDecision();
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      opportunity: {
        findUnique: vi.fn(async () => ({ id: "op1", status: "accepted" })),
        update: vi.fn(async (args: { data: Record<string, unknown> }) => {
          updates.push(args.data);
          return {};
        }),
      },
      evidenceEdge: { findMany: vi.fn(async () => []) },
    } as never;
    await publishDecision(db, {
      projectId: "p1",
      decision,
      findingType: "CONCERN",
      evidenceId: "e1",
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.status).toBeUndefined();
    expect((updates[0]?.recommendationDecision as { readiness?: string }).readiness).toBe("rejected");
  });
});


describe("R8 shadow compares full decisions and preserves accepted work", () => {
  function shadowDb(current: RecommendationDecision, status = "detected") {
    return {
      site: { findUnique: vi.fn(async () => ({ id: "s1", projectId: "p1", domain: "site.test" })) },
      siteProfile: { findUnique: vi.fn(async () => null) },
      businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
      businessKnowledgeRevision: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => ({ id: "c1", pagesFound: 1, maxPages: 100, finishedAt: at })) },
      auditPage: { findMany: vi.fn(async () => []) },
      researchSource: { findMany: vi.fn(async () => []) },
      researchFinding: {
        findUnique: vi.fn(async () => ({
          id: "f1",
          runId: "r1",
          type: "CONCERN",
          theme: "documents",
          summary: "Which documents?",
          evidenceSourceIds: [],
          createdAt: at,
        })),
      },
      evidenceRecord: {
        findMany: vi.fn(async (args?: { where?: { kind?: unknown } }) => {
          if (args?.where?.kind !== "research_finding") return [];
          return [
            {
              id: "e1",
              dimensions: {
                findingId: "f1",
                painPoint: "true",
                theme: "documents",
                recommendationDedupKey: "O13:f1",
                recommendationFinalPacketJson: JSON.stringify(packet()),
              },
              observedAt: at,
            },
          ];
        }),
        findUnique: vi.fn(async () => null),
      },
      opportunity: {
        findMany: vi.fn(async () => [
          {
            dedupKey: "O13:f1",
            status,
            title: "Documents",
            summary: "Which documents?",
            scoreInputs: {},
            recommendationDecision: current,
            recommendationEvidenceId: "e1",
          },
        ]),
        findUnique: vi.fn(async () => null),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      evidenceEdge: { findMany: vi.fn(async () => []) },
      rawProviderResponse: { findUnique: vi.fn(async () => null) },
      task: { findMany: vi.fn(async () => []) },
    } as never;
  }

  function currentDecision(): RecommendationDecision {
    return finaliseDecision({
      model: model({
        readiness: "needs_investigation",
        intervention: "investigate",
        change: null,
        investigation: {
          kind: "owner_input",
          question: "What does the owner's private ledger require?",
          inspect: ["Ask the owner for the private ledger."],
          decisionCriteria: ["The owner confirms the requirement."],
          deliverable: "A confirmed private list.",
        },
        reviews: [],
        reasons: ["A private requirement is unresolved."],
      }),
      packet: packet(),
      modelName: "fixture-model",
      promptVersion: "recommendation-prompt/2",
    });
  }

  function proposedDecision(packetValue: EvidencePacket, over: Partial<ModelDecision> = {}): RecommendationDecision {
    return finaliseDecision({
      model: model({
        readiness: "needs_investigation",
        intervention: "investigate",
        change: null,
        investigation: {
          kind: "owner_input",
          question: "What does the owner's private ledger require?",
          inspect: ["Ask the owner for the private ledger."],
          decisionCriteria: ["The owner confirms the requirement."],
          deliverable: "A confirmed private list.",
        },
        reviews: [{ requirement: "legal", reason: "The claim needs legal review." }],
        reasons: ["A private requirement is unresolved."],
        ...over,
      }),
      packet: packetValue,
      modelName: "fixture-model",
      promptVersion: "recommendation-prompt/2",
    });
  }

  it("reports a changed legal-review requirement, not unchanged", async () => {
    const current = currentDecision();
    let proposed: RecommendationDecision | null = null;
    const db = shadowDb(current);
    const report = await shadowRecommendations(db, {
      projectId: "p1",
      siteId: "s1",
      assessor: (async (packetValue: EvidencePacket) => {
        proposed = proposedDecision(packetValue);
        return { kind: "final" as const, attempts: 1, raw: null, decision: proposed };
      }) as never,
      ledger: new AnalysisLedger(),
    });
    expect(report.entries[0].status).toBe("changed");
    expect(report.entries[0].currentDecision?.reviews).toEqual([]);
    expect(report.entries[0].proposedDecision?.reviews[0]?.requirement).toBe("legal");
    expect(report.entries[0].currentProjection).not.toBeNull();
    expect(report.entries[0].currentPacket).not.toBeNull();
    expect(report.entries[0].proposedPacket).not.toBeNull();
    expect(report.entries[0].proposedProjection?.recommendationDecision.reviews[0]?.requirement).toBe("legal");
  });

  it("shows a rejected proposal for accepted work as changed and preserved", async () => {
    const current = currentDecision();
    let proposed: RecommendationDecision | null = null;
    const db = shadowDb(current, "accepted");
    const report = await shadowRecommendations(db, {
      projectId: "p1",
      siteId: "s1",
      assessor: (async (packetValue: EvidencePacket) => {
        proposed = proposedDecision(packetValue, {
          readiness: "rejected",
          intervention: "maintain",
          investigation: null,
          reviews: [],
          reasons: ["The premise is false."],
        });
        return { kind: "final" as const, attempts: 1, raw: null, decision: proposed };
      }) as never,
      ledger: new AnalysisLedger(),
    });
    expect(report.entries[0].status).toBe("changed");
    expect(report.entries[0].preservedHumanWork).toBe(true);
    expect(report.entries[0].reason).toContain("preserved");
  });
});
