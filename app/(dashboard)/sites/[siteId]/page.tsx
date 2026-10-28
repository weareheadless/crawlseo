import Link from "next/link";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { DashboardMetrics } from "@/components/dashboard/metrics";
import { TrafficChart } from "@/components/dashboard/traffic-chart";
import { TopKeywords } from "@/components/dashboard/top-keywords";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { SyncButton } from "@/components/sites/sync-button";
import { DataLagBadge } from "@/components/ui/data-lag-badge";
import {
  CrawlButton,
  VitalsButton,
} from "@/components/sites/action-buttons";
import { CsvExportButton } from "@/components/ui/csv-export-button";
import { getAllOpportunities } from "@/lib/seo-opportunities";
import { TimeframeSelect } from "@/components/sites/timeframe-select";
import { parseSeoTimeframe } from "@/lib/seo-timeframes";
import { readPipelineOverview } from "@/lib/pipeline/overview";
import { PipelineNavigation } from "@/components/pipeline/pipeline-navigation";

interface SitePageProps {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ days?: string }>;
}

export default async function SiteOverviewPage({ params, searchParams }: SitePageProps) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  const days = parseSeoTimeframe((await searchParams).days);
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: {
      userId: true,
      domain: true,
      gscProperty: true,
      _count: { select: { keywords: true } },
    },
  });

  if (!site) {
    redirect("/sites");
  }

  const latestCrawl = await db.crawl.findFirst({
    where: { siteId, status: "COMPLETED" },
    orderBy: { finishedAt: "desc" },
    select: { healthScore: true, issuesFound: true, pagesFound: true, finishedAt: true },
  });

  const latestVital = await db.vitalsReport.findFirst({
    where: { siteId },
    orderBy: { date: "desc" },
    select: { perfScore: true, lcp: true, url: true },
  });
  const pipeline = await readPipelineOverview(siteId);

  const opportunities =
    site._count.keywords > 0
      ? await getAllOpportunities(siteId)
      : null;

  return (
    <div>
      <PageHeader
        eyebrow="Site"
        title={site.domain}
        description={site.gscProperty || "Search Console property"}
        actions={
          <div className="flex flex-wrap items-start gap-2">
            <DataLagBadge />
            <TimeframeSelect value={days} />
            <SyncButton siteId={siteId} days={days} />
            <CrawlButton siteId={siteId} />
            <VitalsButton siteId={siteId} />
          </div>
        }
      />

      <div className="mb-6 space-y-4">
        <PipelineNavigation siteId={siteId} />
        <section aria-labelledby="overview-decisions" className="panel p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="overview-decisions" className="font-heading text-lg font-semibold">Site overview · decisions and active work</h2>
            <span className="text-xs text-muted-foreground">Activity window: last {pipeline.windowDays} days</span>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div><h3 className="text-sm font-semibold">What do we know?</h3>
              <p className="mt-2 text-sm">
                {pipeline.business
                  ? `Canonical knowledge revision ${pipeline.business.revision}${pipeline.business.acceptedRevision == null ? " (not accepted)" : ` · accepted ${pipeline.business.acceptedRevision}`}`
                  : "No canonical business knowledge is recorded yet."}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {pipeline.profile
                  ? `Operational context: ${pipeline.profile.topicCount} topic${pipeline.profile.topicCount === 1 ? "" : "s"}${pipeline.profile.hasAudience ? ", audience set" : ", audience not recorded"}`
                  : "No operational business context is recorded."}
              </p>
            </div>
            <div><h3 className="text-sm font-semibold">What improved?</h3>
              {pipeline.measured.length ? <ul className="mt-2 space-y-2">{pipeline.measured.map((item) => <li key={item.id} className="text-sm"><Link className="text-primary underline" href={`/sites/${siteId}/actions/${item.id}`}>{item.title}</Link> · measurement recorded {item.measuredAt?.toLocaleDateString()} (not attributed)</li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">No measured outcome is linked to work yet.</p>}
            </div>
            <div><h3 className="text-sm font-semibold">What is running?</h3>
              {pipeline.runs.length ? <ul className="mt-2 space-y-2">{pipeline.runs.map((run) => <li key={run.id} className="text-sm"><Link className="text-primary underline" href={`/sites/${siteId}/research/runs/${run.id}`}>{run.title}</Link> · {run.status.toLowerCase()} · {run.createdAt.toLocaleDateString()}</li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">No research run currently queued or running.</p>}
              {pipeline.runsTruncated && <p className="mt-2 text-xs text-muted-foreground">Showing first 20; list truncated.</p>}
            </div>
            <div><h3 className="text-sm font-semibold">What needs a decision?</h3>
              {pipeline.actions.length ? <ul className="mt-2 space-y-2">{pipeline.actions.map((action) => <li key={action.id} className="text-sm"><Link className="text-primary underline" href={`/sites/${siteId}/actions/${action.id}`}>{action.title}</Link> · {action.preparationStatus === "BLOCKED" ? "blocked input" : ["DRAFT_READY", "DELIVERY_APPROVED", "APPROVED"].includes(action.status) ? "needs review / decision" : action.status.toLowerCase()} · updated {action.updatedAt.toLocaleDateString()}</li>)}</ul> : <p className="mt-2 text-sm text-muted-foreground">No recently active work in the decision queue; this does not mean no work is needed.</p>}
              {pipeline.actionsTruncated && <p className="mt-2 text-xs text-muted-foreground">Showing first 20; list truncated.</p>}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <Link className="text-primary underline" href={`/sites/${siteId}/business`}>Review business context</Link>
            <Link className="text-primary underline" href={`/sites/${siteId}/research`}>Review research</Link>
            <Link className="text-primary underline" href={`/sites/${siteId}/work`}>Open Work</Link>
            <Link className="text-primary underline" href={`/sites/${siteId}/results`}>Review Results</Link>
          </div>
        </section>
      </div>

      {site._count.keywords === 0 ? (
        <EmptyState
          icon="↻"
          title="Waiting for GSC data"
          description="Run a sync to pull keywords, pages, and traffic for the last 28 days."
        />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="panel p-4">
              <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Crawl health
              </p>
              <p className="mt-1 font-heading text-2xl font-semibold text-foreground">
                {latestCrawl?.healthScore != null ? `${latestCrawl.healthScore}/100` : "—"}
              </p>
              <p className="text-xs text-muted-foreground">
                {latestCrawl
                  ? `${latestCrawl.pagesFound} pages · ${latestCrawl.issuesFound} issues`
                  : "Run a crawl"}
              </p>
            </div>
            <div className="panel p-4">
              <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Opportunities
              </p>
              <p className="mt-1 font-heading text-2xl font-semibold text-signal">
                {opportunities?.feed.length ?? 0}
              </p>
              <p className="text-xs text-muted-foreground">action items this period</p>
            </div>
            <div className="panel p-4">
              <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Latest perf score
              </p>
              <p className="mt-1 font-heading text-2xl font-semibold text-foreground">
                {latestVital?.perfScore ?? "—"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {latestVital?.url || "Check vitals"}
              </p>
            </div>
          </div>

          <DashboardMetrics siteId={siteId} days={days} />
          <TrafficChart siteId={siteId} days={days} />
          <TopKeywords siteId={siteId} days={days} />

          <div className="flex flex-wrap gap-2">
            <CsvExportButton siteId={siteId} type="keywords" />
            <CsvExportButton siteId={siteId} type="pages" />
          </div>
        </div>
      )}
    </div>
  );
}
