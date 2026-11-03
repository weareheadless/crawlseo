import { METRICS, type MetricSemantic } from "@/lib/funnel/metric-semantics";
import { cn } from "@/lib/utils";

/**
 * DS-05 in the UI: a column header that says where the number came from and how
 * much to trust it. Used on keyword research, domain overview and backlinks so
 * a provider estimate is never read as a measured fact.
 */

const SOURCE_LABEL: Record<string, string> = {
  gsc: "GSC",
  crawler: "Crawler",
  dataforseo: "DataForSEO",
  internal: "Internal",
  manual: "Manual",
};

const STATE_TONE: Record<string, string> = {
  fresh: "text-[var(--a-success-700)]",
  sampled: "text-[var(--a-info-600)]",
  estimated: "text-[var(--a-warning-700)]",
  stale: "text-[var(--a-warning-700)]",
  unknown: "text-muted-foreground",
};

export function MetricHeader({
  semantic,
  label,
  align = "left",
  className,
}: {
  semantic: MetricSemantic;
  /** Override the visible label; the declared label is the default. */
  label?: string;
  align?: "left" | "right";
  className?: string;
}) {
  const metric = METRICS[semantic];
  const state = metric.source === "dataforseo" ? "estimated" : metric.source === "crawler" ? "fresh" : "fresh";
  return (
    <th
      scope="col"
      title={`${metric.caveat} (source: ${SOURCE_LABEL[metric.source] ?? metric.source}, unit: ${metric.unit})`}
      className={cn(
        "px-4 py-2 font-medium text-muted-foreground",
        align === "right" ? "text-right" : "text-left",
        className
      )}
    >
      <span className="inline-flex flex-col gap-0.5">
        <span>{label ?? metric.label}</span>
        <span className="flex items-center gap-1 text-[9px] font-normal uppercase tracking-wide">
          <span className="rounded bg-muted/60 px-1 py-px">{SOURCE_LABEL[metric.source] ?? metric.source}</span>
          <span className={STATE_TONE[state] ?? "text-muted-foreground"}>{state}</span>
        </span>
      </span>
    </th>
  );
}

/** Inline provenance for a single value that is not in a table. */
export function MetricSource({ semantic, className }: { semantic: MetricSemantic; className?: string }) {
  const metric = METRICS[semantic];
  return (
    <span
      title={metric.caveat}
      className={cn("text-[10px] uppercase tracking-wide text-muted-foreground", className)}
    >
      {SOURCE_LABEL[metric.source] ?? metric.source}
    </span>
  );
}
