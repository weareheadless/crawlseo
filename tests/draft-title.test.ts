import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  generated: {
    title: "Banks in Playa del Carmen: Opening an Account as a Foreigner",
    slug: "banks-in-playa-del-carmen",
    metaTitle: "Banks in Playa del Carmen: Opening an Account as a Foreigner",
    metaDescription: "A practical guide to opening a bank account in Playa del Carmen as a foreigner.",
    excerpt: "Which banks work with foreigners.",
    markdown: "# Banks in Playa del Carmen: Opening an Account as a Foreigner\n\nA useful paragraph about banking. ".repeat(4),
    outline: ["Quick answer"],
    model: "test-model",
    provider: "openai-compatible",
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    researchAction: {
      findUnique: vi.fn(async () => ({
        id: "action-1",
        siteId: "site-1",
        projectId: "project-1",
        dedupeKey: "opportunity:one",
        status: "APPROVED",
        kind: "create_article",
        format: "article",
        title: "Update the bank guide",
        recommendation: "Retitle and rewrite the H1 around 'Banks in Playa del Carmen'.",
        targetUrl: "https://example.com/post/opening-a-bank-account",
        primaryQuery: "banks in playa del carmen",
        priority: 70,
        evidence: {},
        revision: 1,
        site: { id: "site-1", domain: "example.com", connectorBinding: null },
        finding: null,
        run: null,
      })),
      update: vi.fn(async () => ({ id: "action-1", status: "DRAFT_READY" })),
    },
    contentDraft: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.created.push(data);
        return { id: "draft-1", ...data };
      }),
    },
  },
}));

vi.mock("@/lib/ai-seo/writer", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai-seo/writer")>("@/lib/ai-seo/writer");
  return { ...actual, generateContentDraft: vi.fn(async () => state.generated), briefForDraft: actual.briefForDraft };
});
vi.mock("@/lib/delivery/unsplash", () => ({}));

import { generateDraftForAction } from "@/lib/research/content";

beforeEach(() => {
  state.created.length = 0;
});

describe("generating a draft for an existing post", () => {
  it("keeps the title the writer returns when the action asks for a retitle", async () => {
    await generateDraftForAction("action-1", "Retitle the post.", {
      requireApproval: false,
      forceArticle: true,
      currentTitle: "Opening a Bank Account in Playa del Carmen: A Detailed Guide",
    });

    expect(state.created[0].title).toBe("Banks in Playa del Carmen: Opening an Account as a Foreigner");
  });

  it("drops a leading H1 that repeats the new title", async () => {
    await generateDraftForAction("action-1", undefined, {
      requireApproval: false,
      forceArticle: true,
      currentTitle: "Opening a Bank Account in Playa del Carmen: A Detailed Guide",
    });

    const markdown = String(state.created[0].markdown);
    expect(markdown.startsWith("# ")).toBe(false);
    expect(markdown).toContain("A useful paragraph about banking.");
  });

  it("keeps a different first heading as body content", async () => {
    state.generated = {
      ...state.generated,
      title: "Banks in Playa del Carmen",
      markdown: "# Which banks work with foreigners\n\nA useful paragraph about banking. ".repeat(4),
    };
    await generateDraftForAction("action-1", undefined, {
      requireApproval: false,
      forceArticle: true,
      currentTitle: "Old title",
    });
    expect(String(state.created[0].markdown).startsWith("# Which banks")).toBe(true);
  });
});
