import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { fetchRedditRssSearch } from "@/lib/research/providers/reddit-rss";
import { fetchGoogleNewsRssSearch } from "@/lib/research/providers/google-news-rss";
import {
  createResearchAction,
  createResearchFinding,
  researchMonthBounds,
  saveResearchSources,
  reusableResearchSources,
} from "@/lib/research/service";
import { createAgentTaskForAction } from "@/lib/agent-tasks/service";
import { isSupersededByExternalAuthority } from "@/lib/research/execution-authority";
import { generateDraftForAction } from "@/lib/research/content";
import { autoAgentDecision } from "@/lib/research/automation";
import { reclassifyUnstableActionTargets } from "@/lib/editorial/action-policy";
import { synthesizeResearch } from "@/lib/research/synthesizer";
import { researchCountry } from "@/lib/research/locale";
import { emitConnectorEvent } from "@/lib/connectors/events";
import { sourceRecencyIssue } from "@/lib/research/quality";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

export function boundedQueryPlan(input: { topics: string[]; questions: string[]; exclusions: string[]; limit: number }) {
  const clean = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  const candidates = [
    ...input.topics.flatMap((value) => [
      { query: value, basis: "configured_topic" },
      { query: `${value} problems`, basis: "topic_intent" },
    ]),
    ...input.questions.flatMap((value) => [
      { query: value, basis: "audience_question" },
      { query: value.replace(/^(how|what|why|when|where|which|who)\s+/i, ""), basis: "question_topic" },
    ]),
  ];
  const seen = new Set<string>();
  return candidates.filter(({ query }) => {
    const normalized = clean(query);
    if (!normalized || query.length > 180 || seen.has(normalized)) return false;
    if (input.exclusions.some((excluded) => {
      const term = clean(excluded);
      return term.length > 0 && ` ${normalized} `.includes(` ${term} `);
    })) return false;
    seen.add(normalized);
    return true;
  }).slice(0, input.limit);
}

export function researchCompletionStatus(sourceErrors: string[], savedSourceCount: number): "COMPLETED" | "PARTIAL" {
  return sourceErrors.length > 0 || savedSourceCount === 0 ? "PARTIAL" : "COMPLETED";
}

function excludedUrl(raw: string, exclusions: string[]): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
    return exclusions.some((value) => {
      const candidate = value.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
      return candidate.startsWith(".") ? host.endsWith(candidate) : host === candidate || host.endsWith(`.${candidate}`);
    });
  } catch { return true; }
}

export async function automateRunActions(input: {
  runId: string;
  siteDomain: string;
  autoDraft: boolean;
  autoAgent: boolean;
  connectorExecutor?: string | null;
}) {
  const actions = await db.researchAction.findMany({
    where: {
      runId: input.runId,
      status: { notIn: ["DISMISSED", "VERIFIED", "FAILED"] },
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    include: {
      _count: { select: { drafts: true } },
      agentTasks: {
        where: { status: { notIn: ["CLOSED", "COMPLETED", "FAILED", "CANCELLED"] } },
        select: { id: true, status: true },
      },
    },
  });

  const drafts: Array<{ actionId: string; status: string; draftId?: string; reason?: string; error?: string }> = [];
  const agentTasks: Array<{ actionId: string; status: string; taskId?: string; reason?: string; error?: string }> = [];
  const skipped: Array<{ actionId: string; reason: string }> = [];

  for (const action of actions) {
    let status = action.status;

    if (input.connectorExecutor && input.connectorExecutor !== "crawlseo-agent") {
      if (input.connectorExecutor === "helloada" && (input.autoDraft || input.autoAgent)) {
        if (action.preparationStatus !== "NONE") {
          skipped.push({ actionId: action.id, reason: `preparation_already_${String(action.preparationStatus).toLowerCase()}` });
          continue;
        }
        const becameEligible = await db.$transaction(async (tx) => {
          const updated = await tx.researchAction.updateMany({
            where: { id: action.id, revision: action.revision, preparationStatus: "NONE" },
            data: { preparationStatus: "ELIGIBLE" },
          });
          if (updated.count !== 1) return false;
          if (action.projectId) await emitConnectorEvent(tx, { projectId: action.projectId, siteId: action.siteId,
            actionId: action.id, actionRevision: action.revision, type: "preparation.eligible",
            payload: { actionId: action.id, revision: action.revision, source: "research-policy" } });
          return true;
        });
        if (!becameEligible) skipped.push({ actionId: action.id, reason: "preparation_state_changed" });
      } else {
        skipped.push({ actionId: action.id, reason: "site_has_another_active_executor" });
      }
      continue;
    }

    // AUTOMATIC authorizes bounded preparation eligibility only. It never
    // substitutes for the owner's approval of the exact candidate/effect.
    if (action.status === "PROPOSED" && action.automationMode === "AUTOMATIC") {
      const becameEligible = await db.$transaction(async (tx) => {
        const updated = await tx.researchAction.updateMany({
          where: { id: action.id, revision: action.revision, status: "PROPOSED", preparationStatus: "NONE" },
          data: { preparationStatus: "ELIGIBLE" },
        });
        if (updated.count !== 1) return false;
        if (action.projectId) await emitConnectorEvent(tx, { projectId: action.projectId, siteId: action.siteId,
          actionId: action.id, actionRevision: action.revision, type: "preparation.eligible",
          payload: { actionId: action.id, revision: action.revision, source: "automatic-research-policy" } });
        return true;
      });
      if (!becameEligible) skipped.push({ actionId: action.id, reason: "preparation_state_changed" });
      else skipped.push({ actionId: action.id, reason: "eligible_for_connector_preparation_owner_approval_required" });
      continue;
    }

    if (input.autoDraft) {
      if (action._count.drafts > 0) {
        drafts.push({ actionId: action.id, status: "skipped", reason: "draft_exists" });
      } else if (!["PROPOSED", "APPROVED", "DRAFTING"].includes(status)) {
        drafts.push({ actionId: action.id, status: "skipped", reason: "not_ready" });
      } else {
        try {
          const draft = await generateDraftForAction(
            action.id,
            "Generated automatically from the site research policy. Review the draft and its evidence before publishing.",
            { requireApproval: false },
          );
          drafts.push({ actionId: action.id, status: "created", draftId: draft.id });
          status = "DRAFT_READY";
        } catch (error) {
          drafts.push({
            actionId: action.id,
            status: "failed",
            error: error instanceof Error ? error.message.slice(0, 240) : "draft generation failed",
          });
        }
      }
    }

    if (!input.autoAgent) continue;

    const decision = autoAgentDecision({
      targetUrl: action.targetUrl,
      format: action.format,
      status,
      source: action.source,
      kind: action.kind,
      siteDomain: input.siteDomain,
      hasOpenTask: action.agentTasks.length > 0,
    });
    if (!decision.eligible) {
      skipped.push({ actionId: action.id, reason: decision.reason });
      continue;
    }

    try {
      await db.researchAction.update({ where: { id: action.id }, data: { preparationStatus: "QUEUED" } });
      const task = await createAgentTaskForAction(
        action.id,
        "Created automatically by the site research policy. Review the evidence and run the agent when ready.",
      );
      agentTasks.push({ actionId: action.id, status: "created", taskId: task.id });
    } catch (error) {
      agentTasks.push({
        actionId: action.id,
        status: "failed",
        error: error instanceof Error ? error.message.slice(0, 240) : "agent task creation failed",
      });
    }
  }

  return { drafts, agentTasks, skipped };
}

export async function runResearchRun(runId: string) {
  const run = await db.researchRun.findUnique({
    where: { id: runId },
    include: {
      site: {
        select: {
          id: true,
          domain: true,
          projectId: true,
          project: { select: { researchBudgetTimeZone: true } },
          connectorBinding: { select: { executor: true, status: true } },
          researchPolicy: { select: { autoDraft: true, autoAgent: true, maxSources: true, monthlyBudget: true,
            goals: true, recencyDays: true, revision: true, enabled: true, providers: true } },
          siteProfile: { select: { constraints: true } },
        },
      },
      findings: { select: { id: true } },
    },
  });
  if (!run) throw new Error("Research run not found");
  if (run.status === "COMPLETED" || run.status === "PARTIAL") return run;

  const { start: monthStart, end: monthEnd } = researchMonthBounds(
    new Date(), run.site.project?.researchBudgetTimeZone ?? "UTC",
  );
  const currentMonthRuns = await db.researchRun.count({
    where: { siteId: run.siteId, createdAt: { gte: monthStart, lt: monthEnd } },
  });
  if (currentMonthRuns > Math.max(0, run.site.researchPolicy?.monthlyBudget ?? 9)) {
    await db.researchRun.update({
      where: { id: run.id },
      data: { status: "FAILED", errorCode: "MONTHLY_RESEARCH_BUDGET_EXCEEDED", completedAt: new Date() },
    });
    throw new Error("Monthly research task budget is exhausted; this queued run was not dispatched");
  }

  const currentPolicy = run.site.researchPolicy;
  const allowedProviders = currentPolicy && Array.isArray(currentPolicy.providers)
    ? stringList(currentPolicy.providers) : ["reddit", "news", "web"];
  const effectiveAllowedProviders = [...allowedProviders];
  if (allowedProviders.includes("web")) effectiveAllowedProviders.push("news");
  const disallowedProviders = currentPolicy
    ? stringList(run.providerSet).filter((provider) => !effectiveAllowedProviders.includes(provider)) : [];
  if (currentPolicy && (run.policyRevision !== currentPolicy.revision || currentPolicy.enabled === false || disallowedProviders.length > 0)) {
    const errorCode = currentPolicy.enabled === false ? "RESEARCH_POLICY_DISABLED"
      : disallowedProviders.length ? "RESEARCH_PROVIDER_NOT_ALLOWED" : "RESEARCH_POLICY_CHANGED";
    await db.researchRun.update({ where: { id: run.id }, data: {
      status: "FAILED", errorCode, completedAt: new Date(),
    } });
    throw new Error(currentPolicy.enabled === false
      ? "Research was disabled before this queued run could be dispatched"
      : disallowedProviders.length
        ? `A queued provider is outside the current site policy: ${disallowedProviders.join(", ")}`
        : "Research policy changed before this queued run could be dispatched; create a fresh run");
  }

  const dispatchAllowed = await db.$transaction(async (tx) => {
    if (run.site.projectId) await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${run.site.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${run.siteId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ResearchPolicy" WHERE "siteId" = ${run.siteId} FOR UPDATE`;
    const latestPolicy = await tx.researchPolicy.findUnique({ where: { siteId: run.siteId }, select: { enabled: true } });
    if (latestPolicy?.enabled === false) {
      await tx.researchRun.updateMany({
        where: { id: run.id, status: { in: ["QUEUED", "RUNNING"] } },
        data: { status: "FAILED", errorCode: "RESEARCH_POLICY_DISABLED", completedAt: new Date() },
      });
      return false;
    }
    const claimed = await tx.researchRun.updateMany({
      where: { id: run.id, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "RUNNING", startedAt: run.startedAt ?? new Date(), errorCode: null, completedAt: null },
    });
    return claimed.count === 1;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (!dispatchAllowed) return (await db.researchRun.findUnique({ where: { id: run.id } })) ?? run;

  try {
    const brief = run.brief as Record<string, unknown>;
    const topics = stringList(run.topics);
    const effectiveTopics = topics.length > 0 ? topics : stringList(brief.topics);
    if (effectiveTopics.length === 0) throw new Error("Research run has no topics");

    const providers = stringList(run.providerSet);
    const useReddit = providers.length === 0 || providers.includes("reddit");
    const useNews = providers.includes("news");
    const unsupportedProviders = providers.filter((provider) => provider !== "reddit" && provider !== "news");
    const collected = new Map<string, Awaited<ReturnType<typeof fetchRedditRssSearch>>[number]>();
    const sourceErrors: string[] = unsupportedProviders.map((provider) => provider === "web"
      ? "web: general web search is not implemented; Google News RSS is available through the news provider"
      : `${provider}: provider is not implemented; no results were reported for this capability`);
    const language = typeof brief.language === "string" ? brief.language : "en";
    const market = typeof brief.market === "string" ? brief.market : "";
    const country = researchCountry(market, language);
    const constraints = run.site.siteProfile?.constraints && typeof run.site.siteProfile.constraints === "object" && !Array.isArray(run.site.siteProfile.constraints)
      ? run.site.siteProfile.constraints as Record<string, unknown> : {};
    const exclusions = stringList(constraints.exclusions ?? constraints.excludedTopics).slice(0, 100);
    const excludedDomains = stringList(constraints.excludedDomains).slice(0, 100);
    const queryPlan = boundedQueryPlan({ topics: effectiveTopics, questions: stringList(brief.questions), exclusions, limit: 5 });
    if (!queryPlan.length) throw new Error("Research policy exclusions removed all bounded query candidates");
    // `web` is explicitly reported unsupported above; never relabel news RSS
    // results as general web research.
    const requestCount = queryPlan.length * ((useReddit ? 1 : 0) + (useNews ? 1 : 0));
    const recencyDays = Math.max(1, Math.min(run.recencyDays, run.site.researchPolicy?.recencyDays ?? run.recencyDays, 730));
    const cached = run.projectId ? await Promise.all([
      ...(useReddit ? [reusableResearchSources({ projectId: run.projectId, provider: "reddit_rss", queries: queryPlan.map((item) => item.query), recencyDays, excludedDomains })] : []),
      ...(useNews ? [reusableResearchSources({ projectId: run.projectId, provider: "google_news_rss", queries: queryPlan.map((item) => item.query), recencyDays, excludedDomains })] : []),
    ]) : [];
    const reusable = cached.flat();
    const reusedQueries = new Set(reusable.map((source) => `${source.provider}:${String(source.metadata?.query ?? "").toLowerCase()}`));
    for (const source of reusable) collected.set(source.contentHash, source);
    let requestIndex = 0;

    for (const plan of queryPlan) {
      const topic = plan.query;
      if (useReddit && !reusedQueries.has(`reddit_rss:${topic.toLowerCase()}`)) {
        try {
          const sources = await fetchRedditRssSearch({
            query: topic,
            sort: "relevance",
            timeWindow: "year",
            limit: 10,
          });
          for (const source of sources) collected.set(source.contentHash, { ...source,
            metadata: { ...source.metadata, query: topic, query_basis: plan.basis, retrieved_at: new Date().toISOString() } });
        } catch (error) {
          sourceErrors.push(`reddit: ${error instanceof Error ? error.message : "Reddit RSS failed"}`);
        }
        requestIndex += 1;
        if (requestIndex < requestCount) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (providers.includes("news") && !reusedQueries.has(`google_news_rss:${topic.toLowerCase()}`)) {
        try {
          const sources = await fetchGoogleNewsRssSearch({
            query: topic,
            language,
            country,
            limit: 10,
          });
          for (const source of sources) collected.set(source.contentHash, { ...source,
            metadata: { ...source.metadata, query: topic, query_basis: plan.basis, retrieved_at: new Date().toISOString() } });
        } catch (error) {
          sourceErrors.push(`news: ${error instanceof Error ? error.message : "Google News RSS failed"}`);
        }
        requestIndex += 1;
        if (requestIndex < requestCount) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }

    const maxSources = Math.max(1, Math.min(run.site.researchPolicy?.maxSources ?? 30, 100));
    const collectedSources = [...collected.values()];
    const qualityFiltered = collectedSources.filter((source) => !excludedUrl(source.url, excludedDomains));
    const policyRecency = run.site.researchPolicy?.recencyDays ?? run.recencyDays;
    const effectiveRecencyDays = Math.max(1, Math.min(run.recencyDays, policyRecency, 730));
    const recencyIssues = qualityFiltered.map((source) => sourceRecencyIssue(source.publishedAt, effectiveRecencyDays));
    const recencyRejections = { missing_date: 0, invalid_date: 0, future_date: 0, stale: 0 };
    for (const issue of recencyIssues) if (issue) recencyRejections[issue] += 1;
    const freshFiltered = qualityFiltered.filter((_, index) => recencyIssues[index] === null);
    const boundedSources = freshFiltered.slice(0, maxSources);
    const savedSources = await saveResearchSources(
      run.id,
      boundedSources.map((source) => ({
        provider: source.provider,
        url: source.url,
        title: source.title,
        author: source.author,
        community: source.community,
        publishedAt: source.publishedAt,
        excerpt: source.excerpt,
        contentHash: source.contentHash,
        language: source.language,
        metadata: source.metadata,
      })),
    );

    const existingFindings = await db.researchFinding.findMany({
      where: { runId: run.id },
      select: { id: true },
    });

    // A site that handed owner work to an external executor through a sibling
    // site for the same domain must not emit a second set of Actions.
    const supersededByExternalAuthority = await isSupersededByExternalAuthority(run.siteId);
    let synthesis: Awaited<ReturnType<typeof synthesizeResearch>> | null = null;
    const actionIds: string[] = [];
    if (existingFindings.length === 0 && savedSources.length > 0) {
      const latestCrawl = await db.crawl.findFirst({
        where: { siteId: run.siteId, status: "COMPLETED" },
        orderBy: { finishedAt: "desc" },
        select: { id: true },
      });
      const candidatePages = latestCrawl
        ? (await db.auditPage.findMany({
            where: { crawlId: latestCrawl.id },
            orderBy: { contentScore: "desc" },
            take: 30,
            select: { url: true },
          })).map((page) => page.url)
        : [];

      synthesis = await synthesizeResearch({
        siteDomain: run.site.domain,
        title: run.title,
        topics: effectiveTopics,
        goals: stringList(run.site.researchPolicy?.goals),
        audience: typeof brief.audience === "string" ? brief.audience : null,
        market: typeof brief.market === "string" ? brief.market : null,
        questions: stringList(brief.questions),
        sources: savedSources,
        candidatePages,
      });

      const findingIdByIndex = new Map<number, string>();
      const sourceIdsByFindingIndex = new Map<number, string[]>();
      for (const [index, finding] of synthesis.findings.entries()) {
        const sourceIds = finding.sourceIndexes
          .map((sourceIndex) => savedSources[sourceIndex]?.id)
          .filter((id): id is string => Boolean(id));
        const savedFinding = await createResearchFinding(run.id, finding, sourceIds);
        findingIdByIndex.set(index, savedFinding.id);
        sourceIdsByFindingIndex.set(index, sourceIds);
      }

      for (const action of supersededByExternalAuthority ? [] : synthesis.actions) {
        const findingId = findingIdByIndex.get(action.findingIndex);
        const result = await createResearchAction(
          run.siteId,
          {
            runId: run.id,
            findingId,
            source: action.source,
            kind: action.kind,
            format: action.format,
            title: action.title,
            primaryQuery: action.primaryQuery,
            targetUrl: action.targetUrl,
            recommendation: action.recommendation,
            priority: action.priority,
            automationMode: action.automationMode,
            evidence: {
              research_run_id: run.id,
              research_title: run.title,
              topics: effectiveTopics,
              source_ids: sourceIdsByFindingIndex.get(action.findingIndex) ?? [],
            },
          },
          run.requestedBy ?? "research-worker",
        );
        actionIds.push(result.action.id);
      }
    }

    const reclassified = await reclassifyUnstableActionTargets(run.siteId, { runId: run.id });

    const policy = run.site.researchPolicy;
    const automation = policy && (policy.autoDraft || policy.autoAgent)
      ? await automateRunActions({
          runId: run.id,
          siteDomain: run.site.domain,
          autoDraft: policy.autoDraft,
          autoAgent: policy.autoAgent,
          connectorExecutor: run.site.connectorBinding
            ? run.site.connectorBinding.status === "ACTIVE" ? run.site.connectorBinding.executor : "inactive-connector"
            : null,
        })
      : null;

    if (savedSources.length === 0) sourceErrors.push("quality: no sources passed URL exclusions and the configured freshness window");
    const status = researchCompletionStatus(sourceErrors, savedSources.length);
    const report = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      providers: [
        ...(useReddit ? ["reddit_rss"] : []),
        ...(providers.includes("news") ? ["google_news_rss"] : []),
      ],
      requested_providers: providers,
      unsupported_providers: unsupportedProviders,
      query_plan: queryPlan,
      exclusions_applied: { topics: exclusions, domains: excludedDomains },
      recency_days: effectiveRecencyDays,
      max_sources: maxSources,
      topics: effectiveTopics,
      source_count: savedSources.length,
      source_quality: {
        collected: collectedSources.length,
        excluded_domains: collectedSources.length - qualityFiltered.length,
        excluded_recency: recencyRejections,
        freshness_eligible: freshFiltered.length,
        capped_by_max_sources: freshFiltered.length - boundedSources.length,
        saved: savedSources.length,
      },
      source_errors: sourceErrors,
      synthesis: synthesis
        ? {
            model: synthesis.model,
            provider: synthesis.provider,
            findings: synthesis.findings,
            actions: synthesis.actions,
          }
        : null,
      action_ids: actionIds,
      reclassified,
      automation,
    };

    return db.researchRun.update({
      where: { id: run.id },
      data: {
        status,
        report: json(report),
        completedAt: new Date(),
        errorCode: status === "PARTIAL" ? "PARTIAL_SOURCE_FAILURES" : null,
      },
    });
  } catch (error) {
    await db.researchRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        errorCode: error instanceof Error ? error.message.slice(0, 120) : "RESEARCH_RUN_FAILED",
      },
    }).catch(() => undefined);
    throw error;
  }
}
