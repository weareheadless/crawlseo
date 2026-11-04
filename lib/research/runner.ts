import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { fetchRedditRssSearch } from "@/lib/research/providers/reddit-rss";
import { fetchGoogleNewsRssSearch } from "@/lib/research/providers/google-news-rss";
import { fetchDataForSeoCompetitorSources } from "@/lib/research/providers/dataforseo-competitor";
import { resolveDataForSeoLocale } from "@/lib/dataforseo/client";
import {
  createResearchAction,
  createResearchFinding,
  researchMonthBounds,
  saveResearchSources,
  reusableResearchSources,
  claimResearchDispatch,
  releaseResearchDispatch,
} from "@/lib/research/service";
import { createAgentTaskForAction } from "@/lib/agent-tasks/service";
import { isSupersededByExternalAuthority } from "@/lib/research/execution-authority";
import { generateDraftForAction } from "@/lib/research/content";
import { autoAgentDecision } from "@/lib/research/automation";
import { reclassifyUnstableActionTargets } from "@/lib/editorial/action-policy";
import { synthesizeResearch } from "@/lib/research/synthesizer";
import { countryFromText, resolveSiteContext } from "@/lib/site/context";
import { emitConnectorEvent } from "@/lib/connectors/events";
import { sourceRecencyIssue } from "@/lib/research/quality";
import { bridgeFindingsToEvidence } from "@/lib/research/finding-evidence";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

export function boundedQueryPlan(input: { topics: string[]; questions: string[]; exclusions: string[]; limit: number; language?: string }) {
  const clean = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
  const candidates = [
    // The intent expansion is English ("… problems"); applying it to a French
    // topic produces phrases nobody searches for, so it only runs in English.
    ...input.topics.flatMap((value) => [
      { query: value, basis: "configured_topic" },
      ...((input.language ?? "en").toLowerCase().startsWith("en")
        ? [{ query: `${value} problems`, basis: "topic_intent" }]
        : []),
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
      status: { notIn: ["DISMISSED", "VERIFIED", "FULFILLED", "FAILED"] },
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
  // Project-scoped runs (prelaunch) have no site and use their own runner.
  if (!run.site) throw new Error("RESEARCH_RUN_SITE_REQUIRED");
  const site = run.site;
  if (run.status === "COMPLETED" || run.status === "PARTIAL") return run;

  const { start: monthStart, end: monthEnd } = researchMonthBounds(
    new Date(), site.project?.researchBudgetTimeZone ?? "UTC",
  );
  const currentMonthRuns = await db.researchRun.count({
    where: { siteId: site.id, createdAt: { gte: monthStart, lt: monthEnd } },
  });
  if (currentMonthRuns > Math.max(0, site.researchPolicy?.monthlyBudget ?? 9)) {
    await db.researchRun.update({
      where: { id: run.id },
      data: { status: "FAILED", errorCode: "MONTHLY_RESEARCH_BUDGET_EXCEEDED", completedAt: new Date() },
    });
    throw new Error("Monthly research task budget is exhausted; this queued run was not dispatched");
  }

  const currentPolicy = site.researchPolicy;
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
    if (site.projectId) await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${site.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${site.id} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ResearchPolicy" WHERE "siteId" = ${site.id} FOR UPDATE`;
    const latestPolicy = await tx.researchPolicy.findUnique({ where: { siteId: site.id }, select: { enabled: true } });
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
    const useCompetitor = providers.includes("competitor");
    const unsupportedProviders = providers.filter((provider) => provider !== "reddit" && provider !== "news" && provider !== "competitor");
    const collected = new Map<string, Awaited<ReturnType<typeof fetchRedditRssSearch>>[number]>();
    const addCollected = (source: Awaited<ReturnType<typeof fetchRedditRssSearch>>[number]) => {
      const previous = collected.get(source.contentHash);
      const oldMeta = previous?.metadata ?? {};
      const newMeta = source.metadata ?? {};
      const queryKeys = [...new Set([
        ...(Array.isArray(oldMeta.query_keys) ? oldMeta.query_keys.filter((item): item is string => typeof item === "string") : []),
        ...(typeof oldMeta.query === "string" ? [oldMeta.query] : []),
        ...(Array.isArray(newMeta.query_keys) ? newMeta.query_keys.filter((item): item is string => typeof item === "string") : []),
        ...(typeof newMeta.query === "string" ? [newMeta.query] : []),
      ].map((query) => query.trim().toLowerCase()).filter(Boolean))];
      collected.set(source.contentHash, { ...source, metadata: { ...oldMeta, ...newMeta, query_keys: queryKeys } });
    };
    const sourceErrors: string[] = unsupportedProviders.map((provider) => provider === "web"
      ? "web: general web search is not implemented; Google News RSS is available through the news provider"
      : `${provider}: provider is not implemented; no results were reported for this capability`);
    // The brief may target a market explicitly; otherwise the site's own context
    // answers, and a site with no language fails loudly instead of running in
    // English.
    const context = await resolveSiteContext(db, site.id);
    const language = typeof brief.language === "string" && brief.language.trim() ? brief.language : context.language;
    const market = typeof brief.market === "string" && brief.market.trim() ? brief.market : (context.market ?? "");
    const country = countryFromText(market) ?? context.country;
    const constraints = site.siteProfile?.constraints && typeof site.siteProfile.constraints === "object" && !Array.isArray(site.siteProfile.constraints)
      ? site.siteProfile.constraints as Record<string, unknown> : {};
    const exclusions = stringList(constraints.exclusions ?? constraints.excludedTopics).slice(0, 100);
    const excludedDomains = stringList(constraints.excludedDomains).slice(0, 100);
    const queryPlan = boundedQueryPlan({ topics: effectiveTopics, questions: stringList(brief.questions), exclusions, limit: 5, language });
    if (!queryPlan.length) throw new Error("Research policy exclusions removed all bounded query candidates");
    // `web` is explicitly reported unsupported above; never relabel news RSS
    // results as general web research.
    const requestCount = queryPlan.length * ((useReddit ? 1 : 0) + (useNews ? 1 : 0) + (useCompetitor ? 1 : 0));
    // Competitor evidence is location-specific, so the locale is resolved once.
    const competitorLocale = useCompetitor && run.projectId
      ? await resolveDataForSeoLocale(run.projectId, language, country).catch(() => null)
      : null;
    const recencyDays = Math.max(1, Math.min(run.recencyDays, site.researchPolicy?.recencyDays ?? run.recencyDays, 730));
    const cached = run.projectId ? await Promise.all([
      ...(useReddit ? [reusableResearchSources({ projectId: run.projectId, provider: "reddit_rss", queries: queryPlan.map((item) => item.query), recencyDays, excludedDomains })] : []),
      ...(useNews ? [reusableResearchSources({ projectId: run.projectId, provider: "google_news_rss", queries: queryPlan.map((item) => item.query), recencyDays, excludedDomains })] : []),
    ]) : [];
    const reusable = cached.flat();
    const reusedQueries = new Set(reusable.map((source) => `${source.provider}:${String(source.metadata?.query ?? "").toLowerCase()}`));
    for (const source of reusable) addCollected(source);
    const heldClaims: Array<{ provider: string; query: string; owner: string }> = [];
    const dispatchClaimed = async (provider: string, topic: string, fetchSources: () => Promise<Awaited<ReturnType<typeof fetchRedditRssSearch>>>) => {
      if (!run.projectId || reusedQueries.has(`${provider}:${topic.toLowerCase()}`)) return null;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const owner = await claimResearchDispatch(run.projectId, provider, topic);
        if (owner) {
          const cachedAfterClaim = await reusableResearchSources({ projectId: run.projectId, provider, queries: [topic], recencyDays, excludedDomains });
          if (cachedAfterClaim.length) {
            await releaseResearchDispatch(run.projectId, provider, topic, owner);
            for (const source of cachedAfterClaim) addCollected(source);
            reusedQueries.add(`${provider}:${topic.toLowerCase()}`);
            return null;
          }
          heldClaims.push({ provider, query: topic, owner });
          return await fetchSources();
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        const found = await reusableResearchSources({ projectId: run.projectId, provider, queries: [topic], recencyDays, excludedDomains });
        if (found.length) {
          for (const source of found) addCollected(source);
          reusedQueries.add(`${provider}:${topic.toLowerCase()}`);
          return null;
        }
      }
      throw new Error("Timed out waiting for concurrent research dispatch");
    };
    let requestIndex = 0;

    for (const plan of queryPlan) {
      const topic = plan.query;
      if (useReddit && !reusedQueries.has(`reddit_rss:${topic.toLowerCase()}`)) {
        try {
          const sources = await dispatchClaimed("reddit_rss", topic, () => fetchRedditRssSearch({
            query: topic,
            sort: "relevance",
            timeWindow: "year",
            limit: 10,
          }));
          for (const source of sources ?? []) addCollected({ ...source,
            metadata: { ...source.metadata, query: topic, query_basis: plan.basis, retrieved_at: new Date().toISOString() } });
        } catch (error) {
          sourceErrors.push(`reddit: ${error instanceof Error ? error.message : "Reddit RSS failed"}`);
        }
        requestIndex += 1;
        if (requestIndex < requestCount) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (providers.includes("news") && !reusedQueries.has(`google_news_rss:${topic.toLowerCase()}`)) {
        try {
          const sources = await dispatchClaimed("google_news_rss", topic, () => fetchGoogleNewsRssSearch({
            query: topic,
            language,
            // The feed needs a `gl` edition; the provider owns that fallback.
            country: country ?? undefined,
            limit: 10,
          }));
          for (const source of sources ?? []) addCollected({ ...source,
            metadata: { ...source.metadata, query: topic, query_basis: plan.basis, retrieved_at: new Date().toISOString() } });
        } catch (error) {
          sourceErrors.push(`news: ${error instanceof Error ? error.message : "Google News RSS failed"}`);
        }
        requestIndex += 1;
        if (requestIndex < requestCount) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }

    // Competitor evidence is collected once for the whole query plan: Labs needs
    // several keywords to return anyone, and one call covers the run.
    if (useCompetitor) {
      if (!competitorLocale) {
        sourceErrors.push("competitor: DataForSEO locale could not be resolved; no competitor evidence was collected");
      } else {
        try {
          const sources = await fetchDataForSeoCompetitorSources({
            projectId: run.projectId!,
            // Only real topics/questions: the intent expansion is for source search,
            // not a keyword set to validate.
            queries: queryPlan
              .filter((plan) => plan.basis === "configured_topic" || plan.basis === "audience_question")
              .map((plan) => plan.query),
            domain: site.domain,
            languageCode: competitorLocale.languageCode,
            locationCode: competitorLocale.locationCode,
            // Paid calls keep their payload and cost for provenance.
            db: db as never,
          });
          for (const source of sources) addCollected(source);
        } catch (error) {
          sourceErrors.push(`competitor: ${error instanceof Error ? error.message : "DataForSEO competitor lookup failed"}`);
        }
      }
    }

    const maxSources = Math.max(1, Math.min(site.researchPolicy?.maxSources ?? 30, 100));
    const collectedSources = [...collected.values()];
    const qualityFiltered = collectedSources.filter((source) => !excludedUrl(source.url, excludedDomains));
    const policyRecency = site.researchPolicy?.recencyDays ?? run.recencyDays;
    const effectiveRecencyDays = Math.max(1, Math.min(run.recencyDays, policyRecency, 730));
    const recencyIssues = qualityFiltered.map((source) => sourceRecencyIssue(source.publishedAt, effectiveRecencyDays));
    const recencyRejections = { missing_date: 0, invalid_date: 0, future_date: 0, stale: 0 };
    for (const issue of recencyIssues) if (issue) recencyRejections[issue] += 1;
    const freshFiltered = qualityFiltered.filter((_, index) => recencyIssues[index] === null);
    // Competitor evidence is why the run asked DataForSEO: it must not be crowded
    // out of the source cap by social/news volume.
    const PROVIDER_PRIORITY: Record<string, number> = { dataforseo_labs: 0, dataforseo_serp: 1, google_news_rss: 2, reddit_rss: 3 };
    const prioritised = freshFiltered
      .map((source, index) => ({ source, index }))
      .sort((a, b) => (PROVIDER_PRIORITY[a.source.provider] ?? 9) - (PROVIDER_PRIORITY[b.source.provider] ?? 9) || a.index - b.index)
      .map((entry) => entry.source);
    const boundedSources = prioritised.slice(0, maxSources);
    if (process.env.RESEARCH_SOURCE_DEBUG === "1") {
      const count = (rows: typeof boundedSources) => rows.reduce((acc: Record<string, number>, row) => {
        acc[row.provider] = (acc[row.provider] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`[research] sources collected=${collectedSources.length} fresh=${freshFiltered.length} bounded=${boundedSources.length}`, JSON.stringify(count(boundedSources)), JSON.stringify(recencyRejections));
    }
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
    for (const claim of heldClaims) await releaseResearchDispatch(run.projectId!, claim.provider, claim.query, claim.owner);

    const existingFindings = await db.researchFinding.findMany({
      where: { runId: run.id },
      select: { id: true },
    });

    // A site that handed owner work to an external executor through a sibling
    // site for the same domain must not emit a second set of Actions.
    const supersededByExternalAuthority = await isSupersededByExternalAuthority(site.id);
    let synthesis: Awaited<ReturnType<typeof synthesizeResearch>> | null = null;
    const actionIds: string[] = [];
    if (existingFindings.length === 0 && savedSources.length > 0) {
      const latestCrawl = await db.crawl.findFirst({
        where: { siteId: site.id, status: "COMPLETED" },
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
        siteDomain: site.domain,
        title: run.title,
        topics: effectiveTopics,
        goals: stringList(site.researchPolicy?.goals),
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
        // The model often puts the search phrase on the action rather than the
        // finding; the action is linked by finding_index, so use it as a fallback.
        const actionQuery = synthesis.actions.find((action) => action.findingIndex === index)?.primaryQuery;
        const savedFinding = await createResearchFinding(
          run.id,
          { ...finding, primaryQuery: finding.primaryQuery ?? actionQuery },
          sourceIds
        );
        findingIdByIndex.set(index, savedFinding.id);
        sourceIdsByFindingIndex.set(index, sourceIds);
      }

      // Bridge the findings into funnel evidence so business research reaches
      // the opportunity board (the "why" leg). Additive: the legacy rows above
      // are untouched, so this is safe while the old pipeline still produces.
      if (run.projectId) {
        try {
          await bridgeFindingsToEvidence(db, { projectId: run.projectId, siteId: site.id, runId: run.id });
        } catch (error) {
          console.error("[research] finding evidence bridge failed", error);
        }
      }

      // Wave 6: the funnel is the single producer of work. Findings are bridged
      // into evidence above and the O13/O14 detectors turn winnable gaps into
      // opportunities, so the runner no longer writes legacy actions by default.
      // Set CRAWLSEO_LEGACY_ACTION_WRITES=on to restore the old behaviour.
      const legacyActionWrites = process.env.CRAWLSEO_LEGACY_ACTION_WRITES === "on";
      for (const action of legacyActionWrites && !supersededByExternalAuthority ? synthesis.actions : []) {
        const findingId = findingIdByIndex.get(action.findingIndex);
        const result = await createResearchAction(
          site.id,
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

    const reclassified = await reclassifyUnstableActionTargets(site.id, { runId: run.id });

    const policy = site.researchPolicy;
    const automation = policy && (policy.autoDraft || policy.autoAgent)
      ? await automateRunActions({
          runId: run.id,
          siteDomain: site.domain,
          autoDraft: policy.autoDraft,
          autoAgent: policy.autoAgent,
          connectorExecutor: site.connectorBinding
            ? site.connectorBinding.status === "ACTIVE" ? site.connectorBinding.executor : "inactive-connector"
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
