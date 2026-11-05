import { describe, expect, it, vi } from "vitest";

import {
  finaliseDecision,
  normaliseModelDecision,
  parseModelDecision,
  parseModelOutput,
  sealPacket,
  validateDecision,
  validateEvidenceRequest,
  type EvidencePacket,
  type ModelDecision,
} from "@/lib/recommendation/contracts";
import { relevantSections } from "@/lib/recommendation/packet";
import { assessFinding } from "@/lib/recommendation/run";
import { shadowRecommendations } from "@/lib/recommendation/shadow";
import { acceptOpportunityIntoTask } from "@/lib/funnel/join";
import { AnalysisLedger } from "@/lib/recommendation/ledger";

/**
 * Regressions for the structural review.
 *
 * Each case asserts the desired behaviour at the shared contract/service boundary,
 * not a successful reproduction of the old bug.
 */

function packet(over: Partial<EvidencePacket> = {}): EvidencePacket {
  const base = sealPacket({
    projectId: "p1",
    siteId: "s1",
    policyVersion: "recommendation-policy/2",
    candidate: {
      findingId: "f1",
      findingType: "CONCERN",
      theme: "fitted wardrobe cost",
      summary: "Customers ask what a fitted wardrobe costs.",
      premise: "The service page does not give a price.",
      observedAt: "2026-11-04T00:00:00.000Z",
      dedupKey: "O13:fitted-wardrobe-cost",
      sourceIds: ["s1"],
    },
    businessFacts: [
      {
        id: "fact:services",
        field: "services",
        value: "Fitted wardrobes",
        sourceUrl: "https://site.test/about",
        provenanceKind: "ai_observation",
        provenanceStatus: "assumed",
        publicationUse: "internal_only",
        documentRevision: 1,
      },
    ],
    context: { language: "en", audience: "homeowners", market: "United Kingdom", marketSource: "site_profile" },
    sources: [
      {
        id: "source:s1",
        url: "https://forum.test/cost",
        title: "What did you pay?",
        provider: "community",
        excerpt: "I could not find a price before booking.",
        observedAt: "2026-11-01T00:00:00.000Z",
        language: "en",
      },
    ],
    pages: [
      {
        id: "page:read",
        url: "https://site.test/services",
        title: "Fitted wardrobes",
        contentHash: "h1",
        text: "We make fitted wardrobes to measure for each room. Every project starts with a survey.",
        truncated: false,
        retrieval: "stored",
        status: 200,
        language: "en",
        inspected: 94,
        totalChars: 94,
        retrievalNote: null,
        sections: [
          {
            id: "section:read:0",
            locator: "chars:0-94",
            text: "We make fitted wardrobes to measure for each room. Every project starts with a survey.",
          },
        ],
      },
      {
        id: "page:unread",
        url: "https://site.test/pricing",
        title: "Pricing",
        contentHash: null,
        text: "",
        truncated: false,
        retrieval: "unavailable",
        status: 200,
        language: "en",
        inspected: 0,
        totalChars: 0,
        retrievalNote: "no stored page text",
        sections: [],
      },
    ],
    links: [],
    requests: [],
    trace: [],
    inventory: [
      { url: "https://site.test/services", title: "Fitted wardrobes", status: 200, indexable: true, retrieval: "stored" },
      { url: "https://site.test/pricing", title: "Pricing", status: 200, indexable: true, retrieval: "unavailable" },
    ],
    search: [],
    limitations: ["page text for https://site.test/pricing could not be retrieved"],
  });
  return { ...base, ...over };
}

function model(over: Partial<ModelDecision> = {}): ModelDecision {
  return {
    question: {
      text: "What does a fitted wardrobe cost?",
      audience: "homeowners",
      journeyStage: "consideration",
      bases: [{ basis: "observed_request", references: ["source:s1"], note: "A customer asks what they paid." }],
      state: "supported",
      rationale: "A customer explicitly asks for a price.",
    },
    premise: { state: "unverified", rationale: "The page does not state a price.", references: [] },
    offerFit: { state: "supported", rationale: "The business makes fitted wardrobes.", references: ["fact:services"] },
    coverage: [
      {
        pageId: "page:read",
        state: "does_not_answer",
        rationale: "It describes the service but not the cost.",
        excerpts: [],
        limitations: [],
      },
    ],
    readiness: "actionable",
    intervention: "update_page",
    change: "Add a typical price range and what the quotation includes.",
    assetJustification: null,
    investigation: null,
    targets: [
      { pageId: "page:read", pageUrl: "https://site.test/services", sectionId: null, role: "update", rationale: "The service page." },
    ],
    benefits: [
      {
        track: "customer_value",
        mechanism: "A homeowner can judge the budget before booking.",
        measurement: "unquantified",
        baselineReference: null,
        assumptions: [],
        uncertainty: ["demand is not measured"],
      },
    ],
    effort: { size: "small", rationale: "One section.", uncertainty: [] },
    risks: [],
    reviews: [],
    success: { measure: "A homeowner can state a typical range.", instrumentation: "unavailable", rationale: "No tracking." },
    uncertainty: ["demand is not measured"],
    contradictions: [],
    reasons: ["A specific existing-page improvement is justified."],
    ...over,
  };
}

function decide(p: EvidencePacket, m: ModelDecision) {
  return finaliseDecision({ model: m, packet: p, modelName: "fixture-model", promptVersion: "recommendation-prompt/2" });
}

describe("structural recommendation regressions", () => {
  it("rejects a no-answer claim about a page that was never read", () => {
    const p = packet();
    const decision = decide(
      p,
      model({
        coverage: [
          {
            pageId: "page:unread",
            state: "does_not_answer",
            rationale: "Assumed absent.",
            excerpts: [],
            limitations: [],
          },
        ],
        targets: [
          { pageId: "page:unread", pageUrl: "https://site.test/pricing", sectionId: null, role: "update", rationale: "Add a price." },
        ],
      })
    );
    const result = validateDecision(decision, p);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("no page text was inspected");
  });

  it("refuses an ambiguous readiness instead of coercing it", () => {
    const raw = { ...model(), readiness: "partial" };
    const parsed = parseModelDecision(raw);
    expect(parsed.ok).toBe(false);
    expect(normaliseModelDecision(raw)).toMatchObject({ readiness: "partial" });
  });

  it("requires an explicit target role instead of guessing one", () => {
    const raw = model();
    raw.targets = [{ ...raw.targets[0], role: undefined as never }];
    const parsed = parseModelDecision(raw);
    expect(parsed.ok).toBe(false);
  });

  it("rejects duplicate coverage rather than silently choosing one", () => {
    const p = packet();
    const decision = decide(
      p,
      model({
        coverage: [
          { pageId: "page:read", state: "does_not_answer", rationale: "No price.", excerpts: [], limitations: [] },
          {
            pageId: "page:read",
            state: "answers",
            rationale: "It answers.",
            excerpts: ["We make fitted wardrobes to measure for each room."],
            limitations: [],
          },
        ],
      })
    );
    const result = validateDecision(decision, p);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("more than once");
  });

  it("allows a distinct-intent asset only with an explicit justification", () => {
    const p = packet();
    const answered = {
      pageId: "page:read",
      state: "partially_answers" as const,
      rationale: "It covers made-to-measure but not small alcove projects.",
      excerpts: ["We make fitted wardrobes to measure for each room."],
      limitations: [],
    };
    const without = decide(p, model({ intervention: "create_asset", coverage: [answered], targets: [], change: "Create an alcove guide." }));
    expect(validateDecision(without, p).errors.join(" ")).toContain("assetJustification");

    const withJustification = decide(
      p,
      model({
        intervention: "create_asset",
        coverage: [answered],
        targets: [],
        change: "Create an alcove wardrobe guide.",
        assetJustification: {
          distinctIntent: "Small alcove and awkward-space wardrobes",
          whyExistingInsufficient: "The service page covers general fitted wardrobes, not alcove constraints.",
        },
      })
    );
    expect(validateDecision(withJustification, p).ok).toBe(true);
  });

  it("refuses an investigation that asks a person to inspect content already supplied", () => {
    const p = packet();
    const decision = decide(
      p,
      model({
        readiness: "needs_investigation",
        intervention: "investigate",
        change: null,
        targets: [],
        benefits: [],
        coverage: [],
        investigation: {
          kind: "owner_input",
          question: "Does the service page mention price?",
          inspect: ["page:read", "https://site.test/services"],
          decisionCriteria: ["the page states a price"],
          deliverable: "A note.",
        },
      })
    );
    const result = validateDecision(decision, p);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("already supplied");
  });

  it("keeps section offsets correct when the body contains repeated whitespace", () => {
    const text = `Header   with   gaps\n\nIntro paragraph.\n\n${"filler ".repeat(80)}Fitted wardrobes cost from 1200 pounds.`;
    const sections = relevantSections(text, ["wardrobes"], 400);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.some((section) => section.text.includes("Fitted wardrobes cost from 1200 pounds"))).toBe(true);
  });

  it("rejects evidence requests outside the site or for text already supplied in full", () => {
    const p = packet();
    const outside = validateEvidenceRequest(
      {
        kind: "request_evidence",
        requests: [{ type: "page_text", target: "https://other.example/page", question: "What?", whyItMatters: "It matters." }],
        rationale: "Need it.",
      },
      p,
      { siteDomain: "site.test", maxRequests: 4 }
    );
    expect(outside.ok).toBe(false);

    const already = validateEvidenceRequest(
      {
        kind: "request_evidence",
        requests: [{ type: "page_text", target: "page:read", question: "What?", whyItMatters: "It matters." }],
        rationale: "Need it.",
      },
      p,
      { siteDomain: "site.test", maxRequests: 4 }
    );
    expect(already.ok).toBe(false);
    expect(already.errors.join(" ")).toContain("already supplied in full");
  });

  it("parses an evidence request as analysis work, not a decision", () => {
    const parsed = parseModelOutput({
      kind: "request_evidence",
      requests: [
        {
          type: "journey_links",
          target: "page:read",
          question: "Can a visitor reach the quote page?",
          whyItMatters: "A journey fix would change the intervention.",
        },
      ],
      rationale: "The links were not supplied.",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.output.kind).toBe("request_evidence");
  });

  it("refuses a stale decision at acceptance and accepts the current one", async () => {
    const decision = decide(packet(), model());
    const store = new Map<string, Record<string, unknown>>([
      [
        "op1",
        {
          id: "op1",
          projectId: "p1",
          status: "detected",
          type: "O13_user_pain_point",
          title: "Fitted wardrobe cost",
          summary: "Customers ask what a fitted wardrobe costs.",
          scoreInputs: {},
          recommendationDecision: decision,
          recommendationFingerprint: "fp-1",
        },
      ],
    ]);
    const tasks: Array<Record<string, unknown>> = [];
    const db = {
      opportunity: {
        findUnique: vi.fn(async () => store.get("op1") ?? null),
        updateMany: vi.fn(async (args: { data: Record<string, unknown> }) => {
          Object.assign(store.get("op1")!, args.data);
          return { count: 1 };
        }),
      },
      task: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          tasks.push(args.data);
          return { id: `task-${tasks.length}` };
        }),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    };
    await expect(
      acceptOpportunityIntoTask(db as never, "op1", {
        title: "Update the page",
        assignedTo: "dana",
        expectedDecisionId: decision.decisionId,
        expectedProjectId: "p1",
        recommendationDecision: { ...decision, decisionId: "decision-stale" },
      })
    ).rejects.toThrow(/changed since this page was loaded/);

    const taskId = await acceptOpportunityIntoTask(db as never, "op1", {
      title: "Update the page",
      assignedTo: "dana",
      expectedDecisionId: decision.decisionId,
      expectedProjectId: "p1",
      recommendationDecision: decision,
    });
    expect(taskId).toBe("task-1");
    expect(tasks[0]).toMatchObject({ opportunityId: "op1", assignedTo: "dana" });
    expect((tasks[0].plan as { kind?: string }).kind).toBe("implementation");
  });

  it("produces a shadow report without writing published state", async () => {
    const db = {
      site: { findUnique: vi.fn(async () => ({ id: "s1", projectId: "p1", domain: "site.test" })) },
      siteProfile: { findUnique: vi.fn(async () => null) },
      businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
      businessKnowledgeRevision: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => ({ id: "c1", pagesFound: 1, maxPages: 100, finishedAt: new Date() })) },
      auditPage: { findMany: vi.fn(async () => []) },
      researchSource: { findMany: vi.fn(async () => []) },
      researchFinding: {
        findUnique: vi.fn(async () => ({
          id: "f1",
          runId: "r1",
          type: "CONCERN",
          theme: "fitted wardrobe cost",
          summary: "Customers ask what a fitted wardrobe costs.",
          evidenceSourceIds: [],
          createdAt: new Date("2026-11-04T00:00:00.000Z"),
        })),
      },
      evidenceRecord: {
        findMany: vi.fn(async (args?: { where?: { kind?: unknown } }) => {
          if (args?.where?.kind !== "research_finding") return [];
          return [
            {
              id: "e1",
              dimensions: { findingId: "f1", painPoint: "true", theme: "fitted wardrobe cost" },
              observedAt: new Date("2026-11-04T00:00:00.000Z"),
            },
          ];
        }),
        findUnique: vi.fn(async () => null),
      },
      opportunity: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      evidenceEdge: { findMany: vi.fn(async () => []) },
      rawProviderResponse: { findUnique: vi.fn(async () => null) },
    };
    const assessor = vi.fn(async (packet: EvidencePacket) => ({
      kind: "final" as const,
      attempts: 1,
      raw: null,
      decision: finaliseDecision({
        model: model({
          readiness: "rejected",
          intervention: "maintain",
          change: null,
          targets: [],
          benefits: [],
          coverage: [],
          question: {
            text: "What does a fitted wardrobe cost?",
            audience: "homeowners",
            journeyStage: "consideration",
            bases: [{ basis: "inferred_need", references: [], note: "The finding suggests a buying question." }],
            state: "unverified",
            rationale: "No direct customer source is stored.",
          },
          offerFit: { state: "unverified", rationale: "No fact was supplied.", references: [] },
          premise: { state: "unverified", rationale: "No checkable absence.", references: [] },
        }),
        packet,
        modelName: "fixture-model",
        promptVersion: "recommendation-prompt/2",
      }),
    }));
    const report = await shadowRecommendations(db as never, {
      projectId: "p1",
      siteId: "s1",
      assessor: assessor as never,
      ledger: new AnalysisLedger(),
    });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].proposedReadiness, report.entries[0].reason ?? "").toBe("rejected");
    expect(db.opportunity.update).not.toHaveBeenCalled();
    expect(db.opportunity.updateMany).not.toHaveBeenCalled();
  });

  it("runs request → retrieval → final decision through the shared service", async () => {
    const p = packet();
    const db = {
      site: { findUnique: vi.fn(async () => ({ id: "s1", projectId: "p1", domain: "site.test" })) },
      siteProfile: { findUnique: vi.fn(async () => null) },
      businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
      businessKnowledgeRevision: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => ({ id: "c1", pagesFound: 2, maxPages: 100, finishedAt: new Date() })) },
      auditPage: {
        findMany: vi.fn(async () => [
          { url: "https://site.test/services", title: "Fitted wardrobes", contentText: "We make fitted wardrobes to measure.", contentHash: "h1", statusCode: 200, indexable: true },
        ]),
      },
      researchSource: {
        findMany: vi.fn(async () => [
          { id: "s1", url: "https://forum.test/cost", title: "What did you pay?", provider: "community", excerpt: "I could not find a price.", retrievedAt: new Date(), language: "en" },
        ]),
      },
      evidenceRecord: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
      opportunity: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []), update: vi.fn(), updateMany: vi.fn() },
      evidenceEdge: { findMany: vi.fn(async () => []) },
      rawProviderResponse: { findUnique: vi.fn(async () => null) },
    };
    const assess = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "request",
        attempts: 1,
        raw: null,
        request: {
          kind: "request_evidence",
          requests: [
            {
              type: "source_text",
              target: "source:s1",
              question: "What exactly did the customer ask?",
              whyItMatters: "It establishes the need.",
            },
          ],
          rationale: "The excerpt is short.",
        },
      })
      .mockImplementationOnce(async (expanded: EvidencePacket) => {
        const page = expanded.pages[0];
        return {
          kind: "final" as const,
          attempts: 1,
          raw: null,
          decision: finaliseDecision({
            model: model({
              coverage: [
                {
                  pageId: page.id,
                  state: "does_not_answer",
                  rationale: "It describes the service but not the cost.",
                  excerpts: [],
                  limitations: [],
                },
              ],
              targets: [
                { pageId: page.id, pageUrl: page.url, sectionId: null, role: "update", rationale: "The service page." },
              ],
            }),
            packet: expanded,
            modelName: "fixture-model",
            promptVersion: "recommendation-prompt/2",
          }),
        };
      });

    const result = await assessFinding(db as never, {
      projectId: "p1",
      siteId: "s1",
      persist: false,
      force: true,
      assessor: assess as never,
      ledger: new AnalysisLedger(),
      businessFacts: [
        {
          id: "fact:services",
          field: "services",
          value: "Fitted wardrobes",
          sourceUrl: "https://site.test/about",
          provenanceKind: "ai_observation",
          provenanceStatus: "assumed",
          publicationUse: "internal_only",
          documentRevision: null,
        },
      ],
      finding: {
        id: "f1",
        runId: "r1",
        type: "CONCERN",
        theme: "fitted wardrobe cost",
        summary: "Customers ask what a fitted wardrobe costs.",
        premise: "The service page does not give a price.",
        observedAt: new Date("2026-11-04T00:00:00.000Z"),
        sourceIds: ["s1"],
        dedupKey: "O13:fitted-wardrobe-cost",
        dimensions: { painPoint: "true" },
      },
    });

    expect(assess).toHaveBeenCalledTimes(2);
    expect(result.status, result.errors.join("; ")).toBe("assessed");
    expect(result.decision?.readiness).toBe("actionable");
    expect(result.trace?.length).toBeGreaterThan(0);
    expect(result.packet?.limitations.join(" ")).toContain("only a stored excerpt");
    void p;
  });
});
