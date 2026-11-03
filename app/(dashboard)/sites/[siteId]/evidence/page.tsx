import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { listEvidence } from "@/lib/funnel/views";
import { evidenceKindLabel } from "@/lib/funnel/labels";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Chip, SourceChip, relativeTime } from "@/components/funnel/badges";
import { RefreshFunnelButton } from "@/components/funnel/refresh-button";
import { cn } from "@/lib/utils";
import type { EvidenceRecordKind } from "@prisma/client";

interface Props {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ kind?: string }>;
}

const KIND_FILTERS: Array<{ key: string; label: string; kinds?: EvidenceRecordKind[] }> = [
  { key: "all", label: "All evidence" },
  { key: "rank", label: "Ranks", kinds: ["keyword_rank", "keyword_metrics"] },
  { key: "crawl", label: "Crawl", kinds: ["onpage_crawl", "internal_link_graph"] },
  { key: "serp", label: "SERP", kinds: ["serp_snapshot", "serp_features", "competitor_rank"] },
  { key: "ai", label: "AI visibility", kinds: ["ai_visibility_observation", "question_coverage"] },
  { key: "business", label: "Business", kinds: ["knowledge_fact", "research_finding"] },
];

/**
 * Evidence store (plan §5, surface 6): what we actually know, where it came
 * from and when. This is the audit trail behind every score.
 */
export default async function EvidencePage({ params, searchParams }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, domain: true, projectId: true } });
  if (!site) redirect("/sites");

  if (!site.projectId) {
    return (
      <div>
        <PageHeader eyebrow={site.domain} title="Evidence" description="Every stored observation behind the funnel." />
        <EmptyState
          title="This site is not attached to a project"
          description="Evidence is project-scoped. Attach the site to a project to store observations."
          actionLabel="Open sites"
          actionHref="/sites"
        />
      </div>
    );
  }

  const query = await searchParams;
  const filter = KIND_FILTERS.find((entry) => entry.key === (query.kind ?? "all")) ?? KIND_FILTERS[0];
  const rows = await listEvidence(db, { projectId: site.projectId, kinds: filter.kinds, limit: 200 });

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Evidence"
        description="Every observation the funnel reasons from, with its producer and age. Nothing here is a guess."
        actions={<RefreshFunnelButton siteId={siteId} />}
      />

      <div className="mb-4 flex flex-wrap gap-1 rounded-xl bg-muted/50 p-1">
        {KIND_FILTERS.map((entry) => (
          <a
            key={entry.key}
            href={`/sites/${siteId}/evidence?kind=${entry.key}`}
            aria-current={entry.key === filter.key ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition",
              entry.key === filter.key ? "bg-background text-foreground shadow-[var(--shadow-1)]" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {entry.label}
          </a>
        ))}
        <span className="ml-2 self-center text-xs text-muted-foreground">{rows.length} records</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No evidence stored for this filter"
          description="Refresh projects the crawl and Search Console data already stored for this site into the evidence store. No paid calls are made."
        />
      ) : (
        <div className="panel divide-y divide-border">
          {rows.map((row) => (
            <div key={row.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
              <SourceChip producer={row.producer} />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.headline}</span>
              <Chip>{evidenceKindLabel(row.kind)}</Chip>
              {row.usedBy > 0 ? (
                <Chip tone="primary">{row.usedBy} opportunity</Chip>
              ) : (
                <Chip tone="neutral">unused</Chip>
              )}
              {row.superseded && <Chip tone="warning">superseded</Chip>}
              <span className="w-16 text-right text-[11px] text-muted-foreground">{relativeTime(row.observedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
