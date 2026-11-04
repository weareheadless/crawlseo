import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPublicDocument } from "@/lib/crawler/engine";
import {
  finaliseDecision,
  sealPacket,
  validateDecision,
  type EvidencePacket,
  type ModelDecision,
} from "@/lib/recommendation/contracts";
import { AnalysisLedger } from "@/lib/recommendation/ledger";
import { expandEvidencePacket } from "@/lib/recommendation/packet";
import { assessFinding } from "@/lib/recommendation/run";

/**
 * Safety, accounting, replay and scope regressions.
 *
 * These use fake storage and injected reasoning. They prove mechanics, not SEO
 * judgement. No real network or model calls are made.
 */

const at = new Date("2026-11-04T00:00:00.000Z");

afterEach(() => {
  vi.unstubAllGlobals();
});

function model(over: Partial<ModelDecision> = {}): ModelDecision {
  return {
    question: {
      text: "What does the service cost?",
      audience: null,
      journeyStage: null,
      bases: [{ basis: "inferred_need", references: [], note: "An explicitly inferred buying question." }],
      state: "unverified",
      rationale: "A plausible buying question.",
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
    effort: { size: "unknown", rationale: "No work proposed.", uncertainty: [] },
    risks: [],
    reviews: [],
    success: { measure: "No work proposed.", instrumentation: "unknown", rationale: "No work proposed." },
    uncertainty: [],
    contradictions: [],
    reasons: ["No evidenced improvement."],
    ...over,
  };
}

function finding() {
  return {
    id: "f1",
    runId: "r1",
    type: "CONCERN",
    theme: "service cost",
    summary: "What does the service cost?",
    premise: "The service cost is not explained.",
    observedAt: at,
    sourceIds: ["s1"],
    dedupKey: "O13:service-cost",
    dimensions: { findingId: "f1", painPoint: "true", theme: "service cost" },
  };
}

function fixture(pageCount = 1) {
  const rows: Array<Record<string, unknown>> = [];
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    url: `https://site.test/service-${index}${pageCount > 1 ? "a".repeat(650) : ""}`,
    title: "Service",
    contentText: "A service with individually quoted scope and pricing.",
    contentHash: "stored",
    statusCode: 200,
    indexable: true,
  }));
  const db = {
    site: { findUnique: vi.fn(async () => ({ id: "s1", projectId: "p1", domain: "site.test" })) },
    siteProfile: { findUnique: vi.fn(async () => null) },
    businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
    businessKnowledgeRevision: { findFirst: vi.fn(async () => null) },
    crawl: { findFirst: vi.fn(async () => ({ id: "c1", pagesFound: pageCount, maxPages: 500, finishedAt: at })) },
    auditPage: { findMany: vi.fn(async () => pages) },
    researchSource: {
      findMany: vi.fn(async () => [
        { id: "s1", url: "https://source.test/q", title: "Cost question", provider: "community", excerpt: "What does this cost?", retrievedAt: at, language: "en" },
      ]),
    },
    researchFinding: { findUnique: vi.fn(async () => ({ ...finding(), evidenceSourceIds: ["s1"], createdAt: at })) },
    evidenceRecord: {
      findMany: vi.fn(async (args?: { where?: { kind?: unknown } }) =>
        args?.where?.kind === "research_finding" ? rows : []
      ),
      upsert: vi.fn(async (args: { create: Record<string, unknown> }) => {
        const row = { id: `e${rows.length + 1}`, ...args.create };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async () => ({})),
    },
    opportunity: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    evidenceEdge: { findMany: vi.fn(async () => []) },
    rawProviderResponse: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: "raw-1" })) },
  };
  return { db, rows };
}

describe("safe bounded retrieval", () => {
  it("refuses a redirect to a private destination before dispatching that hop", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: "https://private.test/secret" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      fetchPublicDocument("https://public.test/page", {
        resolve: async (hostname) => (hostname === "private.test" ? "127.0.0.1" : "93.184.216.34"),
      })
    ).rejects.toThrow(/private\/reserved IP/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops reading at the byte limit and reports truncation", async () => {
    const body = "a".repeat(5_000);
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/html" } })
    ));
    const doc = await fetchPublicDocument("https://public.test/page", {
      maxBytes: 1_024,
      resolve: async () => "93.184.216.34",
    });
    expect(doc.truncated).toBe(true);
    expect(doc.bytes).toBe(1_024);
  });
});

describe("analysis budget and convergence", () => {
  it("does not fetch when the ledger has no fetch budget", async () => {
    const { db } = fixture();
    const packet = sealPacket({
      projectId: "p1",
      siteId: "s1",
      policyVersion: "recommendation-policy/2",
      candidate: {
        findingId: "f1",
        findingType: "CONCERN",
        theme: "service cost",
        summary: "What does the service cost?",
        premise: null,
        observedAt: at.toISOString(),
        dedupKey: "O13:service-cost",
        sourceIds: ["s1"],
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
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const ledger = new AnalysisLedger();
    const result = await expandEvidencePacket(
      db as never,
      packet,
      [{ type: "page_text", target: "https://site.test/new", pageId: null, url: "https://site.test/new" }],
      {
        siteDomain: "site.test",
        maxLiveFetches: 0,
        beforeFetch: () => {
          if (!ledger.canFetch()) throw new Error("budget exhausted");
          ledger.chargeFetchAttempt();
        },
      }
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.packet.requests[0]?.status).toBe("budget_exhausted");
  });

  it("reuses an unchanged expanded decision without another reasoning call", async () => {
    const { db } = fixture();
    let calls = 0;
    const assessor = vi.fn(async (packet: EvidencePacket) => {
      calls += 1;
      if (calls % 2 === 1) {
        return {
          kind: "request" as const,
          attempts: 1,
          raw: null,
          rawAttempts: [{ kind: "request_evidence" }],
          request: {
            kind: "request_evidence" as const,
            requests: [
              {
                type: "source_text" as const,
                target: "source:s1",
                question: "Read the full source.",
                whyItMatters: "The snippet may omit context.",
              },
            ],
            rationale: "Need the full source.",
          },
        };
      }
      return {
        kind: "final" as const,
        attempts: 1,
        raw: null,
        rawAttempts: [{ kind: "final_decision" }],
        decision: finaliseDecision({ model: model(), packet, modelName: "fixture-model", promptVersion: "recommendation-prompt/2" }),
      };
    });

    const first = await assessFinding(db as never, {
      projectId: "p1",
      siteId: "s1",
      finding: finding(),
      assessor: assessor as never,
      ledger: new AnalysisLedger(),
    });
    const second = await assessFinding(db as never, {
      projectId: "p1",
      siteId: "s1",
      finding: finding(),
      assessor: assessor as never,
      ledger: new AnalysisLedger(),
    });

    expect(first.status).toBe("assessed");
    expect(second.status).toBe("reused");
    expect(assessor).toHaveBeenCalledTimes(2);
    expect(second.decision?.decisionId).toBe(first.decision?.decisionId);
  });

  it("records a failed reassessment without erasing the previous decision", async () => {
    const { db, rows } = fixture();
    const success = (async (packet: EvidencePacket) => ({
      kind: "final" as const,
      attempts: 1,
      raw: null,
      rawAttempts: [{ kind: "final_decision" }],
      decision: finaliseDecision({ model: model(), packet, modelName: "fixture-model", promptVersion: "recommendation-prompt/2" }),
    })) as never;
    const first = await assessFinding(db as never, {
      projectId: "p1",
      siteId: "s1",
      finding: finding(),
      assessor: success,
      ledger: new AnalysisLedger(),
    });
    expect(first.status).toBe("assessed");
    const decisionId = first.decision?.decisionId;

    const second = await assessFinding(db as never, {
      projectId: "p1",
      siteId: "s1",
      finding: finding(),
      force: true,
      assessor: (async () => ({ kind: "failure" as const, attempts: 1, raw: null, errors: ["model unavailable"] })) as never,
      ledger: new AnalysisLedger(),
    });
    expect(second.status).toBe("failed");
    expect(second.decision).toBeNull();
    expect(rows).toHaveLength(1);
    const stored = (rows[0]?.dimensions as Record<string, unknown>).recommendationDecisionJson as string;
    expect(JSON.parse(stored).decisionId).toBe(decisionId);
    expect(db.rawProviderResponse.create).toHaveBeenCalledTimes(1);
  });

  it("stops a repeated unavailable request instead of looping", async () => {
    const { db } = fixture();
    const assessor = vi.fn(async () => ({
      kind: "request" as const,
      attempts: 1,
      raw: null,
      rawAttempts: [{ kind: "request_evidence" }],
      request: {
        kind: "request_evidence" as const,
        requests: [
          {
            type: "source_text" as const,
            target: "source:s1",
            question: "Read the full source.",
            whyItMatters: "The snippet may omit context.",
          },
        ],
        rationale: "Need the full source.",
      },
    }));
    const result = await assessFinding(db as never, {
      projectId: "p1",
      siteId: "s1",
      finding: finding(),
      assessor: assessor as never,
      ledger: new AnalysisLedger(),
    });
    expect(result.status).toBe("failed");
    expect(result.errors.join(" ")).toContain("already attempted");
    expect(assessor.mock.calls.length).toBeLessThan(6);
  });

  it("charges every transport attempt before dispatch", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const { assessRecommendation } = await import("@/lib/recommendation/assess");
    const ledger = new AnalysisLedger();
    const packet = sealPacket({
      projectId: "p1",
      siteId: "s1",
      policyVersion: "recommendation-policy/2",
      candidate: {
        findingId: "f1",
        findingType: "CONCERN",
        theme: "service cost",
        summary: "What does the service cost?",
        premise: null,
        observedAt: at.toISOString(),
        dedupKey: "O13:service-cost",
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
    const outcome = await assessRecommendation(packet, { ledger, maxAttempts: 1 });
    expect(outcome.kind).toBe("failure");
    expect(ledger.snapshot().modelCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stores a complete parseable packet above the old 200k slice", async () => {
    const { db, rows } = fixture(500);
    const result = await assessFinding(db as never, {
      projectId: "p1",
      siteId: "s1",
      finding: finding(),
      assessor: (async (packet: EvidencePacket) => ({
        kind: "final" as const,
        attempts: 1,
        raw: null,
        rawAttempts: [{ kind: "final_decision" }],
        decision: finaliseDecision({ model: model(), packet, modelName: "fixture-model", promptVersion: "recommendation-prompt/2" }),
      })) as never,
      ledger: new AnalysisLedger(),
    });
    expect(result.status).toBe("assessed");
    const stored = (rows[0]?.dimensions as Record<string, unknown>).recommendationFinalPacketJson as string;
    expect(stored.length).toBeGreaterThan(200_000);
    expect(() => JSON.parse(stored)).not.toThrow();
    const attempts = (rows[0]?.dimensions as Record<string, unknown>).recommendationAttemptsJson as string;
    expect(JSON.parse(attempts)).toHaveLength(1);
  });
});

describe("scoped coverage", () => {
  function packetWithTruncatedPage(): EvidencePacket {
    return sealPacket({
      projectId: "p1",
      siteId: "s1",
      policyVersion: "recommendation-policy/2",
      candidate: {
        findingId: "f1",
        findingType: "CONCERN",
        theme: "service cost",
        summary: "What does the service cost?",
        premise: "The service cost is not explained.",
        observedAt: at.toISOString(),
        dedupKey: "O13:service-cost",
        sourceIds: ["s1"],
      },
      businessFacts: [
        {
          id: "fact:services",
          field: "services",
          value: "Service",
          sourceUrl: null,
          provenanceKind: "ai_observation",
          provenanceStatus: "assumed",
          publicationUse: "internal_only",
          documentRevision: 1,
        },
      ],
      context: { language: "en", audience: null, market: null, marketSource: null },
      sources: [],
      pages: [
        {
          id: "page:p1",
          url: "https://site.test/service",
          title: "Service",
          contentHash: "h1",
          text: "Short service introduction.",
          truncated: true,
          retrieval: "stored",
          status: 200,
          language: "en",
          inspected: 27,
          totalChars: 5_000,
          retrievalNote: null,
          sections: [{ id: "section:p1:0", locator: "chars:0-27", text: "Short service introduction." }],
        },
      ],
      links: [],
      requests: [],
      trace: [],
      inventory: [],
      search: [],
      limitations: [],
    });
  }

  it("rejects a whole-page absence claim from a truncated prefix", () => {
    const packet = packetWithTruncatedPage();
    const decision = finaliseDecision({
      model: model({
        readiness: "actionable",
        intervention: "update_page",
        change: "Add price guidance.",
        offerFit: { state: "supported", rationale: "Service fits.", references: ["fact:services"] },
        coverage: [
          { pageId: "page:p1", state: "does_not_answer", rationale: "No price in the prefix.", excerpts: [], limitations: [] },
        ],
        targets: [{ pageId: "page:p1", pageUrl: "https://site.test/service", sectionId: null, role: "update", rationale: "Add price." }],
        benefits: [
          { track: "customer_value", mechanism: "Budget clarity.", measurement: "unquantified", baselineReference: null, assumptions: [], uncertainty: ["Unmeasured."] },
        ],
      }),
      packet,
      modelName: "fixture-model",
      promptVersion: "recommendation-prompt/2",
    });
    const result = validateDecision(decision, packet);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("truncated section");
  });

  it("accepts a section-scoped negative assessment with a named inspected section", () => {
    const packet = packetWithTruncatedPage();
    const decision = finaliseDecision({
      model: model({
        readiness: "actionable",
        intervention: "update_page",
        change: "Add price guidance to the inspected introduction.",
        offerFit: { state: "supported", rationale: "Service fits.", references: ["fact:services"] },
        coverage: [
          {
            pageId: "page:p1",
            state: "does_not_answer",
            scope: "section",
            sectionIds: ["section:p1:0"],
            rationale: "The inspected introduction gives no price.",
            excerpts: [],
            limitations: ["Only the first section was supplied."],
          },
        ],
        targets: [{ pageId: "page:p1", pageUrl: "https://site.test/service", sectionId: "section:p1:0", role: "update", rationale: "Add price." }],
        benefits: [
          { track: "customer_value", mechanism: "Budget clarity.", measurement: "unquantified", baselineReference: null, assumptions: [], uncertainty: ["Unmeasured."] },
        ],
      }),
      packet,
      modelName: "fixture-model",
      promptVersion: "recommendation-prompt/2",
    });
    expect(validateDecision(decision, packet).ok).toBe(true);
  });
});
