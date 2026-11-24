import type { WinProbabilitySource } from "@/lib/funnel/win-probability";

/**
 * CMP-012: the winnability inputs, each with its source and the date it was measured.
 *
 * The defect this panel exposes was invisible: the score said "this is a fair fight" while
 * three of its four winnability inputs were the literal `0.5`. A person could not tell a
 * measured fight from a typed-in one, because the number looked the same.
 *
 * So every input shows three things — **the value, where it came from, and when** — and an
 * unmeasured input says "not measured" instead of showing a neutral-looking default. The
 * row's overall confidence is stated once, at the top, in the same words the score ceiling
 * uses.
 */

const INPUT_LABELS: Record<string, string> = {
  rankDistance: "Rank distance",
  authorityGap: "Authority vs competitors",
  pageStrength: "Our page vs theirs",
  serpCompetition: "SERP competition",
  playTypeFactor: "Play type",
};

const INPUT_MEANING: Record<string, string> = {
  rankDistance: "How close the current position is to a winnable one.",
  authorityGap: "Our share of the measured referring-domain pool.",
  pageStrength: "The share of compared page dimensions where we match or beat the page ahead.",
  serpCompetition: "Derived from the provider's keyword difficulty for this query.",
  playTypeFactor: "A declared property of the play, not a measurement of this SERP.",
};

const SOURCE_TONE: Record<WinProbabilitySource, string> = {
  measured: "text-[var(--a-success-700,#34D399)]",
  estimated: "text-[var(--a-warning-700)]",
  assumed: "text-muted-foreground",
};

export type WinProbabilityPanelProps = {
  winProbability: Partial<Record<string, number | null>> | null | undefined;
  source: Partial<Record<string, WinProbabilitySource>> | null | undefined;
  observedAt: Partial<Record<string, string>> | null | undefined;
  missing: string[] | null | undefined;
  score: number | null;
  /** True when the score was capped because nothing measurable was measured. */
  lowConfidenceCeiling?: number | null;
};

function format(value: number | null | undefined): string {
  if (value == null) return "not measured";
  return `${Math.round(value * 100) / 100}`;
}

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return `· ${iso.slice(0, 10)}`;
}

export function WinProbabilityPanel({
  winProbability,
  source,
  observedAt,
  missing,
  score,
  lowConfidenceCeiling,
}: WinProbabilityPanelProps) {
  const inputs = winProbability ?? {};
  const sources = source ?? {};
  const dates = observedAt ?? {};
  const keys = ["rankDistance", "authorityGap", "pageStrength", "serpCompetition", "playTypeFactor"].filter(
    (key) => key in inputs
  );
  if (keys.length === 0) return null;

  const measurable = ["rankDistance", "authorityGap", "pageStrength", "serpCompetition"];
  const measuredCount = measurable.filter((key) => inputs[key] != null).length;
  const entirelyAssumed = measuredCount === 0;

  return (
    <section className="panel mb-5 overflow-hidden" aria-label="Winnability">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-4">
        <h2 className="font-heading text-sm font-semibold">Can we win this?</h2>
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          {`${measuredCount} of ${measurable.length} measured`}
        </span>
      </div>

      <p className="mt-1 px-4 text-[11px] text-muted-foreground">
        {entirelyAssumed
          ? lowConfidenceCeiling != null
            ? `Nothing about this SERP has been measured, so this row is low-confidence — not a fair fight. Its priority index cannot exceed ${lowConfidenceCeiling} until an input is measured.`
            : "Nothing about this SERP has been measured, so this row is low-confidence rather than a fair fight."
          : "Each input below is a stored fact with its date. An input nobody measured says so instead of showing a neutral default."}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-y border-border text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              <th className="px-4 py-2 font-medium">Input</th>
              <th className="px-2 py-2 text-right font-medium">Value</th>
              <th className="px-2 py-2 font-medium">Source</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const value = inputs[key] ?? null;
              const kind = sources[key] ?? "assumed";
              return (
                <tr key={key} className="border-b border-border/60 last:border-0">
                  <td className="px-4 py-1.5">
                    <span className="text-[13px]">{INPUT_LABELS[key] ?? key}</span>
                    {INPUT_MEANING[key] && (
                      <span className="block text-[10px] text-muted-foreground">{INPUT_MEANING[key]}</span>
                    )}
                  </td>
                  <td
                    className={`px-2 py-1.5 text-right font-mono text-xs ${value == null ? "text-muted-foreground" : ""}`}
                  >
                    {format(value)}
                  </td>
                  <td className={`px-2 py-1.5 text-[11px] ${SOURCE_TONE[kind]}`}>
                    {`${kind}${when(dates[key])}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {missing && missing.length > 0 && (
        <div className="border-t border-border px-4 py-2">
          <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Not measured</p>
          <ul className="mt-1 space-y-0.5">
            {missing.map((line) => (
              <li key={line} className="text-[11px] text-muted-foreground">
                {`· ${line}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
        {`Priority index ${score ?? "—"}. The value is a 0–1 input to the score, not a probability of success.`}
      </p>
    </section>
  );
}
