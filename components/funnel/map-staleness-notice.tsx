import type { MapStaleness } from "@/lib/research/map-staleness";

/**
 * Why the board may not reflect the latest evidence.
 *
 * A topic map is a projection of the evidence that existed when it ran. When a
 * map is older than its bundle, or was built with no bundle at all, its clusters
 * can carry zero queries — and on the board that looks exactly like a site with
 * no demand. This notice exists so those two states are never confused: it says
 * which one it is, what it means for the rows below, and what fixes it.
 *
 * It is a plain server component: no state, no dismiss button. A warning that
 * can be dismissed is a warning that gets dismissed.
 */
export function MapStalenessNotice({
  state,
  detail,
  month,
  bundleIsPartial = false,
  bundleCompleteness = null,
}: {
  state: Exclude<MapStaleness, "current">;
  detail: string;
  month: string;
  /**
   * The bundle being compared against collected only some of its sections.
   *
   * A partial bundle is not an absent one, and the difference is what the reader should
   * act on: complete the collection rather than query why nothing was bought. The share
   * matters too — one missing section of eight is a gap to fill, five of eight is a run to
   * redo.
   */
  bundleIsPartial?: boolean;
  /** `stored/planned` sections, so the banner can say how incomplete rather than that it is. */
  bundleCompleteness?: { stored: number; planned: number; short: string[] } | null;
}) {
  const title =
    state === "no-bundle"
      ? "This map was built without paid evidence"
      : bundleIsPartial
        ? "This map is older than its evidence, and that evidence is incomplete"
        : "This map is older than its evidence";
  const tone =
    state === "no-bundle"
      ? "border-warning/40 bg-warning/5 text-warning-foreground"
      : "border-warning/40 bg-warning/5 text-warning-foreground";

  return (
    <div role="status" className={`mb-6 rounded-xl border px-4 py-3 ${tone}`}>
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
      {bundleCompleteness ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {/* The number, not just the word. A run that is one section short is usable; one
              that is half empty is not, and the reader cannot tell from "partial" alone. */}
          Evidence collected: <span className="font-medium">{bundleCompleteness.stored} of {bundleCompleteness.planned}</span> sections
          {bundleCompleteness.short.length > 0 ? ` (short on ${bundleCompleteness.short.join(", ")})` : ""}.
        </p>
      ) : null}
      <p className="mt-1 text-xs text-muted-foreground">
        The rows below were drafted from that map, so a cluster with no work attached may mean the map never
        saw the demand rather than the site not having any. Rebuild it for {month}:
      </p>
      <code className="mt-2 block overflow-x-auto rounded-lg bg-muted/60 px-3 py-2 font-mono text-[11px]">
        npx tsx scripts/research-pipeline.ts --site &lt;siteId&gt; --month {month} --execute --approval
        &lt;reference&gt; --refresh
      </code>
    </div>
  );
}
