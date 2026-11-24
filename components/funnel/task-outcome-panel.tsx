import type { Verdict } from "@/lib/funnel/outcome-measurement";

/**
 * CMP-009: what was measured before the work, and what moved after it.
 *
 * The loop was open — `OutcomeObservation` held 0 rows against 17 tasks — so the first
 * job of this panel is to make its **absence** legible rather than leaving a blank
 * space. Three states, each said in words:
 *
 *  - **no baseline** — the work predates baseline capture. It cannot be backfilled, so
 *    it is reported unmeasured and never as a win.
 *  - **baseline, no verdict yet** — the re-check window is open. A number is shown; a
 *    verdict is not invented.
 *  - **measured** — before → after with both dates, the competitor's movement, and the
 *    limitation stated on the row itself.
 *
 * Two render rules this panel exists to keep:
 *  - **the baseline is shown, not just labelled.** A `Baseline` row was being written and
 *    the page said only "Baseline recorded", so nobody could see the position the work was
 *    measured against. Worse, the baseline's flat metrics were being handed to a renderer
 *    that expects `{ value, unit }`, which printed "position —" for a real number.
 *  - **`measured` is a person's word, and so is `won`.** A system verdict is
 *    improved/unchanged/declined/unmeasurable; `verified_win` appears only after a human
 *    confirms.
 */

export type BaselineMetrics = {
  unobserved?: boolean;
  reason?: string | null;
  query?: string | null;
  position?: number | null;
  competitorDomain?: string | null;
  competitorPosition?: number | null;
  url?: string | null;
};

export type AfterMetrics = {
  position?: number | null;
  competitorPosition?: number | null;
  positionDelta?: number | null;
  competitorDelta?: number | null;
  passedCompetitor?: boolean | null;
  verdict?: Verdict | null;
  reason?: string | null;
  limitation?: string | null;
  confirmedBy?: string | null;
  confirmedAt?: string | null;
};

export type OutcomeRow = {
  id: string;
  verdict: string;
  measuredBy: string;
  baselineObservedAt: Date;
  afterObservedAt: Date;
  baselineMetrics: unknown;
  afterMetrics: unknown;
};

export type BaselineRow = {
  id: string;
  observedAt: Date;
  metrics: unknown;
};

function asBaseline(metrics: unknown): BaselineMetrics {
  return (metrics ?? {}) as BaselineMetrics;
}

function asAfter(metrics: unknown): AfterMetrics {
  return (metrics ?? {}) as AfterMetrics;
}

const VERDICT_WORDING: Record<string, string> = {
  improved: "Moved up",
  unchanged: "No material change",
  declined: "Moved down",
  unmeasurable: "Not measurable",
  no_effect: "No material change",
  regression: "Moved down",
  verified_win: "Verified win",
};

function places(value: number | null | undefined): string {
  if (value == null) return "unknown";
  const rounded = Math.round(value * 10) / 10;
  return `${Math.abs(rounded)} ${Math.abs(rounded) === 1 ? "place" : "places"}`;
}

function position(value: number | null | undefined): string {
  if (value == null) return "not measured";
  return `#${Math.round(value * 10) / 10}`;
}

/**
 * The competitor comparison, said honestly.
 *
 * `null` is not zero. A competitor the after-sample did not name has an unknown
 * position, which is a different statement from "they did not move" — and the panel
 * distinguishes them rather than printing 0.
 */
function competitorLine(after: AfterMetrics, baseline: BaselineMetrics): string {
  const before = baseline.competitorPosition;
  const domain = baseline.competitorDomain;
  if (!domain) return "No competitor was ahead of this page when the baseline was taken.";
  if (after.competitorPosition == null) {
    return `${domain} was ${position(before)} in the baseline; the re-check did not sample it, so its movement is unknown.`;
  }
  const movement =
    after.competitorDelta == null
      ? "movement unknown"
      : after.competitorDelta === 0
        ? "held its place"
        : after.competitorDelta > 0
          ? `moved up ${places(after.competitorDelta)}`
          : `moved down ${places(after.competitorDelta)}`;
  const passed = after.passedCompetitor === true ? "We are now ahead of it." : after.passedCompetitor === false ? "It is still ahead of us." : "";
  return `${domain} went ${position(before)} → ${position(after.competitorPosition)} (${movement}). ${passed}`.trim();
}

export function TaskOutcomePanel({
  baselines,
  outcomes,
}: {
  baselines: BaselineRow[];
  outcomes: OutcomeRow[];
}) {
  if (outcomes.length > 0) {
    return (
      <ul className="space-y-3">
        {outcomes.map((outcome) => {
          const baseline = asBaseline(outcome.baselineMetrics);
          const after = asAfter(outcome.afterMetrics);
          return (
            <li key={outcome.id} className="rounded-lg border border-border bg-background/40 px-3 py-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">{VERDICT_WORDING[outcome.verdict] ?? outcome.verdict}</span>
                <span className="text-[11px] text-muted-foreground">
                  {`measured by ${outcome.measuredBy} · ${outcome.baselineObservedAt.toISOString().slice(0, 10)} → ${outcome.afterObservedAt.toISOString().slice(0, 10)}`}
                </span>
              </div>

              <p className="mt-1.5 text-xs">
                {`“${baseline.query ?? "this query"}”: our position ${position(baseline.position)} → ${position(after.position)}`}
                {after.positionDelta != null && after.positionDelta !== 0
                  ? ` (${after.positionDelta > 0 ? "up" : "down"} ${places(after.positionDelta)})`
                  : ""}
                .
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{competitorLine(after, baseline)}</p>
              {after.reason && <p className="mt-0.5 text-[11px] text-muted-foreground">{after.reason}</p>}
              {after.confirmedBy && (
                <p className="mt-1 text-[11px]">
                  {`Confirmed by ${after.confirmedBy}${after.confirmedAt ? ` on ${after.confirmedAt.slice(0, 10)}` : ""}.`}
                </p>
              )}
              <p className="mt-1.5 border-t border-border/60 pt-1.5 text-[10px] text-muted-foreground">
                {after.limitation ??
                  "A position change between two samples is not proof this work caused it: algorithm updates, seasonality and competitor action are not excluded."}
              </p>
            </li>
          );
        })}
      </ul>
    );
  }

  const latest = baselines[0];
  if (!latest) {
    return (
      <p className="text-sm text-muted-foreground">
        No baseline was recorded when this work was accepted, so no verdict can be claimed. An outcome without a
        pre-delivery baseline is reported as unmeasured, never as a win — and it is not backfilled, because a number taken
        after delivery describes a position the work may already have moved.
      </p>
    );
  }

  const baseline = asBaseline(latest.metrics);
  if (baseline.unobserved === true || baseline.position == null) {
    return (
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          {baseline.reason ??
            "The baseline was taken but no position could be measured, so there is nothing to compare against."}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {`Recorded ${latest.observedAt.toISOString().slice(0, 10)}. This is reported as unmeasured rather than as no change.`}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-sm">
        {`Baseline: “${baseline.query ?? "this query"}” at ${position(baseline.position)}`}
        {baseline.competitorDomain ? `, behind ${baseline.competitorDomain} at ${position(baseline.competitorPosition)}` : ""}
        .
      </p>
      <p className="text-[11px] text-muted-foreground">
        {`Taken ${latest.observedAt.toISOString().slice(0, 10)}. The verdict appears once a sample lands at least 28 days after delivery — a change measured sooner is noise.`}
      </p>
    </div>
  );
}
