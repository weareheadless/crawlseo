import { createHash, randomUUID } from "node:crypto";
import type { ResearchActionStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { recordDraftCoverage } from "@/lib/research/question-coverage";
import { findUnsplashCover, importImageAsset, importUnsplashCover, type UnsplashCover } from "@/lib/delivery/unsplash";
import { resolveSiteContext } from "@/lib/site/context";

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
  assets?: unknown;
  action: { id: string; revision: number; targetUrl: string | null } | null;
}) {
  return createHash("sha256").update(JSON.stringify({
    id: draft.id, siteId: draft.siteId, actionId: draft.actionId,
    title: draft.title, slug: draft.slug, metaTitle: draft.metaTitle,
    metaDescription: draft.metaDescription, excerpt: draft.excerpt,
    markdown: draft.markdown,
    assets: draft.assets ?? null,
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
  // A new article has no post URL yet: the slug comes from the draft and the
  // post is created on delivery. An update still targets an existing post.
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
  // Wix is currently the only owner-approval transition for ContentDraft; the
  // coverage service itself is provider-neutral and records the reviewed draft.
  await recordDraftCoverage(contentDraftId);
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
  // Bold and links are the inline forms the writer emits. Everything else
  // stays literal rather than being silently dropped.
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(textNode(value.slice(cursor, index)));
    if (match[1]?.trim()) {
      nodes.push(textNode(match[1].trim(), [{ type: "BOLD", fontWeightValue: 700 }]));
    } else if (match[2]?.trim() && match[3]) {
      nodes.push(textNode(match[2].trim(), [{
        type: "LINK",
        linkData: { link: { url: match[3], target: "BLANK", rel: { noreferrer: true } } },
      }]));
    }
    cursor = index + match[0].length;
  }
  if (cursor < value.length) nodes.push(textNode(value.slice(cursor)));
  return nodes.length > 0 ? nodes : [textNode(value)];
}

function imageNode(image: { mediaId: string; url: string; altText: string; width: number; height: number }) {
  return {
    type: "IMAGE",
    id: randomUUID().replace(/-/g, "").slice(0, 10),
    style: {},
    nodes: [],
    imageData: {
      image: {
        id: image.mediaId,
        url: image.url,
        altText: image.altText,
        width: image.width,
        height: image.height,
      },
      caption: "",
      link: null,
    },
  };
}

function creditParagraph(value: string, url: string) {
  return {
    type: "PARAGRAPH",
    id: randomUUID().replace(/-/g, "").slice(0, 10),
    style: { paddingBottom: "18px" },
    nodes: [{
      type: "TEXT",
      id: randomUUID().replace(/-/g, "").slice(0, 10),
      nodes: [],
      textData: {
        text: value,
        decorations: url
          ? [{ type: "LINK", linkData: { link: { url, target: "BLANK", rel: { noreferrer: true } } } }]
          : [],
      },
    }],
    paragraphData: { textStyle: { textAlignment: "AUTO" } },
  };
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

export function markdownToRicos(
  markdown: string,
  title: string,
  images: Map<string, ImportedInlineImage> = new Map(),
): { documentStyle: object; nodes: unknown[] } {
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
    const imageMarker = line.match(/^<!--\s*image:\s*([A-Za-z0-9_-]+)\s*-->$/);
    if (imageMarker) {
      const image = images.get(imageMarker[1]);
      if (image) {
        nodes.push(imageNode(image));
        if (image.credit) nodes.push(creditParagraph(image.credit, image.creditUrl));
      }
      continue;
    }
    if (/^<!--.*-->$/.test(line)) continue;
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const value = headingMatch[2].trim();
      if (!firstHeadingSkipped && level === 1 && value.toLowerCase() === title.trim().toLowerCase()) {
        firstHeadingSkipped = true;
        continue;
      }
      // The post title is the page H1, so a leading body H1 becomes an H2.
      nodes.push(heading(value, level === 1 ? 2 : Math.min(6, Math.max(2, level))));
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

function coverCreditText(cover: UnsplashCover): string {
  return `Cover photo by ${cover.photographer} on Unsplash`;
}

function withCoverCredit(
  rich: { documentStyle: object; nodes: unknown[] },
  credit: { text: string; url: string },
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
    nodes: [textNode(credit.text, [
      {
        type: "LINK",
        linkData: { link: { url: credit.url, target: "BLANK", rel: { noreferrer: true } } },
      },
    ])],
    paragraphData: { textStyle: { textAlignment: "AUTO" } },
  });
  return { documentStyle: rich.documentStyle, nodes };
}

/**
 * What the cover searches for.
 *
 * The query the article answers is short and concrete, while a title is a whole
 * sentence; Unsplash matches the sentence badly and returns something unrelated.
 */
type PlannedAsset = {
  id: string;
  role: "cover" | "inline";
  source: string;
  url: string;
  width: number;
  height: number;
  alt: string;
  credit: string;
  creditUrl: string;
  photoId: string;
};

function assetText(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function assetNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Images the writer chose, stored on the draft for every connector. */
function plannedAssets(draft: { assets?: unknown }): PlannedAsset[] {
  if (!Array.isArray(draft.assets)) return [];
  const rows: PlannedAsset[] = [];
  for (const row of draft.assets) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const value = row as Record<string, unknown>;
    const url = assetText(value.url);
    if (!url) continue;
    rows.push({
      id: assetText(value.id, `img_${rows.length + 1}`),
      role: value.role === "cover" ? "cover" : "inline",
      source: assetText(value.source, "unsplash"),
      url,
      width: assetNumber(value.width, 1600),
      height: assetNumber(value.height, 1067),
      alt: assetText(value.alt),
      credit: assetText(value.credit),
      creditUrl: assetText(value.credit_url),
      photoId: assetText(value.photo_id),
    });
  }
  return rows;
}

type ImportedInlineImage = {
  mediaId: string;
  url: string;
  altText: string;
  width: number;
  height: number;
  credit: string;
  creditUrl: string;
};

/**
 * Move every inline picture into Wix media before the rich content is built.
 *
 * A picture that cannot be imported is dropped with a warning: a post must
 * still publish without it, and its marker is skipped rather than left as text.
 */
async function prepareInlineImages(
  cfg: WixConfig,
  draft: { slug: string; assets?: unknown },
): Promise<Map<string, ImportedInlineImage>> {
  const images = new Map<string, ImportedInlineImage>();
  for (const asset of plannedAssets(draft)) {
    if (asset.role !== "inline") continue;
    try {
      const imported = await importImageAsset(
        (method, path, body) => wixRequest(cfg, method, path, body),
        { url: asset.url, altText: asset.alt, width: asset.width, height: asset.height },
        `${draft.slug}-${asset.id}.jpg`,
      );
      images.set(asset.id, {
        ...imported,
        width: asset.width,
        height: asset.height,
        credit: asset.credit,
        creditUrl: asset.creditUrl,
      });
    } catch (error) {
      console.warn(`Wix Blog inline image ${asset.id} was skipped`, error);
    }
  }
  return images;
}

function coverQuery(draft: { title: string; primaryQuery: string }): string {
  return (draft.primaryQuery || draft.title).trim();
}

/**
 * The business's own place, for the image fallback.
 *
 * Resolved by the site context like every other site fact, so the cover path and
 * the research path cannot disagree about where this business is.
 */
async function locationForSite(siteId: string): Promise<string | null> {
  const context = await resolveSiteContext(db, siteId).catch(() => null);
  return context?.location ?? null;
}

/** The cover a delivery used, kept so a post's image is auditable later. */
function coverPayload(cover: UnsplashCover) {
  return {
    photo_id: cover.photoId,
    query: cover.query,
    alt_text: cover.altText,
    photographer: cover.photographer,
    photo_url: cover.photoUrl,
  };
}

async function importCover(
  cfg: WixConfig,
  draft: { title: string; primaryQuery: string; slug: string; siteId: string; assets?: unknown },
) {
  const planned = plannedAssets(draft).find((asset) => asset.role === "cover");
  if (planned) {
    const imported = await importImageAsset(
      (method, path, body) => wixRequest(cfg, method, path, body),
      { url: planned.url, altText: planned.alt, width: planned.width, height: planned.height },
      `${draft.slug}-cover.jpg`,
    );
    return {
      ...imported,
      credit: { text: planned.credit || "Photo via Unsplash", url: planned.creditUrl },
      cover: {
        photoId: planned.photoId,
        url: imported.url,
        width: planned.width,
        height: planned.height,
        altText: planned.alt,
        photographer: planned.credit,
        photographerUrl: planned.creditUrl,
        photoUrl: planned.creditUrl,
        downloadLocation: "",
        query: planned.url,
      } satisfies UnsplashCover,
    };
  }
  const cover = await findUnsplashCover(coverQuery(draft), {
    location: await locationForSite(draft.siteId),
    siteId: draft.siteId,
  });
  const imported = await importUnsplashCover(
    (method, path, body) => wixRequest(cfg, method, path, body),
    cover,
    draft.slug,
  );
  return { ...imported, credit: { text: coverCreditText(cover), url: cover.photographerUrl } };
}

export async function createWixBlogDraftForDraft(contentDraftId: string) {
  const draft = await db.contentDraft.findUnique({
    where: { id: contentDraftId },
    include: {
      site: { select: { id: true, domain: true } },
      action: { select: { id: true, format: true, primaryQuery: true, status: true, targetUrl: true, evidence: true } },
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

  // An action that names an existing post updates that post. Creating a draft
  // here would publish a second post at the new slug and leave the original
  // untouched, so the delivery points at the post's own draft instead.
  const targetSlug = draft.action.targetUrl && !proposesNewAsset(draft.action.evidence)
    ? blogSlugFromUrl(draft.action.targetUrl)
    : null;
  if (targetSlug) {
    const post = await readWixBlogPostBySlug(targetSlug, cfg);
    return db.delivery.create({
      data: {
        actionId: draft.action.id,
        draftId: draft.id,
        platform: "wix_blog",
        externalId: post.id,
        status: "DRAFT_VERIFIED",
        verifiedAt: new Date(),
        payload: {
          draft_id: post.id,
          post_id: post.id,
          slug: post.slug,
          mode: "update_existing",
          language: cfg.language,
          readback_verified: true,
        },
      },
    });
  }

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
  const inlineImages = await prepareInlineImages(cfg, draft);
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
    richContent: withCoverCredit(markdownToRicos(draft.markdown, draft.title, inlineImages), importedCover.credit),
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
        cover: coverPayload(importedCover.cover),
      },
    },
  });
}

/**
 * True when the recommendation proposes a post that does not exist yet.
 *
 * Such an action still carries the URL the post will occupy; treating that URL
 * as an existing post sends the lane to the update path and fails.
 */
export function proposesNewAsset(evidence: unknown): boolean {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return false;
  const decision = (evidence as Record<string, unknown>).recommendationDecision;
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return false;
  const target = (decision as Record<string, unknown>).target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return false;
  return (target as Record<string, unknown>).newAsset === true;
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
  if (!action || ["VERIFIED", "FULFILLED", "DISMISSED", "FAILED"].includes(action.status)) return;
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
  if (!draft.action) throw new WixBlogDeliveryError("A linked ResearchAction is required", 409);

  // A post created by this pipeline is published from its own draft id, not by
  // looking a slug up in the published collection. An existing post keeps the
  // slug lookup.
  const createdDraft = await db.delivery.findFirst({
    where: { actionId: draft.action.id, draftId: draft.id, platform: "wix_blog", status: "DRAFT_VERIFIED" },
    orderBy: { createdAt: "desc" },
    select: { externalId: true },
  });
  let existing: { id: string; title: string; slug: string };
  if (createdDraft?.externalId) {
    const saved = await wixRequest<{ draftPost?: { id?: string; title?: string; seoSlug?: string } }>(
      cfg,
      "GET",
      `/blog/v3/draft-posts/${encodeURIComponent(createdDraft.externalId)}`,
    );
    if (!saved.draftPost?.id) throw new WixBlogDeliveryError("The Wix Blog draft could not be read back", 502);
    existing = {
      id: saved.draftPost.id,
      title: saved.draftPost.title ?? draft.title,
      slug: saved.draftPost.seoSlug ?? draft.slug,
    };
  } else {
    if (!draft.action.targetUrl) throw new WixBlogDeliveryError("This action has no Wix Blog target", 409);
    const slug = blogSlugFromUrl(draft.action.targetUrl);
    if (!slug) throw new WixBlogDeliveryError("The action target is not a Wix Blog post URL", 409);
    existing = await readWixBlogPostBySlug(slug, cfg);
  }
  const slug = existing.slug;
  // The approved draft carries the title the update asked for; the existing
  // post keeps its slug, so only the address of the post is preserved.
  const title = draft.title || existing.title;
  let importedCover: Awaited<ReturnType<typeof importCover>>;
  try {
    importedCover = await importCover(cfg, draft);
  } catch (error) {
    throw new WixBlogDeliveryError(
      `Cover image could not be prepared: ${error instanceof Error ? error.message : "Unsplash or Wix import failed"}`,
      502,
    );
  }
  const inlineImages = await prepareInlineImages(cfg, draft);
  const richContent = withCoverCredit(markdownToRicos(draft.markdown, title, inlineImages), importedCover.credit);
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

  const liveUrl = draft.action.targetUrl && blogSlugFromUrl(draft.action.targetUrl)
    ? draft.action.targetUrl
    : `https://${draft.site.domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}/post/${encodeURIComponent(slug)}`;
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
        live_url: liveUrl,
        readback_verified: true,
        cover: coverPayload(importedCover.cover),
      },
    },
  });
  // A new article gains its public URL here, so later updates target the post
  // instead of creating another one.
  if (!draft.action.targetUrl || !blogSlugFromUrl(draft.action.targetUrl)) {
    await db.researchAction.update({ where: { id: draft.action.id }, data: { targetUrl: liveUrl } });
  }
  await markActionVerified(draft.action.id);
  return delivery;
}

/**
 * One human action: approve this exact draft and publish it.
 *
 * A new article is created in Wix Blog first, then published from its own draft
 * id. An existing post is patched and published. The approval hash is bound to
 * the reviewed candidate, so an edit between review and click still fails.
 */
export async function approveAndPublishWixBlogDraft(contentDraftId: string, userId: string) {
  await approveWixBlogUpdateForDraft(contentDraftId, userId);
  await createWixBlogDraftForDraft(contentDraftId);
  return publishWixBlogUpdateForDraft(contentDraftId, userId);
}
