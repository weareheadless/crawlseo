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

export type Job = {
  slug: string;
  /** Buyer language: "I want to ..." */
  statement: string;
  who: string;
  stage: JobStage;
  language: string;
  market: { scope: JobMarketScope; places: string[] };
  businessFit: JobFit;
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
  counts: {
    /** Unique measured queries with volume. */
    queries: number;
    assigned: number;
    /** Queries sent to the model that received no verdict. */
    unassigned: number;
    /** Queries with volume that the sample bound did not send; stated, not hidden. */
    omitted: number;
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

/**
 * How many queries one job-map call sends. A model context bound, not a
 * relevance decision: the sample keeps the top impressions and the top volume,
 * and the count it dropped is reported in `counts.omitted`.
 */
export const JOB_SAMPLE_LIMIT = 900;

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
  "A job is what the searcher is trying to accomplish, in their words: 'I want to buy a condo in Tulum', 'I want to check whether this project is legitimate', 'I want to learn to freedive'. A topic is a roll-up of one job. A keyword is not a job.",
  "Read the business facts, the offers and the page inventory. Decide which jobs this business can serve. A job the business does not serve is not demand, however large its volume.",
  "For every job set statement (buyer language), who, stage (research, compare, buy, after_sale), language (two-letter ISO 639-1), marketScope (local, national, international), marketPlaces, businessFit (serves, does_not_serve, unknown), the measured queries that express it, and the page that does the job or null.",
  "A job may have no page: set page to null. Do not classify a query as context or noise only because no page exists.",
  "language is the ISO 639-1 code the buyers search in for this job. market.scope is local, national or international; a local or national job must name its places.",
  "businessFit is serves, does_not_serve or unknown. Use unknown when the facts do not say; do not invent an offer or a page.",
  "Assign every measured query to exactly one verdict: demand (this job, this market, this buyer intent), context (names the market or the business but not the job), noise (shares a word but serves a different job or meaning), or out_of_market (another place or audience).",
  "A bare place ('tulum') is context, never demand. A bare category noun ('casas', 'departamentos', 'freediving') is context unless the query also carries the specific job. A query that names a different job with the same word ('casas de cambio') is noise.",
  "For a demand verdict, set job to the job slug. For every other verdict, job is null.",
  "Do not create a job for a query the business does not serve. Do not leave a query with volume unassigned: if it fits no job, mark it context, noise or out_of_market and say why.",
  "previous lists the job map in use. Revise it; do not replace it with a fresh guess. Keep a job whose queries it still explains.",
  "Return exactly one JSON object: { summary, jobs: [{ slug, statement, who, stage, language, marketScope, marketPlaces, businessFit, queries, page, reason }], verdicts: [{ query, verdict, job, reason }] }.",
  "Keep summary under 400 characters, each reason under 200, at most 20 jobs.",
].join("\n");

export function parseJobMap(
  record: Record<string, unknown>,
  input: Pick<JobMapInput, "pages" | "queries">,
  meta: { proposedBy: "ai" | "human"; model: string | null; generatedAt?: string }
): { jobMap: JobMap; rejected: Array<{ title: string; reason: string }> } {
  const rejected: Array<{ title: string; reason: string }> = [];
  const sampleByKey = new Map(input.queries.map((query) => [query.query.toLowerCase(), query.query]));
  const pageSet = new Set(input.pages.map((page) => pathKey(page.path)));
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
    const page = text(row.page);
    if (page && !pageSet.has(pathKey(page))) {
      rejected.push({ title: statement, reason: "page is not in the supplied inventory" });
      continue;
    }
    const queries = stringList(row.queries, 60)
      .map((query) => sampleByKey.get(query.toLowerCase()))
      .filter((query): query is string => Boolean(query));
    if (queries.length === 0) {
      rejected.push({ title: statement, reason: "cites no measured query" });
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
      queries,
      page: page ? pageKey(page, input.pages) : null,
      reason: text(row.reason)?.slice(0, 400) ?? "",
    });
  }

  const jobSlugs = new Set(jobs.map((job) => job.slug));
  const fitBySlug = new Map(jobs.map((job) => [job.slug, job.businessFit]));
  const verdicts: JobVerdict[] = [];
  const seenQueries = new Set<string>();
  for (const raw of Array.isArray(record.verdicts) ? record.verdicts : []) {
    const row = asRecord(raw);
    const query = text(row.query);
    const verdict = text(row.verdict) as QueryVerdict | null;
    if (!query || !verdict || !VERDICTS.includes(verdict)) continue;
    const matched = sampleByKey.get(query.toLowerCase());
    if (!matched || seenQueries.has(matched)) continue;
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
    seenQueries.add(matched);
    verdicts.push({ query: matched, verdict, job: verdict === "demand" ? job : null, reason: text(row.reason)?.slice(0, 240) ?? "" });
  }

  const sample = sampleForJobs(input.queries);
  const sampleSet = new Set(sample.map((query) => query.query));
  const withVolume = input.queries.filter((query) => (query.volume ?? 0) > 0);
  const withVolumeSet = new Set(withVolume.map((query) => query.query));
  const sentWithVolume = withVolume.filter((query) => sampleSet.has(query.query));
  const assigned = new Set(verdicts.filter((verdict) => withVolumeSet.has(verdict.query)).map((verdict) => verdict.query));
  const unassigned = sentWithVolume.filter((query) => !assigned.has(query.query)).length;
  // Everything the sample did not send, with or without volume: the bound is
  // stated, not hidden. Volume queries are the ones the contract assigns.
  const omitted = input.queries.length - sample.length;

  return {
    jobMap: {
      version: 1,
      proposedBy: meta.proposedBy,
      model: meta.model,
      generatedAt: meta.generatedAt ?? new Date().toISOString(),
      jobs,
      verdicts,
      summary: text(record.summary)?.slice(0, 600) ?? null,
      counts: { queries: withVolume.length, assigned: assigned.size, unassigned, omitted },
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
            page: job.page,
          })),
        }
      : null,
    queriesOmitted: Math.max(0, input.queries.length - sample.length),
  };

  const run = async (extra?: Record<string, unknown>) => {
    const parsed = await chatJson({
      config,
      system: SYSTEM,
      user: JSON.stringify(extra ? { ...payload, correction: extra } : payload),
      maxTokens: 32_000,
      temperature: 0.2,
      attempts: 3,
      timeoutMs: 600_000,
      jsonMode: false,
    });
    return parseJobMap(asRecord(parsed), input, { proposedBy: "ai", model: config.model });
  };

  let result: { jobMap: JobMap; rejected: Array<{ title: string; reason: string }> } | null = null;
  let error: string | null = null;
  try {
    result = await run();
  } catch (cause) {
    error = cause instanceof Error ? cause.message.slice(0, 300) : String(cause).slice(0, 300);
  }
  if (!result) return { jobMap: null, rejected: [], unassigned: [], error, model: config.model };

  // One re-proposal: name the unassigned queries and the rejected jobs. Only
  // queries the sample actually sent can be unassigned; an omitted query is
  // reported as omitted, not asked for again.
  const sampleSet = new Set(sampleForJobs(input.queries).map((query) => query.query));
  const withVolume = new Set(
    input.queries
      .filter((query) => (query.volume ?? 0) > 0 && sampleSet.has(query.query))
      .map((query) => query.query)
  );
  const assigned = new Set(result.jobMap.verdicts.map((verdict) => verdict.query));
  const unassigned = [...withVolume].filter((query) => !assigned.has(query));
  if (unassigned.length > 0 || result.jobMap.jobs.length === 0 || result.rejected.length > 0) {
    try {
      const corrected = await run({
        reason: "The first map left measured queries unassigned or produced no usable job.",
        unassigned: unassigned.slice(0, 60),
        unassignedCount: unassigned.length,
        rejected: result.rejected,
        instruction: "Assign every query with volume to a job or to context, noise or out_of_market. Return the complete revised map, not a diff.",
      });
      if (corrected.jobMap.jobs.length > 0) result = corrected;
    } catch (cause) {
      error = cause instanceof Error ? cause.message.slice(0, 300) : String(cause).slice(0, 300);
    }
  }

  const finalAssigned = new Set(result.jobMap.verdicts.map((verdict) => verdict.query));
  return {
    jobMap: result.jobMap,
    rejected: result.rejected,
    unassigned: [...withVolume].filter((query) => !finalAssigned.has(query)),
    error,
    model: config.model,
  };
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
  return record as unknown as JobMap;
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
