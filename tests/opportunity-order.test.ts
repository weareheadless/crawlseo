import { describe, expect, it } from "vitest";

import {
  compareOpportunities,
  OPPORTUNITY_ORDER_KEYS,
  opportunityOrder,
  sortOpportunities,
} from "@/lib/funnel/opportunity-order";

/**
 * One ordering for every surface that shows or evicts an opportunity.
 *
 * `scoreValue: "desc"` was written in six places — the board, the run report's top
 * five, the SERP watch list, `applyOpenCap`'s overflow, and two scripts — and they did
 * not agree on the tie-break: most said newest first, the cap said oldest first. That
 * is not cosmetic. The cap decides **which rows park**, so a scorer change plus a
 * stale cap would reorder the board and silently evict a different set.
 *
 * The part that matters most here is the last test: the order and the eviction set come
 * from the same comparator, so they cannot disagree about what "best" means.
 */

const at = (iso: string) => new Date(iso).toISOString();

describe("the opportunity order is declared once", () => {
  it("orders by score, then by who has waited longer", () => {
    const rows = [
      { id: "low", evidenceClass: "estimated", scoreValue: 5, firstDetectedAt: at("2026-01-01") },
      { id: "high", evidenceClass: "estimated", scoreValue: 40, firstDetectedAt: at("2026-11-20") },
      { id: "mid-new", evidenceClass: "estimated", scoreValue: 20, firstDetectedAt: at("2026-11-24") },
      { id: "mid-old", evidenceClass: "estimated", scoreValue: 20, firstDetectedAt: at("2026-02-01") },
    ];
    expect(sortOpportunities(rows).map((row) => row.id)).toEqual(["high", "mid-old", "mid-new", "low"]);
  });

  it("sorts an unscored row last, not first", () => {
    // Postgres puts NULL first under DESC. A row with no assessment is not a row that
    // tops the board, so the order states this instead of relying on the database.
    const rows = [
      { id: "unscored", evidenceClass: "estimated", scoreValue: null, firstDetectedAt: at("2026-01-01") },
      { id: "zero", evidenceClass: "estimated", scoreValue: 0, firstDetectedAt: at("2026-01-02") },
      { id: "high", evidenceClass: "estimated", scoreValue: 40, firstDetectedAt: at("2026-01-03") },
    ];
    expect(sortOpportunities(rows).map((row) => row.id)).toEqual(["high", "zero", "unscored"]);
  });

  it("treats an undated row as waiting longest, not as newest", () => {
    const rows = [
      { id: "dated", evidenceClass: "estimated", scoreValue: 10, firstDetectedAt: at("2026-05-01") },
      { id: "undated", evidenceClass: "estimated", scoreValue: 10, firstDetectedAt: null },
    ];
    expect(sortOpportunities(rows).map((row) => row.id)).toEqual(["dated", "undated"]);
  });

  it("keeps the SQL order and the in-memory order in step", () => {
    // Two forms exist because the board paginates in SQL while the cap and the report
    // hold an array. If they disagree, the board and its own eviction set disagree.
    const sql = opportunityOrder();
    expect(sql.map((clause) => Object.keys(clause)[0])).toEqual([...OPPORTUNITY_ORDER_KEYS]);
    // D1 first: the class decides the band, then the score decides the place in it.
    expect(sql[0]).toEqual({ evidenceClass: "asc" });
    expect(sql[1]).toEqual({ scoreValue: { sort: "desc", nulls: "last" } });
    expect(sql[2]).toEqual({ firstDetectedAt: "asc" });
  });

  it("hands out a fresh array, so one caller cannot reorder another surface", () => {
    const first = opportunityOrder();
    first.reverse();
    expect(opportunityOrder()[0]).toEqual({ evidenceClass: "asc" });
  });
});

describe("the board and its own overflow agree about what is best", () => {
  it("parks what the board would have shown last", () => {
    // The property the issue asks for: one comparator decides both the visible order
    // and the eviction set. A cap of 5 over 8 rows must park exactly the tail of the
    // board order — no separate ranking, no second opinion.
    const rows = [
      { id: "a", evidenceClass: "estimated", scoreValue: 31, firstDetectedAt: at("2026-03-01") },
      { id: "b", evidenceClass: "estimated", scoreValue: 12, firstDetectedAt: at("2026-01-01") },
      { id: "c", evidenceClass: "estimated", scoreValue: 44, firstDetectedAt: at("2026-06-01") },
      { id: "d", evidenceClass: "estimated", scoreValue: 12, firstDetectedAt: at("2026-02-01") },
      { id: "e", evidenceClass: "estimated", scoreValue: 7, firstDetectedAt: at("2026-05-01") },
      { id: "f", evidenceClass: "estimated", scoreValue: 0, firstDetectedAt: at("2026-04-01") },
      { id: "g", evidenceClass: "estimated", scoreValue: 22, firstDetectedAt: at("2026-07-01") },
      { id: "h", evidenceClass: "estimated", scoreValue: 1, firstDetectedAt: at("2026-08-01") },
    ];
    const cap = 5;

    // What the board shows, from the same comparator.
    const board = sortOpportunities(rows).slice(0, cap).map((row) => row.id);
    // What applyOpenCap parks: the rows past the cap in that same order.
    const overflow = sortOpportunities(rows).slice(cap).map((row) => row.id);

    expect(board).toEqual(["c", "a", "g", "b", "d"]);
    // Scores 7, 1, 0 — so e, then h, then f. Written out rather than trusted, because
    // this pair is the assertion that the eviction set follows the board.
    expect(overflow).toEqual(["e", "h", "f"]);
    // Nothing is both shown and parked: the two sets partition the rows.
    expect([...board, ...overflow].sort()).toEqual(rows.map((row) => row.id).sort());
    expect(board.filter((id) => overflow.includes(id))).toEqual([]);
  });

  it("evicts the weakest row when one better row arrives", () => {
    // The failure the old split caused: adding a strong row must push out the weakest
    // row, not a different one because the cap sorted by another rule.
    const base = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`,
      evidenceClass: "estimated" as const,
      scoreValue: 10 + i,
      firstDetectedAt: at("2026-01-01"),
    }));
    const before = sortOpportunities(base).slice(5).map((row) => row.id);
    expect(before).toEqual([]); // exactly at the cap

    const withNew = [...base, { id: "new", evidenceClass: "estimated", scoreValue: 50, firstDetectedAt: at("2026-11-01") }];
    const overflow = sortOpportunities(withNew).slice(5).map((row) => row.id);
    expect(overflow).toEqual(["r0"]); // the weakest, not the newest
  });
});

describe("the comparator is total and stable enough to trust", () => {
  it("returns zero only for rows that are genuinely equivalent", () => {
    const a = { scoreValue: 10, firstDetectedAt: at("2026-01-01") };
    expect(compareOpportunities(a, { ...a })).toBe(0);
  });

  it("is antisymmetric, so sorting twice cannot oscillate", () => {
    const a = { scoreValue: 10, firstDetectedAt: at("2026-01-01") };
    const b = { scoreValue: 10, firstDetectedAt: at("2026-02-01") };
    expect(Math.sign(compareOpportunities(a, b))).toBe(-Math.sign(compareOpportunities(b, a)));
  });

  it("does not mutate the array it is given", () => {
    const rows = [
      { id: "a", evidenceClass: "estimated", scoreValue: 1, firstDetectedAt: at("2026-01-01") },
      { id: "b", evidenceClass: "estimated", scoreValue: 2, firstDetectedAt: at("2026-01-01") },
    ];
    const copy = [...rows];
    sortOpportunities(rows);
    expect(rows).toEqual(copy);
  });
});
