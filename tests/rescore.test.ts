import { describe, expect, it, vi } from "vitest";

import { rescoreAllProjects, rescoreProjectOpportunities } from "@/lib/funnel/rescore";
import { computeScore, type ScoreInputs } from "@/lib/funnel/scoring";

/**
 * `scoreValue` is computed once inside `writeOpportunity` and never again, so a row
 * keeps the score it had when first written. When a later bundle supplies impressions,
 * a competitor position or measured reach, the number does not move — which is why
 * "re-run the month and the board reorders" did not happen, and why any one-off backfill
 * would be correct for a day and then decay.
 *
 * The trigger, decided 2026-11-25: **pipeline end plus a nightly sweep**. This file
 * pins the entry point those two callers share.
 */

function inputs(businessValue = 0.85): ScoreInputs {
  return {
    worth: {
      change: "New Spanish article: apnea as a sport",
      volume: 1300,
      intentFit: 0.35,
      readiness: "actionable",
      technical: false,
      windowDays: 28,
      measurement: "observed_baseline",
      targetPages: ["https://example.test/es/apnea"],
      benefitTrack: "organic_growth",
      intervention: "create_asset",
      volumeSource: "provider",
      businessValue,
      businessValueSource: "cluster",
      targetPosition: 10,
      currentPosition: null,
      observedImpressions: 0,
      unmeasured: false,
    },
    effort: { sizeFactor: 1, playTypeBase: 8 },
    freshness: 0.9,
    stability: 0.8,
    evidenceCompleteness: "both",
    winProbability: {
      authorityGap: null,
      pageStrength: null,
      rankDistance: null,
      playTypeFactor: 0.6,
      serpCompetition: null,
    },
    winProbabilitySource: {
      authorityGap: "assumed",
      pageStrength: "assumed",
      rankDistance: "assumed",
      playTypeFactor: "assumed",
      serpCompetition: "assumed",
    },
  } as unknown as ScoreInputs;
}

type Row = {
  id: string;
  title: string;
  status: string;
  scoreValue: number | null;
  scoreInputs: unknown;
  evidenceClass?: string;
};

/** A client that records updates, like the mocks the rest of the funnel tests use. */
function mockDb(rows: Row[]) {
  const updates: { where: { id: string }; data: Record<string, unknown> }[] = [];
  return {
    updates,
    db: {
      opportunity: {
        findMany: vi.fn(async () => rows),
        update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push(args);
          const row = rows.find((candidate) => candidate.id === args.where.id);
          if (row) Object.assign(row, args.data);
          return row;
        }),
      },
      site: { findMany: vi.fn(async () => []) },
    },
  };
}

describe("a stored score follows its inputs", () => {
  it("raises a row whose inputs improved since it was written", async () => {
    // The row was scored when its business value was unknown; the cluster has since been
    // rated. Same work, different number.
    const stale = computeScore(inputs(0.25)).scoreValue;
    const fresh = computeScore(inputs(0.85)).scoreValue;
    expect(fresh).toBeGreaterThan(stale);

    const { db, updates } = mockDb([
      { id: "op-1", title: "apnea article", status: "detected", scoreValue: stale, scoreInputs: inputs(0.85) },
    ]);
    const result = await rescoreProjectOpportunities(db as never, { projectId: "p1" });

    expect(result.changed).toBe(1);
    expect(result.movements[0]).toMatchObject({ id: "op-1", from: stale, to: fresh, delta: fresh - stale });
    expect(updates[0].data.scoreValue).toBe(fresh);
  });

  it("writes lastScoredAt, so a board can say how stale it is", async () => {
    // It was written at first insert and read by nothing. A re-score that does not
    // stamp it leaves the same silence in place.
    const stale = computeScore(inputs(0.25)).scoreValue;
    const { db, updates } = mockDb([
      { id: "op-1", title: "t", status: "detected", scoreValue: stale, scoreInputs: inputs(0.85) },
    ]);
    await rescoreProjectOpportunities(db as never, { projectId: "p1" });
    expect(updates[0].data.lastScoredAt).toBeInstanceOf(Date);
  });

  it("is idempotent: a second run changes nothing", async () => {
    // The property the nightly sweep depends on. A job that rewrites rows every run
    // makes "did anything change?" unanswerable. The stored row has to carry the class
    // as well as the score, because both are compared.
    const scored = computeScore(inputs());
    const { db, updates } = mockDb([
      {
        id: "op-1",
        title: "t",
        status: "detected",
        scoreValue: scored.scoreValue,
        evidenceClass: scored.evidenceClass,
        scoreInputs: inputs(),
      },
    ]);
    const first = await rescoreProjectOpportunities(db as never, { projectId: "p1" });
    expect(first.changed).toBe(0);
    expect(first.unchanged).toBe(1);
    expect(updates).toHaveLength(0);
  });

  it("writes nothing in a dry run", async () => {
    const stale = computeScore(inputs(0.25)).scoreValue;
    const { db, updates } = mockDb([
      { id: "op-1", title: "t", status: "detected", scoreValue: stale, scoreInputs: inputs(0.85) },
    ]);
    const result = await rescoreProjectOpportunities(db as never, { projectId: "p1", dryRun: true });
    expect(result.changed).toBe(1);
    expect(updates).toHaveLength(0);
  });
});

describe("a re-score never moves work a person owns", () => {
  it.each(["accepted", "in_progress", "delivered"])("leaves a %s row alone", async (status) => {
    // That row carries a task and a brief chosen at its current priority. Moving the
    // number under it silently is the same defect as the backfill rewriting them.
    const stale = computeScore(inputs(0.25)).scoreValue;
    const { db, updates } = mockDb([
      { id: "op-1", title: "t", status, scoreValue: stale, scoreInputs: inputs(0.85) },
    ]);
    const result = await rescoreProjectOpportunities(db as never, { projectId: "p1" });
    expect(result.humanOwned).toBe(1);
    expect(result.changed).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("includes them only when explicitly asked", async () => {
    const stale = computeScore(inputs(0.25)).scoreValue;
    const { db } = mockDb([
      { id: "op-1", title: "t", status: "accepted", scoreValue: stale, scoreInputs: inputs(0.85) },
    ]);
    const result = await rescoreProjectOpportunities(db as never, { projectId: "p1", includeHumanOwned: true });
    expect(result.changed).toBe(1);
  });
});

describe("a missing input is reported, not invented", () => {
  it("counts a row with no worth block as unscorable", async () => {
    const { db, updates } = mockDb([
      { id: "op-1", title: "t", status: "detected", scoreValue: 12, scoreInputs: { effort: {} } },
    ]);
    const result = await rescoreProjectOpportunities(db as never, { projectId: "p1" });
    expect(result.unscorable).toBe(1);
    expect(result.changed).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("counts a row whose inputs are not an object at all", async () => {
    const { db } = mockDb([
      { id: "op-1", title: "t", status: "detected", scoreValue: 12, scoreInputs: null },
    ]);
    const result = await rescoreProjectOpportunities(db as never, { projectId: "p1" });
    expect(result.unscorable).toBe(1);
  });
});

describe("the sweep walks live sites only", () => {
  it("skips a project whose site is retired", async () => {
    // A retired site's board is history. Rewriting its numbers changes a record nobody
    // asked to change.
    const findMany = vi.fn(async () => [{ domain: "live.test", projectId: "p1" }]);
    const db = {
      opportunity: {
        findMany: vi.fn(async (args: { where: { projectId: string } }) =>
          args.where.projectId === "p1"
            ? [{ id: "op-1", title: "t", status: "detected", scoreValue: 0, scoreInputs: inputs() }]
            : []
        ),
        update: vi.fn(),
      },
      site: { findMany },
    };
    const out = await rescoreAllProjects(db as never, { dryRun: true });
    expect([...out.keys()]).toEqual(["p1"]);
    // The query itself filters retired sites, so the sweep cannot see a retired one.
    expect((findMany.mock.calls[0] as unknown[])[0]).toMatchObject({ where: { retiredAt: null } });
  });

  it("orders reported movements by size, so the log shows what matters", async () => {
    const small = computeScore(inputs(0.3)).scoreValue;
    const { db } = mockDb([
      { id: "small", title: "small move", status: "detected", scoreValue: small, scoreInputs: inputs(0.35) },
      { id: "big", title: "big move", status: "detected", scoreValue: 0, scoreInputs: inputs(0.95) },
    ]);
    const result = await rescoreProjectOpportunities(db as never, { projectId: "p1" });
    expect(result.movements[0].id).toBe("big");
  });
});
