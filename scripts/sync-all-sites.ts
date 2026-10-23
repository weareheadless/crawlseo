import { loadEnvConfig } from "@next/env";
import { IntegrationProvider, IntegrationGrantStatus, JobKind } from "@prisma/client";
import { db } from "@/lib/db";
import { enqueueJob } from "@/lib/jobs/queue";

loadEnvConfig(process.cwd());

const dryRun = process.argv.includes("--dry-run");
const runDate = process.argv
  .find((arg) => arg.startsWith("--date="))
  ?.slice("--date=".length) || new Date().toISOString().slice(0, 10);

type Source = "gsc" | "ga4" | "crawl" | "vitals";
type Outcome = {
  domain: string;
  siteId: string;
  source: Source;
  result: "queued" | "skipped";
  reason?: string;
  jobId?: string;
};

function hasActiveGrant(
  grants: Array<{ provider: IntegrationProvider; siteId: string | null }>,
  provider: IntegrationProvider,
  siteId: string,
): boolean {
  return grants.some(
    (grant) =>
      grant.provider === provider &&
      (grant.siteId === null || grant.siteId === siteId),
  );
}

async function main() {
  const sites = await db.site.findMany({
    select: {
      id: true,
      domain: true,
      projectId: true,
      userId: true,
      gscProperty: true,
      _count: { select: { keywords: true, pages: true, crawls: true } },
      user: { select: { googleTokens: true } },
      crawls: {
        orderBy: { startedAt: "desc" },
        take: 1,
        select: { status: true, finishedAt: true },
      },
      vitals: {
        orderBy: { date: "desc" },
        take: 1,
        select: { date: true },
      },
      project: {
        select: {
          integrationGrants: {
            where: { status: IntegrationGrantStatus.ACTIVE },
            select: { provider: true, siteId: true },
          },
        },
      },
    },
    orderBy: { domain: "asc" },
  });

  const outcomes: Outcome[] = [];

  for (const site of sites) {
    const projectGrants = site.project?.integrationGrants ?? [];
    const projectGsc = hasActiveGrant(
      projectGrants,
      IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
      site.id,
    );
    const projectGa4 = hasActiveGrant(
      projectGrants,
      IntegrationProvider.GOOGLE_ANALYTICS,
      site.id,
    );
    const userGsc = !site.projectId
      && Boolean(site.userId)
      && Boolean(site.gscProperty)
      && Boolean(site.user?.googleTokens);

    const sources: Array<{ source: Source; projectId?: string; userId?: string }> = [];
    if (site.projectId && projectGsc) {
      sources.push({ source: "gsc", projectId: site.projectId });
    } else if (userGsc) {
      sources.push({ source: "gsc", userId: site.userId! });
    }
    if (site.projectId && projectGa4) {
      sources.push({ source: "ga4", projectId: site.projectId });
    }

    const hasSiteData = site._count.keywords > 0 || site._count.pages > 0 || site._count.crawls > 0;
    const latestCrawl = site.crawls[0];
    const crawlActive = latestCrawl?.status === "PENDING" || latestCrawl?.status === "RUNNING";
    const crawlAgeMs = latestCrawl?.status === "COMPLETED" && latestCrawl.finishedAt
      ? Date.now() - latestCrawl.finishedAt.getTime()
      : Number.POSITIVE_INFINITY;
    if (
      hasSiteData
      && !crawlActive
      && crawlAgeMs > 7 * 24 * 60 * 60 * 1000
    ) {
      sources.push({ source: "crawl" });
    }

    const vitalsAgeMs = site.vitals[0]?.date
      ? Date.now() - site.vitals[0].date.getTime()
      : Number.POSITIVE_INFINITY;
    if (
      hasSiteData
      && process.env.GOOGLE_PAGESPEED_KEY
      && vitalsAgeMs > 7 * 24 * 60 * 60 * 1000
    ) {
      if (site.projectId) {
        sources.push({ source: "vitals", projectId: site.projectId });
      } else if (site.userId) {
        sources.push({ source: "vitals", userId: site.userId });
      }
    }

    if (sources.length === 0) {
      outcomes.push({
        domain: site.domain,
        siteId: site.id,
        source: "gsc",
        result: "skipped",
        reason: !process.env.GOOGLE_PAGESPEED_KEY && vitalsAgeMs > 7 * 24 * 60 * 60 * 1000
          ? "no PageSpeed key and no fresh vitals"
          : site.projectId
            ? "no active GSC/GA4 grant"
            : !site.userId
              ? "no owner and no active project grant"
              : !site.gscProperty
                ? "no GSC property"
                : !site.user?.googleTokens
                  ? "no Google OAuth token"
                  : "no supported source",
      });
      continue;
    }

    for (const source of sources) {
      const key = `scheduled:${source.source}:${site.id}:${runDate}`;
      if (dryRun) {
        outcomes.push({
          domain: site.domain,
          siteId: site.id,
          source: source.source,
          result: "queued",
          reason: "dry-run",
        });
        continue;
      }
      try {
        const job = await enqueueJob({
          projectId: source.projectId ?? null,
          siteId: site.id,
          kind:
            source.source === "gsc"
              ? JobKind.GSC_SYNC
              : source.source === "ga4"
                ? JobKind.GA4_SYNC
                : source.source === "crawl"
                  ? JobKind.CRAWL
                  : JobKind.VITALS_SYNC,
          payload:
            source.source === "crawl"
              ? { maxPages: 200 }
              : source.source === "vitals"
                ? { ...(source.userId ? { userId: source.userId } : {}), limit: 5 }
                : source.userId
                  ? { userId: source.userId, daysBack: 28 }
                  : source.source === "gsc"
                    ? { daysBack: 28 }
                    : {},
          idempotencyKey: key,
          maxAttempts: 2,
        });
        outcomes.push({
          domain: site.domain,
          siteId: site.id,
          source: source.source,
          result: "queued",
          jobId: job.id,
        });
      } catch (error) {
        outcomes.push({
          domain: site.domain,
          siteId: site.id,
          source: source.source,
          result: "skipped",
          reason: error instanceof Error ? error.message : "enqueue failed",
        });
      }
    }
  }

  console.log(JSON.stringify({ dryRun, runDate, outcomes }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
