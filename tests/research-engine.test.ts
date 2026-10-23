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
