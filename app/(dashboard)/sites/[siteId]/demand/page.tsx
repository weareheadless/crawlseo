import Link from "next/link";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { listDemandClusters } from "@/lib/funnel/views";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Chip } from "@/components/funnel/badges";
import { RefreshFunnelButton } from "@/components/funnel/refresh-button";

interface Props {
  params: Promise<{ siteId: string }>;
}

const INTENT_LABELS: Record<string, string> = {
  informational: "Informational",
  commercial: "Commercial",
  transactional: "Transactional",
  local: "Local",
  mixed: "Mixed",
};

/**
 * Demand map (plan §5, surface 2): the landscape the opportunities come from.
 * Clusters carry curated identity; every count here is recomputed from stored
 * evidence, so this page can never disagree with the board.
 */
export default async function DemandMapPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, domain: true, projectId: true } });
  if (!site) redirect("/sites");

  if (!site.projectId) {
    return (
      <div>
        <PageHeader eyebrow={site.domain} title="Demand map" description="The clusters, intent and competitors the funnel works from." />
        <EmptyState
          title="This site is not attached to a project"
          description="The demand map is project-scoped. Attach the site to a project to build it."
          actionLabel="Open sites"
          actionHref="/sites"
        />
      </div>
    );
  }

  const clusters = await listDemandClusters(db, site.projectId);
  const openTotal = clusters.reduce((sum, cluster) => sum + cluster.openOpportunities, 0);
  // Opportunities exist before clusters do. Saying "0 open" while the board has
  // work would be a lie, so the unclustered remainder is stated explicitly.
  const unclustered = await db.opportunity.count({
    where: { projectId: site.projectId, clusterId: null, status: { in: ["detected", "accepted", "in_progress"] } },
  });

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Demand map"
        description="What customers need, how they search for it, and where we stand. Opportunities are slices of this map."
        actions={<RefreshFunnelButton siteId={siteId} />}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="panel px-4 py-3">
          <p className="text-atom-caption uppercase tracking-[0.12em] text-muted-foreground">Clusters</p>
          <p className="mt-1 font-heading text-2xl font-semibold">{clusters.length}</p>
        </div>
        <div className="panel px-4 py-3">
          <p className="text-atom-caption uppercase tracking-[0.12em] text-muted-foreground">Tracked</p>
          <p className="mt-1 font-heading text-2xl font-semibold">{clusters.filter((cluster) => cluster.tracked).length}</p>
        </div>
        <div className="panel px-4 py-3">
          <p className="text-atom-caption uppercase tracking-[0.12em] text-muted-foreground">In a cluster</p>
          <p className="mt-1 font-heading text-2xl font-semibold">{openTotal}</p>
        </div>
        <div className="panel px-4 py-3">
          <p className="text-atom-caption uppercase tracking-[0.12em] text-muted-foreground">Not yet clustered</p>
          <p className="mt-1 font-heading text-2xl font-semibold">{unclustered}</p>
        </div>
      </div>

      {clusters.length === 0 ? (
        <EmptyState
          title="No clusters yet"
          description="A cluster groups queries around one customer need, with the intent and business relevance that make an opportunity worth playing. Discovery proposes clusters from stored evidence; none are endorsed until a person marks them core or adjacent to the offer."
        />
      ) : (
        <ul className="space-y-2">
          {clusters.map((cluster) => {
            const relevance = (cluster.businessRelevance ?? {}) as { relevance?: string };
            const endorsed = relevance.relevance && relevance.relevance !== "none";
            const coverage = cluster.members === 0 ? 0 : cluster.covered / cluster.members;
            return (
              <li key={cluster.id}>
                <Link href={`/sites/${siteId}/demand/${cluster.id}`} className="panel block px-4 py-3 transition hover:border-primary/40">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-heading text-base font-semibold text-foreground">{cluster.name}</h3>
                    <Chip>{INTENT_LABELS[cluster.intent] ?? cluster.intent}</Chip>
                    <Chip tone={endorsed ? "success" : "warning"}>{endorsed ? relevance.relevance : "not endorsed"}</Chip>
                    {cluster.tracked && <Chip tone="success">tracked</Chip>}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{cluster.topicSummary}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    <span>{cluster.members} queries</span>
                    <span>coverage {(coverage * 100).toFixed(0)}%</span>
                    <span>{cluster.bestPosition == null ? "not ranking" : `best #${Math.round(cluster.bestPosition)}`}</span>
                    <span>{cluster.openOpportunities} open opportunities</span>
                    <span>via {cluster.proposedBy}</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
