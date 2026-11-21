import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesizeResearch } from "@/lib/research/synthesizer";
import type { SiteBrief } from "@/lib/site/brief";

function brief(overrides: Partial<SiteBrief> = {}): SiteBrief {
  return {
    siteId: "site-1", projectId: "project-1", domain: "casamigo.net",
    language: "en", country: "MX", market: null, audienceMarket: null, audienceCountry: null,
    audience: null, topics: [], goals: [], facts: [], withheldFields: [],
    ...overrides,
  };
}

const sources = [{
  provider: "reddit_rss",
  url: "https://www.reddit.com/r/tulum/comments/1/ownership/",
  title: "How does ownership work?",
  community: "r/tulum",
  publishedAt: new Date("2026-10-20T12:00:00Z"),
  excerpt: "Can a foreign buyer own property directly in Mexico?",
}];

function completion(payload: unknown) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("research synthesis", () => {
  it("normalizes findings and filters invented target URLs", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({
      findings: [{
        type: "CONCERN",
        theme: "Property ownership",
        summary: "Buyers repeatedly ask whether foreigners can own property directly.",
        confidence: 76,
        sentiment: "mixed",
        urgency: "medium",
        suggested_action_kind: "add_faq",
        source_indexes: [0],
      }],
      actions: [{
        finding_index: 0,
        source: "market_research",
        kind: "add_faq",
        format: "page_update",
        title: "Add ownership FAQ",
        primary_query: "can foreigners own property in mexico",
        target_url: "https://www.casamigo.net/",
        recommendation: "Add a source-grounded FAQ to the existing ownership page.",
        priority: 82,
        automation_mode: "MANUAL",
      }],
    })));

    const result = await synthesizeResearch({
      brief: brief({ topics: ["Tulum real estate"], audience: "international buyers", market: "Mexico" }),
      title: "Buyer concerns",
      questions: ["What concerns do buyers raise?"],
      sources,
      candidatePages: ["https://www.casamigo.net/"],
    });

    expect(result.findings).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      targetUrl: "https://www.casamigo.net/",
      priority: 82,
      format: "page_update",
    });
    expect(result.model).toBe("test-model");
  });

  it("drops a target URL that was not in the candidate page list", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({
      findings: [{
        type: "THEME",
        theme: "Ownership",
        summary: "Buyers ask about ownership and legal checks in the market.",
        confidence: 60,
        source_indexes: [0],
      }],
      actions: [{
        finding_index: 0,
        source: "market_research",
        kind: "update_page",
        title: "Update page",
        target_url: "https://invented.example/page",
        recommendation: "Update the page with the evidence-backed explanation.",
        priority: 50,
      }],
    })));

    const result = await synthesizeResearch({
      brief: brief({ topics: ["Tulum real estate"] }),
      title: "Buyer concerns",
      questions: [],
      sources,
      candidatePages: ["https://www.casamigo.net/"],
    });
    expect(result.actions[0].targetUrl).toBeUndefined();
  });

  it("keeps Action finding links aligned when earlier model findings are rejected", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({
      findings: [
        { type: "INVALID", theme: "bad", summary: "Rejected finding with a source reference.", source_indexes: [0] },
        { type: "CONCERN", theme: "Ownership", summary: "Buyers repeatedly ask whether foreign owners can hold title.", source_indexes: [0] },
      ],
      actions: [
        { finding_index: 0, source: "market_research", kind: "update_page", title: "Wrong finding", recommendation: "This action must be dropped because finding zero was invalid." },
        { finding_index: 1, source: "market_research", kind: "update_page", title: "Ownership explanation", recommendation: "Clarify title ownership using the cited buyer evidence." },
      ],
    })));
    const result = await synthesizeResearch({
      brief: brief({ topics: ["ownership"] }), title: "Buyer concerns", questions: [], sources, candidatePages: [],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].findingIndex).toBe(0);
    expect(result.actions[0].title).toBe("Ownership explanation");
  });

  it("keeps a contradicted finding for the canonical assessor instead of pre-rejecting it", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({
      findings: [{
        type: "CONTENT_GAP",
        theme: "Foreign ownership",
        summary: "The site has no foreign-ownership answer.",
        confidence: 70,
        source_indexes: [0],
        site_claim: { kind: "missing_answer", statement: "The site has no foreign-ownership answer." },
      }],
      actions: [],
    })));
    const result = await synthesizeResearch({
      brief: brief({ domain: "example.test", topics: ["ownership"] }),
      title: "Ownership",
      questions: [],
      sources,
      candidatePages: [],
      verifyClaim: () => ({
        status: "contradicted",
        reason: "The supplied page already explains foreign ownership.",
      }),
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].verification?.status).toBe("contradicted");
    expect(result.rejected).toHaveLength(1);
  });

  it("drops model actions outside the documented capability set", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({
      findings: [{
        type: "CONCERN", theme: "Ownership", summary: "Buyers repeatedly ask about foreign ownership rules.",
        source_indexes: [0],
      }],
      actions: [{
        finding_index: 0, source: "market_research", kind: "publish_site_wide_script",
        title: "Install a new script", recommendation: "Add a site-wide script based on the source.",
      }],
    })));

    const result = await synthesizeResearch({
      brief: brief({ topics: ["ownership"] }), title: "Buyer concerns", questions: [], sources, candidatePages: [],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.actions).toEqual([]);
  });

  it("rejects a response with no valid findings", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ findings: [], actions: [] })));

    await expect(synthesizeResearch({
      brief: brief({ topics: ["Tulum real estate"] }),
      title: "Buyer concerns",
      questions: [],
      sources,
      candidatePages: [],
    })).rejects.toThrow("no valid findings");
  });
});

describe("research synthesis business context", () => {
  it("puts recorded business facts and their provenance status in the prompt", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return completion({
        findings: [{
          type: "CONTENT_GAP",
          theme: "Beginner course",
          summary: "Buyers ask what a first course includes before booking.",
          confidence: 60,
          source_indexes: [0],
        }],
        actions: [],
      });
    }));

    await synthesizeResearch({
      brief: brief({
        topics: ["freediving"],
        facts: [
          { field: "services", value: "Freediving courses", status: "assumed", kind: "ai_observation", sourceUrl: null },
          { field: "differentiators", value: "Small groups", status: "owner_confirmed", kind: "owner_input", sourceUrl: null },
        ],
        withheldFields: ["prohibitedClaims"],
      }),
      title: "Market questions",
      questions: [],
      sources,
      candidatePages: [],
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("Freediving courses");
    expect(bodies[0]).toContain("assumed");
    expect(bodies[0]).toContain("owner_confirmed");
    expect(bodies[0]).not.toContain("prohibitedClaims");
  });
});

describe("demand forms on a finding", () => {
  it("keeps shape-valid forms, drops duplicates and over-long text, and counts the drops", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({
      findings: [{
        type: "CONCERN",
        theme: "Ownership",
        summary: "Buyers ask whether a foreigner can own property directly.",
        confidence: 70,
        source_indexes: [0],
        primary_query: "can foreigners own property in mexico",
        demand_queries: [
          "can foreigners own property in mexico",
          "  buying   property in mexico as a foreigner ",
          "can foreigners own property in mexico",
          "x".repeat(90),
          42,
        ],
      }],
      actions: [],
    })));

    const result = await synthesizeResearch({
      brief: brief({ topics: ["real estate"] }),
      title: "Buyer concerns",
      questions: [],
      sources,
      candidatePages: [],
    });

    expect(result.findings[0].demandQueries).toEqual([
      "can foreigners own property in mexico",
      "buying property in mexico as a foreigner",
    ]);
    // The duplicate, the over-long phrase and the non-string are reported.
    expect(result.droppedDemandQueries).toBe(3);
  });
});
