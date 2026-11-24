import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { RankTrendChart } from "@/components/funnel/rank-trend-chart";
import type { RankChart } from "@/lib/funnel/rank-series";

/**
 * CMP-004's rendering contract, checked on the element tree.
 *
 * The chart is a pure function of its props (no hooks, no fetch), so the tree it
 * returns can be inspected without a DOM. What matters for the acceptance is not
 * that recharts draws something, but that:
 *  - two series are drawn separately and never merged into one line,
 *  - the legend names the source of each,
 *  - one week is an empty state, not a flat line,
 *  - nothing is drawn as a position when there is nothing to draw.
 */

type Node = ReactElement<Record<string, unknown>>;

/**
 * Recharts components are wrapped (`memo`/`forwardRef`), so `element.type` is
 * often an object rather than a function. Resolving the display name through the
 * wrapper is what makes the tree readable without a DOM.
 */
function typeName(type: unknown): string {
  if (typeof type === "string") return type;
  if (typeof type === "function") return (type as { name?: string }).name ?? "";
  if (type && typeof type === "object") {
    const wrapper = type as { displayName?: string; name?: string; render?: { name?: string }; type?: unknown };
    return wrapper.displayName ?? wrapper.name ?? wrapper.render?.name ?? typeName(wrapper.type);
  }
  return "";
}

function walk(node: unknown, visit: (element: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!isValidElement(node)) return;
  visit(node as Node);
  const props = (node as Node).props;
  for (const value of Object.values(props)) {
    if (Array.isArray(value) || isValidElement(value)) walk(value, visit);
  }
}

function collect(node: unknown, name: string): Node[] {
  const found: Node[] = [];
  walk(node, (element) => {
    if (typeName(element.type) === name) found.push(element);
  });
  return found;
}

/** Every string and number in the tree, in render order. */
function textOf(node: unknown): string {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isValidElement(value)) return;
    visit((value as Node).props.children);
  };
  visit(node);
  return parts.join(" ");
}

const twoWeeks: RankChart = {
  weekly: [
    { week: "2026-11-16", position: 12.4, impressions: 120, clicks: 2, days: 7 },
    { week: "2026-11-23", position: 9.8, impressions: 160, clicks: 3, days: 7 },
  ],
  sampled: [{ date: "2026-11-20", position: 11, query: "condos for sale" }],
  suppressed: [],
  state: "trend",
};

describe("CMP-004 rank trend rendering", () => {
  it("draws the weekly series as a line and the sampled series as points", () => {
    const tree = RankTrendChart({ chart: twoWeeks }) as unknown;
    const lines = collect(tree, "Line");
    const scatter = collect(tree, "Scatter");
    expect(lines).toHaveLength(1);
    expect(lines[0].props.dataKey).toBe("weekly");
    expect(scatter).toHaveLength(1);
    expect(scatter[0].props.dataKey).toBe("sampled");
  });

  it("never joins the two series: each is its own component with its own key", () => {
    const tree = RankTrendChart({ chart: twoWeeks }) as unknown;
    const lines = collect(tree, "Line");
    const scatter = collect(tree, "Scatter");
    const lineKeys = lines.map((line) => line.props.dataKey);
    const scatterKeys = scatter.map((point) => point.props.dataKey);
    expect(lineKeys).toEqual(["weekly"]);
    expect(scatterKeys).toEqual(["sampled"]);
    // A sampled point drawn on the weekly line would mean one merged series.
    expect(lineKeys).not.toContain("sampled");
  });

  it("names the source of each series in the legend", () => {
    const tree = RankTrendChart({ chart: twoWeeks }) as unknown;
    const text = textOf(tree);
    expect(text).toContain("Search Console weekly");
    expect(text).toContain("Sampled SERP");
  });

  it("inverts the axis so a better position is higher", () => {
    const tree = RankTrendChart({ chart: twoWeeks }) as unknown;
    const axis = collect(tree, "YAxis");
    expect(axis[0].props.reversed).toBe(true);
  });

  it("says one week is no trend yet, instead of drawing a flat line", () => {
    const tree = RankTrendChart({
      chart: { weekly: [twoWeeks.weekly[0]], sampled: [], suppressed: [], state: "one_week" },
    }) as unknown;
    const text = textOf(tree);
    expect(text).toContain("One week of history");
    expect(text).toContain("no trend yet");
    // Not a chart at all.
    expect(collect(tree, "Line")).toHaveLength(0);
    expect(collect(tree, "ComposedChart")).toHaveLength(0);
  });

  it("draws nothing when there is no position, rather than a zero line", () => {
    const tree = RankTrendChart({ chart: { weekly: [], sampled: [], suppressed: [], state: "empty" } }) as unknown;
    expect(textOf(tree)).toContain("No position history yet");
    expect(collect(tree, "ComposedChart")).toHaveLength(0);
  });

  it("reports the weeks it refused to plot", () => {
    const tree = RankTrendChart({
      chart: { ...twoWeeks, suppressed: [{ week: "2026-11-09", impressions: 2 }] },
    }) as unknown;
    expect(textOf(tree)).toContain("not plotted");
  });

  it("omits the sampled legend when there is no sampled series", () => {
    const tree = RankTrendChart({ chart: { ...twoWeeks, sampled: [] } }) as unknown;
    expect(textOf(tree)).not.toContain("Sampled SERP");
  });
});
