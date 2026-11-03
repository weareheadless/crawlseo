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
import { getFunnelOverview } from "@/lib/funnel/views";

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
      projectId: true,
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

  const opportunities =
    site._count.keywords > 0
      ? await getAllOpportunities(siteId)
      : null;
  const funnel = site.projectId ? await getFunnelOverview(db, site.projectId) : null;

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

      {/* The funnel, in order. Each stage links to its surface. */}
      <ol className="mb-6 grid grid-cols-1 gap-2 sm:grid-cols-5">
        {[
          { label: "Demand map", value: funnel ? `${funnel.clusters} clusters` : "no project", href: `/sites/${siteId}/demand` },
          { label: "Opportunities", value: funnel ? `${funnel.counts.detected} detected` : "—", href: `/sites/${siteId}/opportunities` },
          { label: "Work", value: funnel ? `${funnel.counts.accepted + funnel.counts.inProgress} accepted` : "—", href: `/sites/${siteId}/work` },
          { label: "Delivery", value: funnel ? `${funnel.counts.closed} closed` : "—", href: `/sites/${siteId}/work` },
          { label: "Evidence", value: funnel ? `${funnel.evidenceTotal} records` : "—", href: `/sites/${siteId}/evidence` },
        ].map((stage, index) => (
          <li key={stage.label}>
            <Link
              href={stage.href}
              className="panel block px-3 py-2 transition hover:border-primary/40"
            >
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {index + 1} · {stage.label}
              </p>
              <p className="mt-0.5 text-xs text-foreground">{stage.value}</p>
            </Link>
          </li>
        ))}
      </ol>

      {/* The funnel decides; legacy decision panels are gone from this page. */}
      {funnel && (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <section className="panel p-4 sm:p-5" aria-labelledby="overview-next">
            <div className="flex items-baseline justify-between gap-2">
              <h2 id="overview-next" className="font-heading text-lg font-semibold">What to play next</h2>
              <Link className="text-xs text-primary hover:underline" href={`/sites/${siteId}/opportunities`}>
                All opportunities →
              </Link>
            </div>
            {funnel.topOpportunities.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Nothing detected yet. Refresh from stored evidence on the Opportunities board to detect work.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {funnel.topOpportunities.map((row) => (
                  <li key={row.id}>
                    <Link
                      href={`/sites/${siteId}/opportunities/${row.id}`}
                      className="block rounded-lg border border-border px-3 py-2 transition hover:border-primary/40"
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.title}</span>
                        <span className="font-mono text-xs text-muted-foreground">{row.score ?? "—"}</span>
                      </div>
                      {row.reason && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.reason}</p>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel p-4 sm:p-5" aria-labelledby="overview-running">
            <div className="flex items-baseline justify-between gap-2">
              <h2 id="overview-running" className="font-heading text-lg font-semibold">In flight</h2>
              <Link className="text-xs text-primary hover:underline" href={`/sites/${siteId}/work`}>
                Open Work →
              </Link>
            </div>
            {funnel.tasks.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No task yet. Accepting an opportunity is the only way work enters the queue.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {funnel.tasks.map((task) => (
                  <li key={task.id}>
                    <Link
                      href={`/sites/${siteId}/opportunities/${task.opportunityId}`}
                      className="block rounded-lg border border-border px-3 py-2 transition hover:border-primary/40"
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{task.title}</span>
                        <span className="text-[11px] text-muted-foreground">{task.status.replaceAll("_", " ")}</span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        executor {task.assignedTo}
                        {task.agentPreparedById ? " · prepared by agent" : ""}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {funnel.recentVerdicts.length > 0 && (
              <p className="mt-3 text-[11px] text-muted-foreground">
                Outcomes: {funnel.recentVerdicts.map((v) => `${v.count} ${v.verdict.replaceAll("_", " ")}`).join(" · ")}
              </p>
            )}
          </section>
        </div>
      )}

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
                Open opportunities
              </p>
              <p className="mt-1 font-heading text-2xl font-semibold text-signal">
                {funnel ? funnel.counts.detected + funnel.counts.accepted + funnel.counts.inProgress : "—"}
              </p>
              <p className="text-xs text-muted-foreground">detected and not yet closed</p>
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
