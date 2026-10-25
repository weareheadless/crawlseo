import { randomUUID } from "node:crypto";
import { IntegrationProvider, JobKind } from "@prisma/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  getLatestResearchReport,
  getResearchReport,
  getResearchReportStatus,
  listResearchReports,
  requestResearchReport,
} from "@/lib/dataforseo/research";
import {
  getArticleKeywordResearch,
  getArticleKeywordResearchStatus,
  listArticleKeywordResearch,
  requestArticleKeywordResearch,
  requestArticleSerpResearch,
} from "@/lib/dataforseo/article-research";
import {
  getMonthlySiteEvidence,
  prepareMonthlySiteEvidence,
} from "@/lib/reports/monthly-site-evidence";
import { getTopKeywords } from "@/lib/seo-metrics";
import { getLatestAnalyticsSummary } from "@/lib/workers/ga4-sync";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  requireProjectScope,
  type ServicePrincipalContext,
} from "@/lib/auth/service-credentials";
import { projectSite } from "@/lib/projects/project-site";

type ToolData = Record<string, unknown>;

function success(data: ToolData): {
  content: [{ type: "text"; text: string }];
  structuredContent: ToolData;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed";
  const safe = message.includes("scope") || message.includes("connected") || message.includes("DataForSEO")
    ? message
    : "CrawlSEO could not complete that request";
  return {
    content: [{ type: "text" as const, text: safe }],
    structuredContent: { error: safe },
    isError: true,
  };
}


export function createProjectMcpServer(principal: ServicePrincipalContext): McpServer {
  const server = new McpServer({ name: "CrawlSEO project data", version: "1.0.0" });
  const projectId = principal.projectId;

  server.registerTool(
    "seo_get_project",
    {
      description: "Get the authenticated project, site, and integration status.",
    },
    async () => {
      try {
        requireProjectScope(principal, "seo:read");
        const project = await db.project.findUnique({
          where: { id: projectId },
          select: {
            id: true,
            externalProjectId: true,
            name: true,
            status: true,
            workspace: { select: { id: true, status: true } },
            integrationGrants: {
              select: {
                provider: true,
                externalResourceId: true,
                status: true,
                safeErrorCode: true,
                lastSuccessfulAt: true,
              },
            },
            dataforseoGrants: {
              where: { provider: "dataforseo" },
              select: {
                status: true,
                lastValidatedAt: true,
                apiKeyId: true,
                providerCredentialId: true,
                providerCredential: { select: { status: true } },
              },
            },
          },
        });
        if (!project) throw new Error("Project not found");
        const site = await projectSite(projectId);
        const grants = Object.fromEntries(
          project.integrationGrants.map((grant) => [
            grant.provider === IntegrationProvider.GOOGLE_SEARCH_CONSOLE ? "gsc" : "ga4",
            {
              status: grant.status.toLowerCase(),
              property: grant.externalResourceId,
              safe_error_code: grant.safeErrorCode,
              last_successful_at: grant.lastSuccessfulAt?.toISOString() ?? null,
            },
          ])
        );
        const dataforseoGrant = project.dataforseoGrants[0];
        return success({
          project_id: project.id,
          external_project_id: project.externalProjectId,
          name: project.name,
          status: project.status.toLowerCase(),
          workspace_id: project.workspace.id,
          site: site ? { domain: site.domain, url: `https://${site.domain}/` } : null,
          connections: {
            gsc: grants.gsc ?? { status: "unverified", property: null },
            ga4: grants.ga4 ?? { status: "unverified", property: null },
            dataforseo: dataforseoGrant
              ? {
                  status: dataforseoGrant.status.toLowerCase(),
                  credential_source: dataforseoGrant.providerCredentialId
                    ? "platform"
                    : dataforseoGrant.apiKeyId
                      ? "user"
                      : "invalid",
                  credential_status:
                    dataforseoGrant.providerCredential?.status.toLowerCase() ?? null,
                  last_validated_at: dataforseoGrant.lastValidatedAt?.toISOString() ?? null,
                }
              : {
                  status: "unconfigured",
                  credential_source: null,
                  credential_status: null,
                  last_validated_at: null,
                },
          },
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_search_summary",
    {
      description: "Get the authenticated project's Search Console query summary.",
      inputSchema: {
        days: z.number().int().min(1).max(90).optional().default(28),
        query_limit: z.number().int().min(1).max(100).optional().default(10),
      },
    },
    async ({ days, query_limit }) => {
      try {
        requireProjectScope(principal, "seo:read");
        const site = await projectSite(projectId);
        const top = await getTopKeywords(site.id, days, query_limit);
        return success({
          period_days: days,
          top_queries: top.map((row) => ({
            query: row.query,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          })),
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_analytics_summary",
    {
      description: "Get the authenticated project's normalized GA4 weekly summary.",
    },
    async () => {
      try {
        requireProjectScope(principal, "analytics:read");
        const site = await projectSite(projectId);
        return success(await getLatestAnalyticsSummary(projectId, site.id));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_prepare_monthly_site_evidence",
    {
      description: "Queue or reuse closed-month GSC, GA4, and recent crawl evidence; never starts paid research.",
      inputSchema: {
        period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        idempotency_key: z.string().trim().min(1).max(240),
        max_crawl_pages: z.number().int().min(1).max(2000).optional().default(200),
      },
    },
    async ({ period, idempotency_key, max_crawl_pages }) => {
      try {
        requireProjectScope(principal, "seo:read");
        requireProjectScope(principal, "analytics:read");
        requireProjectScope(principal, "crawl:read");
        requireProjectScope(principal, "crawl:run");
        return success(await prepareMonthlySiteEvidence({
          projectId,
          period,
          idempotencyKey: idempotency_key,
          maxCrawlPages: max_crawl_pages,
        }));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_monthly_site_evidence",
    {
      description: "Read bounded closed-month GSC, GA4, and crawl evidence without queueing work or making paid calls.",
      inputSchema: { period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) },
    },
    async ({ period }) => {
      try {
        requireProjectScope(principal, "seo:read");
        requireProjectScope(principal, "analytics:read");
        requireProjectScope(principal, "crawl:read");
        return success(await getMonthlySiteEvidence(projectId, period));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_request_article_keyword_research",
    {
      description: "Reserve one bounded DataForSEO keyword overview task for Ada's 5-10 audience-led candidate queries.",
      inputSchema: {
        idea_key: z.string().trim().min(1).max(240),
        idea_summary: z.string().trim().min(1).max(2000),
        queries: z.array(z.string().trim().min(1).max(120)).min(5).max(10),
        language: z.string().trim().min(2).max(16),
        country: z.string().trim().length(2),
        idempotency_key: z.string().trim().min(1).max(240),
      },
    },
    async ({ idea_key, idea_summary, queries, language, country, idempotency_key }) => {
      try {
        requireProjectScope(principal, "seo:research:request");
        return success(await requestArticleKeywordResearch({
          projectId,
          ideaKey: idea_key,
          ideaSummary: idea_summary,
          queries,
          language,
          country,
          idempotencyKey: idempotency_key,
        }));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_request_article_serp_research",
    {
      description: "Reserve one bounded organic SERP snapshot for the query Ada selected after a completed keyword overview.",
      inputSchema: {
        parent_run_id: z.string().trim().min(1).max(120),
        keyword: z.string().trim().min(1).max(120),
        idempotency_key: z.string().trim().min(1).max(240),
      },
    },
    async ({ parent_run_id, keyword, idempotency_key }) => {
      try {
        requireProjectScope(principal, "seo:research:request");
        return success(await requestArticleSerpResearch({
          projectId,
          parentRunId: parent_run_id,
          keyword,
          idempotencyKey: idempotency_key,
        }));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_article_keyword_research_status",
    {
      description: "Read the status and receipt metadata for one article keyword research run.",
      inputSchema: { run_id: z.string().trim().min(1).max(120) },
    },
    async ({ run_id }) => {
      try {
        requireProjectScope(principal, "seo:read");
        return success(await getArticleKeywordResearchStatus(projectId, run_id));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_article_keyword_research",
    {
      description: "Read one bounded normalized article keyword-overview or SERP result and its provider receipt.",
      inputSchema: { run_id: z.string().trim().min(1).max(120) },
    },
    async ({ run_id }) => {
      try {
        requireProjectScope(principal, "seo:read");
        return success(await getArticleKeywordResearch(projectId, run_id));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_list_article_keyword_research",
    {
      description: "List bounded historical article keyword research runs for report and editorial reuse.",
      inputSchema: {
        period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
        limit: z.number().int().min(1).max(50).optional().default(20),
      },
    },
    async ({ period, limit }) => {
      try {
        requireProjectScope(principal, "seo:read");
        return success(await listArticleKeywordResearch(projectId, period, limit));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_request_research_report",
    {
      description: "Request Ada's fixed monthly SEO research batch; competitor research is optional when no in-category domain can be verified.",
      inputSchema: {
        period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        focus_language: z.string().trim().min(2).max(16),
        focus_country: z.string().trim().length(2),
        business_goal: z.string().trim().min(1).max(1000),
        audience: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
        priority_services: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
        keyword_seeds: z.array(z.string().trim().min(1).max(120)).length(5),
        competitor: z.string().trim().max(253).nullable().optional(),
        research_questions: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
        market_rationale: z.string().trim().min(1).max(1000),
        seed_rationales: z.array(z.string().trim().min(1).max(500)).length(5),
        competitor_rationale: z.string().trim().min(1).max(1000).optional(),
        idempotency_key: z.string().trim().min(1).max(240),
      },
    },
    async ({
      period,
      focus_language,
      focus_country,
      business_goal,
      audience,
      priority_services,
      keyword_seeds,
      competitor,
      research_questions,
      market_rationale,
      seed_rationales,
      competitor_rationale,
      idempotency_key,
    }) => {
      try {
        requireProjectScope(principal, "seo:research:request");
        const result = await requestResearchReport({
          projectId,
          idempotencyKey: idempotency_key,
          brief: {
            period,
            focus_market: { language: focus_language, country: focus_country },
            business_goal,
            audience,
            priority_services,
            keyword_seeds,
            competitor,
            research_questions,
            selection_rationale: {
              market: market_rationale,
              seeds: seed_rationales,
               competitor: competitor_rationale || "No reliable in-category competitor was available; competitor research was skipped.",
            },
            package: "standard-v1",
          },
        });
        return success(result);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_research_report_status",
    {
      description: "Get the status of an Ada-requested SEO research report without starting paid work.",
      inputSchema: { report_id: z.string().trim().min(1).max(120) },
    },
    async ({ report_id }) => {
      try {
        requireProjectScope(principal, "seo:read");
        return success(await getResearchReportStatus(projectId, report_id));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_research_report",
    {
      description: "Read an immutable completed or partial SEO research report.",
      inputSchema: { report_id: z.string().trim().min(1).max(120) },
    },
    async ({ report_id }) => {
      try {
        requireProjectScope(principal, "seo:read");
        return success(await getResearchReport(projectId, report_id));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_latest_research_report",
    {
      description: "Read the latest completed or partial SEO research report.",
    },
    async () => {
      try {
        requireProjectScope(principal, "seo:read");
        return success(await getLatestResearchReport(projectId));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_list_research_reports",
    {
      description: "List historical SEO research report metadata.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().default(12) },
    },
    async ({ limit }) => {
      try {
        requireProjectScope(principal, "seo:read");
        return success(await listResearchReports(projectId, limit));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_dataforseo_domain_report",
    {
      description: "Read the project's latest persisted DataForSEO domain overview report.",
    },
    async () => {
      try {
        requireProjectScope(principal, "seo:read");
        const site = await projectSite(projectId);
        const latest = await getLatestResearchReport(projectId);
        const report = latest.report as Record<string, unknown> | null;
        const tasks = report && Array.isArray(report.dataforseo) ? report.dataforseo : [];
        const task = tasks.find((candidate) => {
          if (!candidate || typeof candidate !== "object") return false;
          const entry = candidate as Record<string, unknown>;
          const input = entry.input;
          return entry.kind === "domain_overview" && input && typeof input === "object" &&
            (input as Record<string, unknown>).domain === site.domain;
        }) as Record<string, unknown> | undefined;

        return success({
          source: "dataforseo",
          connection: task?.status === "completed" ? "cached" : "unavailable",
          domain: site.domain,
          research_report_id: latest.report_id ?? null,
          report: task?.result ?? null,
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_dataforseo_keyword_report",
    {
      description: "Read persisted DataForSEO keyword ideas for a search seed.",
      inputSchema: {
        seed: z.string().trim().min(1).max(120).optional().default("seo"),
      },
    },
    async ({ seed }) => {
      try {
        requireProjectScope(principal, "seo:read");
        const site = await projectSite(projectId);
        const latest = await getLatestResearchReport(projectId);
        const report = latest.report as Record<string, unknown> | null;
        const tasks = report && Array.isArray(report.dataforseo) ? report.dataforseo : [];
        const normalizedSeed = seed.toLocaleLowerCase().replace(/\s+/g, " ").trim();
        const task = tasks.find((candidate) => {
          if (!candidate || typeof candidate !== "object") return false;
          const entry = candidate as Record<string, unknown>;
          const input = entry.input;
          return entry.kind === "keyword_seed" && input && typeof input === "object" &&
            (input as Record<string, unknown>).seed &&
            String((input as Record<string, unknown>).seed).toLocaleLowerCase().replace(/\s+/g, " ").trim() === normalizedSeed;
        }) as Record<string, unknown> | undefined;
        const keywords = Array.isArray(task?.result) ? task.result : [];

        return success({
          source: "dataforseo",
          connection: task?.status === "completed" ? "cached" : "unavailable",
          domain: site.domain,
          seed,
          research_report_id: latest.report_id ?? null,
          report: {
            keyword_count: keywords.length,
            keywords,
          },
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_crawl_summary",
    {
      description: "Get the latest project-owned technical crawl summary.",
    },
    async () => {
      try {
        requireProjectScope(principal, "crawl:read");
        const site = await projectSite(projectId);
        const crawl = await db.crawl.findFirst({
          where: { siteId: site.id },
          orderBy: { startedAt: "desc" },
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
        return success({
          crawl_id: crawl?.id ?? null,
          status: crawl?.status?.toLowerCase() ?? "none",
          health_score: crawl?.healthScore ?? null,
          page_count: crawl?.pagesFound ?? 0,
          issue_count: crawl?.issuesFound ?? 0,
          finished_at: crawl?.finishedAt?.toISOString() ?? null,
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_get_crawl_issues",
    {
      description: "List issues from the latest project-owned crawl.",
      inputSchema: {
        severity: z.enum(["CRITICAL", "WARNING", "INFO"]).optional(),
        limit: z.number().int().min(1).max(200).optional().default(50),
      },
    },
    async ({ severity, limit }) => {
      try {
        requireProjectScope(principal, "crawl:read");
        const site = await projectSite(projectId);
        const crawl = await db.crawl.findFirst({
          where: { siteId: site.id },
          orderBy: { startedAt: "desc" },
          select: { id: true },
        });
        if (!crawl) return success({ crawl_id: null, issues: [] });
        const issues = await db.crawlIssue.findMany({
          where: { crawlId: crawl.id, ...(severity ? { severity } : {}) },
          take: limit,
          orderBy: [{ severity: "asc" }, { type: "asc" }],
          select: { severity: true, type: true, url: true, message: true },
        });
        return success({
          crawl_id: crawl.id,
          issues: issues.map((issue) => ({
            severity: issue.severity,
            type: issue.type,
            url: issue.url,
            message: issue.message,
          })),
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "seo_run_crawl",
    {
      description: "Queue a technical crawl for the authenticated project.",
      inputSchema: {
        max_pages: z.number().int().min(1).max(2000).optional().default(200),
        idempotency_key: z.string().min(1).max(240),
      },
    },
    async ({ max_pages, idempotency_key }) => {
      try {
        requireProjectScope(principal, "crawl:run");
        const site = await projectSite(projectId);
        const job = await enqueueJob({
          projectId,
          siteId: site.id,
          kind: JobKind.CRAWL,
          payload: { maxPages: max_pages },
          idempotencyKey: idempotency_key || `mcp:${randomUUID()}`,
        });
        return success({ job_id: job.id, status: job.status.toLowerCase(), site_id: site.id });
      } catch (error) {
        return failure(error);
      }
    }
  );

  return server;
}
