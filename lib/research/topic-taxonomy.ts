import type { PrismaClient } from "@prisma/client";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";

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
export type TopicMarketScope = "local" | "national" | "international";
/**
 * A topic is either the business's own name or a market need. The distinction
 * is structural: a brand topic matches its name and nothing else, while a
 * market topic must match both its market and its need.
 */
export type TopicKind = "brand" | "market";

/**
 * Where a topic applies. A topic is place-scoped only when the business serves
 * that place; an international topic has no place requirement. `localIntent`
 * carries phrases that signal local intent without naming the place ("near me",
 * "autour de moi"), in the audience's language.
 */
export type TopicMarket = {
  scope: TopicMarketScope;
  places: string[];
  localIntent: string[];
};

/**
 * What a topic is about, in the words buyers use. This is the need half of
 * membership; the market half is `TopicMarket`. A query belongs to the topic
 * only when both match. A brand topic is the exception: its name is the need.
 */
export type TopicNeed = {
  terms: string[];
};

export type TopicDefinition = {
  slug: string;
  name: string;
  /** Brand topics match their name; market topics match market AND need. */
  kind: TopicKind;
  intent: TopicIntent;
  relevance: TopicRelevance;
  /** What a strong page for this topic looks like. */
  coverageKind: TopicCoverageKind;
  /** The offer key used by the tenant market-scope configuration. */
  offerKey: string;
  /** Where the topic applies. Brand topics do not need a market. */
  market?: TopicMarket;
  /** What the topic is about. Brand topics use requireAny as the name. */
  need?: TopicNeed;
  /** Why this topic matters to the business, in one sentence. */
  rationale: string;
  /** At least one of these must appear in the query for the topic to apply. */
  requireAny: string[];
  /** Every group must have at least one match; used for two-part rules like kit + workshop. */
  requireGroups?: string[][];
  /**
   * A deterministic defect the reviewer must see: `no-need-word` means the
   * topic is defined only by place or brand and would claim every query that
   * names it. It is not an opportunity until the taxonomy is corrected.
   */
  reviewFlags?: string[];
  /** Pages that should be shown first when they match. */
  preferredPages?: string[];
  /** A brand topic claims its query instead of sharing it with a generic topic. */
  exclusive?: boolean;
  /** Base matching terms. Phrases score higher than single tokens. */
  terms: string[];
  /** Extra weight for terms that identify the topic rather than modify it. */
  strongTerms?: string[];
  /**
   * A head term the owning topic claims, matched only when it is the whole
   * query. Shared terms are dropped so they do not blur every topic, but the
   * term that is the entire market must still belong somewhere.
   */
  headTerms?: string[];
  /**
   * Legacy coverage terms, kept only so an older stored taxonomy still parses.
   * Coverage is the owner page now; these no longer decide it.
   */
  coverageRequireAny?: string[];
  /** @deprecated Legacy coverage groups; coverage is the owner page. */
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
  /** The business's market as the owner wrote it, when known. */
  market?: string | null;
  /**
   * Where the audience searches, which is not where the business sits. The
   * taxonomy must serve this audience, not the business address.
   */
  audienceMarket?: string | null;
  audienceCountry?: string | null;
  audienceCountries?: string[];
  /** The language(s) the audience searches in, when known. */
  audienceLanguages?: string[];
  /** The site's own page paths, for coverage grounding. */
  pagePaths: string[];
  business: {
    name: string | null;
    services: string[];
    location: string | null;
    serviceArea: string[];
    audience: string | null;
    /** What the audience wants, from the business knowledge document. */
    audienceMotivations?: string[];
    differentiators: string[];
    concerns: string[];
  };
  marketScope: { default: string; offers: Array<{ offer: string; scope: string; markets?: string[] }> };
  queries: Array<{ query: string; impressions: number; volume: number | null }>;
  pages: Array<{ path: string; title: string; h1: string; wordCount: number }>;
  /**
   * Terms that identify the business by name, carried over from an approved
   * taxonomy. Brand demand must survive a re-proposal even when the model
   * treats two impressions as noise.
   */
  brandTerms?: string[];
  /**
   * Measured queries the previous map left with no owning topic. The map
   * computes the list; the model decides whether each is a missing need term,
   * a split, a missing topic, or off-business. Without this the next proposal
   * starts blind and repeats the omission.
   */
  previousUnmapped?: Array<{ query: string; impressions: number; volume: number | null }>;
  /**
   * The taxonomy in use, so a re-proposal is a revision and not a fresh roll.
   * The model keeps what still owns its demand and changes what the unowned
   * demand requires; the code never merges old and new by itself.
   */
  currentTaxonomy?: Array<{
    name: string;
    kind: string;
    marketScope?: string | null;
    marketPlaces?: string[];
    localIntent?: string[];
    needTerms?: string[];
    ownerPages?: string[];
  }>;
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

/**
 * A path is a fact. Percent-encoding hex digits are case-insensitive
 * (RFC 3986), so a model that copies %c3 for %C3 still names the same page.
 * Nothing else about the path is normalized.
 */
export function normalizePathKey(path: string): string {
  return path.trim().replace(/%[0-9a-f]{2}/gi, (match) => match.toUpperCase());
}

function termInText(text: string, term: string): boolean {
  const normalized = normalizeTerm(term);
  if (!normalized) return false;
  // The model proposes the forms buyers search. Matching is a normalized
  // word-boundary containment, not a morphology engine: no plural or
  // word-order variants live in code.
  return ` ${text} `.includes(` ${normalized} `);
}

/**
 * Whether a term is the business's name rather than a generic word the model
 * split the name into. "casa migo" and "casamigo homes" are the brand; "casa"
 * and "migo" alone are not, and an exclusive brand topic that claims them
 * swallows the whole market ("casas", "casas de cambio").
 */
export function brandTermMatches(term: string, brandKey: string): boolean {
  const compact = term.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!compact) return false;
  const brandTokens = brandKey.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const termTokens = term.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const brandCompact = brandTokens.join("");
  // Spacing and spelling variants of a one-word brand: "casa migo" for
  // "casamigo", "ocean vibes" for "oceanicvibes".
  if (compact.length >= 8 || term.trim().includes(" ")) {
    let shared = 0;
    while (shared < compact.length && shared < brandCompact.length && compact[shared] === brandCompact[shared]) shared += 1;
    if (shared >= 4) return true;
  }
  // Word-order variants of a multi-word brand: "harmonie atelier" and
  // "l'atelier by harmonie" are the same name, "harmonie boutique" is not.
  if (brandTokens.length > 1) {
    const termSet = new Set(termTokens);
    const brandSet = new Set(brandTokens);
    // The term must carry the whole name, in either order. A single word from
    // a multi-word name ("harmonie" from "Atelier de l'harmonie") is not the
    // brand: it is a generic word that would swallow the market.
    if (brandTokens.every((token) => termSet.has(token))) return true;
    if (termTokens.length >= 2 && termTokens.every((token) => brandSet.has(token))) return true;
  }
  return false;
}

/** A brand topic is the business's own name, not a market need. */
export function isBrandTopic(topic: TopicDefinition): boolean {
  return topic.kind === "brand" || (topic.kind === undefined && topic.coverageKind === "brand");
}

/**
 * Does a query name the topic's market?
 *
 * An international topic has no market requirement: it applies wherever the
 * audience is. A local or national topic matches a place it serves, or a phrase
 * that signals local intent without naming the place ("near me", "autour de
 * moi"). The places and phrases are proposed by the model in the audience's
 * language, so this stays tenant-neutral.
 */
export function marketMatches(topic: TopicDefinition, text: string): boolean {
  const market = topic.market;
  if (!market) return true;
  if (market.scope === "international") return true;
  if (market.places.some((term) => termInText(text, term))) return true;
  return market.localIntent.some((term) => termInText(text, term));
}

/**
 * Does a query name the topic's place?
 *
 * This is the context-only test, not membership: a local-intent phrase like
 * "near me" is only meaningful with a need ("freediving near me"), so it must
 * not make "hospital near me" look like context-only demand for every local
 * topic. Context-only is demand that names the place and not the need.
 */
export function placeMatches(topic: TopicDefinition, text: string): boolean {
  const market = topic.market;
  if (!market || market.scope === "international") return false;
  return market.places.some((term) => termInText(text, term));
}

/** Does a query name the topic's need? */
export function needMatches(topic: TopicDefinition, text: string): boolean {
  const need = topic.need;
  if (!need) return true;
  return need.terms.some((term) => termInText(text, term));
}

/**
 * The one membership rule, shared by the topic map and the monthly bundle.
 *
 * - A brand topic matches its name, in any spelling the model supplied.
 * - A market topic matches its market AND its need. Neither half alone is
 *   enough: the place is where, the need is what.
 * - A head term matches only the bare query, so "freediving" is owned once and
 *   "freediving course" still belongs to the course topic.
 * - A taxonomy stored before the structured fields existed falls back to its
 *   lexical terms, so an approved older map keeps working until re-proposed.
 */
export function topicMatchesQuery(topic: TopicDefinition, query: string): boolean {
  const text = normalizeTerm(query);
  const headMatch = (topic.headTerms ?? []).some((term) => normalizeTerm(term) === text);
  if (isBrandTopic(topic)) {
    return headMatch || topic.requireAny.some((term) => termInText(text, term));
  }
  if (topic.market && topic.need) {
    if (!marketMatches(topic, text)) return false;
    return headMatch || needMatches(topic, text);
  }
  // Legacy taxonomy: the flat lexical rule, including any stored groups.
  const anyTerm = headMatch || topic.requireAny.some((term) => termInText(text, term));
  if (!anyTerm) return false;
  if (topic.requireGroups && !topic.requireGroups.every((group) => group.some((term) => termInText(text, term)))) {
    return false;
  }
  return true;
}

/**
 * Does a measured query belong to one of the site's approved topics?
 *
 * The bundle and the topic map both need this answer, and both must give the
 * same one: a site whose Search Console data contains queries the business does
 * not sell into (a hospital query on a property site) should not spend its paid
 * cap measuring them.
 */
export function queryMatchesTopics(topics: TopicDefinition[], query: string): boolean {
  if (topics.length === 0) return false;
  return topics.some((topic) => topicMatchesQuery(topic, query));
}

export function queryMatchesTaxonomy(taxonomy: TopicTaxonomy | null, query: string): boolean {
  if (!taxonomy || taxonomy.topics.length === 0) return false;
  return queryMatchesTopics(taxonomy.topics, query);
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
  const dropped: Array<{ title: string; reason: string }> = [];
  const kept = topics.filter((topic) => {
    const matches = queries.some((query) => topicMatchesQuery(topic, query));
    if (!matches) dropped.push({ title: topic.name, reason: "no measured query matches its terms" });
    return matches;
  });
  return { topics: kept, dropped };
}

const INTENTS: TopicIntent[] = ["informational", "commercial", "transactional", "local", "mixed"];
const RELEVANCES: TopicRelevance[] = ["high", "medium", "low"];
const COVERAGE_KINDS: TopicCoverageKind[] = ["service", "product", "content", "local", "brand", "business", "mixed"];
const MARKET_SCOPES: TopicMarketScope[] = ["local", "national", "international"];
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
 *
 * A structured topic must say where it applies (`market`) and what it is about
 * (`need`). A brand topic needs only its name. A taxonomy stored before those
 * fields existed is still accepted and keeps its legacy lexical membership.
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

  const rawKind = text(row.kind);
  const kind: TopicKind = rawKind === "brand" || coverageKind === "brand" ? "brand" : "market";
  const marketRow = asRecord(row.market);
  const marketScope = text(marketRow.scope) as TopicMarketScope | null;
  const market: TopicMarket | undefined = kind === "market" && marketScope && MARKET_SCOPES.includes(marketScope)
    ? {
        scope: marketScope,
        places: stringList(marketRow.places, 20),
        localIntent: stringList(marketRow.localIntent, 20),
      }
    : undefined;
  const needRow = asRecord(row.need);
  const needTerms = stringList(needRow.terms, 30);
  // A brand topic is the name, not a need. Its terms are brand terms.
  const need: TopicNeed | undefined = kind === "market" && needTerms.length > 0 ? { terms: needTerms } : undefined;

  if (kind === "market" && row.need !== undefined && !need) {
    return { topic: null, reason: `${slug}: no need terms` };
  }
  const effectiveRequireAny = requireAny.length > 0
    ? requireAny
    : need?.terms.length
      ? need.terms
      : terms;
  if (kind === "market" && effectiveRequireAny.length === 0) {
    return { topic: null, reason: `${slug}: no matching terms` };
  }
  const ownerPages = Array.isArray(row.ownerPages) ? row.ownerPages : row.preferredPages;
  return {
    topic: {
      slug,
      name: name.slice(0, 160),
      kind,
      intent,
      relevance,
      coverageKind,
      offerKey: text(row.offerKey)?.slice(0, 120) ?? name.slice(0, 120),
      ...(market ? { market } : {}),
      ...(need ? { need } : {}),
      rationale: text(row.rationale)?.slice(0, 600) ?? "",
      requireAny: effectiveRequireAny,
      ...(Array.isArray(row.requireGroups)
        ? { requireGroups: (row.requireGroups as unknown[]).flatMap((group) => (Array.isArray(group) ? [stringList(group, 10)].filter((entry) => entry.length > 0) : [])) }
        : {}),
      ...(Array.isArray(ownerPages)
        ? { preferredPages: stringList(ownerPages, 10).map((path) => (path.startsWith("/") ? path : `/${path}`)) }
        : {}),
      ...(row.exclusive === true ? { exclusive: true } : {}),
      terms: terms.length > 0 ? terms : effectiveRequireAny,
      strongTerms: stringList(row.strongTerms),
      ...(Array.isArray(row.headTerms) ? { headTerms: stringList(row.headTerms, 10) } : {}),
      coverageRequireAny: stringList(row.coverageRequireAny),
      ...(Array.isArray(row.coverageRequireGroups)
        ? { coverageRequireGroups: (row.coverageRequireGroups as unknown[]).flatMap((group) => (Array.isArray(group) ? [stringList(group, 10)].filter((entry) => entry.length > 0) : [])) }
        : {}),
      pageTerms: pageTerms.length > 0 ? pageTerms : effectiveRequireAny,
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

/**
 * A query sample the model can reason over: the head by impressions, plus a
 * spread of the long tail, because a topic like "awa playacar" has almost no
 * volume but is a real page and a real demand. A sample, not clusters: the
 * lexical discovery merges on shared phrases and collapses a whole market into
 * one component, which the model can then neither split nor correct.
 *
 * The bound is a model-context limit, not a decision about which topics exist.
 * It is deliberately larger than the query sets of a typical site so the model
 * sees the whole market; when a site exceeds it, the proposal summary reports
 * exactly how many queries were not sent.
 */
export function sampleQueries(
  queries: Array<{ query: string; impressions: number; volume: number | null }>,
  limit = 1_500
): Array<{ query: string; impressions: number; volume: number | null }> {
  const sorted = [...queries].sort((a, b) => b.impressions - a.impressions);
  if (sorted.length <= limit) return sorted;
  const head = sorted.slice(0, Math.min(sorted.length, Math.ceil(limit * 0.7)));
  const rest = sorted.slice(head.length);
  const tail: typeof rest = [];
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, limit - head.length)));
  for (let index = 0; index < rest.length && tail.length < limit - head.length; index += step) tail.push(rest[index]);
  return [...head, ...tail];
}

const SYSTEM = [
  "You are an SEO strategist modelling one business so a topic map can be built.",
  "You receive the business's own facts, the offers it sells with their market scope, its page inventory, the audience market and language where its buyers search, and a sample of its measured Search Console queries.",
  "The business's services list is authoritative: every service the owner lists must have at least one topic. If it lists renting, buying, management or advice, the taxonomy contains a topic for it even when its query volume is small.",
  "The audience market is where the business sells and where its buyers search. It governs the market and the language of the topics; the business address is context, not the audience.",
  "Define the topics this business can serve. A topic is one need with one kind of page that should own it.",
  "Every topic is either a brand topic or a market topic. A brand topic is the business's own name and matches only that name. A market topic must say where it applies and what it is about, and a query belongs to it only when both match.",
  "If the query set contains searches for the business's own name, include a brand topic. The brand topic is the name and nothing else; do not split the name into generic words.",
  "For a market topic set marketScope to local, national or international. A local or national topic must list the places it serves in marketPlaces, and the phrases that signal local intent without naming a place in localIntent, in the audience's language (for example 'near me', 'autour de moi', 'cerca de mí'). An international topic has no place requirement.",
  "Use local or national only when the demand itself names the place or has local intent. A service a buyer can search without naming the town is international, even when the business is local; otherwise the topic cannot match the service query.",
  "needTerms are the words that make a query about this topic rather than about the place, the brand or another topic. Name the need in the language buyers search, not necessarily the site language. A market topic with no need term is not a topic.",
  "Include the forms buyers actually search: singular and plural, both word orders, and the common synonyms in the audience language. If the same need appears as 'lampe artisanale' and 'lampes artisanales', or as 'fauteuil restauration' and 'restauration fauteuil', include both. The matcher does not generate variants.",
  "A need term must distinguish this topic from the others: a word every topic in the same market uses belongs to none of them, and a generic word that also names the brand is not a need.",
  "Never put the business's location, service area or brand name in needTerms. The place belongs in marketPlaces; the brand is its own topic.",
  "headTerms are bare terms this topic should own on their own, such as the service name. If the query set contains a bare service term the whole market searches, give it to the topic that should own it as a headTerm. Only add one when the whole term belongs to this topic, and give it to at most one topic.",
  "Different places and different product or service types are different topics. Do not collapse a market into one topic: if the queries separate into houses in one place, condos in another and rentals in a third, those are three topics.",
  "One topic has one owning page. If two topics would be owned by the same page, they are one topic: merge them instead of listing both.",
  "For each topic, set memberQueries to between three and eight queries copied exactly from the supplied list. They are the evidence the topic exists; choose the queries that most clearly belong to it.",
  "A query may appear in at most two topics, and only when it genuinely serves both.",
  "Every distinct place or need with measured demand must have a topic. Leave out only queries that are off-business or research noise, and say why in the summary. Do not invent a topic to cover noise.",
  "previousUnmapped lists measured queries that the previous map left with no owning topic. Decide each one: add its missing need term to the topic it belongs to, split a topic, add the topic it needs, or leave it out as off-business and say why in the summary. Never add a term just to claim a query whose intent is different.",
  "currentTaxonomy is the taxonomy in use. Revise it; do not replace it with a fresh guess. Keep a topic whose cited queries it still owns, change only what the unowned demand requires, and return the complete revised taxonomy.",
  "If audienceMarket is empty, infer the audience from the site, the audience facts and the query mix, and say so in the summary.",
  "Set ownerPages to the one to three real paths from the supplied inventory that should own the topic. The field must be present. Prefer the page that sells or explains the topic, with real content, over a thin archive: a tag page is never the owner when a service or category page covers the same topic. Return an empty list only when the site truly has no page for the topic, and say so in the rationale.",
  "offerKey must be copied exactly from the supplied offer names, or be the topic name when no offer fits. Do not paraphrase an offer name.",
  "pageTypeRules are required: map the inventory's URL prefixes to home, service, category, product, blog or other. If the inventory mirrors pages in a second language, exclude those paths unless the business targets that language. Exclude legal, checkout and account pages, tag archives, paginated lists and search-result paths.",
  "newsQueries are 4 to 6 search queries in the site language that find current news, events or regulation relevant to this business and its market. Use the current year from today, not a past one.",
  "Return exactly one JSON object, with no prose around it: { summary, topics: [{ name, kind, marketScope, marketPlaces: string[], localIntent: string[], needTerms: string[], headTerms: string[], intent, relevance, coverageKind, offerKey, rationale, actionHint, memberQueries: string[], ownerPages: string[], exclusive }], pageTypeRules: [{ type, pattern }], excludePaths: [], newsQueries: [] }.",
  "Keep summary under 300 characters, each rationale and actionHint under 160, and at most 12 topics.",
  "kind is brand or market. marketScope is local, national or international. intent is informational, commercial, transactional, local or mixed. relevance is high, medium or low. coverageKind is service, product, content, local, brand, business or mixed.",
].join("\n");

type ContextGap = {
  topic: string;
  queries: string[];
  impressions: number;
  volume: number;
};

/**
 * Demand that names a topic's market but not its need, and that no other topic
 * owns. This is the signal that the taxonomy is incomplete: the place is
 * covered, the need is missing. It is computed from the sample the model saw,
 * so a correction can name the exact queries.
 */
function contextGaps(
  topics: TopicDefinition[],
  queries: Array<{ query: string; impressions: number; volume: number | null }>
): ContextGap[] {
  const gaps: ContextGap[] = [];
  for (const topic of topics) {
    if (isBrandTopic(topic) || !topic.market) continue;
    const unowned = queries.filter((query) => {
      const text = normalizeTerm(query.query);
      if (topicMatchesQuery(topic, query.query)) return false;
      if (!placeMatches(topic, text)) return false;
      return !topics.some((other) => other !== topic && topicMatchesQuery(other, query.query));
    });
    if (unowned.length === 0) continue;
    gaps.push({
      topic: topic.name,
      queries: unowned.slice(0, 8).map((query) => query.query),
      impressions: unowned.reduce((sum, query) => sum + query.impressions, 0),
      volume: unowned.reduce((sum, query) => sum + (query.volume ?? 0), 0),
    });
  }
  return gaps;
}

export async function proposeTopicTaxonomy(
  input: TopicTaxonomyInput
): Promise<{
  taxonomy: TopicTaxonomy | null;
  rejected: Array<{ title: string; reason: string }>;
  /** Topics the model gave the same owning page, merged into one. */
  merges: Array<{ into: string; merged: string[]; page: string }>;
  error: string | null;
  model: string | null;
}> {
  const config = contentWriterConfig();
  if (!config) return { taxonomy: null, rejected: [], merges: [], error: "CONTENT_LLM_API_KEY is not configured", model: null };
  if (input.queries.length === 0) {
    return { taxonomy: null, rejected: [], merges: [], error: "no measured query to model", model: config.model };
  }

  const sample = sampleQueries(input.queries);
  const omittedQueries = Math.max(0, input.queries.length - sample.length);
  const sampleByKey = new Map(sample.map((query) => [normalizeTerm(query.query), query.query]));
  const baseBrandTerms = [...new Set((input.brandTerms ?? []).map(normalizeTerm).filter(Boolean))];
  // The previous map's unmapped demand is the cross-run feedback loop. Bound it
  // to what the model can read and report the count it did not send.
  const previousUnmappedAll = input.previousUnmapped ?? [];
  const previousUnmapped = previousUnmappedAll.slice(0, 200);
  const payload = {
    domain: input.domain,
    language: input.language,
    // The business address is context, not the audience. Keep both so the
    // model can tell a Tulum agency selling to US buyers from a local shop.
    businessCountry: input.country,
    market: input.market ?? null,
    audienceMarket: input.audienceMarket ?? null,
    audienceCountry: input.audienceCountry ?? null,
    audienceCountries: input.audienceCountries ?? [],
    audienceLanguages: input.audienceLanguages ?? [],
    business: input.business,
    offers: input.marketScope.offers.length > 0 ? input.marketScope.offers : [{ offer: input.business.name ?? input.domain, scope: input.marketScope.default }],
    // The whole inventory. A cap here is invisible to the model and to the
    // reader: it silently removes the page that should own a topic.
    pages: input.pages,
    today: new Date().toISOString().slice(0, 10),
    queries: sample,
    // Measured demand the previous map could not place. The code lists it; the
    // model decides why it is unowned.
    previousUnmapped: previousUnmapped.length > 0
      ? { count: previousUnmappedAll.length, sent: previousUnmapped.length, queries: previousUnmapped }
      : null,
    currentTaxonomy: input.currentTaxonomy ?? [],
  };

  const brandKey = input.business.name ?? input.domain.replace(/^www\./, "").split(".")[0];

  /**
   * Turn one model response into a taxonomy. The model proposes the market and
   * the need; the deterministic layer only enforces the contract: a market
   * topic needs a need, a local topic needs a place, one page owns one topic.
   * The code never fills a semantic field: a missing need, place or owner is a
   * contract rejection, and the single re-proposal asks the model again.
   */
  function build(record: Record<string, unknown>): {
    topics: TopicDefinition[];
    rejected: Array<{ title: string; reason: string }>;
    merges: Array<{ into: string; merged: string[]; page: string }>;
    pageTypeRules: TopicPageTypeRule[];
    excludePaths: string[];
    newsQueries: string[];
    summary: string | null;
    membersBySlug: Map<string, string[]>;
    filled: string[];
  } {
    const topics: TopicDefinition[] = [];
    const rejected: Array<{ title: string; reason: string }> = [];
    const filled: string[] = [];
    const seen = new Set<string>();
    const membersBySlug = new Map<string, string[]>();
    for (const raw of Array.isArray(record.topics) ? record.topics : []) {
      const row = asRecord(raw);
      const name = text(row.name);
      const intent = text(row.intent) as TopicIntent | null;
      const relevance = text(row.relevance) as TopicRelevance | null;
      const coverageKind = text(row.coverageKind) as TopicCoverageKind | null;
      if (!name) continue;
      if (!intent || !INTENTS.includes(intent) || !relevance || !RELEVANCES.includes(relevance) || !coverageKind || !COVERAGE_KINDS.includes(coverageKind)) {
        rejected.push({ title: name, reason: "incomplete classification" });
        continue;
      }
      const memberQueries = Array.isArray(row.memberQueries)
        ? [...new Set(row.memberQueries.filter((entry): entry is string => typeof entry === "string").map((entry) => sampleByKey.get(normalizeTerm(entry))).filter((entry): entry is string => Boolean(entry)))]
        : [];
      // One cited query is still evidence. Requiring two would delete the
      // branded demand of a listings site ("ikuku for sale") that has no
      // sibling query, which is a real topic with a real page.
      if (memberQueries.length < 1) {
        rejected.push({ title: name, reason: "cites no query from the sample" });
        continue;
      }
      const slug = slugify(name);
      if (!slug || seen.has(slug)) continue;

      const kind: TopicKind = text(row.kind) === "brand" || coverageKind === "brand" ? "brand" : "market";
      const proposedOffer = text(row.offerKey);
      const offerKey = proposedOffer && input.marketScope.offers.some((offer) => offer.offer === proposedOffer)
        ? proposedOffer
        : name;
      if (proposedOffer && offerKey !== proposedOffer) {
        filled.push(`${name}: offerKey "${proposedOffer}" is not a supplied offer; using the topic name`);
      }
      const ownerField = Array.isArray(row.ownerPages) ? row.ownerPages : Array.isArray(row.preferredPages) ? row.preferredPages : null;
      if (ownerField === null) {
        rejected.push({ title: name, reason: "no ownerPages field" });
        continue;
      }
      const proposedOwners = ownerField
        .filter((entry): entry is string => typeof entry === "string" && entry.startsWith("/"))
        .filter((path) => !stringList(record.excludePaths, 20).some((excluded) => path.startsWith(excluded.startsWith("/") ? excluded : `/${excluded}`)))
        .slice(0, 3);
      // An owner must be a real page. A path the model invented reports "no
      // page covers this topic" for a topic that has one, so it is a contract
      // rejection, not a coverage fact.
      const inventory = new Set(input.pages.map((page) => normalizePathKey(page.path)));
      const ownerPages = proposedOwners.filter((path) => inventory.has(normalizePathKey(path)));
      if (proposedOwners.length > ownerPages.length) {
        const unknown = proposedOwners.filter((path) => !inventory.has(normalizePathKey(path)));
        filled.push(`${name}: owner pages not in the supplied inventory (${unknown.join(", ")})`);
      }
      if (proposedOwners.length > 0 && ownerPages.length === 0) {
        rejected.push({ title: name, reason: "owner pages are not in the supplied inventory" });
        continue;
      }
      if (ownerPages.length === 0) filled.push(`${name}: no owner page proposed`);
      const headTerms = stringList(row.headTerms, 10);

      const needTerms = stringList(row.needTerms, 30);
      let marketScope = text(row.marketScope) as TopicMarketScope | null;
      const places = stringList(row.marketPlaces, 20);
      const localIntent = stringList(row.localIntent, 20);
      const exclusive = row.exclusive === true;

      if (kind === "brand") {
        // A brand topic is the name and nothing else. The model supplies the
        // name; the site's own name is used only when the model gave no
        // name-like term at all.
        const supplied = [...stringList(row.brandTerms), ...needTerms, ...stringList(row.requireAny)]
          .filter((term) => brandTermMatches(term, brandKey));
        const brandTerms = supplied.length > 0 ? [...new Set(supplied)] : baseBrandTerms;
        if (brandTerms.length === 0) {
          rejected.push({ title: name, reason: "brand topic names no brand term" });
          continue;
        }
        seen.add(slug);
        membersBySlug.set(slug, memberQueries);
        topics.push({
          slug,
          name: name.slice(0, 160),
          kind: "brand",
          intent,
          relevance,
          coverageKind: "brand",
          offerKey,
          rationale: text(row.rationale)?.slice(0, 600) ?? "",
          requireAny: brandTerms,
          terms: brandTerms,
          strongTerms: brandTerms,
          ...(headTerms.length > 0 ? { headTerms } : {}),
          pageTerms: brandTerms,
          ...(ownerPages.length > 0 ? { preferredPages: ownerPages } : {}),
          exclusive: true,
          actionHint: text(row.actionHint)?.slice(0, 400) ?? "",
        });
        continue;
      }

      if (!marketScope || !MARKET_SCOPES.includes(marketScope)) {
        const offerScope = input.marketScope.offers.find((offer) => normalizeTerm(offer.offer) === normalizeTerm(offerKey))?.scope;
        marketScope = offerScope && MARKET_SCOPES.includes(offerScope as TopicMarketScope) ? (offerScope as TopicMarketScope) : "international";
      }
      if (needTerms.length === 0) {
        // A market topic without a need cannot match anything. The model must
        // supply the need; the re-proposal asks again, and a topic that still
        // has none is dropped rather than guessed.
        rejected.push({ title: name, reason: "no need terms" });
        continue;
      }
      // A need term the query set never uses is unmeasured, not wrong: the
      // business may serve demand the current window does not show. Keep it
      // and record it, so the taxonomy is not silently narrowed.
      const sampleTexts = sample.map((query) => normalizeTerm(query.query));
      const unmeasured = needTerms.filter((term) => !sampleTexts.some((text) => termInText(text, term)));
      if (unmeasured.length > 0 && unmeasured.length < needTerms.length) {
        filled.push(`${name}: need terms not measured in this query set (${unmeasured.join(", ")})`);
      }
      if (marketScope !== "international" && places.length === 0 && localIntent.length === 0) {
        // A place-scoped topic must say where. The model decides the scope;
        // the contract only checks that the scope has a place.
        rejected.push({ title: name, reason: "no market places for a local or national topic" });
        continue;
      }

      const definition: TopicDefinition = {
        slug,
        name: name.slice(0, 160),
        kind: "market",
        intent,
        relevance,
        coverageKind,
        offerKey,
        market: {
          scope: marketScope,
          places: marketScope === "international" ? [] : places,
          localIntent,
        },
        need: { terms: needTerms },
        rationale: text(row.rationale)?.slice(0, 600) ?? "",
        requireAny: needTerms,
        terms: needTerms,
        strongTerms: needTerms.filter((term) => term.includes(" ")),
        ...(headTerms.length > 0 ? { headTerms } : {}),
        pageTerms: needTerms,
        ...(ownerPages.length > 0 ? { preferredPages: ownerPages } : {}),
        ...(exclusive ? { exclusive: true } : {}),
        actionHint: text(row.actionHint)?.slice(0, 400) ?? "",
      };
      // The cited evidence must satisfy the topic's own contract. A local
      // topic whose cited queries name no place is not local, and a need list
      // that cannot match its own evidence cannot match the market either.
      // This is arithmetic on the model's own citations, not a guess.
      if (!memberQueries.some((query) => topicMatchesQuery(definition, query))) {
        rejected.push({ title: name, reason: "cites no query that matches its own market and need" });
        continue;
      }
      seen.add(slug);
      membersBySlug.set(slug, memberQueries);
      topics.push(definition);
    }

    // Brand demand is the site's own name. The model must propose the brand
    // topic; if it does not, the contract rejects the proposal and the one
    // re-proposal asks again. The code never creates a topic.
    if (baseBrandTerms.length > 0 && !topics.some((topic) => isBrandTopic(topic))) {
      const brandMembers = input.queries
        .map((query) => query.query)
        .filter((query) => baseBrandTerms.some((term) => termInText(normalizeTerm(query), term)));
      if (brandMembers.length > 0) {
        rejected.push({ title: `${brandKey} brand`, reason: "brand demand exists but the proposal has no brand topic" });
      }
    }
    if (topics.length === 0) {
      return {
        topics,
        rejected,
        merges: [],
        pageTypeRules: [],
        excludePaths: [],
        newsQueries: [],
        summary: null,
        membersBySlug,
        filled,
      };
    }

    // One topic has one owning page. When the model gives two topics the same
    // owner, they are one topic: merging keeps both query sets instead of
    // leaving two rows that fight over a page and split its demand.
    const merges: Array<{ into: string; merged: string[]; page: string }> = [];
    const byOwner = new Map<string, TopicDefinition[]>();
    for (const topic of topics) {
      const owner = topic.preferredPages?.[0];
      // The homepage can own several broad topics; a specific page cannot.
      // A brand topic is exempt: it is the name, not a market need, so it may
      // share an about page with a topic without becoming that topic.
      if (!owner || owner === "/" || isBrandTopic(topic)) continue;
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), topic]);
    }
    const removed = new Set<string>();
    for (const [page, group] of byOwner) {
      if (group.length < 2) continue;
      const relevanceRank = (topic: TopicDefinition) => RELEVANCES.indexOf(topic.relevance);
      const survivor = [...group].sort(
        (a, b) => relevanceRank(a) - relevanceRank(b) || (membersBySlug.get(b.slug)?.length ?? 0) - (membersBySlug.get(a.slug)?.length ?? 0)
      )[0];
      const memberQueries = [...new Set(group.flatMap((topic) => membersBySlug.get(topic.slug) ?? []))];
      // The merged topic keeps the union of both need lists. No derived terms:
      // the model's need terms are the vocabulary.
      const mergedNeed = [...new Set(group.flatMap((topic) => topic.need?.terms ?? []))];
      survivor.need = { terms: mergedNeed };
      survivor.requireAny = mergedNeed;
      survivor.terms = mergedNeed;
      survivor.strongTerms = mergedNeed.filter((term) => term.includes(" "));
      survivor.pageTerms = mergedNeed;
      survivor.headTerms = [...new Set(group.flatMap((topic) => topic.headTerms ?? []))];
      if (group.some((topic) => topic.exclusive)) survivor.exclusive = true;
      const mergedNames = group.filter((topic) => topic !== survivor).map((topic) => topic.name);
      survivor.rationale = [survivor.rationale, `Merged with ${mergedNames.join(", ")}: the same page owns both topics.`]
        .filter(Boolean)
        .join(" ")
        .slice(0, 600);
      membersBySlug.set(survivor.slug, memberQueries);
      for (const topic of group) if (topic !== survivor) removed.add(topic.slug);
      merges.push({ into: survivor.name, merged: mergedNames, page });
    }
    if (removed.size > 0) {
      for (const slug of removed) {
        const index = topics.findIndex((topic) => topic.slug === slug);
        if (index >= 0) topics.splice(index, 1);
      }
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
      topics,
      rejected,
      merges,
      pageTypeRules,
      excludePaths: stringList(record.excludePaths, 20).map((path) => (path.startsWith("/") ? path : `/${path}`)),
      newsQueries: Array.isArray(record.newsQueries)
        ? record.newsQueries.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()).slice(0, 10)
        : [],
      summary: text(record.summary)?.slice(0, 800) ?? null,
      membersBySlug,
      filled,
    };
  }

  try {
    const first = await chatJson({
      config,
      system: SYSTEM,
      user: JSON.stringify(payload),
      // A reasoning model spends budget before emitting; 24k produced a
      // truncated JSON on a 1,000-query site.
      maxTokens: 32_000,
      temperature: 0.2,
      attempts: 3,
      timeoutMs: 300_000,
      jsonMode: false,
    });
    let result = build(asRecord(first));
    let correctionNote: string | null = null;
    // The first proposal can leave demand that names a topic's place but not
    // its need, or reject a topic for an incomplete contract. Both are
    // incomplete taxonomies, not reports to clean up later: ask once, naming
    // the exact unowned queries and the rejected topics, for a correction.
    const gaps = contextGaps(result.topics, sample);
    const material = gaps.filter((gap) => gap.queries.length >= 2 || gap.volume >= 100 || gap.impressions >= 10);
    // The other half of the fact: queries that match no topic at all. The code
    // computes the list; the model decides whether they are a missing topic, a
    // missing term, or off-business.
    const owned = new Set<string>();
    for (const query of sample) {
      if (result.topics.some((topic) => topicMatchesQuery(topic, query.query))) owned.add(query.query);
    }
    const unowned = sample.filter((query) => !owned.has(query.query)).map((query) => query.query);
    const unownedQueries = unowned.slice(0, 60);
    const needsCorrection =
      material.length > 0 ||
      unowned.length > 0 ||
      (result.topics.length === 0 && result.rejected.length > 0);
    if (needsCorrection) {
      try {
        const corrected = await chatJson({
          config,
          system: SYSTEM,
          user: JSON.stringify({
            ...payload,
            correction: {
              reason: material.length > 0
                ? "The first proposal left measured queries that name a topic's market but not its need, and no other topic owns them."
                : unowned.length > 0
                  ? "The first proposal left measured queries that no topic owns."
                  : "The first proposal contained topics that do not satisfy the topic contract.",
              unownedContext: material,
              unownedQueries,
              unownedCount: unowned.length,
              rejected: result.rejected,
              instruction: "Correct the taxonomy. Add the missing need term to the topic, split the topic when the queries are a different need, or add a topic that owns the unowned queries. If a query is off-business or research noise, leave it out and say why in the summary. Never put the place or brand in needTerms. Return the complete corrected taxonomy, not a diff.",
            },
          }),
          maxTokens: 32_000,
          temperature: 0.2,
          attempts: 2,
          timeoutMs: 300_000,
          jsonMode: false,
        });
        const second = build(asRecord(corrected));
        if (second.topics.length > 0) {
          const firstRejected = result.rejected.length;
          result = second;
          correctionNote = material.length > 0
            ? `Re-proposed once after ${material.length} topic${material.length === 1 ? "" : "s"} left unowned market demand.`
            : unowned.length > 0
              ? `Re-proposed once after ${unowned.length} queries matched no topic.`
              : `Re-proposed once after ${firstRejected} incomplete topic${firstRejected === 1 ? "" : "s"}.`;
        }
      } catch {
        // A failed correction keeps the first proposal; the map still reports
        // the context-only gap, so nothing is hidden.
        correctionNote = `Re-proposal failed; ${material.length} topic${material.length === 1 ? "" : "s"} keep unowned market demand in the report.`;
      }
    }
    if (result.topics.length === 0) {
      return { taxonomy: null, rejected: result.rejected, merges: [], error: "the review proposed no usable topic", model: config.model };
    }
    return {
      taxonomy: {
        version: 1,
        proposedBy: "ai",
        model: config.model,
        generatedAt: new Date().toISOString(),
        topics: result.topics,
        pageTypeRules: result.pageTypeRules,
        excludePaths: result.excludePaths,
        newsQueries: result.newsQueries,
        summary: [
          result.summary,
          omittedQueries > 0 ? `${omittedQueries} of ${input.queries.length} queries were outside the sample the model saw.` : null,
          result.merges.length > 0 ? `${result.merges.length} topic pair${result.merges.length === 1 ? "" : "s"} shared an owning page and were merged.` : null,
          result.filled.length > 0 ? `${result.filled.length} topic correction${result.filled.length === 1 ? "" : "s"}: ${result.filled.join("; ")}.` : null,
          correctionNote,
        ]
          .filter(Boolean)
          .join(" ") || null,
      },
      rejected: result.rejected,
      merges: result.merges,
      error: null,
      model: config.model,
    };
  } catch (error) {
    return {
      taxonomy: null,
      rejected: [],
      merges: [],
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

export type TaxonomyStabilization = {
  topics: TopicDefinition[];
  merges: Array<{ into: string; merged: string[]; page: string }>;
  headTerms: Array<{ term: string; owner: string; volume: number }>;
};

/**
 * Deterministic ownership rules applied to an approved taxonomy.
 *
 * The model proposes the topics, the market and the need. This pass enforces
 * only the invariants that must hold whatever the model said:
 *
 * - a brand topic matches its name, and the site's own name matches even when
 *   the model spelled it as two words;
 * - one owning page per topic: two topics the proposal gave the same specific
 *   page are one topic. The homepage is exempt because it legitimately owns
 *   several broad topics.
 *
 * It does not invent head terms, drop shared terms or widen a topic's need.
 * Those are the taxonomy's job, and the stored taxonomy is what the map uses.
 */
export function stabilizeTopicTaxonomy(input: {
  topics: TopicDefinition[];
  queries: Array<{ query: string; impressions: number; volume: number | null }>;
  /** The site's own name key (domain label or business name), for brand membership. */
  brandKey?: string;
}): TaxonomyStabilization {
  const topics = input.topics.map((topic) => ({
    ...topic,
    ...(topic.market
      ? { market: { ...topic.market, places: [...topic.market.places], localIntent: [...topic.market.localIntent] } }
      : {}),
    ...(topic.need ? { need: { terms: [...topic.need.terms] } } : {}),
    requireAny: [...topic.requireAny],
    terms: [...topic.terms],
    strongTerms: [...(topic.strongTerms ?? [])],
    coverageRequireAny: [...(topic.coverageRequireAny ?? [])],
    headTerms: [...(topic.headTerms ?? [])],
  }));
  const siteBrandKey = (input.brandKey ?? "").toLowerCase();
  const siteBrandCompact = siteBrandKey.replace(/[^a-z0-9]/g, "");
  for (const topic of topics) {
    if (!isBrandTopic(topic)) continue;
    const brandKey = siteBrandKey || topic.slug.split("-")[0];
    const filtered = topic.requireAny.filter((term) => brandTermMatches(term, brandKey));
    // The site's own name must match even when the model spelled the brand as
    // two words: "OceanicVibes" is not "ocean vibes" to a substring matcher.
    if (siteBrandCompact && !filtered.some((term) => term.toLowerCase().replace(/[^a-z0-9]/g, "") === siteBrandCompact)) {
      filtered.push(siteBrandCompact);
    }
    if (filtered.length > 0) {
      topic.requireAny = filtered;
      topic.terms = [...new Set([...topic.terms, ...filtered])];
      topic.strongTerms = [...new Set([...(topic.strongTerms ?? []), ...filtered])];
    }
  }

  const members = new Map<string, string[]>();
  for (const topic of topics) {
    members.set(
      topic.slug,
      input.queries.filter((query) => topicMatchesQuery(topic, query.query)).map((query) => query.query)
    );
  }

  const merges: TaxonomyStabilization["merges"] = [];
  const byOwner = new Map<string, TopicDefinition[]>();
  for (const topic of topics) {
    const owner = topic.preferredPages?.[0];
    // The homepage can own several broad topics; a specific page cannot. A
    // brand topic is exempt: it may share an about page without merging.
    if (!owner || owner === "/" || isBrandTopic(topic)) continue;
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), topic]);
  }
  const removed = new Set<string>();
  for (const [page, group] of byOwner) {
    if (group.length < 2) continue;
    const relevanceRank = (topic: TopicDefinition) => RELEVANCES.indexOf(topic.relevance);
    const survivor = [...group].sort(
      (a, b) => relevanceRank(a) - relevanceRank(b) || (members.get(b.slug)?.length ?? 0) - (members.get(a.slug)?.length ?? 0)
    )[0];
    const union = [...new Set(group.flatMap((topic) => members.get(topic.slug) ?? []))];
    if (union.length > 0) {
      // The merged topic keeps every need term from both sides. No derived
      // terms: the model's need terms are the vocabulary.
      const needTerms = [...new Set(group.flatMap((topic) => topic.need?.terms ?? []))];
      survivor.need = { terms: needTerms };
      survivor.market = {
        scope: survivor.market?.scope ?? "international",
        places: [...new Set(group.flatMap((topic) => topic.market?.places ?? []))],
        localIntent: [...new Set(group.flatMap((topic) => topic.market?.localIntent ?? []))],
      };
      survivor.requireAny = needTerms;
      survivor.terms = needTerms;
      survivor.strongTerms = needTerms.filter((term) => term.includes(" "));
      survivor.pageTerms = needTerms;
    }
    if (group.some((topic) => topic.exclusive)) survivor.exclusive = true;
    survivor.headTerms = [...new Set(group.flatMap((topic) => topic.headTerms ?? []))];
    const mergedNames = group.filter((topic) => topic !== survivor).map((topic) => topic.name);
    survivor.rationale = [survivor.rationale, `Merged with ${mergedNames.join(", ")}: the same page owns both topics.`]
      .filter(Boolean)
      .join(" ")
      .slice(0, 600);
    members.set(survivor.slug, union);
    for (const topic of group) if (topic !== survivor) removed.add(topic.slug);
    merges.push({ into: survivor.name, merged: mergedNames, page });
  }
  const kept = removed.size > 0 ? topics.filter((topic) => !removed.has(topic.slug)) : topics;

  // Head terms are proposed by the model and stored on the topic. This pass
  // only reports them; it does not invent or reassign one.
  const headTerms: TaxonomyStabilization["headTerms"] = kept.flatMap((topic) =>
    (topic.headTerms ?? []).map((term) => ({
      term,
      owner: topic.name,
      volume: Math.max(
        0,
        ...input.queries.filter((query) => termInText(normalizeTerm(query.query), term)).map((query) => query.volume ?? 0)
      ),
    }))
  );

  return { topics: kept, merges, headTerms };
}
