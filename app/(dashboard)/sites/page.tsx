import Link from "next/link";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { AddSiteModal } from "@/components/sites/add-site-modal";
import { SyncButton } from "@/components/sites/sync-button";
import { formatCompact } from "@/lib/seo-metrics";

export default async function SitesPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const userId = await getUserIdFromCookies();
  if (!userId) redirect("/login");
  const showAll = (await searchParams).all === "1";

  // Single-operator CrawlSEO: show all sites regardless of provisioning path.
  const allSites = await db.site.findMany({
    select: {
      id: true,
      domain: true,
      gscProperty: true,
      createdAt: true,
      _count: {
        select: {
          keywords: true,
          pages: true,
          crawls: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const sites = showAll
    ? allSites
    : allSites.filter((site) =>
        site._count.keywords > 0 || site._count.pages > 0 || site._count.crawls > 0,
      );

  return (
    <div>
      <PageHeader
        eyebrow="Properties"
        title="Sites"
        description={showAll
          ? `${allSites.length} sites including empty records`
          : `${sites.length} of ${allSites.length} sites with data`}
        actions={
          <div className="flex items-center gap-2">
            <Link
              href={showAll ? "/sites" : "/sites?all=1"}
              className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              {showAll ? "Only with data" : `Show all ${allSites.length}`}
            </Link>
            <AddSiteModal />
          </div>
        }
      />

      {sites.length === 0 ? (
        <EmptyState
          icon="⊕"
          title="Connect your first property"
          description="Choose a domain or URL-prefix property from Search Console. CrawlSEO stores your metrics locally."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sites.map((site) => (
            <div key={site.id} className="panel flex h-full flex-col p-5">
              <Link href={`/sites/${site.id}`} className="group block min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate font-heading text-lg font-semibold text-foreground group-hover:text-signal">
                      {site.domain}
                    </h2>
                    <p className="mt-1 truncate font-data text-xs text-muted-foreground">
                      {site.gscProperty}
                    </p>
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-3 gap-2 border-t border-border/50 pt-4">
                  <MiniStat
                    label="Keyword rows"
                    value={formatCompact(site._count.keywords)}
                  />
                  <MiniStat
                    label="Page rows"
                    value={formatCompact(site._count.pages)}
                  />
                  <MiniStat
                    label="Crawls"
                    value={String(site._count.crawls)}
                  />
                </div>

                <p className="mt-4 text-xs text-muted-foreground">
                  Added{" "}
                  {new Date(site.createdAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </Link>

              <div className="mt-4 border-t border-border/50 pt-4">
                <SyncButton siteId={site.id} fullWidth />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </p>
      <p className="font-data mt-0.5 text-sm font-semibold text-foreground">
        {value}
      </p>
    </div>
  );
}
