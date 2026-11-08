import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { storeEvidenceRecord, type MetricValue } from "@/lib/funnel/evidence";
import { businessKnowledgeFields, providerCountry, resolveSiteContext } from "@/lib/site/context";
import { distinctVolume } from "@/lib/research/keyword-identity";
import { jobVerdictIndex, type JobMap } from "@/lib/research/job-map";
import {
  parseMarketScope,
  marketScopeForTopic,
  type MarketScopeConfig,
  type MarketScopeLevel,
} from "@/lib/site/market-scope";
import {
  isBrandTopic,
  normalizePathKey,
  placeMatches,
  topicMatchesQuery,
  type TopicDefinition,
  type TopicIntent,
  type TopicKind,
  type TopicPageType,
  type TopicPageTypeRule,
  type TopicRelevance,
  type TopicTaxonomy,
} from "@/lib/research/topic-taxonomy";

/**
 * Phase 2 topic map.
 *
 * The map is built from the stored monthly bundle and the latest crawl. The
 * deterministic pass is the audit trail: every query membership and every page
 * match comes from a stated term, not from a model. The optional AI call only
 * reviews and names the clusters; it cannot add queries or pages.
 *
 * Storage reuses `DemandMapCluster` and `keyword_universe_membership` evidence.
 * No new table and no opportunity generation.
 */

export type TopicMapDb = PrismaClient;

/**
 * How many unmapped queries the markdown report lists. The map data keeps all
 * of them and the reviewer reads all of them; this only keeps the report
 * readable, and the report says how many it left out.
 */
const UNMAPPED_TABLE_LIMIT = 25;

export type DemandQuery = {
  query: string;
  impressions: number;
  clicks: number;
  position: number | null;
  volume: number | null;
  difficulty: number | null;
  observedAt: Date;
  /**
   * Set by the AI review when the query's geography is judged against the
   * business location and the cluster's market scope. Undefined means "not
   * judged", which is treated as in market.
   */
  inMarket?: boolean;
  marketReason?: string;
};

export type ExcludedQuery = {
  query: string;
  impressions: number;
  reason: string;
};

export type TopicPage = {
  url: string;
  path: string;
  title: string;
  description: string;
  h1: string;
  wordCount: number;
  type: "home" | "service" | "category" | "product" | "blog" | "other";
  text: string;
};

export type TopicCoveragePage = {
  url: string;
  title: string;
  type: TopicPage["type"];
  wordCount: number;
  score: number;
};

export type TopicCluster = {
  slug: string;
  name: string;
  /** Brand topics are the name alone; they need no need word. */
  kind: TopicKind;
  topicSummary: string;
  intent: TopicIntent;
  relevance: TopicRelevance;
  rationale: string;
  actionHint: string;
  marketScope: { scope: MarketScopeLevel; markets: string[]; source: "offer" | "default" };
  confidence: number;
  metrics: {
    queries: number;
    impressions: number;
    clicks: number;
    /** Distinct demand: near-duplicate keywords count once, at their own volume. */
    volume: number;
    /** Raw sum of every keyword's reported volume, kept so the difference is visible. */
    volumeSum: number;
    difficulty: number | null;
    position: number | null;
    aeoQuestions: number;
    aeoCited: number;
  };
  queries: DemandQuery[];
  /** Queries the review placed outside the configured market, kept for audit. */
  excludedQueries: ExcludedQuery[];
  pages: TopicCoveragePage[];
  /** Does a page cover the topic's terms? That is coverage, not visibility. */
  coverage: "strong" | "partial" | "none";
  /** Does the site actually earn impressions for it? */
  visibility: "proven" | "unproven";
  /**
   * The three facts "coverage" was conflating: a page exists, the site earns
   * impressions for it, and the page earns clicks. A page that ranks at 42 is
   * not strong because it exists.
   */
  coverageFacts: { page: boolean; ranks: boolean; converts: boolean };
  /** The language the topic's queries are written in, judged by the review. */
  language: string | null;
  /**
   * Queries that name the topic's place or brand but not its need. They are
   * not counted in the cluster's demand; the count makes the trade-off visible
   * instead of leaving it buried in the global unmapped table.
   */
  contextOnly: {
    queries: number;
    impressions: number;
    volume: number;
    examples: string[];
  };
  /** Deterministic taxonomy defects, e.g. `no-need-word`. */
  reviewFlags: string[];
  gaps: string[];
};

export type UnmappedQuery = {
  query: string;
  impressions: number;
  volume: number | null;
  reason: string;
  /**
   * unowned: qualified demand that no topic owns, the taxonomy's feedback loop.
   * excluded: the job map marked it context, noise or out of market, so it is
   * shown for audit but is not demand to place.
   */
  kind: "unowned" | "excluded";
};

export type TopicMapAi = {
  available: boolean;
  model: string | null;
  summary: string | null;
  review: string | null;
  priorityTopics: string[];
  weakTopics: string[];
  /** Queries the review placed outside their cluster's market. */
  marketExclusions: number;
  error: string | null;
  /** Operational note, e.g. a successful earlier call followed by a failed retry. */
  note?: string | null;
};

export type MarketVerdict = {
  cluster: string;
  query: string;
  inMarket: boolean;
  reason: string;
};

export type TopicMap = {
  siteId: string;
  projectId: string;
  domain: string;
  month: string;
  generatedAt: string;
  locale: { language: string; country: string | null };
  marketScope: MarketScopeConfig;
  /** The tenant model this map was built with. */
  taxonomy: TopicDefinition[];
  business: {
    name: string | null;
    services: string[];
    location: string | null;
    serviceArea: string[];
    audience: string | null;
    differentiators: string[];
  };
  clusters: TopicCluster[];
  unmapped: UnmappedQuery[];
  news: Array<{ title: string; url: string; publishedAt: string | null; excerpt: string | null }>;
  ai: TopicMapAi;
  /** Site-level Search Console totals for the window: the reach gate uses these. */
  site: { impressions: number; clicks: number };
  /** Queries outside this cycle's tranche, counted and left for a later cycle. */
  deferred: {
    count: number;
    impressions: number;
    clicks: number;
    examples: string[];
  };
  counts: {
    queries: number;
    /** Queries the job map judged as demand (or every query when no job map is stored). */
    qualifiedQueries: number;
    /** Queries outside this cycle's tranche; not counted as demand. */
    deferredQueries: number;
    /** Queries the job map marked context, noise or out of market. */
    excludedQueries: number;
    clusteredQueries: number;
    unmappedQueries: number;
    pages: number;
    news: number;
  };
};

export type TopicMapData = {
  site: { id: string; domain: string; projectId: string };
  taxonomy: TopicDefinition[];
  pageTypeRules: TopicPageTypeRule[];
  excludePaths: string[];
  context: Awaited<ReturnType<typeof resolveSiteContext>>;
  fields: Record<string, unknown>;
  marketScope: MarketScopeConfig;
  queries: DemandQuery[];
  pages: TopicPage[];
  aeo: Array<{ question: string; cited: number; observedAt: Date }>;
  news: Array<{ title: string; url: string; publishedAt: string | null; excerpt: string | null }>;
  month: string;
};

/**
 * Tokens that are generic *for this query set*: they appear in most queries, so
 * they describe the market rather than a topic. This replaces a hardcoded list
 * of French craft words that made the map tenant-specific.
 */
function genericTokens(queries: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const query of queries) {
    for (const token of new Set(normalizeTopicText(query).split(" "))) {
      if (token.length < 4) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.ceil(queries.length * 0.4));
  return new Set([...counts.entries()].filter(([, count]) => count >= threshold).map(([token]) => token));
}

export function normalizeTopicText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(text: string, term: string): boolean {
  const normalized = normalizeTopicText(term);
  if (!normalized) return false;
  // The model proposes the forms buyers search. Matching is a normalized
  // word-boundary containment, not a morphology engine.
  return ` ${text} `.includes(` ${normalized} `);
}

function termWeight(text: string, term: string): number {
  const normalized = normalizeTopicText(term);
  if (!normalized || !containsTerm(text, normalized)) return 0;
  return normalized.includes(" ") ? 2 : 1;
}

export function scoreTopicForQuery(query: string, topic: TopicDefinition): number {
  // Membership is the taxonomy's own rule: a market topic needs both its
  // market and its need, a brand topic needs its name. Scoring only ranks the
  // topics that already belong; it never widens membership.
  if (!topicMatchesQuery(topic, query)) return 0;
  const text = normalizeTopicText(query);
  const terms = topic.need?.terms.length ? topic.need.terms : topic.requireAny;
  let score = 0;
  for (const term of terms) score += termWeight(text, term);
  for (const term of topic.strongTerms ?? []) score += termWeight(text, term);
  for (const term of topic.headTerms ?? []) score += termWeight(text, term);
  return score;
}

export function assignQuery(
  query: string,
  taxonomy: TopicDefinition[]
): Array<{ topic: TopicDefinition; score: number }> {
  const scored = taxonomy
    .map((topic, index) => ({ topic, score: scoreTopicForQuery(query, topic), index }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (scored.length === 0) return [];
  const exclusive = scored.find((entry) => entry.topic.exclusive);
  if (exclusive) return [{ topic: exclusive.topic, score: exclusive.score }];
  const primary = scored[0];
  const selected = [primary];
  const text = normalizeTopicText(query);
  for (const candidate of scored.slice(1)) {
    if (selected.length >= 2) break;
    // A secondary topic must have its own strong term, not just the phrase both
    // topics share. Otherwise a bare head term like "abat-jour" is counted in
    // both creation and restoration and inflates both volume totals.
    const hasStrongTerm = (candidate.topic.strongTerms ?? []).some((term) => containsTerm(text, term));
    if (candidate.score >= 2 && hasStrongTerm) {
      selected.push(candidate);
    }
  }
  return selected.map(({ topic, score }) => ({ topic, score }));
}

export function pageType(path: string, rules: TopicPageTypeRule[] = []): TopicPageType {
  if (path === "/") return "home";
  for (const rule of rules) {
    // "/" is the home rule, not a prefix for every path. Without this skip a
    // taxonomy that lists home first classifies the whole site as home, and
    // every product, service and category topic reports no coverage.
    if (rule.pattern === "/") continue;
    if (path.startsWith(rule.pattern)) return rule.type;
  }
  // The model classifies the inventory. A page it did not classify is
  // "other": the map treats an unknown type as unknown, not as a guess.
  return "other";
}

function pageAllowed(page: TopicCoveragePage, kind: TopicDefinition["coverageKind"]): boolean {
  switch (kind) {
    case "service":
      return page.type === "service" || page.type === "category";
    case "product":
      return page.type === "product" || page.type === "category";
    case "content":
      return page.type === "blog" || page.type === "service" || page.type === "category";
    case "brand":
      return page.type === "home" || page.type === "service";
    case "local":
      return page.type === "home" || page.type === "service" || page.type === "category";
    case "business":
      return page.type === "service" || page.type === "category";
    case "mixed":
      return page.type !== "other";
  }
}

function ownerCoveragePage(pages: TopicPage[], topic: TopicDefinition): TopicPage | null {
  const owner = topic.preferredPages?.[0];
  if (!owner) return null;
  // Percent-encoding hex case is not a different page; a model that copies
  // %c3 for %C3 still named the page it read in the inventory.
  const target = normalizePathKey(owner);
  return pages.find((page) => normalizePathKey(page.path) === target || normalizePathKey(page.url).endsWith(target)) ?? null;
}

function coverageLevel(owner: TopicPage | null, topic: TopicDefinition): TopicCluster["coverage"] {
  // The owner page is the coverage. A topic with no owner has none; a thin
  // owner is partial. Whether the owner is the ideal page *type* is a separate
  // gap, so a substantive blog post still covers the topic it owns.
  if (!owner) return "none";
  const minWords = topic.coverageKind === "content" ? 100 : 200;
  return owner.wordCount >= minWords ? "strong" : "partial";
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export { canonicalKeyword, distinctVolume } from "@/lib/research/keyword-identity";

export function clusterMetrics(
  queries: DemandQuery[],
  aeo: { questions: number; cited: number } = { questions: 0, cited: 0 }
): TopicCluster["metrics"] {
  return {
    queries: queries.length,
    impressions: queries.reduce((sum, query) => sum + query.impressions, 0),
    clicks: queries.reduce((sum, query) => sum + query.clicks, 0),
    volume: distinctVolume(queries),
    volumeSum: queries.reduce((sum, query) => sum + (query.volume ?? 0), 0),
    difficulty: average(queries.flatMap((query) => (query.difficulty == null ? [] : [query.difficulty]))),
    position: weightedPosition(queries),
    aeoQuestions: aeo.questions,
    aeoCited: aeo.cited,
  };
}

function weightedPosition(queries: DemandQuery[]): number | null {
  const withPosition = queries.filter((query) => query.position != null);
  if (withPosition.length === 0) return null;
  const totalImpressions = withPosition.reduce((sum, query) => sum + Math.max(1, query.impressions), 0);
  const weighted = withPosition.reduce((sum, query) => sum + (query.position as number) * Math.max(1, query.impressions), 0);
  return weighted / totalImpressions;
}

export function missingQueryTerms(queries: DemandQuery[], pages: TopicCoveragePage[]): Array<{ term: string; count: number; impressions: number }> {
  const pageText = pages.map((page) => normalizeTopicText(page.title + " " + page.url)).join(" ");
  const generic = genericTokens(queries.map((query) => query.query));
  const byTerm = new Map<string, { count: number; impressions: number }>();
  for (const query of queries) {
    const tokens = new Set(
      normalizeTopicText(query.query)
        .split(" ")
        .filter((token) => token.length >= 4 && !generic.has(token))
    );
    for (const token of tokens) {
      if (containsTerm(pageText, token)) continue;
      const entry = byTerm.get(token) ?? { count: 0, impressions: 0 };
      entry.count += 1;
      entry.impressions += query.impressions;
      byTerm.set(token, entry);
    }
  }
  return [...byTerm.entries()]
    .map(([term, entry]) => ({ term, ...entry }))
    .filter((entry) => entry.count >= 1 && entry.impressions >= 10)
    .sort((a, b) => b.impressions - a.impressions || b.count - a.count)
    .slice(0, 6);
}

function buildGaps(input: {
  topic: TopicDefinition;
  queries: DemandQuery[];
  pages: TopicCoveragePage[];
  allPages: TopicCoveragePage[];
  coverage: TopicCluster["coverage"];
}): string[] {
  const gaps: string[] = [];
  const { topic, queries, pages, allPages, coverage } = input;
  if (queries.length === 0) {
    gaps.push("No measured query demand in the current Search Console window; keep as a business-knowledge topic, not an SEO priority.");
    return gaps;
  }
  if (coverage === "none") {
    gaps.push("No page covers this topic.");
  } else {
    // Coverage is the owner page; the page type is a separate quality signal.
    // A blog post that owns a service topic covers it, but the site still has
    // no service page for it. An owner the classifier cannot type is not
    // evidence of absence, so it does not produce that gap.
    const expected = expectedPageLabel(topic.coverageKind);
    const hasExpected = pages.some((page) => pageAllowed(page, topic.coverageKind));
    const typeUnknown = pages.length > 0 && pages.every((page) => page.type === "other");
    if (!hasExpected && !typeUnknown) {
      gaps.push(`Coverage exists, but there is no ${expected} page for this topic.`);
    } else if (coverage === "partial") {
      gaps.push("Coverage exists but is not strong enough to own the topic.");
    }
  }
  const thin = allPages.find(
    (page) =>
      pageAllowed(page, topic.coverageKind) &&
      (page.type === "service" || page.type === "category") &&
      page.wordCount > 0 &&
      page.wordCount < 200
  );
  if (thin) {
    gaps.push(`Thin coverage: ${thin.url} has ${thin.wordCount} words.`);
  }
  // Missing terms are checked against every page that matched the topic, not
  // only the four shown in the report. A product page for a pagode shade counts
  // as coverage even when the category page is the one displayed.
  const missing = missingQueryTerms(queries, allPages);
  for (const entry of missing.slice(0, 4)) {
    gaps.push(`Queries mention “${entry.term}” (${entry.count} ${entry.count === 1 ? "query" : "queries"}, ${entry.impressions} impressions) but no matched page does.`);
  }
  if (topic.relevance === "low" && coverage !== "none") {
    gaps.push("Low commercial relevance; treat as supporting content rather than a revenue topic.");
  }
  return gaps;
}

function expectedPageLabel(kind: TopicDefinition["coverageKind"]): string {
  switch (kind) {
    case "service":
      return "service or category";
    case "product":
      return "product or category";
    case "content":
      return "article or blog";
    case "local":
      return "local service";
    case "brand":
      return "brand";
    case "business":
      return "professional";
    case "mixed":
      return "service, product or article";
  }
}

export async function loadTopicMapData(
  db: TopicMapDb,
  siteId: string,
  month: string,
  taxonomy: TopicTaxonomy | null = null
): Promise<TopicMapData> {
  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { id: true, domain: true, projectId: true },
  });
  if (!site?.projectId) throw new Error("site is not attached to a project");
  const projectId = site.projectId;
  const context = await resolveSiteContext(db, siteId);
  const fields = await businessKnowledgeFields(db, projectId);

  const [rankRows, metricRows, crawl, bundleRun, aeoRows, profile] = await Promise.all([
    db.evidenceRecord.findMany({
      where: { projectId, siteId, kind: "keyword_rank", supersededById: null },
      select: { dimensions: true, metrics: true, observedAt: true },
    }),
    db.evidenceRecord.findMany({
      where: { projectId, siteId, kind: "keyword_metrics", supersededById: null },
      select: { dimensions: true, metrics: true, observedAt: true },
      orderBy: { observedAt: "desc" },
    }),
    db.crawl.findFirst({
      where: { siteId, status: "COMPLETED" },
      orderBy: { finishedAt: "desc" },
      select: { id: true },
    }),
    db.researchRun.findFirst({
      where: { siteId, idempotencyKey: `monthly:${siteId}:${month}:bundle` },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
    db.evidenceRecord.findMany({
      where: {
        projectId,
        siteId,
        kind: "ai_visibility_observation",
        supersededById: null,
        dimensions: { path: ["surface"], equals: "google_ai_overview" },
      },
      select: { dimensions: true, metrics: true, observedAt: true },
    }),
    db.siteProfile.findUnique({ where: { siteId }, select: { constraints: true } }),
  ]);
  const constraints = profile?.constraints && typeof profile.constraints === "object" && !Array.isArray(profile.constraints)
    ? (profile.constraints as Record<string, unknown>)
    : {};
  const marketScope = parseMarketScope(constraints.marketScope);

  const byQuery = new Map<string, DemandQuery>();
  for (const row of rankRows) {
    const dims = asRecord(row.dimensions);
    const metrics = asRecord(row.metrics);
    if (typeof dims.query !== "string" || dims.windowRole === "previous") continue;
    const impressions = numberValue(asRecord(metrics["first_party:impressions"]).value);
    const clicks = numberValue(asRecord(metrics["first_party:clicks"]).value);
    const position = numberValue(asRecord(metrics["first_party:position"]).value);
    const existing = byQuery.get(dims.query);
    if (existing) {
      existing.impressions += impressions;
      existing.clicks += clicks;
      if (position != null) existing.position = existing.position == null ? position : (existing.position + position) / 2;
      if (row.observedAt > existing.observedAt) existing.observedAt = row.observedAt;
    } else {
      byQuery.set(dims.query, {
        query: dims.query,
        impressions,
        clicks,
        position,
        volume: null,
        difficulty: null,
        observedAt: row.observedAt,
      });
    }
  }

  const metricsByQuery = new Map<string, { volume: number | null; difficulty: number | null }>();
  for (const row of metricRows) {
    const dims = asRecord(row.dimensions);
    const metrics = asRecord(row.metrics);
    if (typeof dims.query !== "string") continue;
    if (!metricsByQuery.has(dims.query)) {
      metricsByQuery.set(dims.query, {
        volume: nullableNumber(asRecord(metrics["provider:volume"]).value),
        difficulty: nullableNumber(asRecord(metrics["provider:difficulty"]).value),
      });
    }
  }
  for (const query of byQuery.values()) {
    const metric = metricsByQuery.get(query.query);
    if (metric) {
      query.volume = metric.volume;
      query.difficulty = metric.difficulty;
    }
  }
  // A provider keyword can be real demand even when Search Console has no row
  // for it (privacy limits, no impressions yet, or a head term the site does not
  // rank for). Keep it, with zero first-party impressions, so the map does not
  // hide the highest-volume phrase in the bundle.
  const metricOnlyObservedAt = new Date(`${month}-01T00:00:00.000Z`);
  for (const [query, metric] of metricsByQuery) {
    if (byQuery.has(query)) continue;
    byQuery.set(query, {
      query,
      impressions: 0,
      clicks: 0,
      position: null,
      volume: metric.volume,
      difficulty: metric.difficulty,
      observedAt: metricOnlyObservedAt,
    });
  }

  const auditPages = crawl
    ? await db.auditPage.findMany({
        where: { crawlId: crawl.id, statusCode: 200 },
        select: { url: true, title: true, description: true, h1s: true, wordCount: true },
        orderBy: { url: "asc" },
      })
    : [];

  const pages: TopicPage[] = auditPages.flatMap((page) => {
    let path: string;
    try {
      path = new URL(page.url).pathname.replace(/\/$/, "") || "/";
    } catch {
      return [];
    }
    if (taxonomy?.excludePaths.some((pattern) => path.startsWith(pattern))) return [];
    if (path.includes("?")) return [];
    const h1s = Array.isArray(page.h1s)
      ? page.h1s.filter((value): value is string => typeof value === "string")
      : [];
    const h1 = h1s.join(" | ");
    // URL, title and H1 are the page's declared topic. The description is
    // marketing copy that often names every service, so it is kept for the
    // report but not used to decide coverage.
    const text = normalizeTopicText(`${path} ${page.title ?? ""} ${h1}`);
    return [{
      url: page.url,
      path,
      title: page.title ?? "",
      description: page.description ?? "",
      h1,
      wordCount: page.wordCount,
      type: pageType(path, taxonomy?.pageTypeRules ?? []),
      text,
    }];
  });

  const news = bundleRun
    ? (await db.researchSource.findMany({
        where: { runId: bundleRun.id },
        select: { title: true, url: true, publishedAt: true, excerpt: true },
        orderBy: { publishedAt: "desc" },
        take: 20,
      })).map((row) => ({
        title: row.title ?? "",
        url: row.url,
        publishedAt: row.publishedAt?.toISOString() ?? null,
        excerpt: row.excerpt,
      }))
    : [];

  const aeo = aeoRows.flatMap((row) => {
    const dims = asRecord(row.dimensions);
    const metrics = asRecord(row.metrics);
    if (typeof dims.question !== "string") return [];
    return [{
      question: dims.question,
      cited: numberValue(asRecord(metrics["provider:citedCount"]).value),
      observedAt: row.observedAt,
    }];
  });

  return {
    site: { id: site.id, domain: site.domain, projectId },
    taxonomy: taxonomy?.topics ?? [],
    pageTypeRules: taxonomy?.pageTypeRules ?? [],
    excludePaths: taxonomy?.excludePaths ?? [],
    context,
    fields,
    marketScope,
    queries: [...byQuery.values()].sort((a, b) => b.impressions - a.impressions),
    pages,
    aeo,
    news,
    month,
  };
}

export function buildTopicMap(
  data: TopicMapData,
  taxonomy: TopicDefinition[],
  now = new Date(),
  jobMap: JobMap | null = null
): TopicMap {
  // Demand is judged demand, not "not excluded". A query outside this cycle's
  // tranche has no verdict; it is deferred and counted, never treated as
  // understood demand. Without a job map (legacy) every query stays in.
  const verdictIndex = jobVerdictIndex(jobMap);
  // A job map with no verdict is a failed pass, not an absent one: everything
  // is then deferred and reported, instead of silently counting as demand.
  const hasJobMap = jobMap != null;
  const jobBySlug = new Map((jobMap?.jobs ?? []).map((job) => [job.slug, job]));
  const qualifiedQueries = hasJobMap
    ? data.queries.filter((query) => verdictIndex.get(query.query)?.verdict === "demand")
    : data.queries;
  const deferredQueries = hasJobMap
    ? data.queries.filter((query) => !verdictIndex.has(query.query))
    : [];
  const excludedQueries = hasJobMap
    ? data.queries.filter((query) => {
        const verdict = verdictIndex.get(query.query);
        return verdict != null && verdict.verdict !== "demand";
      })
    : [];
  const deferred = {
    count: deferredQueries.length,
    impressions: deferredQueries.reduce((sum, query) => sum + query.impressions, 0),
    clicks: deferredQueries.reduce((sum, query) => sum + (query.clicks ?? 0), 0),
    examples: deferredQueries.slice(0, 10).map((query) => query.query),
  };
  const site = {
    impressions: data.queries.reduce((sum, query) => sum + query.impressions, 0),
    clicks: data.queries.reduce((sum, query) => sum + (query.clicks ?? 0), 0),
  };
  // The taxonomy is already one topic per job. There is nothing to merge or
  // normalise: a code-side merge would be a second decision about meaning.
  const topics = taxonomy;
  // A topic that rolls up a job owns that job's demand by the job map's own
  // verdict, not by string matching: "torre 25" names no place, yet the job map
  // decided it is demand for the Torre 25 job. The code joins the two model
  // judgments; it does not re-decide the meaning.
  const topicsByJob = new Map<string, TopicDefinition[]>();
  for (const topic of topics) {
    if (!topic.jobSlug) continue;
    topicsByJob.set(topic.jobSlug, [...(topicsByJob.get(topic.jobSlug) ?? []), topic]);
  }
  const assignments = new Map<string, Array<{ topic: TopicDefinition; score: number }>>();
  for (const query of qualifiedQueries) {
    const verdict = verdictIndex.get(query.query);
    const jobSlug = verdict?.verdict === "demand" ? verdict.job : null;
    let assigned = assignQuery(query.query, topics);
    if (jobSlug) {
      const jobTopics = topicsByJob.get(jobSlug) ?? [];
      if (jobTopics.length > 0) {
        // The job map decides which job this query serves. A lexical match to
        // a topic for a different job must not steal it.
        assigned = assigned.filter((entry) => !entry.topic.jobSlug || entry.topic.jobSlug === jobSlug);
        for (const topic of jobTopics) {
          if (!assigned.some((entry) => entry.topic.slug === topic.slug)) assigned.push({ topic, score: 1 });
        }
      }
    }
    if (assigned.length > 0) assignments.set(query.query, assigned);
  }

  const clusters: TopicCluster[] = topics.map((topic) => {
    const queries = qualifiedQueries.filter((query) => assignments.get(query.query)?.some((entry) => entry.topic.slug === topic.slug));
    // Context-only demand names the topic's market but not its need, and no
    // other topic owns it. It is the taxonomy's own gap signal: a place-scoped
    // topic that leaves real demand unowned is incomplete, and the board says
    // so instead of burying the queries in the global unmapped table.
    const contextOnlyQueries = !isBrandTopic(topic) && topic.market && topic.market.scope !== "international"
      ? qualifiedQueries.filter((query) => {
          const text = normalizeTopicText(query.query);
          if (topicMatchesQuery(topic, query.query)) return false;
          if (!placeMatches(topic, text)) return false;
          // A query another topic already owns is not a gap for this one: the
          // rentals topic owning "playa del carmen rentals" is the split
          // working, not the condos topic missing demand.
          return !assignments.get(query.query)?.some((entry) => entry.topic.slug !== topic.slug);
        })
      : [];
    // The owner page is the coverage. A topic with no owner has none; a thin
    // owner is partial. Coverage is not re-inferred from words on other pages.
    const owner = ownerCoveragePage(data.pages, topic);
    const pages: TopicCoveragePage[] = owner
      ? [{ url: owner.url, title: owner.title, type: owner.type, wordCount: owner.wordCount, score: 10 }]
      : [];
    const allPages = pages;
    const coverage = coverageLevel(owner, topic);
    const aeo = data.aeo.filter((row) => assignQuery(row.question, taxonomy).some((entry) => entry.topic.slug === topic.slug));
    const metrics = clusterMetrics(queries, {
      questions: aeo.length,
      cited: aeo.reduce((sum, row) => sum + row.cited, 0),
    });
    const gaps = buildGaps({ topic, queries, pages, allPages, coverage });
    // Coverage says a page matches the topic's terms; it says nothing about the
    // site earning anything for them. A page that matches and earns nothing is
    // unproven, and calling it "strong" tells the owner to leave it alone.
    const visibility: TopicCluster["visibility"] = metrics.impressions > 0 || metrics.clicks > 0 ? "proven" : "unproven";
    const scope = marketScopeForTopic(data.marketScope, topic.offerKey);
    const demandScore = Math.log10(metrics.impressions + metrics.volume + 1) / 4;
    const confidence = Math.min(1, 0.35 + demandScore + (coverage === "strong" ? 0.15 : coverage === "partial" ? 0.05 : 0));
    return {
      slug: topic.slug,
      name: topic.name,
      kind: isBrandTopic(topic) ? "brand" : "market",
      // The prose is the model's reason for the topic. The counts, coverage and
      // visibility are rendered as facts next to it, not folded into a sentence
      // that reads like a keyword-cluster label.
      topicSummary: topic.rationale?.trim() || `${metrics.queries} queries, ${metrics.impressions} impressions; coverage ${coverage}, visibility ${visibility}; ${gaps.length} gap${gaps.length === 1 ? "" : "s"}.`,
      intent: topic.intent,
      relevance: topic.relevance,
      rationale: topic.rationale,
      actionHint: topic.actionHint,
      marketScope: scope,
      confidence,
      metrics,
      queries: queries.sort((a, b) => b.impressions - a.impressions || (b.volume ?? 0) - (a.volume ?? 0)),
      excludedQueries: [],
      pages,
      coverage,
      visibility,
      coverageFacts: {
        page: pages.length > 0,
        ranks: visibility === "proven",
        converts: metrics.clicks > 0,
      },
      language: null,
      contextOnly: {
        queries: contextOnlyQueries.length,
        impressions: contextOnlyQueries.reduce((sum, query) => sum + query.impressions, 0),
        volume: distinctVolume(contextOnlyQueries),
        examples: contextOnlyQueries.slice(0, 3).map((query) => query.query),
      },
      reviewFlags: [
        ...new Set([
          ...(topic.reviewFlags ?? []),
          // A market topic with no need word is defined only by its place and
          // would claim every query that names it. It is a taxonomy defect,
          // not an opportunity, until the need is supplied.
          ...(!isBrandTopic(topic) && (topic.need?.terms.length ?? 0) === 0 ? ["no-need-word"] : []),
        ]),
      ],
      gaps,
    };
  });

  // Every unmapped query stays in the map: the reviewer's job includes spotting
  // a missing topic, and the report states how many rows it shows. A slice here
  // once hid real demand from both the report and the review.
  const unmapped = [
    ...qualifiedQueries
      .filter((query) => !assignments.has(query.query))
      .map((query) => {
        const verdict = verdictIndex.get(query.query);
        if (verdict?.verdict === "demand") {
          const job = jobBySlug.get(verdict.job ?? "");
          return {
            query: query.query,
            impressions: query.impressions,
            volume: query.volume,
            reason: `demand for job "${verdict.job ?? "unknown"}"${job ? ` (businessFit ${job.businessFit})` : ""} but no topic owns it`,
            kind: "unowned" as const,
          };
        }
        return {
          query: query.query,
          impressions: query.impressions,
          volume: query.volume,
          reason: offBusinessReason(query.query),
          kind: "unowned" as const,
        };
      }),
    // Queries the job map removed from demand stay visible with the verdict
    // that removed them, so the subtraction is auditable.
    ...excludedQueries.map((query) => {
      const verdict = verdictIndex.get(query.query);
      return {
        query: query.query,
        impressions: query.impressions,
        volume: query.volume,
        reason: `${verdict?.verdict ?? "not demand"}${verdict?.reason ? `: ${verdict.reason}` : ""}`,
        kind: "excluded" as const,
      };
    }),
  ].sort((a, b) => b.impressions - a.impressions || (b.volume ?? 0) - (a.volume ?? 0));

  return {
    siteId: data.site.id,
    projectId: data.site.projectId,
    domain: data.site.domain,
    month: data.month,
    generatedAt: now.toISOString(),
    taxonomy: topics,
    locale: { language: data.context.language, country: providerCountry(data.context) },
    marketScope: data.marketScope,
    business: {
      name: fieldText(data.fields, "businessName"),
      services: fieldList(data.fields, "services"),
      location: fieldText(data.fields, "location"),
      serviceArea: fieldList(data.fields, "serviceArea"),
      audience: fieldText(data.fields, "audienceMotivations"),
      differentiators: fieldList(data.fields, "differentiators"),
    },
    clusters: clusters.sort((a, b) => relevanceRank(b.relevance) - relevanceRank(a.relevance) || b.metrics.impressions - a.metrics.impressions),
    unmapped,
    news: data.news,
    ai: {
      available: false,
      model: null,
      summary: null,
      review: null,
      priorityTopics: [],
      weakTopics: [],
      marketExclusions: 0,
      error: null,
    },
    site,
    deferred,
    counts: {
      queries: data.queries.length,
      qualifiedQueries: qualifiedQueries.length,
      deferredQueries: deferredQueries.length,
      excludedQueries: excludedQueries.length,
      clusteredQueries: [...assignments.keys()].length,
      unmappedQueries: qualifiedQueries.filter((query) => !assignments.has(query.query)).length,
      pages: data.pages.length,
      news: data.news.length,
    },
  };
}

function relevanceRank(relevance: TopicRelevance): number {
  return { high: 3, medium: 2, low: 1 }[relevance];
}

function offBusinessReason(query: string): string {
  // The taxonomy is the only matching rule. Whether an unmatched query is
  // adjacent demand or research noise is a judgement the review call makes;
  // code does not carry a list of a tenant's products to decide it.
  return `No taxonomy topic matched “${query}”; review for a missing topic or an off-business query.`;
}

/**
 * Apply the review's geography verdicts to the map.
 *
 * A verdict is scoped to a cluster, because the same query can belong to a
 * local offer and to a national one: "restauration fauteuil <distant town>"
 * is out of market for the local cluster and still valid demand for the
 * restoration cluster. Excluded queries stay on the cluster for audit and are
 * removed from `queries`, so demand totals and evidence selection use only the
 * market the owner configured.
 */
export function applyMarketVerdicts(map: TopicMap, verdicts: MarketVerdict[]): number {
  const byKey = new Map(
    verdicts.map((verdict) => [`${verdict.cluster}|${normalizeTopicText(verdict.query)}`, verdict])
  );
  let excluded = 0;
  for (const cluster of map.clusters) {
    const kept: DemandQuery[] = [];
    const dropped: ExcludedQuery[] = [];
    for (const query of cluster.queries) {
      const verdict = byKey.get(`${cluster.slug}|${normalizeTopicText(query.query)}`);
      if (verdict && !verdict.inMarket) {
        dropped.push({ query: query.query, impressions: query.impressions, reason: verdict.reason });
        excluded += 1;
        continue;
      }
      kept.push(verdict ? { ...query, inMarket: true, marketReason: verdict.reason } : query);
    }
    if (dropped.length === 0) continue;
    cluster.queries = kept;
    cluster.excludedQueries = [...cluster.excludedQueries, ...dropped];
    cluster.metrics = clusterMetrics(kept, {
      questions: cluster.metrics.aeoQuestions,
      cited: cluster.metrics.aeoCited,
    });
    cluster.topicSummary = `${cluster.metrics.queries} queries, ${cluster.metrics.impressions} impressions; coverage ${cluster.coverage}, visibility ${cluster.visibility}; ${cluster.gaps.length} gap${cluster.gaps.length === 1 ? "" : "s"}; ${cluster.excludedQueries.length} out-of-market ${cluster.excludedQueries.length === 1 ? "query" : "queries"}.`;
  }
  return excluded;
}

export async function synthesizeTopicMap(
  map: TopicMap,
  business: TopicMap["business"]
): Promise<TopicMapAi> {
  const config = contentWriterConfig();
  if (!config) {
    return {
      available: false,
      model: null,
      summary: null,
      review: null,
      priorityTopics: [],
      weakTopics: [],
      marketExclusions: 0,
      error: "CONTENT_LLM_API_KEY is not configured",
    };
  }

  // Every topic is reviewed. A demand-ranked cut would silently drop the
  // smallest topic from the review, and the smallest topic is often the one
  // whose owner page is wrong.
  const rankedClusters = [...map.clusters].sort(
    (a, b) => b.metrics.impressions + b.metrics.volume - (a.metrics.impressions + a.metrics.volume)
  );
  // The local cluster is often the weakest by volume. Every cluster with a
  // bounded market is sent, with its queries, because geography is judged from
  // the query text, not from demand size.
  const reviewClusters = rankedClusters;
  const payload = {
    site: map.domain,
    business: {
      name: business.name,
      services: business.services,
      location: business.location,
      serviceArea: business.serviceArea,
    },
    clusters: reviewClusters.map((cluster) => ({
      slug: cluster.slug,
      name: cluster.name,
      kind: cluster.kind,
      intent: cluster.intent,
      relevance: cluster.relevance,
      coverage: cluster.coverage,
      marketScope: cluster.marketScope,
      demand: `${cluster.metrics.queries} queries, ${cluster.metrics.impressions} impressions, ${cluster.metrics.volume} distinct monthly demand (${cluster.metrics.volumeSum} summed across keyword variants)`,
      contextOnly: cluster.contextOnly,
      reviewFlags: cluster.reviewFlags,
      gaps: cluster.gaps.slice(0, 2),
      queries: cluster.queries.slice(0, 10).map((query) => ({
        query: query.query,
        impressions: query.impressions,
        position: query.position == null ? null : Number(query.position.toFixed(1)),
      })),
    })),
    // Every unmapped query: the reviewer's job includes spotting a missing
    // topic, which it cannot do from a sample of five.
    unmapped: map.unmapped.map((query) => query.query),
  };

  const system = [
    "You are an SEO reviewer for the business described in the payload.",
    "Judge it by the supplied business facts. Do not assume its trade: a craft workshop, a property agency and a dive school need different pages.",
    "Review the supplied topic map. Use only the supplied clusters, slugs and facts; do not invent queries, pages or metrics.",
    "Respect each cluster's marketScope. A local offer is local; a national or international offer is not limited to the business location. Do not assume every offer is local.",
    "For every query in a cluster whose marketScope is local or national, decide whether the place it names is inside the business's market. Use business.location and business.serviceArea as the business's real geography: a place outside them is out of market, however large its demand. A query that names no place is in market.",
    "Do not use a radius or a fixed list of cities; judge the place the query names against the business's location and service area.",
    "Say which topics are worth doing first and which are weak or off-area.",
    "A weak topic has low measured demand, not no opportunity. If a weak topic is business-relevant, say what expansion or small test would validate it.",
    "A topic flagged no-need-word is defined only by place or brand: do not treat it as an opportunity. Say that its taxonomy needs a need word.",
    "A topic whose kind is brand is the business's own name. It is complete as a name: do not ask for a need word and do not treat the name alone as a taxonomy defect. Judge whether its page earns the brand query.",
    "A cluster's contextOnly count is demand that names its place or brand but not its need. Treat it as evidence of a missing need term or a separate audience, not as demand the topic owns.",
    "For every cluster, set language to the ISO 639-1 code of the language its queries are written in (for example en, es, fr). If the queries mix languages, use the dominant one. This is a fact about the demand, not a preference.",
    "Return exactly one JSON object: { map_summary: string, seo_review: string, clusters: [{ slug: string, name: string, rationale: string, intent: string, relevance: string, coverage: string, confidence: number, language: string, gaps: string[] }], priority_topics: string[], weak_topics: string[], market_verdicts: [{ cluster: string, query: string, in_market: boolean, reason: string }] }.",
    "priority_topics and weak_topics must use only the supplied slugs. At most 5 priority topics and at most 4 weak topics.",
    "market_verdicts must use only the supplied cluster slugs and query strings. Omit a query you cannot place. Keep each reason under 140 characters.",
    "Keep map_summary under 400 characters and seo_review under 600 characters.",
  ].join("\n");

  try {
    const parsed = await chatJson({
      config,
      system,
      user: JSON.stringify(payload),
      maxTokens: 16_000,
      temperature: 0.2,
      attempts: 2,
      // A 1,000-query site produces a payload that a 120s budget aborts.
      timeoutMs: 240_000,
      // This provider is a reasoning model: a small completion budget can be
      // spent on reasoning before any content is emitted, which looked like an
      // empty response. Keep a generous completion budget.
      jsonMode: false,
    });
    const record = asRecord(parsed);
    const bySlug = new Map(map.clusters.map((cluster) => [cluster.slug, cluster]));
    const allowedIntent = new Set(["informational", "commercial", "transactional", "local", "mixed"]);
    const allowedRelevance = new Set(["high", "medium", "low"]);
    const allowedCoverage = new Set(["strong", "partial", "none"]);
    const aiClusters = Array.isArray(record.clusters) ? record.clusters : [];
    for (const raw of aiClusters) {
      const row = asRecord(raw);
      const slug = textValue(row.slug);
      const cluster = slug ? bySlug.get(slug) : undefined;
      if (!cluster) continue;
      const name = textValue(row.name);
      const rationale = textValue(row.rationale);
      const intent = textValue(row.intent);
      const relevance = textValue(row.relevance);
      const coverage = textValue(row.coverage);
      const confidence = numberValue(row.confidence);
      // The review names the language it reads in the queries. It is a fact
      // about the demand, not a guess by the map: the model sees the queries.
      const language = textValue(row.language)?.toLowerCase() ?? null;
      if (name) cluster.name = name.slice(0, 160);
      if (rationale) {
        cluster.rationale = rationale.slice(0, 600);
        cluster.topicSummary = rationale.slice(0, 300);
      }
      if (intent && allowedIntent.has(intent)) cluster.intent = intent as TopicIntent;
      if (relevance && allowedRelevance.has(relevance)) cluster.relevance = relevance as TopicRelevance;
      if (coverage && allowedCoverage.has(coverage)) cluster.coverage = coverage as TopicCluster["coverage"];
      if (language && /^[a-z]{2}$/.test(language)) cluster.language = language;
      if (Number.isFinite(confidence)) cluster.confidence = Math.max(0, Math.min(1, confidence));
      if (Array.isArray(row.gaps)) {
        const gaps = row.gaps
          .filter((gap): gap is string => typeof gap === "string" && gap.trim().length > 0)
          .map((gap) => gap.trim().slice(0, 400))
          .slice(0, 8);
        if (gaps.length > 0) cluster.gaps = gaps;
      }
    }
    const verdicts: MarketVerdict[] = [];
    for (const raw of Array.isArray(record.market_verdicts) ? record.market_verdicts : []) {
      const row = asRecord(raw);
      const cluster = textValue(row.cluster);
      const query = textValue(row.query);
      const reason = textValue(row.reason);
      const flag = row.in_market;
      const inMarket =
        typeof flag === "boolean" ? flag : flag === "true" ? true : flag === "false" ? false : null;
      if (!cluster || !query || inMarket == null || !reason) continue;
      verdicts.push({ cluster, query, inMarket, reason: reason.slice(0, 200) });
    }
    const marketExclusions = applyMarketVerdicts(map, verdicts);

    const priorityTopics = stringList(record.priority_topics).filter((slug) => bySlug.has(slug)).slice(0, 5);
    const weakTopics = stringList(record.weak_topics).filter((slug) => bySlug.has(slug)).slice(0, 4);
    return {
      available: true,
      model: config.model,
      summary: textValue(record.map_summary)?.slice(0, 1_200) ?? null,
      review: textValue(record.seo_review)?.slice(0, 2_000) ?? null,
      priorityTopics,
      weakTopics,
      marketExclusions,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      model: config.model,
      summary: null,
      review: null,
      priorityTopics: [],
      weakTopics: [],
      marketExclusions: 0,
      error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    };
  }
}

export async function storeTopicMap(
  db: TopicMapDb,
  map: TopicMap,
  opts: { now?: Date } = {}
): Promise<{ created: number; updated: number; superseded: number; memberships: number }> {
  const now = opts.now ?? new Date();
  // Slugs are unique per project, including superseded rows: a topic that comes
  // back after being superseded must reuse its row, not collide with it.
  const allRows = await db.demandMapCluster.findMany({
    where: { projectId: map.projectId },
    select: { id: true, slug: true, identityKey: true, tracked: true, proposedBy: true, supersededAt: true },
    orderBy: { supersededAt: "desc" },
  });
  const existing = allRows.filter((row) => row.supersededAt === null);
  const existingBySlug = new Map(allRows.map((row) => [row.slug, row]));
  const activeBySlug = new Map(existing.map((row) => [row.slug, row]));
  const newSlugs = new Set(map.clusters.map((cluster) => cluster.slug));
  let created = 0;
  let updated = 0;
  let memberships = 0;

  for (const cluster of map.clusters) {
    const identityKey = `topic:${cluster.slug}`;
    const current = existingBySlug.get(cluster.slug);
    const data = {
      slug: cluster.slug,
      identityKey,
      name: cluster.name,
      topicSummary: cluster.topicSummary,
      intent: cluster.intent,
      businessRelevance: {
        relevance: cluster.relevance,
        rationale: cluster.rationale,
        proposed: true,
        source: "topic-map-v1",
        coverage: cluster.coverage,
        visibility: cluster.visibility,
        pages: cluster.pages,
        gaps: cluster.gaps,
        excludedQueries: cluster.excludedQueries,
        metrics: cluster.metrics,
        actionHint: cluster.actionHint,
        ai: map.ai,
      } as never,
      proposedBy: "topic-map-v1",
      confidence: cluster.confidence,
    };
    let clusterId: string;
    if (current) {
      await db.demandMapCluster.update({ where: { id: current.id }, data: { ...data, supersededAt: null } });
      clusterId = current.id;
      updated += 1;
    } else {
      const createdRow = await db.demandMapCluster.create({
        data: { projectId: map.projectId, ...data },
        select: { id: true },
      });
      clusterId = createdRow.id;
      created += 1;
    }
    void clusterId;

    for (const query of cluster.queries) {
      const metrics: Record<string, MetricValue> = {
        "derived:impressions": { value: query.impressions, unit: "count", source: "derived" },
        "derived:clicks": { value: query.clicks, unit: "count", source: "derived" },
      };
      if (query.position != null) metrics["derived:position"] = { value: query.position, unit: "rank", source: "derived" };
      if (query.volume != null) metrics["derived:volume"] = { value: query.volume, unit: "searches/month", source: "derived" };
      const stored = await storeEvidenceRecord(db, {
        projectId: map.projectId,
        siteId: map.siteId,
        kind: "keyword_universe_membership",
        observedAt: query.observedAt,
        producer: "topic-map-v1",
        dimensions: {
          cluster: cluster.slug,
          query: query.query,
          source: "topic-map-v1",
          topic: cluster.name,
        },
        metrics,
      });
      await supersedeMembership(db, map.projectId, cluster.slug, query.query, stored.id);
      memberships += 1;
    }
  }

  let superseded = 0;
  const newMembersBySlug = new Map(map.clusters.map((cluster) => [cluster.slug, cluster.queries.map((query) => query.query)]));
  for (const row of existing) {
    if (newSlugs.has(row.slug) || row.tracked) continue;
    const oldMembers = await membershipQueries(db, map.projectId, row.slug);
    if (oldMembers.length === 0) {
      // A model topic that is no longer in the map and never had members is
      // stale, not curated: retire it. A row a person owns is left alone.
      if (row.proposedBy === "topic-map-v1") {
        await db.demandMapCluster.update({ where: { id: row.id }, data: { supersededAt: now } });
        superseded += 1;
      }
      continue;
    }
    let best: { slug: string; score: number } | null = null;
    for (const [slug, members] of newMembersBySlug) {
      const score = jaccard(oldMembers, members);
      if (!best || score > best.score) best = { slug, score };
    }
    const successor = best && best.score >= 0.2 ? activeBySlug.get(best.slug) : null;
    await db.demandMapCluster.update({
      where: { id: row.id },
      data: { supersededAt: now, supersededById: successor?.id ?? null },
    });
    superseded += 1;
  }

  return { created, updated, superseded, memberships };
}

async function supersedeMembership(
  db: TopicMapDb,
  projectId: string,
  slug: string,
  query: string,
  replacementId: string
): Promise<void> {
  const rows = await db.evidenceRecord.findMany({
    where: {
      projectId,
      kind: "keyword_universe_membership",
      supersededById: null,
      dimensions: { path: ["cluster"], equals: slug },
    },
    select: { id: true, dimensions: true },
  });
  for (const row of rows) {
    if (row.id === replacementId) continue;
    const dims = asRecord(row.dimensions);
    if (dims.query !== query) continue;
    await db.evidenceRecord.update({ where: { id: row.id }, data: { supersededById: replacementId } });
  }
}

async function membershipQueries(db: TopicMapDb, projectId: string, slug: string): Promise<string[]> {
  const rows = await db.evidenceRecord.findMany({
    where: {
      projectId,
      kind: "keyword_universe_membership",
      supersededById: null,
      dimensions: { path: ["cluster"], equals: slug },
    },
    select: { dimensions: true },
  });
  return rows.flatMap((row) => {
    const query = asRecord(row.dimensions).query;
    return typeof query === "string" ? [query] : [];
  });
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  const shared = [...setA].filter((value) => setB.has(value)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : shared / union;
}

export function renderTopicMapMarkdown(map: TopicMap): string {
  const lines: string[] = [];
  lines.push(`# Topic map — ${map.domain} — ${map.month}`);
  lines.push("");
  lines.push(`Generated ${map.generatedAt}. Locale ${map.locale.language}${map.locale.country ? `/${map.locale.country}` : ""}.`);
  lines.push("");
  lines.push("## Business");
  lines.push("");
  lines.push(`- Name: ${map.business.name ?? "unknown"}`);
  lines.push(`- Services: ${map.business.services.join("; ") || "unknown"}`);
  lines.push(`- Location: ${map.business.location ?? "unknown"}`);
  lines.push(`- Service area: ${map.business.serviceArea.join("; ") || "unknown"}`);
  lines.push(`- Audience: ${map.business.audience ?? "unknown"}`);
  lines.push("");
  lines.push("## Topic taxonomy");
  lines.push("");
  lines.push(`- Topics: ${map.taxonomy.length}`);
  for (const topic of map.taxonomy) {
    lines.push(`  - \`${topic.slug}\` — ${topic.name} (${topic.intent}, ${topic.coverageKind}, ${topic.relevance}); ${topic.terms.length} matching terms${topic.headTerms?.length ? `; head term${topic.headTerms.length === 1 ? "" : "s"} ${topic.headTerms.map((term) => `\`${term}\``).join(", ")}` : ""}`);
  }
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push("One semantic pass: the job map decides the jobs, their markets, owner pages and topic fields, and the taxonomy is projected from it one topic per job. Membership and page matching are arithmetic over the stated need terms, market places and local-intent phrases. The AI call, when enabled, only reviews and names the clusters; it cannot add queries or pages.");
  lines.push("");
  lines.push("A query can belong to more than one topic (a local service query, or a content query that names the craft). Demand totals are per-topic and are not additive across topics.");
  lines.push("");
  if (map.ai.available) {
    lines.push(`AI review: ${map.ai.model ?? "configured model"}.`);
    if (map.ai.summary) lines.push(`\n${map.ai.summary}`);
    if (map.ai.review) lines.push(`\n${map.ai.review}`);
    if (map.ai.priorityTopics.length > 0) lines.push(`\nPriority topics: ${map.ai.priorityTopics.join(", ")}.`);
    if (map.ai.weakTopics.length > 0) lines.push(`Weak topics: ${map.ai.weakTopics.join(", ")}.`);
    if (map.ai.marketExclusions > 0) lines.push(`Out-of-market queries excluded from demand and evidence: ${map.ai.marketExclusions}.`);
    if (map.ai.note) lines.push(`\nNote: ${map.ai.note}`);
  } else {
    lines.push(`AI review: not available${map.ai.error ? ` (${map.ai.error})` : ""}. The deterministic map is shown as-is.`);
  }
  lines.push("");
  lines.push("## Topic table");
  lines.push("");
  lines.push("| Topic | Intent | Relevance | Market scope | Lang | Queries | Impressions | Clicks | Distinct demand | Summed volume | Context-only | Page | Ranks | Main page | Main gap |");
  lines.push("|---|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|---|");
  for (const cluster of map.clusters) {
    const mainPage = cluster.pages[0]?.url.replace(/^https?:\/\/[^/]+/, "") ?? "—";
    const mainGap = cluster.gaps[0] ?? "—";
    const contextOnly = cluster.contextOnly.queries > 0
      ? `${cluster.contextOnly.queries} q / ${cluster.contextOnly.volume}`
      : "—";
    const pageState = cluster.coverageFacts.page ? (cluster.coverage === "partial" ? "thin" : "exists") : "none";
    const rankState = cluster.metrics.position != null && cluster.metrics.impressions > 0
      ? `pos ${cluster.metrics.position.toFixed(1)}`
      : "no";
    lines.push(
      `| ${escapePipe(cluster.name)} | ${cluster.intent} | ${cluster.relevance} | ${escapePipe(formatScope(cluster.marketScope))} | ${cluster.language ?? "—"} | ${cluster.metrics.queries} | ${cluster.metrics.impressions} | ${cluster.metrics.clicks} | ${cluster.metrics.volume} | ${cluster.metrics.volumeSum} | ${contextOnly} | ${pageState} | ${rankState} | ${escapePipe(mainPage)} | ${escapePipe(mainGap)} |`
    );
  }
  lines.push("");
  lines.push("## Clusters");
  lines.push("");
  for (const cluster of map.clusters) {
    lines.push(`### ${cluster.name}`);
    lines.push("");
    lines.push(`- Slug: \`${cluster.slug}\``);
    lines.push(`- Intent: ${cluster.intent}; relevance: ${cluster.relevance}; confidence: ${cluster.confidence.toFixed(2)}`);
    lines.push(`- Market scope: ${formatScope(cluster.marketScope)}`);
    lines.push(`- Rationale: ${cluster.rationale}`);
    lines.push(`- Demand: ${cluster.metrics.queries} queries, ${cluster.metrics.impressions} impressions, ${cluster.metrics.clicks} clicks, ${cluster.metrics.volume} distinct monthly demand (${cluster.metrics.volumeSum} summed across keyword variants); average position ${cluster.metrics.position?.toFixed(1) ?? "unknown"}.`);
    lines.push(`- Page: ${cluster.coverageFacts.page ? `exists (${cluster.pages[0]?.wordCount ?? 0} words)` : "none"}; ranking: ${cluster.metrics.position != null ? `position ${cluster.metrics.position.toFixed(1)}` : "no measured position"}; clicks: ${cluster.metrics.clicks}.`);
    if (cluster.language) lines.push(`- Query language: ${cluster.language}.`);
    lines.push(`- AEO: ${cluster.metrics.aeoQuestions} measured questions, ${cluster.metrics.aeoCited} citations of the site.`);
    lines.push(`- Action hint: ${cluster.actionHint}`);
    if (cluster.reviewFlags.includes("no-need-word")) {
      lines.push("- Review: no need word. This topic is defined only by place or brand and would claim every query that names it; correct the taxonomy before treating it as an opportunity.");
    }
    if (cluster.contextOnly.queries > 0) {
      const examples = cluster.contextOnly.examples.length > 0 ? ` Examples: ${cluster.contextOnly.examples.join(", ")}.` : "";
      lines.push(`- Context-only: ${cluster.contextOnly.queries} queries, ${cluster.contextOnly.volume} monthly demand match this topic's place or brand but not its need.${examples} Review for a missing need term or a separate audience.`);
    }
    lines.push("");
    if (cluster.queries.length > 0) {
      lines.push("| Query | Impressions | Clicks | Position | Volume | Difficulty |");
      lines.push("|---|---:|---:|---:|---:|---:|");
      for (const query of cluster.queries.slice(0, 15)) {
        lines.push(
          `| ${escapePipe(query.query)} | ${query.impressions} | ${query.clicks} | ${query.position?.toFixed(1) ?? "—"} | ${query.volume ?? "—"} | ${query.difficulty ?? "—"} |`
        );
      }
      if (cluster.queries.length > 15) lines.push(`| … ${cluster.queries.length - 15} more | | | | | |`);
      lines.push("");
    }
    if (cluster.excludedQueries.length > 0) {
      lines.push("Out-of-market queries (excluded from demand and evidence):");
      lines.push("");
      lines.push("| Query | Impressions | Reason |");
      lines.push("|---|---:|---|");
      for (const query of cluster.excludedQueries) {
        lines.push(`| ${escapePipe(query.query)} | ${query.impressions} | ${escapePipe(query.reason)} |`);
      }
      lines.push("");
    }
    if (cluster.pages.length > 0) {
      lines.push("Owner page:");
      lines.push("");
      lines.push("| Page | Type | Words |");
      lines.push("|---|---|---:|");
      for (const page of cluster.pages) {
        lines.push(`| ${escapePipe(page.url.replace(/^https?:\/\/[^/]+/, ""))} | ${page.type} | ${page.wordCount} |`);
      }
      lines.push("");
    } else {
      lines.push("No owner page: the taxonomy names none, so the topic has no coverage until it does.");
      lines.push("");
    }
    if (cluster.gaps.length > 0) {
      lines.push("Gaps:");
      lines.push("");
      for (const gap of cluster.gaps) lines.push(`- ${gap}`);
      lines.push("");
    }
  }
  lines.push("## Unmapped demand");
  lines.push("");
  const unowned = map.unmapped.filter((query) => query.kind !== "excluded");
  const excluded = map.unmapped.filter((query) => query.kind === "excluded");
  if (unowned.length === 0) {
    lines.push("Every query with demand matched a topic.");
  } else {
    // A display bound, not a data bound: the map keeps every unmapped query and
    // the reviewer reads them all. The remainder is stated, never hidden.
    const shown = unowned.slice(0, UNMAPPED_TABLE_LIMIT);
    lines.push("| Query | Impressions | Volume | Why it is unmapped |");
    lines.push("|---|---:|---:|---|");
    for (const query of shown) {
      lines.push(`| ${escapePipe(query.query)} | ${query.impressions} | ${query.volume ?? "—"} | ${escapePipe(query.reason)} |`);
    }
    if (unowned.length > shown.length) {
      lines.push("");
      lines.push(`- Showing the ${shown.length} unmapped queries with the most impressions; ${unowned.length - shown.length} more are in the map data.`);
    }
  }
  lines.push("");
  lines.push("## Queries the job map excluded from demand");
  lines.push("");
  if (excluded.length === 0) {
    lines.push("The job map excluded no measured query.");
  } else {
    lines.push(`- ${excluded.length} measured queries are context, noise or out of market. They stay visible for audit and are not demand.`);
    const shown = excluded.slice(0, UNMAPPED_TABLE_LIMIT);
    lines.push("");
    lines.push("| Query | Impressions | Volume | Verdict |");
    lines.push("|---|---:|---:|---|");
    for (const query of shown) {
      lines.push(`| ${escapePipe(query.query)} | ${query.impressions} | ${query.volume ?? "—"} | ${escapePipe(query.reason)} |`);
    }
    if (excluded.length > shown.length) {
      lines.push("");
      lines.push(`- Showing the ${shown.length} excluded queries with the most impressions; ${excluded.length - shown.length} more are in the map data.`);
    }
  }
  lines.push("");
  lines.push("## Deferred to next cycle");
  lines.push("");
  if (map.deferred.count === 0) {
    lines.push("Every measured query was in this cycle's tranche.");
  } else {
    lines.push(`- ${map.deferred.count} queries (${map.deferred.impressions} impressions, ${map.deferred.clicks} clicks) were outside this cycle's tranche. They are not counted as demand and are not judged yet; they are processed in a later cycle.`);
    if (map.deferred.examples.length > 0) {
      lines.push(`- Examples: ${map.deferred.examples.map((query) => `“${query}”`).join(", ")}.`);
    }
  }
  lines.push("");
  lines.push("## Timely signals from the bundle");
  lines.push("");
  if (map.news.length === 0) {
    lines.push("No news/event sources in the bundle.");
  } else {
    for (const item of map.news.slice(0, 10)) {
      lines.push(`- ${item.title}${item.publishedAt ? ` (${item.publishedAt.slice(0, 10)})` : ""} — ${item.url}`);
    }
  }
  lines.push("");
  lines.push("## Counts");
  lines.push("");
  lines.push(`- Site window: ${map.site.impressions} impressions, ${map.site.clicks} clicks. Queries: ${map.counts.queries}; judged demand: ${map.counts.qualifiedQueries}; deferred: ${map.counts.deferredQueries}; clustered: ${map.counts.clusteredQueries}; not demand: ${map.counts.excludedQueries}; unmapped: ${map.counts.unmappedQueries}.`);
  lines.push(`- Pages considered: ${map.counts.pages}; news sources: ${map.counts.news}.`);
  lines.push("");
  lines.push("## Limits");
  lines.push("");
  lines.push("- This is a topic map, not an opportunity list. No article, business or technical proposal is created here.");
  lines.push("- Page coverage uses URL, title, description and H1 because the latest crawl stored no body text.");
  lines.push("- The taxonomy is projected from this site's job map; another site needs its own job map. Two jobs may share one owner page, and that is the model's decision, not a defect.");
  lines.push("- Queries outside this cycle's tranche are deferred, counted and not judged; they are not evidence either way.");
  lines.push("- Search Console query rows are privacy-limited and do not sum to the page total.");
  lines.push("");
  return lines.join("\n");
}

function formatScope(scope: { scope: string; markets: string[]; source: string }): string {
  const markets = scope.markets.length > 0 ? ` (${scope.markets.join(", ")})` : "";
  return `${scope.scope}${markets}${scope.source === "default" ? " · default" : ""}`;
}

function escapePipe(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function fieldText(fields: Record<string, unknown>, key: string): string | null {
  const fact = asRecord(fields[key]);
  const value = fact.value;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string");
    return parts.length > 0 ? parts.join("; ") : null;
  }
  return null;
}

function fieldList(fields: Record<string, unknown>, key: string): string[] {
  const fact = asRecord(fields[key]);
  const value = fact.value;
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

export function topicMapKey(siteId: string, month: string): string {
  return `topic-map:${siteId}:${month}`;
}

export function topicMapChecksum(map: TopicMap): string {
  return createHash("sha256")
    .update(JSON.stringify({
      siteId: map.siteId,
      month: map.month,
      clusters: map.clusters.map((cluster) => ({ slug: cluster.slug, queries: cluster.queries.map((query) => query.query), pages: cluster.pages.map((page) => page.url) })),
    }))
    .digest("hex")
    .slice(0, 16);
}
