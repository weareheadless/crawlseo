import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { ImpactPanel } from "@/components/funnel/impact-panel";

/**
 * CMP-005's visible half.
 *
 * The acceptance is specific: the detail shows the volume, its source, the
 * observation date and the incremental clicks; and a query with no measurement
 * shows the words "not measured" and no number. A panel that printed `0` for an
 * unmeasured query would say "worthless" when it means "unknown".
 */

type Node = ReactElement<Record<string, unknown>>;

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

const measured = {
  worth: {
    volume: 480,
    volumeSource: "provider",
    currentPosition: 14,
    targetPosition: 8,
    windowDays: 28,
    observedCtr: 0.005,
    observedImpressions: 40,
  },
  assessment: {
    kind: "measured",
    incrementalClicksPerMonth: 3.4,
    assumptions: { currentCtr: 0.005, targetCtr: 0.04 },
    limitations: ["reachable impressions are the impressions already observed for this query/page, not the whole market"],
  },
};

describe("CMP-005 impact panel", () => {
  it("shows the volume, its source and the observation date", () => {
    const text = textOf(ImpactPanel({ scoreInputs: measured, observedAt: new Date("2026-11-23T00:00:00Z") }));
    expect(text).toContain("480 /mo");
    expect(text).toContain("provider volume");
    expect(text).toContain("2026-11-23");
  });

  it("shows the incremental clicks per month", () => {
    const text = textOf(ImpactPanel({ scoreInputs: measured }));
    expect(text).toContain("3.4 /mo");
  });

  it("lists the assumptions the number rests on", () => {
    const text = textOf(ImpactPanel({ scoreInputs: measured }));
    expect(text).toContain("What this assumes");
    expect(text).toContain("reachable impressions");
  });

  it("shows the position pair it is estimating between", () => {
    const text = textOf(ImpactPanel({ scoreInputs: measured }));
    // JSX renders `#14 → #8` with the arrow's own spacing; normalise before matching.
    expect(text.replace(/\s+/g, " ")).toContain("#14 → #8");
    expect(text).toContain("0.5%");
    expect(text).toContain("4.0%");
  });

  it("says not measured, and shows no number, when nothing was measured", () => {
    const text = textOf(
      ImpactPanel({
        scoreInputs: {
          worth: { volume: null, volumeSource: "unknown", currentPosition: null, targetPosition: 8 },
          assessment: {
            kind: "hypothesis",
            incrementalClicksPerMonth: null,
            limitations: ["no demand evidence: neither a provider volume nor first-party impressions"],
          },
        },
      })
    );
    expect(text).toContain("not measured");
    // The failure this guards against: a fabricated "0 /mo".
    expect(text).not.toContain("0 /mo");
    expect(text).toContain("no provider volume and no impressions");
  });

  it("does not claim a measured demand when the source is missing", () => {
    // A row whose worth has a volume but no declared source is not a measurement;
    // showing the number without its provenance is how a proxy becomes a fact.
    const text = textOf(ImpactPanel({ scoreInputs: { worth: { volume: 900, currentPosition: 5 } } }));
    expect(text).toContain("not measured");
  });

  it("labels an impressions-only basis as first-party, not as a search volume", () => {
    const text = textOf(
      ImpactPanel({
        scoreInputs: {
          worth: { volume: 40, volumeSource: "first_party", observedImpressions: 40, currentPosition: 14, targetPosition: 8 },
          assessment: { kind: "measured", incrementalClicksPerMonth: 0.6 },
        },
      })
    );
    expect(text).toContain("impressions observed");
    expect(text).toContain("Measured");
  });
});
