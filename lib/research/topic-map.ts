import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { storeEvidenceRecord, type MetricValue } from "@/lib/funnel/evidence";
import { businessKnowledgeFields, resolveSiteContext } from "@/lib/site/context";
import {
  parseMarketScope,
  marketScopeForTopic,
  type MarketScopeConfig,
  type MarketScopeLevel,
} from "@/lib/site/market-scope";
import type { TopicDefinition, TopicIntent, TopicRelevance } from "@/lib/research/topic-taxonomy";

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

export type DemandQuery = {
  query: string;
  impressions: number;
  clicks: number;
  position: number | null;
  volume: number | null;
  difficulty: number | null;
  observedAt: Date;
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
    volume: number;
    difficulty: number | null;
    position: number | null;
    aeoQuestions: number;
    aeoCited: number;
  };
  queries: DemandQuery[];
  pages: TopicCoveragePage[];
  coverage: "strong" | "partial" | "none";
  gaps: string[];
};

export type UnmappedQuery = {
  query: string;
  impressions: number;
  volume: number | null;
  reason: string;
};

export type TopicMapAi = {
  available: boolean;
  model: string | null;
  summary: string | null;
  review: string | null;
  priorityTopics: string[];
  weakTopics: string[];
  error: string | null;
  /** Operational note, e.g. a successful earlier call followed by a failed retry. */
  note?: string | null;
};

export type TopicMap = {
  siteId: string;
  projectId: string;
  domain: string;
  month: string;
  generatedAt: string;
  locale: { language: string; country: string | null };
  marketScope: MarketScopeConfig;
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
  counts: {
    queries: number;
    clusteredQueries: number;
    unmappedQueries: number;
    pages: number;
    news: number;
  };
};

export type TopicMapData = {
  site: { id: string; domain: string; projectId: string };
  context: Awaited<ReturnType<typeof resolveSiteContext>>;
  fields: Record<string, unknown>;
  marketScope: MarketScopeConfig;
  queries: DemandQuery[];
  pages: TopicPage[];
  aeo: Array<{ question: string; cited: number; observedAt: Date }>;
  news: Array<{ title: string; url: string; publishedAt: string | null; excerpt: string | null }>;
  month: string;
};

const FRENCH_STOPWORDS = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "a", "au", "aux", "en", "dans",
  "pour", "par", "sur", "sous", "avec", "sans", "chez", "que", "qui", "quoi", "dont", "ou", "quand",
  "comment", "pourquoi", "quel", "quelle", "quels", "quelles", "est", "sont", "etre", "fait", "faire",
  "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "notre", "nos", "votre", "vos", "leur",
  "leurs", "ce", "cette", "ces", "cet", "plus", "moins", "tres", "tout", "tous", "toute", "toutes",
  "the", "and", "for", "with", "from", "that", "this", "your", "you", "our", "are", "was", "how",
  "what", "why", "when", "where", "who", "which", "best", "top", "near", "about", "into", "out",
]);

const GENERIC_QUERY_TOKENS = new Set([
  "artisanal", "artisanale", "artisanales", "artisanaux", "artisan", "artisane", "creation", "creer",
  "cree", "unique", "uniques", "original", "originale", "originales", "francais", "francaise",
  "prix", "devis", "achat", "acheter", "vente", "boutique", "magasin", "fait", "main", "sur", "mesure",
  "modele", "collection", "couleur", "style", "idee", "inspiration", "conseil", "guide", "blog",
  "mans", "sarthe", "normandie", "saint", "pierre", "germain", "laye", "adresse", "fecamp",
  "caen", "rouen", "honfleur", "caux",
]);

const PAGE_EXCLUDE = [
  /^\/en(\/|$)/,
  /^\/blog\/tags\//,
  /^\/conditions-generales/,
  /^\/politique-de-/,
  /^\/livraison/,
  /^\/profile\//,
];

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
  // French plurals are the common case ("lampe"/"lampes", "fauteuil"/"fauteuils",
  // "hôtel"/"hôtels"). A plural variant is enough; broad prefix matching would
  // make "mer" match "merci".
  const variants = new Set([normalized, normalized.replace(/s$/, ""), `${normalized}s`]);
  return [...variants].some((variant) => variant.length > 0 && ` ${text} `.includes(` ${variant} `));
}

function termWeight(text: string, term: string): number {
  const normalized = normalizeTopicText(term);
  if (!normalized || !containsTerm(text, normalized)) return 0;
  return normalized.includes(" ") ? 2 : 1;
}

export function scoreTopicForQuery(query: string, topic: TopicDefinition): number {
  const text = normalizeTopicText(query);
  if (!topic.requireAny.some((term) => containsTerm(text, term))) return 0;
  if (topic.requireGroups && !topic.requireGroups.every((group) => group.some((term) => containsTerm(text, term)))) return 0;
  let score = 0;
  for (const term of topic.terms) score += termWeight(text, term);
  for (const term of topic.strongTerms ?? []) score += termWeight(text, term);
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

function pageType(path: string): TopicPage["type"] {
  if (path === "/") return "home";
  if (path.startsWith("/product-page/")) return "product";
  if (path === "/post/" || path.startsWith("/post/") || path === "/blog" || path.startsWith("/blog/")) return "blog";
  if (path.startsWith("/category/")) return "category";
  if (path === "/gift-card") return "product";
  if (
    path === "/lampes" ||
    path.startsWith("/lampes/") ||
    path === "/objets-deco" ||
    path === "/sieges"
  ) {
    return "category";
  }
  if (
    path === "/tapisserie-restauration" ||
    path === "/les-ateliers" ||
    path === "/les-tissus" ||
    path === "/b2b" ||
    path === "/devis" ||
    path === "/shop" ||
    path === "/a-propos"
  ) {
    return "service";
  }
  return "other";
}

function pageCoverageScore(page: TopicPage, topic: TopicDefinition): number {
  // The home page mentions every service in its marketing copy. It can carry a
  // brand or local signal, but it must not win a service or product topic.
  if (page.type === "home" && topic.coverageKind !== "brand" && topic.coverageKind !== "local") return 0;
  // The all-products listing is a shop index, not a topic page.
  if (page.path === "/category/all-products") return 0;
  // Every page title ends with "Atelier de l'Harmonie". That is a brand suffix,
  // not evidence that the page is about the brand.
  if (topic.slug === "marque" && page.path !== "/" && page.path !== "/a-propos") return 0;
  if (topic.coverageRequireAny && !topic.coverageRequireAny.some((term) => containsTerm(page.text, term))) {
    return 0;
  }
  if (topic.coverageRequireGroups && !topic.coverageRequireGroups.every((group) => group.some((term) => containsTerm(page.text, term)))) {
    return 0;
  }
  let score = 0;
  for (const term of topic.pageTerms) score += termWeight(page.text, term);
  if (topic.preferredPages?.includes(page.path)) score += 10;
  return score;
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

function coverageLevel(pages: TopicCoveragePage[], topic: TopicDefinition): TopicCluster["coverage"] {
  if (pages.length === 0) return "none";
  const minWords = topic.coverageKind === "content" ? 100 : 200;
  const allowed = pages.filter((page) => pageAllowed(page, topic.coverageKind));
  if (allowed.some((page) => page.score >= 2 && page.wordCount >= minWords)) return "strong";
  // A blog post or product page can still be real coverage even when it is not
  // the page type that should own the topic.
  return "partial";
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
  const byTerm = new Map<string, { count: number; impressions: number }>();
  for (const query of queries) {
    const tokens = new Set(
      normalizeTopicText(query.query)
        .split(" ")
        .filter((token) => token.length >= 4 && !FRENCH_STOPWORDS.has(token) && !GENERIC_QUERY_TOKENS.has(token))
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
  } else if (coverage === "partial") {
    const expected = expectedPageLabel(topic.coverageKind);
    const hasExpected = pages.some((page) => pageAllowed(page, topic.coverageKind));
    if (!hasExpected) {
      gaps.push(`Coverage exists, but there is no ${expected} page for this topic.`);
    } else {
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
  if (topic.slug === "local-normandie") {
    const dedicatedLocal = allPages.some(
      (page) =>
        (page.type === "service" || page.type === "category") &&
        containsTerm(normalizeTopicText(page.title + " " + page.url), "tapissier") &&
        (containsTerm(normalizeTopicText(page.title + " " + page.url), "normandie") ||
          containsTerm(normalizeTopicText(page.title + " " + page.url), "saint pierre"))
    );
    if (!dedicatedLocal) {
      gaps.push("No dedicated local landing page combining the trade and the place; the home and workshop pages carry the local signal.");
    }
    const offArea = queries.filter((query) => /\b(le mans|sarthe|saint germain en laye|sainte adresse)\b/i.test(query.query));
    if (offArea.length > 0) {
      gaps.push(
        `Off-area demand: ${offArea.map((query) => `“${query.query}”`).slice(0, 4).join(", ")}. Do not chase it without a business reason.`
      );
    }
  }
  // Missing terms are checked against every page that matched the topic, not
  // only the four shown in the report. A product page for a pagode shade counts
  // as coverage even when the category page is the one displayed.
  const missing = missingQueryTerms(queries, allPages);
  for (const entry of missing.slice(0, 4)) {
    gaps.push(`Queries mention “${entry.term}” (${entry.count} query${entry.count === 1 ? "" : "s"}, ${entry.impressions} impressions) but no matched page does.`);
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

export async function loadTopicMapData(db: TopicMapDb, siteId: string, month: string): Promise<TopicMapData> {
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
    if (PAGE_EXCLUDE.some((pattern) => pattern.test(path))) return [];
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
      type: pageType(path),
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

export function buildTopicMap(data: TopicMapData, taxonomy: TopicDefinition[], now = new Date()): TopicMap {
  const assignments = new Map<string, Array<{ topic: TopicDefinition; score: number }>>();
  for (const query of data.queries) {
    const assigned = assignQuery(query.query, taxonomy);
    if (assigned.length > 0) assignments.set(query.query, assigned);
  }

  const clusters: TopicCluster[] = taxonomy.map((topic) => {
    const queries = data.queries.filter((query) => assignments.get(query.query)?.some((entry) => entry.topic.slug === topic.slug));
    const allPages = data.pages
      .map((page) => ({
        url: page.url,
        title: page.title,
        type: page.type,
        wordCount: page.wordCount,
        score: pageCoverageScore(page, topic),
      }))
      .filter((page) => page.score > 0)
      .sort((a, b) => b.score - a.score || typeRank(a.type) - typeRank(b.type));
    const pages = allPages.slice(0, 4);
    const coverage = coverageLevel(allPages, topic);
    const aeo = data.aeo.filter((row) => assignQuery(row.question, taxonomy).some((entry) => entry.topic.slug === topic.slug));
    const metrics = {
      queries: queries.length,
      impressions: queries.reduce((sum, query) => sum + query.impressions, 0),
      clicks: queries.reduce((sum, query) => sum + query.clicks, 0),
      volume: queries.reduce((sum, query) => sum + (query.volume ?? 0), 0),
      difficulty: average(queries.flatMap((query) => (query.difficulty == null ? [] : [query.difficulty]))),
      position: weightedPosition(queries),
      aeoQuestions: aeo.length,
      aeoCited: aeo.reduce((sum, row) => sum + row.cited, 0),
    };
    const gaps = buildGaps({ topic, queries, pages, allPages, coverage });
    const scope = marketScopeForTopic(data.marketScope, topic.offerKey);
    const demandScore = Math.log10(metrics.impressions + metrics.volume + 1) / 4;
    const confidence = Math.min(1, 0.35 + demandScore + (coverage === "strong" ? 0.15 : coverage === "partial" ? 0.05 : 0));
    return {
      slug: topic.slug,
      name: topic.name,
      topicSummary: `${metrics.queries} queries, ${metrics.impressions} impressions; coverage ${coverage}; ${gaps.length} gap${gaps.length === 1 ? "" : "s"}.`,
      intent: topic.intent,
      relevance: topic.relevance,
      rationale: topic.rationale,
      actionHint: topic.actionHint,
      marketScope: scope,
      confidence,
      metrics,
      queries: queries.sort((a, b) => b.impressions - a.impressions || (b.volume ?? 0) - (a.volume ?? 0)),
      pages,
      coverage,
      gaps,
    };
  });

  const unmapped = data.queries
    .filter((query) => !assignments.has(query.query))
    .sort((a, b) => b.impressions - a.impressions || (b.volume ?? 0) - (a.volume ?? 0))
    .slice(0, 25)
    .map((query) => ({
      query: query.query,
      impressions: query.impressions,
      volume: query.volume,
      reason: offBusinessReason(query.query),
    }));

  return {
    siteId: data.site.id,
    projectId: data.site.projectId,
    domain: data.site.domain,
    month: data.month,
    generatedAt: now.toISOString(),
    locale: { language: data.context.language, country: data.context.country },
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
      error: null,
    },
    counts: {
      queries: data.queries.length,
      clusteredQueries: [...assignments.keys()].length,
      unmappedQueries: data.queries.length - [...assignments.keys()].length,
      pages: data.pages.length,
      news: data.news.length,
    },
  };
}

function typeRank(type: TopicPage["type"]): number {
  return { service: 0, category: 1, home: 2, product: 3, blog: 4, other: 5 }[type];
}

function relevanceRank(relevance: TopicRelevance): number {
  return { high: 3, medium: 2, low: 1 }[relevance];
}

function offBusinessReason(query: string): string {
  const text = normalizeTopicText(query);
  if (/\b(tenue|sexie|definition|customer need|corpus|ambiguite|mot fleche)\b/.test(text)) {
    return "Off-business or research-noise query; ignore for the SEO map.";
  }
  if (/\b(meuble|meubles)\b/.test(text) && !/\b(fauteuil|chaise|siege|tapisserie|tapissier)\b/.test(text)) {
    return "Adjacent furniture restoration demand; the business sells seating and lighting, not general furniture.";
  }
  return "No taxonomy topic matched; review for a missing topic or an off-business query.";
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
      error: "CONTENT_LLM_API_KEY is not configured",
    };
  }

  const priorityClusters = map.clusters
    .filter((cluster) => cluster.relevance !== "low")
    .sort(
      (a, b) =>
        b.metrics.impressions + b.metrics.volume - (a.metrics.impressions + a.metrics.volume)
    )
    .slice(0, 8);
  const payload = {
    site: map.domain,
    business: {
      name: business.name,
      services: business.services,
      location: business.location,
      serviceArea: business.serviceArea,
    },
    clusters: priorityClusters.map((cluster) => ({
      slug: cluster.slug,
      name: cluster.name,
      intent: cluster.intent,
      relevance: cluster.relevance,
      coverage: cluster.coverage,
      marketScope: cluster.marketScope,
      demand: `${cluster.metrics.queries} queries, ${cluster.metrics.impressions} impressions, ${cluster.metrics.volume} monthly volume`,
      gaps: cluster.gaps.slice(0, 2),
    })),
    unmapped: map.unmapped.slice(0, 5).map((query) => query.query),
  };

  const system = [
    "You are an SEO reviewer for a small craft business.",
    "Review the supplied topic map. Use only the supplied clusters, slugs and facts; do not invent queries, pages or metrics.",
    "Respect each cluster's marketScope. A local offer is local; a national or international offer is not limited to Normandy. Do not assume every offer is local.",
    "Say which topics are worth doing first and which are weak or off-area.",
    "Return exactly one JSON object: { map_summary: string, seo_review: string, priority_topics: string[], weak_topics: string[] }.",
    "priority_topics and weak_topics must use only the supplied slugs. At most 5 priority topics and at most 4 weak topics.",
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
      timeoutMs: 120_000,
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
      if (name) cluster.name = name.slice(0, 160);
      if (rationale) {
        cluster.rationale = rationale.slice(0, 600);
        cluster.topicSummary = rationale.slice(0, 300);
      }
      if (intent && allowedIntent.has(intent)) cluster.intent = intent as TopicIntent;
      if (relevance && allowedRelevance.has(relevance)) cluster.relevance = relevance as TopicRelevance;
      if (coverage && allowedCoverage.has(coverage)) cluster.coverage = coverage as TopicCluster["coverage"];
      if (Number.isFinite(confidence)) cluster.confidence = Math.max(0, Math.min(1, confidence));
      if (Array.isArray(row.gaps)) {
        const gaps = row.gaps
          .filter((gap): gap is string => typeof gap === "string" && gap.trim().length > 0)
          .map((gap) => gap.trim().slice(0, 400))
          .slice(0, 8);
        if (gaps.length > 0) cluster.gaps = gaps;
      }
    }
    const priorityTopics = stringList(record.priority_topics).filter((slug) => bySlug.has(slug)).slice(0, 5);
    const weakTopics = stringList(record.weak_topics).filter((slug) => bySlug.has(slug)).slice(0, 4);
    return {
      available: true,
      model: config.model,
      summary: textValue(record.map_summary)?.slice(0, 1_200) ?? null,
      review: textValue(record.seo_review)?.slice(0, 2_000) ?? null,
      priorityTopics,
      weakTopics,
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
  const existing = await db.demandMapCluster.findMany({
    where: { projectId: map.projectId, supersededAt: null },
    select: { id: true, slug: true, identityKey: true, tracked: true },
  });
  const existingBySlug = new Map(existing.map((row) => [row.slug, row]));
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
        pages: cluster.pages,
        gaps: cluster.gaps,
        metrics: cluster.metrics,
        actionHint: cluster.actionHint,
        ai: map.ai,
      } as never,
      proposedBy: "topic-map-v1",
      confidence: cluster.confidence,
    };
    let clusterId: string;
    if (current) {
      await db.demandMapCluster.update({ where: { id: current.id }, data });
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
    if (oldMembers.length === 0) continue;
    let best: { slug: string; score: number } | null = null;
    for (const [slug, members] of newMembersBySlug) {
      const score = jaccard(oldMembers, members);
      if (!best || score > best.score) best = { slug, score };
    }
    const successor = best && best.score >= 0.2 ? existingBySlug.get(best.slug) : null;
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
  lines.push("## Method");
  lines.push("");
  lines.push("Deterministic taxonomy over stored Search Console queries, DataForSEO keyword metrics, SERP snapshots and the latest crawl. Every membership and page match comes from a stated term. The AI call, when enabled, only reviews and names the clusters; it cannot add queries or pages.");
  lines.push("");
  lines.push("A query can belong to more than one topic (a local service query, or a content query that names the craft). Demand totals are per-topic and are not additive across topics.");
  lines.push("");
  if (map.ai.available) {
    lines.push(`AI review: ${map.ai.model ?? "configured model"}.`);
    if (map.ai.summary) lines.push(`\n${map.ai.summary}`);
    if (map.ai.review) lines.push(`\n${map.ai.review}`);
    if (map.ai.priorityTopics.length > 0) lines.push(`\nPriority topics: ${map.ai.priorityTopics.join(", ")}.`);
    if (map.ai.weakTopics.length > 0) lines.push(`Weak topics: ${map.ai.weakTopics.join(", ")}.`);
    if (map.ai.note) lines.push(`\nNote: ${map.ai.note}`);
  } else {
    lines.push(`AI review: not available${map.ai.error ? ` (${map.ai.error})` : ""}. The deterministic map is shown as-is.`);
  }
  lines.push("");
  lines.push("## Topic table");
  lines.push("");
  lines.push("| Topic | Intent | Relevance | Market scope | Queries | Impressions | Volume | Coverage | Main page | Main gap |");
  lines.push("|---|---|---|---|---:|---:|---:|---|---|---|");
  for (const cluster of map.clusters) {
    const mainPage = cluster.pages[0]?.url.replace(/^https?:\/\/[^/]+/, "") ?? "—";
    const mainGap = cluster.gaps[0] ?? "—";
    lines.push(
      `| ${escapePipe(cluster.name)} | ${cluster.intent} | ${cluster.relevance} | ${escapePipe(formatScope(cluster.marketScope))} | ${cluster.metrics.queries} | ${cluster.metrics.impressions} | ${cluster.metrics.volume} | ${cluster.coverage} | ${escapePipe(mainPage)} | ${escapePipe(mainGap)} |`
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
    lines.push(`- Demand: ${cluster.metrics.queries} queries, ${cluster.metrics.impressions} impressions, ${cluster.metrics.clicks} clicks, ${cluster.metrics.volume} measured monthly volume; average position ${cluster.metrics.position?.toFixed(1) ?? "unknown"}.`);
    lines.push(`- AEO: ${cluster.metrics.aeoQuestions} measured questions, ${cluster.metrics.aeoCited} citations of the site.`);
    lines.push(`- Action hint: ${cluster.actionHint}`);
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
    if (cluster.pages.length > 0) {
      lines.push("Coverage pages:");
      lines.push("");
      lines.push("| Page | Type | Words | Match score |");
      lines.push("|---|---|---:|---:|");
      for (const page of cluster.pages) {
        lines.push(`| ${escapePipe(page.url.replace(/^https?:\/\/[^/]+/, ""))} | ${page.type} | ${page.wordCount} | ${page.score} |`);
      }
      lines.push("");
    } else {
      lines.push("No page matched this topic.");
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
  if (map.unmapped.length === 0) {
    lines.push("Every query with demand matched a topic.");
  } else {
    lines.push("| Query | Impressions | Volume | Why it is unmapped |");
    lines.push("|---|---:|---:|---|");
    for (const query of map.unmapped) {
      lines.push(`| ${escapePipe(query.query)} | ${query.impressions} | ${query.volume ?? "—"} | ${escapePipe(query.reason)} |`);
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
  lines.push(`- Queries: ${map.counts.queries}; clustered: ${map.counts.clusteredQueries}; unmapped: ${map.counts.unmappedQueries}.`);
  lines.push(`- Pages considered: ${map.counts.pages}; news sources: ${map.counts.news}.`);
  lines.push("");
  lines.push("## Limits");
  lines.push("");
  lines.push("- This is a topic map, not an opportunity list. No article, business or technical proposal is created here.");
  lines.push("- Page coverage uses URL, title, description and H1 because the latest crawl stored no body text.");
  lines.push("- The taxonomy is a pilot taxonomy for Atelier; a different site needs its own terms or a reviewed taxonomy.");
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
