import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { listOpportunities } from "@/lib/funnel/views";
import { OPPORTUNITY_LABELS } from "@/lib/funnel/labels";
import { PageHeader } from "@/components/ui/page-header";
import { Chip, CompletenessChip, ScoreBadge, StatusChip, relativeTime } from "@/components/funnel/badges";

interface Props {
  params: Promise<{ siteId: string; clusterId: string }>;
}

const INTENT_LABELS: Record<string, string> = {
  informational: "Informational",
  commercial: "Commercial",
  transactional: "Transactional",
  local: "Local",
  mixed: "Mixed",
};

const SIGNAL_LABELS: Record<string, string> = {
  gsc_query: "Search Console queries sharing a phrase",
  serp_overlap: "Queries sharing the same top results",
  knowledge_prior: "A question from business knowledge",
  manual: "Curated by a person",
};

/**
 * Cluster page (docs/demand-map-cluster-discovery.md §7): the reason the
 * cluster exists, its members with our position, its coverage, and the work
 * inside it.
 */
export default async function ClusterPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId, clusterId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, domain: true, projectId: true } });
  if (!site) redirect("/sites");
  if (!site.projectId) redirect(`/sites/${siteId}/demand`);

  const cluster = await db.demandMapCluster.findFirst({
    where: { id: clusterId, projectId: site.projectId },
    select: {
      id: true,
      slug: true,
      name: true,
      topicSummary: true,
      intent: true,
      proposedBy: true,
      confidence: true,
      tracked: true,
      businessRelevance: true,
      supersededById: true,
      createdAt: true,
    },
  });
  if (!cluster) notFound();

  const memberships = await db.evidenceRecord.findMany({
    where: { projectId: site.projectId, kind: "keyword_universe_membership", supersededById: null },
    select: { dimensions: true, observedAt: true },
  });
  const members = memberships
    .map((row) => (row.dimensions ?? {}) as { cluster?: string; query?: string })
    .filter((dims) => dims.cluster === cluster.slug && dims.query)
    .map((dims) => dims.query as string);

  // Our best recorded position per member query, from stored rank evidence.
  const ranks = await db.evidenceRecord.findMany({
    where: { projectId: site.projectId, kind: "keyword_rank", supersededById: null },
    select: { dimensions: true, metrics: true },
  });
  const positionByQuery = new Map<string, number>();
  for (const row of ranks) {
    const dims = (row.dimensions ?? {}) as { query?: string };
    const metrics = (row.metrics ?? {}) as Record<string, { value: number | null }>;
    const position = metrics["provider:position"]?.value ?? metrics["first_party:position"]?.value ?? null;
    if (!dims.query || position == null) continue;
    const current = positionByQuery.get(dims.query);
    if (current == null || position < current) positionByQuery.set(dims.query, position);
  }

  const opportunities = (await listOpportunities(db, { projectId: site.projectId })).filter(
    (row) => row.clusterSlug === cluster.slug
  );
  const covered = members.filter((query) => positionByQuery.has(query)).length;
  const coverage = members.length === 0 ? 0 : covered / members.length;
  const relevance = (cluster.businessRelevance ?? {}) as { relevance?: string; decidedBy?: string };

  return (
    <div className="mx-auto max-w-4xl">
      <nav className="mb-4 text-xs text-muted-foreground">
        <Link href={`/sites/${siteId}/demand`} className="hover:text-foreground">
          ← Demand map
        </Link>
      </nav>

      <PageHeader eyebrow={`${site.domain} · cluster`} title={cluster.name} description={cluster.topicSummary} />

      <div className="panel mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <Chip>{INTENT_LABELS[cluster.intent] ?? cluster.intent}</Chip>
        <Chip tone={relevance.relevance && relevance.relevance !== "none" ? "success" : "warning"}>
          {relevance.relevance === "none" || !relevance.relevance ? "not endorsed" : relevance.relevance}
        </Chip>
        {cluster.tracked && <Chip tone="success">tracked</Chip>}
        {cluster.supersededById && <Chip tone="warning">superseded</Chip>}
        <span className="text-[11px] text-muted-foreground">{members.length} queries</span>
        <span className="text-[11px] text-muted-foreground">coverage {(coverage * 100).toFixed(0)}%</span>
        <span className="text-[11px] text-muted-foreground">confidence {cluster.confidence.toFixed(2)}</span>
      </div>

      <section className="panel mb-5 px-4 py-3">
        <h2 className="font-heading text-sm font-semibold">Why this cluster exists</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Proposed by {SIGNAL_LABELS[cluster.proposedBy] ?? cluster.proposedBy} · {relativeTime(cluster.createdAt)}
        </p>
        {relevance.relevance && relevance.relevance !== "none" && relevance.decidedBy ? (
          <p className="mt-1 text-xs text-muted-foreground">Endorsed by {relevance.decidedBy}</p>
        ) : (
          <p className="mt-1 text-xs text-[var(--a-warning-700)]">
            Not endorsed yet. Discovery proposes; a person decides whether this need is core or adjacent to the offer.
          </p>
        )}
      </section>

      <section className="mb-5" aria-label="Members">
        <h2 className="mb-2 font-heading text-sm font-semibold">Queries in this cluster</h2>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members recorded.</p>
        ) : (
          <ul className="panel divide-y divide-border">
            {members.map((query) => {
              const position = positionByQuery.get(query);
              return (
                <li key={query} className="flex items-center gap-3 px-4 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{query}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {position == null ? "not ranking" : `#${Math.round(position)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Opportunities in this cluster">
        <h2 className="mb-2 font-heading text-sm font-semibold">Work in this cluster</h2>
        {opportunities.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No opportunity in this cluster yet. The cluster play fires when coverage is low and the cluster has enough tracked queries.
          </p>
        ) : (
          <ul className="space-y-2">
            {opportunities.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/sites/${siteId}/opportunities/${row.id}`}
                  className="panel flex items-center gap-3 px-4 py-2.5 transition hover:border-primary/40"
                >
                  <span className="font-mono text-[11px] font-semibold text-primary">{OPPORTUNITY_LABELS[row.type].code}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.title}</span>
                  <StatusChip status={row.status} />
                  <CompletenessChip completeness={row.completeness} />
                  <ScoreBadge score={row.score} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
