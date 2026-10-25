import Link from "next/link";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { getSitePeriodMetrics, formatCompact } from "@/lib/seo-metrics";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { AddSiteModal } from "@/components/sites/add-site-modal";
import { OnboardingChecklist } from "@/components/dashboard/onboarding-checklist";
import { DataLagBadge } from "@/components/ui/data-lag-badge";
import { formatDeltaPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getSupersededSiteIds } from "@/lib/research/execution-authority";
import { TimeframeSelect } from "@/components/sites/timeframe-select";
import { parseSeoTimeframe } from "@/lib/seo-timeframes";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string; days?: string }>;
}) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  const query = await searchParams;
  const showAll = query.all === "1";
  const days = parseSeoTimeframe(query.days);

  // Single-operator CrawlSEO: show all sites regardless of provisioning path.
  const [queriedSites, superseded] = await Promise.all([
    db.site.findMany({
      select: {
        id: true,
        domain: true,
        gscProperty: true,
        _count: { select: { keywords: true, pages: true, crawls: true } },
      },
      orderBy: { domain: "asc" },
    }),
    getSupersededSiteIds(),
  ]);
  const allSites = queriedSites.filter((site) => !superseded.has(site.id));
  const sites = showAll
    ? allSites
    : allSites.filter((site) =>
        site._count.keywords > 0 || site._count.pages > 0 || site._count.crawls > 0,
      );

  // Onboarding state
  const hasSites = sites.length > 0;
  const hasGscConnected = sites.some((s) => s.gscProperty);
  const hasSyncedData = sites.some((s) => s._count.keywords > 0);
  const hasCrawled = sites.some((s) => s._count.crawls > 0);
  const firstSiteId = sites[0]?.id;

  if (sites.length === 0) {
    return (
      <div>
        <PageHeader
          eyebrow="Workspace"
          title="Welcome to CrawlSEO"
          description="Connect Google Search Console properties to track rankings, traffic, and opportunity."
          actions={<AddSiteModal triggerLabel="Connect first site" />}
        />
        <OnboardingChecklist
          hasSites={false}
          hasGscConnected={false}
          hasSyncedData={false}
          hasCrawled={false}
        />
        <EmptyState
          icon="↗"
          title="No sites connected"
          description="Import a GSC property to start monitoring organic search performance. Read-only access only."
          actionLabel="Add site"
          actionHref="/sites"
        />
      </div>
    );
  }

  const siteCards = await Promise.all(
    sites.map(async (site) => {
      if (site._count.keywords === 0) {
        return {
          site,
          metrics: null as Awaited<ReturnType<typeof getSitePeriodMetrics>> | null,
        };
      }
      try {
        const metrics = await getSitePeriodMetrics(site.id, days);
        return { site, metrics };
      } catch {
        return { site, metrics: null };
      }
    })
  );

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Portfolio overview"
        description={showAll
          ? `${allSites.length} sites including empty records · last ${days} days vs prior period`
          : `${sites.length} of ${allSites.length} sites with data · last ${days} days vs prior period`}
        actions={
          <div className="flex items-center gap-3">
            <DataLagBadge />
            <TimeframeSelect value={days} />
            <Link
              href={showAll ? "/dashboard" : "/dashboard?all=1"}
              className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              {showAll ? "Only with data" : `Show all ${allSites.length}`}
            </Link>
            <AddSiteModal />
          </div>
        }
      />

      {/* Onboarding checklist */}
      <OnboardingChecklist
        hasSites={hasSites}
        hasGscConnected={hasGscConnected}
        hasSyncedData={hasSyncedData}
        hasCrawled={hasCrawled}
        firstSiteId={firstSiteId}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {siteCards.map(({ site, metrics }) => (
          <Link
            key={site.id}
            href={`/sites/${site.id}`}
            className="panel group relative block overflow-hidden p-5 transition hover:border-signal/40"
          >
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-signal/30 to-transparent opacity-0 transition group-hover:opacity-100" />
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate font-heading text-lg font-semibold text-foreground">
                  {site.domain}
                </h2>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {site.gscProperty}
                </p>
              </div>
              <span className="text-signal opacity-0 transition group-hover:opacity-100">
                →
              </span>
            </div>

            {!metrics ? (
              <div className="mt-6 rounded-lg border border-dashed border-border/70 bg-muted/20 px-3 py-4 text-sm text-muted-foreground">
                Waiting for first GSC sync…
              </div>
            ) : (
              <div className="mt-5 grid grid-cols-2 gap-3">
                <Stat
                  label="Clicks"
                  value={formatCompact(metrics.current.clicks)}
                  delta={formatDeltaPercent(metrics.deltas.clicks)}
                  positive={metrics.deltas.clicks >= 0}
                />
                <Stat
                  label="Impressions"
                  value={formatCompact(metrics.current.impressions)}
                  delta={formatDeltaPercent(metrics.deltas.impressions)}
                  positive={metrics.deltas.impressions >= 0}
                />
                <Stat
                  label="Avg pos"
                  value={
                    metrics.current.avgPosition > 0
                      ? metrics.current.avgPosition.toFixed(1)
                      : "—"
                  }
                  delta={
                    metrics.deltas.avgPosition === 0
                      ? "0"
                      : `${metrics.deltas.avgPosition > 0 ? "+" : ""}${metrics.deltas.avgPosition.toFixed(1)}`
                  }
                  positive={metrics.deltas.avgPosition >= 0}
                />
                <Stat
                  label="Keywords"
                  value={metrics.current.uniqueKeywords.toLocaleString()}
                />
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  delta,
  positive,
}: {
  label: string;
  value: string;
  delta?: string;
  positive?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-panel/80 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <p className="font-data text-base font-semibold text-foreground">{value}</p>
        {delta !== undefined && (
          <span
            className={cn(
              "font-data text-[11px] font-medium",
              positive ? "text-signal" : "text-danger"
            )}
          >
            {delta}
          </span>
        )}
      </div>
    </div>
  );
}
