import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";
import {
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
import { businessKnowledgeFields, resolveSiteContext, type SiteContext } from "@/lib/site/context";

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
  serpQueries: 10,
  aeoQuestions: 12,
  newsItems: 20,
  capMicros: 100_000,
};

/** Conservative unit prices; the provider receipt is the source of truth. */
export const BUNDLE_COST_ESTIMATES = {
  keywordPerQueryMicros: 1_500,
  keywordBatchSize: 20,
  keywordMinBatchMicros: 12_000,
  serpPerQueryMicros: 2_000,
  aiOverviewPerQuestionMicros: 2_500,
} as const;

export type BundleLocale = {
  language: string;
  languageCode: string;
  country: string;
  locationCode: number;
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
  allowanceMicros: number | null;
  committedMicros: number;
  remainingMicros: number | null;
};

export type PlannedPaidCall = {
  section: "keyword_metrics" | "serp_snapshots" | "aeo_geo";
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
    serpQueries: string[];
    aeoQuestions: string[];
    newsQueries: string[];
  };
  reuse: {
    keywordQueries: string[];
    serpQueries: string[];
    aeoQuestions: string[];
  };
  missing: {
    keywordQueries: string[];
    serpQueries: string[];
    aeoQuestions: string[];
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
  collectKeywordMetrics: (db: BundleDb, input: CollectionInput) => Promise<CollectionOutput>;
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
  collectKeywordMetrics,
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
  if (caps.serpQueries > 10) throw new BundleError("serpQueries cap cannot exceed 10", 2);
  if (caps.aeoQuestions > 20) throw new BundleError("aeoQuestions cap cannot exceed 20", 2);
  if (caps.newsItems > 20) throw new BundleError("newsItems cap cannot exceed 20", 2);
  return {
    keywordQueries: Math.floor(caps.keywordQueries),
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

export function rankQueries(
  rows: Array<{ dimensions: unknown; metrics: unknown }>
): string[] {
  const byQuery = new Map<string, { query: string; impressions: number }>();
  for (const row of rows) {
    const dimensions = asRecord(row.dimensions);
    const query = stringValue(dimensions.query);
    if (!query || query.length > 120) continue;
    if (dimensions.windowRole === "previous") continue;
    const metrics = asRecord(row.metrics);
    const impressions = Number(asRecord(metrics["first_party:impressions"]).value ?? 0);
    const key = normalizePhrase(query);
    const current = byQuery.get(key);
    if (current) current.impressions += Number.isFinite(impressions) ? impressions : 0;
    else byQuery.set(key, { query, impressions: Number.isFinite(impressions) ? impressions : 0 });
  }
  return [...byQuery.values()]
    .sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query))
    .map((entry) => entry.query);
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
  },
  cap = 6
): string[] {
  const queries: string[] = [];
  const add = (value: string | null | undefined) => {
    const query = value?.trim();
    if (!query || query.length < 3) return;
    if (queries.some((existing) => normalizePhrase(existing) === normalizePhrase(query))) return;
    queries.push(query);
  };
  if (input.businessName) add(`"${input.businessName}"`);
  const place = input.location ?? input.serviceArea?.[0] ?? null;
  const area = input.serviceArea?.[0] ?? null;
  const services = (input.services ?? []).slice(0, 2);
  for (const service of services) {
    add(place ? `"${service}" ${place}` : `"${service}"`);
  }
  // The business location is narrow. The service area is where the audience
  // actually reads the trade press, so it gets its own pass.
  for (const service of services) {
    if (area && area !== place) add(`"${service}" ${area}`);
  }
  if (queries.length === 0) add(input.domain.replace(/^www\./, ""));
  return queries.slice(0, cap);
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
  const allowance = project.monthlyResearchAllowanceMicros === null
    ? null
    : Number(project.monthlyResearchAllowanceMicros);
  return {
    period,
    currency: project.researchBudgetCurrency,
    timeZone: project.researchBudgetTimeZone,
    allowanceMicros: allowance,
    committedMicros: committed,
    remainingMicros: allowance === null ? null : allowance - committed,
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
  const country = (input.country ?? input.context.country)?.toUpperCase() ?? null;
  if (!country) {
    throw new BundleError(
      "the site has no country in business knowledge, the site profile or its domain; pass --country",
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
  return { language, languageCode: language, country, locationCode };
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
}): Promise<BundlePlan> {
  const { db, site, locale, caps } = input;
  const monthStart = monthStartUtc(input.month);
  const localeKey = `${locale.languageCode}:${locale.locationCode}`;
  const warnings: string[] = [];

  const [ranks, coverage] = await Promise.all([
    db.evidenceRecord.findMany({
      where: { projectId: site.projectId, siteId: site.id, kind: "keyword_rank", supersededById: null },
      select: { dimensions: true, metrics: true },
    }),
    db.evidenceRecord.findMany({
      where: { projectId: site.projectId, siteId: site.id, kind: "question_coverage", supersededById: null },
      select: { dimensions: true },
    }),
  ]);

  const rankedQueries = rankQueries(ranks);
  const keywordQueries = rankedQueries.slice(0, caps.keywordQueries);
  const serpQueries = rankedQueries.slice(0, caps.serpQueries);
  const coverageQuestions = coverage
    .map((row) => stringValue(asRecord(row.dimensions).question))
    .filter((question): question is string => Boolean(question));
  // Prefer queries that are not already bought as SERP snapshots: the AI
  // Overview call is a SERP call too, and measuring a different slice of demand
  // is more useful than paying twice for the same query.
  const aeoFallback = [...rankedQueries.slice(caps.serpQueries), ...rankedQueries];
  const aeoQuestions = selectAeoQuestions(
    coverageQuestions,
    aeoFallback,
    caps.aeoQuestions,
    locale.languageCode
  );

  const fields = await businessKnowledgeFields(db, site.projectId);
  const newsQueries = buildNewsQueries(
    {
      businessName: fieldText(fields, "businessName"),
      services: fieldList(fields, "services"),
      location: fieldText(fields, "location"),
      serviceArea: fieldList(fields, "serviceArea"),
      domain: site.domain,
    },
    6
  );

  if (keywordQueries.length < caps.keywordQueries) {
    warnings.push(
      `only ${keywordQueries.length} Search Console queries are available for a ${caps.keywordQueries}-query cap`
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
  if (budget.remainingMicros !== null && estimatedMicros > budget.remainingMicros) {
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
    selected: { keywordQueries, serpQueries, aeoQuestions, newsQueries },
    reuse: { keywordQueries: keywordReuse, serpQueries: serpReuse, aeoQuestions: aeoReuse },
    missing: { keywordQueries: missingKeywords, serpQueries: missingSerp, aeoQuestions: missingAeo },
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
  if (plan.budget.remainingMicros !== null && plan.estimatedMicros > plan.budget.remainingMicros) {
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
    key: "query" | "question";
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
