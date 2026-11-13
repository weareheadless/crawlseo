#!/usr/bin/env node
/**
 * CrawlSEO → editorial → Wix Blog, first test harness.
 *
 * Takes an existing ResearchAction, builds an evidence bundle from the latest
 * crawl, asks editorial to write the article, stores the reviewed artifact as a
 * ContentDraft linked to the action, and (optionally) creates the Wix Blog
 * draft through the existing delivery code.
 *
 * Editorial never publishes in this flow. CrawlSEO keeps the owner approval and
 * the delivery receipt.
 *
 *   EDITORIAL_TOKEN=... DATABASE_URL=... npx tsx scripts/editorial-article.ts \
 *     --site atelier-harmonie.com --action <actionId> --wix-draft
 */
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { db } from "../lib/db";
import { createWixBlogDraftForDraft, WixBlogDeliveryError } from "../lib/delivery/wix-blog";

type Args = {
  site: string;
  action: string;
  editorialUrl: string;
  locale: string;
  voice: string;
  bundleOut: string;
  wixDraft: boolean;
  dryRun: boolean;
  fresh: boolean;
  maxWaitSeconds: number;
};

type EditorialArtifact = {
  locale: string;
  revision: number;
  status: string;
  title: string;
  dek: string;
  slug: string;
  body_markdown: string;
  outline: string[];
  excerpt: string;
  meta_title: string;
  meta_description: string;
  primary_keyword: string;
  tags: string[];
  category: string;
  quote_pull: string;
  content_hash: string;
  claims: Array<{ text: string; verdict: string }>;
  sources: Array<{ id: string; url: string; title: string; sha256: string }>;
  coverage: Record<string, unknown>;
  editorial: Record<string, unknown>;
};

type EditorialPost = {
  id: string;
  state: string;
  error: string;
  artifacts: Record<string, EditorialArtifact>;
  receipts: Array<{ locale: string; verified: boolean; url: string }>;
  events: Array<{ type: string; data: Record<string, unknown>; at: string }>;
};

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const name = item.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  const site = values.get("site") ?? "";
  const action = values.get("action") ?? "";
  if (!site || !action) {
    throw new Error("--site and --action are required");
  }
  return {
    site,
    action,
    editorialUrl: (values.get("editorial-url") ?? process.env.EDITORIAL_URL ?? "http://127.0.0.1:8790").replace(/\/+$/, ""),
    locale: values.get("locale") ?? "",
    voice: values.get("voice") ?? "atelier",
    bundleOut: values.get("bundle-out") ?? `/tmp/opencode/editorial-bundle-${action}.json`,
    wixDraft: flags.has("wix-draft"),
    dryRun: flags.has("dry-run"),
    fresh: flags.has("fresh"),
    maxWaitSeconds: Number(values.get("max-wait") ?? 600),
  };
}

const STOPWORDS = new Set([
  "avec", "pour", "dans", "cette", "leur", "plus", "sans", "sont", "être",
  "fait", "faire", "tout", "tous", "elle", "nous", "vous", "mais", "comme",
  "page", "site", "create", "article", "durable", "readers", "searching",
  "with", "that", "this", "from", "then", "existing", "high", "level",
]);

function tokens(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-zà-ÿ0-9]{3,}/g) ?? []).filter(
      (token) => !STOPWORDS.has(token),
    ),
  );
}

function overlap(needle: Set<string>, haystack: Set<string>): number {
  let hits = 0;
  for (const token of needle) {
    if (haystack.has(token)) hits += 1;
  }
  return hits;
}

function isBoilerplate(url: string, title: string): boolean {
  const haystack = `${url} ${title}`.toLowerCase();
  return /conditions-generales|politique-de|privacy|terms-of|mentions-legales|cookies|gift-card/.test(haystack);
}

function buildBundle(
  pages: Array<{ url: string; title: string | null; wordCount: number; contentText: string | null }>,
  topic: string,
  query: string,
  out: string,
) {
  const wanted = tokens(topic);
  const queryTokens = tokens(query);
  const score = (value: string, wordCount: number, weight: number) =>
    overlap(wanted, tokens(value)) * 10 +
    overlap(queryTokens, tokens(value)) * 40 +
    Math.min(wordCount, 1500) / 1500 * weight;

  const productPage = pages
    .filter((page) => /\/product-page\//.test(page.url))
    .map((page) => ({
      page,
      score: score(`${page.url} ${page.title ?? ""}`, page.wordCount, 1),
    }))
    .sort((a, b) => b.score - a.score)[0]?.page;

  const editorialPage = pages
    .filter((page) => /\/post\//.test(page.url))
    .map((page) => ({
      page,
      score: score(`${page.url} ${page.title ?? ""}`, page.wordCount, 1),
    }))
    .filter((entry) => overlap(wanted, tokens(`${entry.page.url} ${entry.page.title ?? ""}`)) > 0)
    .sort((a, b) => b.score - a.score)[0]?.page;

  const homepage = pages.find((page) => new URL(page.url).pathname === "/");
  const selected = [productPage, editorialPage, homepage]
    .filter((page): page is NonNullable<typeof page> => Boolean(page))
    .filter(
      (page, index, list) =>
        list.findIndex((item) => item.url === page.url) === index &&
        !isBoilerplate(page.url, page.title ?? ""),
    )
    .slice(0, 4);

  const sources = selected
    .filter((page) => (page.contentText ?? "").length >= 500)
    .map((page) => ({
      id: `src_${createHash("sha256").update(page.url).digest("hex").slice(0, 12)}`,
      url: page.url,
      title: page.title ?? page.url,
      publisher: new URL(page.url).hostname,
      published_at: "",
      text: (page.contentText ?? "").slice(0, 12_000),
    }));

  if (sources.length < 2) {
    throw new Error(
      `only ${sources.length} usable crawl page(s) for ${topic}; refusing to ask editorial to write`,
    );
  }
  writeFileSync(out, JSON.stringify({ sources }, null, 2), "utf8");
  return { path: out, sources, productPage };
}

async function editorialFetch(
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.EDITORIAL_TOKEN ?? ""}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 500) };
  }
  return { status: response.status, body };
}

async function waitForPost(
  args: Args,
  postId: string,
  locale: string,
): Promise<EditorialPost> {
  const deadline = Date.now() + args.maxWaitSeconds * 1000;
  let last = "";
  while (Date.now() < deadline) {
    const { status, body } = await editorialFetch(
      `${args.editorialUrl}/v1/posts/${postId}`,
      { method: "GET" },
    );
    if (status !== 200) {
      throw new Error(`editorial GET ${status}: ${JSON.stringify(body).slice(0, 500)}`);
    }
    const post = body as EditorialPost;
    if (post.state !== last) {
      last = post.state;
      const artifact = post.artifacts[locale];
      console.error(
        `editorial ${post.id}: ${post.state}${artifact ? ` (${artifact.title})` : ""}`,
      );
    }
    if (["ready", "published", "held", "failed", "cancelled"].includes(post.state)) {
      return post;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`editorial post ${postId} did not finish within ${args.maxWaitSeconds}s`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.EDITORIAL_TOKEN) {
    throw new Error("EDITORIAL_TOKEN is required");
  }

  const site = await db.site.findFirst({
    where: { domain: args.site, retiredAt: null },
    select: { id: true, domain: true },
  });
  if (!site) throw new Error(`site not found: ${args.site}`);

  const action = await db.researchAction.findFirst({
    where: { id: args.action, siteId: site.id },
  });
  if (!action) throw new Error(`action ${args.action} not found for ${site.domain}`);
  if (["DISMISSED", "FULFILLED", "FAILED"].includes(action.status)) {
    throw new Error(`action ${action.id} is ${action.status}; choose a live proposal`);
  }
  if (action.format !== "article") {
    throw new Error(`action ${action.id} is format=${action.format}; this harness only writes articles`);
  }

  const [profile, delivery, latestCrawl] = await Promise.all([
    db.siteProfile.findUnique({ where: { siteId: site.id }, select: { language: true } }),
    db.siteDeliveryConfig.findUnique({ where: { siteId: site.id }, select: { bridgeAlias: true, adapters: true, enabled: true } }),
    db.crawl.findFirst({
      where: { siteId: site.id, status: "COMPLETED" },
      orderBy: { finishedAt: "desc" },
      select: { id: true, finishedAt: true },
    }),
  ]);
  if (!delivery?.enabled || !Array.isArray(delivery.adapters) || !delivery.adapters.includes("wix_blog")) {
    throw new Error(`Wix Blog delivery is not enabled for ${site.domain}`);
  }
  if (!latestCrawl) throw new Error(`no completed crawl for ${site.domain}`);
  const locale = args.locale || profile?.language || "fr";

  const pages = await db.auditPage.findMany({
    where: { crawlId: latestCrawl.id, statusCode: 200, wordCount: { gte: 150 } },
    select: { url: true, title: true, wordCount: true, contentText: true },
    orderBy: { wordCount: "desc" },
  });

  const evidence = (action.evidence ?? {}) as Record<string, unknown>;
  const query = action.primaryQuery?.trim() || "";
  const recommendation = action.recommendation ?? "";
  const topicText = `${query} ${action.title} abat-jour lampe luminaire atelier DIY`;
  const bundle = buildBundle(pages, topicText, query, args.bundleOut);
  const productUrl = bundle.productPage?.url ?? "";

  const question = query
    ? `Que faut-il savoir avant d'acheter un ${query} ?`
    : action.title;
  const brief = {
    tenant: delivery.bridgeAlias,
    destination: { adapter: "filesystem", site_id: site.id, domain: site.domain },
    mode: "brief",
    format: "article",
    locales: [locale],
    topic: {
      question,
      angle:
        "Guide pratique : ce que contient le produit, à qui il s'adresse, le matériel et le temps nécessaires, " +
        "les erreurs de montage à éviter, et comment entretenir la lampe ensuite.",
      primary_keyword: query,
      cluster: "lampes",
      notes: [
        recommendation,
        productUrl ? `Lien interne à privilégier : ${productUrl}` : "",
        "N'invente ni prix, ni délai, ni dimension absente des sources.",
      ].filter(Boolean).join("\n"),
    },
    evidence: { bundle_path: bundle.path, min_sources: 2 },
    voice: args.voice,
    target: { mode: "new" },
    policy: {
      approval: "owner",
      publish: false,
      min_words: 600,
      max_words: 1000,
      fact_check_rounds: 2,
      on_unverified: "hold",
      deadline_seconds: Math.max(120, args.maxWaitSeconds - 30),
    },
    idempotency_key:
      `crawlseo:action:${action.id}:rev:${action.revision}` +
      (args.fresh ? `:dev:${Date.now()}` : ""),
    metadata: {
      trigger: { source: "crawlseo", kind: "opportunity", ref: action.id, actor: "script" },
      site_id: site.id,
      action_id: action.id,
      action_revision: action.revision,
      crawl_id: latestCrawl.id,
      intent: typeof evidence.intent === "string" ? evidence.intent : "",
    },
  };

  if (args.dryRun) {
    console.log(JSON.stringify({ brief, bundle: { path: bundle.path, sources: bundle.sources.map((source) => source.url) } }, null, 2));
    return;
  }

  const created = await editorialFetch(`${args.editorialUrl}/v1/posts`, {
    method: "POST",
    body: JSON.stringify(brief),
  });
  if (created.status !== 202 && created.status !== 200) {
    throw new Error(`editorial POST ${created.status}: ${JSON.stringify(created.body).slice(0, 800)}`);
  }
  const postId = (created.body as { post_id: string }).post_id;
  const post = await waitForPost(args, postId, locale);
  if (post.state !== "ready" && post.state !== "published") {
    console.error(JSON.stringify(post.events.slice(-8), null, 2));
    throw new Error(`editorial returned ${post.state}: ${post.error}`);
  }

  const artifact = post.artifacts[locale];
  if (!artifact) throw new Error(`editorial post has no ${locale} artifact`);

  const existing = await db.contentDraft.findFirst({
    where: { siteId: site.id, actionId: action.id, provider: "editorial", title: artifact.title },
    select: { id: true, createdAt: true },
  });
  if (existing) {
    console.log(JSON.stringify({ draft_id: existing.id, editorial_post_id: post.id, reused: true }, null, 2));
    return;
  }

  const draft = await db.contentDraft.create({
    data: {
      siteId: site.id,
      actionId: action.id,
      opportunityKey: action.id,
      actionKind: action.kind,
      format: "article",
      primaryQuery: query,
      targetUrl: null,
      intent: typeof evidence.intent === "string" ? evidence.intent : "informational",
      title: artifact.title,
      slug: artifact.slug,
      metaTitle: artifact.meta_title,
      metaDescription: artifact.meta_description,
      excerpt: artifact.excerpt,
      markdown: artifact.body_markdown,
      outline: artifact.outline as unknown as Prisma.InputJsonValue,
      brief: {
        schema_version: 2,
        source: "editorial",
        action: {
          id: action.id,
          revision: action.revision,
          kind: action.kind,
          format: action.format,
          title: action.title,
          primary_query: query,
          target_url: action.targetUrl,
          recommendation,
        },
        editorial: {
          post_id: post.id,
          content_hash: artifact.content_hash,
          revision: artifact.revision,
          writer: String(artifact.editorial?.writer ?? "editorial"),
          model: String(artifact.editorial?.model ?? ""),
          coverage: artifact.coverage,
          claims: {
            supported: artifact.claims.filter((claim) => claim.verdict === "supported").length,
            removed: artifact.claims.filter((claim) => claim.verdict === "removed").length,
            unsupported: artifact.claims.filter((claim) => claim.verdict === "unsupported").length,
          },
          sources: artifact.sources.map((source) => ({
            url: source.url,
            title: source.title,
            sha256: source.sha256,
          })),
          events: post.events.filter((event) => event.type.startsWith("state.") || event.type.startsWith("verification.")).length,
        },
      } as Prisma.InputJsonValue,
      model: `editorial/${String(artifact.editorial?.model ?? "unknown")}`,
      provider: "editorial",
    },
  });

  let wix: { externalId: string; status: string } | null = null;
  let wixError = "";
  if (args.wixDraft) {
    try {
      const deliveryRecord = await createWixBlogDraftForDraft(draft.id);
      wix = { externalId: deliveryRecord.externalId, status: deliveryRecord.status };
    } catch (error) {
      wixError = error instanceof WixBlogDeliveryError
        ? `${error.status}: ${error.message}`
        : String(error);
    }
  }

  console.log(JSON.stringify({
    site: site.domain,
    action_id: action.id,
    editorial_post_id: post.id,
    editorial_state: post.state,
    content_hash: artifact.content_hash,
    title: artifact.title,
    slug: artifact.slug,
    sources: artifact.sources.map((source) => source.url),
    claims: {
      supported: artifact.claims.filter((claim) => claim.verdict === "supported").length,
      removed: artifact.claims.filter((claim) => claim.verdict === "removed").length,
      unsupported: artifact.claims.filter((claim) => claim.verdict === "unsupported").length,
    },
    draft_id: draft.id,
    wix_draft: wix,
    wix_error: wixError || null,
    next:
      "Review in Content Studio, then approve and publish through the existing Wix Blog routes.",
  }, null, 2));
}

main()
  .then(async () => {
    await db.$disconnect();
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await db.$disconnect();
    process.exit(1);
  });
