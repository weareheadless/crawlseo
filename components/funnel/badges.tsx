import { cn } from "@/lib/utils";
import {
  COMPLETENESS_LABELS,
  DIMENSION_LABELS,
  STATUS_LABELS,
  VERDICT_LABELS,
  sourceBadge,
} from "@/lib/funnel/labels";

/**
 * Funnel badges. Every number and every state in the new surfaces renders
 * through one of these, so provenance and lifecycle are always visible
 * (docs/seo-funnel-spine-plan.md §5 UI invariants).
 */

const TONES = {
  neutral: "border-border bg-muted/60 text-muted-foreground",
  info: "border-primary/30 bg-[var(--a-info-100)] text-[var(--a-info-600)]",
  success: "border-[var(--a-success-700)]/35 bg-[var(--a-success-300)] text-[var(--a-success-700)]",
  warning: "border-[var(--a-warning-700)]/35 bg-[var(--a-warning-300)] text-[var(--a-warning-700)]",
  danger: "border-[var(--a-danger-700)]/35 bg-[var(--a-danger-300)] text-[var(--a-danger-700)]",
  primary: "border-primary/40 bg-[var(--a-brand-100)] text-primary",
} as const;

export type Tone = keyof typeof TONES;

export function Chip({
  children,
  tone = "neutral",
  title,
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4",
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export function SourceChip({ producer }: { producer: string }) {
  return <Chip title={`Recorded by ${producer}`}>{sourceBadge(producer)}</Chip>;
}

/** Score with its declared components one hover away. Unknown is "—", never 0. */
export function ScoreBadge({ score, inputs }: { score: number | null; inputs?: unknown }) {
  const hint = inputs ? scoreHint(inputs) : undefined;
  if (score == null) {
    return (
      <span title="No score recorded for this opportunity" className="font-mono text-sm text-muted-foreground">
        —
      </span>
    );
  }
  return (
    <span
      title={hint}
      className={cn(
        "inline-flex items-baseline gap-0.5 rounded-md border px-1.5 py-0.5 font-mono text-sm font-semibold",
        score >= 40 ? TONES.success : score >= 15 ? TONES.warning : TONES.neutral
      )}
    >
      {score}
      <span className="text-[10px] font-normal opacity-70">/100</span>
    </span>
  );
}

export function scoreHint(inputs: unknown): string | undefined {
  const value = inputs as
    | {
        worth?: { volume?: number | null; ctrAtPosition?: number | null; businessValue?: number };
        winProbability?: { rankDistance?: number | null; authorityGap?: number | null };
        effort?: { playTypeBase?: number; sizeFactor?: number };
        freshness?: number;
        stability?: number;
      }
    | null;
  if (!value) return undefined;
  const parts: string[] = [];
  if (value.worth?.volume != null) parts.push(`demand ${value.worth.volume}/mo`);
  if (value.worth?.ctrAtPosition != null) parts.push(`CTR ${(value.worth.ctrAtPosition * 100).toFixed(1)}%`);
  if (value.worth?.businessValue != null) parts.push(`business value ${value.worth.businessValue}`);
  if (value.winProbability?.rankDistance != null) parts.push(`win chance ${value.winProbability.rankDistance}`);
  if (value.effort?.playTypeBase != null) parts.push(`effort ${value.effort.playTypeBase}h×${value.effort.sizeFactor ?? 1}`);
  if (value.freshness != null) parts.push(`freshness ${value.freshness.toFixed(2)}`);
  return parts.length ? `Score = worth × win chance ÷ effort — ${parts.join(" · ")}` : undefined;
}

export function CompletenessChip({ completeness }: { completeness: string }) {
  const meta = COMPLETENESS_LABELS[completeness] ?? COMPLETENESS_LABELS.none;
  const tone: Tone = completeness === "both" ? "success" : completeness === "none" ? "danger" : "warning";
  return (
    <Chip tone={tone} title={meta.hint}>
      {meta.label}
    </Chip>
  );
}

export function DimensionChip({ dimension }: { dimension: string }) {
  return <Chip>{DIMENSION_LABELS[dimension as keyof typeof DIMENSION_LABELS] ?? dimension}</Chip>;
}

export function StatusChip({ status }: { status: string }) {
  const tone: Tone =
    status === "detected" ? "info" : status === "accepted" || status === "in_progress" ? "primary" : status === "parked" ? "warning" : status === "rejected" ? "danger" : "neutral";
  return <Chip tone={tone}>{STATUS_LABELS[status] ?? status}</Chip>;
}

export function VerdictChip({ verdict }: { verdict: string }) {
  const tone: Tone =
    verdict === "verified_win" ? "success" : verdict === "regression" ? "danger" : verdict === "no_effect" ? "warning" : "neutral";
  return <Chip tone={tone}>{VERDICT_LABELS[verdict] ?? verdict}</Chip>;
}

/** A metric with its declared unit and source. No unlabelled numbers. */
export function MetricChip({ label, value, unit, source }: { label: string; value: number | null; unit: string; source: string }) {
  const display = value == null ? "—" : unit === "ratio" ? `${(value * 100).toFixed(1)}%` : `${Math.round(value * 100) / 100}`;
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground/90">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold">{display}</span>
      {unit !== "count" && unit !== "ratio" ? <span className="text-muted-foreground">{unit}</span> : null}
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground/70">{source === "first_party" ? "1st" : source === "provider" ? "prov" : "d"}</span>
    </span>
  );
}

export function relativeTime(date: Date, now = new Date()): string {
  const diff = now.getTime() - date.getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days}d ago`;
  return date.toISOString().slice(0, 10);
}
