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
  "lib/crawler/technical-actions.ts",
  "tests/technical-actions.test.ts",
  "lib/pipeline/lineage.ts",
  "lib/pipeline/lineage-types.ts",
  "lib/research/crawl-actions.ts",
  "lib/research/seo-actions.ts",
  "lib/research/keyword-actions.ts",
  "lib/dataforseo/prelaunch-actions.ts",
  "scripts/sync-seo-actions.ts",
  "tests/crawl-actions.test.ts",
  "tests/seo-actions-authority.test.ts",
  "tests/crawl-gap-action-lifecycle.test.ts",
  "lib/funnel/legacy-routes.ts",
  "tests/wave6-legacy-routes.test.ts",
];

const GATED: string[] = [];

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

  it("removes the legacy route trees and redirects them in next.config", () => {
    const removed = [
      "content-studio",
      "legacy-work",
      "legacy-opportunities",
      "intelligence",
      "actions",
      "findings",
      "results",
      "research",
    ];
    for (const route of removed) {
      expect(exists(`app/(dashboard)/sites/[siteId]/${route}`), `${route} came back`).toBe(false);
    }
    // The page trees are gone; redirects keep old links and connector URLs working.
    const config = read("next.config.ts");
    for (const route of removed) {
      expect(config).toContain(`/sites/:siteId/${route}`);
    }
    // The screens drove their own API; it is removed with them, not left as a
    // way to create drafts outside the lane that owns them.
    for (const api of [
      "app/api/sites/[siteId]/content-studio",
      "app/api/sites/[siteId]/content-drafts",
      "app/api/content-drafts",
      "app/api/actions/[actionId]/draft",
      "app/api/actions/[actionId]/wix-blog-draft",
    ]) {
      expect(exists(api), `${api} came back`).toBe(false);
    }
    const nav = read("components/layout/sidebar-nav.tsx");
    for (const route of ["legacy-work", "content-studio", "research"]) {
      expect(nav).not.toContain(`/sites/\${siteId}/${route}`);
    }
  });

  it("records the dropped table and the reversible migration", () => {
    const doc = read("docs/wave6-cleanup-ledger.md");
    expect(doc).toContain("20261103120000_drop_rank_snapshot");
    expect(exists("prisma/migrations/20261103120000_drop_rank_snapshot/down.sql")).toBe(true);
    // The model is gone from the schema; a down migration restores it.
    const schema = read("prisma/schema.prisma");
    expect(schema).not.toContain("model RankSnapshot");
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
    expect(doc).toContain("prelaunchResearchRequest");
  });
});
