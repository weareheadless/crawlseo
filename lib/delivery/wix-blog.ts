import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

const API_BASE = "https://www.wixapis.com";

export class WixBlogDeliveryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "WixBlogDeliveryError";
  }
}

type WixConfig = { apiKey: string; siteId: string };

function config(): WixConfig | null {
  const apiKey = (process.env.WIX_BLOG_API_KEY || process.env.WIX_API_KEY || "").trim();
  const siteId = (process.env.WIX_BLOG_SITE_ID || process.env.WIX_SITE_ID || "").trim();
  return apiKey && siteId ? { apiKey, siteId } : null;
}

async function wixRequest<T>(
  cfg: WixConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: cfg.apiKey,
      "wix-site-id": cfg.siteId,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new WixBlogDeliveryError(
      `Wix Blog API returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      502,
    );
  }
  return response.json() as Promise<T>;
}

function textNode(value: string) {
  return {
    type: "TEXT",
    id: randomUUID().replace(/-/g, "").slice(0, 10),
    nodes: [],
    textData: { text: value, decorations: [] },
  };
}

function paragraph(value: string) {
  return {
    type: "PARAGRAPH",
    id: randomUUID().replace(/-/g, "").slice(0, 10),
    style: { paddingBottom: "18px" },
    nodes: [textNode(value)],
    paragraphData: { textStyle: { textAlignment: "AUTO" } },
  };
}

function heading(value: string, level: number) {
  return {
    type: "HEADING",
    id: randomUUID().replace(/-/g, "").slice(0, 10),
    style: { paddingTop: "24px", paddingBottom: "8px" },
    nodes: [textNode(value)],
    headingData: { level: Math.max(1, Math.min(6, level)), textStyle: { textAlignment: "AUTO" } },
  };
}

export function markdownToRicos(markdown: string, title: string): { documentStyle: object; nodes: unknown[] } {
  const nodes: unknown[] = [];
  let list: string[] = [];

  function flushList() {
    if (list.length === 0) return;
    nodes.push({
      type: "BULLETED_LIST",
      id: randomUUID().replace(/-/g, "").slice(0, 10),
      style: { paddingBottom: "18px" },
      nodes: list.map((item) => ({
        type: "LIST_ITEM",
        id: randomUUID().replace(/-/g, "").slice(0, 10),
        style: {},
        listItemData: {},
        nodes: [paragraph(item)],
      })),
      bulletedListData: { indentation: 0, offset: 0 },
    });
    list = [];
  }

  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let firstHeadingSkipped = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      list.push(line.replace(/^[-*]\s+/, ""));
      continue;
    }
    flushList();
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const value = headingMatch[2].trim();
      if (!firstHeadingSkipped && level === 1 && value.toLowerCase() === title.trim().toLowerCase()) {
        firstHeadingSkipped = true;
        continue;
      }
      nodes.push(heading(value, level === 1 ? 2 : level));
      continue;
    }
    const cleaned = line
      .replace(/^\s*>\s?/, "")
      .replace(/^\s*\d+\.\s+/, "")
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/`(.*?)`/g, "$1");
    nodes.push(paragraph(cleaned));
  }
  flushList();
  return { documentStyle: {}, nodes };
}

function seoData(draft: { title: string; metaTitle: string; metaDescription: string; primaryQuery: string }) {
  const keywords = [draft.primaryQuery, draft.metaTitle, draft.title]
    .filter(Boolean)
    .slice(0, 5)
    .map((term, index) => ({ term, isMain: index === 0, origin: "CrawlSEO" }));
  return {
    tags: [
      { type: "title", children: draft.metaTitle || draft.title, custom: false, disabled: false },
      {
        type: "meta",
        props: { name: "description", content: draft.metaDescription },
        children: "",
        custom: false,
        disabled: false,
      },
    ],
    settings: { keywords },
  };
}

async function siteCmsConfig(cfg: WixConfig) {
  const categories = await wixRequest<{ categories?: Array<{ id: string; label?: string; title?: string }> }>(
    cfg, "GET", "/blog/v3/categories?language=en&paging.limit=100",
  );
  const category = (categories.categories ?? []).find((item) =>
    /real estate market updates/i.test(item.label ?? item.title ?? ""),
  );
  if (!category?.id) throw new WixBlogDeliveryError("Wix category 'Real Estate Market Updates' was not found", 502);

  const tags = await wixRequest<{ tags?: Array<{ id: string; label?: string }> }>(
    cfg, "GET", "/blog/v3/tags?language=en&paging.limit=100",
  );
  const members = await wixRequest<{ members?: Array<{ id: string; profile?: { nickname?: string } }> }>(
    cfg, "GET", "/members/v1/members?fieldsets=PUBLIC&paging.limit=100",
  );
  const member = (members.members ?? []).find((item) =>
    (item.profile?.nickname ?? "").toLowerCase() === "susi macdonald",
  );
  if (!member?.id) throw new WixBlogDeliveryError("Wix author member 'Susi MacDonald' was not found", 502);

  return { categoryId: category.id, tags: tags.tags ?? [], memberId: member.id };
}

async function slugExists(cfg: WixConfig, slug: string) {
  const result = await wixRequest<{ dataItems?: unknown[] }>(cfg, "POST", "/wix-data/v2/items/query", {
    dataCollectionId: "Blog/Posts",
    query: { filter: { slug }, paging: { limit: 1, offset: 0 } },
    publishPluginOptions: { includeDraftItems: true },
  });
  return (result.dataItems?.length ?? 0) > 0;
}

export async function createWixBlogDraftForDraft(contentDraftId: string) {
  const cfg = config();
  if (!cfg) throw new WixBlogDeliveryError("Wix Blog credentials are not configured", 503);

  const draft = await db.contentDraft.findUnique({
    where: { id: contentDraftId },
    include: {
      site: { select: { id: true, domain: true } },
      action: { select: { id: true, format: true, primaryQuery: true, status: true } },
    },
  });
  if (!draft) throw new WixBlogDeliveryError("Content draft not found", 404);
  if (!draft.action || draft.format !== "article") {
    throw new WixBlogDeliveryError("Only article drafts linked to a ResearchAction can be delivered to Wix Blog", 409);
  }

  const deliveryConfig = await db.siteDeliveryConfig.findUnique({
    where: { siteId: draft.siteId },
    select: { enabled: true, adapters: true },
  });
  const adapters = Array.isArray(deliveryConfig?.adapters) ? deliveryConfig.adapters : [];
  if (!deliveryConfig?.enabled || !adapters.includes("wix_blog")) {
    throw new WixBlogDeliveryError("Wix Blog delivery is not enabled for this site", 409);
  }

  const existing = await db.delivery.findFirst({
    where: { actionId: draft.action.id, draftId: draft.id, platform: "wix_blog", status: "DRAFT_VERIFIED" },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return existing;

  if (await slugExists(cfg, draft.slug)) {
    throw new WixBlogDeliveryError(`A Wix Blog post or draft already uses slug ${draft.slug}`, 409);
  }

  const cms = await siteCmsConfig(cfg);
  const searchable = `${draft.title} ${draft.primaryQuery} ${draft.metaTitle}`.toLowerCase();
  const tagIds = cms.tags
    .filter((tag) => tag.label && searchable.includes(tag.label.toLowerCase()))
    .map((tag) => tag.id)
    .slice(0, 8);

  const draftPost = {
    title: draft.title,
    excerpt: draft.excerpt,
    seoSlug: draft.slug,
    memberId: cms.memberId,
    language: "en",
    categoryIds: [cms.categoryId],
    tagIds,
    hashtags: ["RivieraMaya", "RealEstate"],
    commentingEnabled: true,
    featured: false,
    richContent: markdownToRicos(draft.markdown, draft.title),
    seoData: seoData(draft),
  };

  const created = await wixRequest<{ draftPost?: { id?: string } }>(cfg, "POST", "/blog/v3/draft-posts", {
    draftPost,
    publish: false,
  });
  const externalId = created.draftPost?.id;
  if (!externalId) throw new WixBlogDeliveryError("Wix Blog returned no draft ID", 502);

  const saved = await wixRequest<{ draftPost?: { id?: string; title?: string; seoSlug?: string; richContent?: { nodes?: unknown[] } } }>(
    cfg, "GET", `/blog/v3/draft-posts/${encodeURIComponent(externalId)}?fieldsets=RICH_CONTENT`,
  );
  const verified = saved.draftPost;
  if (!verified || verified.id !== externalId || verified.title !== draft.title
      || !verified.richContent?.nodes?.length || verified.seoSlug !== draft.slug) {
    throw new WixBlogDeliveryError("Wix Blog draft did not pass readback verification", 502);
  }

  return db.delivery.create({
    data: {
      actionId: draft.action.id,
      draftId: draft.id,
      platform: "wix_blog",
      externalId,
      status: "DRAFT_VERIFIED",
      verifiedAt: new Date(),
      payload: {
        draft_id: externalId,
        title: draft.title,
        slug: draft.slug,
        language: "en",
        readback_verified: true,
      },
    },
  });
}
