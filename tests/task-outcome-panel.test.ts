import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { TaskOutcomePanel } from "@/components/funnel/task-outcome-panel";

/**
 * CMP-009's visible half.
 *
 * The defect this replaces was not a wrong number, it was an **absence**: the page said
 * "Baseline recorded" and showed nothing, and `OutcomeObservation` held 0 rows against 17
 * tasks. So these tests are mostly about what must be *said*:
 *
 *  - the baseline's own numbers are shown, not just its label,
 *  - a missing baseline says why and that it is not backfilled,
 *  - `measured` shows before → after with both dates and the competitor's movement,
 *  - an unsampled competitor is "unknown", never 0,
 *  - the limitation travels with every verdict.
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

const measuredBaseline = {
  unobserved: false,
  reason: null,
  query: "condos for sale",
  position: 12,
  competitorDomain: "rival.com",
  competitorPosition: 4,
  url: "https://oursite.com/condos",
};

const outcome = (over: { after?: Record<string, unknown>; verdict?: string } = {}) => ({
  id: "o1",
  verdict: over.verdict ?? "no_effect",
  measuredBy: "site-cycle",
  baselineObservedAt: new Date("2026-11-01T00:00:00Z"),
  afterObservedAt: new Date("2026-12-15T00:00:00Z"),
  baselineMetrics: measuredBaseline,
  afterMetrics: {
    position: 5,
    competitorPosition: 6,
    positionDelta: 7,
    competitorDelta: -2,
    passedCompetitor: true,
    verdict: "improved",
    reason: "Our position moved from 12 to 5 (7 places better).",
    // The same sentence the module writes, so the test checks the real wording.
    limitation:
      "A position change between two samples is not proof this work caused it: algorithm updates, seasonality and competitor action are not excluded.",
    ...over.after,
  },
});

describe("CMP-009 the outcome panel shows a measured outcome", () => {
  it("shows before and after positions with both dates", () => {
    const text = textOf(TaskOutcomePanel({ baselines: [], outcomes: [outcome()] }));
    expect(text).toContain("#12");
    expect(text).toContain("#5");
    expect(text).toContain("2026-11-01");
    expect(text).toContain("2026-12-15");
  });

  it("names the query the work was about", () => {
    const text = textOf(TaskOutcomePanel({ baselines: [], outcomes: [outcome()] }));
    expect(text).toContain("condos for sale");
  });

  it("says how far the position moved, with a direction", () => {
    const text = textOf(TaskOutcomePanel({ baselines: [], outcomes: [outcome()] }));
    expect(text).toContain("up 7 places");
  });

  it("shows the competitor's own movement and that we passed it", () => {
    const text = textOf(TaskOutcomePanel({ baselines: [], outcomes: [outcome()] }));
    expect(text).toContain("rival.com");
    expect(text).toContain("#4");
    expect(text).toContain("#6");
    expect(text).toContain("moved down 2 places");
    expect(text).toContain("We are now ahead of it");
  });

  it("states the limitation on the verdict itself", () => {
    const text = textOf(TaskOutcomePanel({ baselines: [], outcomes: [outcome()] }));
    expect(text).toContain("not proof this work caused it");
    expect(text).toContain("seasonality");
  });

  it("says a competitor was not sampled rather than reporting zero movement", () => {
    const text = textOf(
      TaskOutcomePanel({
        baselines: [],
        outcomes: [
          outcome({
            after: { competitorPosition: null, competitorDelta: null, passedCompetitor: null },
          }),
        ],
      })
    );
    // Null is not zero: an unsampled competitor has an unknown position.
    expect(text).toContain("did not sample it");
    expect(text).toContain("unknown");
    expect(text).not.toContain("held its place");
  });

  it("shows a human confirmation when one exists, and never invents one", () => {
    const confirmed = textOf(
      TaskOutcomePanel({
        baselines: [],
        outcomes: [
          outcome({
            verdict: "verified_win",
            after: { confirmedBy: "dana", confirmedAt: "2026-12-20T00:00:00.000Z" },
          }),
        ],
      })
    );
    expect(confirmed).toContain("Confirmed by dana");
    expect(confirmed).toContain("2026-12-20");
    expect(confirmed).toContain("Verified win");

    const unconfirmed = textOf(TaskOutcomePanel({ baselines: [], outcomes: [outcome()] }));
    expect(unconfirmed).not.toContain("Confirmed by");
  });
});

describe("CMP-009 the outcome panel states the absence", () => {
  it("says a missing baseline was not captured and is not backfilled", () => {
    const text = textOf(TaskOutcomePanel({ baselines: [], outcomes: [] }));
    expect(text).toContain("No baseline was recorded");
    expect(text).toContain("reported as unmeasured, never as a win");
    expect(text).toContain("not backfilled");
  });

  it("shows the baseline's own numbers while the window is open, not just a label", () => {
    // The defect: the page said "Baseline recorded" and rendered nothing, so a client
    // could not see the position the work was measured against.
    const text = textOf(
      TaskOutcomePanel({
        baselines: [{ id: "b1", observedAt: new Date("2026-11-01T00:00:00Z"), metrics: measuredBaseline }],
        outcomes: [],
      })
    );
    expect(text).toContain("#12");
    expect(text).toContain("condos for sale");
    expect(text).toContain("2026-11-01");
    expect(text).toContain("rival.com");
    expect(text).toContain("#4");
    // And it says a verdict is not being guessed in the meantime.
    expect(text).toContain("28 days after delivery");
  });

  it("does not print a fabricated number for a baseline that measured nothing", () => {
    const text = textOf(
      TaskOutcomePanel({
        baselines: [
          {
            id: "b1",
            observedAt: new Date("2026-11-01T00:00:00Z"),
            metrics: { unobserved: true, reason: "No sample names this query.", position: null },
          },
        ],
        outcomes: [],
      })
    );
    expect(text).toContain("No sample names this query");
    expect(text).toContain("unmeasured rather than as no change");
    expect(text).not.toContain("#");
  });

  it("counts the outcome as measured only when one exists", () => {
    // A panel with a baseline and no verdict must not read like a result.
    const pending = textOf(
      TaskOutcomePanel({
        baselines: [{ id: "b1", observedAt: new Date("2026-11-01T00:00:00Z"), metrics: measuredBaseline }],
        outcomes: [],
      })
    );
    expect(pending).not.toContain("Moved up");
    expect(pending).not.toContain("No material change");
  });
});
