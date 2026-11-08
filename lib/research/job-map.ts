import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { chatJson } from "@/lib/ai/chat";
import { contentWriterConfig } from "@/lib/ai-seo/writer";

/**
 * The job map: what the searcher is trying to do, before any topic is named.
 *
 * A topic is a roll-up of one job. The model names the job, its market, its
 * language and whether the business can serve it, and assigns every measured
 * query to a job or to a not-served bucket. The code checks the contract and
 * the arithmetic; it never decides what the job is.
 */

export type JobStage = "research" | "compare" | "buy" | "after_sale";
export type JobMarketScope = "local" | "national" | "international";
export type JobFit = "serves" | "does_not_serve" | "unknown";
export type QueryVerdict = "demand" | "context" | "noise" | "out_of_market";
export type JobKind = "brand" | "market";
export type JobIntent = "informational" | "commercial" | "transactional" | "local" | "mixed";
export type JobRelevance = "high" | "medium" | "low";
export type JobCoverageKind = "service" | "product" | "content" | "local" | "brand" | "business" | "mixed";

/**
 * The topic this job rolls up. It is decided in the same call as the job, so
 * the topic map is a projection and there is no second semantic pass.
 */
export type JobTopic = {
  name: string;
  kind: JobKind;
  intent: JobIntent;
  relevance: JobRelevance;
  coverageKind: JobCoverageKind;
  offerKey: string;
  /** The forms buyers search, in their language. */
  needTerms: string[];
  /** Phrases that signal local intent without naming a place ("near me"). */
  localIntent: string[];
  actionHint: string;
};

export type Job = {
  slug: string;
  /** Buyer language: "I want to ..." */
  statement: string;
  who: string;
  stage: JobStage;
  language: string;
  market: { scope: JobMarketScope; places: string[] };
  businessFit: JobFit;
  /** The topic projection, decided with the job. */
  topic: JobTopic;
  /** Measured queries that express this job. */
  queries: string[];
  /** The page that does the job, or null when none exists. */
  page: string | null;
  reason: string;
};

export type JobVerdict = {
  query: string;
  verdict: QueryVerdict;
  /** The job slug for a `demand` verdict; null otherwise. */
  job: string | null;
  reason: string;
};

export type JobMap = {
  version: 1;
  proposedBy: "ai" | "human";
  model: string | null;
  generatedAt: string;
  jobs: Job[];
  verdicts: JobVerdict[];
  summary: string | null;
  /** Site-level config, decided in the same call as the jobs. */
  pageTypeRules: Array<{ type: "home" | "service" | "category" | "product" | "blog" | "other"; pattern: string }>;
  excludePaths: string[];
  newsQueries: string[];
  counts: {
    /** Unique measured queries in the window. */
    queries: number;
    /** Queries in this cycle's tranche that the model saw. */
    sent: number;
    /** Sent queries that received a verdict. */
    assigned: number;
    /** Sent queries with no verdict. */
    unassigned: number;
    /** Queries outside the tranche, deferred to a later cycle. */
    deferred: number;
  };
};

export type JobMapInput = {
  domain: string;
  language: string;
  country: string | null;
  market?: string | null;
  audienceMarket?: string | null;
  audienceCountry?: string | null;
  audienceCountries?: string[];
  audienceLanguages?: string[];
  business: {
    name: string | null;
    services: string[];
    location: string | null;
    serviceArea: string[];
    audience: string | null;
    audienceMotivations?: string[];
    differentiators: string[];
    concerns: string[];
  };
  offers: Array<{ offer: string; scope: string; markets?: string[] }>;
  pages: Array<{ path: string; title: string; h1: string; wordCount: number }>;
  queries: Array<{ query: string; impressions: number; volume: number | null }>;
  /** The previous job map, so a pass revises instead of re-inventing. */
  previous?: JobMap | null;
};

export type JobMapDb = Pick<PrismaClient, "siteProfile">;

const STAGES: JobStage[] = ["research", "compare", "buy", "after_sale"];
const SCOPES: JobMarketScope[] = ["local", "national", "international"];
const FITS: JobFit[] = ["serves", "does_not_serve", "unknown"];
const VERDICTS: QueryVerdict[] = ["demand", "context", "noise", "out_of_market"];
const KINDS: JobKind[] = ["brand", "market"];
const INTENTS: JobIntent[] = ["informational", "commercial", "transactional", "local", "mixed"];
const RELEVANCES: JobRelevance[] = ["high", "medium", "low"];
const COVERAGE_KINDS: JobCoverageKind[] = ["service", "product", "content", "local", "brand", "business", "mixed"];
const PAGE_TYPES = ["home", "service", "category", "product", "blog", "other"] as const;

/**
 * How many queries one job-map call sends. This is the cycle's tranche, not a
 * sample of a complete map: the highest-demand queries are processed now and
 * the rest are deferred, counted and left for a later cycle. A thousand
 * keywords are not a completeness target.
 */
export const JOB_SAMPLE_LIMIT = 250;

/** A query sample that includes the high-volume queries, not only the visible ones. */
export function sampleForJobs(
  queries: Array<{ query: string; impressions: number; volume: number | null }>,
  limit = JOB_SAMPLE_LIMIT
): Array<{ query: string; impressions: number; volume: number | null }> {
  if (queries.length <= limit) return [...queries];
  const byImpressions = [...queries].sort((a, b) => b.impressions - a.impressions);
  const byVolume = [...queries].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  const picked = new Map<string, { query: string; impressions: number; volume: number | null }>();
  // Reserve at least one slot for the high-volume tail, which is often the
  // part with zero impressions and the part that inflates a demand number.
  const impressionShare = Math.max(0, Math.min(limit - 1, Math.ceil(limit * 0.6)));
  for (const row of byImpressions.slice(0, impressionShare)) picked.set(row.query, row);
  for (const row of byVolume) {
    if (picked.size >= limit) break;
    picked.set(row.query, row);
  }
  return [...picked.values()];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringList(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()))].slice(0, limit)
    : [];
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function pathKey(path: string): string {
  return path.trim().replace(/%[0-9a-f]{2}/gi, (match) => match.toUpperCase());
}

const SYSTEM = [
  "You map search demand to the jobs people are trying to do for this business.",
  "A job is what the searcher is trying to accomplish, in their words: 'I want to buy a condo in Tulum', 'I want to check whether this project is legitimate', 'I want to learn to freedive'. A keyword is not a job.",
  "Read the crawled business facts, the services and offers it sells, and the page inventory. Those facts are authoritative: a job is served only when the supplied services or offers include it, or a supplied page sells it. A blog guide is not an offer. If the facts do not say, use unknown; do not invent an offer or a page.",
  "A topic is a roll-up of one job. Decide the topic in the same response: topicName (the short label), kind (brand or market), intent (informational, commercial, transactional, local or mixed), relevance (high, medium or low), coverageKind (service, product, content, local, brand, business or mixed), offerKey (the supplied offer, or the topic name when no offer fits), needTerms (the forms buyers search, in their language, including singular/plural and word order), localIntent (phrases that signal local intent without naming a place, in the buyer language), and actionHint (one sentence).",
  "For every job set statement (buyer language), who, stage (research, compare, buy, after_sale), language (two-letter ISO 639-1), marketScope (local, national, international), marketPlaces, businessFit (serves, does_not_serve, unknown), topic, the tranche queries that express it, and the page that does the job or null.",
  "A job may have no page: set page to null. Do not classify a query as context or noise only because no page exists.",
  "language is the ISO 639-1 code the buyers search in for this job. market.scope is local, national or international; a local or national job must name its places.",
  "businessFit is serves, does_not_serve or unknown. Use unknown when the facts do not say; do not invent an offer or a page.",
  "queries is this cycle's tranche, not the whole query set: list the tranche queries that express this job. A later call assigns every tranche query to a verdict.",
  "Do not create a job for a query the business does not serve.",
  "Also return the site config: pageTypeRules (map the inventory's URL prefixes to home, service, category, product, blog or other; exclude legal, checkout, account, tag, pagination and search paths), excludePaths, and newsQueries (4 to 6 searches in the site language that find current news or regulation for this business).",
  "previous lists the job map in use. Revise it; do not replace it with a fresh guess. Keep a job whose queries it still explains.",
  "Return exactly one JSON object: { summary, jobs: [{ slug, statement, who, stage, language, marketScope, marketPlaces, businessFit, topic: { name, kind, intent, relevance, coverageKind, offerKey, needTerms, localIntent, actionHint }, queries, page, reason }], pageTypeRules: [{ type, pattern }], excludePaths: [], newsQueries: [] }.",
  "Keep summary under 400 characters, each reason and actionHint under 200, at most 24 jobs.",
].join("\n");

const SYSTEM_VERDICTS = [
  "You receive the jobs already decided for this business and one batch of measured queries.",
  "Assign every query in the batch to exactly one verdict: demand (this job, this market, this buyer intent), context (names the market or the business but not the job), noise (shares a word but serves a different job or meaning), or out_of_market (another place or audience).",
  "For a demand verdict, set job to the job slug. For every other verdict, job is null.",
  "A bare place ('tulum') is context, never demand. A bare category noun is context unless the query also carries the specific job. A query that names a different job with the same word is noise.",
  "Do not leave a query unassigned. If it fits no job, mark it context, noise or out_of_market and say why.",
  "Return exactly one JSON object: { verdicts: [{ query, verdict, job, reason }] }. Keep each reason under 160 characters.",
].join("\n");

/**
 * Parse one verdict batch against the jobs already decided. It is the only
 * per-query check: membership, the verdict enum and the job link. It does not
 * decide what the query means.
 */
export function parseVerdicts(
  record: Record<string, unknown>,
  queries: Array<{ query: string }>,
  jobs: Job[]
): { verdicts: JobVerdict[]; rejected: Array<{ title: string; reason: string }> } {
  const rejected: Array<{ title: string; reason: string }> = [];
  const byKey = new Map(queries.map((query) => [query.query.toLowerCase(), query.query]));
  const jobSlugs = new Set(jobs.map((job) => job.slug));
  const fitBySlug = new Map(jobs.map((job) => [job.slug, job.businessFit]));
  const verdicts: JobVerdict[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(record.verdicts) ? record.verdicts : []) {
    const row = asRecord(raw);
    const query = text(row.query);
    const verdict = text(row.verdict) as QueryVerdict | null;
    if (!query || !verdict || !VERDICTS.includes(verdict)) continue;
    const matched = byKey.get(query.toLowerCase());
    if (!matched || seen.has(matched)) continue;
    const job = text(row.job);
    if (verdict === "demand") {
      if (!job || !jobSlugs.has(job)) {
        rejected.push({ title: query, reason: "demand verdict names no supplied job" });
        continue;
      }
      // A job the business does not serve cannot own demand.
      if (fitBySlug.get(job) === "does_not_serve") {
        rejected.push({ title: query, reason: "demand assigned to a job the business does not serve" });
        continue;
      }
    }
    if (verdict !== "demand" && job && !jobSlugs.has(job)) {
      rejected.push({ title: query, reason: "verdict names an unknown job" });
      continue;
    }
    seen.add(matched);
    verdicts.push({ query: matched, verdict, job: verdict === "demand" ? job : null, reason: text(row.reason)?.slice(0, 240) ?? "" });
  }
  return { verdicts, rejected };
}

export function parseJobMap(
  record: Record<string, unknown>,
  input: Pick<JobMapInput, "pages" | "queries" | "offers">,
  meta: { proposedBy: "ai" | "human"; model: string | null; generatedAt?: string }
): { jobMap: JobMap; rejected: Array<{ title: string; reason: string }> } {
  const rejected: Array<{ title: string; reason: string }> = [];
  // This cycle's tranche: only these queries can be cited or judged. A query
  // outside it is deferred, not silently treated as understood.
  const sample = sampleForJobs(input.queries);
  const sampleByKey = new Map(sample.map((query) => [query.query.toLowerCase(), query.query]));
  const pageSet = new Set(input.pages.map((page) => pathKey(page.path)));
  const offerKeys = new Set(input.offers.map((offer) => offer.offer));
  const jobs: Job[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(record.jobs) ? record.jobs : []) {
    const row = asRecord(raw);
    const statement = text(row.statement);
    const slug = text(row.slug) ?? (statement ? slugify(statement) : null);
    if (!statement || !slug) {
      rejected.push({ title: text(row.slug) ?? "job", reason: "missing statement" });
      continue;
    }
    if (seen.has(slug)) {
      rejected.push({ title: statement, reason: "duplicate job slug" });
      continue;
    }
    const stage = text(row.stage)?.toLowerCase() as JobStage | null;
    const fit = text(row.businessFit)?.toLowerCase() as JobFit | null;
    const scope = text(row.marketScope)?.toLowerCase() as JobMarketScope | null;
    const language = text(row.language)?.toLowerCase() ?? null;
    if (!stage || !STAGES.includes(stage)) {
      rejected.push({ title: statement, reason: "stage must be research, compare, buy or after_sale" });
      continue;
    }
    if (!fit || !FITS.includes(fit)) {
      rejected.push({ title: statement, reason: "businessFit must be serves, does_not_serve or unknown" });
      continue;
    }
    if (!scope || !SCOPES.includes(scope)) {
      rejected.push({ title: statement, reason: "marketScope must be local, national or international" });
      continue;
    }
    if (!language || !/^[a-z]{2}$/.test(language)) {
      rejected.push({ title: statement, reason: "language must be a two-letter code" });
      continue;
    }
    const places = stringList(row.marketPlaces, 20);
    if (scope !== "international" && places.length === 0) {
      rejected.push({ title: statement, reason: "local or national job needs market places" });
      continue;
    }
    const topicRow = asRecord(row.topic);
    const topicName = text(topicRow.name);
    const kind = text(topicRow.kind)?.toLowerCase() as JobKind | null;
    const intent = text(topicRow.intent)?.toLowerCase() as JobIntent | null;
    const relevance = text(topicRow.relevance)?.toLowerCase() as JobRelevance | null;
    const coverageKind = text(topicRow.coverageKind)?.toLowerCase() as JobCoverageKind | null;
    const offerKey = text(topicRow.offerKey);
    const needTerms = stringList(topicRow.needTerms, 30);
    if (!topicName || !kind || !KINDS.includes(kind) || !intent || !INTENTS.includes(intent) || !relevance || !RELEVANCES.includes(relevance) || !coverageKind || !COVERAGE_KINDS.includes(coverageKind) || !offerKey) {
      rejected.push({ title: statement, reason: "incomplete topic contract" });
      continue;
    }
    if (needTerms.length === 0) {
      rejected.push({ title: statement, reason: "topic has no need terms" });
      continue;
    }
    if (input.offers.length > 0 && !offerKeys.has(offerKey)) {
      rejected.push({ title: statement, reason: "offerKey is not a supplied offer" });
      continue;
    }
    const page = text(row.page);
    if (page && !pageSet.has(pathKey(page))) {
      rejected.push({ title: statement, reason: "page is not in the supplied inventory" });
      continue;
    }
    const queries = stringList(row.queries, 60)
      .map((query) => sampleByKey.get(query.toLowerCase()))
      .filter((query): query is string => Boolean(query));
    if (queries.length === 0) {
      rejected.push({ title: statement, reason: "cites no tranche query" });
      continue;
    }
    seen.add(slug);
    jobs.push({
      slug,
      statement: statement.slice(0, 240),
      who: text(row.who)?.slice(0, 200) ?? "",
      stage,
      language,
      market: { scope, places },
      businessFit: fit,
      topic: {
        name: topicName.slice(0, 160),
        kind,
        intent,
        relevance,
        coverageKind,
        offerKey: offerKey.slice(0, 120),
        needTerms,
        localIntent: stringList(topicRow.localIntent, 20),
        actionHint: text(topicRow.actionHint)?.slice(0, 240) ?? "",
      },
      queries,
      page: page ? pageKey(page, input.pages) : null,
      reason: text(row.reason)?.slice(0, 400) ?? "",
    });
  }

  const parsedVerdicts = parseVerdicts(record, sample, jobs);
  rejected.push(...parsedVerdicts.rejected);
  const verdicts = parsedVerdicts.verdicts;

  const pageTypeRules: JobMap["pageTypeRules"] = [];
  for (const raw of Array.isArray(record.pageTypeRules) ? record.pageTypeRules : []) {
    const row = asRecord(raw);
    const type = text(row.type) as JobMap["pageTypeRules"][number]["type"] | null;
    const pattern = text(row.pattern);
    if (!type || !(PAGE_TYPES as readonly string[]).includes(type) || !pattern || !pattern.startsWith("/")) continue;
    pageTypeRules.push({ type, pattern: pattern.slice(0, 200) });
  }
  const excludePaths = stringList(record.excludePaths, 20).map((path) => (path.startsWith("/") ? path : `/${path}`));
  const newsQueries = stringList(record.newsQueries, 8);

  const assignedQueries = new Set(verdicts.map((verdict) => verdict.query));
  const assigned = [...sample].filter((query) => assignedQueries.has(query.query)).length;
  const unassigned = sample.length - assigned;

  return {
    jobMap: {
      version: 1,
      proposedBy: meta.proposedBy,
      model: meta.model,
      generatedAt: meta.generatedAt ?? new Date().toISOString(),
      jobs,
      verdicts,
      summary: text(record.summary)?.slice(0, 600) ?? null,
      pageTypeRules,
      excludePaths,
      newsQueries,
      counts: {
        queries: input.queries.length,
        sent: sample.length,
        assigned,
        unassigned,
        deferred: input.queries.length - sample.length,
      },
    },
    rejected,
  };
}

function pageKey(path: string, pages: Array<{ path: string }>): string {
  const target = pathKey(path);
  return pages.find((page) => pathKey(page.path) === target)?.path ?? path;
}

export async function proposeJobMap(
  input: JobMapInput
): Promise<{
  jobMap: JobMap | null;
  rejected: Array<{ title: string; reason: string }>;
  unassigned: string[];
  error: string | null;
  model: string | null;
}> {
  const config = contentWriterConfig();
  if (!config) return { jobMap: null, rejected: [], unassigned: [], error: "CONTENT_LLM_API_KEY is not configured", model: null };
  if (input.queries.length === 0) return { jobMap: null, rejected: [], unassigned: [], error: "no measured query to model", model: null };

  const sample = sampleForJobs(input.queries);
  const sampleQueries = sample.map((query) => query.query);
  const payload = {
    domain: input.domain,
    language: input.language,
    businessCountry: input.country,
    market: input.market ?? null,
    audienceMarket: input.audienceMarket ?? null,
    audienceCountry: input.audienceCountry ?? null,
    audienceCountries: input.audienceCountries ?? [],
    audienceLanguages: input.audienceLanguages ?? [],
    business: input.business,
    offers: input.offers,
    pages: input.pages,
    today: new Date().toISOString().slice(0, 10),
    queries: sample,
    previous: input.previous
      ? {
          summary: input.previous.summary,
          jobs: input.previous.jobs.map((job) => ({
            slug: job.slug,
            statement: job.statement,
            marketScope: job.market.scope,
            marketPlaces: job.market.places,
            businessFit: job.businessFit,
            topic: job.topic,
            page: job.page,
          })),
        }
      : null,
    queriesDeferred: Math.max(0, input.queries.length - sample.length),
  };

  // Phase 1: the jobs and the site config. One call; the response is small.
  const jobsRun = async (extra?: Record<string, unknown>) => {
    const parsed = await chatJson({
      config,
      system: `${SYSTEM}\nThis call decides the jobs and site config only. Do not return verdicts; a later call assigns the tranche in batches.`,
      user: JSON.stringify(extra ? { ...payload, correction: extra } : payload),
      maxTokens: 16_000,
      temperature: 0.2,
      attempts: 3,
      timeoutMs: 600_000,
      jsonMode: false,
    });
    return parseJobMap({ ...asRecord(parsed), verdicts: [] }, input, { proposedBy: "ai", model: config.model });
  };

  let jobsResult: ReturnType<typeof parseJobMap> | null = null;
  let error: string | null = null;
  try {
    jobsResult = await jobsRun();
    if (jobsResult.jobMap.jobs.length === 0 || jobsResult.rejected.length > 0) {
      const corrected = await jobsRun({
        reason: "The first job proposal was incomplete.",
        rejected: jobsResult.rejected,
        instruction: "Return the complete job list. Every job needs the topic contract, a supplied offer key and a tranche query it expresses.",
      });
      if (corrected.jobMap.jobs.length > 0) jobsResult = corrected;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message.slice(0, 300) : String(cause).slice(0, 300);
  }
  if (!jobsResult || jobsResult.jobMap.jobs.length === 0) {
    return { jobMap: null, rejected: jobsResult?.rejected ?? [], unassigned: sampleQueries, error: error ?? "no usable job", model: config.model };
  }

  const jobs = jobsResult.jobMap.jobs;
  const verdictPayload = {
    domain: input.domain,
    language: input.language,
    market: input.market ?? null,
    audienceMarket: input.audienceMarket ?? null,
    jobs: jobs.map((job) => ({
      slug: job.slug,
      statement: job.statement,
      stage: job.stage,
      marketScope: job.market.scope,
      marketPlaces: job.market.places,
      businessFit: job.businessFit,
      topic: { name: job.topic.name, needTerms: job.topic.needTerms, intent: job.topic.intent },
    })),
  };

  // Phase 2: verdict batches against the fixed jobs. Every batch is checked
  // for coverage; a missing query is retried once in that batch, never guessed.
  const batchSize = 80;
  const verdicts: JobVerdict[] = [];
  const rejected = [...jobsResult.rejected];
  for (let index = 0; index < sample.length; index += batchSize) {
    const batch = sample.slice(index, index + batchSize);
    const runBatch = async (queries: typeof batch, extra?: Record<string, unknown>) => {
      const parsed = await chatJson({
        config,
        system: SYSTEM_VERDICTS,
        user: JSON.stringify({ ...verdictPayload, queries, correction: extra }),
        maxTokens: 16_000,
        temperature: 0.2,
        attempts: 3,
        timeoutMs: 300_000,
        jsonMode: false,
      });
      return parseVerdicts(asRecord(parsed), queries, jobs);
    };
    try {
      let parsed = await runBatch(batch);
      rejected.push(...parsed.rejected);
      const missing = batch.filter((query) => !parsed.verdicts.some((verdict) => verdict.query === query.query));
      if (missing.length > 0) {
        const retry = await runBatch(batch, {
          reason: "The first pass left queries in this batch unassigned.",
          unassigned: missing.map((query) => query.query),
          instruction: "Assign every query in the batch. Return the complete batch, not a diff.",
        });
        rejected.push(...retry.rejected);
        const byQuery = new Map(parsed.verdicts.map((verdict) => [verdict.query, verdict]));
        for (const verdict of retry.verdicts) byQuery.set(verdict.query, verdict);
        parsed = { verdicts: [...byQuery.values()], rejected: [] };
      }
      verdicts.push(...parsed.verdicts);
    } catch (cause) {
      error = cause instanceof Error ? cause.message.slice(0, 300) : String(cause).slice(0, 300);
    }
  }

  const assignedSet = new Set(verdicts.map((verdict) => verdict.query));
  const assigned = sampleQueries.filter((query) => assignedSet.has(query)).length;
  const unassigned = sampleQueries.filter((query) => !assignedSet.has(query));
  const jobMap: JobMap = {
    ...jobsResult.jobMap,
    verdicts,
    counts: {
      queries: input.queries.length,
      sent: sample.length,
      assigned,
      unassigned: unassigned.length,
      deferred: input.queries.length - sample.length,
    },
  };
  return { jobMap, rejected, unassigned, error, model: config.model };
}

/** Verdicts keyed by query, for the topic map's demand arithmetic. */
export function jobVerdictIndex(jobMap: JobMap | null | undefined): Map<string, JobVerdict> {
  return new Map((jobMap?.verdicts ?? []).map((verdict) => [verdict.query, verdict]));
}

export function jobMapChecksum(jobMap: JobMap): string {
  return createHash("sha256")
    .update(JSON.stringify({ jobs: jobMap.jobs, verdicts: jobMap.verdicts }))
    .digest("hex")
    .slice(0, 16);
}

export async function loadJobMap(db: JobMapDb, siteId: string): Promise<JobMap | null> {
  const profile = await db.siteProfile.findUnique({ where: { siteId }, select: { constraints: true } });
  const raw = asRecord(profile?.constraints).jobMap;
  if (!raw) return null;
  const record = asRecord(raw);
  if (!Array.isArray(record.jobs) || !Array.isArray(record.verdicts)) return null;
  // A map stored before the topic contract (or before the tranche counts) is
  // not usable as a projection. Returning null forces one new proposal instead
  // of guessing the missing fields.
  const counts = asRecord(record.counts);
  if (typeof counts.sent !== "number") return null;
  if (record.jobs.some((job) => !asRecord(asRecord(job).topic).name)) return null;
  return {
    ...(record as unknown as JobMap),
    pageTypeRules: Array.isArray(record.pageTypeRules) ? (record.pageTypeRules as JobMap["pageTypeRules"]) : [],
    excludePaths: Array.isArray(record.excludePaths) ? (record.excludePaths as string[]) : [],
    newsQueries: Array.isArray(record.newsQueries) ? (record.newsQueries as string[]) : [],
  };
}

export async function saveJobMap(db: JobMapDb, siteId: string, jobMap: JobMap): Promise<void> {
  const profile = await db.siteProfile.findUnique({ where: { siteId }, select: { constraints: true } });
  const constraints = { ...asRecord(profile?.constraints), jobMap };
  if (profile) {
    await db.siteProfile.update({ where: { siteId }, data: { constraints: constraints as never } });
  } else {
    await db.siteProfile.create({ data: { siteId, constraints: constraints as never } });
  }
}
