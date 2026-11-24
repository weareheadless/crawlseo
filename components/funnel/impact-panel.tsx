import { ctrCurve } from "@/lib/funnel/impact";

/**
 * CMP-005: what this opportunity is worth, and what that rests on.
 *
 * The board orders work by click upside. If the upside is not shown with its
 * basis, a person has to trust a number they cannot see the argument for — and a
 * query with no measurement at all looks identical to one with a small one.
 *
 * So this panel states, in order:
 *  1. the demand, its **source** and the date it was observed,
 *  2. the incremental clicks per month,
 *  3. every assumption the number rests on,
 *  4. and, when there is no measurement, the words "not measured" instead of a
 *     number. A zero would read as "worthless"; an absence reads as "unknown".
 */

type Worth = {
  volume?: number | null;
  volumeSource?: string | null;
  currentPosition?: number | null;
  targetPosition?: number | null;
  windowDays?: number | null;
  observedCtr?: number | null;
  observedImpressions?: number | null;
  ctrAtPosition?: number | null;
};

type Assessment = {
  kind?: string;
  basis?: string;
  incrementalClicksPerMonth?: number | null;
  assumptions?: Record<string, number | null | undefined>;
  limitations?: string[];
};

export type ImpactPanelProps = {
  scoreInputs: unknown;
  /** When the demand was observed, when the caller knows it. */
  observedAt?: Date | null;
  /** The query this opportunity is about, when the row carries one. */
  query?: string | null;
};

function percent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function clicks(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  // A tenth of a click a month is still a number a person can act on; rounding it
  // to "0" would turn a small winnable query into a meaningless one.
  return value >= 10 ? Math.round(value).toLocaleString() : value.toFixed(1);
}

const KIND_LABEL: Record<string, string> = {
  measured: "Measured",
  estimated: "Estimated",
  technical: "Technical",
  hypothesis: "Hypothesis",
};

export function ImpactPanel({ scoreInputs, observedAt, query }: ImpactPanelProps) {
  const inputs = (scoreInputs ?? {}) as { worth?: Worth; assessment?: Assessment };
  const worth = inputs.worth ?? {};
  const assessment = inputs.assessment;
  const kind = assessment?.kind ?? "hypothesis";

  const volume = worth.volume ?? null;
  // `unknown` and a missing source are the same claim: nobody measured this.
  const source = worth.volumeSource ?? null;
  const measured = source === "provider" || source === "first_party";
  const incremental = assessment?.incrementalClicksPerMonth ?? null;

  const targetCtr =
    assessment?.assumptions?.targetCtr ?? ctrCurve(worth.targetPosition ?? null) ?? null;
  const currentCtr =
    assessment?.assumptions?.currentCtr ?? worth.observedCtr ?? ctrCurve(worth.currentPosition ?? null) ?? null;

  return (
    <section className="panel mb-5 px-4 py-4" aria-label="What this is worth">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-sm font-semibold">What this is worth</h2>
        <span
          className={
            kind === "measured"
              ? "text-[10px] uppercase tracking-[0.12em] text-[var(--a-success-700,#34D399)]"
              : kind === "estimated"
                ? "text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
                : "text-[10px] uppercase tracking-[0.12em] text-[var(--a-warning-700)]"
          }
        >
          {KIND_LABEL[kind] ?? kind}
        </span>
      </div>

      {query && <p className="mt-0.5 text-[11px] text-muted-foreground">for “{query}”</p>}

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Search demand</p>
          <p className="mt-0.5 font-mono text-lg font-semibold">
            {measured ? (volume != null ? `${Math.round(volume).toLocaleString()} /mo` : "—") : "not measured"}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {source === "provider"
              ? "provider volume"
              : source === "first_party"
                ? `${worth.observedImpressions != null ? Math.round(worth.observedImpressions).toLocaleString() : "—"} impressions observed, used as the volume`
                : "no provider volume and no impressions — treat the upside as unknown"}
          </p>
          {observedAt && (
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              observed {observedAt.toISOString().slice(0, 10)}
            </p>
          )}
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Click upside</p>
          <p className="mt-0.5 font-mono text-lg font-semibold">
            {incremental == null ? "not measured" : `${clicks(incremental)} /mo`}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {incremental == null
              ? "no defensible estimate without a demand measurement"
              : "incremental clicks per month at the target position"}
          </p>
        </div>

        <div>
          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Position</p>
          <p className="mt-0.5 font-mono text-lg font-semibold">
            {worth.currentPosition != null ? `#${Math.round(worth.currentPosition)}` : "—"}
            {worth.targetPosition != null ? ` → #${Math.round(worth.targetPosition)}` : ""}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            CTR {percent(currentCtr)} now, {percent(targetCtr)} at target
          </p>
        </div>
      </div>

      {assessment?.limitations && assessment.limitations.length > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">What this assumes</p>
          <ul className="mt-1 space-y-0.5">
            {assessment.limitations.map((line) => (
              <li key={line} className="text-[11px] text-muted-foreground">
                · {line}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
