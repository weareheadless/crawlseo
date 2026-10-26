import { createHash } from "node:crypto";
import {
  IntegrationProvider,
  JobKind,
  Prisma,
  SyncSource,
  SyncStatus,
  ProjectApiKeyGrantStatus,
  SeoResearchRunStatus,
  SeoResearchTaskKind,
  SeoResearchTaskStatus,
} from "@prisma/client";
import { db } from "@/lib/db";
import { projectSite as resolveProjectSite } from "@/lib/projects/project-site";
import { ConnectorError, connectorBudget, reserveConnectorBudget, settleConnectorBudget } from "@/lib/connectors/service";
import type { ServicePrincipalContext } from "@/lib/auth/service-credentials";
import { getTopKeywords, getTopPages, getSitePeriodMetrics, seoMetricsDateRange } from "@/lib/seo-metrics";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  executeDataForSeoOperation,
  resolveDataForSeoLocale,
  type DataForSeoOperation,
  type DataForSeoOperationResult,
} from "@/lib/dataforseo/client";
import type { ResolvedDataForSeoLocale } from "@/lib/dataforseo/locale";
export { DATAFORSEO_LOCATION_CODES } from "@/lib/dataforseo/locale";

export const STANDARD_PACKAGE_VERSION = "standard-v1";
export const STANDARD_TASK_LIMIT = 9;
export const STANDARD_KEYWORD_SEED_LIMIT = 5;
export const STANDARD_COMPETITOR_LIMIT = 1;
export const REPORT_SCHEMA_VERSION = 1;

export type ResearchBrief = {
  period: string;
  focus_market: { language: string; country: string };
  business_goal: string;
  audience: string[];
  priority_services: string[];
  keyword_seeds: string[];
  competitor: string | null;
  research_questions: string[];
  selection_rationale: {
    market: string;
    seeds: string[];
    competitor: string;
  };
  package: string;
};

export class ResearchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchValidationError";
  }
}

export class ResearchNotFoundError extends Error {
  constructor(message = "SEO research report not found") {
    super(message);
    this.name = "ResearchNotFoundError";
  }
}

function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ResearchValidationError(`${field} must be non-empty text`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new ResearchValidationError(`${field} is too long`);
  return normalized;
}

function list(value: unknown, field: string, maxItems: number, maxItemLength = 300): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ResearchValidationError(`${field} must contain at most ${maxItems} items`);
  }
  const result = value.map((item, index) => text(item, `${field}[${index}]`, maxItemLength));
  if (new Set(result.map((item) => item.toLowerCase())).size !== result.length) {
    throw new ResearchValidationError(`${field} must not contain duplicates`);
  }
  return result;
}

function canonicalDomain(raw: unknown, field: string): string {
  const value = text(raw, field, 253);
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new ResearchValidationError(`${field} must be a hostname without credentials or a path`);
  }
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

function periodStart(period: string): Date {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    throw new ResearchValidationError("period must use YYYY-MM format");
  }
  return new Date(`${period}-01T00:00:00.000Z`);
}

type ClosedPeriod = {
  start: Date;
  end: Date;
  startDate: string;
  endDate: string;
};

export function closedPeriod(period: string): ClosedPeriod {
  const start = periodStart(period);
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const end = new Date(next.getTime() - 1);
  return {
    start,
    end,
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function normalizeSeed(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function validateResearchBrief(value: unknown): ResearchBrief {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ResearchValidationError("research brief must be an object");
  }
  const input = value as Record<string, unknown>;
  const market = input.focus_market;
  if (!market || typeof market !== "object" || Array.isArray(market)) {
    throw new ResearchValidationError("focus_market is required");
  }
  const marketInput = market as Record<string, unknown>;
  const language = text(marketInput.language, "focus_market.language", 16).toLowerCase();
  const country = text(marketInput.country, "focus_market.country", 2).toUpperCase();
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(language)) {
    throw new ResearchValidationError("focus_market.language must be an ISO language code");
  }
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new ResearchValidationError("focus_market.country is not supported for DataForSEO");
  }

  const period = text(input.period, "period", 7);
  periodStart(period);
  const currentMonth = new Date(`${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`);
  if (periodStart(period) >= currentMonth) {
    throw new ResearchValidationError("research period must be a closed calendar month");
  }

  const seeds = list(input.keyword_seeds, "keyword_seeds", STANDARD_KEYWORD_SEED_LIMIT, 120);
  if (seeds.length !== STANDARD_KEYWORD_SEED_LIMIT) {
    throw new ResearchValidationError(`keyword_seeds must contain exactly ${STANDARD_KEYWORD_SEED_LIMIT} items`);
  }
  const normalizedSeeds = seeds.map(normalizeSeed);
  if (new Set(normalizedSeeds).size !== normalizedSeeds.length) {
    throw new ResearchValidationError("keyword_seeds must contain unique concepts");
  }
  const rationale = input.selection_rationale;
  if (!rationale || typeof rationale !== "object" || Array.isArray(rationale)) {
    throw new ResearchValidationError("selection_rationale is required");
  }
  const rationaleInput = rationale as Record<string, unknown>;
  const rationaleSeeds = list(rationaleInput.seeds, "selection_rationale.seeds", STANDARD_KEYWORD_SEED_LIMIT, 500);
  if (rationaleSeeds.length !== STANDARD_KEYWORD_SEED_LIMIT) {
    throw new ResearchValidationError(`selection_rationale.seeds must contain exactly ${STANDARD_KEYWORD_SEED_LIMIT} items`);
  }

  const audience = list(input.audience, "audience", 12, 300);
  const priorityServices = list(input.priority_services, "priority_services", 12, 300);
  const researchQuestions = list(input.research_questions, "research_questions", 12, 500);
  if (!audience.length || !priorityServices.length || !researchQuestions.length) {
    throw new ResearchValidationError("audience, priority_services, and research_questions cannot be empty");
  }
  const competitor = input.competitor === undefined || input.competitor === null || input.competitor === ""
    ? null
    : canonicalDomain(input.competitor, "competitor");
  const packageVersion = text(input.package || STANDARD_PACKAGE_VERSION, "package", 64);
  if (packageVersion !== STANDARD_PACKAGE_VERSION) {
    throw new ResearchValidationError("package is not supported");
  }

  return {
    period,
    focus_market: { language, country },
    business_goal: text(input.business_goal, "business_goal", 1000),
    audience,
    priority_services: priorityServices,
    keyword_seeds: seeds,
    competitor,
    research_questions: researchQuestions,
    selection_rationale: {
      market: text(rationaleInput.market, "selection_rationale.market", 1000),
      seeds: rationaleSeeds,
      competitor: competitor
        ? text(rationaleInput.competitor, "selection_rationale.competitor", 1000)
        : typeof rationaleInput.competitor === "string" && rationaleInput.competitor.trim()
          ? text(rationaleInput.competitor, "selection_rationale.competitor", 1000)
          : "No reliable in-category competitor was available; competitor research was skipped.",
    },
    package: packageVersion,
  };
}

function taskInputForOperation(operation: DataForSeoOperation): Record<string, unknown> {
  switch (operation.kind) {
    case "DOMAIN_OVERVIEW":
      return {
        domain: operation.domain,
        language_code: operation.languageCode,
        location_code: operation.locationCode,
      };
    case "BACKLINKS_OVERVIEW":
      return { domain: operation.domain };
    case "KEYWORD_SEED":
      return {
        seed: operation.seed,
        language_code: operation.languageCode,
        location_code: operation.locationCode,
      };
  }
}

function taskDefinition(
  operationKey: string,
  kind: SeoResearchTaskKind,
  ordinal: number | null,
  operation: DataForSeoOperation
) {
  const input = taskInputForOperation(operation);
  return {
    operationKey,
    kind,
    ordinal,
    input: jsonValue(input),
    requestHash: sha256(input),
  };
}

export function taskDefinitions(
  siteDomain: string,
  brief: ResearchBrief,
  locale: ResolvedDataForSeoLocale
) {
  const expectedLanguageCode = brief.focus_market.language.split("-")[0];
  if (
    locale.country !== brief.focus_market.country
    || locale.languageCode !== expectedLanguageCode
  ) {
    throw new ResearchValidationError("resolved DataForSEO locale does not match focus_market");
  }
  const { locationCode, languageCode } = locale;
  const definitions = [
    taskDefinition(
      `domain:site:${brief.focus_market.language}:${brief.focus_market.country}`,
      SeoResearchTaskKind.DOMAIN_OVERVIEW,
      null,
      { kind: "DOMAIN_OVERVIEW", domain: siteDomain, languageCode, locationCode }
    ),
    taskDefinition(
      "backlinks:site",
      SeoResearchTaskKind.BACKLINKS_OVERVIEW,
      null,
      { kind: "BACKLINKS_OVERVIEW", domain: siteDomain }
    ),
  ];
  brief.keyword_seeds.forEach((seed, index) => {
    definitions.push(
      taskDefinition(
        `keyword:${index + 1}:${normalizeSeed(seed)}:${brief.focus_market.language}:${brief.focus_market.country}`,
        SeoResearchTaskKind.KEYWORD_SEED,
        index + 1,
        { kind: "KEYWORD_SEED", seed, languageCode, locationCode }
      )
    );
  });
  if (brief.competitor) {
    definitions.push(
      taskDefinition(
        `domain:competitor:${brief.focus_market.language}:${brief.focus_market.country}`,
        SeoResearchTaskKind.DOMAIN_OVERVIEW,
        null,
        { kind: "DOMAIN_OVERVIEW", domain: brief.competitor, languageCode, locationCode }
      ),
      taskDefinition(
        "backlinks:competitor",
        SeoResearchTaskKind.BACKLINKS_OVERVIEW,
        null,
        { kind: "BACKLINKS_OVERVIEW", domain: brief.competitor }
      )
    );
  }
  return definitions;
}

export type ResearchRequestResult = {
  report_id: string;
  site_id: string | null;
  period: string;
  status: string;
  task_limit: number;
  task_count: number;
  existing: boolean;
};

function runResult(run: {
  id: string;
  siteId: string | null;
  periodStart: Date;
  status: SeoResearchRunStatus;
  taskLimit: number;
  taskCount: number;
}, existing: boolean): ResearchRequestResult {
  return {
    report_id: run.id,
    site_id: run.siteId,
    period: run.periodStart.toISOString().slice(0, 7),
    status: run.status.toLowerCase(),
    task_limit: run.taskLimit,
    task_count: run.taskCount,
    existing,
  };
}

async function ensureResearchJob(projectId: string, siteId: string, runId: string) {
  return enqueueJob({
    projectId,
    siteId,
    kind: JobKind.SEO_RESEARCH,
    payload: { researchRunId: runId },
    idempotencyKey: `seo-research:${siteId}:${runId}`,
    maxAttempts: 12,
  });
}

export async function requestResearchReport(input: {
  projectId: string;
  brief: unknown;
  idempotencyKey: string;
}): Promise<ResearchRequestResult> {
  const brief = validateResearchBrief(input.brief);
  const idempotencyKey = text(input.idempotencyKey, "idempotency_key", 240);
  let site;
  try {
    site = await resolveProjectSite(input.projectId);
  } catch {
    throw new ResearchNotFoundError("Project has no site");
  }

  const period = periodStart(brief.period);
  const policy = await db.seoResearchPolicy.findUnique({
    where: { siteId: site.id },
    select: {
      enabled: true,
      packageVersion: true,
      monthlyTaskLimit: true,
      keywordSeedLimit: true,
      competitorLimit: true,
    },
  });
  if (!policy) throw new ResearchValidationError("SEO research policy is not configured for this site");
  if (!policy.enabled) throw new ResearchValidationError("SEO research is disabled for this site");
  if (
    policy.monthlyTaskLimit !== STANDARD_TASK_LIMIT ||
    policy.keywordSeedLimit !== STANDARD_KEYWORD_SEED_LIMIT ||
    policy.competitorLimit !== STANDARD_COMPETITOR_LIMIT
  ) {
    throw new ResearchValidationError("SEO research policy does not match the standard package allowance");
  }
  const grant = await db.projectApiKeyGrant.findFirst({
    where: {
      projectId: input.projectId,
      provider: "dataforseo",
      status: ProjectApiKeyGrantStatus.ACTIVE,
    },
    select: {
      id: true,
      providerCredential: { select: { status: true } },
    },
  });
  if (!grant) throw new ResearchValidationError("DataForSEO is not granted to this project");
  if (grant.providerCredential && grant.providerCredential.status !== "ACTIVE") {
    throw new ResearchValidationError("DataForSEO platform credentials are inactive");
  }
  const packageVersion = policy.packageVersion || STANDARD_PACKAGE_VERSION;
  if (packageVersion !== STANDARD_PACKAGE_VERSION) {
    throw new ResearchValidationError("SEO research package is not supported");
  }
  const existingByKey = await db.seoResearchRun.findFirst({
    where: {
      siteId: site.id,
      idempotencyKey,
    },
    include: { tasks: { select: { id: true } } },
  });
  if (existingByKey && (existingByKey.periodStart.getTime() !== period.getTime() || existingByKey.packageVersion !== packageVersion)) {
    throw new ResearchValidationError("idempotency_key is already used for another research period");
  }
  const existing = existingByKey ?? await db.seoResearchRun.findFirst({
    where: {
      siteId: site.id,
      periodStart: period,
      packageVersion,
    },
    include: { tasks: { select: { id: true } } },
  });
  if (existing) {
    const job = await ensureResearchJob(input.projectId, site.id, existing.id);
    void job;
    return runResult(existing, true);
  }

  const budget = await connectorBudget({ projectId: input.projectId } as ServicePrincipalContext, site.id);
  if (budget.configured !== true || !budget.maxOperationMicros || BigInt(budget.maxOperationMicros) <= BigInt(0)) {
    throw new ResearchValidationError("Paid SEO research requires an owner-configured USD monthly allowance and per-operation ceiling");
  }
  if (budget.currency !== "USD") throw new ResearchValidationError("DataForSEO research requires a USD budget policy to reconcile provider costs accurately");

  const locale = await resolveDataForSeoLocale(
    input.projectId,
    brief.focus_market.language,
    brief.focus_market.country
  );
  const definitions = taskDefinitions(site.domain, { ...brief, package: packageVersion }, locale);
  if (definitions.length > STANDARD_TASK_LIMIT) {
    throw new ResearchValidationError("research package exceeds the monthly task allowance");
  }

  const briefJson = jsonValue({ ...brief, package: packageVersion });
  let run;
  try {
    run = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${site.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "SeoResearchPolicy" WHERE "siteId" = ${site.id} FOR UPDATE`;
      const currentPolicy = await tx.seoResearchPolicy.findUnique({ where: { siteId: site.id }, select: { enabled: true } });
      if (!currentPolicy?.enabled) throw new ResearchValidationError("SEO research was disabled before this run could be queued");
      return tx.seoResearchRun.create({
        data: {
        projectId: input.projectId,
        siteId: site.id,
        periodStart: period,
        idempotencyKey,
        brief: briefJson,
        briefHash: sha256(briefJson),
        packageVersion,
        reportSchemaVersion: REPORT_SCHEMA_VERSION,
        status: SeoResearchRunStatus.REQUESTED,
        taskLimit: STANDARD_TASK_LIMIT,
        taskCount: definitions.length,
        tasks: { create: definitions },
      },
      select: {
        id: true,
        siteId: true,
        periodStart: true,
        status: true,
        taskLimit: true,
        taskCount: true,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error;
    const winner = await db.seoResearchRun.findFirst({
      where: { siteId: site.id, periodStart: period, packageVersion },
      select: { id: true, siteId: true, periodStart: true, status: true, taskLimit: true, taskCount: true },
    });
    if (!winner) throw error;
    run = winner;
  }
  await ensureResearchJob(input.projectId, site.id, run.id);
  return runResult(run, false);
}

export type ResearchTaskView = {
  id: string;
  operation_key: string;
  kind: string;
  ordinal: number | null;
  status: string;
  provider_task_id: string | null;
  cost_micros: number | null;
  error_code: string | null;
  attempted_at: string | null;
  completed_at: string | null;
};

function taskView(task: {
  id: string;
  operationKey: string;
  kind: SeoResearchTaskKind;
  ordinal: number | null;
  status: SeoResearchTaskStatus;
  providerTaskId: string | null;
  costMicros: number | null;
  errorCode: string | null;
  attemptedAt: Date | null;
  completedAt: Date | null;
}): ResearchTaskView {
  return {
    id: task.id,
    operation_key: task.operationKey,
    kind: task.kind.toLowerCase(),
    ordinal: task.ordinal,
    status: task.status.toLowerCase(),
    provider_task_id: task.providerTaskId,
    cost_micros: task.costMicros,
    error_code: task.errorCode,
    attempted_at: task.attemptedAt?.toISOString() ?? null,
    completed_at: task.completedAt?.toISOString() ?? null,
  };
}

type ResearchRunViewInput = {
  id: string;
  siteId: string | null;
  periodStart: Date;
  status: SeoResearchRunStatus;
  packageVersion: string;
  taskLimit: number;
  taskCount: number;
  attemptedCount: number;
  actualCostMicros: number;
  requestedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  sourceManifest: unknown;
  brief: unknown;
  report: unknown;
  tasks: Parameters<typeof taskView>[0][];
};

export function researchRunView(run: ResearchRunViewInput, includeReport = false): Record<string, unknown> {
  return {
    report_id: run.id,
    site_id: run.siteId,
    period: run.periodStart.toISOString().slice(0, 7),
    status: run.status.toLowerCase(),
    package: run.packageVersion,
    task_limit: run.taskLimit,
    task_count: run.taskCount,
    attempted_count: run.attemptedCount,
    actual_cost_micros: run.actualCostMicros,
    requested_at: run.requestedAt.toISOString(),
    started_at: run.startedAt?.toISOString() ?? null,
    completed_at: run.completedAt?.toISOString() ?? null,
    error_code: run.errorCode,
    source_manifest: run.sourceManifest ?? null,
    tasks: Array.isArray(run.tasks) ? run.tasks.map(taskView) : [],
    ...(includeReport ? { brief: run.brief, report: run.report ?? null } : {}),
  };
}

async function projectRun(projectId: string, reportId: string) {
  const run = await db.seoResearchRun.findFirst({
    where: { id: reportId, projectId },
    include: { tasks: { orderBy: { createdAt: "asc" } } },
  });
  if (!run) throw new ResearchNotFoundError();
  return run;
}

export async function getResearchReportStatus(projectId: string, reportId: string) {
  return researchRunView(await projectRun(projectId, reportId));
}

export async function getResearchReport(projectId: string, reportId: string) {
  return researchRunView(await projectRun(projectId, reportId), true);
}

export async function getLatestResearchReport(projectId: string) {
  const run = await db.seoResearchRun.findFirst({
    where: { projectId, status: { in: [SeoResearchRunStatus.COMPLETED, SeoResearchRunStatus.PARTIAL] } },
    orderBy: { periodStart: "desc" },
    include: { tasks: { orderBy: { createdAt: "asc" } } },
  });
  return run ? researchRunView(run, true) : { report: null };
}

function reportTasks(report: unknown): Array<Record<string, unknown>> {
  if (!report || typeof report !== "object") return [];
  const data = (report as Record<string, unknown>).dataforseo;
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
}

function taskInput(task: Record<string, unknown>): Record<string, unknown> {
  return task.input && typeof task.input === "object" ? task.input as Record<string, unknown> : {};
}

export function cachedDomainReport(report: unknown, domain: string): Record<string, unknown> | null {
  const task = reportTasks(report).find((candidate) =>
    candidate.kind === "domain_overview" && taskInput(candidate).domain === domain && candidate.status === "completed"
  );
  return task?.result && typeof task.result === "object" ? task.result as Record<string, unknown> : null;
}

export function cachedBacklinksReport(report: unknown, domain: string): Record<string, unknown> | null {
  const task = reportTasks(report).find((candidate) =>
    candidate.kind === "backlinks_overview" && taskInput(candidate).domain === domain && candidate.status === "completed"
  );
  return task?.result && typeof task.result === "object" ? task.result as Record<string, unknown> : null;
}

export function cachedKeywordReport(report: unknown, seed: string): Array<Record<string, unknown>> | null {
  const normalized = normalizeSeed(seed);
  const task = reportTasks(report).find((candidate) =>
    candidate.kind === "keyword_seed" && candidate.status === "completed" && normalizeSeed(String(taskInput(candidate).seed || "")) === normalized
  );
  return Array.isArray(task?.result)
    ? task.result.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    : null;
}

export async function listResearchReports(projectId: string, limit = 12) {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 50));
  const runs = await db.seoResearchRun.findMany({
    where: { projectId },
    orderBy: { periodStart: "desc" },
    take: safeLimit,
    select: {
      id: true,
      siteId: true,
      periodStart: true,
      status: true,
      packageVersion: true,
      taskLimit: true,
      taskCount: true,
      attemptedCount: true,
      actualCostMicros: true,
      requestedAt: true,
      completedAt: true,
      errorCode: true,
    },
  });
  return {
    reports: runs.map((run) => ({
      report_id: run.id,
      site_id: run.siteId,
      period: run.periodStart.toISOString().slice(0, 7),
      status: run.status.toLowerCase(),
      package: run.packageVersion,
      task_limit: run.taskLimit,
      task_count: run.taskCount,
      attempted_count: run.attemptedCount,
      actual_cost_micros: run.actualCostMicros,
      requested_at: run.requestedAt.toISOString(),
      completed_at: run.completedAt?.toISOString() ?? null,
      error_code: run.errorCode,
    })),
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "RESEARCH_SOURCE_FAILED")
    .replace(/(token|secret|password|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .slice(0, 240);
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<{ value: T; error: string | null }> {
  try {
    return { value: await fn(), error: null };
  } catch (error) {
    return { value: fallback, error: safeError(error) };
  }
}

export async function firstPartyEvidence(siteId: string, period?: string) {
  const closed = period ? closedPeriod(period) : null;
  const range = closed ? seoMetricsDateRange(closed.startDate, closed.endDate) : undefined;
  const [metrics, keywords, pages, analytics, gscRun, crawl] = await Promise.all([
    safe(() => getSitePeriodMetrics(siteId, 28, range), null),
    safe(() => getTopKeywords(siteId, 28, 50, range), []),
    safe(() => getTopPages(siteId, 28, 50, range), []),
    safe(
      () => db.analyticsSnapshot.findFirst({
        where: {
          siteId,
          source: "GA4",
          ...(closed ? { periodStart: closed.start, periodEnd: closed.end } : {}),
        },
        orderBy: { capturedAt: "desc" },
        select: { id: true, data: true, periodStart: true, periodEnd: true, capturedAt: true },
      }),
      null
    ),
    safe(
      () => db.syncRun.findMany({
        where: { siteId, source: SyncSource.GSC, status: SyncStatus.COMPLETED },
        orderBy: { finishedAt: "desc" },
        take: 20,
        select: { id: true, metadata: true, finishedAt: true },
      }),
      []
    ),
    safe(
      async () => {
        const latest = await db.crawl.findFirst({
          where: { siteId, status: "COMPLETED" },
          orderBy: { finishedAt: "desc" },
          select: {
            id: true,
            status: true,
            healthScore: true,
            pagesFound: true,
            issuesFound: true,
            startedAt: true,
            finishedAt: true,
          },
        });
        if (!latest) return null;
        const issues = await db.crawlIssue.findMany({
          where: { crawlId: latest.id },
          take: 100,
          orderBy: [{ severity: "asc" }, { type: "asc" }],
          select: { type: true, severity: true, url: true, message: true },
        });
        return { ...latest, issues };
      },
      null
    ),
  ]);

  const gscRecord = (gscRun.value ?? []).find((run) => {
    const coverage = runCoverage(run.metadata);
    return closed && coverage && coverage.startDate <= closed.startDate && coverage.endDate >= closed.endDate;
  }) ?? gscRun.value?.[0] ?? null;
  return {
    gsc: {
      status: gscRecord ? "available" : metrics.error ? "error" : keywords.value.length || pages.value.length ? "available" : "empty",
      error: metrics.error,
      metrics: metrics.value,
      top_queries: keywords.value,
      top_pages: pages.value,
      sync_run_id: gscRecord?.id ?? null,
      coverage: runCoverage(gscRecord?.metadata) ?? (closed ? { startDate: closed.startDate, endDate: closed.endDate } : null),
      completed_at: gscRecord?.finishedAt?.toISOString() ?? null,
    },
    ga4: {
      status: analytics.error ? "error" : analytics.value ? "available" : "empty",
      error: analytics.error,
      summary: analytics.value?.data ?? null,
      snapshot_id: analytics.value?.id ?? null,
      coverage: analytics.value
        ? {
            startDate: analytics.value.periodStart.toISOString().slice(0, 10),
            endDate: analytics.value.periodEnd.toISOString().slice(0, 10),
          }
        : null,
      captured_at: analytics.value?.capturedAt.toISOString() ?? null,
    },
    crawl: {
      status: crawl.error ? "error" : crawl.value ? "available" : "empty",
      error: crawl.error,
      latest: crawl.value,
      crawl_id: crawl.value?.id ?? null,
      finished_at: crawl.value?.finishedAt?.toISOString() ?? null,
    },
  };
}

export async function historicalEvidence(siteId: string, period: string) {
  const current = closedPeriod(period);
  const start = new Date(current.start);
  start.setUTCMonth(start.getUTCMonth() - 5);
  const [keywords, analytics] = await Promise.all([
    db.keyword.findMany({
      where: { siteId, date: { gte: start, lte: current.end } },
      select: { date: true, clicks: true, impressions: true },
    }),
    db.analyticsSnapshot.findMany({
      where: { siteId, source: "GA4", periodStart: { gte: start, lte: current.end } },
      orderBy: { periodStart: "asc" },
      select: { id: true, periodStart: true, periodEnd: true, capturedAt: true, data: true },
    }),
  ]);
  const gscByMonth = new Map<string, { clicks: number; impressions: number }>();
  for (const row of keywords) {
    const month = row.date.toISOString().slice(0, 7);
    const value = gscByMonth.get(month) ?? { clicks: 0, impressions: 0 };
    value.clicks += row.clicks;
    value.impressions += row.impressions;
    gscByMonth.set(month, value);
  }
  const monthLabels: string[] = [];
  const cursor = new Date(start);
  for (let index = 0; index < 6; index += 1) {
    monthLabels.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const gscMonths = monthLabels.map((month) => ({
    month,
    ...(gscByMonth.get(month) ?? { clicks: 0, impressions: 0 }),
    available: gscByMonth.has(month),
  }));
  const ga4Months = analytics.map((snapshot) => ({
    snapshot_id: snapshot.id,
    month: snapshot.periodStart.toISOString().slice(0, 7),
    period_start: snapshot.periodStart.toISOString().slice(0, 10),
    period_end: snapshot.periodEnd.toISOString().slice(0, 10),
    captured_at: snapshot.capturedAt.toISOString(),
    summary: snapshot.data,
  }));
  return {
    gsc_months: gscMonths,
    ga4_months: ga4Months,
    windows: {
      three_months: gscMonths.slice(-3),
      six_months: gscMonths,
      history_state: gscMonths.filter((month) => month.available).length >= 3 ? "available" : "insufficient_history",
    },
  };
}

type SourceCoverage = { startDate: string; endDate: string };

type ResearchSourcePrerequisites = {
  period: { startDate: string; endDate: string };
  ready: boolean;
  sources: {
    gsc: { connected: boolean; ready: boolean; coverage: SourceCoverage | null; last_status: string | null; error_code: string | null };
    ga4: { connected: boolean; ready: boolean; coverage: SourceCoverage | null; last_status: string | null; error_code: string | null };
    crawl: { ready: boolean; finishedAt: string | null };
  };
  queued_jobs: string[];
};

function runCoverage(metadata: unknown): SourceCoverage | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const coverage = (metadata as Record<string, unknown>).coverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) return null;
  const startDate = (coverage as Record<string, unknown>).startDate;
  const endDate = (coverage as Record<string, unknown>).endDate;
  return typeof startDate === "string" && typeof endDate === "string"
    ? { startDate, endDate }
    : null;
}

function matchingCoverage(
  runs: Array<{ metadata: unknown }>,
  period: { startDate: string; endDate: string }
): SourceCoverage | null {
  for (const run of runs) {
    const coverage = runCoverage(run.metadata);
    if (coverage && coverage.startDate <= period.startDate && coverage.endDate >= period.endDate) {
      return coverage;
    }
  }
  return null;
}

export async function sourcePrerequisites(
  projectId: string,
  siteId: string,
  period: string
): Promise<ResearchSourcePrerequisites> {
  const closed = closedPeriod(period);
  const [gscRuns, ga4Runs, crawl, grants] = await Promise.all([
    db.syncRun.findMany({
      where: { siteId, source: SyncSource.GSC, status: { in: [SyncStatus.COMPLETED, SyncStatus.FAILED] } },
      orderBy: { finishedAt: "desc" },
      take: 20,
      select: { metadata: true, status: true, errorCode: true },
    }),
    db.syncRun.findMany({
      where: { siteId, source: SyncSource.GA4, status: { in: [SyncStatus.COMPLETED, SyncStatus.FAILED] } },
      orderBy: { finishedAt: "desc" },
      take: 20,
      select: { metadata: true, status: true, errorCode: true },
    }),
    db.crawl.findFirst({
      where: {
        siteId,
        status: "COMPLETED",
        finishedAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { finishedAt: "desc" },
      select: { finishedAt: true },
    }),
    db.integrationGrant.findMany({
      where: {
        projectId,
        siteId,
        provider: { in: [IntegrationProvider.GOOGLE_SEARCH_CONSOLE, IntegrationProvider.GOOGLE_ANALYTICS] },
        status: { in: ["ACTIVE", "UNVERIFIED"] },
      },
      select: { provider: true },
    }),
  ]);
  const connected = new Set(grants.map((grant) => grant.provider));
  const gscCoverage = matchingCoverage(gscRuns, closed);
  const ga4Coverage = matchingCoverage(ga4Runs, closed);
  const sources = {
    gsc: {
      connected: connected.has(IntegrationProvider.GOOGLE_SEARCH_CONSOLE),
      ready: Boolean(gscCoverage),
      coverage: gscCoverage,
      last_status: gscRuns[0]?.status.toLowerCase() ?? null,
      error_code: gscRuns[0]?.errorCode ?? null,
    },
    ga4: {
      connected: connected.has(IntegrationProvider.GOOGLE_ANALYTICS),
      ready: Boolean(ga4Coverage),
      coverage: ga4Coverage,
      last_status: ga4Runs[0]?.status.toLowerCase() ?? null,
      error_code: ga4Runs[0]?.errorCode ?? null,
    },
    crawl: {
      ready: Boolean(crawl?.finishedAt),
      finishedAt: crawl?.finishedAt?.toISOString() ?? null,
    },
  };
  return {
    period: { startDate: closed.startDate, endDate: closed.endDate },
    ready: sources.gsc.ready && sources.ga4.ready && sources.crawl.ready,
    sources,
    queued_jobs: [],
  };
}

export async function ensureSourcePrerequisites(
  projectId: string,
  siteId: string,
  period: string,
  maxCrawlPages = 200
): Promise<ResearchSourcePrerequisites> {
  const prerequisites = await sourcePrerequisites(projectId, siteId, period);
  const jobs: string[] = [];
  if (!prerequisites.sources.gsc.ready && prerequisites.sources.gsc.connected) {
    const job = await enqueueJob({
      projectId,
      siteId,
      kind: JobKind.GSC_SYNC,
      payload: { periodStart: prerequisites.period.startDate, periodEnd: prerequisites.period.endDate },
      idempotencyKey: `seo-source:${siteId}:${period}:gsc`,
    });
    jobs.push(job.id);
  }
  if (!prerequisites.sources.ga4.ready && prerequisites.sources.ga4.connected) {
    const job = await enqueueJob({
      projectId,
      siteId,
      kind: JobKind.GA4_SYNC,
      payload: { periodStart: prerequisites.period.startDate, periodEnd: prerequisites.period.endDate },
      idempotencyKey: `seo-source:${siteId}:${period}:ga4`,
    });
    jobs.push(job.id);
  }
  if (!prerequisites.sources.crawl.ready) {
    const job = await enqueueJob({
      projectId,
      siteId,
      kind: JobKind.CRAWL,
      payload: { maxPages: Math.max(1, Math.min(Math.floor(maxCrawlPages), 2000)) },
      idempotencyKey: `seo-source:${siteId}:${period}:crawl`,
    });
    jobs.push(job.id);
  }
  return { ...prerequisites, queued_jobs: jobs };
}

async function waitingForSources(
  runId: string,
  prerequisites: ResearchSourcePrerequisites
) {
  return db.seoResearchRun.update({
    where: { id: runId },
    data: {
      status: SeoResearchRunStatus.WAITING_FOR_SOURCES,
      sourceManifest: jsonValue({
        generated_at: new Date().toISOString(),
        required_period: prerequisites.period,
        sources: prerequisites.sources,
        queued_jobs: prerequisites.queued_jobs,
      }),
    },
    include: { tasks: { orderBy: { createdAt: "asc" } } },
  });
}

function operationFromTask(task: {
  kind: SeoResearchTaskKind;
  input: unknown;
}): DataForSeoOperation {
  const input = task.input && typeof task.input === "object" ? task.input as Record<string, unknown> : {};
  if (task.kind === SeoResearchTaskKind.KEYWORD_SEED) {
    if (typeof input.seed !== "string" || typeof input.language_code !== "string" || typeof input.location_code !== "number") {
      throw new Error("INVALID_RESEARCH_TASK_INPUT");
    }
    return {
      kind: "KEYWORD_SEED",
      seed: input.seed,
      languageCode: input.language_code,
      locationCode: input.location_code,
    };
  }
  if (task.kind === SeoResearchTaskKind.DOMAIN_OVERVIEW) {
    if (typeof input.domain !== "string" || typeof input.language_code !== "string" || typeof input.location_code !== "number") {
      throw new Error("INVALID_RESEARCH_TASK_INPUT");
    }
    return {
      kind: "DOMAIN_OVERVIEW",
      domain: input.domain,
      languageCode: input.language_code,
      locationCode: input.location_code,
    };
  }
  if (typeof input.domain !== "string") throw new Error("INVALID_RESEARCH_TASK_INPUT");
  return { kind: "BACKLINKS_OVERVIEW", domain: input.domain };
}

export async function executeReservedTask(taskId: string, projectId: string, siteId: string): Promise<void> {
  const task = await db.seoResearchTask.findUnique({
    where: { id: taskId },
    select: { id: true, kind: true, input: true, researchRunId: true },
  });
  if (!task) return;
  const operation = operationFromTask(task);
  const principal = { projectId } as ServicePrincipalContext;
  const budget = await connectorBudget(principal, siteId);
  if (budget.configured !== true || !budget.maxOperationMicros || BigInt(budget.maxOperationMicros) <= BigInt(0)) {
    throw new ConnectorError("A monthly allowance and positive per-operation ceiling are required before paid SEO research", 409);
  }
  if (budget.currency !== "USD") throw new ConnectorError("DataForSEO costs require a USD budget policy", 409);
  const reservation = await reserveConnectorBudget(principal, {
    siteId, period: budget.period, policyRevision: budget.policyRevision,
    idempotencyKey: `dataforseo-task:${task.id}`, amountMicros: budget.maxOperationMicros,
    currency: budget.currency, operation: `dataforseo:${task.kind.toLowerCase()}`,
    detail: { researchRunId: task.researchRunId, taskId: task.id, ceilingMicros: budget.maxOperationMicros },
  });
  const claimed = await db.seoResearchTask.updateMany({
    where: { id: taskId, status: SeoResearchTaskStatus.RESERVED },
    data: { status: SeoResearchTaskStatus.ATTEMPTING, attemptedAt: new Date() },
  });
  if (claimed.count !== 1) return;

  let result: DataForSeoOperationResult | null = null;
  let errorCode: string | null = null;
  let uncertain = false;
  try {
    result = await executeDataForSeoOperation({
      projectId,
      researchRunId: task.researchRunId,
      taskId: task.id,
      operation,
    });
  } catch (error) {
    errorCode = safeError(error).toUpperCase().replace(/[^A-Z0-9_]+/g, "_").slice(0, 120);
    uncertain = error instanceof Error && /timeout|timed out|fetch failed|network/i.test(error.message);
  }

  if (result?.costMicros !== null && result?.costMicros !== undefined) {
    await settleConnectorBudget(principal, reservation.id, { status: "settled", actualCostMicros: String(result.costMicros),
      providerTaskId: result.providerTaskId, detail: { researchRunId: task.researchRunId, taskId: task.id } });
  } else if (result || uncertain) {
    await settleConnectorBudget(principal, reservation.id, { status: "uncertain", providerTaskId: result?.providerTaskId,
      detail: { researchRunId: task.researchRunId, taskId: task.id, reason: result ? "provider_cost_missing" : errorCode } });
    uncertain = true;
  } else {
    await settleConnectorBudget(principal, reservation.id, { status: "released", detail: {
      researchRunId: task.researchRunId, taskId: task.id, reason: errorCode || "provider_rejected_before_dispatch",
    } });
  }

  await db.seoResearchTask.update({
    where: { id: task.id },
    data: result
      ? {
          status: SeoResearchTaskStatus.COMPLETED,
          providerTaskId: result.providerTaskId,
          costMicros: result.costMicros,
          result: jsonValue(result.result),
          completedAt: new Date(),
        }
      : {
          status: uncertain ? SeoResearchTaskStatus.UNCERTAIN : SeoResearchTaskStatus.FAILED,
          errorCode: errorCode || "DATAFORSEO_TASK_FAILED",
          completedAt: new Date(),
        },
  });
  await db.seoResearchRun.update({
    where: { id: task.researchRunId },
    data: { attemptedCount: { increment: 1 } },
  });
}

export async function runSeoResearch(projectId: string, siteId: string, researchRunId: string) {
  const run = await db.seoResearchRun.findFirst({
    where: { id: researchRunId, projectId, siteId },
    include: { tasks: { orderBy: { createdAt: "asc" } } },
  });
  if (!run) throw new ResearchNotFoundError();
  if (run.status === SeoResearchRunStatus.COMPLETED || run.status === SeoResearchRunStatus.PARTIAL) return run;

  const brief = run.brief as unknown as ResearchBrief;
  const prerequisites = await ensureSourcePrerequisites(projectId, siteId, brief.period);
  if (!prerequisites.ready) return waitingForSources(run.id, prerequisites);

  const dispatchAllowed = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "SeoResearchPolicy" WHERE "siteId" = ${siteId} FOR UPDATE`;
    const currentPolicy = await tx.seoResearchPolicy.findUnique({ where: { siteId }, select: { enabled: true } });
    if (!currentPolicy?.enabled) {
      await tx.seoResearchRun.updateMany({
        where: { id: run.id, status: { in: [SeoResearchRunStatus.REQUESTED, SeoResearchRunStatus.WAITING_FOR_SOURCES, SeoResearchRunStatus.RUNNING_PAID_RESEARCH] } },
        data: { status: SeoResearchRunStatus.FAILED, errorCode: "SEO_RESEARCH_DISABLED", completedAt: new Date() },
      });
      return false;
    }
    const claimed = await tx.seoResearchRun.updateMany({
      where: { id: run.id, status: { in: [SeoResearchRunStatus.REQUESTED, SeoResearchRunStatus.WAITING_FOR_SOURCES, SeoResearchRunStatus.RUNNING_PAID_RESEARCH] } },
      data: { status: SeoResearchRunStatus.RUNNING_PAID_RESEARCH, startedAt: run.startedAt ?? new Date() },
    });
    return claimed.count === 1;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (!dispatchAllowed) return (await db.seoResearchRun.findUnique({ where: { id: run.id } })) ?? run;

  for (const task of run.tasks) {
    if (task.status === SeoResearchTaskStatus.RESERVED) {
      // Sequential execution makes the nine-task allowance auditable and avoids
      // bursting a provider account with simultaneous paid calls.
      await executeReservedTask(task.id, projectId, siteId);
    }
  }

  const [firstParty, history] = await Promise.all([
    firstPartyEvidence(siteId, brief.period),
    historicalEvidence(siteId, brief.period),
  ]);
  const finished = await db.seoResearchTask.findMany({
    where: { researchRunId: run.id },
    orderBy: { createdAt: "asc" },
  });
  const paid = finished.map((task) => ({
    task_id: task.id,
    operation_key: task.operationKey,
    kind: task.kind.toLowerCase(),
    input: task.input,
    status: task.status.toLowerCase(),
    provider_task_id: task.providerTaskId,
    cost_micros: task.costMicros,
    result: task.result,
    error_code: task.errorCode,
  }));
  const completedCount = finished.filter((task) => task.status === SeoResearchTaskStatus.COMPLETED).length;
  const attempted = finished.filter((task) => task.status !== SeoResearchTaskStatus.RESERVED).length;
  const costMicrosTotal = finished.reduce((sum, task) => sum + (task.costMicros ?? 0), 0);
  const status = completedCount === finished.length
    ? SeoResearchRunStatus.COMPLETED
    : completedCount > 0
      ? SeoResearchRunStatus.PARTIAL
      : SeoResearchRunStatus.FAILED;
  const sourceManifest = {
    generated_at: new Date().toISOString(),
    first_party: {
      gsc: {
        status: firstParty.gsc.status,
        error: firstParty.gsc.error,
        record_id: firstParty.gsc.sync_run_id,
        coverage: firstParty.gsc.coverage,
        completed_at: firstParty.gsc.completed_at,
      },
      ga4: {
        status: firstParty.ga4.status,
        error: firstParty.ga4.error,
        record_id: firstParty.ga4.snapshot_id,
        coverage: firstParty.ga4.coverage,
        captured_at: firstParty.ga4.captured_at,
      },
      crawl: {
        status: firstParty.crawl.status,
        error: firstParty.crawl.error,
        record_id: firstParty.crawl.crawl_id,
        finished_at: firstParty.crawl.finished_at,
      },
    },
    dataforseo: {
      task_count: finished.length,
      completed_count: completedCount,
      attempted_count: attempted,
      cost_micros: costMicrosTotal,
    },
    competitor: brief.competitor
      ? { status: "selected", domain: brief.competitor }
      : {
          status: "not_selected",
          reason: brief.selection_rationale.competitor,
        },
    history: { status: history.windows.history_state },
  };
  const report = {
    schema_version: REPORT_SCHEMA_VERSION,
    period: brief.period,
    focus_market: brief.focus_market,
    brief,
    first_party: firstParty,
    history,
    dataforseo: paid,
    freshness: sourceManifest,
    generated_at: new Date().toISOString(),
  };
  return db.seoResearchRun.update({
    where: { id: run.id },
    data: {
      status,
      attemptedCount: attempted,
      actualCostMicros: costMicrosTotal,
      report: jsonValue(report),
      sourceManifest: jsonValue(sourceManifest),
      errorCode: status === SeoResearchRunStatus.FAILED ? "ALL_DATAFORSEO_TASKS_FAILED" : null,
      completedAt: new Date(),
    },
    include: { tasks: { orderBy: { createdAt: "asc" } } },
  });
}
