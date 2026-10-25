import { createHash, randomUUID } from "node:crypto";
import type { ResearchActionStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { findUnsplashCover, importUnsplashCover, type UnsplashCover } from "@/lib/delivery/unsplash";

const API_BASE = "https://www.wixapis.com";

export class WixBlogDeliveryError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "WixBlogDeliveryError";
  }
}

async function assertWixBlogExecutor(siteId: string): Promise<void> {
  const binding = await db.connectorBinding.findUnique({
    where: { siteId },
    select: { executor: true, status: true },
  });
  // Legacy sites without a connector binding keep their existing Wix owner
  // flow. Once a binding exists, Wix delivery belongs only to the CrawlSEO
  // adapter; HelloAda and unsupported/transferring bindings must not be
  // bypassed through the legacy Wix routes.
  if (binding && (binding.status !== "ACTIVE" || binding.executor !== "crawlseo-agent")) {
    throw new WixBlogDeliveryError("The active execution connector does not own Wix Blog delivery for this site", 409);
  }
}

function wixCandidateHash(draft: {
  id: string; siteId: string; actionId: string | null; title: string; slug: string;
  metaTitle: string; metaDescription: string; excerpt: string; markdown: string;
  action: { id: string; revision: number; targetUrl: string | null } | null;
}) {
  return createHash("sha256").update(JSON.stringify({
    id: draft.id, siteId: draft.siteId, actionId: draft.actionId,
    title: draft.title, slug: draft.slug, metaTitle: draft.metaTitle,
    metaDescription: draft.metaDescription, excerpt: draft.excerpt,
    markdown: draft.markdown,
    action: draft.action && { id: draft.action.id, revision: draft.action.revision, targetUrl: draft.action.targetUrl },
  })).digest("hex");
}

export async function approveWixBlogUpdateForDraft(contentDraftId: string, userId: string) {
  const draft = await db.contentDraft.findUnique({
    where: { id: contentDraftId },
    include: { action: { select: { id: true, revision: true, targetUrl: true } } },
  });
  if (!draft?.action) throw new WixBlogDeliveryError("A linked ResearchAction is required", 404);
  await assertWixBlogExecutor(draft.siteId);
  if (!draft.action.targetUrl || !blogSlugFromUrl(draft.action.targetUrl)) {
    throw new WixBlogDeliveryError("This action is not a Wix Blog target", 409);
  }
  const hash = wixCandidateHash(draft);
  const saved = await db.contentDraft.updateMany({
    where: { id: draft.id, updatedAt: draft.updatedAt, action: { is: { revision: draft.action.revision } } },
    data: {
      wixApprovalHash: hash,
      wixApprovedBy: userId,
      wixApprovedAt: new Date(),
      wixApprovedRevision: draft.action.revision,
    },
  });
  if (saved.count !== 1) throw new WixBlogDeliveryError("The candidate changed during approval; review it again", 409);
  return { draftId: draft.id, candidateHash: hash, actionRevision: draft.action.revision };
}

type WixConfig = {
  apiKey: string;
  siteId: string;
  alias: string;
  language: string;
  authorNickname: string;
  categoryLabel: string;
  hashtags: string[];
};

export async function configForSite(siteId: string): Promise<WixConfig | null> {
  const delivery = await db.siteDeliveryConfig.findUnique({
    where: { siteId },
    select: { bridgeAlias: true },
  });
  const alias = delivery?.bridgeAlias?.trim() ?? "";
  const prefix = alias ? `WIX_BLOG_${alias.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}` : "";
  const legacySusi = alias === "susimacdonald";
  const apiKey = (process.env.WIX_BLOG_API_KEY || process.env.WIX_API_KEY || "").trim();
  const wixSiteId = (prefix ? process.env[`${prefix}_SITE_ID`] : "")
    || (legacySusi ? process.env.WIX_BLOG_SITE_ID || process.env.WIX_SITE_ID : "")
    || (!alias ? process.env.WIX_BLOG_SITE_ID || process.env.WIX_SITE_ID : "")
    || "";
  if (!apiKey || !wixSiteId.trim()) return null;

  const hashtags = (process.env[`${prefix}_HASHTAGS`]
    || (legacySusi ? "RivieraMaya,RealEstate" : ""))
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  return {
    apiKey,
    siteId: wixSiteId.trim(),
    alias,
    language: (prefix ? process.env[`${prefix}_LANGUAGE`] : "")?.trim() || "en",
    authorNickname: (prefix ? process.env[`${prefix}_AUTHOR_NICKNAME`] : "")?.trim()
      || (legacySusi ? "Susi MacDonald" : ""),
    categoryLabel: (prefix ? process.env[`${prefix}_CATEGORY_LABEL`] : "")?.trim()
      || (legacySusi ? "Real Estate Market Updates" : ""),
    hashtags,
  };
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

function textNode(value: string, decorations: unknown[] = []) {
  return {
    type: "TEXT",
    id: randomUUID().replace(/-/g, "").slice(0, 10),
    nodes: [],
    textData: { text: value, decorations },
  };
}

function inlineNodes(value: string): unknown[] {
  const nodes: unknown[] = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(textNode(value.slice(cursor, index)));
    const bold = match[1]?.trim();
    if (bold) nodes.push(textNode(bold, [{ type: "BOLD", fontWeightValue: 700 }]));
    cursor = index + match[0].length;
  }
  if (cursor < value.length) nodes.push(textNode(value.slice(cursor)));
  return nodes.length > 0 ? nodes : [textNode(value)];
}

function paragraph(value: string) {
  return {
    type: "PARAGRAPH",
    id: randomUUID().replace(/-/g, "").slice(0, 10),
    style: { paddingBottom: "18px" },
    nodes: inlineNodes(value),
    paragraphData: { textStyle: { textAlignment: "AUTO" } },
  };
}

function heading(value: string, level: number) {
  return {
    type: "HEADING",
    id: randomUUID().replace(/-/g, "").slice(0, 10),
    style: { paddingTop: "24px", paddingBottom: "8px" },
    nodes: [textNode(value, [{ type: "BOLD", fontWeightValue: 700 }])],
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
  let categoryId: string | null = null;
  if (cfg.categoryLabel) {
    const categories = await wixRequest<{ categories?: Array<{ id: string; label?: string; title?: string }> }>(
      cfg, "GET", `/blog/v3/categories?language=${encodeURIComponent(cfg.language)}&paging.limit=100`,
    );
    const category = (categories.categories ?? []).find((item) =>
      (item.label ?? item.title ?? "").toLowerCase() === cfg.categoryLabel.toLowerCase(),
    );
    if (!category?.id) {
      throw new WixBlogDeliveryError(`Wix category '${cfg.categoryLabel}' was not found`, 502);
    }
    categoryId = category.id;
  }

  const tags = await wixRequest<{ tags?: Array<{ id: string; label?: string }> }>(
    cfg, "GET", `/blog/v3/tags?language=${encodeURIComponent(cfg.language)}&paging.limit=100`,
  );
  if (!cfg.authorNickname) {
    throw new WixBlogDeliveryError("Wix Blog author nickname is not configured for this site", 503);
  }
  const members = await wixRequest<{ members?: Array<{ id: string; profile?: { nickname?: string } }> }>(
    cfg, "GET", "/members/v1/members?fieldsets=PUBLIC&paging.limit=100",
  );
  const member = (members.members ?? []).find((item) =>
    (item.profile?.nickname ?? "").toLowerCase() === cfg.authorNickname.toLowerCase(),
  );
  if (!member?.id) {
    throw new WixBlogDeliveryError(`Wix author member '${cfg.authorNickname}' was not found`, 502);
  }

  return { categoryId, tags: tags.tags ?? [], memberId: member.id };
}

async function slugExists(cfg: WixConfig, slug: string) {
  const result = await wixRequest<{ dataItems?: unknown[] }>(cfg, "POST", "/wix-data/v2/items/query", {
    dataCollectionId: "Blog/Posts",
    query: { filter: { slug }, paging: { limit: 1, offset: 0 } },
    publishPluginOptions: { includeDraftItems: true },
  });
  return (result.dataItems?.length ?? 0) > 0;
}

function withCoverCredit(
  rich: { documentStyle: object; nodes: unknown[] },
  cover: UnsplashCover,
): { documentStyle: object; nodes: unknown[] } {
  const nodes = rich.nodes.filter((node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return true;
    const row = node as Record<string, unknown>;
    if (row.type !== "PARAGRAPH") return true;
    const text = JSON.stringify(row.nodes ?? []);
    return !/Cover photo by .* on Unsplash|Photo by .* on Unsplash/.test(text);
  });
  nodes.push({
    type: "PARAGRAPH",
    id: randomUUID().replace(/-/g, "").slice(0, 10),
    style: { paddingBottom: "18px" },
    nodes: [textNode(`Cover photo by ${cover.photographer} on Unsplash`, [
      {
        type: "LINK",
        linkData: { link: { url: cover.photographerUrl, target: "BLANK", rel: { noreferrer: true } } },
      },
    ])],
    paragraphData: { textStyle: { textAlignment: "AUTO" } },
  });
  return { documentStyle: rich.documentStyle, nodes };
}

function coverQuery(draft: { title: string; primaryQuery: string }): string {
  return (draft.title || draft.primaryQuery).trim();
}

async function importCover(
  cfg: WixConfig,
  draft: { title: string; primaryQuery: string; slug: string },
) {
  const cover = await findUnsplashCover(coverQuery(draft));
  return importUnsplashCover(
    (method, path, body) => wixRequest(cfg, method, path, body),
    cover,
    draft.slug,
  );
}

export async function createWixBlogDraftForDraft(contentDraftId: string) {
  const draft = await db.contentDraft.findUnique({
    where: { id: contentDraftId },
    include: {
      site: { select: { id: true, domain: true } },
      action: { select: { id: true, format: true, primaryQuery: true, status: true } },
    },
  });
  if (!draft) throw new WixBlogDeliveryError("Content draft not found", 404);
  await assertWixBlogExecutor(draft.siteId);
  const cfg = await configForSite(draft.siteId);
  if (!cfg) throw new WixBlogDeliveryError("Wix Blog credentials are not configured for this site", 503);
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
  let importedCover: Awaited<ReturnType<typeof importCover>>;
  try {
    importedCover = await importCover(cfg, draft);
  } catch (error) {
    throw new WixBlogDeliveryError(
      `Cover image could not be prepared: ${error instanceof Error ? error.message : "Unsplash or Wix import failed"}`,
      502,
    );
  }
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
    language: cfg.language,
    categoryIds: cms.categoryId ? [cms.categoryId] : [],
    tagIds,
    hashtags: cfg.hashtags,
    commentingEnabled: true,
    featured: false,
    heroImage: {
      id: importedCover.mediaId,
      url: importedCover.url,
      altText: importedCover.altText,
    },
    richContent: withCoverCredit(markdownToRicos(draft.markdown, draft.title), importedCover.cover),
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
        language: cfg.language,
        readback_verified: true,
      },
    },
  });
}

function blogSlugFromUrl(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(/\/post\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export async function readWixBlogPostBySlug(slug: string, cfg: WixConfig) {

  const result = await wixRequest<{
    dataItems?: Array<{ id?: string; data?: Record<string, unknown> }>;
  }>(cfg, "POST", "/wix-data/v2/items/query", {
    dataCollectionId: "Blog/Posts",
    query: { filter: { slug }, paging: { limit: 1, offset: 0 } },
    publishPluginOptions: { includeDraftItems: true },
  });
  const item = result.dataItems?.[0];
  const data = item?.data ?? {};
  const draftPostId = typeof data.uuid === "string" ? data.uuid : item?.id;
  if (!draftPostId) throw new WixBlogDeliveryError(`Wix Blog post not found for slug ${slug}`, 404);

  const saved = await wixRequest<{
    draftPost?: {
      id?: string;
      title?: string;
      seoSlug?: string;
      status?: string;
      richContent?: { nodes?: unknown[] };
      seoData?: unknown;
      excerpt?: string;
    };
  }>(cfg, "GET", `/blog/v3/draft-posts/${encodeURIComponent(draftPostId)}?fieldsets=RICH_CONTENT`);
  const draftPost = saved.draftPost;
  if (!draftPost?.id) throw new WixBlogDeliveryError("Wix Blog draft post could not be read", 502);

  return {
    id: draftPost.id,
    title: draftPost.title ?? String(data.title ?? ""),
    slug: draftPost.seoSlug ?? slug,
    status: draftPost.status ?? null,
    plainContent: String(data.plainContent ?? ""),
    seoData: draftPost.seoData,
    excerpt: draftPost.excerpt ?? String(data.excerpt ?? ""),
  };
}

async function markActionVerified(actionId: string) {
  const action = await db.researchAction.findUnique({
    where: { id: actionId },
    select: { id: true, status: true },
  });
  if (!action || ["VERIFIED", "DISMISSED", "FAILED"].includes(action.status)) return;
  const pathByStatus: Record<string, ResearchActionStatus[]> = {
    PROPOSED: ["APPROVED", "DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    APPROVED: ["DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    DRAFTING: ["DRAFT_READY", "DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    DRAFT_READY: ["DELIVERY_APPROVED", "DELIVERING", "DELIVERED", "VERIFIED"],
    DELIVERY_APPROVED: ["DELIVERING", "DELIVERED", "VERIFIED"],
    DELIVERING: ["DELIVERED", "VERIFIED"],
    DELIVERED: ["VERIFIED"],
  };
  const { updateResearchAction } = await import("@/lib/research/service");
  for (const status of pathByStatus[action.status] ?? []) {
    await updateResearchAction(action.id, { status }, "wix-blog-publish");
  }
}

export async function publishWixBlogUpdateForDraft(contentDraftId: string, userId: string) {
  const draft = await db.contentDraft.findUnique({
    where: { id: contentDraftId },
    include: {
      site: { select: { id: true, domain: true } },
      action: { select: { id: true, revision: true, targetUrl: true, status: true } },
    },
  });
  if (!draft) throw new WixBlogDeliveryError("Content draft not found", 404);
  await assertWixBlogExecutor(draft.siteId);
  const approvedHash = wixCandidateHash(draft);
  if (!draft.wixApprovalHash || draft.wixApprovalHash !== approvedHash
    || draft.wixApprovedBy !== userId
    || draft.wixApprovedRevision !== draft.action?.revision
    || !draft.wixApprovedAt) {
    throw new WixBlogDeliveryError("This exact candidate has not been approved by the current owner; review and approve it first", 409);
  }
  const cfg = await configForSite(draft.siteId);
  if (!cfg) throw new WixBlogDeliveryError("Wix Blog credentials are not configured for this site", 503);
  if (!draft.action?.targetUrl) throw new WixBlogDeliveryError("This action has no Wix Blog target", 409);
  const slug = blogSlugFromUrl(draft.action.targetUrl);
  if (!slug) throw new WixBlogDeliveryError("The action target is not a Wix Blog post URL", 409);

  const existing = await readWixBlogPostBySlug(slug, cfg);
  const title = existing.title || draft.title;
  let importedCover: Awaited<ReturnType<typeof importCover>>;
  try {
    importedCover = await importCover(cfg, draft);
  } catch (error) {
    throw new WixBlogDeliveryError(
      `Cover image could not be prepared: ${error instanceof Error ? error.message : "Unsplash or Wix import failed"}`,
      502,
    );
  }
  const richContent = withCoverCredit(markdownToRicos(draft.markdown, title), importedCover.cover);
  const updated = await wixRequest<{ draftPost?: { id?: string; title?: string; richContent?: { nodes?: unknown[] } } }>(
    cfg,
    "PATCH",
    `/blog/v3/draft-posts/${encodeURIComponent(existing.id)}?fieldsets=RICH_CONTENT`,
    {
      draftPost: {
        id: existing.id,
        title,
        excerpt: draft.excerpt,
        heroImage: {
          id: importedCover.mediaId,
          url: importedCover.url,
          altText: importedCover.altText,
        },
        richContent,
        seoData: seoData({
          title,
          metaTitle: draft.metaTitle,
          metaDescription: draft.metaDescription,
          primaryQuery: draft.primaryQuery,
        }),
      },
    },
  );
  const verifiedDraft = updated.draftPost;
  if (!verifiedDraft?.id || verifiedDraft.title !== title || !verifiedDraft.richContent?.nodes?.length) {
    throw new WixBlogDeliveryError("Wix Blog update did not pass readback verification", 502);
  }

  await wixRequest<{ draftPost?: { id?: string } }>(
    cfg,
    "POST",
    `/blog/v3/draft-posts/${encodeURIComponent(existing.id)}/publish`,
    { draftPostId: existing.id },
  );
  const published = await wixRequest<{ draftPost?: { id?: string; status?: string } }>(
    cfg,
    "GET",
    `/blog/v3/draft-posts/${encodeURIComponent(existing.id)}`,
  );
  if (published.draftPost?.status && published.draftPost.status !== "PUBLISHED") {
    throw new WixBlogDeliveryError(
      `Wix Blog post did not report PUBLISHED (got ${published.draftPost.status})`,
      502,
    );
  }

  const delivery = await db.delivery.create({
    data: {
      actionId: draft.action.id,
      draftId: draft.id,
      platform: "wix_blog",
      externalId: existing.id,
      status: "PUBLISHED",
      verifiedAt: new Date(),
      payload: {
        post_id: existing.id,
        title,
        slug,
        live_url: draft.action.targetUrl,
        readback_verified: true,
      },
    },
  });
  await markActionVerified(draft.action.id);
  return delivery;
}
