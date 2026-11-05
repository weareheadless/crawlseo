import { describe, expect, it } from "vitest";

import { fallbackLane, parseOpportunityProposal } from "@/lib/funnel/proposal";
import { acceptOpportunityIntoTask, taskPlanFromOpportunity } from "@/lib/funnel/join";

const proposal = {
  schemaVersion: "phase3-v1",
  source: "phase3-topic-map",
  readiness: "actionable",
  lane: "content_business",
  kind: "update",
  title: "Renforcer le hub luminaires",
  summary: "The hub ranks but the subcategories are thin.",
  whyNow: "The lighting range has the most first-party demand.",
  evidenceRefs: ["ev-1", "ev-2"],
  target: { url: "/lampes", newAsset: false, section: "hub" },
  action: "Expand /lampes with buying guidance and internal links.",
  expectedOutcome: "Improve rankings for luminaire artisanal.",
  effort: "medium",
  confidence: "high",
  expiresAt: null,
  topicSlug: "luminaires",
  sources: [{ title: "Source", url: "https://example.com/source", publishedAt: null }],
  critique: { verdict: "keep", reason: "Grounded in the topic map." },
};

describe("phase 3 proposal parsing", () => {
  it("parses the minimal proposal contract and ignores other JSON", () => {
    expect(parseOpportunityProposal(proposal)).toMatchObject({
      lane: "content_business",
      kind: "update",
      target: { url: "/lampes", newAsset: false },
      action: proposal.action,
    });
    expect(parseOpportunityProposal({ foo: "bar" })).toBeNull();
    expect(parseOpportunityProposal({ ...proposal, schemaVersion: "v1" })).toBeNull();
  });

  it("falls back to a lane from the legacy dimension", () => {
    expect(fallbackLane("technical")).toBe("technical");
    expect(fallbackLane("aeo")).toBe("aeo_geo");
    expect(fallbackLane("content")).toBe("content_business");
  });

  it("turns the proposal into a task brief", () => {
    const plan = taskPlanFromOpportunity({
      title: proposal.title,
      summary: proposal.summary,
      scoreInputs: {},
      recommendationDecision: proposal,
    });
    expect(plan).toMatchObject({
      kind: "implementation",
      lane: "content_business",
      whyNow: proposal.whyNow,
      action: proposal.action,
      expectedOutcome: proposal.expectedOutcome,
      targetPages: ["/lampes"],
      successMeasure: proposal.expectedOutcome,
    });
  });
});

describe("phase 3 acceptance", () => {
  it("accepts a phase 3 proposal into a task with its brief", async () => {
    let captured: Record<string, unknown> | null = null;
    const db = {
      opportunity: {
        findUnique: async () => ({
          id: "opp-1",
          projectId: "proj-1",
          status: "detected",
          type: "O3_content_gap",
          title: proposal.title,
          summary: proposal.summary,
          scoreInputs: {},
          recommendationDecision: proposal,
          recommendationFingerprint: "fp-1",
        }),
        updateMany: async () => ({ count: 1 }),
      },
      task: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          captured = data;
          return { id: "task-1" };
        },
      },
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
    };

    const taskId = await acceptOpportunityIntoTask(db as never, "opp-1", {
      title: proposal.title,
      assignedTo: "owner@example.com",
      recommendationDecision: proposal,
      expectedProjectId: "proj-1",
      expectedDecisionId: null,
    });

    expect(taskId).toBe("task-1");
    const plan = (captured as { plan?: Record<string, unknown> } | null)?.plan;
    expect(plan).toMatchObject({
      kind: "implementation",
      lane: "content_business",
      whyNow: proposal.whyNow,
      action: proposal.action,
      targetPages: ["/lampes"],
      successMeasure: proposal.expectedOutcome,
    });
  });
});
