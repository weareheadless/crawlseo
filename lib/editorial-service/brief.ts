import { db } from "@/lib/db";
import { ResearchServiceError } from "@/lib/research/service";

/**
 * Translate a CrawlSEO article proposal into an editorial brief.
 *
 * The brief is the whole contract: editorial never reads this database. The
 * evidence is the site's own crawled pages, addressed by URL so the service
 * fetches and records exactly what it read; CrawlSEO does not ship it a copy.
 */

const STOPWORDS = new Set([
  "avec", "pour", "dans", "cette", "leur", "plus", "sans", "sont", "être",
  "fait", "faire", "tout", "tous", "elle", "nous", "vous", "mais", "comme",
  "page", "site", "create", "article", "durable", "readers", "searching",
  "with", "that", "this", "from", "then", "existing", "high", "level",
]);

function tokens(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/[a-zà-ÿ0-9]{3,}/g) ?? []).filter((token) => !STOPWORDS.has(token)),
  );
}

function overlap(needle: Set<string>, haystack: Set<string>): number {
  let hits = 0;
  for (const token of needle) if (haystack.has(token)) hits += 1;
  return hits;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isBoilerplate(url: string, title: string): boolean {
  const haystack = `${url} ${title}`.toLowerCase();
  return /conditions-generales|politique-de|privacy|terms-of|mentions-legales|cookies|gift-card|\/blog\/tags\/|\/product-page\/|\/shop|\/cart|\/en\//.test(haystack);
}

/** The page whose text best answers the question, then the homepage as context. */
export function selectEvidenceUrls(
  pages: Array<{ url: string; title: string | null; wordCount: number }>,
  topic: string,
  query: string,
  limit = 4,
): string[] {
  const wanted = tokens(topic);
  const queryTokens = tokens(query);
  const score = (page: { url: string; title: string | null; wordCount: number }) => {
    const haystack = `${page.title ?? ""} ${page.url}`;
    // A page that explains a craft is worth more than one that merely mentions
    // the keyword: guides, steps and restoration are what a how-to quotes.
    const editorial = /\/(post|blog)\//.test(page.url) ? 20 : 0;
    const method = /guide|etape|étape|technique|restaur|tapiss|fauteuil|siege|siège/.test(haystack.toLowerCase()) ? 15 : 0;
    return overlap(wanted, tokens(haystack)) * 10
      + overlap(queryTokens, tokens(haystack)) * 40
      + editorial
      + method
      + Math.min(page.wordCount, 2000) / 400;
  };

  const ranked = pages
    .filter((page) => page.wordCount >= 150 && !isBoilerplate(page.url, page.title ?? ""))
    .sort((left, right) => score(right) - score(left));

  const picked: string[] = [];
  for (const page of ranked) {
    if (picked.includes(page.url)) continue;
    picked.push(page.url);
    if (picked.length >= limit) break;
  }

  // The homepage is the one page every site can explain itself with; the
  // ranked pages may already contain it.
  const home = pages.find((page) => {
    try {
      return new URL(page.url).pathname === "/" && !isBoilerplate(page.url, page.title ?? "");
    } catch {
      return false;
    }
  });
  if (home && !picked.includes(home.url) && picked.length < limit) picked.push(home.url);
  return picked;
}

export type EditorialBrief = Record<string, unknown>;

/** Internal paths the brief asks the writer to link, e.g. `/devis`. */
export function internalLinks(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|[\s(«"])(\/[a-z0-9][a-z0-9\-\/]*)/gi)) {
    const path = match[1]?.replace(/\/+$/, "");
    if (path && path.length > 1) found.add(path);
  }
  return [...found].slice(0, 5);
}

function textList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export async function buildEditorialBrief(input: {
  actionId: string;
  operatorInstructions?: string;
  fresh?: boolean;
}): Promise<{ brief: EditorialBrief; tenant: string; locale: string; postUrl: string | null }> {
  const action = await db.researchAction.findUnique({
    where: { id: input.actionId },
    include: {
      site: {
        select: {
          id: true,
          domain: true,
          siteProfile: {
            select: { language: true, country: true, audience: true, topics: true, services: true },
          },
          siteDeliveryConfig: { select: { bridgeAlias: true, adapters: true, enabled: true } },
        },
      },
    },
  });
  if (!action) throw new ResearchServiceError("Research action not found", 404);

  const delivery = action.site.siteDeliveryConfig;
  const adapters = Array.isArray(delivery?.adapters) ? delivery.adapters : [];
  if (!delivery?.enabled || !adapters.includes("wix_blog")) {
    throw new ResearchServiceError("Wix Blog delivery is not enabled for this site", 409);
  }
  const tenant = String(delivery.bridgeAlias);
  if (!tenant) throw new ResearchServiceError("This site has no delivery alias to scope editorial work", 409);

  const crawl = await db.crawl.findFirst({
    where: { siteId: action.site.id, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true, finishedAt: true },
  });
  if (!crawl) throw new ResearchServiceError("No completed crawl is available as evidence for this article", 409);

  const pages = await db.auditPage.findMany({
    where: { crawlId: crawl.id, statusCode: 200, wordCount: { gte: 150 } },
    select: { url: true, title: true, wordCount: true },
    orderBy: { wordCount: "desc" },
  });

  const evidence = (action.evidence ?? {}) as Record<string, unknown>;
  const decision = record(record(evidence.recommendationDecision));
  // The funnel stores the question in the target slug when the opportunity came
  // from a topic map, not in primaryQuery. "comment-retapisser-un-fauteuil" is
  // the question; the title carries internal wording ("Test : …").
  const slugQuery = (() => {
    const url = typeof record(decision.target).url === "string" ? record(decision.target).url as string : "";
    try {
      const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
      return last.replace(/[-_]+/g, " ").trim();
    } catch {
      return "";
    }
  })();
  const query = action.primaryQuery?.trim() || slugQuery;
  // The recommendation names the steps a how-to must cover; the title alone
  // misses pages like "La tapisserie traditionnelle" that hold the method.
  const topic = [
    query,
    action.title,
    typeof decision.action === "string" ? decision.action : "",
    typeof evidence.cluster === "string" ? evidence.cluster : "",
  ]
    .filter(Boolean)
    .join(" ");
  const sourceUrls = selectEvidenceUrls(pages, topic, query, 6);
  if (sourceUrls.length < 2) {
    throw new ResearchServiceError(
      `The last crawl has only ${sourceUrls.length} usable page(s); editorial needs at least two sources`,
      409,
    );
  }

  const profile = action.site.siteProfile;
  const locale = profile?.language || "en";
  const voice = (process.env.EDITORIAL_VOICE ?? "").trim() || tenant.split("-")[0] || "default";
  const recommendation = action.recommendation ?? "";
  const business = {
    name: "",
    domain: action.site.domain,
    audience: textList(profile?.audience).join(", "),
    topics: textList(profile?.topics),
    services: textList(profile?.services),
    location: textList(profile?.country).join(", "),
    locale,
  };
  const requirements = {
    action: recommendation.trim(),
    why_now: typeof decision.whyNow === "string" ? decision.whyNow : "",
    must_link: internalLinks(`${recommendation}\n${typeof decision.action === "string" ? decision.action : ""}`),
  };
  const notes = [recommendation, input.operatorInstructions ?? ""]
    .filter((value) => value.trim())
    .join("\n");

  const brief: EditorialBrief = {
    tenant,
    destination: { adapter: "filesystem", site_id: action.site.id, domain: action.site.domain },
    mode: "brief",
    format: "article",
    locales: [locale],
    business,
    requirements,
    topic: {
      question: query || action.title,
      angle: recommendation,
      primary_keyword: query,
      cluster: typeof evidence.cluster === "string" ? evidence.cluster : "",
      notes,
    },
    evidence: { source_urls: sourceUrls, min_sources: Math.min(2, sourceUrls.length) },
    voice,
    // The URL the funnel proposed is where the post will live, so the writer
    // keeps its slug instead of inventing one or suffixing a retry.
    target: { mode: "new", url: action.targetUrl ?? "" },
    // CrawlSEO owns the owner gate and the publication; editorial stops at the
    // verified artifact so there is exactly one place that can publish.
    policy: {
      approval: "none",
      publish: false,
      min_words: 800,
      max_words: 1600,
      fact_check_rounds: 2,
      on_unverified: "hold",
      deadline_seconds: 900,
    },
    idempotency_key: `crawlseo:action:${action.id}:rev:${action.revision}${input.fresh ? `:retry:${Date.now()}` : ""}`,
    metadata: {
      trigger: { source: "crawlseo", kind: "opportunity", ref: action.id, actor: "crawlseo" },
      site_id: action.site.id,
      action_id: action.id,
      action_revision: action.revision,
      crawl_id: crawl.id,
      intent: typeof evidence.intent === "string" ? evidence.intent : "",
    },
  };

  return { brief, tenant, locale, postUrl: action.targetUrl ?? null };
}
