import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPublicDocument } from "@/lib/crawler/engine";
import {
  buildDependencyManifest,
  canonicalRequestKey,
  finaliseDecision,
  hashPacket,
  sealPacket,
  validateDecision,
  validateEvidenceRequest,
  type EvidencePacket,
  type ModelDecision,
} from "@/lib/recommendation/contracts";
import { AnalysisLedger } from "@/lib/recommendation/ledger";
import { buildEvidencePacket, expandEvidencePacket, retrievePage } from "@/lib/recommendation/packet";
import { assessFinding, findReusableDecision } from "@/lib/recommendation/run";

/**
 * Regressions for the `252df72` review.
 *
 * Fake storage, pinned fake transports and injected reasoning only. No real DNS,
 * network, model or database writes.
 */

const at = new Date("2026-11-04T00:00:00.000Z");
const publicResolve = async () => "93.184.216.34";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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
    offerFit: { state: "supported", rationale: "Relevant service.", references: ["fact:services"] },
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

function packet(opts: { pages?: number; text?: string; truncated?: boolean } = {}): EvidencePacket {
  const count = opts.pages ?? 1;
  const text = opts.text ?? "The introduction does not list documents.";
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
    sources: [
      {
        id: "source:s1",
        url: "https://source.test/q",
        title: "Question",
        provider: "community",
        excerpt: "Which documents?",
        observedAt: at.toISOString(),
        language: "en",
      },
    ],
    pages: Array.from({ length: count }, (_, index) => ({
      id: `page:${index}`,
      url: `https://site.test/p${index}`,
      title: "Page",
      contentHash: "stored",
      text,
      truncated: opts.truncated ?? true,
      retrieval: "stored" as const,
      status: 200,
      language: "en",
      inspected: text.length,
      totalChars: 5_000,
      offset: 0,
      retrievalNote: null,
      truncation: opts.truncated ? ("sectioned" as const) : ("none" as const),
      sections: [{ id: `section:${index}`, locator: `chars:0-${text.length}`, text }],
    })),
    links: [],
    requests: [],
    trace: [],
    inventory: [],
    search: [],
    limitations: [],
  });
}

function reuseDb(over: Partial<Record<string, unknown>> = {}) {
  return {
    crawl: { findFirst: vi.fn(async () => ({ id: "c1" })) },
    auditPage: { findMany: vi.fn(async () => []) },
    researchSource: {
      findMany: vi.fn(async () => [{ id: "s1", excerpt: "Which documents?", retrievedAt: at }]),
    },
    businessKnowledgeDocument: {
      findUnique: vi.fn(async () => ({ id: "doc", revision: 1, acceptedRevision: 1 })),
    },
    businessKnowledgeRevision: { findFirst: vi.fn(async () => null) },
    evidenceRecord: { findMany: vi.fn(async () => []) },
    ...over,
  } as never;
}

function expandDb(over: Partial<Record<string, unknown>> = {}) {
  return {
    site: { findUnique: vi.fn(async () => ({ domain: "site.test" })) },
    auditPage: { findFirst: vi.fn(async () => null) },
    ...over,
  } as never;
}

function reusableDimensions(p: EvidencePacket, decision = finaliseDecision({ model: model(), packet: p, modelName: "offline", promptVersion: "recommendation-prompt/2" })) {
  return {
    recommendationDecisionJson: JSON.stringify(decision),
    recommendationInitialPacketHash: p.packetHash,
    recommendationFinalPacketJson: JSON.stringify(p),
    recommendationDependenciesJson: JSON.stringify(buildDependencyManifest(p)),
  };
}

describe("retrieval safety", () => {
  it("refuses an off-origin redirect before the second hop is dispatched", async () => {
    const calls: string[] = [];
    const result = await retrievePage("https://site.test/start", "site.test", {
      resolve: publicResolve,
      transport: async (url) => {
        calls.push(url);
        if (calls.length === 1) {
          return new Response(null, { status: 302, headers: { location: "https://outside.test/page" } });
        }
        return new Response("<p>Readable body. </p>", { headers: { "content-type": "text/html" } });
      },
    });
    expect(calls).toEqual(["https://site.test/start"]);
    expect(result.retrieval).toBe("unavailable");
    expect(result.note).toMatch(/outside the authorised origin/);
  });

  it("refuses a reserved address through the recommendation retrieval boundary", async () => {
    const transport = vi.fn(async () => new Response("body", { headers: { "content-type": "text/html" } }));
    const result = await retrievePage("https://site.test/page", "site.test", {
      resolve: async () => "100.64.1.2",
      transport,
    });
    expect(result.retrieval).toBe("unavailable");
    expect(result.note).toMatch(/private\/reserved IP/);
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses shared, documentation, mapped and multicast addresses before dispatch", async () => {
    for (const address of ["100.64.1.2", "198.18.0.1", "192.0.2.1", "::ffff:127.0.0.1", "ff02::1", "2001:db8::1"]) {
      const transport = vi.fn(async () => new Response("public", { headers: { "content-type": "text/html" } }));
      await expect(
        fetchPublicDocument("https://public.test/page", { resolve: async () => address, transport })
      ).rejects.toThrow(/private\/reserved IP/);
      expect(transport).not.toHaveBeenCalled();
    }
  });
});

describe("replay integrity", () => {
  it("refuses an archived packet whose content no longer matches its hash", async () => {
    const p = packet();
    const dimensions = reusableDimensions(p);
    const altered = structuredClone(p);
    altered.pages[0].text = "The archived contents changed without updating their hash.";
    expect(hashPacket(altered)).not.toBe(altered.packetHash);
    dimensions.recommendationFinalPacketJson = JSON.stringify(altered);
    await expect(findReusableDecision(reuseDb(), dimensions, p, "offline")).resolves.toBeNull();
  });

  it("refuses an archive without the initial identity or with another candidate", async () => {
    const p = packet();
    const dimensions = reusableDimensions(p);
    const withoutInitial = { ...dimensions, recommendationInitialPacketHash: undefined };
    await expect(findReusableDecision(reuseDb(), withoutInitial, p, "offline")).resolves.toBeNull();

    const other = packet();
    other.projectId = "other-project";
    other.siteId = "other-site";
    other.candidate.findingId = "other-finding";
    await expect(findReusableDecision(reuseDb(), dimensions, other, "offline")).resolves.toBeNull();
  });

  it("refuses reuse when a stored dependency changed and allows it when unchanged", async () => {
    const p = packet();
    const dimensions = reusableDimensions(p);
    const unchanged = reuseDb({
      auditPage: {
        findMany: vi.fn(async () => [{ url: "https://site.test/p0", contentHash: "stored", contentText: null }]),
      },
    });
    await expect(findReusableDecision(unchanged, dimensions, p, "offline")).resolves.toMatchObject({
      decision: { packetHash: p.packetHash },
      packet: { packetHash: p.packetHash },
    });

    const changed = reuseDb({
      auditPage: {
        findMany: vi.fn(async () => [{ url: "https://site.test/p0", contentHash: "changed", contentText: null }]),
      },
    });
    await expect(findReusableDecision(changed, dimensions, p, "offline")).resolves.toBeNull();
  });

  it("refuses reuse when a source excerpt changed", async () => {
    const p = packet();
    const dimensions = reusableDimensions(p);
    const db = reuseDb({
      auditPage: {
        findMany: vi.fn(async () => [{ url: "https://site.test/p0", contentHash: "stored", contentText: null }]),
      },
      researchSource: {
        findMany: vi.fn(async () => [{ id: "s1", excerpt: "A different excerpt.", retrievedAt: at }]),
      },
    });
    await expect(findReusableDecision(db, dimensions, p, "offline")).resolves.toBeNull();
  });

  it("returns the archived final packet with the reused decision", async () => {
    const p = packet();
    const expanded = sealPacket({
      ...p,
      pages: p.pages.map((page) => ({ ...page, text: `${page.text} More evidence.`, inspected: page.text.length + 15, truncated: false, truncation: "none" as const })),
    });
    const decision = finaliseDecision({ model: model(), packet: expanded, modelName: "offline", promptVersion: "recommendation-prompt/2" });
    const dimensions = {
      recommendationDecisionJson: JSON.stringify(decision),
      recommendationInitialPacketHash: p.packetHash,
      recommendationFinalPacketJson: JSON.stringify(expanded),
      recommendationDependenciesJson: JSON.stringify(buildDependencyManifest(expanded)),
    };
    const db = reuseDb({
      auditPage: {
        findMany: vi.fn(async () => [{ url: "https://site.test/p0", contentHash: "stored", contentText: null }]),
      },
    });
    const result = await findReusableDecision(db, dimensions, p, "offline");
    expect(result?.decision.decisionId).toBe(decision.decisionId);
    expect(result?.packet.packetHash).toBe(expanded.packetHash);
  });
});

describe("truncation, capacity and progress", () => {
  it("propagates a transport byte cap into the final packet and does not call it fulfilled", async () => {
    const result = await expandEvidencePacket(
      expandDb(),
      packet({ pages: 0 }),
      [
        {
          type: "page_text",
          target: "https://site.test/large",
          pageId: null,
          url: "https://site.test/large",
          offset: null,
          key: canonicalRequestKey("page_text", "https://site.test/large", { url: "https://site.test/large" }),
        },
      ],
      {
        siteDomain: "site.test",
        resolve: publicResolve,
        transport: async () =>
          new Response(
            `<p>${"Useful text. ".repeat(30)}</p><script>${"x".repeat(2 * 1024 * 1024 + 100)}</script><p>The missing answer is after this script.</p>`,
            { headers: { "content-type": "text/html" } }
          ),
      }
    );
    const page = result.packet.pages[0];
    expect(page.truncated).toBe(true);
    expect(page.truncation).toBe("byte_limit");
    expect(page.retrievalNote).toMatch(/byte limit/);
    expect(result.packet.requests[0]?.status).toBe("partial");
  });

  it("reports packet capacity instead of claiming a new page was supplied", async () => {
    const result = await expandEvidencePacket(
      expandDb(),
      packet({ pages: 10 }),
      [
        {
          type: "page_text",
          target: "https://site.test/eleventh",
          pageId: null,
          url: "https://site.test/eleventh",
          offset: null,
          key: canonicalRequestKey("page_text", "https://site.test/eleventh", { url: "https://site.test/eleventh" }),
        },
      ],
      {
        siteDomain: "site.test",
        resolve: publicResolve,
        transport: async () => new Response(`<p>${"Read text. ".repeat(30)}</p>`, { headers: { "content-type": "text/html" } }),
      }
    );
    expect(result.packet.pages.some((page) => page.url.endsWith("/eleventh"))).toBe(false);
    expect(result.packet.requests[0]?.status).toBe("unavailable");
    expect(result.packet.requests[0]?.detail).toMatch(/capacity/);
    expect(result.progress).toBe(false);
  });

  it("continues a long page from the unread offset and then stops", async () => {
    const request = {
      type: "page_text" as const,
      target: "https://site.test/long",
      pageId: null,
      url: "https://site.test/long",
      offset: null,
      key: canonicalRequestKey("page_text", "https://site.test/long", { url: "https://site.test/long" }),
    };
    const transport = async () =>
      new Response(`<p>${"x".repeat(25_000)}</p>`, { headers: { "content-type": "text/html" } });
    const first = await expandEvidencePacket(expandDb(), packet({ pages: 0 }), [request], {
      siteDomain: "site.test",
      resolve: publicResolve,
      transport,
    });
    expect(first.packet.pages[0]?.text.length).toBe(20_000);
    expect(first.packet.pages[0]?.truncated).toBe(true);
    expect(first.packet.requests[0]?.status).toBe("partial");
    expect(first.progress).toBe(true);

    const repeat = validateEvidenceRequest(
      {
        kind: "request_evidence",
        requests: [{ type: "page_text", target: request.url, question: "Read the rest.", whyItMatters: "The answer may be later." }],
        rationale: "Need the rest.",
      },
      first.packet,
      { siteDomain: "site.test" }
    );
    expect(repeat.ok).toBe(true);

    const second = await expandEvidencePacket(expandDb(), first.packet, [request], {
      siteDomain: "site.test",
      resolve: publicResolve,
      transport,
    });
    expect(second.packet.pages[0]?.text.length).toBe(25_002);
    expect(second.packet.pages[0]?.truncated).toBe(false);
    expect(second.packet.requests[1]?.status).toBe("fulfilled");
    expect(second.progress).toBe(true);

    const third = validateEvidenceRequest(
      {
        kind: "request_evidence",
        requests: [{ type: "page_text", target: request.url, question: "Read again.", whyItMatters: "No reason." }],
        rationale: "Again.",
      },
      second.packet,
      { siteDomain: "site.test" }
    );
    expect(third.ok).toBe(false);
    expect(third.errors.join(" ")).toMatch(/already supplied in full/);
  });
});

describe("budget enforcement", () => {
  it("never reads above the remaining aggregate byte allowance", async () => {
    const ledger = new AnalysisLedger({ ...new AnalysisLedger().policy, maxTotalBytes: 1_024 });
    ledger.chargeBytes(1_000);
    expect(ledger.remainingBytes()).toBe(24);
    expect(ledger.canFetch()).toBe(true);

    const result = await expandEvidencePacket(
      expandDb(),
      packet({ pages: 0 }),
      [
        {
          type: "page_text",
          target: "https://site.test/large",
          pageId: null,
          url: "https://site.test/large",
          offset: null,
          key: canonicalRequestKey("page_text", "https://site.test/large", { url: "https://site.test/large" }),
        },
      ],
      {
        siteDomain: "site.test",
        resolve: publicResolve,
        transport: async () => new Response(`<p>${"x".repeat(5_000)}</p>`, { headers: { "content-type": "text/html" } }),
        remainingBytes: () => ledger.remainingBytes(),
        onBytes: (bytes) => ledger.chargeBytes(bytes),
        beforeFetch: () => {
          if (!ledger.canFetch()) throw new Error("budget exhausted");
          ledger.chargeFetchAttempt();
        },
      }
    );
    expect(ledger.snapshot().bytesFetched).toBeLessThanOrEqual(1_024);
    expect(ledger.canFetch()).toBe(false);
    expect(result.packet.requests[0]?.status).toBe("unavailable");
  });

  it("rejects a zero-byte or expired retrieval before dispatch", async () => {
    const transport = vi.fn(async () => new Response("body", { headers: { "content-type": "text/html" } }));
    await expect(
      fetchPublicDocument("https://public.test/page", { maxBytes: 0, resolve: publicResolve, transport })
    ).rejects.toThrow(/no byte allowance/);
    await expect(
      fetchPublicDocument("https://public.test/page", { deadlineAt: Date.now() - 1, resolve: publicResolve, transport })
    ).rejects.toThrow(/deadline/);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("scoped evidence integrity", () => {
  function sectionPacket() {
    return packet({ truncated: true });
  }

  it("rejects a target section that was not supplied", () => {
    const p = sectionPacket();
    const decision = finaliseDecision({
      model: model({
        readiness: "actionable",
        intervention: "update_page",
        change: "Change a different section.",
        coverage: [
          {
            pageId: "page:0",
            state: "does_not_answer",
            scope: "section",
            sectionIds: ["section:0"],
            rationale: "The introduction has no list.",
            excerpts: [],
            limitations: [],
          },
        ],
        targets: [{ pageId: "page:0", pageUrl: p.pages[0].url, sectionId: "section:never-supplied", role: "update", rationale: "Change it." }],
        benefits: [
          { track: "customer_value", mechanism: "Clarity.", measurement: "unquantified", baselineReference: null, assumptions: [], uncertainty: ["Unmeasured."] },
        ],
      }),
      packet: p,
      modelName: "offline",
      promptVersion: "recommendation-prompt/2",
    });
    const result = validateDecision(decision, p);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/not in the supplied text/);
  });

  it("rejects a whole-page change from a section-scoped assessment", () => {
    const p = sectionPacket();
    const decision = finaliseDecision({
      model: model({
        readiness: "actionable",
        intervention: "update_page",
        change: "Change the whole page.",
        coverage: [
          {
            pageId: "page:0",
            state: "does_not_answer",
            scope: "section",
            sectionIds: ["section:0"],
            rationale: "The introduction has no list.",
            excerpts: [],
            limitations: [],
          },
        ],
        targets: [{ pageId: "page:0", pageUrl: p.pages[0].url, sectionId: null, role: "update", rationale: "Change it." }],
        benefits: [
          { track: "customer_value", mechanism: "Clarity.", measurement: "unquantified", baselineReference: null, assumptions: [], uncertainty: ["Unmeasured."] },
        ],
      }),
      packet: p,
      modelName: "offline",
      promptVersion: "recommendation-prompt/2",
    });
    expect(validateDecision(decision, p).errors.join(" ")).toMatch(/cannot authorise a whole-page change/);
  });

  it("does not classify an external investigation by a URL inside prose", () => {
    const p = packet();
    const external = finaliseDecision({
      model: model({
        readiness: "needs_investigation",
        intervention: "investigate",
        change: null,
        investigation: {
          kind: "owner_input",
          question: "What does the owner's private ledger require?",
          inspect: ["Ask the owner to confirm the private ledger (the public page https://site.test/p0 is not the source)."],
          decisionCriteria: ["The owner confirms the private requirement."],
          deliverable: "A confirmed private list.",
        },
      }),
      packet: p,
      modelName: "offline",
      promptVersion: "recommendation-prompt/2",
    });
    expect(validateDecision(external, p).ok).toBe(true);

    const supplied = finaliseDecision({
      model: model({
        readiness: "needs_investigation",
        intervention: "investigate",
        change: null,
        investigation: {
          kind: "owner_input",
          question: "What does the page say?",
          inspect: ["page:0"],
          decisionCriteria: ["The page states it."],
          deliverable: "A note.",
        },
      }),
      packet: p,
      modelName: "offline",
      promptVersion: "recommendation-prompt/2",
    });
    expect(validateDecision(supplied, p).errors.join(" ")).toMatch(/already supplied/);
  });
});

describe("attempt archival", () => {
  it("records a transport failure with its response text and input packet", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    const fetchMock = vi.fn(async () => new Response("provider rejected the request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const { assessRecommendation } = await import("@/lib/recommendation/assess");
    const ledger = new AnalysisLedger();
    const outcome = await assessRecommendation(packet({ pages: 0 }), { ledger, maxAttempts: 1 });
    expect(outcome.kind).toBe("failure");
    expect(outcome.history?.length).toBeGreaterThan(0);
    const attempt = outcome.history?.[0];
    expect(attempt?.kind).toBe("transport_error");
    expect(attempt?.inputPacketHash).toBeTruthy();
    expect(attempt?.responseText).toContain("provider rejected");
    expect(ledger.snapshot().modelCalls).toBe(1);
  });
});

describe("fair reassessment order", () => {
  it("moves a recently failed candidate behind one that has not had a turn", async () => {
    const { reassessProjectRecommendations } = await import("@/lib/recommendation/reassess");
    const rows = [
      {
        id: "e1",
        observedAt: at,
        dimensions: { findingId: "a", painPoint: "true", theme: "A", recommendationDedupKey: "O13:a" },
      },
      {
        id: "e2",
        observedAt: new Date(at.getTime() + 1_000),
        dimensions: { findingId: "b", painPoint: "true", theme: "B", recommendationDedupKey: "O13:b" },
      },
    ];
    const db = {
      site: { findUnique: vi.fn(async () => ({ id: "s1", projectId: "p1", domain: "site.test" })) },
      siteProfile: { findUnique: vi.fn(async () => null) },
      businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
      businessKnowledgeRevision: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => null) },
      auditPage: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      researchSource: { findMany: vi.fn(async () => []) },
      researchFinding: {
        findUnique: vi.fn(async (args: { where: { id: string } }) => ({
          id: args.where.id,
          runId: "r1",
          type: "CONCERN",
          theme: args.where.id,
          summary: args.where.id,
          evidenceSourceIds: [],
          createdAt: at,
        })),
      },
      evidenceRecord: {
        findMany: vi.fn(async (args?: { where?: { kind?: unknown } }) =>
          args?.where?.kind === "research_finding" ? rows : []
        ),
      },
      opportunity: { findMany: vi.fn(async () => []) },
      rawProviderResponse: {
        findMany: vi.fn(async () => [
          {
            payload: {
              projectId: "p1",
              siteId: "s1",
              findingId: "a",
              attemptedAt: new Date().toISOString(),
              outcome: "failed",
            },
          },
        ]),
        create: vi.fn(async () => ({ id: "progress-1" })),
      },
    } as never;
    const result = await reassessProjectRecommendations(db, {
      projectId: "p1",
      siteId: "s1",
      dryRun: true,
    });
    expect(result.outcomes.map((outcome) => outcome.findingId)).toEqual(["b", "a"]);
  });
});

describe("stored text and journey progress", () => {
  it("uses complete stored crawl text before any live fetch", async () => {
    const storedText = "Stored service text. ".repeat(500);
    const transport = vi.fn(async () => new Response("<p>live</p>", { headers: { "content-type": "text/html" } }));
    const result = await expandEvidencePacket(
      expandDb({
        auditPage: {
          findFirst: vi.fn(async () => ({
            contentText: storedText,
            title: "Stored",
            contentHash: "stored-full",
            statusCode: 200,
          })),
        },
      }),
      packet({ pages: 1 }),
      [
        {
          type: "page_text",
          target: "page:0",
          pageId: "page:0",
          url: "https://site.test/p0",
          offset: null,
          key: canonicalRequestKey("page_text", "page:0", { pageId: "page:0" }),
        },
      ],
      { siteDomain: "site.test", resolve: publicResolve, transport }
    );
    expect(transport).not.toHaveBeenCalled();
    expect(result.packet.pages[0]?.text).toContain("Stored service text.");
    expect(result.packet.pages[0]?.retrieval).toBe("stored");
    expect(result.packet.requests[0]?.status).toBe("fulfilled");
    expect(result.progress).toBe(true);
  });

  it("reports no progress when journey inspection adds no new anchor", async () => {
    const p = packet();
    const withLink = sealPacket({
      ...p,
      links: [{ fromPageId: "page:0", toUrl: "https://site.test/contact", anchor: "Contact", observation: "observed", status: null }],
    });
    const result = await expandEvidencePacket(
      expandDb(),
      withLink,
      [
        {
          type: "journey_links",
          target: "page:0",
          pageId: "page:0",
          url: "https://site.test/p0",
          offset: null,
          key: canonicalRequestKey("journey_links", "page:0", { pageId: "page:0" }),
        },
      ],
      {
        siteDomain: "site.test",
        resolve: publicResolve,
        transport: async () =>
          new Response(
            `<p>${"Page text for navigation. ".repeat(10)}</p><a href="https://site.test/contact">Contact</a>`,
            { headers: { "content-type": "text/html" } }
          ),
      }
    );
    expect(result.packet.requests[0]?.status).toBe("no_progress");
    expect(result.progress).toBe(false);
  });
});

describe("queue deadline", () => {
  it("does not dispatch a queued model request after its deadline", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    const { chatJson } = await import("@/lib/ai/chat");
    const config = { apiKey: "test-key", baseUrl: "https://llm.test/v1", model: "test-model" };
    const first = chatJson({ config, system: "s", user: "u", attempts: 1 });
    const second = chatJson({ config, system: "s", user: "u", attempts: 1, deadlineAt: Date.now() + 5 });
    const results = await Promise.allSettled([first, second]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
    expect(calls).toBe(1);
  });
});

describe("failed reassessment archive", () => {
  it("archives the failed packet, attempts, requests and dependencies without erasing the decision", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const finding = {
      id: "f1",
      runId: "r1",
      type: "CONCERN",
      theme: "documents",
      summary: "Which documents?",
      premise: "The page does not list documents.",
      observedAt: at,
      sourceIds: ["s1"],
      dedupKey: "O13:documents",
      dimensions: { findingId: "f1", painPoint: "true", theme: "documents" },
    };
    const db = {
      site: { findUnique: vi.fn(async () => ({ id: "s1", projectId: "p1", domain: "site.test" })) },
      siteProfile: { findUnique: vi.fn(async () => null) },
      businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
      businessKnowledgeRevision: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => ({ id: "c1", pagesFound: 1, maxPages: 500, finishedAt: at })) },
      auditPage: {
        findMany: vi.fn(async () => [
          { url: "https://site.test/p0", title: "Page", contentText: "The introduction does not list documents.", contentHash: "stored", statusCode: 200, indexable: true },
        ]),
        findFirst: vi.fn(async () => null),
      },
      researchSource: {
        findMany: vi.fn(async () => [
          { id: "s1", url: "https://source.test/q", title: "Question", provider: "community", excerpt: "Which documents?", retrievedAt: at, language: "en" },
        ]),
      },
      researchFinding: { findUnique: vi.fn(async () => ({ ...finding, evidenceSourceIds: ["s1"], createdAt: at })) },
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
      opportunity: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []), update: vi.fn(), updateMany: vi.fn() },
      evidenceEdge: { findMany: vi.fn(async () => []) },
      rawProviderResponse: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ id: "raw-1" })) },
    } as never;

    const success = (async (p: EvidencePacket) => ({
      kind: "final" as const,
      attempts: 1,
      raw: { kind: "final_decision" },
      history: [{ round: 0, attempt: 1, inputPacketHash: p.packetHash, feedback: null, kind: "final_decision" as const, raw: { kind: "final_decision" }, responseText: null, errors: [] }],
      decision: finaliseDecision({
        model: model({ offerFit: { state: "unverified", rationale: "No business fact was supplied.", references: [] } }),
        packet: p,
        modelName: "fixture-model",
        promptVersion: "recommendation-prompt/2",
      }),
    })) as never;
    const first = await assessFinding(db, { projectId: "p1", siteId: "s1", finding, assessor: success, ledger: new AnalysisLedger() });
    expect(first.status).toBe("assessed");

    const failed = await assessFinding(db, {
      projectId: "p1",
      siteId: "s1",
      finding,
      force: true,
      ledger: new AnalysisLedger(),
      assessor: (async (p: EvidencePacket) => ({
        kind: "failure" as const,
        attempts: 1,
        raw: null,
        errors: ["provider unavailable"],
        history: [{ round: 0, attempt: 1, inputPacketHash: p.packetHash, feedback: null, kind: "transport_error" as const, raw: null, responseText: "HTTP 503", errors: ["provider unavailable"] }],
      })) as never,
    });
    expect(failed.status).toBe("failed");
    expect(rows).toHaveLength(1);
    expect((rows[0]?.dimensions as Record<string, unknown>).recommendationDecisionJson).toBeTruthy();
    const payload = (db as { rawProviderResponse: { create: ReturnType<typeof vi.fn> } }).rawProviderResponse.create.mock.calls[0][0].data.payload;
    expect(payload.packetJson).toContain("evidence-packet/2");
    expect(payload.dependenciesJson).toContain("dependency-manifest/1");
    expect(payload.attempts).toHaveLength(1);
    expect(payload.attempts[0].responseText).toBe("HTTP 503");
    expect(payload.requests).toBeDefined();

    const create = (db as unknown as { rawProviderResponse: { create: ReturnType<typeof vi.fn> } }).rawProviderResponse.create;
    create.mockRejectedValueOnce(new Error("archive database unavailable"));
    const archiveFailed = await assessFinding(db, {
      projectId: "p1",
      siteId: "s1",
      finding,
      force: true,
      ledger: new AnalysisLedger(),
      assessor: (async (p: EvidencePacket) => ({
        kind: "failure" as const,
        attempts: 1,
        raw: null,
        errors: ["provider unavailable"],
        history: [{ round: 0, attempt: 1, inputPacketHash: p.packetHash, feedback: null, kind: "transport_error" as const, raw: null, responseText: "HTTP 503", errors: ["provider unavailable"] }],
      })) as never,
    });
    expect(archiveFailed.status).toBe("failed");
    expect(archiveFailed.errors.join(" ")).toContain("archive could not be written");
  });
});

describe("remaining review coverage", () => {
  function matchingReuseDb(over: Partial<Record<string, unknown>> = {}) {
    return reuseDb({
      auditPage: {
        findMany: vi.fn(async () => [{ url: "https://site.test/p0", contentHash: "stored", contentText: null }]),
      },
      ...over,
    });
  }

  it("propagates the 120k extracted-text cap as text_limit and rejects whole-page absence", async () => {
    const db = {
      site: { findUnique: vi.fn(async () => ({ id: "s1", projectId: "p1", domain: "site.test" })) },
      siteProfile: { findUnique: vi.fn(async () => null) },
      businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
      businessKnowledgeRevision: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => ({ id: "c1", pagesFound: 1, maxPages: 500, finishedAt: at })) },
      auditPage: {
        findMany: vi.fn(async () => [
          { url: "https://site.test/huge", title: "Huge", contentText: null, contentHash: null, statusCode: 200, indexable: true },
        ]),
      },
      researchSource: { findMany: vi.fn(async () => []) },
      evidenceRecord: { findMany: vi.fn(async () => []) },
    } as never;
    const p = await buildEvidencePacket(db, {
      projectId: "p1",
      siteId: "s1",
      maxLiveFetches: 1,
      maxCharsPerPage: 8_000,
      resolve: publicResolve,
      transport: async () =>
        new Response(`<p>${"y".repeat(130_000)}</p>`, { headers: { "content-type": "text/html" } }),
      candidate: {
        findingId: "f1",
        dedupKey: "O13:documents",
        findingType: "CONCERN",
        theme: "documents",
        summary: "Which documents?",
        premise: null,
        observedAt: at,
        sourceIds: [],
      },
    });
    const page = p.pages[0];
    expect(page.text.length).toBe(8_000);
    expect(page.truncated).toBe(true);
    expect(page.truncation).toBe("text_limit");
    expect(page.retrievalNote).toMatch(/live-text limit/);

    const decision = finaliseDecision({
      model: model({
        readiness: "actionable",
        intervention: "update_page",
        change: "Add the missing answer.",
        coverage: [
          { pageId: page.id, state: "does_not_answer", rationale: "The prefix does not answer.", excerpts: [], limitations: [] },
        ],
        targets: [{ pageId: page.id, pageUrl: page.url, sectionId: null, role: "update", rationale: "Change it." }],
        benefits: [
          { track: "customer_value", mechanism: "Clarity.", measurement: "unquantified", baselineReference: null, assumptions: [], uncertainty: ["Unmeasured."] },
        ],
      }),
      packet: p,
      modelName: "offline",
      promptVersion: "recommendation-prompt/2",
    });
    expect(validateDecision(decision, p).errors.join(" ")).toMatch(/truncated section/);
  });

  it("refuses reuse when business knowledge, search evidence, a source timestamp or a live page is stale", async () => {
    const p = packet();
    const dimensions = reusableDimensions(p);

    await expect(
      findReusableDecision(
        matchingReuseDb({
          businessKnowledgeDocument: { findUnique: vi.fn(async () => ({ id: "doc", revision: 2, acceptedRevision: 2 })) },
        }),
        dimensions,
        p,
        "offline"
      )
    ).resolves.toBeNull();

    await expect(
      findReusableDecision(
        matchingReuseDb({
          researchSource: {
            findMany: vi.fn(async () => [{ id: "s1", excerpt: "Which documents?", retrievedAt: new Date(at.getTime() + 1_000) }]),
          },
        }),
        dimensions,
        p,
        "offline"
      )
    ).resolves.toBeNull();

    const searchPacket = sealPacket({
      ...p,
      search: [
        {
          id: "search:q1",
          query: "documents",
          pageUrl: null,
          windowStart: null,
          windowEnd: null,
          clicks: null,
          impressions: null,
          position: null,
          ctr: null,
          source: "gsc_query",
        },
      ],
    });
    const searchDimensions = reusableDimensions(searchPacket);
    await expect(findReusableDecision(matchingReuseDb(), searchDimensions, searchPacket, "offline")).resolves.toBeNull();
    await expect(
      findReusableDecision(
        matchingReuseDb({ evidenceRecord: { findMany: vi.fn(async () => [{ id: "q1" }]) } }),
        searchDimensions,
        searchPacket,
        "offline"
      )
    ).resolves.toMatchObject({ decision: { packetHash: searchPacket.packetHash } });

    const livePacket = sealPacket({
      ...p,
      pages: p.pages.map((page) => ({ ...page, retrieval: "live" as const, truncated: true, truncation: "byte_limit" as const })),
    });
    await expect(
      findReusableDecision(matchingReuseDb(), reusableDimensions(livePacket), livePacket, "offline")
    ).resolves.toBeNull();

    const oldDecision = finaliseDecision({
      model: model(),
      packet: p,
      modelName: "offline",
      promptVersion: "recommendation-prompt/2",
      now: new Date(Date.now() - 8 * 24 * 60 * 60_000),
    });
    await expect(
      findReusableDecision(matchingReuseDb(), reusableDimensions(p, oldDecision), p, "offline")
    ).resolves.toBeNull();

    const withoutManifest = { ...dimensions, recommendationDependenciesJson: undefined };
    await expect(findReusableDecision(matchingReuseDb(), withoutManifest, p, "offline")).resolves.toBeNull();
  });

  it("treats a page id and its URL as the same request in history", () => {
    const p = packet();
    const url = p.pages[0].url;
    const first = validateEvidenceRequest(
      {
        kind: "request_evidence",
        requests: [{ type: "page_text", target: url, question: "Read it.", whyItMatters: "It matters." }],
        rationale: "Need it.",
      },
      p,
      { siteDomain: "site.test" }
    );
    expect(first.ok).toBe(true);
    const key = first.resolved[0].key;
    const withHistory = sealPacket({
      ...p,
      requests: [{ type: "page_text", target: url, key, status: "unavailable", detail: "retrieval failed" }],
    });
    const second = validateEvidenceRequest(
      {
        kind: "request_evidence",
        requests: [{ type: "page_text", target: "page:0", question: "Read it again.", whyItMatters: "It matters." }],
        rationale: "Need it.",
      },
      withHistory,
      { siteDomain: "site.test" }
    );
    expect(second.ok).toBe(false);
    expect(second.errors.join(" ")).toMatch(/already attempted/);
  });

  it("accepts a scoped positive change to the assessed section", () => {
    const p = packet({ truncated: false });
    const decision = finaliseDecision({
      model: model({
        readiness: "actionable",
        intervention: "update_page",
        change: "Clarify the document list in the assessed section.",
        coverage: [
          {
            pageId: "page:0",
            state: "partially_answers",
            scope: "section",
            sectionIds: ["section:0"],
            rationale: "It mentions documents but does not list them.",
            excerpts: ["documents"],
            limitations: [],
          },
        ],
        targets: [{ pageId: "page:0", pageUrl: p.pages[0].url, sectionId: "section:0", role: "update", rationale: "Change the assessed section." }],
        benefits: [
          { track: "customer_value", mechanism: "Clarity.", measurement: "unquantified", baselineReference: null, assumptions: [], uncertainty: ["Unmeasured."] },
        ],
      }),
      packet: p,
      modelName: "offline",
      promptVersion: "recommendation-prompt/2",
    });
    expect(validateDecision(decision, p)).toEqual({ ok: true, errors: [] });
  });

  it("passes the validated address to the transport and rejects a mixed private answer", async () => {
    const transport = vi.fn(async () => new Response("body", { headers: { "content-type": "text/html" } }));
    await fetchPublicDocument("https://public.test/page", {
      resolve: async () => "93.184.216.34",
      transport,
    });
    const call = transport.mock.calls[0] as unknown as [string, { address: string; family: number }];
    expect(call[1]).toMatchObject({ address: "93.184.216.34", family: 4 });

    const mixed = vi.fn(async () => new Response("body", { headers: { "content-type": "text/html" } }));
    await expect(
      fetchPublicDocument("https://public.test/page", {
        resolve: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
        transport: mixed,
      })
    ).rejects.toThrow(/private\/reserved IP/);
    expect(mixed).not.toHaveBeenCalled();
  });

  it("charges bytes already streamed when the body fails mid-read", async () => {
    let charged = 0;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(500));
          return;
        }
        controller.error(new Error("network broke"));
      },
    });
    await expect(
      fetchPublicDocument("https://public.test/page", {
        resolve: publicResolve,
        onBytes: (bytes) => {
          charged += bytes;
        },
        transport: async () => new Response(stream, { headers: { "content-type": "text/html" } }),
      })
    ).rejects.toThrow(/network broke/);
    expect(charged).toBe(500);
  });

  it("retries a transient provider response and records both attempts", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("busy", { status: 500, headers: { "retry-after": "0.001" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const { chatJson } = await import("@/lib/ai/chat");
    const records: Array<{ status: string; error?: string }> = [];
    const result = await chatJson({
      config: { apiKey: "test-key", baseUrl: "https://llm.test/v1", model: "test-model" },
      system: "s",
      user: "u",
      attempts: 2,
      onAttempt: (record) => records.push(record),
    });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(records.map((record) => record.status)).toEqual(["error", "ok"]);
  });

  it("records malformed JSON and timeouts as failed attempts", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    const { chatJson } = await import("@/lib/ai/chat");
    const malformed: Array<{ status: string; responseText?: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );
    await expect(
      chatJson({
        config: { apiKey: "test-key", baseUrl: "https://llm.test/v1", model: "test-model" },
        system: "s",
        user: "u",
        attempts: 1,
        onAttempt: (record) => malformed.push(record),
      })
    ).rejects.toThrow(/non-JSON/);
    expect(malformed[0]).toMatchObject({ status: "error", responseText: "not json" });

    const timedOut: Array<{ status: string; error?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("The operation was aborted");
        error.name = "TimeoutError";
        throw error;
      })
    );
    await expect(
      chatJson({
        config: { apiKey: "test-key", baseUrl: "https://llm.test/v1", model: "test-model" },
        system: "s",
        user: "u",
        attempts: 1,
        onAttempt: (record) => timedOut.push(record),
      })
    ).rejects.toThrow(/aborted/);
    expect(timedOut[0]).toMatchObject({ status: "error" });
  });

  it("records invalid model output as an invalid-output attempt", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"kind":"final_decision"}' } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const { assessRecommendation } = await import("@/lib/recommendation/assess");
    const outcome = await assessRecommendation(packet({ pages: 0 }), {
      ledger: new AnalysisLedger(),
      maxAttempts: 1,
    });
    expect(outcome.kind).toBe("failure");
    expect(outcome.history?.some((entry) => entry.kind === "invalid_output")).toBe(true);
  });
});

describe("persistent failure backoff", () => {
  it("does not retry a recently failed candidate in the same reassessment lane", async () => {
    const { reassessProjectRecommendations } = await import("@/lib/recommendation/reassess");
    const row = {
      id: "e1",
      observedAt: at,
      dimensions: { findingId: "a", painPoint: "true", theme: "A", recommendationDedupKey: "O13:a" },
    };
    const db = {
      site: { findUnique: vi.fn(async () => ({ id: "s1", projectId: "p1", domain: "site.test" })) },
      siteProfile: { findUnique: vi.fn(async () => null) },
      businessKnowledgeDocument: { findUnique: vi.fn(async () => null) },
      businessKnowledgeRevision: { findFirst: vi.fn(async () => null) },
      crawl: { findFirst: vi.fn(async () => ({ id: "c1", pagesFound: 1, maxPages: 500, finishedAt: at })) },
      auditPage: {
        findMany: vi.fn(async () => [
          {
            url: "https://site.test/p0",
            title: "Page",
            contentText: "The introduction does not list documents.",
            contentHash: "stored",
            statusCode: 200,
            indexable: true,
          },
        ]),
        findFirst: vi.fn(async () => null),
      },
      researchSource: { findMany: vi.fn(async () => []) },
      researchFinding: {
        findUnique: vi.fn(async () => ({
          id: "a",
          runId: "r1",
          type: "CONCERN",
          theme: "A",
          summary: "A",
          evidenceSourceIds: [],
          createdAt: at,
        })),
      },
      evidenceRecord: {
        findMany: vi.fn(async (args?: { where?: { kind?: unknown } }) =>
          args?.where?.kind === "research_finding" ? [row] : []
        ),
      },
      opportunity: { findMany: vi.fn(async () => []) },
      rawProviderResponse: {
        findMany: vi.fn(async () => [
          {
            payload: {
              projectId: "p1",
              siteId: "s1",
              findingId: "a",
              attemptedAt: new Date().toISOString(),
              outcome: "failed",
            },
          },
        ]),
        create: vi.fn(async () => ({ id: "progress-1" })),
      },
    } as never;
    const assessor = vi.fn();
    const result = await reassessProjectRecommendations(db, {
      projectId: "p1",
      siteId: "s1",
      assessor: assessor as never,
    });
    expect(assessor).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.outcomes[0]?.reason).toContain("backoff");
  });
});

describe("limitation preservation", () => {
  it("records overflow limitations in the trace instead of dropping them silently", async () => {
    const p = sealPacket({
      ...packet({ pages: 0 }),
      limitations: Array.from({ length: 20 }, (_, index) => `existing limitation ${index}`),
    });
    const result = await expandEvidencePacket(
      expandDb(),
      p,
      [
        {
          type: "page_text",
          target: "https://site.test/fail",
          pageId: null,
          url: "https://site.test/fail",
          offset: null,
          key: canonicalRequestKey("page_text", "https://site.test/fail", { url: "https://site.test/fail" }),
        },
      ],
      {
        siteDomain: "site.test",
        resolve: publicResolve,
        transport: async () => new Response("nope", { status: 500, headers: { "content-type": "text/html" } }),
      }
    );
    expect(result.packet.limitations).toHaveLength(20);
    expect(result.packet.limitations[19]).toMatch(/further limitations were recorded in the trace/);
    expect(result.packet.trace.some((entry) => entry.detail.includes("additional limitations:"))).toBe(true);
  });
});
