import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const draftRow: Record<string, unknown> = {
    id: "draft-1",
    siteId: "site-1",
    actionId: "action-1",
    title: "Banks in Playa del Carmen: Opening an Account as a Foreigner",
    slug: "banks-in-playa-del-carmen",
    metaTitle: "Banks in Playa del Carmen",
    metaDescription: "A practical guide to opening a bank account in Playa del Carmen as a foreigner.",
    primaryQuery: "banks in playa del carmen",
    excerpt: "Which banks work with foreigners.",
    markdown: "# Banks in Playa del Carmen\n\nA useful paragraph about opening an account. ".repeat(6),
    updatedAt: new Date("2026-11-11T12:00:00Z"),
    wixApprovalHash: null,
    wixApprovedBy: null,
    wixApprovedAt: null,
    wixApprovedRevision: null,
    format: "article",
    action: {
      id: "action-1",
      revision: 1,
      status: "VERIFIED",
      format: "article",
      primaryQuery: "banks in playa del carmen",
      targetUrl: "https://example.com/post/opening-a-bank-account-in-playa-del-carmen",
    },
    site: { id: "site-1", domain: "example.com" },
  };
  return {
    draftRow,
    deliveries: [] as Array<{ externalId: string; status: string; payload?: unknown; id: string }>,
    created: [] as Array<Record<string, unknown>>,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    contentDraft: {
      findUnique: vi.fn(async () => state.draftRow),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(state.draftRow, data);
        return { count: 1 };
      }),
    },
    connectorBinding: { findUnique: vi.fn(async () => null) },
    researchAction: { findUnique: vi.fn(async () => ({ id: "action-1", status: "VERIFIED" })) },
    siteDeliveryConfig: { findUnique: vi.fn(async () => ({ enabled: true, adapters: ["wix_blog"], bridgeAlias: null })) },
    delivery: {
      findFirst: vi.fn(async () => state.deliveries[0] ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: `delivery-${state.deliveries.length + 1}` } as { externalId: string; status: string; payload?: unknown; id: string };
        state.deliveries.unshift(row);
        state.created.push(data);
        return row;
      }),
    },
  },
}));

vi.mock("@/lib/research/question-coverage", () => ({ recordDraftCoverage: vi.fn(async () => ({ status: "COVERED" })) }));

vi.mock("@/lib/delivery/unsplash", () => ({
  findUnsplashCover: vi.fn(async () => ({ url: "https://images.test/cover.jpg", alt: "cover", credit: "Photographer" })),
  importUnsplashCover: vi.fn(async () => ({ mediaId: "media-1", url: "https://images.test/cover.jpg", altText: "cover", cover: "Photo: Photographer" })),
}));
vi.mock("@/lib/site/context", () => ({ resolveSiteContext: vi.fn(async () => ({ location: "Playa del Carmen" })) }));

import { approveWixBlogUpdateForDraft, createWixBlogDraftForDraft, publishWixBlogUpdateForDraft } from "@/lib/delivery/wix-blog";

const requests: Array<{ method: string; url: string; body?: unknown }> = [];

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WIX_BLOG_API_KEY", "test-key");
  vi.stubEnv("WIX_BLOG_SITE_ID", "site-guid");
  state.deliveries.length = 0;
  state.created.length = 0;
  requests.length = 0;
  state.draftRow.wixApprovalHash = null;
  state.draftRow.wixApprovedBy = null;
  state.draftRow.wixApprovedAt = null;
  state.draftRow.wixApprovedRevision = null;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body });
    if (url.includes("/wix-data/v2/items/query")) {
      return json({ dataItems: [{ id: "item-1", data: { uuid: "post-1", slug: "opening-a-bank-account-in-playa-del-carmen", plainContent: "old body" } }] });
    }
    if (method === "GET" && /\/blog\/v3\/draft-posts\/post-1/.test(url)) {
      return json({ draftPost: { id: "post-1", title: "Opening a Bank Account in Playa del Carmen", seoSlug: "opening-a-bank-account-in-playa-del-carmen", status: "PUBLISHED", richContent: { nodes: [{ type: "PARAGRAPH" }] } } });
    }
    if (method === "PATCH") {
      return json({ draftPost: { id: "post-1", title: body?.draftPost?.title, richContent: { nodes: [{ type: "PARAGRAPH" }] } } });
    }
    return json({ draftPost: { id: "post-1", status: "PUBLISHED" } });
  }));
});

describe("publishing an approved update to an existing post", () => {
  it("points the delivery at the existing post instead of creating a new one", async () => {
    const marker = await createWixBlogDraftForDraft("draft-1");
    expect(marker.externalId).toBe("post-1");
    expect(requests.some((request) => request.method === "POST" && /\/blog\/v3\/draft-posts$/.test(request.url))).toBe(false);
  });

  it("patches and publishes that post, keeping its slug and using the approved title", async () => {
    await createWixBlogDraftForDraft("draft-1");
    await approveWixBlogUpdateForDraft("draft-1", "owner-1");
    const published = await publishWixBlogUpdateForDraft("draft-1", "owner-1");

    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.url).toContain("/blog/v3/draft-posts/post-1");
    const sent = patch?.body as { draftPost: { title: string; seoSlug?: string } };
    expect(sent.draftPost.title).toBe("Banks in Playa del Carmen: Opening an Account as a Foreigner");
    // The address of the post must not change: no seoSlug is sent.
    expect(sent.draftPost.seoSlug).toBeUndefined();

    const publishRequest = requests.find((request) => request.method === "POST" && request.url.includes("/publish"));
    expect(publishRequest?.url).toContain("/blog/v3/draft-posts/post-1/publish");
    expect(published.externalId).toBe("post-1");
    expect(published.payload).toMatchObject({ post_id: "post-1", readback_verified: true });
  });
});
