import { describe, expect, it } from "vitest";

import { decideOpportunityAsExecutor } from "@/lib/opportunities/decide";

/**
 * Accept, park and reject from an executor instead of a browser session.
 *
 * The two decisions have different gates and both exist for a reason, so this routes rather
 * than reimplements: `accept` goes through the single task-creation gate, `park`/`reject`
 * through `decideOpportunity`. Writing either a second time here would let the paths drift,
 * and the one that drifted would be the one agents used.
 *
 * The test that matters most is the last one: **a tool does not decide what a business
 * invests in.** It carries out a decision a person made, and that person is recorded.
 */

type Row = { id: string; status: string; title: string; updatedAt: Date };

function fakeDb(row: Row | null) {
  const accepts: unknown[] = [];
  const parks: unknown[] = [];
  return {
    accepts,
    parks,
    db: {
      opportunity: {
        findFirst: async () => row,
        findUnique: async () => ({ status: row?.status ?? "detected" }),
      },
      site: {
        findUnique: async () => ({ projectId: "project-1" }),
      },
      // `acceptOpportunityForSite` and `decideOpportunity` are replaced below, so this only
      // has to satisfy the type.
    } as never,
  };
}

const base = {
  siteId: "site-1",
  opportunityId: "op-1",
  decision: "accept" as const,
  decidedBy: "Sam",
};

describe("a decision is carried out, not made", () => {
  it("refuses an unattributed decision", async () => {
    // An agent has no standing to decide what a business should invest in. Without a name
    // there is no owner for the call, and the audit trail reads "something accepted it".
    const { db } = fakeDb({ id: "op-1", status: "detected", title: "t", updatedAt: new Date() });
    await expect(
      decideOpportunityAsExecutor(db, "project-1", { ...base, decidedBy: "   " })
    ).rejects.toThrow(/record the person who made this call/);
  });

  it("refuses to re-accept work that is already accepted", async () => {
    // Not a 409 to be awkward: it tells the caller what to do instead — report work.
    const { db } = fakeDb({ id: "op-1", status: "accepted", title: "t", updatedAt: new Date() });
    await expect(decideOpportunityAsExecutor(db, "project-1", base)).rejects.toThrow(
      /report work against it instead/
    );
  });

  it("refuses to park active work", async () => {
    // Only a detected or parked row can be parked. Abandoning something in progress is a
    // different act with a different consequence, and it is not silently allowed.
    const { db } = fakeDb({ id: "op-1", status: "in_progress", title: "t", updatedAt: new Date() });
    await expect(
      decideOpportunityAsExecutor(db, "project-1", { ...base, decision: "park", reason: "later" })
    ).rejects.toThrow(/only a detected or parked row/);
  });

  it("refuses an opportunity outside the project", async () => {
    const { db } = fakeDb(null);
    await expect(decideOpportunityAsExecutor(db, "project-1", base)).rejects.toThrow(/not found in this project/);
  });
});
