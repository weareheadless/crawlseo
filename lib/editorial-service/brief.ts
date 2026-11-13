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

function isBoilerplate(url: string, title: string): boolean {
  const haystack = `${url} ${title}`.toLowerCase();
  return /conditions-generales|politique-de|privacy|terms-of|mentions-legales|cookies|gift-card/.test(haystack);
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
  const score = (page: { url: string; title: string | null; wordCount: number }) =>
    overlap(wanted, tokens(`${page.title ?? ""} ${page.url}`)) * 10 +
    overlap(queryTokens, tokens(`${page.title ?? ""} ${page.url}`)) * 40 +
    Math.min(page.wordCount, 1500) / 1500;

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
          siteProfile: { select: { language: true } },
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

  const query = action.primaryQuery?.trim() ?? "";
  const evidence = (action.evidence ?? {}) as Record<string, unknown>;
  const topic = `${query} ${action.title}`.trim();
  const sourceUrls = selectEvidenceUrls(pages, topic, query);
  if (sourceUrls.length < 2) {
    throw new ResearchServiceError(
      `The last crawl has only ${sourceUrls.length} usable page(s); editorial needs at least two sources`,
      409,
    );
  }

  const locale = action.site.siteProfile?.language || "en";
  const voice = (process.env.EDITORIAL_VOICE ?? "").trim() || tenant.split("-")[0] || "default";
  const recommendation = action.recommendation ?? "";
  const notes = [recommendation, input.operatorInstructions ?? ""]
    .filter((value) => value.trim())
    .join("\n");

  const brief: EditorialBrief = {
    tenant,
    destination: { adapter: "filesystem", site_id: action.site.id, domain: action.site.domain },
    mode: "brief",
    format: "article",
    locales: [locale],
    topic: {
      question: query || action.title,
      angle: recommendation,
      primary_keyword: query,
      cluster: typeof evidence.cluster === "string" ? evidence.cluster : "",
      notes,
    },
    evidence: { source_urls: sourceUrls, min_sources: Math.min(2, sourceUrls.length) },
    voice,
    target: { mode: "new" },
    // CrawlSEO owns the owner gate and the publication; editorial stops at the
    // verified artifact so there is exactly one place that can publish.
    policy: {
      approval: "none",
      publish: false,
      min_words: 600,
      max_words: 1400,
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
