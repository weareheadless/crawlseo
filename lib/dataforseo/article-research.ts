import { createHash } from "node:crypto";
import {
  ArticleKeywordResearchKind,
  ArticleKeywordResearchStatus,
  JobKind,
  Prisma,
  ProjectApiKeyGrantStatus,
} from "@prisma/client";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  executeDataForSeoKeywordOverview,
  executeDataForSeoOrganicSerp,
  executeDataForSeoRelatedKeywords,
  resolveDataForSeoLocale,
} from "@/lib/dataforseo/client";

export const ARTICLE_TASK_LIMIT_MAX = 5;
export const ARTICLE_MIN_INTERVAL_DAYS = 0;
export const ARTICLE_RESEARCH_SCHEMA_VERSION = 1;

export class ArticleResearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArticleResearchValidationError";
  }
}

export class ArticleResearchNotFoundError extends Error {
  constructor(message = "Article keyword research run not found") {
    super(message);
    this.name = "ArticleResearchNotFoundError";
  }
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ArticleResearchValidationError(`${field} must be non-empty text`);
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new ArticleResearchValidationError(`${field} is too long`);
  }
  return normalized;
}

function language(value: unknown): string {
  const normalized = text(value, "language", 16).toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(normalized)) {
    throw new ArticleResearchValidationError("language must be an ISO language code");
  }
  return normalized;
}

function country(value: unknown): string {
  const normalized = text(value, "country", 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new ArticleResearchValidationError("country is not supported for DataForSEO");
  }
  return normalized;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "ARTICLE_RESEARCH_FAILED")
    .replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .slice(0, 240);
}

function isUncertain(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out|fetch failed|network|socket|econn/i.test(error.message);
}

function monthStart(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

type ArticleResearchInput = {
  ideaKey: string;
  ideaSummary: string;
  queries: string[];
  language: string;
  country: string;
  idempotencyKey: string;
};

export function normalizeArticleResearchSeed(value: unknown): string {
  const normalized = text(value, "seed", 120);
  if (/[;,|\n]/.test(normalized)) {
    throw new ArticleResearchValidationError(
      "seed must be one concise query without commas, semicolons, pipes, or newlines"
    );
  }
  return normalized.replace(/\s+/g, " ");
}

export function normalizeArticleResearchQueries(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 5 || value.length > 10) {
    throw new ArticleResearchValidationError("queries must contain 5 to 10 candidates");
  }
  const queries = value.map(normalizeArticleResearchSeed);
  if (new Set(queries.map((query) => query.toLowerCase())).size !== queries.length) {
    throw new ArticleResearchValidationError("queries must be unique");
  }
  return queries;
}

function normalizeInput(input: ArticleResearchInput): ArticleResearchInput {
  return {
    ideaKey: text(input.ideaKey, "idea_key", 240),
    ideaSummary: text(input.ideaSummary, "idea_summary", 2_000),
    queries: normalizeArticleResearchQueries(input.queries),
    language: language(input.language),
    country: country(input.country),
    idempotencyKey: text(input.idempotencyKey, "idempotency_key", 240),
  };
}

function runView(run: {
  id: string;
  projectId: string;
  siteId: string;
  ideaKey: string;
  ideaSummary: string;
  idempotencyKey: string;
  requestHash: string;
  seed: string;
  queries: unknown;
  kind: ArticleKeywordResearchKind;
  parentRunId: string | null;
  language: string;
  country: string;
  providerLanguageCode: string | null;
  providerLocationCode: number | null;
  status: ArticleKeywordResearchStatus;
  providerTaskId: string | null;
  costMicros: number | null;
  result?: unknown;
  errorCode: string | null;
  requestedAt: Date;
  attemptedAt: Date | null;
  completedAt: Date | null;
}, includeResult = false): Record<string, unknown> {
  return {
    run_id: run.id,
    project_id: run.projectId,
    site_id: run.siteId,
    idea_key: run.ideaKey,
    idea_summary: run.ideaSummary,
    idempotency_key: run.idempotencyKey,
    request_hash: run.requestHash,
    seed: run.seed,
    queries: Array.isArray(run.queries) ? run.queries : [],
    kind: run.kind.toLowerCase(),
    parent_run_id: run.parentRunId,
    language: run.language,
    country: run.country,
    provider_language_code: run.providerLanguageCode,
    provider_location_code: run.providerLocationCode,
    status: run.status.toLowerCase(),
    provider_task_id: run.providerTaskId,
    cost_micros: run.costMicros,
    error_code: run.errorCode,
    requested_at: run.requestedAt.toISOString(),
    attempted_at: run.attemptedAt?.toISOString() ?? null,
    completed_at: run.completedAt?.toISOString() ?? null,
    ...(includeResult ? { result: run.result ?? null } : {}),
  };
}

async function ensureArticleResearchJob(projectId: string, siteId: string, runId: string) {
  return enqueueJob({
    projectId,
    siteId,
    kind: JobKind.ARTICLE_KEYWORD_RESEARCH,
    payload: { articleResearchRunId: runId },
    idempotencyKey: `article-keyword-research:${siteId}:${runId}`,
    maxAttempts: 1,
  });
}

async function projectSite(projectId: string) {
  const site = await db.site.findFirst({
    where: { projectId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!site) throw new ArticleResearchNotFoundError("Project has no site");
  return site;
}

async function lockArticleDispatchPolicy(tx: Prisma.TransactionClient, projectId: string, siteId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "SeoResearchPolicy" WHERE "siteId" = ${siteId} FOR UPDATE`;
  const policy = await tx.seoResearchPolicy.findUnique({
    where: { siteId }, select: { articleResearchEnabled: true },
  });
  if (!policy?.articleResearchEnabled) {
    throw new ArticleResearchValidationError("Article keyword research is disabled for this site");
  }
}

async function assertDataForSeoGrant(projectId: string): Promise<void> {
  const grant = await db.projectApiKeyGrant.findFirst({
    where: {
      projectId,
      provider: "dataforseo",
      status: ProjectApiKeyGrantStatus.ACTIVE,
    },
    select: { providerCredential: { select: { status: true } }, apiKeyId: true },
  });
  if (!grant) throw new ArticleResearchValidationError("DataForSEO is not granted to this project");
  if (grant.providerCredential && grant.providerCredential.status !== "ACTIVE") {
    throw new ArticleResearchValidationError("DataForSEO platform credentials are inactive");
  }
  if (!grant.providerCredential && !grant.apiKeyId) {
    throw new ArticleResearchValidationError("DataForSEO credentials are not configured");
  }
}

export type ArticleResearchRequestResult = {
  run_id: string;
  site_id: string;
  status: string;
  existing: boolean;
};

export async function requestArticleKeywordResearch(input: {
  projectId: string;
  ideaKey: string;
  ideaSummary: string;
  queries: string[];
  language: string;
  country: string;
  idempotencyKey: string;
}): Promise<ArticleResearchRequestResult> {
  const normalized = normalizeInput(input);
  const site = await projectSite(input.projectId);
  const policy = await db.seoResearchPolicy.findUnique({
    where: { siteId: site.id },
    select: {
      articleResearchEnabled: true,
      articleTaskLimitPerMonth: true,
      articleMinIntervalDays: true,
    },
  });
  if (!policy) throw new ArticleResearchValidationError("SEO research policy is not configured for this site");
  if (!policy.articleResearchEnabled) {
    throw new ArticleResearchValidationError("Article keyword research is disabled for this site");
  }
  await assertDataForSeoGrant(input.projectId);

  const requestHash = sha256(normalized);
  const existing = await db.articleKeywordResearchRun.findUnique({
    where: { siteId_idempotencyKey: { siteId: site.id, idempotencyKey: normalized.idempotencyKey } },
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ArticleResearchValidationError("idempotency_key is already used for another article idea");
    }
    await ensureArticleResearchJob(input.projectId, site.id, existing.id);
    return {
      run_id: existing.id,
      site_id: existing.siteId,
      status: existing.status.toLowerCase(),
      existing: true,
    };
  }

  const locale = await resolveDataForSeoLocale(
    input.projectId,
    normalized.language,
    normalized.country
  );

  const limit = Math.min(ARTICLE_TASK_LIMIT_MAX, Math.max(1, policy.articleTaskLimitPerMonth));
  const intervalDays = Math.max(ARTICLE_MIN_INTERVAL_DAYS, policy.articleMinIntervalDays);
  const now = new Date();
  const intervalStart = new Date(now.getTime() - intervalDays * 24 * 60 * 60 * 1000);
  let run;
  try {
    run = await db.$transaction(async (tx) => {
      await lockArticleDispatchPolicy(tx, input.projectId, site.id);
      // Serialize allowance checks per site so concurrent MCP calls cannot
      // reserve two paid ideas inside the same interval or monthly allowance.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`article-research:${site.id}`}))`;
      const recent = await tx.articleKeywordResearchRun.findFirst({
        where: {
          siteId: site.id,
          requestedAt: { gte: intervalStart },
          kind: { in: [ArticleKeywordResearchKind.RELATED_KEYWORDS, ArticleKeywordResearchKind.KEYWORD_OVERVIEW] },
        },
        orderBy: { requestedAt: "desc" },
        select: { id: true, requestedAt: true },
      });
      if (recent) {
        throw new ArticleResearchValidationError(`Article keyword research requires ${intervalDays} days between requests`);
      }
      const attemptedThisMonth = await tx.articleKeywordResearchRun.count({
        where: {
          siteId: site.id,
          attemptedAt: { gte: monthStart(now) },
          kind: { in: [ArticleKeywordResearchKind.RELATED_KEYWORDS, ArticleKeywordResearchKind.KEYWORD_OVERVIEW] },
          status: {
            in: [
              ArticleKeywordResearchStatus.ATTEMPTING,
              ArticleKeywordResearchStatus.COMPLETED,
              ArticleKeywordResearchStatus.FAILED,
              ArticleKeywordResearchStatus.UNCERTAIN,
            ],
          },
        },
      });
      if (attemptedThisMonth >= limit) {
        throw new ArticleResearchValidationError("Monthly article keyword research allowance is exhausted");
      }
      return tx.articleKeywordResearchRun.create({
        data: {
          projectId: input.projectId,
          siteId: site.id,
          ideaKey: normalized.ideaKey,
          ideaSummary: normalized.ideaSummary,
          idempotencyKey: normalized.idempotencyKey,
          requestHash,
          seed: normalized.queries[0],
          queries: jsonValue(normalized.queries),
          kind: ArticleKeywordResearchKind.KEYWORD_OVERVIEW,
          language: normalized.language,
          country: normalized.country,
          providerLanguageCode: locale.languageCode,
          providerLocationCode: locale.locationCode,
          status: ArticleKeywordResearchStatus.REQUESTED,
        },
      });
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    const winner = await db.articleKeywordResearchRun.findUnique({
      where: { siteId_idempotencyKey: { siteId: site.id, idempotencyKey: normalized.idempotencyKey } },
    });
    if (!winner || winner.requestHash !== requestHash) throw error;
    run = winner;
  }

  await ensureArticleResearchJob(input.projectId, site.id, run.id);
  return {
    run_id: run.id,
    site_id: run.siteId,
    status: run.status.toLowerCase(),
    existing: false,
  };
}

export async function requestArticleSerpResearch(input: {
  projectId: string;
  parentRunId: string;
  keyword: string;
  idempotencyKey: string;
}): Promise<ArticleResearchRequestResult> {
  const parentRunId = text(input.parentRunId, "parent_run_id", 120);
  const keyword = normalizeArticleResearchSeed(input.keyword);
  const idempotencyKey = text(input.idempotencyKey, "idempotency_key", 240);
  const parent = await db.articleKeywordResearchRun.findFirst({
    where: {
      id: parentRunId,
      projectId: input.projectId,
      kind: ArticleKeywordResearchKind.KEYWORD_OVERVIEW,
      status: ArticleKeywordResearchStatus.COMPLETED,
    },
  });
  if (!parent) {
    throw new ArticleResearchValidationError("A completed keyword overview run is required");
  }
  await assertDataForSeoGrant(input.projectId);

  const requestHash = sha256({ parentRunId, keyword, idempotencyKey });
  const existing = await db.articleKeywordResearchRun.findUnique({
    where: { siteId_idempotencyKey: { siteId: parent.siteId, idempotencyKey } },
  });
  if (existing) {
    if (existing.requestHash !== requestHash || existing.parentRunId !== parentRunId) {
      throw new ArticleResearchValidationError("idempotency_key is already used for another article research request");
    }
    await ensureArticleResearchJob(input.projectId, parent.siteId, existing.id);
    return {
      run_id: existing.id,
      site_id: existing.siteId,
      status: existing.status.toLowerCase(),
      existing: true,
    };
  }

  let run;
  try {
    run = await db.$transaction(async (tx) => {
      await lockArticleDispatchPolicy(tx, input.projectId, parent.siteId);
      return tx.articleKeywordResearchRun.create({
        data: {
        projectId: input.projectId,
        siteId: parent.siteId,
        ideaKey: parent.ideaKey,
        ideaSummary: parent.ideaSummary,
        idempotencyKey,
        requestHash,
        seed: keyword,
        kind: ArticleKeywordResearchKind.ORGANIC_SERP,
        parentRunId,
        language: parent.language,
        country: parent.country,
        providerLanguageCode: parent.providerLanguageCode,
        providerLocationCode: parent.providerLocationCode,
        status: ArticleKeywordResearchStatus.REQUESTED,
        },
      });
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    const winner = await db.articleKeywordResearchRun.findUnique({ where: { parentRunId } });
    if (!winner || winner.requestHash !== requestHash) {
      throw new ArticleResearchValidationError("This keyword overview already has a different SERP request");
    }
    run = winner;
  }

  await ensureArticleResearchJob(input.projectId, parent.siteId, run.id);
  return {
    run_id: run.id,
    site_id: run.siteId,
    status: run.status.toLowerCase(),
    existing: false,
  };
}

async function projectRun(projectId: string, runId: string) {
  const run = await db.articleKeywordResearchRun.findFirst({ where: { id: runId, projectId } });
  if (!run) throw new ArticleResearchNotFoundError();
  return run;
}

export async function getArticleKeywordResearchStatus(projectId: string, runId: string) {
  return runView(await projectRun(projectId, runId));
}

export async function getArticleKeywordResearch(projectId: string, runId: string) {
  return runView(await projectRun(projectId, runId), true);
}

export async function listArticleKeywordResearch(
  projectId: string,
  period?: string,
  limit = 20
) {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 50));
  const where: Prisma.ArticleKeywordResearchRunWhereInput = { projectId };
  if (period) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      throw new ArticleResearchValidationError("period must use YYYY-MM format");
    }
    const start = new Date(`${period}-01T00:00:00.000Z`);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    where.requestedAt = { gte: start, lt: end };
  }
  const runs = await db.articleKeywordResearchRun.findMany({
    where,
    orderBy: { requestedAt: "desc" },
    take: safeLimit,
  });
  return { runs: runs.map((run) => runView(run, true)) };
}

/** Execute the one reserved provider task. Terminal failures are persisted and
 * returned rather than thrown, so the one-attempt durable job is not retried. */
export async function runArticleKeywordResearch(projectId: string, siteId: string, runId: string) {
  const run = await db.articleKeywordResearchRun.findFirst({
    where: { id: runId, projectId, siteId },
  });
  if (!run) throw new ArticleResearchNotFoundError();
  if (run.status !== ArticleKeywordResearchStatus.REQUESTED) return run;

  const claimedCount = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "SeoResearchPolicy" WHERE "siteId" = ${siteId} FOR UPDATE`;
    const policy = await tx.seoResearchPolicy.findUnique({ where: { siteId }, select: { articleResearchEnabled: true } });
    if (!policy?.articleResearchEnabled) {
      await tx.articleKeywordResearchRun.updateMany({
        where: { id: run.id, status: ArticleKeywordResearchStatus.REQUESTED },
        data: { status: ArticleKeywordResearchStatus.FAILED, errorCode: "ARTICLE_RESEARCH_DISABLED", completedAt: new Date() },
      });
      return 0;
    }
    const claimed = await tx.articleKeywordResearchRun.updateMany({
      where: { id: run.id, status: ArticleKeywordResearchStatus.REQUESTED },
      data: { status: ArticleKeywordResearchStatus.ATTEMPTING, attemptedAt: new Date() },
    });
    return claimed.count;
  });
  if (claimedCount !== 1) return projectRun(projectId, runId);

  try {
    const locale = run.providerLanguageCode && run.providerLocationCode
      ? {
          languageCode: run.providerLanguageCode,
          locationCode: run.providerLocationCode,
        }
      : await resolveDataForSeoLocale(projectId, run.language, run.country);
    const result = run.kind === ArticleKeywordResearchKind.KEYWORD_OVERVIEW
      ? await executeDataForSeoKeywordOverview({
          projectId,
          keywords: normalizeArticleResearchQueries(run.queries),
          languageCode: locale.languageCode,
          locationCode: locale.locationCode,
        })
      : run.kind === ArticleKeywordResearchKind.ORGANIC_SERP
        ? await executeDataForSeoOrganicSerp({
            projectId,
            keyword: run.seed,
            languageCode: locale.languageCode,
            locationCode: locale.locationCode,
          })
        : await executeDataForSeoRelatedKeywords({
            projectId,
            seed: run.seed,
            languageCode: locale.languageCode,
            locationCode: locale.locationCode,
          });
    if (JSON.stringify(result.result).length > 200_000) {
      throw new Error("DATAFORSEO_ARTICLE_RESULT_TOO_LARGE");
    }
    return db.articleKeywordResearchRun.update({
      where: { id: run.id },
      data: {
        status: ArticleKeywordResearchStatus.COMPLETED,
        providerTaskId: result.providerTaskId,
        costMicros: result.costMicros,
        result: jsonValue(result.result),
        completedAt: new Date(),
        errorCode: null,
      },
    });
  } catch (error) {
    return db.articleKeywordResearchRun.update({
      where: { id: run.id },
      data: {
        status: isUncertain(error)
          ? ArticleKeywordResearchStatus.UNCERTAIN
          : ArticleKeywordResearchStatus.FAILED,
        errorCode: (isUncertain(error) ? "DATAFORSEO_DISPATCH_UNCERTAIN" : safeError(error))
          .toUpperCase()
          .replace(/[^A-Z0-9_]+/g, "_")
          .slice(0, 120),
        completedAt: new Date(),
      },
    });
  }
}
