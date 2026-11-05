import Link from "next/link";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { listOpportunities, getFunnelCounts, type OpportunityRow } from "@/lib/funnel/views";
import { OPPORTUNITY_LABELS } from "@/lib/funnel/labels";
import { OPPORTUNITY_LANES, laneLabel } from "@/lib/funnel/proposal";
import { READINESS_LABELS } from "@/lib/funnel/decision";
import { DETECTOR_REQUIRES } from "@/lib/funnel/detectors";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import {
  CompletenessChip,
  DimensionChip,
  ScoreBadge,
  StatusChip,
  relativeTime,
} from "@/components/funnel/badges";
import { RefreshFunnelButton } from "@/components/funnel/refresh-button";
import { cn } from "@/lib/utils";
import type { OpportunityStatus } from "@prisma/client";

interface Props {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ status?: string; leg?: string; type?: string; q?: string; lane?: string; source?: string }>;
}

const STATUS_TABS: Array<{ key: string; label: string; statuses?: OpportunityStatus[] }> = [
  { key: "open", label: "Open", statuses: ["detected", "accepted", "in_progress"] },
  { key: "detected", label: "Detected", statuses: ["detected"] },
  { key: "accepted", label: "Accepted", statuses: ["accepted", "in_progress"] },
  { key: "parked", label: "Parked", statuses: ["parked"] },
  { key: "all", label: "All" },
];

export default async function OpportunitiesPage({ params, searchParams }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true, projectId: true },
  });
  if (!site) redirect("/sites");

  if (!site.projectId) {
    return (
      <div>
        <PageHeader eyebrow={site.domain} title="Opportunities" description="Every task on this site starts here." />
        <EmptyState
          title="This site is not attached to a project yet"
          description="The funnel is project-scoped: evidence, opportunities and tasks all belong to a project. Attach the site to a project to start detecting work."
          actionLabel="Open sites"
          actionHref="/sites"
        />
      </div>
    );
  }

  const query = await searchParams;
  const tab = STATUS_TABS.find((entry) => entry.key === (query.status ?? "open")) ?? STATUS_TABS[0];
  const laneQuery = query.lane ? `&lane=${query.lane}` : "";
  // Type chips count the current status/leg view, not the whole project: after
  // the §3 rules most rows are parked, and a chip reading 170 when 5 are open is
  // a lie about the board.
  const typeCounts = await db.opportunity.groupBy({
    by: ["type"],
    where: {
      projectId: site.projectId,
      status: tab.statuses?.length ? { in: tab.statuses } : undefined,
      evidenceCompleteness: query.leg && query.leg !== "all" ? { in: [query.leg as never] } : undefined,
    },
    _count: { _all: true },
  });
  const typeTotal = typeCounts.reduce((sum, entry) => sum + entry._count._all, 0);
  const kindsPresent = await db.evidenceRecord.groupBy({
    by: ["kind"],
    where: { projectId: site.projectId, supersededById: null },
    _count: { _all: true },
  });
  const present = new Set(kindsPresent.map((row) => row.kind));
  const disabledDetectors: Array<{ type: string; missing: string[] }> = Object.entries(DETECTOR_REQUIRES).flatMap(([type, needs]) => {
    const missing = needs.filter((kind) => !present.has(kind));
    return missing.length > 0 ? [{ type, missing: missing as string[] }] : [];
  });
  // O13/O14 need a finding that states a gap, not just any finding. Research that
  // returned themes only leaves them enabled-but-empty, which reads as "nothing
  // found" when the truth is "no gap was stated".
  const gapFindings = await db.evidenceRecord.count({
    where: {
      projectId: site.projectId,
      kind: "research_finding",
      OR: [
        { dimensions: { path: ["painPoint"], equals: "true" } },
        { dimensions: { path: ["positioningGap"], equals: "true" } },
      ],
    },
  });
  if (gapFindings === 0) {
    disabledDetectors.push({ type: "O13_user_pain_point", missing: ["gap-typed research_finding"] });
    disabledDetectors.push({ type: "O14_offer_positioning_gap", missing: ["gap-typed research_finding"] });
  }

  // The board is the proposal board: rows from the drafting system, not every
  // detector that has ever written to this project. "All sources" is explicit.
  const PROPOSAL_SOURCES = ["phase3:topic-map", "phase5:weekly"];
  const source = query.source ?? "proposals";
  const proposalCount = await db.opportunity.count({
    where: { projectId: site.projectId, detectedBy: { in: PROPOSAL_SOURCES }, status: "detected" },
  });
  const [rows, counts] = await Promise.all([
    listOpportunities(db, {
      projectId: site.projectId,
      statuses: tab.statuses,
      completeness: query.leg && query.leg !== "all" ? [query.leg] : undefined,
      types: query.type && query.type !== "all" ? [query.type as never] : undefined,
      search: query.q,
      lane: query.lane as never,
      detectedBy:
        source === "proposals"
          ? PROPOSAL_SOURCES
          : source === "phase3"
            ? "phase3:topic-map"
            : undefined,
    }),
    getFunnelCounts(db, site.projectId),
  ]);

  return (
    <div>
      <PageHeader
        eyebrow={site.domain}
        title="Opportunities"
        description="What we could win, why it matters, and what it costs. Accept one to turn it into a task."
        actions={<RefreshFunnelButton siteId={siteId} />}
      />

      {/* Stage strip: the funnel in one line, every number a link. */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Detected", value: counts.detected, href: `/sites/${siteId}/opportunities?status=detected`, tone: "info" },
          { label: "Accepted", value: counts.accepted + counts.inProgress, href: `/sites/${siteId}/opportunities?status=accepted`, tone: "primary" },
          { label: "Both legs", value: counts.bothLegs, href: `/sites/${siteId}/opportunities?status=all&leg=both`, tone: "success" },
          { label: "Parked", value: counts.parked, href: `/sites/${siteId}/opportunities?status=parked`, tone: "warning" },
        ].map((cell) => (
          <Link
            key={cell.label}
            href={cell.href}
            className="panel px-4 py-3 transition hover:border-primary/40"
          >
            <p className="text-atom-caption uppercase tracking-[0.12em] text-muted-foreground">{cell.label}</p>
            <p className="mt-1 font-heading text-2xl font-semibold text-foreground">{cell.value}</p>
          </Link>
        ))}
      </div>

      {/* Lanes first: a technical score must not bury the other lanes. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <nav aria-label="Opportunity lane" className="flex flex-wrap gap-1 rounded-xl bg-muted/50 p-1">
          <Link
            href={`/sites/${siteId}/opportunities?status=${tab.key}&source=all${query.leg ? `&leg=${query.leg}` : ""}`}
            aria-current={source === "all" ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition",
              !query.lane ? "bg-background text-foreground shadow-[var(--shadow-1)]" : "text-muted-foreground hover:text-foreground"
            )}
          >
            All sources · {counts.total}
          </Link>
          <Link
            href={`/sites/${siteId}/opportunities?status=${tab.key}&source=proposals${query.leg ? `&leg=${query.leg}` : ""}`}
            aria-current={source === "proposals" ? "page" : undefined}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition",
              source === "proposals" ? "bg-background text-foreground shadow-[var(--shadow-1)]" : "text-muted-foreground hover:text-foreground"
            )}
          >
            New proposals · {proposalCount}
          </Link>
          {OPPORTUNITY_LANES.map((lane) => (
            <Link
              key={lane.key}
              href={`/sites/${siteId}/opportunities?status=${tab.key}&lane=${lane.key}${query.leg ? `&leg=${query.leg}` : ""}`}
              aria-current={query.lane === lane.key ? "page" : undefined}
              title={lane.description}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition",
                query.lane === lane.key ? "bg-background text-foreground shadow-[var(--shadow-1)]" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {lane.label} · {counts.byLane[lane.key] ?? 0}
            </Link>
          ))}
        </nav>
      </div>

      {/* One filter row. Not two, not a tab pile. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <nav aria-label="Opportunity status" className="flex flex-wrap gap-1 rounded-xl bg-muted/50 p-1">
          {STATUS_TABS.map((entry) => (
            <Link
              key={entry.key}
              href={`/sites/${siteId}/opportunities?status=${entry.key}${query.leg ? `&leg=${query.leg}` : ""}${laneQuery}`}
              aria-current={entry.key === tab.key ? "page" : undefined}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition",
                entry.key === tab.key ? "bg-background text-foreground shadow-[var(--shadow-1)]" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {entry.label}
            </Link>
          ))}
        </nav>
        <div className="flex flex-wrap gap-1 rounded-xl bg-muted/50 p-1">
          {[
            { key: "all", label: "All evidence" },
            { key: "both", label: "Both legs" },
            { key: "why", label: "Why only" },
            { key: "how", label: "How only" },
          ].map((entry) => (
            <Link
              key={entry.key}
              href={`/sites/${siteId}/opportunities?status=${tab.key}${entry.key === "all" ? "" : `&leg=${entry.key}`}${laneQuery}`}
              aria-current={(query.leg ?? "all") === entry.key ? "page" : undefined}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition",
                (query.leg ?? "all") === entry.key ? "bg-background text-foreground shadow-[var(--shadow-1)]" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {entry.label}
            </Link>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">
          {rows.length} {rows.length === 1 ? "opportunity" : "opportunities"}
        </span>
      </div>

      {/* Every detector that fired, with its count. Without this the highest-scoring
          type fills the page and the rest are unreachable. */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <Link
          href={`/sites/${siteId}/opportunities?status=${tab.key}${query.leg ? `&leg=${query.leg}` : ""}${laneQuery}`}
          aria-current={!query.type || query.type === "all" ? "page" : undefined}
          className={cn(
            "rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium transition",
            !query.type || query.type === "all" ? "border-primary/50 bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          All types · {typeTotal}
        </Link>
        {typeCounts
          .slice()
          .sort((a, b) => b._count._all - a._count._all)
          .map((entry) => (
          <Link
            key={entry.type}
            href={`/sites/${siteId}/opportunities?status=${tab.key}&type=${entry.type}${query.leg ? `&leg=${query.leg}` : ""}${laneQuery}`}
            aria-current={query.type === entry.type ? "page" : undefined}
            className={cn(
              "rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium transition",
              query.type === entry.type ? "border-primary/50 bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            title={OPPORTUNITY_LABELS[entry.type]?.label}
          >
            {OPPORTUNITY_LABELS[entry.type]?.code ?? entry.type} · {entry._count._all}
          </Link>
        ))}
      </div>

      {disabledDetectors.length > 0 && (
        <p className="mb-4 text-xs text-muted-foreground">
          {disabledDetectors.length} detectors are disabled because their evidence is missing:{" "}
          {disabledDetectors
            .map((entry) => `${OPPORTUNITY_LABELS[entry.type as keyof typeof OPPORTUNITY_LABELS]?.code ?? entry.type} needs ${entry.missing.join(" + ")}`)
            .join(" · ")}
          . An empty type above means “not collected yet”, not “nothing found”.
        </p>
      )}

      {counts.bothLegs === 0 && counts.total > 0 && (
        <p className="mb-4 rounded-lg border border-[var(--a-warning-300)] bg-[var(--a-warning-50)] px-3 py-2 text-xs text-[var(--a-warning-800)]">
          No opportunity has the <strong>why</strong> leg yet. Business knowledge and research findings are empty for
          this project, so only technical work can be proposed. Demand-led ideas need that evidence first.
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState
          title={counts.total === 0 ? "Nothing detected yet" : "Nothing matches this view"}
          description={
            counts.total === 0
              ? "Detectors read the evidence already stored for this site — crawl results and Search Console. Refresh to project that evidence into the funnel and detect opportunities. No paid calls are made."
              : "Try another status or evidence filter."
          }
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id}>
              <OpportunityCard siteId={siteId} row={row} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OpportunityCard({ siteId, row }: { siteId: string; row: OpportunityRow }) {
  const label = OPPORTUNITY_LABELS[row.type];
  return (
    <Link
      href={`/sites/${siteId}/opportunities/${row.id}`}
      className="panel group block px-4 py-3 transition hover:border-primary/40"
    >
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] font-semibold text-primary">{label.code}</span>
            <h3 className="font-heading text-base font-semibold text-foreground group-hover:text-primary">{row.title}</h3>
            <StatusChip status={row.status} />
            <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[11px] text-foreground">
              {laneLabel(row.lane)}
            </span>
            {row.detectedBy === "phase3:topic-map" && (
              <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                new proposal
              </span>
            )}
            {row.readiness && (
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]",
                  row.readiness === "actionable" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
                  row.readiness === "needs_investigation" && "border-amber-500/30 bg-amber-500/10 text-amber-300",
                  row.readiness === "research_backlog" && "border-sky-500/30 bg-sky-500/10 text-sky-300",
                  row.readiness === "no_action" && "border-border bg-background/60 text-muted-foreground",
                  row.readiness === "rejected" && "border-red-500/30 bg-red-500/10 text-red-300"
                )}
                title={READINESS_LABELS[row.readiness as keyof typeof READINESS_LABELS]?.hint}
              >
                {READINESS_LABELS[row.readiness as keyof typeof READINESS_LABELS]?.label ?? row.readiness}
              </span>
            )}
            {row.measurement === "unquantified" && (
              <span className="text-[11px] text-muted-foreground">impact not quantified</span>
            )}
          </div>

          {row.proposal && (
            <p className="mt-1.5 text-xs text-muted-foreground">
              Target: {row.proposal.target.url ?? (row.proposal.target.newAsset ? "new asset" : "no page")}
              {row.proposal.target.section ? ` · ${row.proposal.target.section}` : ""}
            </p>
          )}

          {/* The reason. Always visible, never behind a click. */}
          <p className="mt-1.5 text-sm text-foreground/85">
            {row.reason ? (
              <>
                <span className="text-muted-foreground">Because </span>
                {row.reason}
              </>
            ) : (
              <span className="text-[var(--a-warning-700)]">No supporting evidence recorded</span>
            )}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <DimensionChip dimension={row.dimension} />
            <CompletenessChip completeness={row.completeness} />
            {row.clusterSlug && <span className="text-[11px] text-muted-foreground">cluster · {row.clusterSlug}</span>}
            <span className="text-[11px] text-muted-foreground">
              {row.evidenceCount} evidence {row.evidenceCount === 1 ? "record" : "records"} · detected {relativeTime(row.firstDetectedAt)}
            </span>
          </div>
        </div>

        <div className="shrink-0 text-right">
          <ScoreBadge score={row.score} />
          <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">score</p>
        </div>
      </div>
    </Link>
  );
}
