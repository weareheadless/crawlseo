/**
 * DS-05: one semantic per field (docs/seo-funnel-spine-plan.md §4, invariant 7).
 *
 * Every metric the product displays declares four things:
 *   - `source`  who produced it (Search Console, our crawler, DataForSEO, …)
 *   - `unit`    what the number means
 *   - `state`   how much to trust it right now
 *   - `semantic` what question it answers
 *
 * Two metrics that answer different questions are never merged under one label,
 * and a provider measurement never silently replaces a first-party one. Where a
 * series must be chosen (the rank-history overlay), the choice is declared in
 * one place and returned with the data so the UI can label it.
 */

export type MetricSource = "gsc" | "crawler" | "dataforseo" | "internal" | "manual";

export type MetricState = "fresh" | "stale" | "sampled" | "estimated" | "unknown";

export type MetricSemantic =
  /** Search Console average position for a query: impressions-weighted, not a SERP rank. */
  | "gsc_average_position"
  /** A sampled rank observed in a SERP snapshot at a point in time. */
  | "serp_sampled_rank"
  /** Keyword volume estimate from a provider dataset. */
  | "provider_volume"
  /** Clicks recorded by Search Console. */
  | "gsc_clicks"
  /** Impressions recorded by Search Console. */
  | "gsc_impressions"
  /** Click-through rate derived from clicks / impressions. */
  | "gsc_ctr"
  /** A count of pages or issues observed by our own crawl. */
  | "crawl_count"
  /** Core Web Vital measured in the field. */
  | "field_vital"
  /** Whether an AI answer cited us, at a point in time. */
  | "ai_citation_presence";

export type MetricDeclaration = {
  semantic: MetricSemantic;
  source: MetricSource;
  unit: string;
  /** Human label. Two declarations must never share a label with different semantics. */
  label: string;
  /** One sentence explaining what the number does and does not mean. */
  caveat: string;
};

export const METRICS: Record<MetricSemantic, MetricDeclaration> = {
  gsc_average_position: {
    semantic: "gsc_average_position",
    source: "gsc",
    unit: "position",
    label: "Search Console average position",
    caveat: "Impressions-weighted average across all impressions, not the rank a searcher sees.",
  },
  serp_sampled_rank: {
    semantic: "serp_sampled_rank",
    source: "dataforseo",
    unit: "position",
    label: "Sampled SERP rank",
    caveat: "One observation at one time and place; it can differ from the average position.",
  },
  provider_volume: {
    semantic: "provider_volume",
    source: "dataforseo",
    unit: "searches/month",
    label: "Estimated search volume",
    caveat: "A provider estimate, not observed traffic.",
  },
  gsc_clicks: {
    semantic: "gsc_clicks",
    source: "gsc",
    unit: "clicks",
    label: "Clicks",
    caveat: "Clicks recorded by Search Console for the selected property.",
  },
  gsc_impressions: {
    semantic: "gsc_impressions",
    source: "gsc",
    unit: "impressions",
    label: "Impressions",
    caveat: "Impressions recorded by Search Console; not a ranking signal.",
  },
  gsc_ctr: {
    semantic: "gsc_ctr",
    source: "gsc",
    unit: "ratio",
    label: "Click-through rate",
    caveat: "Clicks divided by impressions over the same window.",
  },
  crawl_count: {
    semantic: "crawl_count",
    source: "crawler",
    unit: "count",
    label: "Crawl count",
    caveat: "What our crawler saw on its last run; the live site may have changed since.",
  },
  field_vital: {
    semantic: "field_vital",
    source: "gsc",
    unit: "ms",
    label: "Field Core Web Vital",
    caveat: "Measured from real visits, so it lags a deploy by up to 28 days.",
  },
  ai_citation_presence: {
    semantic: "ai_citation_presence",
    source: "dataforseo",
    unit: "boolean",
    label: "AI citation",
    caveat: "Whether one answer cited us when asked; absence is a measurement, not proof of invisibility.",
  },
};

/** Two series that must never be collapsed into one line. */
export type RankSeries = "gsc_average" | "serp_sampled";

export type RankPoint = {
  date: string;
  position: number;
  clicks: number;
  impressions: number;
  /** Which series this point came from. Declared, never inferred by the UI. */
  series: RankSeries;
  semantic: MetricSemantic;
};

export type RankHistory = {
  points: RankPoint[];
  /** Series present in the response, so a consumer can label or split them. */
  series: RankSeries[];
  /** True when more than one series exists: the caller must not draw one line. */
  mixed: boolean;
};

/**
 * Build rank history without the old unlabelled overlay.
 *
 * The previous implementation let a `RankSnapshot` row silently overwrite a
 * Search Console row for the same date, so the chart mixed a sampled rank with
 * an average position under one label. Now both series are kept and tagged; a
 * consumer that wants one line picks a series explicitly.
 */
export function buildRankHistory(input: {
  gsc: Array<{ date: Date; position: number; clicks: number; impressions: number }>;
  sampled: Array<{ date: Date; position: number; clicks: number; impressions: number }>;
}): RankHistory {
  const points: RankPoint[] = [];
  const byDate = new Map<string, RankPoint>();

  for (const row of input.gsc) {
    const date = row.date.toISOString().split("T")[0];
    const existing = byDate.get(date);
    if (existing) {
      const impressions = existing.impressions + row.impressions;
      existing.position =
        impressions === 0
          ? row.position
          : (existing.position * existing.impressions + row.position * row.impressions) / impressions;
      existing.clicks += row.clicks;
      existing.impressions = impressions;
      continue;
    }
    const point: RankPoint = {
      date,
      position: row.position,
      clicks: row.clicks,
      impressions: row.impressions,
      series: "gsc_average",
      semantic: "gsc_average_position",
    };
    byDate.set(date, point);
    points.push(point);
  }

  for (const row of input.sampled) {
    const date = row.date.toISOString().split("T")[0];
    const point: RankPoint = {
      date,
      position: row.position,
      clicks: row.clicks,
      impressions: row.impressions,
      series: "serp_sampled",
      semantic: "serp_sampled_rank",
    };
    points.push(point);
  }

  const series = [...new Set(points.map((point) => point.series))].sort();
  return {
    points: points.sort((a, b) => a.date.localeCompare(b.date)),
    series,
    mixed: series.length > 1,
  };
}

/**
 * Age a state from freshness. Stale is explicit rather than silently fresh:
 * Search Console lags, crawls age, and a sampled rank is only true for its moment.
 */
export function stateForAge(observedAt: Date, opts: { maxAgeHours: number; now?: Date }): MetricState {
  const now = opts.now ?? new Date();
  const ageHours = (now.getTime() - observedAt.getTime()) / 3_600_000;
  if (Number.isNaN(ageHours)) return "unknown";
  if (ageHours < 0) return "unknown";
  return ageHours <= opts.maxAgeHours ? "fresh" : "stale";
}

/** The declared state a source can honestly claim, independent of age. */
export function declaredState(semantic: MetricSemantic): MetricState {
  switch (semantic) {
    case "serp_sampled_rank":
      return "sampled";
    case "provider_volume":
      return "estimated";
    case "field_vital":
      return "stale";
    default:
      return "fresh";
  }
}

/**
 * Guard: the same label must never mean two different things. Used by tests and
 * by the metric registry itself so a new metric cannot quietly collide.
 */
export function labelCollisions(metrics: Record<string, MetricDeclaration> = METRICS): string[] {
  const byLabel = new Map<string, MetricSemantic[]>();
  for (const metric of Object.values(metrics)) {
    byLabel.set(metric.label, [...(byLabel.get(metric.label) ?? []), metric.semantic]);
  }
  return [...byLabel.entries()]
    .filter(([, semantics]) => semantics.length > 1)
    .map(([label, semantics]) => `${label}: ${semantics.join(", ")}`);
}
