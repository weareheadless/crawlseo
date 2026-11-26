import { describe, expect, it, vi } from "vitest";

import {
  ExecutionError,
  readExecutionConfig,
  reportOpportunityWork,
} from "@/lib/opportunities/external-execution";

/**
 * An external executor may deliver work, and the claim is recorded rather than asserted.
 *
 * The decision this implements: an MCP client can move an opportunity to `delivered` on its
 * own, attributed as an external agent. What that must not become is an unattributed
 * "done" — the funnel plan's human-confirmation invariant exists so a person can always
 * answer "who did this and how do I check it", and widening execution must preserve the
 * answer rather than remove the question.
 */

type Row = { id: string; status: string; title: string };

function fakeDb(row: Row | null) {
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  return {
    created,
    updates,
    db: {
      opportunity: {
        findFirst: async () => row,
        update: async ({ data }: { data: Record<string, unknown> }) => {
          updates.push(data);
          return row;
        },
      },
      opportunityExecution: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: "exec-1" };
        },
      },
    } as never,
  };
}

const base = {
  siteId: "site-1",
  opportunityId: "op-1",
  executorId: "mcp:claude-code",
  workKind: "code_change" as const,
  note: "Rewrote the page around the query and pushed it.",
  commitSha: "abc1234",
};

describe("a delivery is accepted when it can be checked", () => {
  it("records the delivery and moves the opportunity in one call", async () => {
    const { db, created, updates } = fakeDb({ id: "op-1", status: "accepted", title: "t" });
    const result = await reportOpportunityWork(db, "project-1", base);

    expect(result.status).toBe("delivered");
    expect(created).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ status: "delivered" });
  });

  it("attributes the work as an external agent, never as a human confirmation", async () => {
    // The invariant being protected: widening who may execute must not erase who did. A
    // delivery written into `humanConfirmedBy` would make "a person confirmed this"
    // indistinguishable from "an agent reported this".
    const { db, created } = fakeDb({ id: "op-1", status: "accepted", title: "t" });
    await reportOpportunityWork(db, "project-1", base);
    expect(created[0].executorKind).toBe("external_agent");
    expect(created[0].executorId).toBe("mcp:claude-code");
    expect(Object.keys(created[0])).not.toContain("humanConfirmedBy");
  });

  it("keeps the reason, because it is the next reader's first question", async () => {
    const { db, created } = fakeDb({ id: "op-1", status: "accepted", title: "t" });
    await reportOpportunityWork(db, "project-1", base);
    expect(created[0].note).toBe(base.note);
    expect(created[0].resultingStatus).toBe("delivered");
  });

  it("accepts a delivery that cites a PR or a live URL instead of a commit", async () => {
    for (const locator of [
      { pullRequestUrl: "https://github.com/o/r/pull/7" },
      { deployedUrl: "https://example.test/page" },
    ]) {
      const { db } = fakeDb({ id: "op-1", status: "in_progress", title: "t" });
      const result = await reportOpportunityWork(db, "project-1", { ...base, commitSha: null, ...locator });
      expect(result.status).toBe("delivered");
    }
  });

  it("allows progress without claiming completion", async () => {
    const { db, updates } = fakeDb({ id: "op-1", status: "accepted", title: "t" });
    const result = await reportOpportunityWork(db, "project-1", { ...base, status: "in_progress" });
    expect(result.status).toBe("in_progress");
    expect(updates[0]).toEqual({ status: "in_progress" });
  });
});

describe("a delivery is refused when it cannot be checked or attributed", () => {
  it("refuses a delivery with no locator at all", async () => {
    // Not because it is dishonest, but because nobody could verify it. A board of
    // unverifiable "done" rows is worse than a board of open work.
    const { db, created } = fakeDb({ id: "op-1", status: "accepted", title: "t" });
    await expect(
      reportOpportunityWork(db, "project-1", { ...base, commitSha: null })
    ).rejects.toThrow(/point at its evidence/);
    expect(created).toHaveLength(0);
  });

  it("allows a locator-free delivery only when the work is explicitly external", async () => {
    // A Wix editor change or a DNS record has no commit. The note is then the record, and it
    // is still required.
    const { db } = fakeDb({ id: "op-1", status: "accepted", title: "t" });
    const result = await reportOpportunityWork(db, "project-1", {
      ...base,
      commitSha: null,
      workKind: "external",
      note: "Placed the element in the Wix editor and recorded the component id.",
    });
    expect(result.status).toBe("delivered");
  });

  it("refuses an unattributed delivery", async () => {
    const { db } = fakeDb({ id: "op-1", status: "accepted", title: "t" });
    await expect(
      reportOpportunityWork(db, "project-1", { ...base, executorId: "   " })
    ).rejects.toThrow(/executorId is required/);
  });

  it("refuses an empty note", async () => {
    const { db } = fakeDb({ id: "op-1", status: "accepted", title: "t" });
    await expect(
      reportOpportunityWork(db, "project-1", { ...base, note: "" })
    ).rejects.toThrow(/note is required/);
  });

  it("refuses prose where a commit belongs", async () => {
    const { db } = fakeDb({ id: "op-1", status: "accepted", title: "t" });
    await expect(
      reportOpportunityWork(db, "project-1", { ...base, commitSha: "pushed it yesterday" })
    ).rejects.toThrow(/hex commit id/);
  });

  it("refuses a locator that is not openable", async () => {
    const { db } = fakeDb({ id: "op-1", status: "accepted", title: "t" });
    await expect(
      reportOpportunityWork(db, "project-1", { ...base, commitSha: null, deployedUrl: "not-a-url" })
    ).rejects.toThrow(/deployedUrl is not a URL/);
  });

  it("refuses work reported against a row nobody accepted", async () => {
    // `detected` means no one has decided this is worth doing. Delivering it silently would
    // skip the human decision the funnel exists to keep.
    const { db } = fakeDb({ id: "op-1", status: "detected", title: "t" });
    await expect(reportOpportunityWork(db, "project-1", base)).rejects.toThrow(/accept it before reporting/);
  });

  it("refuses to un-deliver work that is already delivered", async () => {
    // Progress on delivered work is a new opportunity or a task step, not a status walk
    // backwards that silently makes finished work look open again.
    const { db } = fakeDb({ id: "op-1", status: "delivered", title: "t" });
    await expect(
      reportOpportunityWork(db, "project-1", { ...base, status: "in_progress" })
    ).rejects.toThrow(/already delivered/);
  });

  it("allows a follow-up delivery against a delivered row", async () => {
    // A fix pushed after review is real and worth recording; only the backwards move is
    // refused.
    const { db, created } = fakeDb({ id: "op-1", status: "delivered", title: "t" });
    const result = await reportOpportunityWork(db, "project-1", {
      ...base,
      note: "Follow-up: fixed the canonical tag the first pass missed.",
    });
    expect(result.status).toBe("delivered");
    expect(created[0].note).toMatch(/Follow-up/);
  });

  it("refuses an opportunity outside the project", async () => {
    const { db } = fakeDb(null);
    await expect(reportOpportunityWork(db, "project-1", base)).rejects.toBeInstanceOf(ExecutionError);
  });
});

describe("the execution config says what is missing instead of filling it in", () => {
  function site(config: Record<string, unknown> | null) {
    return {
      site: {
        findFirst: async () => ({ id: "site-1", domain: "example.test", siteDeliveryConfig: config }),
      },
      opportunityExecution: { findMany: async () => [] },
    } as never;
  }

  it("reports the cloneable repository and the site's own deployment document", async () => {
    const config = await readExecutionConfig(
      site({
        repoPath: "/home/admin/example",
        repoUrl: "weareheadless/example-wix",
        defaultBranch: "main",
        deployDocPath: "DEPLOYMENT.md",
        adapters: ["wix_embed"],
        enabled: true,
      }),
      "project-1",
      "site-1"
    );
    expect(config.canExecute).toBe(true);
    expect(config.repo).toEqual({
      url: "weareheadless/example-wix",
      branch: "main",
      deployDocPath: "DEPLOYMENT.md",
    });
    expect(config.localCheckout).toBe("/home/admin/example");
  });

  it("says a local checkout path is not executable evidence", async () => {
    // The defect this is shaped around: `repoPath` is a path on the machine the built-in
    // agent runs on. An external executor cannot `cd` into it, so a site carrying only that
    // must report as not executable rather than return a path the caller will fail to use.
    const config = await readExecutionConfig(
      site({ repoPath: "/home/admin/example", repoUrl: null, defaultBranch: null, deployDocPath: null, adapters: ["wix_embed"], enabled: true }),
      "project-1",
      "site-1"
    );
    expect(config.canExecute).toBe(false);
    expect(config.missing.join(" ")).toMatch(/cloneable repoUrl/);
  });

  it("reports no configuration as a missing configuration, not as an empty one", async () => {
    const config = await readExecutionConfig(site(null), "project-1", "site-1");
    expect(config.canExecute).toBe(false);
    expect(config.missing[0]).toMatch(/no delivery configuration/);
    expect(config.adapters).toEqual([]);
  });

  it("reports a disabled delivery as disabled", async () => {
    const config = await readExecutionConfig(
      site({ repoPath: null, repoUrl: "o/r", defaultBranch: "main", deployDocPath: "DEPLOYMENT.md", adapters: ["wix_embed"], enabled: false }),
      "project-1",
      "site-1"
    );
    expect(config.canExecute).toBe(false);
    expect(config.missing.join(" ")).toMatch(/disabled/);
  });

  it("states how to report back, so a client does not guess the shape", async () => {
    const config = await readExecutionConfig(site(null), "project-1", "site-1");
    expect(config.reporting.tool).toBe("seo_report_work");
    expect(config.reporting.requires.join(" ")).toMatch(/locator|commitSha/i);
  });
});
