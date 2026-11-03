import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Wave 6 ledger guard (docs/wave6-cleanup-ledger.md).
 *
 * The cleanup is only real if it stays done: this test fails if a deleted item
 * comes back, if a still-gated item is deleted without its cutover, or if the
 * cutover stops pointing at the funnel.
 */

const root = process.cwd();
const exists = (relative: string) => existsSync(path.join(root, relative));
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const DELETED = [
  "lib/pipeline/lineage.ts",
  "lib/pipeline/lineage-types.ts",
  "lib/research/crawl-actions.ts",
  "lib/research/seo-actions.ts",
  "scripts/sync-seo-actions.ts",
  "tests/crawl-actions.test.ts",
  "tests/seo-actions-authority.test.ts",
  "tests/crawl-gap-action-lifecycle.test.ts",
];

const GATED = [
  "lib/crawler/technical-actions.ts",
  "lib/research/keyword-actions.ts",
  "lib/dataforseo/prelaunch-actions.ts",
];

describe("wave 6 cleanup ledger", () => {
  it("keeps every deleted item deleted", () => {
    for (const file of DELETED) {
      expect(exists(file), `${file} came back; see docs/wave6-cleanup-ledger.md`).toBe(false);
    }
  });

  it("does not delete an item that still has a read consumer", () => {
    for (const file of GATED) {
      expect(exists(file), `${file} was deleted before its cutover; see docs/wave6-cleanup-ledger.md`).toBe(true);
    }
  });

  it("cut over the crawl job to the funnel", () => {
    const worker = read("scripts/job-worker.ts");
    expect(worker).toContain("refreshFunnelForSite");
    expect(worker).not.toContain("syncCrawlIssuesToActions");
  });

  it("cut over the sync endpoint to the funnel", () => {
    const route = read("app/api/sites/[siteId]/actions/sync-seo/route.ts");
    expect(route).toContain("refreshFunnelForSite");
    expect(route).not.toContain("syncSeoOpportunitiesToActions");
  });

  it("keeps the ported lifecycle requirement covered", () => {
    expect(exists("tests/funnel-crawl-gap-lifecycle.test.ts")).toBe(true);
    const ported = read("tests/funnel-crawl-gap-lifecycle.test.ts");
    expect(ported).toContain("acceptOpportunityIntoTask");
    expect(ported).toContain("recordDeliveryOutcome");
  });

  it("documents both lists so the ledger cannot drift silently", () => {
    const doc = read("docs/wave6-cleanup-ledger.md");
    for (const file of [...DELETED, ...GATED]) {
      expect(doc).toContain(path.basename(file));
    }
  });

  it("keeps the legacy freeze switch documented as the cutover step", () => {
    const doc = read("docs/wave6-cleanup-ledger.md");
    expect(doc).toContain("CRAWLSEO_LEGACY_FUNNEL_FREEZE=strict");
  });

  it("archives the legacy routes rather than leaving them reachable", () => {
    const routes = read("lib/funnel/legacy-routes.ts");
    for (const route of ["legacy-work", "legacy-opportunities", "actions", "findings", "results"]) {
      expect(routes).toContain(route);
    }
    const nav = read("components/layout/sidebar-nav.tsx");
    expect(nav).not.toContain("legacy-work");
  });

  it("does not claim the freeze is flipped while a writer remains", async () => {
    const { FROZEN_TABLES, auditLegacyWriters, writersByTable } = await import("../scripts/legacy-writer-audit");
    const findings = await auditLegacyWriters();
    const byTable = writersByTable(findings);
    // The ledger may only freeze tables that are provably write-free.
    for (const table of FROZEN_TABLES) {
      expect(byTable[table] ?? [], `${table} is frozen but still written`).toHaveLength(0);
    }
    const doc = read("docs/wave6-cleanup-ledger.md");
    if (FROZEN_TABLES.length === 0) {
      expect(doc).toContain("not possible yet");
    }
  });
});
