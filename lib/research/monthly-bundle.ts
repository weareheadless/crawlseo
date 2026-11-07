import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";
import {
  collectKeywordDiscovery,
  collectKeywordMetrics,
  collectSerpSnapshots,
  type CollectionInput,
  type CollectionOutput,
} from "@/lib/dataforseo/collection";
import {
  collectGoogleAiOverviews,
  type GoogleAiOverviewCollectionInput,
  type GoogleAiOverviewCollectionOutput,
} from "@/lib/dataforseo/google-ai-overview-collection";
import { DATAFORSEO_LOCATION_CODES } from "@/lib/dataforseo/locale";
import { backfillSiteEvidence, type BackfillResult } from "@/lib/funnel/backfill";
import { ConnectorError } from "@/lib/connectors/service";
import {
  bridgeBusinessKnowledgeToEvidence,
  type BusinessKnowledgeBridgeResult,
} from "@/lib/projects/business-knowledge-evidence";
import { fetchGoogleNewsRssSearch } from "@/lib/research/providers/google-news-rss";
import type { ResearchProviderSource } from "@/lib/research/providers/types";
import { saveResearchSources } from "@/lib/research/service";
import type { ResearchSourceInput } from "@/lib/research/types";
import { effectiveMonthlyAllowance, usesDefaultAllowance } from "@/lib/billing/budget-defaults";
import { businessKnowledgeFields, providerCountry, resolveSiteContext, type SiteContext } from "@/lib/site/context";
import {
  proposeDiscoverySeeds,
  type DiscoverySeedInput,
  type DiscoverySeedResult,
} from "@/lib/research/discovery-seeds";
import {
  isBrandTopic,
  loadTopicTaxonomy,
  queryMatchesTaxonomy,
  queryMatchesTopics,
  stabilizeTopicTaxonomy,
  type TopicTaxonomy,
} from "@/lib/research/topic-taxonomy";
import { canonicalKeyword } from "@/lib/research/keyword-identity";
import { TIMELY_WINDOW_DAYS as TIMELY_NEWS_DAYS } from "@/lib/research/opportunity-drafting";

/**
 * One monthly evidence bundle per site.
 *
 * This is the Phase 1 thin slice: collect the evidence an SEO needs for one
 * month, store it in the existing tables, record what it cost, and make a second
 * run for the same site/month return the receipt without paying twice.
 *
 * It deliberately does not generate opportunities, call an LLM for proposals,
 * build packets, score anything or touch the board. The bundle is an input.
 */

export type BundleDb = PrismaClient;

export type BundleCaps = {
  /** Target 20–40. */
  keywordQueries: number;
  /** Seeds for keyword discovery; each seed buys two Labs calls. */
  discoverySeeds: number;
  /** Target 10. */
  serpQueries: number;
  /** Target 10–20. */
  aeoQuestions: number;
  /** Target 10–20. */
  newsItems: number;
  /** Hard ceiling for the whole bundle, before any paid call. */
  capMicros: number;
};

export const DEFAULT_BUNDLE_CAPS: BundleCaps = {
  keywordQueries: 30,
  // Discovery is the part that lets a site with no Search Console history get a
  // query universe at all. Two Labs calls per seed, so six seeds is about $0.14.
  discoverySeeds: 6,
  serpQueries: 10,
  aeoQuestions: 12,
  newsItems: 20,
  // $0.30 covers a full bundle: 30 keyword queries, 6 discovery seeds, 10 SERPs
  // and 12 AI Overviews. The monthly allowance ($1 default) still governs.
  capMicros: 300_000,
};

/** Conservative unit prices; the provider receipt is the source of truth. */
export const BUNDLE_COST_ESTIMATES = {
  keywordPerQueryMicros: 1_500,
  keywordBatchSize: 20,
  keywordMinBatchMicros: 12_000,
  serpPerQueryMicros: 2_000,
  aiOverviewPerQuestionMicros: 2_500,
  discoveryPerSeedMicros: 24_000,
} as const;

export type BundleLocale = {
  language: string;
  languageCode: string;
  country: string;
  locationCode: number;
  /** Which fact chose the market, so a wrong locale is visible in the report. */
  marketSource: "override" | "audience" | "business";
  fallback?: unknown;
};

export type BundleRunSummary = {
  id: string;
  status: string;
  createdAt: string | null;
  completedAt: string | null;
  costMicros: number;
  sourceCount: number;
};

export type BundleBudget = {
  period: string;
  currency: string;
  timeZone: string;
  allowanceMicros: number;
  committedMicros: number;
  remainingMicros: number;
  /** True when the project sets no allowance and the default applies. */
  defaulted: boolean;
};

export type PlannedPaidCall = {
  section: "keyword_metrics" | "keyword_discovery" | "serp_snapshots" | "aeo_geo";
  operation: string;
  units: string[];
  estimatedMicros: number;
};

export type BundlePlan = {
  siteId: string;
  projectId: string;
  domain: string;
  month: string;
  idempotencyKey: string;
  locale: BundleLocale;
  caps: BundleCaps;
  brand: string | null;
  selected: {
    keywordQueries: string[];
    discoverySeeds: string[];
    serpQueries: string[];
    aeoQuestions: string[];
    newsQueries: string[];
  };
  reuse: {
    keywordQueries: string[];
    discoverySeeds: string[];
    serpQueries: string[];
    aeoQuestions: string[];
  };
  missing: {
    keywordQueries: string[];
    discoverySeeds: string[];
    serpQueries: string[];
    aeoQuestions: string[];
  };
  /** Who chose the discovery seeds, and why the fallback was used if it was. */
  discovery: { source: "model" | "fallback"; model: string | null; error: string | null };
  /** What the paid caps left out, counted rather than dropped in silence. */
  coverage: {
    keywordQueriesAvailable: number;
    unmeasuredKeywordQueries: number;
    keywordQueriesOmitted: number;
    serpQueriesOmitted: number;
    discoverySeedsOmitted: number;
    queriesDroppedTooLong: number;
    /** Audience markets the owner declared that this bundle did not measure. */
    unmeasuredMarkets: string[];
    /** Ranked queries the approved taxonomy does not claim, kept behind in-market ones. */
    offTopicQueries: number;
    /** False when no taxonomy is approved yet, so every query was ranked. */
    taxonomyApplied: boolean;
  };
  paidCalls: PlannedPaidCall[];
  estimatedMicros: number;
  budget: BundleBudget;
  credentials: boolean;
  existingRun: BundleRunSummary | null;
  warnings: string[];
  storage: Array<{ table: string; purpose: string }>;
};

export type BundleSectionName =
  | "business_knowledge"
  | "crawl"
  | "gsc"
  | "keyword_metrics"
  | "keyword_discovery"
  | "serp_snapshots"
  | "aeo_geo"
  | "news_events";

export type BundleSectionResult = {
  name: BundleSectionName;
  status: "stored" | "reused" | "skipped" | "failed";
  stored: number;
  reused: number;
  costMicros: number;
  evidenceIds: string[];
  /** Some units failed or were skipped, but the section still stored evidence. */
  partial?: boolean;
  detail?: unknown;
  error?: string;
};

export type BundleReceipt = {
  runId: string;
  status: string;
  idempotencyKey: string;
  month: string | null;
  costMicros: number;
  completedAt: string | null;
  sourceCount: number;
  report: unknown;
};

export type BundleResult = {
  status: "planned" | "completed" | "partial" | "failed" | "existing" | "refused";
  exitCode: number;
  plan: BundlePlan;
  runId: string | null;
  receipt: BundleReceipt | null;
  sections: BundleSectionResult[];
  totalCostMicros: number;
  paidCalls: number;
  error?: string;
};

export type BundleDeps = {
  proposeDiscoverySeeds: (input: DiscoverySeedInput) => Promise<DiscoverySeedResult>;
  collectKeywordMetrics: (db: BundleDb, input: CollectionInput) => Promise<CollectionOutput>;
  collectKeywordDiscovery: (db: BundleDb, input: CollectionInput) => Promise<CollectionOutput>;
  collectSerpSnapshots: (db: BundleDb, input: CollectionInput) => Promise<CollectionOutput>;
  collectAiOverviews: (
    db: BundleDb,
    input: GoogleAiOverviewCollectionInput
  ) => Promise<GoogleAiOverviewCollectionOutput>;
  backfill: (db: BundleDb, siteId: string, opts: { projectId: string }) => Promise<BackfillResult>;
  bridgeKnowledge: (
    db: BundleDb,
    opts: { projectId: string; siteId: string }
  ) => Promise<BusinessKnowledgeBridgeResult>;
  fetchNews: (input: {
    query: string;
    limit?: number;
    language?: string;
    country?: string;
    recencyDays?: number;
  }) => Promise<ResearchProviderSource[]>;
  saveNews: (runId: string, sources: ResearchSourceInput[]) => Promise<Array<{ id: string }>>;
  resolveLocale: (
    projectId: string,
    language: string,
    country: string
  ) => Promise<{
    language?: string;
    languageCode: string;
    country?: string;
    locationCode: number;
    fallback?: unknown;
  }>;
  hasCredentials: (db: BundleDb, projectId: string) => Promise<boolean>;
};

export const defaultBundleDeps: BundleDeps = {
  proposeDiscoverySeeds,
  collectKeywordMetrics,
  collectKeywordDiscovery,
  collectSerpSnapshots,
  collectAiOverviews: collectGoogleAiOverviews,
  backfill: backfillSiteEvidence,
  bridgeKnowledge: bridgeBusinessKnowledgeToEvidence,
  fetchNews: fetchGoogleNewsRssSearch,
  saveNews: saveResearchSources,
  resolveLocale: resolveDataForSeoLocale,
  hasCredentials: hasDataForSeoCredentials,
};

export class BundleError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
    this.name = "BundleError";
  }
}

export class BundleApprovalError extends BundleError {
  constructor() {
    super("--execute requires --approval <reference>", 2);
  }
}

export class BundleCapError extends BundleError {
  constructor(message: string) {
    super(message, 3);
  }
}

export class BundleCredentialsError extends BundleError {
  constructor() {
    super("DataForSEO credentials are not configured for this project", 4);
  }
}

export function resolveBundleCaps(input: Partial<BundleCaps> = {}): BundleCaps {
  const caps: BundleCaps = { ...DEFAULT_BUNDLE_CAPS };
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    (caps as Record<string, number>)[name] = value;
  }
  for (const [name, value] of Object.entries(caps)) {
    if (!Number.isFinite(value) || value <= 0) throw new BundleError(`cap ${name} must be a positive number`, 2);
  }
  if (caps.keywordQueries > 40) throw new BundleError("keywordQueries cap cannot exceed 40", 2);
  if (caps.discoverySeeds > 20) throw new BundleError("discoverySeeds cap cannot exceed 20", 2);
  if (caps.serpQueries > 10) throw new BundleError("serpQueries cap cannot exceed 10", 2);
  if (caps.aeoQuestions > 20) throw new BundleError("aeoQuestions cap cannot exceed 20", 2);
  if (caps.newsItems > 20) throw new BundleError("newsItems cap cannot exceed 20", 2);
  return {
    keywordQueries: Math.floor(caps.keywordQueries),
    discoverySeeds: Math.floor(caps.discoverySeeds),
    serpQueries: Math.floor(caps.serpQueries),
    aeoQuestions: Math.floor(caps.aeoQuestions),
    newsItems: Math.floor(caps.newsItems),
    capMicros: Math.floor(caps.capMicros),
  };
}

export function normalizeMonth(value: string | undefined, now: Date): string {
  const month = value?.trim() || now.toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new BundleError("--month must be YYYY-MM", 2);
  return month;
}

export function monthStartUtc(month: string): Date {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1, 0, 0, 0, 0));
}

export function monthEndUtc(month: string): Date {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 1, 0, 0, 0, 0));
}

export function budgetPeriod(timeZone: string, now: Date): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(now);
  } catch {
    throw new BundleError(`research budget timezone "${timeZone}" is invalid`, 2);
  }
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) throw new BundleError("could not calculate the research budget period", 1);
  return `${year}-${month}`;
}

export function estimateKeywordBatchMicros(count: number): number {
  return Math.max(
    BUNDLE_COST_ESTIMATES.keywordMinBatchMicros,
    count * BUNDLE_COST_ESTIMATES.keywordPerQueryMicros
  );
}

export function planPaidCalls(input: {
  keywordQueries: string[];
  discoverySeeds?: string[];
  serpQueries: string[];
  aeoQuestions: string[];
}): PlannedPaidCall[] {
  const calls: PlannedPaidCall[] = [];
  for (const batch of chunk(input.keywordQueries, BUNDLE_COST_ESTIMATES.keywordBatchSize)) {
    calls.push({
      section: "keyword_metrics",
      operation: "dataforseo:keyword_metrics",
      units: batch,
      estimatedMicros: estimateKeywordBatchMicros(batch.length),
    });
  }
  for (const seed of input.discoverySeeds ?? []) {
    calls.push({
      section: "keyword_discovery",
      operation: "dataforseo:keyword_discovery",
      units: [seed],
      estimatedMicros: BUNDLE_COST_ESTIMATES.discoveryPerSeedMicros,
    });
  }
  for (const query of input.serpQueries) {
    calls.push({
      section: "serp_snapshots",
      operation: "dataforseo:serp_snapshot",
      units: [query],
      estimatedMicros: BUNDLE_COST_ESTIMATES.serpPerQueryMicros,
    });
  }
  for (const question of input.aeoQuestions) {
    calls.push({
      section: "aeo_geo",
      operation: "dataforseo:ai_overview",
      units: [question],
      estimatedMicros: BUNDLE_COST_ESTIMATES.aiOverviewPerQuestionMicros,
    });
  }
  return calls;
}

export function withinBundleCap(spentMicros: number, estimateMicros: number, capMicros: number): boolean {
  return spentMicros + estimateMicros <= capMicros;
}

/**
 * Search Console queries longer than this are questions, not keyword phrases,
 * and the keyword API returns no volume for them. They are still real demand,
 * so the count is reported rather than dropped in silence.
 */
const MAX_KEYWORD_QUERY_LENGTH = 120;

export function rankQueries(
  rows: Array<{ dimensions: unknown; metrics: unknown }>
): string[] {
  return rankQueriesWithStats(rows).queries;
}

export function rankQueriesWithStats(
  rows: Array<{ dimensions: unknown; metrics: unknown }>
): { queries: string[]; droppedTooLong: number } {
  const byQuery = new Map<string, { query: string; impressions: number }>();
  let droppedTooLong = 0;
  for (const row of rows) {
    const dimensions = asRecord(row.dimensions);
    const query = stringValue(dimensions.query);
    if (!query) continue;
    if (query.length > MAX_KEYWORD_QUERY_LENGTH) {
      droppedTooLong += 1;
      continue;
    }
    if (dimensions.windowRole === "previous") continue;
    const metrics = asRecord(row.metrics);
    const impressions = Number(asRecord(metrics["first_party:impressions"]).value ?? 0);
    const key = normalizePhrase(query);
    const current = byQuery.get(key);
    if (current) current.impressions += Number.isFinite(impressions) ? impressions : 0;
    else byQuery.set(key, { query, impressions: Number.isFinite(impressions) ? impressions : 0 });
  }
  const queries = [...byQuery.values()]
    .sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query))
    .map((entry) => entry.query);
  return { queries, droppedTooLong };
}

/**
 * Which queries this month's bundle buys. A paid cap is a budget, not a rule
 * about what exists: queries that have never had volume data go first, in
 * impression order, so the head is covered now and the tail rotates in over
 * following months instead of being excluded forever. Anything left out is
 * counted, never silent.
 */
export function selectQueriesForBundle(
  ranked: string[],
  measured: Set<string>,
  cap: number
): { selected: string[]; omitted: number; unmeasuredBefore: number } {
  const unmeasured = ranked.filter((query) => !measured.has(normalizePhrase(query)));
  const alreadyMeasured = ranked.filter((query) => measured.has(normalizePhrase(query)));
  const selected = [...unmeasured, ...alreadyMeasured].slice(0, cap);
  return {
    selected,
    omitted: Math.max(0, ranked.length - selected.length),
    unmeasuredBefore: unmeasured.length,
  };
}

/**
 * Words that mark a query as someone trying to buy, not to read. Deliberately
 * domain-neutral: this module cannot know one business's services, so the
 * markers are generic buying signals ("price", "hire", "vs"). "near me" is a
 * location modifier, not a buying signal, and the taxonomy already decides
 * whether a query is in-market.
 */
const COMMERCIAL_INTENT_MARKERS = [
  "buy", "price", "prices", "cost", "costs", "cheap", "hire",
  "rent", "rental", "book", "booking", "quote", "service", "services", "review",
  "reviews", "vs", "alternative", "alternatives", "comparison", "deal", "deals",
  "discount", "package", "packages",
];

export function commercialIntentScore(query: string): number {
  const text = query
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  let score = 0;
  for (const marker of COMMERCIAL_INTENT_MARKERS) {
    if (new RegExp(`(^| )${marker}( |$)`).test(text)) score += 1;
  }
  return score;
}

/**
 * Which queries deserve a paid SERP snapshot.
 *
 * The old order was Search Console impressions, which bought the brand terms:
 * a brand SERP says who outranks the owner for their own name, not who owns the
 * market. Snapshots now go to in-market queries with commercial intent, then to
 * the largest demand, and two variants of one query buy one snapshot, not two.
 */
export function selectSerpQueries(input: {
  ranked: string[];
  measured: Set<string>;
  cap: number;
  volume: (query: string) => number;
  impressions: (query: string) => number;
  isBrand: (query: string) => boolean;
}): { selected: string[]; omitted: number; brandSkipped: number; unmeasuredBefore: number } {
  const nonBrand = input.ranked.filter((query) => !input.isBrand(query));
  // A site with no market queries yet still needs its brand SERP; the fallback
  // is explicit rather than silently buying nothing.
  const candidates = nonBrand.length > 0 ? nonBrand : input.ranked;
  const scored = candidates
    .map((query) => ({
      query,
      commercial: commercialIntentScore(query),
      volume: input.volume(query),
      impressions: input.impressions(query),
    }))
    .sort(
      (a, b) =>
        b.commercial - a.commercial ||
        b.volume - a.volume ||
        b.impressions - a.impressions ||
        a.query.length - b.query.length ||
        a.query.localeCompare(b.query)
    );
  const unmeasured = scored.filter((entry) => !input.measured.has(normalizePhrase(entry.query)));
  const alreadyMeasured = scored.filter((entry) => input.measured.has(normalizePhrase(entry.query)));
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...unmeasured, ...alreadyMeasured]) {
    if (selected.length >= input.cap) break;
    // "freediving course" and "freediving courses" are one SERP; paying twice
    // buys the same answer.
    const key = canonicalKeyword(entry.query);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    selected.push(entry.query);
  }
  return {
    selected,
    omitted: Math.max(0, candidates.length - selected.length),
    brandSkipped: input.ranked.length - candidates.length,
    unmeasuredBefore: unmeasured.length,
  };
}

export function selectAeoQuestions(
  coverageQuestions: string[],
  fallbackQueries: string[],
  cap: number,
  language?: string
): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    if (output.length >= cap) return;
    const question = value.trim();
    if (!question || question.length > 300) return;
    const key = normalizePhrase(question);
    if (seen.has(key)) return;
    seen.add(key);
    output.push(question);
  };
  const wanted = language?.toLowerCase().slice(0, 2);
  for (const question of coverageQuestions) {
    // An English template question asked against a French market is not a
    // measurement of that market. Keep the question set only when it is written
    // in the site's language; otherwise the real queries below are the honest
    // input.
    if (wanted && detectLanguage(question) !== "unknown" && detectLanguage(question) !== wanted) continue;
    add(question);
  }
  const questionLike = fallbackQueries.filter(
    (query) =>
      /\?$/.test(query) ||
      /^(how|what|why|when|where|which|who|is|are|can|do|does|comment|pourquoi|quel|quelle|quels|quelles|où|quand|qui|est|sont|peut|faut)\b/i.test(
        query
      )
  );
  for (const query of questionLike) add(query);
  for (const query of fallbackQueries) add(query);
  return output;
}

export function buildNewsQueries(
  input: {
    businessName?: string | null;
    services?: string[];
    location?: string | null;
    serviceArea?: string[];
    domain: string;
  }
): string[] {
  const queries: string[] = [];
  const add = (value: string | null | undefined) => {
    const query = value?.trim();
    if (!query || query.length < 3) return;
    if (queries.some((existing) => normalizePhrase(existing) === normalizePhrase(query))) return;
    queries.push(query);
  };
  if (input.businessName) add(`"${input.businessName}"`);
  // A one-word service ("Buy", "Rent") is a navigation label, not a phrase:
  // quoting it forces an exact match and returns unrelated pages.
  const phrase = (service: string) => (service.trim().includes(" ") ? `"${service}"` : service);
  const place = input.location ?? input.serviceArea?.[0] ?? null;
  const area = input.serviceArea?.[0] ?? null;
  const services = input.services ?? [];
  for (const service of services) {
    add(place ? `${phrase(service)} ${place}` : phrase(service));
  }
  // The business location is narrow. The service area is where the audience
  // actually reads the trade press, so it gets its own pass.
  for (const service of services) {
    if (area && area !== place) add(`${phrase(service)} ${area}`);
  }
  if (queries.length === 0) add(input.domain.replace(/^www\./, ""));
  // Free searches: no cap. A cap here would decide which news exists.
  return queries;
}

export function buildNewsQueriesForSite(input: {
  businessName: string | null;
  services: string[];
  location: string | null;
  serviceArea: string[];
  domain: string;
  /** Searches proposed for this tenant by the taxonomy; replaces the old
   *  hardcoded craft-event phrases. */
  taxonomyQueries?: string[];
}): string[] {
  // The approved taxonomy already says which searches find this business's
  // current news; service labels scraped from navigation produce noise. Fall
  // back to the business's own facts only when the taxonomy has none.
  const curated = (input.taxonomyQueries ?? []).map((query) => query.trim()).filter(Boolean);
  const base = buildNewsQueries({
    businessName: input.businessName,
    services: curated.length > 0 ? [] : input.services,
    location: input.location,
    serviceArea: input.serviceArea,
    domain: input.domain,
  });
  const seen = new Set<string>();
  // Free searches, so nothing is dropped to save a budget.
  return [...base, ...curated].filter((query) => {
    const key = query.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The words the site already uses for its work: page titles and H1s from the
 * latest crawl. They are closer to how buyers search than the navigation labels
 * the owner's services come from.
 */
async function discoveryPageVocabulary(db: BundleDb, siteId: string): Promise<string[]> {
  const crawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { id: true },
  });
  if (!crawl) return [];
  const pages = await db.auditPage.findMany({
    where: { crawlId: crawl.id, statusCode: 200 },
    select: { title: true, h1s: true },
    orderBy: { wordCount: "desc" },
    take: 60,
  });
  const h1s = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return pages.flatMap((page) => [page.title, ...h1s(page.h1s)]).filter((value): value is string => Boolean(value));
}

export async function hasDataForSeoCredentials(db: BundleDb, projectId: string): Promise<boolean> {
  const grant = await db.projectApiKeyGrant.findFirst({
    where: { projectId, provider: "dataforseo", status: "ACTIVE" },
    select: {
      apiKeyId: true,
      providerCredentialId: true,
      providerCredential: { select: { status: true } },
    },
  });
  if (!grant) return false;
  if (grant.providerCredentialId) return grant.providerCredential?.status === "ACTIVE";
  return Boolean(grant.apiKeyId);
}

export async function readBundleBudget(
  db: BundleDb,
  projectId: string,
  now: Date
): Promise<BundleBudget> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      monthlyResearchAllowanceMicros: true,
      researchBudgetCurrency: true,
      researchBudgetTimeZone: true,
    },
  });
  if (!project) throw new BundleError("project not found", 1);
  const period = budgetPeriod(project.researchBudgetTimeZone, now);
  const rows = await db.researchBudgetReservation.findMany({
    where: { projectId, period },
    select: { status: true, amountMicros: true, actualCostMicros: true },
  });
  const committed = rows.reduce((sum, row) => {
    if (row.status === "SETTLED") return sum + Number(row.actualCostMicros ?? row.amountMicros);
    if (row.status === "RESERVED" || row.status === "UNCERTAIN") return sum + Number(row.amountMicros);
    return sum;
  }, 0);
  // An unset allowance is unconfigured, not unlimited: every project has the
  // default budget, and the plan says when it is the default.
  const allowance = Number(effectiveMonthlyAllowance(project.monthlyResearchAllowanceMicros));
  return {
    period,
    currency: project.researchBudgetCurrency,
    timeZone: project.researchBudgetTimeZone,
    allowanceMicros: allowance,
    committedMicros: committed,
    remainingMicros: allowance - committed,
    defaulted: usesDefaultAllowance(project.monthlyResearchAllowanceMicros),
  };
}

export async function resolveBundleLocale(input: {
  mode: "dry-run" | "execute";
  projectId: string;
  context: SiteContext;
  language?: string;
  country?: string;
  deps: BundleDeps;
}): Promise<BundleLocale> {
  const language = (input.language ?? input.context.language).toLowerCase().slice(0, 2);
  // The audience's market, not the business address: a site selling into the US
  // from Mexico is measured in the US, where its buyers search.
  const marketSource: BundleLocale["marketSource"] = input.country
    ? "override"
    : input.context.audienceCountry
      ? "audience"
      : "business";
  const country = (input.country ?? providerCountry(input.context))?.toUpperCase() ?? null;
  if (!country) {
    throw new BundleError(
      "the site has no audience market or country in business knowledge, the site profile or its domain; pass --country",
      2
    );
  }
  if (input.mode === "execute") {
    try {
      const resolved = await input.deps.resolveLocale(input.projectId, language, country);
      return {
        language: resolved.language ?? language,
        languageCode: resolved.languageCode,
        country: resolved.country ?? country,
        locationCode: resolved.locationCode,
        marketSource,
        fallback: resolved.fallback,
      };
    } catch {
      // A locale catalog failure is not a reason to refuse a bundle whose
      // language/country pair is already known and mapped locally.
    }
  }
  const locationCode = DATAFORSEO_LOCATION_CODES[country];
  if (!locationCode) {
    throw new BundleError(`no DataForSEO location code is known for ${country}; pass a supported --country`, 2);
  }
  return { language, languageCode: language, country, locationCode, marketSource };
}

export async function buildBundlePlan(input: {
  db: BundleDb;
  site: { id: string; domain: string; projectId: string };
  locale: BundleLocale;
  month: string;
  caps: BundleCaps;
  now: Date;
  deps: BundleDeps;
  existingRun: BundleRunSummary | null;
  /** Every market the owner declared; the first is the one measured. */
  contextMarkets?: string[];
}): Promise<BundlePlan> {
  const { db, site, locale, caps } = input;
  const monthStart = monthStartUtc(input.month);
  const localeKey = `${locale.languageCode}:${locale.locationCode}`;
  const warnings: string[] = [];

  const [ranks, coverage, measuredKeywords, measuredSerps] = await Promise.all([
    db.evidenceRecord.findMany({
      where: { projectId: site.projectId, siteId: site.id, kind: "keyword_rank", supersededById: null },
      select: { dimensions: true, metrics: true },
    }),
    db.evidenceRecord.findMany({
      where: { projectId: site.projectId, siteId: site.id, kind: "question_coverage", supersededById: null },
      select: { dimensions: true },
    }),
    // Every query this site has ever had volume data for, not just this month:
    // the cap buys the head first and then rotates the tail in over following
    // months instead of measuring the same forty forever.
    db.evidenceRecord.findMany({
      where: {
        projectId: site.projectId,
        siteId: site.id,
        // Any volume row counts, whatever producer wrote it: re-buying a
        // query that already has volume data wastes the monthly cap.
        kind: "keyword_metrics",
        supersededById: null,
      },
      select: { dimensions: true, metrics: true },
    }),
    db.evidenceRecord.findMany({
      where: {
        projectId: site.projectId,
        siteId: site.id,
        kind: "serp_snapshot",
        supersededById: null,
      },
      select: { dimensions: true },
    }),
  ]);

  const { queries: rankedQueries, droppedTooLong } = rankQueriesWithStats(ranks);
  const measuredKeywordSet = new Set(
    measuredKeywords
      .map((row) => stringValue(asRecord(row.dimensions).query))
      .filter((query): query is string => Boolean(query))
      .map((query) => normalizePhrase(query))
  );
  const measuredSerpSet = new Set(
    measuredSerps
      .map((row) => stringValue(asRecord(row.dimensions).query))
      .filter((query): query is string => Boolean(query))
      .map((query) => normalizePhrase(query))
  );
  const volumeByQuery = new Map<string, number>();
  for (const row of measuredKeywords) {
    const dimensions = asRecord(row.dimensions);
    const query = stringValue(dimensions.query);
    if (!query) continue;
    const volume = Number(asRecord(asRecord(row.metrics)["provider:volume"]).value ?? 0);
    if (!Number.isFinite(volume) || volume <= 0) continue;
    const key = normalizePhrase(query);
    volumeByQuery.set(key, Math.max(volumeByQuery.get(key) ?? 0, volume));
  }
  const impressionsByQuery = new Map<string, number>();
  for (const row of ranks) {
    const query = stringValue(asRecord(row.dimensions).query);
    if (!query) continue;
    const impressions = Number(asRecord(asRecord(row.metrics)["first_party:impressions"]).value ?? 0);
    if (!Number.isFinite(impressions) || impressions <= 0) continue;
    const key = normalizePhrase(query);
    impressionsByQuery.set(key, (impressionsByQuery.get(key) ?? 0) + impressions);
  }
  // Relevance decides order, not existence: queries the approved taxonomy
  // claims are bought first, and queries it does not claim still fill the cap
  // when the site has fewer in-market queries than the cap allows. This is why
  // a property site no longer spends its paid cap on "hospital near me".
  const storedTaxonomy = await loadTopicTaxonomy(db, site.id);
  // The candidate pool is every query the site has demand for, not only the
  // Search Console rows: a site with two GSC queries still discovered 62
  // market keywords, and a SERP snapshot on "freediving course" teaches more
  // than a second snapshot on its own brand name.
  const measuredKeywordQueries = measuredKeywords
    .map((row) => stringValue(asRecord(row.dimensions).query))
    .filter((query): query is string => Boolean(query));
  const candidateQueries = [...new Set([...rankedQueries, ...measuredKeywordQueries])];
  // The bundle must see the same taxonomy the map shows: merged owners and the
  // head term claimed by one topic. Without this, "freediving record" still
  // looks in-market because the stored topic still lists "freediving".
  const taxonomy: TopicTaxonomy | null = storedTaxonomy
    ? {
        ...storedTaxonomy,
        topics: stabilizeTopicTaxonomy({
          topics: storedTaxonomy.topics,
          queries: candidateQueries.map((query) => ({
            query,
            impressions: impressionsByQuery.get(normalizePhrase(query)) ?? 0,
            volume: volumeByQuery.get(normalizePhrase(query)) ?? 0,
          })),
          brandKey: site.domain.replace(/^www\./, "").split(".")[0],
        }).topics,
      }
    : null;
  const inMarket = taxonomy
    ? candidateQueries.filter((query) => queryMatchesTaxonomy(taxonomy, query))
    : candidateQueries;
  const offTopic = taxonomy
    ? candidateQueries.filter((query) => !queryMatchesTaxonomy(taxonomy, query))
    : [];
  const orderedQueries = [...inMarket, ...offTopic];

  const keywordSelection = selectQueriesForBundle(orderedQueries, measuredKeywordSet, caps.keywordQueries);
  const brandTopics = taxonomy ? taxonomy.topics.filter((topic) => isBrandTopic(topic)) : [];
  // The map's review has already decided which queries are outside the service
  // area (Florida and San Diego for a Playa del Carmen school). A paid SERP for
  // those teaches nothing the owner can act on.
  const mapRun = await db.researchRun.findFirst({
    where: { siteId: site.id, idempotencyKey: `topic-map:${site.id}:${input.month}` },
    select: { report: true },
  });
  const mapReport = asRecord(asRecord(mapRun?.report).map);
  const excludedByReview = new Set<string>();
  for (const cluster of Array.isArray(mapReport.clusters) ? mapReport.clusters : []) {
    const excluded = asRecord(cluster).excludedQueries;
    for (const row of Array.isArray(excluded) ? excluded : []) {
      const query = stringValue(asRecord(row).query);
      if (query) excludedByReview.add(normalizePhrase(query));
    }
  }
  // Off-topic queries do not fill the SERP cap: a snapshot of "freediving
  // record" is paid-for research noise, not market intelligence. The fallback
  // keeps a brand-new site from buying nothing.
  const inMarketForSerp = (inMarket.length > 0 ? inMarket : orderedQueries).filter(
    (query) => !excludedByReview.has(normalizePhrase(query))
  );
  const serpCandidates = inMarketForSerp.length > 0 ? inMarketForSerp : inMarket.length > 0 ? inMarket : orderedQueries;
  const serpSelection = selectSerpQueries({
    ranked: serpCandidates,
    measured: measuredSerpSet,
    cap: caps.serpQueries,
    volume: (query) => volumeByQuery.get(normalizePhrase(query)) ?? 0,
    impressions: (query) => impressionsByQuery.get(normalizePhrase(query)) ?? 0,
    isBrand: (query) => queryMatchesTopics(brandTopics, query),
  });
  const keywordQueries = keywordSelection.selected;
  const serpQueries = serpSelection.selected;
  const allCoverageQuestions = coverage
    .map((row) => stringValue(asRecord(row.dimensions).question))
    .filter((question): question is string => Boolean(question));
  // Prefer queries that are not already bought as SERP snapshots: the AI
  // Overview call is a SERP call too, and measuring a different slice of demand
  // is more useful than paying twice for the same query.
  const aeoFallback = [...orderedQueries.slice(caps.serpQueries), ...orderedQueries];
  // A question the business does not serve is not an AEO target: the AI
  // Overview call costs money and its answer describes someone else's market.
  const coverageQuestions = taxonomy
    ? allCoverageQuestions.filter((question) => queryMatchesTaxonomy(taxonomy, question))
    : allCoverageQuestions;
  const excludedCoverageQuestions = allCoverageQuestions.length - coverageQuestions.length;
  if (excludedCoverageQuestions > 0) {
    warnings.push(
      `${excludedCoverageQuestions} of ${allCoverageQuestions.length} stored coverage questions match no approved topic and were not measured`
    );
  }
  const aeoQuestions = selectAeoQuestions(
    coverageQuestions,
    aeoFallback,
    caps.aeoQuestions,
    locale.languageCode
  );

  const fields = await businessKnowledgeFields(db, site.projectId);
  // Seeds are a judgement about the business, so the model proposes them from
  // the owner's services and the site's own page titles. Ask for a few more than
  // the cap so the cap is a choice between seeds, and report what it left out.
  const discoveryPageTitles = await discoveryPageVocabulary(db, site.id);
  const proposed = await input.deps.proposeDiscoverySeeds({
    domain: site.domain,
    language: locale.language,
    businessName: fieldText(fields, "businessName"),
    services: fieldList(fields, "services"),
    location: fieldText(fields, "location"),
    serviceArea: fieldList(fields, "serviceArea"),
    audience: fieldText(fields, "audienceMotivations"),
    pageTitles: discoveryPageTitles,
    knownQueries: rankedQueries,
    limit: Math.min(20, caps.discoverySeeds + 4),
  });
  const discovery = {
    seeds: proposed.seeds.slice(0, caps.discoverySeeds),
    available: proposed.seeds.length,
    omitted: Math.max(0, proposed.seeds.length - caps.discoverySeeds),
  };
  const reusedSeeds = await reusableValues(db, {
    projectId: site.projectId,
    siteId: site.id,
    kind: "keyword_metrics",
    since: monthStart,
    key: "seed",
    match: (dimensions) => dimensions.product === "keyword_related" && dimensions.locale === localeKey,
  });
  const discoveryReuse = discovery.seeds.filter((seed) => reusedSeeds.has(normalizePhrase(seed)));
  const missingSeeds = discovery.seeds.filter((seed) => !reusedSeeds.has(normalizePhrase(seed)));

  const newsQueries = buildNewsQueriesForSite({
    businessName: fieldText(fields, "businessName"),
    services: fieldList(fields, "services"),
    location: fieldText(fields, "location"),
    serviceArea: fieldList(fields, "serviceArea"),
    domain: site.domain,
    // The same searches the weekly sweep uses: one answer for "where does this
    // business's news appear", whether it is a bundle or a weekly run.
    taxonomyQueries: taxonomy?.newsQueries ?? [],
  });

  if (keywordQueries.length < caps.keywordQueries) {
    warnings.push(
      `only ${keywordQueries.length} Search Console queries are available for a ${caps.keywordQueries}-query cap`
    );
  }
  if (keywordSelection.omitted > 0) {
    warnings.push(
      `${keywordSelection.omitted} of ${candidateQueries.length} queries get no paid call this month (cap ${caps.keywordQueries}); the bundle takes unmeasured queries first, so the rest rotate in over following months`
    );
  }
  if (serpSelection.brandSkipped > 0) {
    warnings.push(
      `${serpSelection.brandSkipped} brand ${serpSelection.brandSkipped === 1 ? "query was" : "queries were"} not bought as SERP snapshots: a brand SERP says who ranks for the name, not who owns the market`
    );
  }
  if (serpSelection.omitted > 0) {
    warnings.push(
      `${serpSelection.omitted} queries get no SERP snapshot this month (cap ${caps.serpQueries})`
    );
  }
  if (droppedTooLong > 0) {
    warnings.push(
      `${droppedTooLong} queries longer than ${MAX_KEYWORD_QUERY_LENGTH} characters were not sent to the keyword API`
    );
  }
  if (discovery.omitted > 0) {
    warnings.push(
      `${discovery.omitted} of ${discovery.available} discovery seeds were not sent (cap ${caps.discoverySeeds})`
    );
  }
  if (proposed.source === "fallback") {
    warnings.push(
      `discovery seeds came from the service labels, not the model${proposed.error ? ` (${proposed.error})` : ""}: long labels often return no keywords`
    );
  }
  if (discovery.available === 0) {
    warnings.push(
      "no discovery seeds: the business knowledge has no services, so only measured queries can be measured"
    );
  }
  if (!taxonomy) {
    warnings.push(
      "no approved topic taxonomy: every query was ranked by impressions, so off-business queries can take the paid cap"
    );
  } else if (offTopic.length > 0) {
    warnings.push(
      `${offTopic.length} of ${candidateQueries.length} queries match no approved topic and were ranked behind in-market ones`
    );
  }
  const unmeasuredMarkets = (input.contextMarkets ?? []).filter((code) => code !== locale.country);
  if (unmeasuredMarkets.length > 0) {
    warnings.push(
      `audience markets ${unmeasuredMarkets.join(", ")} were not measured this month; the bundle measured ${locale.country} only`
    );
  }
  if (aeoQuestions.length < caps.aeoQuestions) {
    warnings.push(
      `only ${aeoQuestions.length} AEO questions are available for a ${caps.aeoQuestions}-question cap`
    );
  }

  const reusedKeywords = await reusableValues(db, {
    projectId: site.projectId,
    siteId: site.id,
    kind: "keyword_metrics",
    since: monthStart,
    key: "query",
    match: (dimensions) =>
      dimensions.product === "keyword_overview" && dimensions.locale === localeKey,
  });
  const reusedSerp = await reusableValues(db, {
    projectId: site.projectId,
    siteId: site.id,
    kind: "serp_snapshot",
    since: monthStart,
    key: "query",
    match: (dimensions) =>
      dimensions.device === "desktop" && dimensions.locale === localeKey,
  });
  const reusedAeo = await reusableValues(db, {
    projectId: site.projectId,
    siteId: site.id,
    kind: "ai_visibility_observation",
    since: monthStart,
    key: "question",
    match: (dimensions) =>
      dimensions.surface === "google_ai_overview" && dimensions.locale === localeKey,
  });

  const keywordReuse = keywordQueries.filter((query) => reusedKeywords.has(normalizePhrase(query)));
  const serpReuse = serpQueries.filter((query) => reusedSerp.has(normalizePhrase(query)));
  const aeoReuse = aeoQuestions.filter((question) => reusedAeo.has(normalizePhrase(question)));
  const missingKeywords = keywordQueries.filter((query) => !reusedKeywords.has(normalizePhrase(query)));
  const missingSerp = serpQueries.filter((query) => !reusedSerp.has(normalizePhrase(query)));
  const missingAeo = aeoQuestions.filter((question) => !reusedAeo.has(normalizePhrase(question)));

  const paidCalls = planPaidCalls({
    keywordQueries: missingKeywords,
    discoverySeeds: missingSeeds,
    serpQueries: missingSerp,
    aeoQuestions: missingAeo,
  });
  const estimatedMicros = paidCalls.reduce((sum, call) => sum + call.estimatedMicros, 0);

  const [budget, credentials] = await Promise.all([
    readBundleBudget(db, site.projectId, input.now),
    input.deps.hasCredentials(db, site.projectId),
  ]);

  if (!credentials) warnings.push("DataForSEO credentials are not configured; execute will refuse to spend");
  if (estimatedMicros > caps.capMicros) {
    warnings.push(
      `estimated $${(estimatedMicros / 1_000_000).toFixed(4)} exceeds the bundle cap $${(caps.capMicros / 1_000_000).toFixed(4)}`
    );
  }
  if (estimatedMicros > budget.remainingMicros) {
    warnings.push(
      `estimated $${(estimatedMicros / 1_000_000).toFixed(4)} exceeds the remaining monthly allowance $${(budget.remainingMicros / 1_000_000).toFixed(4)}`
    );
  }

  return {
    siteId: site.id,
    projectId: site.projectId,
    domain: site.domain,
    month: input.month,
    idempotencyKey: bundleKey(site.id, input.month),
    locale,
    caps,
    brand: fieldText(fields, "businessName"),
    selected: { keywordQueries, discoverySeeds: discovery.seeds, serpQueries, aeoQuestions, newsQueries },
    reuse: { keywordQueries: keywordReuse, discoverySeeds: discoveryReuse, serpQueries: serpReuse, aeoQuestions: aeoReuse },
    missing: { keywordQueries: missingKeywords, discoverySeeds: missingSeeds, serpQueries: missingSerp, aeoQuestions: missingAeo },
    discovery: { source: proposed.source, model: proposed.model, error: proposed.error },
    coverage: {
      keywordQueriesAvailable: rankedQueries.length,
      unmeasuredKeywordQueries: keywordSelection.unmeasuredBefore,
      keywordQueriesOmitted: keywordSelection.omitted,
      serpQueriesOmitted: serpSelection.omitted,
      discoverySeedsOmitted: discovery.omitted,
      queriesDroppedTooLong: droppedTooLong,
      unmeasuredMarkets: (input.contextMarkets ?? []).filter((code) => code !== locale.country),
      offTopicQueries: offTopic.length,
      taxonomyApplied: Boolean(taxonomy),
    },
    paidCalls,
    estimatedMicros,
    budget,
    credentials,
    existingRun: input.existingRun,
    warnings,
    storage: [
      { table: "ResearchRun", purpose: "bundle manifest, status, cost and idempotency key" },
      { table: "ResearchSource", purpose: "news/event items for this bundle" },
      { table: "RawProviderResponse", purpose: "immutable DataForSEO payloads and provider cost" },
      { table: "EvidenceRecord", purpose: "normalized keyword, SERP, crawl, GSC, knowledge and AI visibility facts" },
      { table: "ResearchBudgetReservation", purpose: "per-call budget reservation and settlement" },
    ],
  };
}

export async function findBundleRun(
  db: BundleDb,
  siteId: string,
  idempotencyKey: string
): Promise<BundleRunSummary | null> {
  const run = await db.researchRun.findFirst({
    where: { siteId, idempotencyKey },
    orderBy: { createdAt: "desc" },
  });
  return run ? summarizeRun(run) : null;
}

export function bundleKey(siteId: string, month: string): string {
  return `monthly:${siteId}:${month}:bundle`;
}

export function receiptFromRun(run: {
  id: string;
  status: string;
  idempotencyKey: string | null;
  costMicros: number;
  completedAt: Date | string | null;
  sourceCount: number;
  brief?: unknown;
  report?: unknown;
}): BundleReceipt {
  const brief = asRecord(run.brief);
  const report = asRecord(run.report);
  const bundle = asRecord(report.bundle);
  return {
    runId: run.id,
    status: run.status,
    idempotencyKey: run.idempotencyKey ?? "",
    month: stringValue(brief.month) ?? stringValue(bundle.month),
    costMicros: run.costMicros,
    completedAt: toIso(run.completedAt),
    sourceCount: run.sourceCount,
    report: run.report ?? null,
  };
}

export function buildBundleReport(input: {
  plan: BundlePlan;
  runId: string;
  status: "COMPLETED" | "PARTIAL" | "FAILED";
  sections: BundleSectionResult[];
  totalCostMicros: number;
  paidCalls: number;
  evidenceByKind: Record<string, number>;
  runEvidenceByKind: Record<string, number>;
  monthEvidenceByKind: Record<string, number>;
  newsSources: number;
  approvalReference: string;
  startedAt: Date;
  completedAt: Date;
  warnings: string[];
  errors: string[];
  previousAttempt?: unknown;
  attemptCostMicros?: number;
  attemptPaidCalls?: number;
}): Record<string, unknown> {
  return {
    version: 1,
    previousAttempt: input.previousAttempt ?? null,
    bundle: {
      runId: input.runId,
      idempotencyKey: input.plan.idempotencyKey,
      siteId: input.plan.siteId,
      projectId: input.plan.projectId,
      domain: input.plan.domain,
      month: input.plan.month,
      locale: input.plan.locale,
      status: input.status,
      approvalReference: input.approvalReference,
      caps: input.plan.caps,
      estimatedMicros: input.plan.estimatedMicros,
      actualMicros: input.totalCostMicros,
      paidCalls: input.paidCalls,
      attemptMicros: input.attemptCostMicros ?? input.totalCostMicros,
      attemptPaidCalls: input.attemptPaidCalls ?? input.paidCalls,
      startedAt: input.startedAt.toISOString(),
      completedAt: input.completedAt.toISOString(),
    },
    selected: input.plan.selected,
    reuse: input.plan.reuse,
    missing: input.plan.missing,
    coverage: input.plan.coverage,
    sections: input.sections,
    counts: {
      evidenceByKind: input.evidenceByKind,
      runEvidenceByKind: input.runEvidenceByKind,
      monthEvidenceByKind: input.monthEvidenceByKind,
      newsSources: input.newsSources,
    },
    warnings: input.warnings,
    errors: input.errors,
  };
}

export async function runMonthlyBundle(
  db: BundleDb,
  input: {
    siteId: string;
    month?: string;
    mode: "dry-run" | "execute";
    approval?: string | null;
    /** Explicitly continue a PARTIAL/FAILED bundle. Never implicit. */
    resume?: boolean;
    caps?: Partial<BundleCaps>;
    language?: string;
    country?: string;
    now?: Date;
  },
  deps: BundleDeps = defaultBundleDeps
): Promise<BundleResult> {
  const now = input.now ?? new Date();
  const month = normalizeMonth(input.month, now);
  const caps = resolveBundleCaps(input.caps);

  const site = await db.site.findUnique({
    where: { id: input.siteId },
    select: { id: true, domain: true, projectId: true, retiredAt: true },
  });
  if (!site) throw new BundleError(`site ${input.siteId} not found`, 2);
  if (site.retiredAt) throw new BundleError(`site ${site.domain} is retired`, 2);
  if (!site.projectId) throw new BundleError(`site ${site.domain} is not attached to a project`, 2);

  const context = await resolveSiteContext(db, site.id);
  const locale = await resolveBundleLocale({
    mode: input.mode,
    projectId: site.projectId,
    context,
    language: input.language,
    country: input.country,
    deps,
  });
  const existingRun = await findBundleRun(db, site.id, bundleKey(site.id, month));
  const plan = await buildBundlePlan({
    db,
    site: { id: site.id, domain: site.domain, projectId: site.projectId },
    locale,
    month,
    caps,
    now,
    deps,
    existingRun,
    contextMarkets: context.audienceCountries,
  });

  if (input.mode === "dry-run") {
    return {
      status: "planned",
      exitCode: 0,
      plan,
      runId: null,
      receipt: null,
      sections: [],
      totalCostMicros: 0,
      paidCalls: 0,
    };
  }

  const approval = input.approval?.trim();
  if (!approval) throw new BundleApprovalError();

  const existingResult = async (summary: BundleRunSummary): Promise<BundleResult> => {
    const stored = await db.researchRun.findFirst({ where: { id: summary.id } });
    return {
      status: "existing",
      exitCode: summary.status === "RUNNING" ? 4 : 0,
      plan,
      runId: summary.id,
      receipt: stored ? receiptFromRun(stored) : null,
      sections: [],
      totalCostMicros: summary.costMicros,
      paidCalls: 0,
      error:
        summary.status === "RUNNING"
          ? "bundle run is already running or was interrupted; no paid calls were made"
          : undefined,
    };
  };

  if (existingRun) {
    // A completed bundle is returned as-is. A partial/failed bundle is only
    // continued when the caller explicitly asks with --resume; otherwise the
    // receipt is returned and no paid call is made.
    if (!input.resume || existingRun.status === "RUNNING" || existingRun.status === "COMPLETED") {
      return existingResult(existingRun);
    }
  }

  if (!plan.credentials) throw new BundleCredentialsError();
  if (plan.estimatedMicros > caps.capMicros) {
    throw new BundleCapError(
      `estimated $${(plan.estimatedMicros / 1_000_000).toFixed(4)} exceeds the bundle cap $${(caps.capMicros / 1_000_000).toFixed(4)}`
    );
  }
  if (plan.estimatedMicros > plan.budget.remainingMicros) {
    throw new BundleCapError(
      `estimated $${(plan.estimatedMicros / 1_000_000).toFixed(4)} exceeds the remaining monthly allowance $${(plan.budget.remainingMicros / 1_000_000).toFixed(4)}`
    );
  }

  let run: RunRow;
  let previousAttempt: unknown = null;
  let previousCostMicros = 0;
  let previousPaidCalls = 0;
  if (existingRun) {
    const resumed = await resumeBundleRun(db, existingRun.id);
    run = resumed.run;
    previousAttempt = resumed.previousAttempt;
    const previousBundle = asRecord(asRecord(previousAttempt).bundle);
    previousCostMicros = Number(previousBundle.actualMicros ?? 0) || 0;
    previousPaidCalls = Number(previousBundle.paidCalls ?? 0) || 0;
  } else {
    const claimed = await claimBundleRun(db, {
      siteId: site.id,
      projectId: site.projectId,
      month,
      approval,
      plan,
      now,
    });
    if (!claimed.created) return existingResult(summarizeRun(claimed.run));
    run = claimed.run;
  }
  const bundleSite = { id: site.id, projectId: site.projectId, domain: site.domain };
  const attemptToken = randomUUID();
  const spend = { totalMicros: 0, calls: 0 };
  const sections: BundleSectionResult[] = [];
  const errors: string[] = [];
  const warnings = [...plan.warnings];
  const canSpend = (estimateMicros: number) => withinBundleCap(spend.totalMicros, estimateMicros, caps.capMicros);

  sections.push(await collectKnowledgeSection(db, bundleSite, deps));
  sections.push(...(await collectCrawlAndGscSections(db, bundleSite, deps)));

  const keywordSection = await collectKeywordSection(db, {
    plan,
    attemptToken,
    spend,
    caps,
    canSpend,
    deps,
    errors,
  });
  sections.push(keywordSection);

  const discoverySection = await collectDiscoverySection(db, {
    plan,
    attemptToken,
    spend,
    canSpend,
    deps,
    errors,
  });
  sections.push(discoverySection);

  const serpSection = await collectSerpSection(db, {
    plan,
    locale,
    attemptToken,
    spend,
    canSpend,
    deps,
    errors,
  });
  sections.push(serpSection);

  const aeoSection = await collectAeoSection(db, {
    plan,
    locale,
    attemptToken,
    spend,
    canSpend,
    deps,
    errors,
  });
  sections.push(aeoSection);

  const newsSection = await collectNewsSection(run.id, {
    plan,
    locale,
    caps,
    deps,
    errors,
  });
  sections.push(newsSection);

  const capReached = sections.some((section) => asRecord(section.detail).capReached === true);
  if (capReached) warnings.push("bundle cap reached during collection; the run is partial");

  const failedSections = sections.filter((section) => section.status === "failed").length;
  const partialSections = sections.filter((section) => section.partial).length;
  const storedSections = sections.filter(
    (section) => section.status === "stored" || section.status === "reused"
  ).length;
  const status: "COMPLETED" | "PARTIAL" | "FAILED" =
    storedSections === 0
      ? "FAILED"
      : failedSections > 0 || partialSections > 0 || capReached
        ? "PARTIAL"
        : "COMPLETED";

  const completedAt = new Date();
  const [evidenceByKind, runEvidenceByKind, monthEvidenceByKind] = await Promise.all([
    countEvidenceByKind(db, { projectId: site.projectId, siteId: site.id, since: null }),
    countEvidenceByKind(db, { projectId: site.projectId, siteId: site.id, since: run.startedAt ?? now }),
    countEvidenceByKind(db, {
      projectId: site.projectId,
      siteId: site.id,
      since: monthStartUtc(month),
      until: monthEndUtc(month),
    }),
  ]);
  const totalCostMicros = previousCostMicros + spend.totalMicros;
  const totalPaidCalls = previousPaidCalls + spend.calls;
  const report = buildBundleReport({
    plan,
    runId: run.id,
    status,
    sections,
    totalCostMicros,
    paidCalls: totalPaidCalls,
    evidenceByKind,
    runEvidenceByKind,
    monthEvidenceByKind,
    newsSources: newsSection.stored,
    approvalReference: approval,
    startedAt: run.startedAt ?? now,
    completedAt,
    warnings,
    errors,
    previousAttempt,
    attemptCostMicros: spend.totalMicros,
    attemptPaidCalls: spend.calls,
  });

  await db.researchRun.update({
    where: { id: run.id },
    data: {
      status,
      report: report as never,
      costMicros: totalCostMicros,
      completedAt,
      sourceCount: newsSection.stored,
      findingCount: 0,
      actionCount: 0,
      errorCode: status === "FAILED" ? "BUNDLE_FAILED" : status === "PARTIAL" ? "BUNDLE_PARTIAL" : null,
    },
  });

  return {
    status: status.toLowerCase() as "completed" | "partial" | "failed",
    exitCode: status === "FAILED" ? 1 : status === "PARTIAL" ? 5 : 0,
    plan,
    runId: run.id,
    receipt: receiptFromRun({
      ...run,
      status,
      costMicros: totalCostMicros,
      completedAt,
      sourceCount: newsSection.stored,
      report,
    }),
    sections,
    totalCostMicros,
    paidCalls: totalPaidCalls,
    error: status === "FAILED" ? "bundle stored no evidence" : undefined,
  };
}

async function claimBundleRun(
  db: BundleDb,
  input: {
    siteId: string;
    projectId: string;
    month: string;
    approval: string;
    plan: BundlePlan;
    now: Date;
  }
): Promise<{ run: RunRow; created: boolean }> {
  const data = {
    siteId: input.siteId,
    projectId: input.projectId,
    kind: "SEO" as const,
    trigger: "MANUAL" as const,
    status: "RUNNING" as const,
    title: `Monthly evidence bundle — ${input.month}`,
    brief: {
      version: 1,
      month: input.month,
      idempotencyKey: input.plan.idempotencyKey,
      approvalReference: input.approval,
      locale: input.plan.locale,
      caps: input.plan.caps,
      selected: input.plan.selected,
      reuse: input.plan.reuse,
      missing: input.plan.missing,
      paidCalls: input.plan.paidCalls,
      estimatedMicros: input.plan.estimatedMicros,
      budget: input.plan.budget,
    } as never,
    topics: input.plan.selected.keywordQueries.slice(0, 12) as never,
    recencyDays: 31,
    promptVersion: "monthly-bundle-v1",
    idempotencyKey: input.plan.idempotencyKey,
    requestedBy: "research-bundle-cli",
    startedAt: input.now,
  };

  const attempt = async (client: BundleDb) => {
    const existing = await client.researchRun.findFirst({
      where: { siteId: input.siteId, idempotencyKey: input.plan.idempotencyKey },
    });
    if (existing) return { run: existing as RunRow, created: false };
    const run = await client.researchRun.create({ data });
    return { run: run as RunRow, created: true };
  };

  const transaction = (db as unknown as { $transaction?: unknown }).$transaction;
  if (typeof transaction !== "function") return attempt(db);
  return (db as unknown as {
    $transaction: <T>(fn: (tx: BundleDb) => Promise<T>) => Promise<T>;
  }).$transaction(async (tx) => {
    // `pg_advisory_xact_lock` returns void, which Prisma cannot deserialize from
    // `$queryRaw`; `$executeRaw` only needs the affected-row count.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.plan.idempotencyKey}))`;
    return attempt(tx);
  });
}

async function resumeBundleRun(
  db: BundleDb,
  runId: string
): Promise<{ run: RunRow; previousAttempt: unknown }> {
  const current = await db.researchRun.findFirst({ where: { id: runId } });
  if (!current) throw new BundleError(`bundle run ${runId} not found`, 2);
  if (current.status !== "PARTIAL" && current.status !== "FAILED") {
    throw new BundleError(`bundle run ${runId} is ${current.status}, not resumable`, 4);
  }
  const previousAttempt = current.report ?? null;
  const run = await db.researchRun.update({
    where: { id: runId },
    data: {
      status: "RUNNING",
      errorCode: null,
      completedAt: null,
      report: { previousAttempt } as never,
    },
  });
  return { run: run as RunRow, previousAttempt };
}

type RunRow = {
  id: string;
  status: string;
  idempotencyKey: string | null;
  costMicros: number;
  createdAt: Date;
  completedAt: Date | null;
  sourceCount: number;
  startedAt: Date | null;
  brief?: unknown;
  report?: unknown;
};

async function collectKnowledgeSection(
  db: BundleDb,
  site: { id: string; projectId: string },
  deps: BundleDeps
): Promise<BundleSectionResult> {
  try {
    const result = await deps.bridgeKnowledge(db, { projectId: site.projectId, siteId: site.id });
    return {
      name: "business_knowledge",
      status: result.stored > 0 ? "stored" : "skipped",
      stored: result.stored,
      reused: 0,
      costMicros: 0,
      evidenceIds: [],
      detail: result,
    };
  } catch (error) {
    return {
      name: "business_knowledge",
      status: "failed",
      stored: 0,
      reused: 0,
      costMicros: 0,
      evidenceIds: [],
      error: errorMessage(error),
    };
  }
}

async function collectCrawlAndGscSections(
  db: BundleDb,
  site: { id: string; projectId: string },
  deps: BundleDeps
): Promise<BundleSectionResult[]> {
  try {
    const result = await deps.backfill(db, site.id, { projectId: site.projectId });
    return [
      {
        name: "crawl",
        status: result.crawlEvidence > 0 ? "stored" : "skipped",
        stored: result.crawlEvidence,
        reused: 0,
        costMicros: 0,
        evidenceIds: [],
        detail: { window: result.window, skipped: result.skipped },
      },
      {
        name: "gsc",
        status: result.rankEvidence + result.pageEvidence > 0 ? "stored" : "skipped",
        stored: result.rankEvidence + result.pageEvidence,
        reused: 0,
        costMicros: 0,
        evidenceIds: [],
        detail: {
          rankEvidence: result.rankEvidence,
          pageEvidence: result.pageEvidence,
          window: result.window,
          skipped: result.skipped,
        },
      },
    ];
  } catch (error) {
    const failure = errorMessage(error);
    return [
      { name: "crawl", status: "failed", stored: 0, reused: 0, costMicros: 0, evidenceIds: [], error: failure },
      { name: "gsc", status: "failed", stored: 0, reused: 0, costMicros: 0, evidenceIds: [], error: failure },
    ];
  }
}

async function collectKeywordSection(
  db: BundleDb,
  input: {
    plan: BundlePlan;
    attemptToken: string;
    spend: { totalMicros: number; calls: number };
    caps: BundleCaps;
    canSpend: (estimateMicros: number) => boolean;
    deps: BundleDeps;
    errors: string[];
  }
): Promise<BundleSectionResult> {
  const missing = input.plan.missing.keywordQueries;
  const reused = input.plan.reuse.keywordQueries.length;
  if (missing.length === 0) {
    return {
      name: "keyword_metrics",
      status: reused > 0 ? "reused" : "skipped",
      stored: 0,
      reused,
      costMicros: 0,
      evidenceIds: [],
    };
  }

  let stored = 0;
  let costMicros = 0;
  const evidenceIds: string[] = [];
  let error: string | undefined;
  let capReached = false;

  for (const batch of chunk(missing, BUNDLE_COST_ESTIMATES.keywordBatchSize)) {
    const estimate = estimateKeywordBatchMicros(batch.length);
    if (!input.canSpend(estimate)) {
      capReached = true;
      error = "bundle cap reached before a keyword batch";
      break;
    }
    try {
      const result = await input.deps.collectKeywordMetrics(db, {
        projectId: input.plan.projectId,
        siteId: input.plan.siteId,
        queries: batch,
        languageCode: input.plan.locale.languageCode,
        locationCode: input.plan.locale.locationCode,
        attempt: input.attemptToken,
      });
      input.spend.totalMicros += result.spentMicros;
      input.spend.calls += 1;
      costMicros += result.spentMicros;
      stored += result.evidence.length;
      evidenceIds.push(...result.evidence.map((row) => row.id));
    } catch (caught) {
      error = errorMessage(caught);
      input.errors.push(`keyword_metrics: ${error}`);
      break;
    }
  }

  return {
    name: "keyword_metrics",
    status: error && stored === 0 ? "failed" : stored > 0 ? "stored" : "skipped",
    stored,
    reused,
    costMicros,
    evidenceIds,
    partial: Boolean(error) || capReached,
    detail: { capReached, requested: missing.length },
    error,
  };
}

async function collectDiscoverySection(
  db: BundleDb,
  input: {
    plan: BundlePlan;
    attemptToken: string;
    spend: { totalMicros: number; calls: number };
    canSpend: (estimateMicros: number) => boolean;
    deps: BundleDeps;
    errors: string[];
  }
): Promise<BundleSectionResult> {
  const missing = input.plan.missing.discoverySeeds;
  const reused = input.plan.reuse.discoverySeeds.length;
  if (missing.length === 0) {
    return {
      name: "keyword_discovery",
      status: reused > 0 ? "reused" : "skipped",
      stored: 0,
      reused,
      costMicros: 0,
      evidenceIds: [],
    };
  }

  let stored = 0;
  let costMicros = 0;
  const evidenceIds: string[] = [];
  let error: string | undefined;
  let capReached = false;

  for (const seed of missing) {
    const estimate = BUNDLE_COST_ESTIMATES.discoveryPerSeedMicros;
    if (!input.canSpend(estimate)) {
      capReached = true;
      error = "bundle cap reached before a discovery seed";
      break;
    }
    try {
      const result = await input.deps.collectKeywordDiscovery(db, {
        projectId: input.plan.projectId,
        siteId: input.plan.siteId,
        queries: [seed],
        languageCode: input.plan.locale.languageCode,
        locationCode: input.plan.locale.locationCode,
        attempt: input.attemptToken,
      });
      input.spend.totalMicros += result.spentMicros;
      input.spend.calls += 2;
      costMicros += result.spentMicros;
      stored += result.evidence.length;
      evidenceIds.push(...result.evidence.map((row) => row.id));
    } catch (caught) {
      error = errorMessage(caught);
      input.errors.push(`keyword_discovery: ${error}`);
      break;
    }
  }

  return {
    name: "keyword_discovery",
    status: error && stored === 0 ? "failed" : stored > 0 ? "stored" : "skipped",
    stored,
    reused,
    costMicros,
    evidenceIds,
    partial: Boolean(error) || capReached,
    detail: { capReached, requested: missing.length },
    error,
  };
}

async function collectSerpSection(
  db: BundleDb,
  input: {
    plan: BundlePlan;
    locale: BundleLocale;
    attemptToken: string;
    spend: { totalMicros: number; calls: number };
    canSpend: (estimateMicros: number) => boolean;
    deps: BundleDeps;
    errors: string[];
  }
): Promise<BundleSectionResult> {
  const missing = input.plan.missing.serpQueries;
  const reused = input.plan.reuse.serpQueries.length;
  if (missing.length === 0) {
    return {
      name: "serp_snapshots",
      status: reused > 0 ? "reused" : "skipped",
      stored: 0,
      reused,
      costMicros: 0,
      evidenceIds: [],
    };
  }

  let stored = 0;
  let costMicros = 0;
  const evidenceIds: string[] = [];
  let error: string | undefined;
  let capReached = false;

  for (const query of missing) {
    if (!input.canSpend(BUNDLE_COST_ESTIMATES.serpPerQueryMicros)) {
      capReached = true;
      error = "bundle cap reached before a SERP snapshot";
      break;
    }
    try {
      const result = await input.deps.collectSerpSnapshots(db, {
        projectId: input.plan.projectId,
        siteId: input.plan.siteId,
        queries: [query],
        languageCode: input.locale.languageCode,
        locationCode: input.locale.locationCode,
        domain: input.plan.domain,
        attempt: input.attemptToken,
      });
      input.spend.totalMicros += result.spentMicros;
      input.spend.calls += 1;
      costMicros += result.spentMicros;
      stored += result.evidence.length;
      evidenceIds.push(...result.evidence.map((row) => row.id));
    } catch (caught) {
      error = errorMessage(caught);
      input.errors.push(`serp_snapshots: ${error}`);
      break;
    }
  }

  return {
    name: "serp_snapshots",
    status: error && stored === 0 ? "failed" : stored > 0 ? "stored" : "skipped",
    stored,
    reused,
    costMicros,
    evidenceIds,
    partial: Boolean(error) || capReached,
    detail: { capReached, requested: missing.length },
    error,
  };
}

async function collectAeoSection(
  db: BundleDb,
  input: {
    plan: BundlePlan;
    locale: BundleLocale;
    attemptToken: string;
    spend: { totalMicros: number; calls: number };
    canSpend: (estimateMicros: number) => boolean;
    deps: BundleDeps;
    errors: string[];
  }
): Promise<BundleSectionResult> {
  const missing = input.plan.missing.aeoQuestions;
  const reused = input.plan.reuse.aeoQuestions.length;
  if (missing.length === 0) {
    return {
      name: "aeo_geo",
      status: reused > 0 ? "reused" : "skipped",
      stored: 0,
      reused,
      costMicros: 0,
      evidenceIds: [],
    };
  }

  let stored = 0;
  let costMicros = 0;
  const evidenceIds: string[] = [];
  const absent: string[] = [];
  const failed: Array<{ question: string; error: string }> = [];
  let error: string | undefined;
  let capReached = false;

  for (const question of missing) {
    if (!input.canSpend(BUNDLE_COST_ESTIMATES.aiOverviewPerQuestionMicros)) {
      capReached = true;
      error = "bundle cap reached before an AI Overview question";
      break;
    }
    try {
      const result = await input.deps.collectAiOverviews(db, {
        projectId: input.plan.projectId,
        siteId: input.plan.siteId,
        questions: [question],
        languageCode: input.locale.languageCode,
        locationCode: input.locale.locationCode,
        domain: input.plan.domain,
        brand: input.plan.brand,
        attempt: input.attemptToken,
      });
      input.spend.totalMicros += result.spentMicros;
      input.spend.calls += 1;
      costMicros += result.spentMicros;
      stored += result.evidence.length;
      evidenceIds.push(...result.evidence.map((row) => row.id));
      absent.push(...result.absent);
      failed.push(...result.failed);
    } catch (caught) {
      failed.push({ question, error: errorMessage(caught) });
    }
  }

  for (const failure of failed) input.errors.push(`aeo_geo: ${failure.question}: ${failure.error}`);
  if (failed.length > 0 && stored === 0) error = failed[0]?.error ?? "all AI Overview questions failed";

  return {
    name: "aeo_geo",
    status: error ? "failed" : stored > 0 ? "stored" : "skipped",
    stored,
    reused,
    costMicros,
    evidenceIds,
    partial: failed.length > 0 || capReached,
    detail: { absent, failed, capReached, requested: missing.length },
    error,
  };
}

async function collectNewsSection(
  runId: string,
  input: {
    plan: BundlePlan;
    locale: BundleLocale;
    caps: BundleCaps;
    deps: BundleDeps;
    errors: string[];
  }
): Promise<BundleSectionResult> {
  const sources: ResearchSourceInput[] = [];
  const seen = new Set<string>();
  let errors = 0;

  for (const query of input.plan.selected.newsQueries) {
    if (sources.length >= input.caps.newsItems) break;
    try {
      const items = await input.deps.fetchNews({
        query,
        limit: input.caps.newsItems,
        language: input.locale.languageCode,
        country: input.locale.country,
        // The bundle feeds the timely lane, so stale items are not evidence.
        recencyDays: TIMELY_NEWS_DAYS,
      });
      for (const item of items) {
        if (sources.length >= input.caps.newsItems) break;
        const key = item.contentHash || item.url;
        if (seen.has(key)) continue;
        seen.add(key);
        sources.push({
          provider: item.provider,
          url: item.url,
          title: item.title,
          author: item.author,
          community: item.community,
          publishedAt: item.publishedAt,
          excerpt: item.excerpt,
          contentHash: item.contentHash,
          language: item.language,
          metadata: { ...(item.metadata ?? {}), query },
        });
      }
    } catch (caught) {
      errors += 1;
      input.errors.push(`news_events: ${query}: ${errorMessage(caught)}`);
    }
  }

  if (sources.length === 0) {
    return {
      name: "news_events",
      status: errors > 0 ? "failed" : "skipped",
      stored: 0,
      reused: 0,
      costMicros: 0,
      evidenceIds: [],
      error: errors > 0 ? "no news/event query returned a source" : undefined,
    };
  }

  try {
    const saved = await input.deps.saveNews(runId, sources);
    return {
      name: "news_events",
      status: "stored",
      stored: saved.length,
      reused: 0,
      costMicros: 0,
      evidenceIds: [],
      partial: errors > 0,
      detail: {
        queries: input.plan.selected.newsQueries,
        requested: input.plan.selected.newsQueries.length,
        failedQueries: errors,
      },
    };
  } catch (caught) {
    return {
      name: "news_events",
      status: "failed",
      stored: 0,
      reused: 0,
      costMicros: 0,
      evidenceIds: [],
      error: errorMessage(caught),
    };
  }
}

async function countEvidenceByKind(
  db: BundleDb,
  input: { projectId: string; siteId: string; since: Date | null; until?: Date }
): Promise<Record<string, number>> {
  try {
    const rows = await db.evidenceRecord.groupBy({
      by: ["kind"],
      where: {
        projectId: input.projectId,
        siteId: input.siteId,
        ...(input.since || input.until
          ? {
              observedAt: {
                ...(input.since ? { gte: input.since } : {}),
                ...(input.until ? { lt: input.until } : {}),
              },
            }
          : {}),
      },
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((row) => [row.kind, row._count._all]));
  } catch {
    return {};
  }
}

async function reusableValues(
  db: BundleDb,
  input: {
    projectId: string;
    siteId: string;
    kind: "keyword_metrics" | "serp_snapshot" | "ai_visibility_observation";
    since: Date;
    key: "query" | "question" | "seed";
    match: (dimensions: Record<string, unknown>) => boolean;
  }
): Promise<Set<string>> {
  const rows = await db.evidenceRecord.findMany({
    where: {
      projectId: input.projectId,
      siteId: input.siteId,
      kind: input.kind,
      supersededById: null,
      observedAt: { gte: input.since },
    },
    select: { dimensions: true },
  });
  const values = new Set<string>();
  for (const row of rows) {
    const dimensions = asRecord(row.dimensions);
    if (!input.match(dimensions)) continue;
    const value = stringValue(dimensions[input.key]);
    if (value) values.add(normalizePhrase(value));
  }
  return values;
}

function summarizeRun(run: {
  id: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  costMicros: number;
  sourceCount: number;
}): BundleRunSummary {
  return {
    id: run.id,
    status: run.status,
    createdAt: toIso(run.createdAt),
    completedAt: toIso(run.completedAt),
    costMicros: run.costMicros,
    sourceCount: run.sourceCount,
  };
}

function chunk<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

function normalizePhrase(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const ENGLISH_STOPWORDS = new Set([
  "the", "how", "what", "why", "when", "where", "which", "who", "is", "are", "can",
  "do", "does", "with", "for", "from", "my", "i", "you", "we", "they", "it", "and",
  "or", "of", "in", "on", "to", "a", "an", "offers", "right", "needs", "address",
]);
const FRENCH_STOPWORDS = new Set([
  "le", "la", "les", "un", "une", "des", "du", "de", "et", "ou", "comment", "pourquoi",
  "quel", "quelle", "quels", "quelles", "où", "quand", "qui", "est", "sont", "peut",
  "faut", "avec", "pour", "dans", "mon", "ma", "mes", "votre", "notre", "ce", "cette",
  "ces", "je", "tu", "il", "elle", "nous", "vous", "ils", "elles", "ne", "pas", "sur",
  "au", "aux",
]);

/** A cheap language check for selecting AEO questions, not a translation. */
function detectLanguage(value: string): "fr" | "en" | "unknown" {
  const lower = value.trim().toLowerCase();
  // The question templates are recognizable by their opening word; counting
  // stopwords misread "How does … address Ne pas …" as French because the
  // service or concern name is French.
  if (/^(how|what|why|when|where|which|who|is|are|can|do|does|should)\b/.test(lower)) return "en";
  if (/^(comment|pourquoi|quel|quelle|quels|quelles|où|ou|quand|qui|est|sont|faut|peut|dois|doit)\b/.test(lower)) {
    return "fr";
  }
  const tokens = lower
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z]+/)
    .filter(Boolean);
  let english = 0;
  let french = 0;
  for (const token of tokens) {
    if (ENGLISH_STOPWORDS.has(token)) english += 1;
    if (FRENCH_STOPWORDS.has(token)) french += 1;
  }
  if (french > english) return "fr";
  if (english > french) return "en";
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
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
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function errorMessage(error: unknown): string {
  if (error instanceof ConnectorError) return `${error.status}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
