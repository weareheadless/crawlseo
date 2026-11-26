import { describe, expect, it } from "vitest";

import { readOpportunityBoard, readWorkBrief } from "@/lib/opportunities/board";

/**
 * The board an external executor reads.
 *
 * Two properties matter more than the field list:
 *
 * 1. **It does not depend on the HelloAda binding.** `listConnectorOpportunities` sits behind
 *    `requireConnectorSite`, which demands an active `ConnectorBinding` for a named executor.
 *    An MCP client is not that executor, so a board tied to the binding would go dark whenever
 *    the binding was transferred or suspended — a working product feature failing for a
 *    reason its user cannot see.
 * 2. **It keeps the product's own order.** Evidence class first, then score. A client that
 *    re-sorted by score alone would put a projection above a measurement, which is exactly
 *    the inversion the evidence class exists to prevent.
 */

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "op-1",
    title: "Close the gap on 'alex karp height'",
    summary: "The record ranks 68.",
    status: "accepted",
    type: "O2_striking_distance",
    dedupKey: "O2:https://example.test/alex-karp:STRIKING",
    evidenceClass: "measured",
    scoreValue: 53,
    scoreInputs: { worth: { targetPages: ["https://example.test/alex-karp"] } },
    recommendationDecision: { action: "Rewrite the record", successMeasure: "position 10" },
    firstDetectedAt: new Date("2026-11-20T00:00:00Z"),
    updatedAt: new Date("2026-11-25T00:00:00Z"),
    opportunityExecutions: [],
    ...over,
  };
}

function db(rows: unknown[], site: unknown = { id: "site-1", domain: "example.test" }) {
  return {
    site: { findFirst: async () => site },
    opportunity: { findMany: async () => rows },
    opportunityExecution: { findMany: async () => [] },
  } as never;
}

const filters = { siteId: "site-1", limit: 10 };

describe("the board orders by evidence, then score", () => {
  it("puts a measurement above a larger projection", async () => {
    // The inversion the class exists to prevent: a hub for a page that does not exist scoring
    // 90 must not outrank a measured win at 12.
    const projection = row({ id: "op-2", evidenceClass: "estimated", scoreValue: 90, title: "hub" });
    const measured = row({ id: "op-1", evidenceClass: "measured", scoreValue: 12 });
    const board = await readOpportunityBoard(db([projection, measured]), "p1", filters);
    expect(board.opportunities.map((o) => o.id)).toEqual(["op-1", "op-2"]);
  });

  it("orders within a class by score, then oldest first", async () => {
    const board = await readOpportunityBoard(
      db([
        row({ id: "a", scoreValue: 10, firstDetectedAt: new Date("2026-11-22T00:00:00Z") }),
        row({ id: "b", scoreValue: 40 }),
        row({ id: "c", scoreValue: 10, firstDetectedAt: new Date("2026-11-19T00:00:00Z") }),
      ]),
      "p1",
      filters
    );
    // b wins on score; between the two 10s the older one comes first.
    expect(board.opportunities.map((o) => o.id)).toEqual(["b", "c", "a"]);
  });
});

describe("the board carries what a client needs to act", () => {
  it("gives the page and queries rather than a title to parse", async () => {
    // `Duplicate title on https://…` cannot be split reliably, and splitting it is the
    // deterministic guessing this codebase refuses.
    const board = await readOpportunityBoard(
      db([
        row({
          title: "Duplicate title on https://example.test/x",
          dedupKey: "O7:https://example.test/x:DUPLICATE_TITLE",
          // No `targetPages`: the crawl detector's identity *is* the URL, so the anchor falls
          // through to the dedup key. With targetPages present that wins, which is correct —
          // the score was computed against those pages.
          scoreInputs: {},
        }),
      ]),
      "p1",
      filters
    );
    expect(board.opportunities[0].pageUrl).toBe("https://example.test/x");
  });

  it("attaches delivery history so 'done' is checkable", async () => {
    const board = await readOpportunityBoard(
      db([
        row({
          opportunityExecutions: [
            {
              id: "e1",
              executorKind: "external_agent",
              executorId: "mcp:claude-code",
              workKind: "code_change",
              commitSha: "abc1234",
              pullRequestUrl: null,
              deployedUrl: null,
              note: "Rewrote it.",
              resultingStatus: "delivered",
              createdAt: new Date("2026-11-25T10:00:00Z"),
            },
          ],
        }),
      ]),
      "p1",
      filters
    );
    expect(board.opportunities[0].executions[0].executorId).toBe("mcp:claude-code");
    expect(board.opportunities[0].executions[0].note).toBe("Rewrote it.");
  });

  it("counts the whole project, not just the page", async () => {
    // A client shows "13 to decide / 138 parked" from one call; a count of the filtered page
    // would be a different, useless number.
    const board = await readOpportunityBoard(
      db([row({ id: "a", status: "detected" }), row({ id: "b", status: "parked" }), row({ id: "c", status: "parked" })]),
      "p1",
      { siteId: "site-1", status: "detected", limit: 1 }
    );
    expect(board.counts).toEqual({ detected: 1, parked: 2, total: 3 });
    expect(board.opportunities).toHaveLength(1);
  });

  it("pages without repeating a row", async () => {
    const rows = [row({ id: "a", scoreValue: 30 }), row({ id: "b", scoreValue: 20 }), row({ id: "c", scoreValue: 10 })];
    const first = await readOpportunityBoard(db(rows), "p1", { siteId: "site-1", limit: 2 });
    expect(first.opportunities.map((o) => o.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).toBe("b");

    const second = await readOpportunityBoard(db(rows), "p1", { siteId: "site-1", limit: 2, cursor: "b" });
    expect(second.opportunities.map((o) => o.id)).toEqual(["c"]);
    expect(second.nextCursor).toBeNull();
  });

  it("refuses a site that is not this project's", async () => {
    const board = readOpportunityBoard(db([], null), "p1", filters);
    await expect(board).rejects.toThrow(/site not found/i);
  });
});

describe("the work brief reads the recommendation, not the prose", () => {
  it("gives the action and how success is measured", async () => {
    const brief = await readWorkBrief(
      {
        opportunity: {
          findFirst: async () => ({
            ...row(),
            scoreInputs: { worth: { targetPages: ["https://example.test/alex-karp"], successMeasure: "position 10" } },
            recommendationDecision: { action: "Rewrite the record around the query", successMeasure: "reach position 10" },
          }),
        },
        opportunityExecution: { findMany: async () => [] },
      } as never,
      "p1",
      "op-1"
    );
    expect(brief.action).toBe("Rewrite the record around the query");
    expect(brief.successMeasure).toBe("reach position 10");
    expect(brief.targetPages).toEqual(["https://example.test/alex-karp"]);
  });

  it("says it does not know rather than inventing an action", async () => {
    // A row predating the decision contract has no action. A brief that guessed one would
    // send an executor to change something nobody asked for.
    const brief = await readWorkBrief(
      {
        opportunity: {
          findFirst: async () => ({ ...row(), recommendationDecision: null, scoreInputs: {} }),
        },
        opportunityExecution: { findMany: async () => [] },
      } as never,
      "p1",
      "op-1"
    );
    expect(brief.action).toBeNull();
    expect(brief.successMeasure).toBeNull();
  });
});
