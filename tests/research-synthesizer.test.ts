import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesizeResearch } from "@/lib/research/synthesizer";

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
      siteDomain: "casamigo.net",
      title: "Buyer concerns",
      topics: ["Tulum real estate"],
      audience: "international buyers",
      market: "Mexico",
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

  it("keeps action links on the original model finding index after filtering", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({
      findings: [
        {
          type: "UNSUPPORTED",
          theme: "Ignored finding",
          summary: "This invalid finding is removed before any action is linked.",
          source_indexes: [0],
        },
        {
          type: "QUESTION",
          theme: "Ownership",
          summary: "Buyers ask which ownership steps apply to foreign purchasers.",
          source_indexes: [0],
        },
      ],
      actions: [{
        finding_index: 1,
        source: "market_research",
        kind: "add_faq",
        title: "Answer ownership question",
        recommendation: "Add the evidence-backed answer to the existing page.",
        priority: 60,
      }],
    })));

    const result = await synthesizeResearch({
      siteDomain: "casamigo.net",
      title: "Buyer concerns",
      topics: ["Tulum real estate"],
      questions: [],
      sources,
      candidatePages: [],
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].modelIndex).toBe(1);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].findingIndex).toBe(1);
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
      siteDomain: "casamigo.net",
      title: "Buyer concerns",
      topics: ["Tulum real estate"],
      questions: [],
      sources,
      candidatePages: ["https://www.casamigo.net/"],
    });
    expect(result.actions[0].targetUrl).toBeUndefined();
  });

  it("rejects a response with no valid findings", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion({ findings: [], actions: [] })));

    await expect(synthesizeResearch({
      siteDomain: "casamigo.net",
      title: "Buyer concerns",
      topics: ["Tulum real estate"],
      questions: [],
      sources,
      candidatePages: [],
    })).rejects.toThrow("no valid findings");
  });
});
