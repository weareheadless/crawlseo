import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { db } from "@/lib/db";
import { getUserIdFromCookies } from "@/lib/session-helper";
import { getOpportunityDetail, type EvidenceLine } from "@/lib/funnel/views";
import { OPPORTUNITY_LABELS, VERDICT_LABELS, evidenceKindLabel } from "@/lib/funnel/labels";
import { DecisionSummaryPanel } from "@/components/funnel/decision-summary";
import { PageHeader } from "@/components/ui/page-header";
import {
  Chip,
  CompletenessChip,
  DimensionChip,
  MetricChip,
  ScoreBadge,
  SourceChip,
  StatusChip,
  VerdictChip,
  relativeTime,
  scoreHint,
} from "@/components/funnel/badges";
import { OpportunityDecisionBar } from "@/components/funnel/decision-bar";
import { TaskStepControls } from "@/components/funnel/task-step-controls";
import { cn } from "@/lib/utils";

interface Props {
  params: Promise<{ siteId: string; opportunityId: string }>;
}

/**
 * One page per opportunity (docs/seo-funnel-spine-plan.md §5, surface 5).
 * The funnel is the page: why it exists → the plan → research → delivery →
 * outcome. No tabs, no second page. A stage that has not happened renders its
 * lifecycle reason instead of disappearing.
 */
export default async function OpportunityDetailPage({ params }: Props) {
  const userId = await getUserIdFromCookies();
  const { siteId, opportunityId } = await params;
  if (!userId) redirect("/login");

  const site = await db.site.findUnique({ where: { id: siteId }, select: { userId: true, domain: true } });
  if (!site) redirect("/sites");

  const detail = await getOpportunityDetail(db, opportunityId);
  if (!detail) notFound();

  const label = OPPORTUNITY_LABELS[detail.type];
  const decided = detail.status !== "detected";

  return (
    <div className="mx-auto max-w-4xl">
      <nav className="mb-4 text-xs text-muted-foreground">
        <Link href={`/sites/${siteId}/opportunities`} className="hover:text-foreground">
          ← All opportunities
        </Link>
      </nav>

      <PageHeader
        eyebrow={`${site.domain} · ${label.code}`}
        title={detail.title}
        description={detail.summary}
      />

      {/* Header facts, all of them declared. */}
      <div className="panel mb-6 flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <ScoreBadge score={detail.score} inputs={detail.scoreInputs} />
          <span className="text-[11px] text-muted-foreground" title={scoreHint(detail.scoreInputs)}>
            score
          </span>
        </div>
        <StatusChip status={detail.status} />
        <DimensionChip dimension={detail.dimension} />
        <CompletenessChip completeness={detail.completeness} />
        {detail.clusterSlug && <Chip>cluster · {detail.clusterSlug}</Chip>}
        <span className="text-[11px] text-muted-foreground">
          detected {relativeTime(detail.firstDetectedAt)} by {detail.detectedBy}
        </span>
        {decided && detail.decidedBy && (
          <span className="text-[11px] text-muted-foreground">
            decided by {detail.decidedBy}
            {detail.decidedAt ? ` · ${relativeTime(detail.decidedAt)}` : ""}
          </span>
        )}
      </div>

      {detail.decisionChanged && (
        <div className="panel mb-4 border-[var(--a-warning-300)] bg-[var(--a-warning-300)] px-4 py-3 text-sm text-[var(--a-warning-700)]">
          <strong>This recommendation changed after the task was accepted.</strong> Review the
          new decision below before continuing; the accepted task keeps the version it was
          created from.
        </div>
      )}

      <DecisionSummaryPanel decision={detail.decision} />

      <Stage number={1} title="Why this exists" subtitle="The evidence that produced this opportunity. Both legs, always shown.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Leg
            title="Why it matters"
            hint="Business relevance: does this serve what the customer needs?"
            lines={detail.whyEvidence}
            emptyReason="No business evidence yet, so business fit is not established."
          />
          <Leg
            title="How we win it"
            hint="Search and technical evidence: can we take it, and can we measure it?"
            lines={detail.howEvidence}
            emptyReason="No search evidence yet, so the organic side is unmeasured."
          />
        </div>
      </Stage>

      <Stage
        number={2}
        title="The plan"
        subtitle={label.play}
        footer={`Success looks like: ${label.successMetric}`}
      >
        {detail.task ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <StatusChip status={detail.task.status} />
              <span className="text-sm text-foreground">{detail.task.title}</span>
            </div>
            <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Executor</dt>
                <dd className="text-foreground">{detail.task.assignedTo}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Prepared by</dt>
                <dd className="text-foreground">
                  {detail.task.agentPreparedById ? `agent · ${detail.task.agentPreparedById}` : "human"}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Confirmed by</dt>
                <dd className="text-foreground">
                  {detail.task.humanConfirmedBy
                    ? `${detail.task.humanConfirmedBy}${detail.task.humanConfirmedAt ? ` · ${relativeTime(detail.task.humanConfirmedAt)}` : ""}`
                    : "not yet"}
                </dd>
              </div>
            </dl>
            <TaskStepControls
              siteId={siteId}
              opportunityId={detail.id}
              taskId={detail.task.id}
              status={detail.task.status}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              No task yet. Accepting turns this opportunity into a task for a person to execute — the only way work enters the queue.
            </p>
            <OpportunityDecisionBar
              siteId={siteId}
              opportunityId={detail.id}
              status={detail.status}
              expectedDecisionId={detail.recommendation?.decisionId ?? null}
            />
          </div>
        )}
      </Stage>

      <Stage
        number={3}
        title="Research"
        subtitle="What was gathered to decide and to write, when research was needed."
      >
        {detail.whyEvidence.some((line) => line.kind === "research_finding") ? (
          <ul className="space-y-2">
            {detail.whyEvidence
              .filter((line) => line.kind === "research_finding")
              .map((line) => (
                <li key={line.id} className="rounded-lg border border-border bg-background/40 px-3 py-2">
                  <p className="text-sm text-foreground">{line.headline}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {evidenceKindLabel(line.kind)} · {line.producer} · {relativeTime(line.observedAt)}
                  </p>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No research needed for this play. {label.firesFrom === "search" ? "Search evidence alone decides it." : "Business knowledge alone decides it."}
          </p>
        )}
      </Stage>

      <Stage
        number={4}
        title="Delivery"
        subtitle="What shipped, and who confirmed it."
      >
        {detail.task && (detail.task.status === "delivered" || detail.task.status === "verified_outcome") ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <StatusChip status={detail.task.status} />
            <span className="text-foreground">
              Delivered by {detail.task.humanConfirmedBy ?? "unrecorded"}
              {detail.task.humanConfirmedAt ? ` · ${relativeTime(detail.task.humanConfirmedAt)}` : ""}
            </span>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {detail.task
              ? "Not delivered yet. Delivery is recorded when a person confirms it."
              : "Nothing delivered. This opportunity has no task yet."}
          </p>
        )}
      </Stage>

      <Stage
        number={5}
        title="Outcome"
        subtitle="Baseline before delivery versus after. A verdict is never estimated."
      >
        {detail.task && detail.task.outcomes.length > 0 ? (
          <ul className="space-y-3">
            {detail.task.outcomes.map((outcome) => (
              <li key={outcome.id} className="rounded-lg border border-border bg-background/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <VerdictChip verdict={outcome.verdict} />
                  <span className="text-[11px] text-muted-foreground">
                    measured by {outcome.measuredBy} · after {relativeTime(outcome.afterObservedAt)}
                  </span>
                </div>
                <div className="mt-2 grid gap-3 text-xs sm:grid-cols-2">
                  <div>
                    <p className="mb-1 text-muted-foreground">Baseline ({outcome.baselineObservedAt.toISOString().slice(0, 10)})</p>
                    <MetricList metrics={outcome.baselineMetrics} />
                  </div>
                  <div>
                    <p className="mb-1 text-muted-foreground">After ({outcome.afterObservedAt.toISOString().slice(0, 10)})</p>
                    <MetricList metrics={outcome.afterMetrics} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {detail.task?.baselines.length
              ? "Baseline recorded. The verdict appears after the re-check window."
              : "No baseline recorded, so no verdict can be claimed. An outcome without a pre-delivery baseline is reported as unmeasured, never as a win."}
          </p>
        )}
      </Stage>

    </div>
  );
}

function Stage({
  number,
  title,
  subtitle,
  footer,
  children,
}: {
  number: number;
  title: string;
  subtitle?: string;
  footer?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5" aria-label={`Step ${number}: ${title}`}>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border bg-muted/60 font-mono text-[11px] text-muted-foreground">
          {number}
        </span>
        <h2 className="font-heading text-atom-subheader font-semibold text-foreground">{title}</h2>
      </div>
      {subtitle && <p className="mb-3 ml-8 text-sm text-muted-foreground">{subtitle}</p>}
      <div className="panel ml-0 px-4 py-3 sm:ml-8">{children}</div>
      {footer && <p className="mt-2 ml-8 text-[11px] text-muted-foreground">{footer}</p>}
    </section>
  );
}

function Leg({
  title,
  hint,
  lines,
  emptyReason,
}: {
  title: string;
  hint: string;
  lines: EvidenceLine[];
  emptyReason: string;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <Chip tone={lines.length ? "success" : "warning"}>{lines.length ? `${lines.length}` : "missing"}</Chip>
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">{hint}</p>
      {lines.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--a-warning-700)]/40 px-3 py-2 text-xs text-[var(--a-warning-700)]">
          {emptyReason}
        </p>
      ) : (
        <ul className="space-y-2">
          {lines.map((line) => (
            <li key={line.id} className="rounded-lg border border-border bg-background/40 px-3 py-2">
              <p className="text-sm text-foreground">{line.headline}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <SourceChip producer={line.producer} />
                <span className="text-[11px] text-muted-foreground">{evidenceKindLabel(line.kind)}</span>
                <span className="text-[11px] text-muted-foreground">· {relativeTime(line.observedAt)}</span>
              </div>
              {line.metrics.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {line.metrics.map((metric) => (
                    <MetricChip key={`${line.id}-${metric.label}`} {...metric} />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MetricList({ metrics }: { metrics: unknown }) {
  const entries = Object.entries((metrics ?? {}) as Record<string, { value?: number; unit?: string }>);
  if (entries.length === 0) return <p className="text-muted-foreground">no metrics recorded</p>;
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([label, metric]) => (
        <span key={label} className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]">
          {label.split(":").slice(1).join(":")} {metric.value ?? "—"} {metric.unit ?? ""}
        </span>
      ))}
    </div>
  );
}
