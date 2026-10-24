import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildContentActionPlan,
  classifySearchIntent,
  type BuildContentActionPlanInput,
  type PageEvidence,
} from "@/lib/ai-seo/action-plan";
import { generateContentDraft, slugify, validateGeneratedDraft } from "@/lib/ai-seo/writer";

const page: PageEvidence = {
  url: "https://example.com/freediving",
  title: "Freediving in Playa del Carmen",
  description: "Learn to freedive with a local team.",
  wordCount: 420,
  contentScore: 58,
  h1Count: 1,
  statusCode: 200,
};

function input(overrides: Partial<BuildContentActionPlanInput> = {}): BuildContentActionPlanInput {
  return {
    siteId: "site-1",
    domain: "example.com",
    striking: [],
    lowCtr: [],
    decay: [],
    cannibal: [],
    queryTargets: {},
    pages: {},
    ...overrides,
  };
}

describe("search intent classification", () => {
  it.each([
    ["freediving course cost", "transactional"],
    ["best freediving school", "commercial"],
    ["how to equalize while freediving", "informational"],
    ["freediving near me", "local"],
    ["freediving login", "navigational"],
  ] as const)("classifies %s", (query, intent) => {
    expect(classifySearchIntent(query)).toBe(intent);
  });
});

describe("content action planning", () => {
  it("turns a low-CTR query on an existing page into a metadata action", () => {
    const plan = buildContentActionPlan(input({
      lowCtr: [{
        query: "freediving playa del carmen",
        position: 4,
        clicks: 10,
        impressions: 800,
        ctr: 0.0125,
        expectedCtr: 0.07,
        ctrGap: 0.0575,
      }],
      queryTargets: { "freediving playa del carmen": page.url },
      pages: { [page.url]: page },
    }));

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      kind: "improve_metadata",
      format: "metadata",
      targetUrl: page.url,
      page,
    });
    expect(plan.actions[0].expectedClicks).toBe(46);
    expect(plan.actions[0].signals).toEqual(["low_ctr"]);
  });

  it("merges striking-distance and low-CTR evidence into one broader page action", () => {
    const plan = buildContentActionPlan(input({
      striking: [{
        query: "freediving playa del carmen",
        position: 8,
        clicks: 10,
        impressions: 800,
        ctr: 0.0125,
        potential: 56,
      }],
      lowCtr: [{
        query: "freediving playa del carmen",
        position: 8,
        clicks: 10,
        impressions: 800,
        ctr: 0.0125,
        expectedCtr: 0.03,
        ctrGap: 0.0175,
      }],
      queryTargets: { "freediving playa del carmen": page.url },
      pages: { [page.url]: page },
    }));

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].kind).toBe("improve_page");
    expect(plan.actions[0].signals).toEqual(["striking_distance", "low_ctr"]);
    expect(plan.summary.pageUpdates).toBe(1);
    expect(plan.summary.metadata).toBe(0);
  });

  it("creates an article action when a striking-distance query has no landing page", () => {
    const plan = buildContentActionPlan(input({
      striking: [{
        query: "how to choose a freediving school",
        position: 12,
        clicks: 0,
        impressions: 140,
        ctr: 0,
        potential: 14,
      }],
    }));

    expect(plan.actions[0].kind).toBe("create_article");
    expect(plan.actions[0].format).toBe("article");
    expect(plan.actions[0].targetUrl).toBeNull();
  });

  it("turns content decay into a page refresh and keeps the URL", () => {
    const plan = buildContentActionPlan(input({
      decay: [{
        url: page.url,
        currentClicks: 20,
        previousClicks: 80,
        changePct: -75,
      }],
      pages: { [page.url]: page },
    }));

    expect(plan.actions[0]).toMatchObject({
      kind: "refresh_decaying_page",
      format: "page_update",
      targetUrl: page.url,
      expectedClicks: 60,
    });
  });

  it("prioritises a consolidation when one query has competing pages", () => {
    const plan = buildContentActionPlan(input({
      cannibal: [{
        query: "freediving playa del carmen",
        pages: [
          { url: page.url, clicks: 20, impressions: 500, position: 6 },
          { url: "https://example.com/freediving-course", clicks: 4, impressions: 120, position: 11 },
        ],
      }],
      pages: { [page.url]: page },
    }));

    expect(plan.actions[0].kind).toBe("consolidate_pages");
    expect(plan.actions[0].evidence.competing_pages).toBe(2);
    expect(plan.actions[0].targetUrl).toBe(page.url);
  });

  it("orders actions by score", () => {
    const plan = buildContentActionPlan(input({
      striking: [{
        query: "small query",
        position: 15,
        clicks: 0,
        impressions: 5,
        ctr: 0,
        potential: 1,
      }],
      decay: [{
        url: page.url,
        currentClicks: 5,
        previousClicks: 300,
        changePct: -98,
      }],
    }));

    expect(plan.actions[0].kind).toBe("refresh_decaying_page");
    expect(plan.actions[0].score).toBeGreaterThan(plan.actions[1].score);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("writer provider", () => {
  const metadataAction = buildContentActionPlan(input({
    lowCtr: [{
      query: "freediving playa del carmen",
      position: 4,
      clicks: 10,
      impressions: 800,
      ctr: 0.0125,
      expectedCtr: 0.07,
      ctrGap: 0.0575,
    }],
    queryTargets: { "freediving playa del carmen": page.url },
    pages: { [page.url]: page },
  })).actions[0];

  it("calls an OpenAI-compatible endpoint and validates the response", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    vi.stubEnv("CONTENT_LLM_BASE_URL", "https://llm.test/v1/");
    vi.stubEnv("CONTENT_LLM_MODEL", "test-model");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            title: "Freediving in Playa del Carmen: A Practical Guide",
            slug: "freediving-playa-del-carmen",
            metaTitle: "Freediving in Playa del Carmen: Practical Guide",
            metaDescription: "A practical, source-grounded guide to choosing a freediving course, planning your training, and understanding the local options.",
            excerpt: "A concise guide to planning a freediving course in Playa del Carmen.",
            markdown: `# Freediving in Playa del Carmen\n\n${"A useful paragraph about planning, safety, and course selection. ".repeat(8)}`,
            outline: ["Planning"],
          }),
        },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const draft = await generateContentDraft({
      domain: "example.com",
      action: metadataAction,
      instructions: "Keep it concise.",
    });

    expect(draft.model).toBe("test-model");
    expect(draft.slug).toBe("freediving-playa-del-carmen");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://llm.test/v1/chat/completions");
    const request = JSON.parse(String(init?.body));
    expect(request.model).toBe("test-model");
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(request.messages[0].content).toContain("only factual source");
    expect(request.messages[0].content).toContain("unless it appears in EVIDENCE");
    expect(request.messages[1].content).toContain("Keep it concise.");
  });

  it("explains provider rate limiting without retrying", async () => {
    vi.stubEnv("CONTENT_LLM_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateContentDraft({
      domain: "example.com",
      action: metadataAction,
    })).rejects.toThrow("rate-limited");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("draft validation", () => {
  it("normalizes a valid writer payload", () => {
    const draft = validateGeneratedDraft({
      title: "Freediving in Playa del Carmen: A Practical Guide",
      slug: "Freediving in Playa del Carmen",
      metaTitle: "Freediving in Playa del Carmen: Practical Guide",
      metaDescription: "A practical, source-grounded guide to choosing a freediving course, planning your training, and understanding the local options.",
      excerpt: "A concise guide to planning a freediving course in Playa del Carmen.",
      markdown: `# Freediving in Playa del Carmen\n\n${"A useful paragraph about planning, safety, and course selection. ".repeat(8)}\n\n## What to check\n\n- Certification\n- Instructor ratio\n`,
      outline: ["What to check"],
    }, { model: "test-model" });

    expect(draft.slug).toBe("freediving-in-playa-del-carmen");
    expect(draft.provider).toBe("openai-compatible");
    expect(draft.outline).toEqual(["What to check"]);
  });

  it("derives an outline when the writer omits one", () => {
    const draft = validateGeneratedDraft({
      title: "A practical freediving guide",
      metaTitle: "A practical freediving guide",
      metaDescription: "A practical guide to planning a freediving course with the right certification, instructor, and safety checks.",
      excerpt: "A practical guide to planning a freediving course.",
      markdown: `# A practical freediving guide\n\n${"Useful guidance for new divers. ".repeat(12)}\n\n## Certification\n\nDetails.\n\n## Safety\n\nDetails.`,
    }, { model: "test-model" });

    expect(draft.outline).toEqual(["A practical freediving guide", "Certification", "Safety"]);
  });

  it("rejects an empty body", () => {
    expect(() => validateGeneratedDraft({
      title: "A practical freediving guide",
      metaTitle: "A practical freediving guide",
      metaDescription: "A practical guide to planning a freediving course with the right certification, instructor, and safety checks.",
      markdown: "Too short.",
    }, { model: "test-model" })).toThrow("body is too short");
  });

  it("slugifies punctuation and accents", () => {
    expect(slugify("  Playa del Carmen: Guía 2026  ")).toBe("playa-del-carmen-guia-2026");
  });
});
