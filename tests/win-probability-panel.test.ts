import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { WinProbabilityPanel } from "@/components/funnel/win-probability-panel";

/**
 * CMP-012's visible half.
 *
 * The acceptance asks for three things per winnability input: the value, its source, and the
 * date it was measured. The panel exists because a typed-in `0.5` and a measured SERP looked
 * identical on the board, and a person had no way to tell them apart.
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
  winProbability: {
    rankDistance: 0.8,
    authorityGap: 0.24,
    pageStrength: 0.67,
    serpCompetition: 0.42,
    playTypeFactor: 0.6,
  },
  source: {
    rankDistance: "measured" as const,
    authorityGap: "measured" as const,
    pageStrength: "measured" as const,
    serpCompetition: "measured" as const,
    playTypeFactor: "assumed" as const,
  },
  observedAt: {
    rankDistance: "2026-11-01T00:00:00.000Z",
    authorityGap: "2026-11-24T00:00:00.000Z",
    pageStrength: "2026-11-20T00:00:00.000Z",
    serpCompetition: "2026-11-01T00:00:00.000Z",
  },
  missing: [],
  score: 45,
};

describe("CMP-012 the winnability panel shows value, source and date", () => {
  it("shows each input's value", () => {
    const text = textOf(WinProbabilityPanel({ ...measured }));
    expect(text).toContain("0.8");
    expect(text).toContain("0.24");
    expect(text).toContain("0.67");
    expect(text).toContain("0.42");
  });

  it("shows each input's source", () => {
    const text = textOf(WinProbabilityPanel({ ...measured }));
    expect(text).toContain("measured");
    // The play-type factor is the one declared constant, and it says so.
    expect(text).toContain("assumed");
  });

  it("shows the date each input was measured", () => {
    const text = textOf(WinProbabilityPanel({ ...measured }));
    expect(text).toContain("2026-11-24");
    expect(text).toContain("2026-11-20");
    expect(text).toContain("2026-11-01");
  });

  it("counts how many of the measurable inputs were actually measured", () => {
    const text = textOf(WinProbabilityPanel({ ...measured }));
    expect(text).toContain("4 of 4 measured");
  });

  it("says an unmeasured input is not measured, rather than showing a neutral number", () => {
    const text = textOf(
      WinProbabilityPanel({
        winProbability: { rankDistance: 0.8, authorityGap: null, pageStrength: null, serpCompetition: null, playTypeFactor: 0.6 },
        source: { rankDistance: "measured", authorityGap: "assumed", pageStrength: "assumed", serpCompetition: "assumed", playTypeFactor: "assumed" },
        observedAt: {},
        missing: ["authority: no measured referring-domain set for us and a competitor"],
        score: 14,
        lowConfidenceCeiling: 40,
      })
    );
    expect(text).toContain("not measured");
    // The critical guard: a missing input must not render as 0.5, which is what made the
    // old board look decisive.
    expect(text).not.toContain("0.5");
    expect(text).toContain("1 of 4 measured");
  });

  it("names what is missing, so the gap is actionable", () => {
    const text = textOf(
      WinProbabilityPanel({
        winProbability: { rankDistance: 0.8, authorityGap: null, pageStrength: null, serpCompetition: null, playTypeFactor: 0.6 },
        source: { rankDistance: "measured" },
        observedAt: {},
        missing: [
          "authority: no measured referring-domain set for us and a competitor",
          "page strength: our target page has not been crawled",
        ],
        score: 14,
      })
    );
    expect(text).toContain("Not measured");
    expect(text).toContain("referring-domain set");
    expect(text).toContain("has not been crawled");
  });

  it("says a low-confidence row is capped, not that it is a fair fight", () => {
    const text = textOf(
      WinProbabilityPanel({
        winProbability: { rankDistance: null, authorityGap: null, pageStrength: null, serpCompetition: null, playTypeFactor: 0.6 },
        source: { playTypeFactor: "assumed" },
        observedAt: {},
        missing: ["the opportunity names no query"],
        score: 40,
        lowConfidenceCeiling: 40,
      })
    );
    expect(text).toContain("cannot exceed 40");
    expect(text).toContain("low-confidence");
    expect(text).toContain("not a fair fight");
  });

  it("labels the value as an input, not a probability of success", () => {
    const text = textOf(WinProbabilityPanel({ ...measured }));
    expect(text).toContain("not a probability of success");
  });

  it("renders nothing when no winnability input was recorded at all", () => {
    expect(WinProbabilityPanel({ winProbability: null, source: null, observedAt: null, missing: null, score: 5 })).toBeNull();
  });
});
