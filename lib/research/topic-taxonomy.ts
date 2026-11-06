import type { PrismaClient } from "@prisma/client";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";
import { proposeLexicalClusters, significantTokens } from "@/lib/funnel/cluster-discovery";

/**
 * The tenant model for the topic map.
 *
 * What the business sells, how its pages are organised, which paths are
 * utility pages, and which searches find its news. It used to be a constant
 * with a domain check; it is now proposed by the model from the business's own
 * facts and its measured queries, stored per project, and editable by a human.
 *
 * The shape is the contract: matching and reporting need it, but nothing in the
 * pipeline knows a tenant by name.
 */

export type TopicIntent = "informational" | "commercial" | "transactional" | "local" | "mixed";
export type TopicRelevance = "high" | "medium" | "low";
export type TopicCoverageKind = "service" | "product" | "content" | "local" | "brand" | "business" | "mixed";

export type TopicDefinition = {
  slug: string;
  name: string;
  intent: TopicIntent;
  relevance: TopicRelevance;
  /** What a strong page for this topic looks like. */
  coverageKind: TopicCoverageKind;
  /** The offer key used by the tenant market-scope configuration. */
  offerKey: string;
  /** Why this topic matters to the business, in one sentence. */
  rationale: string;
  /** At least one of these must appear in the query for the topic to apply. */
  requireAny: string[];
  /** Every group must have at least one match; used for two-part rules like kit + workshop. */
  requireGroups?: string[][];
  /** Pages that should be shown first when they match. */
  preferredPages?: string[];
  /** A brand topic claims its query instead of sharing it with a generic topic. */
  exclusive?: boolean;
  /** Base matching terms. Phrases score higher than single tokens. */
  terms: string[];
  /** Extra weight for terms that identify the topic rather than modify it. */
  strongTerms?: string[];
  /** At least one of these must appear on a page for it to count as coverage. */
  coverageRequireAny?: string[];
  /** Every group must match on a page; used to keep restoration pages from matching a generic "restauration" mention. */
  coverageRequireGroups?: string[][];
  /** Terms that describe the pages which cover this topic. */
  pageTerms: string[];
  /** A business action hint for the review, not a generated proposal. */
  actionHint: string;
};

export type TopicPageType = "home" | "service" | "category" | "product" | "blog" | "other";

export type TopicPageTypeRule = {
  type: TopicPageType;
  /** URL prefix or substring, from the site's own page inventory. */
  pattern: string;
};

export type TopicTaxonomy = {
  version: 1;
  /** Who last wrote it: the model or a person. */
  proposedBy: "ai" | "human";
  model: string | null;
  generatedAt: string;
  topics: TopicDefinition[];
  /** How this site's URLs map to page types. */
  pageTypeRules: TopicPageTypeRule[];
  /** Paths that are never topics (legal, checkout, account). */
  excludePaths: string[];
  /** Searches that find current news and events for this business and market. */
  newsQueries: string[];
  /** What the model changed or noticed, for the reviewer. */
  summary: string | null;
};

export type TopicTaxonomyInput = {
  domain: string;
  language: string;
  country: string | null;
  /** The site's own page paths, for coverage grounding. */
  pagePaths: string[];
  business: {
    name: string | null;
    services: string[];
    location: string | null;
    serviceArea: string[];
    audience: string | null;
    differentiators: string[];
    concerns: string[];
  };
  marketScope: { default: string; offers: Array<{ offer: string; scope: string }> };
  queries: Array<{ query: string; impressions: number; volume: number | null }>;
  pages: Array<{ path: string; title: string; h1: string; wordCount: number }>;
};

export type TopicTaxonomyDb = Pick<PrismaClient, "siteProfile">;

function normalizeTerm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function termInText(text: string, term: string): boolean {
  const normalized = normalizeTerm(term);
  if (!normalized) return false;
  return ` ${text} `.includes(` ${normalized} `);
}

/**
 * Keep only topics that claim at least one measured query. A topic whose terms
 * match nothing is an invented cluster: it would produce an empty row and a
 * false coverage finding. The taxonomy is proposed from the query sample, so no
 * match means the terms missed the data.
 */
export function pruneTopicsToQueries(
  topics: TopicDefinition[],
  queries: string[]
): { topics: TopicDefinition[]; dropped: Array<{ title: string; reason: string }> } {
  const texts = queries.map(normalizeTerm);
  const dropped: Array<{ title: string; reason: string }> = [];
  const kept = topics.filter((topic) => {
    const matches = texts.some((text) => topic.requireAny.some((term) => termInText(text, term)));
    if (!matches) dropped.push({ title: topic.name, reason: "no measured query matches its terms" });
    return matches;
  });
  return { topics: kept, dropped };
}

/**
 * Map a proposed offer key onto the offers the owner actually configured. The
 * model paraphrases ("Lampes et luminaires artisanaux" for "Lampes & luminaires"),
 * and an unmatched key silently falls back to the default market scope.
 */
export function matchOfferKey(proposed: string, offers: string[]): string {
  if (offers.length === 0) return proposed;
  const normalized = normalizeTerm(proposed);
  const exact = offers.find((offer) => normalizeTerm(offer) === normalized);
  if (exact) return exact;
  const tokens = new Set(normalized.split(" ").filter((token) => token.length >= 4));
  let best: { offer: string; score: number } | null = null;
  for (const offer of offers) {
    const offerTokens = normalizeTerm(offer).split(" ").filter((token) => token.length >= 4);
    const score = offerTokens.filter((token) => tokens.has(token)).length;
    if (score > 0 && (!best || score > best.score)) best = { offer, score };
  }
  return best?.offer ?? proposed;
}

const INTENTS: TopicIntent[] = ["informational", "commercial", "transactional", "local", "mixed"];
const RELEVANCES: TopicRelevance[] = ["high", "medium", "low"];
const COVERAGE_KINDS: TopicCoverageKind[] = ["service", "product", "content", "local", "brand", "business", "mixed"];
const PAGE_TYPES: TopicPageType[] = ["home", "service", "category", "product", "blog", "other"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown, limit = 40): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim().toLowerCase()))].slice(0, limit);
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Validate one proposed topic. A topic that cannot match a query is not a
 * topic: it would create an empty cluster and a fake coverage finding.
 */
export function validateTopic(raw: unknown): { topic: TopicDefinition | null; reason: string | null } {
  const row = asRecord(raw);
  const slug = slugify(text(row.slug) ?? text(row.name) ?? "");
  const name = text(row.name);
  const intent = text(row.intent) as TopicIntent | null;
  const relevance = text(row.relevance) as TopicRelevance | null;
  const coverageKind = text(row.coverageKind) as TopicCoverageKind | null;
  const terms = stringList(row.terms);
  const requireAny = stringList(row.requireAny);
  const pageTerms = stringList(row.pageTerms);
  if (!slug) return { topic: null, reason: "missing slug" };
  if (!name) return { topic: null, reason: `${slug}: missing name` };
  if (!intent || !INTENTS.includes(intent)) return { topic: null, reason: `${slug}: invalid intent` };
  if (!relevance || !RELEVANCES.includes(relevance)) return { topic: null, reason: `${slug}: invalid relevance` };
  if (!coverageKind || !COVERAGE_KINDS.includes(coverageKind)) return { topic: null, reason: `${slug}: invalid coverageKind` };
  if (terms.length === 0) return { topic: null, reason: `${slug}: no matching terms` };
  const effectiveRequireAny = requireAny.length > 0 ? requireAny : terms;
  return {
    topic: {
      slug,
      name: name.slice(0, 160),
      intent,
      relevance,
      coverageKind,
      offerKey: text(row.offerKey)?.slice(0, 120) ?? name.slice(0, 120),
      rationale: text(row.rationale)?.slice(0, 600) ?? "",
      requireAny: effectiveRequireAny,
      ...(Array.isArray(row.requireGroups)
        ? { requireGroups: (row.requireGroups as unknown[]).flatMap((group) => (Array.isArray(group) ? [stringList(group, 10)].filter((entry) => entry.length > 0) : [])) }
        : {}),
      ...(Array.isArray(row.preferredPages)
        ? { preferredPages: stringList(row.preferredPages, 10).map((path) => (path.startsWith("/") ? path : `/${path}`)) }
        : {}),
      ...(row.exclusive === true ? { exclusive: true } : {}),
      terms,
      strongTerms: stringList(row.strongTerms),
      coverageRequireAny: stringList(row.coverageRequireAny),
      ...(Array.isArray(row.coverageRequireGroups)
        ? { coverageRequireGroups: (row.coverageRequireGroups as unknown[]).flatMap((group) => (Array.isArray(group) ? [stringList(group, 10)].filter((entry) => entry.length > 0) : [])) }
        : {}),
      pageTerms: pageTerms.length > 0 ? pageTerms : terms,
      actionHint: text(row.actionHint)?.slice(0, 400) ?? "",
    },
    reason: null,
  };
}

export function parseTopicTaxonomy(
  parsed: unknown,
  meta: { proposedBy: "ai" | "human"; model: string | null; generatedAt?: string }
): { taxonomy: TopicTaxonomy; rejected: Array<{ title: string; reason: string }> } {
  const record = asRecord(parsed);
  const rejected: Array<{ title: string; reason: string }> = [];
  const topics: TopicDefinition[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(record.topics) ? record.topics : []) {
    const { topic, reason } = validateTopic(raw);
    if (!topic) {
      if (reason) rejected.push({ title: text(asRecord(raw).name) ?? "topic", reason });
      continue;
    }
    if (seen.has(topic.slug)) {
      rejected.push({ title: topic.name, reason: `duplicate slug ${topic.slug}` });
      continue;
    }
    seen.add(topic.slug);
    topics.push(topic);
  }
  const pageTypeRules: TopicPageTypeRule[] = [];
  for (const raw of Array.isArray(record.pageTypeRules) ? record.pageTypeRules : []) {
    const row = asRecord(raw);
    const type = text(row.type) as TopicPageType | null;
    const pattern = text(row.pattern);
    if (!type || !PAGE_TYPES.includes(type) || !pattern || !pattern.startsWith("/")) continue;
    pageTypeRules.push({ type, pattern: pattern.slice(0, 200) });
  }
  return {
    taxonomy: {
      version: 1,
      proposedBy: meta.proposedBy,
      model: meta.model,
      generatedAt: meta.generatedAt ?? new Date().toISOString(),
      topics,
      pageTypeRules,
      excludePaths: stringList(record.excludePaths, 20).map((path) => (path.startsWith("/") ? path : `/${path}`)),
      newsQueries: Array.isArray(record.newsQueries)
        ? record.newsQueries.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()).slice(0, 10)
        : [],
      summary: text(record.summary)?.slice(0, 800) ?? null,
    },
    rejected,
  };
}

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Derive the matching terms from the cluster's own queries. The model names the
 * cluster and decides what it means; it does not invent the words that decide
 * membership, because a synonym the data does not contain produces a cluster
 * that matches nothing.
 */
export function deriveTerms(
  members: string[],
  impressions: (query: string) => number,
  pageTexts: string[]
): { terms: string[]; strongTerms: string[]; requireAny: string[]; coverageRequireAny: string[] } {
  const tokenScore = new Map<string, number>();
  const bigramScore = new Map<string, number>();
  for (const query of members) {
    const tokens = significantTokens(query);
    const weight = Math.max(1, impressions(query));
    for (const token of new Set(tokens)) tokenScore.set(token, (tokenScore.get(token) ?? 0) + weight);
    for (let index = 0; index < tokens.length - 1; index += 1) {
      const gram = `${tokens[index]} ${tokens[index + 1]}`;
      bigramScore.set(gram, (bigramScore.get(gram) ?? 0) + weight);
    }
  }
  const top = (map: Map<string, number>, limit: number) =>
    [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([value]) => value);
  const bigrams = top(bigramScore, 6);
  const tokens = top(tokenScore, 10);
  const terms = [...bigrams, ...tokens].slice(0, 14);
  // A phrase is more specific than a token, so phrases carry membership first.
  const requireAny = [...bigrams.slice(0, 3), ...tokens.slice(0, 3)].slice(0, 6);
  const text = pageTexts.map(normalizeForMatch).join(" | ");
  const coverageRequireAny = terms
    .filter((term) => ` ${text} `.includes(` ${normalizeForMatch(term)} `))
    .slice(0, 8);
  return {
    terms,
    strongTerms: bigrams,
    requireAny: requireAny.length > 0 ? requireAny : terms.slice(0, 3),
    coverageRequireAny,
  };
}

const SYSTEM = [
  "You are an SEO strategist modelling one business so a topic map can be built.",
  "You receive clusters that were formed from the business's own measured Search Console queries. Each cluster has an id and its member queries.",
  "For each cluster decide: keep it as a topic, or drop it because it is off-business, research noise or not something this business can serve.",
  "Keep every cluster that has measured demand and that the business can serve. Different places, property types or services are different topics: do not collapse them into one. Merge only clusters that are the same need in different words.",
  "Name each kept topic in the site language, state its intent, relevance, the kind of page that should own it, and the offer key it belongs to. Explain in one sentence why it matters.",
  "Set preferredPages to the one to three real paths from the supplied inventory that should own the topic. Use only paths that appear in the inventory.",
  "offerKey must be one of the supplied offer names, or the topic name when no offer fits.",
  "Do not invent matching terms: membership comes from the queries. You only name, classify and target.",
  "pageTypeRules map URL prefixes from the inventory to home, service, category, product, blog or other. If the inventory mirrors pages in a second language, exclude those paths unless the business targets that language. Exclude legal, checkout and account pages.",
  "newsQueries are 4 to 6 search queries in the site language that find current news, events or regulation relevant to this business and its market. Use the current year from today, not a past one.",
  "Every supplied cluster id must appear exactly once across the decisions: either as a decision's id, or inside another decision's sourceClusters when you merge clusters that are the same need. Never omit a cluster.",
  "Return exactly one JSON object: { summary, clusters: [{ id, sourceClusters: string[], keep, name, intent, relevance, coverageKind, offerKey, rationale, actionHint, preferredPages, exclusive }], pageTypeRules: [{ type, pattern }], excludePaths: [], newsQueries: [] }.",
  "intent is informational, commercial, transactional, local or mixed. relevance is high, medium or low. coverageKind is service, product, content, local, brand, business or mixed.",
].join("\n");

export async function proposeTopicTaxonomy(
  input: TopicTaxonomyInput
): Promise<{ taxonomy: TopicTaxonomy | null; rejected: Array<{ title: string; reason: string }>; error: string | null; model: string | null }> {
  const config = contentWriterConfig();
  if (!config) return { taxonomy: null, rejected: [], error: "CONTENT_LLM_API_KEY is not configured", model: null };

  const impressions = new Map(input.queries.map((query) => [query.query, query.impressions]));
  const discovered = proposeLexicalClusters(
    input.queries.map((query) => ({ query: query.query, observedAt: new Date() })),
    { minMembers: 2 }
  )
    .sort((a, b) => b.members.reduce((sum, query) => sum + (impressions.get(query) ?? 0), 0) - a.members.reduce((sum, query) => sum + (impressions.get(query) ?? 0), 0))
    .slice(0, 40);
  if (discovered.length === 0) {
    return { taxonomy: null, rejected: [], error: "no query cluster could be formed from the measured demand", model: config.model };
  }

  const payload = {
    domain: input.domain,
    language: input.language,
    country: input.country,
    business: input.business,
    offers: input.marketScope.offers.length > 0 ? input.marketScope.offers : [{ offer: input.business.name ?? input.domain, scope: input.marketScope.default }],
    pages: input.pages.slice(0, 40),
    today: new Date().toISOString().slice(0, 10),
    clusters: discovered.map((cluster) => ({
      id: cluster.identityKey,
      queries: cluster.members.slice(0, 8),
      members: cluster.members.length,
    })),
  };

  try {
    const parsed = await chatJson({
      config,
      system: SYSTEM,
      user: JSON.stringify(payload),
      maxTokens: 24_000,
      temperature: 0.2,
      attempts: 3,
      timeoutMs: 240_000,
      jsonMode: false,
    });
    const record = asRecord(parsed);
    const clusterById = new Map(discovered.map((cluster) => [cluster.identityKey, cluster]));
    const accounted = new Set<string>();
    const rejected: Array<{ title: string; reason: string }> = [];
    const decisions: Array<{ row: Record<string, unknown>; members: string[] }> = [];
    for (const raw of Array.isArray(record.clusters) ? record.clusters : []) {
      const row = asRecord(raw);
      const primary = text(row.id);
      if (!primary || !clusterById.has(primary) || accounted.has(primary)) continue;
      const sources = Array.isArray(row.sourceClusters)
        ? row.sourceClusters.filter((entry): entry is string => typeof entry === "string" && clusterById.has(entry))
        : [];
      const members = [...new Set([primary, ...sources])].filter((id) => !accounted.has(id));
      for (const id of members) accounted.add(id);
      decisions.push({ row, members });
    }
    // A cluster the review never mentioned is not silently dropped: it is
    // reported, so the owner can see what the model skipped.
    for (const cluster of discovered) {
      if (!accounted.has(cluster.identityKey)) {
        rejected.push({ title: cluster.name, reason: "the review did not classify this cluster" });
      }
    }
    const pageTexts = input.pagePaths.map((path) => path);
    const topics: TopicDefinition[] = [];
    const seen = new Set<string>();
    for (const { row: decision, members } of decisions) {
      const merged = members.map((id) => clusterById.get(id)!).filter(Boolean);
      const cluster = merged[0];
      if (!cluster) continue;
      if (decision.keep === false) {
        for (const entry of merged) rejected.push({ title: entry.name, reason: "the review dropped this cluster" });
        continue;
      }
      const name = text(decision.name);
      const intent = text(decision.intent) as TopicIntent | null;
      const relevance = text(decision.relevance) as TopicRelevance | null;
      const coverageKind = text(decision.coverageKind) as TopicCoverageKind | null;
      if (!name || !intent || !INTENTS.includes(intent) || !relevance || !RELEVANCES.includes(relevance) || !coverageKind || !COVERAGE_KINDS.includes(coverageKind)) {
        rejected.push({ title: cluster.name, reason: "the review returned an incomplete classification" });
        continue;
      }
      const slug = slugify(name);
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      const memberQueries = merged.flatMap((entry) => entry.members);
      const derived = deriveTerms(memberQueries, (query) => impressions.get(query) ?? 0, pageTexts);
      topics.push({
        slug,
        name: name.slice(0, 160),
        intent,
        relevance,
        coverageKind,
        offerKey: matchOfferKey(text(decision.offerKey) ?? name, input.marketScope.offers.map((entry) => entry.offer)),
        rationale: text(decision.rationale)?.slice(0, 600) ?? "",
        requireAny: derived.requireAny,
        terms: derived.terms,
        strongTerms: derived.strongTerms,
        coverageRequireAny: derived.coverageRequireAny,
        ...(Array.isArray(decision.preferredPages)
          ? {
              preferredPages: decision.preferredPages
                .filter((entry): entry is string => typeof entry === "string" && entry.startsWith("/"))
                .slice(0, 3),
            }
          : {}),
        ...(decision.exclusive === true ? { exclusive: true } : {}),
        pageTerms: derived.terms,
        actionHint: text(decision.actionHint)?.slice(0, 400) ?? "",
      });
    }
    if (topics.length === 0) {
      return { taxonomy: null, rejected, error: "the review kept no cluster", model: config.model };
    }
    const pageTypeRules: TopicPageTypeRule[] = [];
    for (const raw of Array.isArray(record.pageTypeRules) ? record.pageTypeRules : []) {
      const row = asRecord(raw);
      const type = text(row.type) as TopicPageType | null;
      const pattern = text(row.pattern);
      if (!type || !PAGE_TYPES.includes(type) || !pattern || !pattern.startsWith("/")) continue;
      pageTypeRules.push({ type, pattern: pattern.slice(0, 200) });
    }
    return {
      taxonomy: {
        version: 1,
        proposedBy: "ai",
        model: config.model,
        generatedAt: new Date().toISOString(),
        topics,
        pageTypeRules,
        excludePaths: stringList(record.excludePaths, 20).map((path) => (path.startsWith("/") ? path : `/${path}`)),
        newsQueries: Array.isArray(record.newsQueries)
          ? record.newsQueries.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()).slice(0, 10)
          : [],
        summary: text(record.summary)?.slice(0, 800) ?? null,
      },
      rejected,
      error: null,
      model: config.model,
    };
  } catch (error) {
    return {
      taxonomy: null,
      rejected: [],
      error: error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400),
      model: config.model,
    };
  }
}

export async function loadTopicTaxonomy(db: TopicTaxonomyDb, siteId: string): Promise<TopicTaxonomy | null> {
  const profile = await db.siteProfile.findUnique({ where: { siteId }, select: { constraints: true } });
  const raw = asRecord(profile?.constraints).topicTaxonomy;
  if (!raw) return null;
  const { taxonomy } = parseTopicTaxonomy(raw, {
    proposedBy: asRecord(raw).proposedBy === "human" ? "human" : "ai",
    model: text(asRecord(raw).model),
    generatedAt: text(asRecord(raw).generatedAt) ?? new Date().toISOString(),
  });
  return taxonomy.topics.length > 0 ? taxonomy : null;
}

export async function saveTopicTaxonomy(db: TopicTaxonomyDb, siteId: string, taxonomy: TopicTaxonomy): Promise<void> {
  const profile = await db.siteProfile.findUnique({ where: { siteId }, select: { constraints: true } });
  const constraints = { ...asRecord(profile?.constraints), topicTaxonomy: taxonomy };
  if (profile) {
    await db.siteProfile.update({ where: { siteId }, data: { constraints: constraints as never } });
  } else {
    await db.siteProfile.create({ data: { siteId, constraints: constraints as never } });
  }
}
