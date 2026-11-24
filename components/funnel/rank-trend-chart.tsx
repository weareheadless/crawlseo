"use client";

import {
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { RankChart } from "@/lib/funnel/rank-series";

/**
 * CMP-004: the rank trend, drawn as the two series it actually is.
 *
 * Everything here follows from one rule: a weekly Search Console average and a
 * sampled SERP position are different measurements, so they are never joined into
 * one line and never interpolated. The weekly line is the trend; the sampled dots
 * are independent checks that appear on their own dates.
 *
 * Y is inverted — position 1 at the top — because lower is better and a chart that
 * goes *up* when you win is a chart people misread.
 */

const WEEKLY = "#A78BFA";
const SAMPLED = "#34D399";
const axis = "#71717A";
const grid = "rgba(255,255,255,0.06)";

function formatWeek(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type ChartRow = {
  date: string;
  weekly: number | null;
  sampled: number | null;
  impressions?: number;
};

function toRows(chart: RankChart): ChartRow[] {
  const rows = new Map<string, ChartRow>();
  for (const point of chart.weekly) {
    rows.set(point.week, { date: point.week, weekly: point.position, sampled: null, impressions: point.impressions });
  }
  for (const point of chart.sampled) {
    const existing = rows.get(point.date);
    if (existing) {
      existing.sampled = point.position;
      continue;
    }
    rows.set(point.date, { date: point.date, weekly: null, sampled: point.position });
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function RankTrendChart({ chart, title }: { chart: RankChart; title?: string }) {
  if (chart.state === "empty") {
    return (
      <div className="panel px-4 py-6">
        <p className="text-sm font-medium text-foreground">No position history yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Search Console has not recorded any impressions for this query, so there is no position to chart.
        </p>
      </div>
    );
  }

  if (chart.state === "one_week") {
    const only = chart.weekly[0];
    return (
      <div className="panel px-4 py-6">
        <p className="text-sm font-medium text-foreground">One week of history: no trend yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The week of {formatWeek(only.week)} put this query at position {only.position} on{" "}
          {only.impressions.toLocaleString()} impressions. A second week is what turns a point into a trend.
        </p>
      </div>
    );
  }

  const rows = toRows(chart);
  const hasSampled = chart.sampled.length > 0;
  const positions = rows.flatMap((row) => [row.weekly, row.sampled].filter((value): value is number => value != null));
  const max = Math.max(...positions, 10);
  // Give the axis headroom so a position of 1 is not glued to the frame.
  const domain: [number, number] = [1, Math.ceil(max * 1.1)];

  return (
    <div className="panel p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="font-heading text-sm font-semibold text-foreground">{title ?? "Position over time"}</h3>
          <p className="text-[11px] text-muted-foreground">
            Weekly Search Console average, impressions-weighted · lower is better
          </p>
        </div>
        <div className="flex flex-wrap gap-4 text-[11px]">
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <span className="size-2 rounded-full" style={{ background: WEEKLY }} /> Search Console weekly
          </span>
          {hasSampled && (
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <span className="size-2 rounded-full" style={{ background: SAMPLED }} /> Sampled SERP
            </span>
          )}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={grid} strokeDasharray="4 6" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatWeek}
            tick={{ fill: axis, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            minTickGap={26}
          />
          <YAxis
            reversed
            domain={domain}
            allowDecimals={false}
            tick={{ fill: axis, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={34}
          />
          <Tooltip
            contentStyle={{
              background: "#161618",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 14,
              fontSize: 12,
              boxShadow: "0 16px 40px rgba(0,0,0,0.55)",
              color: "#F4F4F5",
            }}
            labelFormatter={(label) => formatWeek(String(label))}
            formatter={(value, name, entry) => {
              if (name === "weekly") {
                const impressions = (entry?.payload as ChartRow | undefined)?.impressions;
                return [
                  `${value}${impressions == null ? "" : ` on ${impressions.toLocaleString()} impressions`}`,
                  "Search Console weekly",
                ];
              }
              return [String(value), "Sampled SERP"];
            }}
          />
          <Line
            type="linear"
            dataKey="weekly"
            stroke={WEEKLY}
            strokeWidth={2}
            dot={{ r: 2.5, fill: WEEKLY, strokeWidth: 0 }}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Scatter dataKey="sampled" fill={SAMPLED} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>

      {chart.suppressed.length > 0 && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          {chart.suppressed.length} week{chart.suppressed.length === 1 ? "" : "s"} not plotted: no query in the series
          cleared the impression floor that week, so there was no position to weight.
        </p>
      )}
    </div>
  );
}
