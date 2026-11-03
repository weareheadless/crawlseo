import { describe, expect, it, vi } from "vitest";

import { wave6Status } from "../scripts/wave6-status";

/**
 * The status report is the executable form of the ledger's checklist, so these
 * tests pin what "complete" means and make sure a regression shows up as a
 * failing check rather than a stale document.
 */

function fakeDb(opts: { actions?: Array<{ createdAt: Date; owner?: string }> } = {}) {
  const now = Date.now();
  return {
    researchAction: {
      findMany: vi.fn(async () => opts.actions ?? []),
      count: vi.fn(async () => 0),
    },
    researchRun: { findMany: vi.fn(async () => []) },
    researchFinding: { findMany: vi.fn(async () => []) },
    seoResearchRun: { findMany: vi.fn(async () => []) },
    seoResearchTask: { findMany: vi.fn(async () => []) },
    articleKeywordResearchRun: { findMany: vi.fn(async () => []) },
    prelaunchResearchRequest: { findMany: vi.fn(async () => []) },
    crawl: { findMany: vi.fn(async () => [{ id: "c1", finishedAt: new Date(now - 60_000) }]) },
    job: { findMany: vi.fn(async () => [{ id: "j1", updatedAt: new Date(now - 60_000) }]) },
  } as never;
}

describe("wave 6 status checklist", () => {
  it("reports step 1 complete: archived by default with five destinations", async () => {
    const status = await wave6Status(fakeDb());
    const routes = status.checks.find((check) => check.name.includes("legacy routes"));
    expect(routes?.status).toBe("complete");
    expect(routes?.detail).toContain("archived by default");
    expect(routes?.detail).toContain("5/5");
  });

  it("reports the freeze as complete only when strict is set", async () => {
    const original = process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE;
    process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE = "strict";
    const on = await wave6Status(fakeDb());
    expect(on.checks.find((check) => check.name === "strict freeze flipped")?.status).toBe("complete");

    delete process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE;
    const off = await wave6Status(fakeDb());
    expect(off.checks.find((check) => check.name === "strict freeze flipped")?.status).toBe("open");

    if (original === undefined) delete process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE;
    else process.env.CRAWLSEO_LEGACY_FUNNEL_FREEZE = original;
  });

  it("keeps the coverage check partial while a scheduled job still creates legacy rows", async () => {
    const status = await wave6Status(fakeDb());
    const coverage = status.checks.find((check) => check.name.includes("freeze covers"));
    // The research families still grow from scheduled jobs, so this must not
    // claim completion.
    expect(coverage?.status).toBe("partial");
    expect(coverage?.detail).toContain("still growing");
  });

  it("flags legacy writes observed in the window", async () => {
    const status = await wave6Status(
      fakeDb({ actions: [{ createdAt: new Date(Date.now() - 60_000), owner: "crawl-actions" }] })
    );
    const clean = status.checks.find((check) => check.name.includes("observation window"));
    expect(clean?.status).toBe("open");
    expect(clean?.detail).toContain("ResearchAction");
  });

  it("reports the reversible drop as complete", async () => {
    const status = await wave6Status(fakeDb());
    const drop = status.checks.find((check) => check.name.includes("reversible migration"));
    expect(drop?.status).toBe("complete");
  });

  it("reports the gated items as deleted once the last factory is retired", async () => {
    const status = await wave6Status(fakeDb());
    const deleted = status.checks.find((check) => check.name === "gated items deleted");
    expect(deleted?.status).toBe("complete");
    expect(deleted?.detail).toMatch(/items deleted/);
  });

  it("lists what the checklist surfaces but does not own, separately from its steps", async () => {
    const status = await wave6Status(fakeDb());
    // The three steps and the DS-02 consequence must not be conflated.
    expect(status.blockedBy.length).toBeGreaterThan(0);
    expect(status.blockedBy.every((entry) => entry.reason.includes("DS-02") || entry.reason.includes("step 4"))).toBe(true);
    expect(status.checks.every((check) => !check.name.includes("DS-02"))).toBe(true);
  });

  it("summarises counts that add up to the number of checks", async () => {
    const status = await wave6Status(fakeDb());
    const { complete, partial, open } = status.summary;
    expect(complete + partial + open).toBe(status.checks.length);
  });
});
