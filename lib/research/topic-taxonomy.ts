import type { PrismaClient } from "@prisma/client";

import type { Job, JobMap } from "@/lib/research/job-map";

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
  /**
   * The job this topic rolls up, from the accepted job map. One topic is one
   * job; membership for the measured window follows the job's query verdicts,
   * so a project name with no place word still belongs to its local job.
   */
  jobSlug?: string;
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
      ...(text(row.job) ? { jobSlug: text(row.job) as string } : {}),
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
 * One job, one topic. This is the only place a taxonomy is built now: the job
 * map already decided the job, its market, its page and its need terms, so the
 * topic is a projection, not a second semantic pass. No merge, no re-proposal,
 * no code reconciliation.
 */
export function projectTopicsFromJobs(jobs: Job[]): TopicDefinition[] {
  return jobs
    .filter((job) => job.businessFit !== "does_not_serve")
    .map((job) => {
      const terms = job.topic.needTerms;
      return {
        slug: job.slug,
        name: job.topic.name,
        jobSlug: job.slug,
        kind: job.topic.kind,
        intent: job.topic.intent,
        relevance: job.topic.relevance,
        coverageKind: job.topic.coverageKind,
        offerKey: job.topic.offerKey,
        market: { scope: job.market.scope, places: job.market.places, localIntent: job.topic.localIntent },
        need: { terms },
        rationale: job.reason,
        requireAny: terms,
        terms,
        strongTerms: terms.filter((term) => term.includes(" ")),
        pageTerms: terms,
        ...(job.page ? { preferredPages: [job.page] } : {}),
        actionHint: job.topic.actionHint,
      };
    });
}

/** The topic map's input is the job map; nothing else authors it. */
export function projectTopicTaxonomy(jobMap: JobMap): TopicTaxonomy {
  return {
    version: 1,
    proposedBy: jobMap.proposedBy,
    model: jobMap.model,
    generatedAt: jobMap.generatedAt,
    topics: projectTopicsFromJobs(jobMap.jobs),
    pageTypeRules: jobMap.pageTypeRules,
    excludePaths: jobMap.excludePaths,
    newsQueries: jobMap.newsQueries,
    summary: jobMap.summary,
  };
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
 * The remaining mechanical pass over a stored taxonomy.
 *
 * The model decides the topics, the pages they own and their need terms. Two
 * jobs may legitimately share one page, and that is the model's decision, not
 * something code unpicks or merges here. This pass only checks a fact: a brand
 * topic matches its own name, including when the model spelled the site name
 * as two words.
 *
 * It does not invent head terms, drop topics, merge owners or widen a topic's
 * need. It only reports the head terms the model proposed.
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

  // Two jobs may share one owner page: the model said so, and this pass does
  // not get to overrule it. Nothing is merged or removed here.
  const kept = topics;
  const merges: TaxonomyStabilization["merges"] = [];

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
