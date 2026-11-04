import { MEASUREMENT_LABELS, READINESS_LABELS, TRACK_LABELS, type BenefitMeasurement, type BenefitTrack, type Readiness } from "@/lib/funnel/decision";
import { cn } from "@/lib/utils";

/**
 * The decision, stated before the evidence (brief §5).
 *
 * A reader must not have to infer whether this is work, a question or a rejected
 * premise. The same component is used by the detail page and by its render test, so
 * the words on screen are the words that were tested.
 *
 * The assessment's own words are shown here too — the existing coverage, the exact
 * change, its target page, the success measure and what remains uncertain. The
 * detail page used to render only the readiness chips, so a reader could not see
 * what was actually proposed without opening raw JSON.
 */
export type DecisionSummary = {
  readiness: string | null;
  measurement: string | null;
  track: string | null;
  intervention: string | null;
  benefit: string | null;
  change?: string | null;
  targetPages?: string[];
  successMeasure?: string | null;
  uncertainty?: string[];
  coverage?: string | null;
  needRationale?: string | null;
  needEvidenceUrls?: string[];
  offerFitRationale?: string | null;
  offerFitEvidenceUrls?: string[];
  assessmentModel?: string | null;
  reviews?: string[];
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

function SourceLink({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="break-all text-primary underline-offset-2 hover:underline"
    >
      {url}
    </a>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="text-xs text-foreground/85">
      <span className="text-muted-foreground">{label}: </span>
      {children}
    </p>
  );
}

export function DecisionSummaryPanel({ decision }: { decision: DecisionSummary }) {
  const readiness = decision.readiness as Readiness | null;
  const measurement = decision.measurement as BenefitMeasurement | null;
  const track = decision.track as BenefitTrack | null;
  const targetPages = decision.targetPages ?? [];
  const uncertainty = decision.uncertainty ?? [];
  const needEvidenceUrls = decision.needEvidenceUrls ?? [];
  const offerFitEvidenceUrls = decision.offerFitEvidenceUrls ?? [];
  const hasDetail = Boolean(
    decision.coverage ||
      decision.change ||
      targetPages.length > 0 ||
      decision.successMeasure ||
      uncertainty.length > 0 ||
      decision.needRationale ||
      decision.offerFitRationale
  );

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

      {hasDetail && (
        <div className="space-y-1.5 border-t border-border pt-3">
          {decision.coverage && <Row label="Existing coverage">{decision.coverage}</Row>}
          {decision.change && <Row label="Change">{decision.change}</Row>}
          {targetPages.length > 0 && (
            <Row label={targetPages.length === 1 ? "Target page" : "Target pages"}>
              {targetPages.map((url, index) => (
                <span key={url}>
                  {index > 0 ? ", " : ""}
                  <SourceLink url={url} />
                </span>
              ))}
            </Row>
          )}
          {decision.successMeasure && <Row label="Success measure">{decision.successMeasure}</Row>}
          {(decision.reviews?.length ?? 0) > 0 && (
            <Row label="Review required">{decision.reviews!.join(" · ")}</Row>
          )}
          {uncertainty.length > 0 && (
            <div className="text-xs text-foreground/85">
              <span className="text-muted-foreground">Still uncertain: </span>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {uncertainty.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {(decision.needRationale || decision.offerFitRationale) && (
            <details className="text-xs text-foreground/85">
              <summary className="cursor-pointer text-muted-foreground">Why this decision</summary>
              <div className="mt-2 space-y-2">
                {decision.needRationale && (
                  <div>
                    <p>
                      <span className="text-muted-foreground">Need: </span>
                      {decision.needRationale}
                    </p>
                    {needEvidenceUrls.length > 0 && (
                      <p className="mt-0.5">
                        <span className="text-muted-foreground">Sources: </span>
                        {needEvidenceUrls.map((url, index) => (
                          <span key={url}>
                            {index > 0 ? ", " : ""}
                            <SourceLink url={url} />
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                )}
                {decision.offerFitRationale && (
                  <div>
                    <p>
                      <span className="text-muted-foreground">Offer fit: </span>
                      {decision.offerFitRationale}
                    </p>
                    {offerFitEvidenceUrls.length > 0 && (
                      <p className="mt-0.5">
                        <span className="text-muted-foreground">Business facts: </span>
                        {offerFitEvidenceUrls.map((url, index) => (
                          <span key={url}>
                            {index > 0 ? ", " : ""}
                            <SourceLink url={url} />
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                )}
                {decision.assessmentModel && (
                  <p className="text-muted-foreground">Assessed by {decision.assessmentModel}.</p>
                )}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
