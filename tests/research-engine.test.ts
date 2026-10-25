import { describe, expect, it } from "vitest";
import {
  canTransitionActionStatus,
  researchActionDedupeKey,
} from "@/lib/research/service";
import {
  createResearchActionSchema,
  createResearchRunSchema,
  ingestResearchFindingSchema,
} from "@/lib/research/types";
import { contentActionFromResearchAction } from "@/lib/research/content";
import type { ResearchAction } from "@prisma/client";

describe("research run input", () => {
  it("accepts a market research brief with defaults", () => {
    const input = createResearchRunSchema.parse({
      title: "Buyer concerns in Tulum",
      topics: ["Tulum real estate", "property ownership"],
    });
    expect(input.kind).toBe("MARKET");
    expect(input.trigger).toBe("MANUAL");
    expect(input.recencyDays).toBe(90);
    expect(input.providers).toEqual(["reddit", "news", "web"]);
  });

  it("rejects a run without topics", () => {
    expect(() => createResearchRunSchema.parse({
      title: "Empty request",
      topics: [],
    })).toThrow();
  });
});

describe("research findings", () => {
  it("requires at least one source", () => {
    expect(() => ingestResearchFindingSchema.parse({
      type: "CONCERN",
      theme: "Ownership",
      summary: "Buyers repeatedly ask how title and ownership work for condos.",
      sources: [],
    })).toThrow();
  });

  it("accepts a cited finding", () => {
    const finding = ingestResearchFindingSchema.parse({
      type: "CONCERN",
      theme: "Ownership",
      summary: "Buyers repeatedly ask how title and ownership work for condos.",
      confidence: 72,
      sources: [{
        provider: "reddit",
        url: "https://www.reddit.com/r/tulum/comments/example",
        title: "How does ownership work?",
        excerpt: "Can a foreigner own property directly?",
        contentHash: "abc123",
      }],
    });
    expect(finding.confidence).toBe(72);
    expect(finding.sources).toHaveLength(1);
  });
});

describe("research actions", () => {
  it("creates a stable dedupe key", () => {
    const first = researchActionDedupeKey({
      source: "market_research",
      kind: "add_faq",
      targetUrl: "https://example.com/tulum",
      title: "Add ownership FAQ",
    });
    const second = researchActionDedupeKey({
      source: "market_research",
      kind: "add_faq",
      targetUrl: "https://example.com/tulum",
      title: "  Add ownership FAQ  ",
    });
    expect(first).toBe(second);
  });

  it("changes the dedupe key when the target changes", () => {
    expect(researchActionDedupeKey({
      source: "market_research",
      kind: "add_faq",
      targetUrl: "https://example.com/tulum",
      title: "Add ownership FAQ",
    })).not.toBe(researchActionDedupeKey({
      source: "market_research",
      kind: "add_faq",
      targetUrl: "https://example.com/cancun",
      title: "Add ownership FAQ",
    }));
  });

  it("keeps the same issue identity when an action title is reworded", () => {
    const first = researchActionDedupeKey({ source: "market_research", kind: "add_faq",
      targetUrl: "https://example.com/tulum", primaryQuery: "foreign ownership rules", title: "Add an ownership FAQ" });
    const revised = researchActionDedupeKey({ source: "technical_seo", kind: "add_faq",
      targetUrl: "https://example.com/tulum", primaryQuery: "foreign ownership rules", title: "Clarify buyer title questions" });
    expect(revised).toBe(first);
  });

  it("validates action priority and URLs", () => {
    expect(createResearchActionSchema.parse({
      source: "market_research",
      kind: "add_faq",
      title: "Add ownership FAQ",
      recommendation: "Add a concise FAQ grounded in the cited buyer concerns.",
      priority: 70,
      targetUrl: "https://example.com/tulum",
    }).priority).toBe(70);

    expect(() => createResearchActionSchema.parse({
      source: "market_research",
      kind: "add_faq",
      title: "Bad URL",
      recommendation: "This should fail because the URL is invalid.",
      targetUrl: "not-a-url",
    })).toThrow();
  });
});

describe("action transitions", () => {
  it("allows the normal workflow", () => {
    expect(canTransitionActionStatus("PROPOSED", "APPROVED")).toBe(true);
    expect(canTransitionActionStatus("APPROVED", "DRAFTING")).toBe(true);
    expect(canTransitionActionStatus("DRAFTING", "DRAFT_READY")).toBe(true);
    expect(canTransitionActionStatus("DRAFT_READY", "DELIVERY_APPROVED")).toBe(true);
    expect(canTransitionActionStatus("DELIVERY_APPROVED", "DELIVERING")).toBe(true);
    expect(canTransitionActionStatus("DELIVERING", "DELIVERED")).toBe(true);
    expect(canTransitionActionStatus("DELIVERED", "VERIFIED")).toBe(true);
  });

  it("rejects skipped or terminal transitions", () => {
    expect(canTransitionActionStatus("PROPOSED", "DELIVERED")).toBe(false);
    expect(canTransitionActionStatus("DISMISSED", "APPROVED")).toBe(false);
    expect(canTransitionActionStatus("VERIFIED", "DRAFTING")).toBe(false);
  });
});


describe("research action to content action", () => {
  const action = {
    id: "action-1",
    projectId: null,
    siteId: "site-1",
    revision: 1,
    runId: null,
    findingId: null,
    source: "market_research",
    kind: "add_faq",
    format: "page_update",
    title: "Add ownership FAQ",
    primaryQuery: "can foreigners own property in mexico",
    targetUrl: null,
    recommendation: "Add a source-grounded FAQ to the existing ownership page.",
    priorityRationale: null,
    requiredCapabilities: null,
    acceptanceCriteria: null,
    dependencies: null,
    reassessmentConditions: null,
    evidence: {
      signals: ["striking_distance"],
      confidence: 0.72,
      expected_clicks: 14,
    },
    priority: 78,
    status: "APPROVED",
    preparationStatus: "NONE",
    preparationRequestId: null,
    automationMode: "MANUAL",
    dedupeKey: "dedupe-1",
    owner: null,
    approvedBy: "user-1",
    approvedAt: new Date(),
    deliveredAt: null,
    verifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as ResearchAction;

  it("maps a research action into the content generator contract", () => {
    const mapped = contentActionFromResearchAction(action);
    expect(mapped).toMatchObject({
      id: "action-1",
      kind: "improve_page",
      format: "page_update",
      primaryQuery: "can foreigners own property in mexico",
      impact: 78,
      confidence: 72,
      expectedClicks: 14,
    });
    expect(mapped.signals).toEqual(["striking_distance"]);
  });
});
