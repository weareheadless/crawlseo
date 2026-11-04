import { MEASUREMENT_LABELS, READINESS_LABELS, TRACK_LABELS, type BenefitMeasurement, type BenefitTrack, type Readiness } from "@/lib/funnel/decision";
import { cn } from "@/lib/utils";

/**
 * The decision, stated before the evidence (brief §5).
 *
 * A reader must not have to infer whether this is work, a question or a rejected
 * premise. The same component is used by the detail page and by its render test, so
 * the words on screen are the words that were tested.
 */
export type DecisionSummary = {
  readiness: string | null;
  measurement: string | null;
  track: string | null;
  intervention: string | null;
  benefit: string | null;
};

const READINESS_TONE: Record<string, string> = {
  actionable: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  needs_investigation: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  research_backlog: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  no_action: "border-border bg-background/60 text-muted-foreground",
  rejected: "border-red-500/30 bg-red-500/10 text-red-300",
};

function Chip({ children, title, tone }: { children: React.ReactNode; title?: string; tone?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-full border border-border bg-background/60 px-2 py-0.5 text-[11px] text-foreground",
        tone
      )}
    >
      {children}
    </span>
  );
}

export function DecisionSummaryPanel({ decision }: { decision: DecisionSummary }) {
  const readiness = decision.readiness as Readiness | null;
  const measurement = decision.measurement as BenefitMeasurement | null;
  const track = decision.track as BenefitTrack | null;

  return (
    <div className="panel mb-6 space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Decision</span>
        {readiness && (
          <Chip title={READINESS_LABELS[readiness]?.hint} tone={READINESS_TONE[readiness]}>
            {READINESS_LABELS[readiness]?.label ?? readiness}
          </Chip>
        )}
        {measurement && (
          <Chip title={MEASUREMENT_LABELS[measurement]?.hint}>
            {MEASUREMENT_LABELS[measurement]?.label ?? measurement}
          </Chip>
        )}
        {track && <Chip>{TRACK_LABELS[track] ?? track}</Chip>}
        {decision.intervention && <Chip>intervention · {decision.intervention.replaceAll("_", " ")}</Chip>}
        {decision.benefit && <Chip>{decision.benefit}</Chip>}
      </div>
      <p className="text-xs text-muted-foreground">
        {readiness === "actionable"
          ? "The need and the change are evidenced. A person still decides whether to do it."
          : readiness === "needs_investigation"
            ? "The need is real; what the site already answers, or the right change, is unresolved."
            : readiness === "rejected"
              ? "A contradicted premise or a research-quality failure. Kept for audit, not offered as work."
              : readiness === "no_action"
                ? "The site already answers this need and no improvement is demonstrated, so no work is proposed."
                : "Readiness is recorded from the evidence, not from the score."}
      </p>
    </div>
  );
}
