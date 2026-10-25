import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { fetchRedditRssSearch } from "@/lib/research/providers/reddit-rss";
import { fetchGoogleNewsRssSearch } from "@/lib/research/providers/google-news-rss";
import {
  createResearchAction,
  createResearchFinding,
  saveResearchSources,
  updateResearchAction,
} from "@/lib/research/service";
import { createAgentTaskForAction } from "@/lib/agent-tasks/service";
import { generateDraftForAction } from "@/lib/research/content";
import { autoAgentDecision } from "@/lib/research/automation";
import { synthesizeResearch } from "@/lib/research/synthesizer";
import { researchCountry } from "@/lib/research/locale";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

async function automateRunActions(input: {
  runId: string;
  siteDomain: string;
  autoDraft: boolean;
  autoAgent: boolean;
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
      siteDomain: input.siteDomain,
      hasOpenTask: action.agentTasks.length > 0,
    });
    if (!decision.eligible) {
      skipped.push({ actionId: action.id, reason: decision.reason });
      continue;
    }

    try {
      if (status === "PROPOSED") {
        await updateResearchAction(action.id, { status: "APPROVED" }, "research-automation");
        status = "APPROVED";
      }
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
          researchPolicy: { select: { autoDraft: true, autoAgent: true } },
        },
      },
      findings: { select: { id: true } },
    },
  });
  if (!run) throw new Error("Research run not found");
  if (run.status === "COMPLETED" || run.status === "PARTIAL") return run;

  await db.researchRun.update({
    where: { id: run.id },
    data: {
      status: "RUNNING",
      startedAt: run.startedAt ?? new Date(),
      errorCode: null,
      completedAt: null,
    },
  });

  try {
    const brief = run.brief as Record<string, unknown>;
    const topics = stringList(run.topics);
    const effectiveTopics = topics.length > 0 ? topics : stringList(brief.topics);
    if (effectiveTopics.length === 0) throw new Error("Research run has no topics");

    const providers = stringList(run.providerSet);
    const useReddit = providers.length === 0 || providers.includes("reddit");
    const useNews = providers.includes("news");
    if (!useReddit && !useNews) {
      throw new Error("No supported research provider is enabled");
    }

    const collected = new Map<string, Awaited<ReturnType<typeof fetchRedditRssSearch>>[number]>();
    const sourceErrors: string[] = [];
    const language = typeof brief.language === "string" ? brief.language : "en";
    const market = typeof brief.market === "string" ? brief.market : "";
    const country = researchCountry(market, language);
    const topicsForRun = effectiveTopics.slice(0, 5);
    const requestCount = topicsForRun.length * ((useReddit ? 1 : 0) + (useNews ? 1 : 0));
    let requestIndex = 0;

    for (const topic of topicsForRun) {
      if (useReddit) {
        try {
          const sources = await fetchRedditRssSearch({
            query: topic,
            sort: "relevance",
            timeWindow: "year",
            limit: 10,
          });
          for (const source of sources) collected.set(source.contentHash, source);
        } catch (error) {
          sourceErrors.push(`reddit: ${error instanceof Error ? error.message : "Reddit RSS failed"}`);
        }
        requestIndex += 1;
        if (requestIndex < requestCount) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (useNews) {
        try {
          const sources = await fetchGoogleNewsRssSearch({
            query: topic,
            language,
            country,
            limit: 10,
          });
          for (const source of sources) collected.set(source.contentHash, source);
        } catch (error) {
          sourceErrors.push(`news: ${error instanceof Error ? error.message : "Google News RSS failed"}`);
        }
        requestIndex += 1;
        if (requestIndex < requestCount) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }

    if (collected.size === 0) {
      throw new Error(sourceErrors[0] || "No research sources were collected");
    }

    const savedSources = await saveResearchSources(
      run.id,
      [...collected.values()].slice(0, 40).map((source) => ({
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

    let synthesis: Awaited<ReturnType<typeof synthesizeResearch>> | null = null;
    const actionIds: string[] = [];
    if (existingFindings.length === 0) {
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
        audience: typeof brief.audience === "string" ? brief.audience : null,
        market: typeof brief.market === "string" ? brief.market : null,
        questions: stringList(brief.questions),
        sources: savedSources,
        candidatePages,
      });

      const findingIdByModelIndex = new Map<number, string>();
      for (const finding of synthesis.findings) {
        const sourceIds = finding.sourceIndexes
          .map((sourceIndex) => savedSources[sourceIndex]?.id)
          .filter((id): id is string => Boolean(id));
        const savedFinding = await createResearchFinding(run.id, finding, sourceIds);
        findingIdByModelIndex.set(finding.modelIndex, savedFinding.id);
      }

      for (const action of synthesis.actions) {
        const findingId = findingIdByModelIndex.get(action.findingIndex);
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
              source_ids: savedSources.map((source) => source.id),
            },
          },
          run.requestedBy ?? "research-worker",
        );
        actionIds.push(result.action.id);
      }
    }

    const policy = run.site.researchPolicy;
    const automation = policy && (policy.autoDraft || policy.autoAgent)
      ? await automateRunActions({
          runId: run.id,
          siteDomain: run.site.domain,
          autoDraft: policy.autoDraft,
          autoAgent: policy.autoAgent,
        })
      : null;

    const status = sourceErrors.length > 0 ? "PARTIAL" : "COMPLETED";
    const report = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      providers: [
        ...(useReddit ? ["reddit_rss"] : []),
        ...(useNews ? ["google_news_rss"] : []),
      ],
      topics: effectiveTopics,
      source_count: savedSources.length,
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
